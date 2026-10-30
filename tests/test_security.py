"""独立QA：使用临时数据、真实HTTP与随机端口验证安全边界。"""
import http.client
import json
import os
import shutil
import subprocess
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import urlencode, urlsplit

from backend.config import Config
from backend.controller import Application, BASE
from backend.repository import db_id, now_ms


class SecurityHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="baba-share-qa-")
        cls.config = Config(root=Path(cls.temp.name), port=1, preview_port=2)
        cls.app = Application(cls.config)
        from http.server import ThreadingHTTPServer
        cls.main = ThreadingHTTPServer(("127.0.0.1", 0), cls.app.handler(False))
        cls.preview = ThreadingHTTPServer(("127.0.0.1", 0), cls.app.handler(True))
        cls.config.port = cls.main.server_port
        cls.config.preview_port = cls.preview.server_port
        cls.config.public_origin = f"http://127.0.0.1:{cls.main.server_port}"
        cls.config.preview_origin = f"http://127.0.0.1:{cls.preview.server_port}"
        cls.threads = []
        for server in (cls.main, cls.preview):
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            cls.threads.append(thread)
        cls.cookies, cls.users = {}, {}
        password = "qa-isolated-password-123"
        status, user, headers = cls.request("POST", "/visitor/account/setup", body={"userName": "qa-admin", "password": password})
        if status != 200:
            raise AssertionError((status, user))
        cls.users["admin"] = user
        cls.cookies["admin"] = headers["set-cookie"].split(";", 1)[0]
        for name, role in (("owner", "editor"), ("peer", "editor"), ("viewer", "viewer")):
            status, user, _ = cls.request("POST", "/user", actor="admin", body={"userName": "qa-" + name, "password": password, "role": role})
            if status != 200:
                raise AssertionError((status, user))
            cls.users[name] = user
            status, _, headers = cls.request("POST", "/visitor/session", body={"userName": "qa-" + name, "password": password})
            if status != 200:
                raise AssertionError(status)
            cls.cookies[name] = headers["set-cookie"].split(";", 1)[0]

    @classmethod
    def tearDownClass(cls):
        for server in (cls.main, cls.preview):
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, route, actor=None, body=None, query=None, preview=False, headers=None):
        port = cls.preview.server_port if preview else cls.main.server_port
        path = route if preview or not route.startswith("/") else BASE + route
        if query:
            path += "?" + urlencode(query)
        request_headers = {"Origin": cls.config.public_origin, "Content-Type": "application/json"}
        if actor:
            request_headers["Cookie"] = cls.cookies[actor]
        request_headers.update(headers or {})
        raw = json.dumps(body).encode() if body is not None else None
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request(method, path, body=raw, headers=request_headers)
            response = connection.getresponse()
            data = response.read()
            result_headers = dict(response.getheaders())
            result_headers = {key.lower(): value for key, value in result_headers.items()}
            if "application/json" in result_headers.get("content-type", ""):
                data = json.loads(data)
            return response.status, data, result_headers
        finally:
            connection.close()

    def setUp(self):
        self.workspace = self.ok("POST", "/workspace", "owner", {"workspaceName": self._testMethodName})["id"]
        for actor, collaborate in (("peer", False), ("viewer", True)):
            self.ok("POST", "/member", "owner", {"workspaceId": self.workspace, "userId": self.users[actor]["id"], "collaborate": collaborate})

    def ok(self, method, route, actor=None, body=None, query=None):
        status, data, _ = self.request(method, route, actor, body, query)
        self.assertEqual(status, 200, (method, route, data))
        return data

    def file(self, path, actor="owner", content="原始内容"):
        return self.ok("PUT", "/file/content", actor, {"workspaceId": self.workspace, "path": path, "content": content})

    def denied(self, method, route, actor, body=None, query=None, expected=403):
        status, data, _ = self.request(method, route, actor, body, query)
        self.assertEqual(status, expected, (method, route, data))
        self.assertEqual(set(data), {"msg", "code", "status"})
        self.assertEqual(data["code"], status)
        return data

    def test_viewer_readonly_even_collaborate(self):
        self.file("site/index.html")
        mutations = [
            ("POST", "/workspace", {"workspaceName": "viewer-forbidden"}, None),
            ("POST", "/folder", {"workspaceId": self.workspace, "path": "new"}, None),
            ("PUT", "/file/content", {"workspaceId": self.workspace, "path": "site/index.html", "content": "changed"}, None),
            ("POST", "/file/upload", {"workspaceId": self.workspace, "files": [{"path": "x.txt", "contentBase64": "eA=="}]}, None),
            ("PATCH", "/file", {"workspaceId": self.workspace, "path": "site/index.html", "newPath": "x.html"}, None),
            ("DELETE", "/folder", None, {"workspaceId": self.workspace, "path": "site"}),
            ("POST", "/share", {"workspaceId": self.workspace, "path": "site"}, None),
            ("PATCH", "/member", {"workspaceId": self.workspace, "userId": self.users["peer"]["id"], "collaborate": True}, None),
        ]
        for method, route, body, query in mutations:
            with self.subTest(method=method, route=route):
                self.denied(method, route, "viewer", body, query)
        self.assertEqual(self.ok("GET", "/file/content", "viewer", query={"workspaceId": self.workspace, "path": "site/index.html"})["content"], "原始内容")

    def test_noncollaborator_own_files_and_foreign_recursive_protection(self):
        self.file("shared/owner.txt")
        self.file("shared/peer.txt", "peer")
        self.file("shared/peer.txt", "peer", "自己的新内容")
        self.denied("PUT", "/file/content", "peer", {"workspaceId": self.workspace, "path": "shared/owner.txt", "content": "覆盖"})
        for method, route, body, query in [
            ("DELETE", "/file", None, {"workspaceId": self.workspace, "path": "shared/owner.txt"}),
            ("DELETE", "/folder", None, {"workspaceId": self.workspace, "path": "shared"}),
            ("PATCH", "/folder", {"workspaceId": self.workspace, "path": "shared", "newPath": "moved"}, None),
        ]:
            with self.subTest(method=method, route=route):
                self.denied(method, route, "peer", body, query)
        self.ok("PATCH", "/file", "peer", {"workspaceId": self.workspace, "path": "shared/peer.txt", "newPath": "mine.txt"})
        self.ok("DELETE", "/file", "peer", query={"workspaceId": self.workspace, "path": "mine.txt"})

    def test_own_folder_cannot_delete_other_users_descendants(self):
        self.ok("POST", "/folder", "peer", {"workspaceId": self.workspace, "path": "peer-folder"})
        self.file("peer-folder/owner.txt")
        self.file("peer-folder/peer.txt", "peer")
        self.denied("DELETE", "/folder", "peer", query={"workspaceId": self.workspace, "path": "peer-folder"})
        self.denied("PATCH", "/folder", "peer", {"workspaceId": self.workspace, "path": "peer-folder", "newPath": "peer-renamed"})
        self.assertEqual(self.ok("GET", "/file/content", "owner", query={"workspaceId": self.workspace, "path": "peer-folder/owner.txt"})["content"], "原始内容")

    def test_collaborator_can_write_foreign_files(self):
        self.file("shared/owner.txt")
        self.ok("PATCH", "/member", "owner", {"workspaceId": self.workspace, "userId": self.users["peer"]["id"], "collaborate": True})
        self.file("shared/owner.txt", "peer", "协作修改")
        self.ok("DELETE", "/folder", "peer", query={"workspaceId": self.workspace, "path": "shared"})

    @unittest.skipUnless(os.name == "nt", "仅Windows大小写不敏感文件系统适用")
    def test_case_alias_cannot_overwrite_foreign_file(self):
        self.file("protected.txt")
        self.denied("PUT", "/file/content", "peer", {"workspaceId": self.workspace, "path": "PROTECTED.TXT", "content": "禁止覆盖"}, expected=409)
        self.assertEqual(self.ok("GET", "/file/content", "owner", query={"workspaceId": self.workspace, "path": "protected.txt"})["content"], "原始内容")

    @unittest.skipUnless(os.name == "nt", "仅Windows大小写不敏感文件系统适用")
    def test_case_alias_cannot_delete_foreign_folder(self):
        self.file("Protected/owner.txt")
        self.denied("DELETE", "/folder", "peer", query={"workspaceId": self.workspace, "path": "PROTECTED"}, expected=409)

    @unittest.skipUnless(os.name == "nt", "仅Windows大小写不敏感文件系统适用")
    def test_upload_case_alias_cannot_overwrite_foreign_file(self):
        self.file("protected.txt")
        payload = {"workspaceId": self.workspace, "files": [{"path": "PROTECTED.TXT", "contentBase64": "5Li75b2V5Zyw"}]}
        self.denied("POST", "/file/upload", "peer", payload, expected=409)
        self.assertEqual(self.ok("GET", "/file/content", "owner", query={"workspaceId": self.workspace, "path": "protected.txt"})["content"], "原始内容")

    @unittest.skipUnless(os.name == "nt", "仅Windows大小写不敏感文件系统适用")
    def test_rename_case_alias_destination_is_rejected(self):
        self.file("source.txt", "peer", "自己的文件")
        self.file("protected.txt")
        self.denied("PATCH", "/file", "peer", {"workspaceId": self.workspace, "path": "source.txt", "newPath": "PROTECTED.TXT"}, expected=409)
        self.assertEqual(self.ok("GET", "/file/content", "owner", query={"workspaceId": self.workspace, "path": "protected.txt"})["content"], "原始内容")
        self.assertEqual(self.ok("GET", "/file/content", "peer", query={"workspaceId": self.workspace, "path": "source.txt"})["content"], "自己的文件")

    @unittest.skipUnless(os.name == "nt", "仅Windows大小写不敏感文件系统适用")
    def test_folder_rename_case_alias_destination_is_rejected(self):
        self.file("source/file.txt", "peer", "自己的文件")
        self.file("Protected/owner.txt")
        self.denied("PATCH", "/folder", "peer", {"workspaceId": self.workspace, "path": "source", "newPath": "PROTECTED/moved"}, expected=409)
        self.assertEqual(self.ok("GET", "/file/content", "owner", query={"workspaceId": self.workspace, "path": "Protected/owner.txt"})["content"], "原始内容")
        self.assertEqual(self.ok("GET", "/file/content", "peer", query={"workspaceId": self.workspace, "path": "source/file.txt"})["content"], "自己的文件")

    def test_workspace_and_admin_permission_boundaries(self):
        for method, route, body, query in [
            ("PATCH", "/workspace", {"id": self.workspace, "workspaceName": "forbidden"}, None),
            ("DELETE", "/workspace", None, {"id": self.workspace}),
            ("PATCH", "/setting", {"registrationEnabled": True}, None),
            ("POST", "/user", {"userName": "forbidden", "password": "1234567890", "role": "admin"}, None),
        ]:
            with self.subTest(method=method, route=route):
                self.denied(method, route, "peer", body, query)
        for patch in ({"role": "viewer"}, {"isDisabled": True}):
            self.denied("PATCH", "/user", "admin", {"id": self.users["admin"]["id"], **patch}, expected=409)

    def test_sqlite_actual_storage_uses_uuid_bytes_and_millisecond_integers(self):
        with self.app.service.repo.connection() as connection:
            user = connection.execute("SELECT typeof(id),length(id),typeof(create_time),create_time,password_hash FROM sys_user WHERE id=?", (db_id(self.users["owner"]["id"]),)).fetchone()
            self.assertEqual(tuple(user[:3]), ("blob", 16, "integer"))
            self.assertGreater(user[3], 1_000_000_000_000)
            self.assertNotIn("qa-isolated-password-123", user[4])
            self.assertIn(":", user[4])
            session = connection.execute("SELECT typeof(id),length(id),typeof(expire_time),session_hash FROM auth_session WHERE user_id=?", (db_id(self.users["owner"]["id"]),)).fetchone()
            self.assertEqual(tuple(session[:3]), ("blob", 16, "integer"))
            self.assertNotEqual(session[3], self.cookies["owner"].split("=", 1)[1])
            self.assertEqual(len(session[3]), 64)

    def test_directory_pagination_uses_requested_page_and_filters_subtree(self):
        files = [{"path": f"target/item-{index:02d}.txt", "contentBase64": "eA=="} for index in range(25)]
        files.extend([{"path": "outside/private.txt", "contentBase64": "eA=="}, {"path": "target/deep/nested.txt", "contentBase64": "eA=="}])
        self.ok("POST", "/file/upload", "owner", {"workspaceId": self.workspace, "files": files})
        data = self.ok("GET", "/node/list", "owner", query={"workspaceId": self.workspace, "path": "target", "pageIndex": 2, "pageSize": 10})
        self.assertEqual(data["pageIndex"], 2)
        self.assertEqual(data["pageSize"], 10)
        self.assertEqual(data["totalCount"], 26)
        self.assertEqual(data["totalPage"], 3)
        self.assertEqual(len(data["data"]), 10)
        self.assertTrue(all(item["path"].startswith("target/") and "/" not in item["path"][7:] for item in data["data"]))
        self.assertEqual(data["entries"], data["data"])

    def test_prefixed_pages_assets_and_anonymous_shell(self):
        self.assertEqual(BASE, "/api/baba-share/core/v1")
        share = self.make_share()
        routes = ["/baba-share/", "/baba-share/auth.html", "/baba-share/workspace.html",
                  "/baba-share/account.html", "/baba-share/users.html", "/baba-share/share.html",
                  "/baba-share/s/" + share["token"], "/baba-share/assets/common.js",
                  "/baba-share/assets/tokens.css"]
        for route in ("/", "/baba-share"):
            connection = http.client.HTTPConnection("127.0.0.1", self.main.server_port, timeout=10)
            try:
                connection.request("GET", route)
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 302)
                self.assertEqual(response.getheader("Location"), "/baba-share/")
            finally:
                connection.close()
        for route in routes:
            with self.subTest(route=route):
                connection = http.client.HTTPConnection("127.0.0.1", self.main.server_port, timeout=10)
                try:
                    connection.request("GET", route)
                    response = connection.getresponse()
                    data = response.read()
                    self.assertEqual(response.status, 200)
                    if "text/html" in response.getheader("Content-Type", ""):
                        self.assertIn(b"babaShare", data)
                        self.assertNotIn(b"ProtoShare", data)
                    if route.startswith("/baba-share/s/"):
                        self.assertIn(b'/baba-share/assets/share.js', data)
                finally:
                    connection.close()

    def test_primary_pages_allow_same_origin_iframe_with_preview_origin(self):
        connection = http.client.HTTPConnection("127.0.0.1", self.main.server_port, timeout=10)
        try:
            connection.request("GET", "/baba-share/workspace.html")
            response = connection.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("X-Frame-Options"), "SAMEORIGIN")
            policy = response.getheader("Content-Security-Policy")
            self.assertIn("frame-ancestors 'self'", policy)
            self.assertIn("frame-src 'self'", policy)
            self.assertIn(self.config.preview_origin, policy)
        finally:
            connection.close()

    def test_all_workspace_members_can_read_roster_but_nonmembers_cannot(self):
        for actor in ("owner", "peer", "viewer"):
            roster = self.ok("GET", "/member/list", actor, query={"workspaceId": self.workspace})
            self.assertEqual({item["userId"] for item in roster}, {self.users["owner"]["id"], self.users["peer"]["id"], self.users["viewer"]["id"]})
            self.assertEqual(sum(item["isOwner"] for item in roster), 1)
        private_workspace = self.ok("POST", "/workspace", "peer", {"workspaceName": "private-roster-check"})["id"]
        for actor in ("owner", "viewer"):
            self.denied("GET", "/member/list", actor, query={"workspaceId": private_workspace})
        self.ok("GET", "/member/list", "admin", query={"workspaceId": private_workspace})
        for actor in ("peer", "viewer"):
            self.denied("PATCH", "/member", actor, {"workspaceId": self.workspace, "userId": self.users["peer"]["id"], "collaborate": True})
            self.denied("DELETE", "/member", actor, query={"workspaceId": self.workspace, "userId": self.users["viewer"]["id"]})

    def test_paths_reject_escape_and_windows_aliases(self):
        for path in ("../outside.txt", "/absolute.txt", "a/../../outside.txt", "a\\outside.txt", "C:/outside.txt", "a//b", "a/./b", "CON.txt", "a.txt:stream", "a. "):
            with self.subTest(path=path):
                self.denied("PUT", "/file/content", "owner", {"workspaceId": self.workspace, "path": path, "content": "escape"}, expected=400)
        self.assertFalse((Path(self.temp.name) / "outside.txt").exists())

    def make_share(self):
        self.file("site/index.html", content="<html>QA</html>")
        self.file("site/assets/main.css", content="body{color:red}")
        self.file("private.txt", content="不可公开")
        return self.ok("POST", "/share", "owner", {"workspaceId": self.workspace, "path": "site", "expireHours": 1})

    def test_share_isolation_revocation_and_headers(self):
        share = self.make_share()
        detail = self.ok("GET", "/visitor/share/detail", query={"token": share["token"]})
        self.assertNotIn("workspaceId", detail["share"])
        self.assertTrue(all(entry["ownerId"] is None for entry in detail["listing"]["entries"]))
        prefix = "/baba-share/s/" + share["token"] + "/"
        for resource in ("index.html", "assets/main.css"):
            status, _, headers = self.request("GET", prefix + resource, preview=True)
            self.assertEqual(status, 200)
            self.assertIn("sandbox allow-scripts;", headers["content-security-policy"])
            self.assertNotIn("allow-same-origin", headers["content-security-policy"])
            self.assertEqual(headers["cache-control"], "no-store")
            self.assertNotIn("set-cookie", headers)
        for resource in ("../private.txt", "%2e%2e/private.txt", "assets/../../private.txt", "private.txt"):
            status, _, _ = self.request("GET", prefix + resource, preview=True)
            self.assertIn(status, (400, 403, 404))
        self.denied("DELETE", "/share", "peer", query={"id": share["id"]})
        self.ok("DELETE", "/share", "owner", query={"id": share["id"]})
        self.denied("GET", "/visitor/share/detail", None, query={"token": share["token"]}, expected=404)
        for resource in ("index.html", "assets/main.css"):
            self.assertEqual(self.request("GET", prefix + resource, preview=True)[0], 404)

    def test_anonymous_directory_redirect_preserves_final_resource(self):
        share = self.make_share()
        self.file("site/sub/index.html", content="<html>子目录页面</html>")
        prefix = "/baba-share/s/" + share["token"]
        for path in (prefix, prefix + "/sub"):
            with self.subTest(path=path):
                status, _, headers = self.request("GET", path, preview=True)
                self.assertIn(status, (301, 302, 307, 308))
                location = urlsplit(headers["location"])
                if location.netloc:
                    self.assertEqual(location.netloc, urlsplit(self.config.preview_origin).netloc)
                self.assertEqual(location.path, path + "/")
                final_status, data, _ = self.request("GET", location.path, preview=True)
                self.assertEqual(final_status, 200)
                self.assertIn(b"<html>", data)

    def test_share_resources_revoke_on_member_removal(self):
        self.file("site/index.html")
        self.file("site/main.css")
        share = self.ok("POST", "/share", "peer", {"workspaceId": self.workspace, "path": "site"})
        prefix = "/baba-share/s/" + share["token"] + "/"
        self.assertEqual(self.request("GET", prefix + "main.css", preview=True)[0], 200)
        self.ok("DELETE", "/member", "owner", query={"workspaceId": self.workspace, "userId": self.users["peer"]["id"]})
        self.denied("GET", "/visitor/share/detail", None, query={"token": share["token"]}, expected=404)
        for resource in ("index.html", "main.css"):
            self.assertEqual(self.request("GET", prefix + resource, preview=True)[0], 404)

    def test_share_resources_revoke_on_root_move(self):
        share = self.make_share()
        self.ok("PATCH", "/folder", "owner", {"workspaceId": self.workspace, "path": "site", "newPath": "renamed"})
        for resource in ("index.html", "assets/main.css"):
            self.assertEqual(self.request("GET", "/baba-share/s/" + share["token"] + "/" + resource, preview=True)[0], 404)

    def test_share_expiry_applies_to_assets(self):
        share = self.make_share()
        self.app.service.repo.execute("UPDATE folder_share SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(share["id"])))
        self.denied("GET", "/visitor/share/detail", None, query={"token": share["token"]}, expected=404)
        for resource in ("index.html", "assets/main.css"):
            self.assertEqual(self.request("GET", "/baba-share/s/" + share["token"] + "/" + resource, preview=True)[0], 404)

    def test_preview_ticket_revoked_by_member_removal(self):
        self.file("site/index.html")
        ticket = self.ok("POST", "/preview/ticket", "viewer", {"workspaceId": self.workspace, "path": "site"})
        path = urlsplit(ticket["previewUrl"]).path
        self.assertEqual(self.request("GET", path, preview=True)[0], 200)
        self.ok("DELETE", "/member", "owner", query={"workspaceId": self.workspace, "userId": self.users["viewer"]["id"]})
        self.assertEqual(self.request("GET", path, preview=True)[0], 403)

    @unittest.skipUnless(shutil.which("node"), "桥接协议动态执行需要Node.js")
    def test_bridge_rejects_wrong_origin_source_version_and_cleans_pending(self):
        source = Path(__file__).resolve().parents[1] / "web" / "assets" / "bridge-core.js"
        script = """
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const sent=[],events=new Map(),target={postMessage:(message,origin)=>sent.push({message,origin})};
const window={addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:(name,fn)=>{if(events.get(name)===fn)events.delete(name)}};
const timers=new Set();let timerId=0,clearCalls=0;
const context={window,location:{origin:'http://127.0.0.1:12345'},console,setTimeout:()=>{const id=++timerId;timers.add(id);return id},clearTimeout:id=>{clearCalls++;timers.delete(id)}};
vm.createContext(context);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),context);
(async()=>{
 const endpoint=window.BabaShareBridgeEndpoint(()=>target,()=>true);let accepted=0;
 endpoint.handle('probe',()=>{accepted++;return 'ok'});
 const receive=events.get('message');
 const event={origin:context.location.origin,source:target,data:{babaShare:true,version:1,type:'probe',requestId:'request-1',payload:{}}};
 await receive({...event,origin:'http://untrusted.invalid'});
 await receive({...event,source:{}});
 await receive({...event,data:{...event.data,version:2}});
 assert.equal(accepted,0);assert.equal(sent.length,0);
 await receive(event);assert.equal(accepted,1);assert.equal(sent[0].message.payload,'ok');assert.equal(sent[0].origin,context.location.origin);
 await receive({...event,data:{...event.data,type:'unknown',requestId:'request-2'}});
 assert.equal(sent[1].message.error,'BRIDGE_UNKNOWN_TYPE');
 const pending=endpoint.request('waiting',{},1000);endpoint.destroy();
 await assert.rejects(pending,e=>e.message==='BRIDGE_CLOSED');assert.equal(events.has('message'),false);assert.equal(timers.size,0);
 const broken=window.BabaShareBridgeEndpoint(()=>({postMessage:()=>{throw Error('POSTMESSAGE_FAILED')}}),()=>true);
 const beforeFailure=clearCalls;
 await assert.rejects(broken.request('send-fails',{}),e=>e.message==='POSTMESSAGE_FAILED');
 assert.equal(timers.size,0);assert.equal(clearCalls,beforeFailure+1);
 broken.destroy();assert.equal(clearCalls,beforeFailure+1);assert.equal(events.has('message'),false);
})().catch(e=>{console.error(e);process.exitCode=1});
"""
        executed = subprocess.run(["node", "-e", script, str(source)], capture_output=True, text=True)
        self.assertEqual(executed.returncode, 0, executed.stderr)

    @unittest.skipUnless(shutil.which("node"), "前端导航动态执行需要Node.js")
    def test_frontend_navigation_stays_inside_product_prefix(self):
        source = Path(__file__).resolve().parents[1] / "web" / "assets" / "common.js"
        script = """
const fs=require('fs'),vm=require('vm'),assert=require('assert');
let scriptUrl='http://127.0.0.1:12345/baba-share/assets/common.js';
const context={window:{},URL,document:{querySelector:()=>({src:scriptUrl})},location:{protocol:'http:',origin:'http://127.0.0.1:12345'}};
vm.createContext(context);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),context);
for(const route of ['workspace','account','users','auth','shell']){
 const url=new URL(context.window.UI.routeUrl(route,{workspaceId:'a&b'}));
 assert.equal(url.origin,context.location.origin);assert.ok(url.pathname.startsWith('/baba-share/'));assert.equal(url.searchParams.get('workspaceId'),'a&b');
}
assert.throws(()=>context.window.UI.routeUrl('javascript:alert(1)'),/ROUTE_NOT_ALLOWED/);
context.location.protocol='file:';context.location.origin='null';scriptUrl='file:///project/web/assets/common.js';
assert.equal(context.window.UI.routeUrl('workspace'),'file:///project/web/workspace.html');
"""
        executed = subprocess.run(["node", "-e", script, str(source)], capture_output=True, text=True)
        self.assertEqual(executed.returncode, 0, executed.stderr)

    @unittest.skipUnless(shutil.which("node"), "前端契约动态执行需要Node.js")
    def test_frontend_api_keys_against_real_http_routes(self):
        source = Path(__file__).resolve().parents[1] / "web" / "assets" / "api.js"
        script = """
const fs=require('fs'),vm=require('vm');
const calls=[]; const context={window:{},UI:{api:(path,options)=>calls.push({key:context.currentKey,path,method:options.method})}};
vm.createContext(context);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),context);
const methods={install:'GET',setup:'POST',registration:'POST',login:'POST',session:'DELETE',me:'GET',workspaces:'GET',workspace:'POST',members:'GET',member:'POST',nodes:'GET',folder:'POST',file:'PATCH',content:'GET',upload:'POST',ticket:'POST',shares:'GET',share:'POST',shareDetail:'GET',users:'GET',user:'POST',setting:'PATCH',settings:'GET'};
for(const [key,method] of Object.entries(methods)){context.currentKey=key;context.window.API(key,{method})}
let rejected=false;try{context.window.API('not-in-contract',{})}catch(e){rejected=true}
if(!rejected)throw Error('未拒绝未知API键');process.stdout.write(JSON.stringify(calls));
"""
        executed = subprocess.run(["node", "-e", script, str(source)], check=True, capture_output=True, text=True)
        calls = json.loads(executed.stdout)
        self.assertEqual(len(calls), 23)
        for call in calls:
            with self.subTest(key=call["key"]):
                self.assertTrue(call["path"].startswith(BASE + "/"))
                status, data, _ = self.request(call["method"], call["path"][len(BASE):], "admin", {} if call["method"] in ("POST", "PATCH", "PUT") else None,
                                               query={"workspaceId": self.workspace, "path": "", "token": "invalid-token-for-contract"})
                self.assertNotEqual(status, 500, data)
                self.assertNotEqual(data.get("status") if isinstance(data, dict) else None, "ROUTE_NOT_EXIST", data)
                if status >= 400:
                    self.assertEqual(set(data), {"msg", "code", "status"})
                    self.assertEqual(data["code"], status)
                if call["key"] == "session":
                    status, _, headers = self.request("POST", "/visitor/session", body={"userName": "qa-admin", "password": "qa-isolated-password-123"})
                    self.assertEqual(status, 200)
                    self.cookies["admin"] = headers["set-cookie"].split(";", 1)[0]

    def test_csrf_rejection_drains_large_body_and_returns_complete_error(self):
        body = {"workspaceId": self.workspace, "path": "csrf-body-test", "ignoredPadding": "x" * (256 * 1024)}
        for headers in ({"Origin": "http://untrusted.invalid"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, data, _ = self.request("POST", "/folder", "owner", body, headers=headers)
                self.assertEqual(status, 403)
                self.assertEqual(data["status"], "ORIGIN_DENIED")
                self.assertEqual(data["code"], 403)
                self.assertEqual(set(data), {"msg", "code", "status"})
        self.assertFalse(self.app.service.disk_path(self.workspace, "csrf-body-test").exists())

    def test_csrf_and_auth_guards(self):
        self.denied("GET", "/workspace/list", None, expected=401)
        status, _, _ = self.request("POST", "/folder", "owner", {"workspaceId": self.workspace, "path": "csrf"}, headers={"Origin": "http://untrusted.invalid"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/session/detail", "owner", headers={"Host": "untrusted.invalid"})
        self.assertEqual(status, 403)


if __name__ == "__main__":
    unittest.main(verbosity=2)
