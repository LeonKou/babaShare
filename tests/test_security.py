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
from urllib.parse import urlencode, urljoin, urlsplit
from unittest import mock

from backend.config import Config
from backend.controller import Application, BASE
from backend.repository import db_id, now_ms


class SecurityHttpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="baba-share-qa-")
        cls.config = Config(root=Path(cls.temp.name), port=1)
        cls.app = Application(cls.config)
        from http.server import ThreadingHTTPServer
        cls.main = ThreadingHTTPServer(("127.0.0.1", 0), cls.app.handler())
        cls.config.port = cls.main.server_port
        cls.config.public_origin = f"http://127.0.0.1:{cls.main.server_port}"
        cls.threads = []
        for server in (cls.main,):
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
        for server in (cls.main,):
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join()
        cls.temp.cleanup()

    @classmethod
    def request(cls, method, route, actor=None, body=None, query=None, preview=False, headers=None):
        port = cls.main.server_port
        path = route if preview or not route.startswith("/") else BASE + route
        if query:
            path += "?" + urlencode(query)
        request_headers = {"Origin": cls.config.public_origin, "Content-Type": "application/json"}
        if actor:
            request_headers["Cookie"] = cls.cookies[actor]
        for name, value in (headers or {}).items():
            if value is None:
                request_headers.pop(name, None)
            else:
                request_headers[name] = value
        raw = json.dumps(body).encode() if body is not None else None
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        try:
            connection.request(method, path, body=raw, headers=request_headers)
            response = connection.getresponse()
            data = response.read()
            result_headers = dict(response.getheaders())
            result_headers = {key.lower(): value for key, value in result_headers.items()}
            if data and "application/json" in result_headers.get("content-type", ""):
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

    def test_primary_pages_allow_only_same_origin_iframes(self):
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
            self.assertIn("frame-src 'self';", policy)
            self.assertNotIn("sandbox", policy)
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

    def assert_sandbox(self, headers):
        self.assertIn("sandbox allow-scripts;", headers["content-security-policy"])
        self.assertNotIn("allow-same-origin", headers["content-security-policy"])
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertNotIn("set-cookie", headers)
        self.assertNotIn("access-control-allow-credentials", headers)

    def test_raw_preview_all_responses_keep_sandbox(self):
        share = self.make_share()
        prefix = "/baba-share/preview/s/" + share["token"]
        cases = [("GET", prefix, 307), ("GET", prefix + "/index.html", 200),
                 ("GET", prefix + "/missing.html", 404), ("GET", prefix + "/%FF", 400),
                 ("GET", "/baba-share/preview", 404),
                 ("GET", "/baba-share/preview/unknown/token/file.html", 404),
                 ("GET", prefix + "/%2e%2e/private.txt", 400),
                 ("POST", prefix + "/index.html", 405), ("PUT", prefix + "/index.html", 405),
                 ("DELETE", prefix + "/index.html", 405), ("HEAD", prefix + "/index.html", 501),
                 ("OPTIONS", prefix + "/index.html", 501), ("TRACE", prefix + "/index.html", 501),
                 ("CUSTOM", prefix + "/index.html", 501)]
        for method, path, expected in cases:
            with self.subTest(method=method, path=path):
                status, _, headers = self.request(method, path, preview=True)
                self.assertEqual(status, expected)
                self.assert_sandbox(headers)
        with self.assertLogs("baba-share", level="ERROR"), mock.patch.object(self.app.service, "preview_resource", side_effect=RuntimeError("隔离测试错误")):
            status, _, headers = self.request("GET", prefix + "/index.html", preview=True)
        self.assertEqual(status, 500)
        self.assert_sandbox(headers)
        status, _, headers = self.request("GET", "/baba-share/s/" + share["token"], preview=True)
        self.assertEqual(status, 200)
        self.assertNotIn("sandbox", headers["content-security-policy"])
        self.ok("DELETE", "/share", "owner", query={"id": share["id"]})
        status, _, headers = self.request("GET", prefix + "/index.html", preview=True)
        self.assertEqual(status, 404)
        self.assert_sandbox(headers)

    def test_raw_preview_drops_accidental_set_cookie(self):
        handler = self.app.handler()
        original = handler.reply

        def accidental_cookie(request, *args, **kwargs):
            kwargs["cookie"] = "must-not-leak"
            kwargs["headers"] = {**kwargs.get("headers", {}), "set-cookie": "injected=must-not-leak"}
            return original(request, *args, **kwargs)

        with mock.patch.object(handler, "reply", accidental_cookie):
            from http.server import ThreadingHTTPServer
            server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=5)
                connection.request("GET", "/baba-share/preview/invalid")
                response = connection.getresponse()
                response.read()
                self.assertEqual(response.status, 404)
                self.assertIsNone(response.getheader("Set-Cookie"))
                self.assertIn("sandbox allow-scripts;", response.getheader("Content-Security-Policy"))
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_malformed_preview_request_keeps_sandbox(self):
        import socket
        for request in (b"GET /baba-share/preview/s/token/index.html HTTP/invalid\r\n\r\n",
                        b"GET /baba-share/preview/s/token/index.html\r\n\r\n"):
            with self.subTest(request=request), socket.create_connection(("127.0.0.1", self.main.server_port), 5) as connection:
                connection.sendall(request)
                response = connection.makefile("rb").read()
            self.assertIn(b"HTTP/1.1 400", response)
            self.assertIn(b"Content-Security-Policy: sandbox allow-scripts;", response)
            self.assertNotIn(b"allow-same-origin", response)

    def test_null_origin_cannot_read_or_mutate_cookie_api(self):
        for method, route, body in (("GET", "/session/detail", None),
                                    ("GET", "/visitor/install/detail", None),
                                    ("POST", "/visitor/session", {"userName": "qa-owner", "password": "qa-isolated-password-123"}),
                                    ("POST", "/workspace", {"workspaceName": "blocked-opaque"}),
                                    ("DELETE", "/session", None)):
            for site in (None, "same-origin", "none", "cross-site"):
                with self.subTest(route=route, site=site):
                    status, data, headers = self.request(method, route, "owner", body, headers={"Origin": "null", "Sec-Fetch-Site": site})
                    self.assertEqual((status, data["status"]), (403, "ORIGIN_DENIED"))
                    self.assertNotIn("access-control-allow-origin", headers)
                    self.assertNotIn("set-cookie", headers)
        self.assertEqual(self.request("GET", "/session/detail", "owner")[0], 200)
        status, _, headers = self.request("POST", "/mcp", "owner", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"Origin": "null"})
        self.assertEqual(status, 403)
        self.assertNotIn("access-control-allow-origin", headers)

    def test_preview_urls_share_one_origin_and_iframes_keep_sandbox(self):
        share = self.make_share()
        detail = self.ok("GET", "/visitor/share/detail", query={"token": share["token"]})
        ticket = self.ok("POST", "/preview/ticket", "owner", {"workspaceId": self.workspace, "path": "site"})
        for result, kind in ((detail, "s"), (ticket, "p")):
            self.assertEqual(urlsplit(result["previewUrl"]).netloc, urlsplit(self.config.public_origin).netloc)
            self.assertIn("/baba-share/preview/" + kind + "/", result["previewBaseUrl"])
            self.assertTrue(result["previewUrl"].startswith(result["previewBaseUrl"]))
            css = urljoin(result["previewUrl"], "assets/main.css")
            status, _, headers = self.request("GET", urlsplit(css).path, preview=True)
            self.assertEqual(status, 200)
            self.assert_sandbox(headers)
        html = (self.config.web_dir / "share.html").read_text(encoding="utf-8")
        script = (self.config.web_dir / "assets/common.js").read_text(encoding="utf-8")
        self.assertIn('sandbox="allow-scripts"', html)
        self.assertIn('sandbox: "allow-scripts"', script)
        self.assertNotIn("allow-same-origin", html + script)

    @unittest.skipUnless(shutil.which("node"), "前端路径防护动态执行需要Node.js")
    def test_share_file_query_cannot_navigate_outside_raw_namespace(self):
        source = self.config.web_dir / "assets/share.js"
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const source=fs.readFileSync(process.argv[1],'utf8');
const code=source.slice(source.indexOf('  function selectFile(entry)'),source.indexOf('  async function loadDirectory'));
const nodes=new Map(),get=id=>{if(!nodes.has(id))nodes.set(id,{});return nodes.get(id)};
let notices=0;
const context={$:get,previewBase:'http://127.0.0.1:12345/baba-share/preview/s/token/',currentFile:'',
 toast:()=>notices++,I18n:{t:x=>x},URL,location:{href:'http://127.0.0.1:12345/baba-share/s/token'},history:{replaceState(){}},document:{querySelectorAll:()=>[]}};
vm.createContext(context);vm.runInContext(code,context);
for(const path of ['../../auth.html','./index.html','/index.html','site//index.html','site\\index.html']){
 context.selectFile({name:'index.html',path});assert.equal(get('#shared-frame').src,undefined);
}
assert.equal(notices,5);
context.selectFile({name:'index.html',path:'sub/index.html'});
assert.equal(get('#shared-frame').src,context.previewBase+'sub/index.html');
'''
        result = subprocess.run(["node", "-e", script, str(source)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_share_isolation_revocation_and_headers(self):
        share = self.make_share()
        detail = self.ok("GET", "/visitor/share/detail", query={"token": share["token"]})
        self.assertNotIn("workspaceId", detail["share"])
        self.assertTrue(all(entry["ownerId"] is None for entry in detail["listing"]["entries"]))
        prefix = "/baba-share/preview/s/" + share["token"] + "/"
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
        prefix = "/baba-share/preview/s/" + share["token"]
        for path in (prefix, prefix + "/sub"):
            with self.subTest(path=path):
                status, _, headers = self.request("GET", path, preview=True)
                self.assertIn(status, (301, 302, 307, 308))
                location = urlsplit(headers["location"])
                if location.netloc:
                    self.assertEqual(location.netloc, urlsplit(self.config.public_origin).netloc)
                self.assertEqual(location.path, path + "/")
                final_status, data, _ = self.request("GET", location.path, preview=True)
                self.assertEqual(final_status, 200)
                self.assertIn(b"<html>", data)

    def test_share_resources_revoke_on_member_removal(self):
        self.file("site/index.html")
        self.file("site/main.css")
        share = self.ok("POST", "/share", "peer", {"workspaceId": self.workspace, "path": "site"})
        prefix = "/baba-share/preview/s/" + share["token"] + "/"
        self.assertEqual(self.request("GET", prefix + "main.css", preview=True)[0], 200)
        self.ok("DELETE", "/member", "owner", query={"workspaceId": self.workspace, "userId": self.users["peer"]["id"]})
        self.denied("GET", "/visitor/share/detail", None, query={"token": share["token"]}, expected=404)
        for resource in ("index.html", "main.css"):
            self.assertEqual(self.request("GET", prefix + resource, preview=True)[0], 404)

    def test_share_resources_revoke_on_root_move(self):
        share = self.make_share()
        self.ok("PATCH", "/folder", "owner", {"workspaceId": self.workspace, "path": "site", "newPath": "renamed"})
        for resource in ("index.html", "assets/main.css"):
            self.assertEqual(self.request("GET", "/baba-share/preview/s/" + share["token"] + "/" + resource, preview=True)[0], 404)

    def test_share_expiry_applies_to_assets(self):
        share = self.make_share()
        self.app.service.repo.execute("UPDATE folder_share SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(share["id"])))
        self.denied("GET", "/visitor/share/detail", None, query={"token": share["token"]}, expected=404)
        for resource in ("index.html", "assets/main.css"):
            self.assertEqual(self.request("GET", "/baba-share/preview/s/" + share["token"] + "/" + resource, preview=True)[0], 404)

    def test_preview_ticket_revoked_by_member_removal(self):
        self.file("site/index.html")
        ticket = self.ok("POST", "/preview/ticket", "viewer", {"workspaceId": self.workspace, "path": "site"})
        path = urlsplit(ticket["previewUrl"]).path
        self.assertEqual(self.request("GET", path, preview=True)[0], 200)
        self.ok("DELETE", "/member", "owner", query={"workspaceId": self.workspace, "userId": self.users["viewer"]["id"]})
        self.assertEqual(self.request("GET", path, preview=True)[0], 403)

    def test_gateway_origin_mismatch_preserves_authentication_and_permission_semantics(self):
        headers = {"Origin": "https://product.rd.chn-das.com", "Host": "127.0.0.1:8080", "Sec-Fetch-Site": "same-origin"}
        status, data, _ = self.request("POST", "/visitor/session", body={"userName": "qa-admin", "password": "wrong-password"}, headers=headers)
        self.assertEqual((status, data["status"]), (401, "LOGIN_FAILED"))
        status, data, _ = self.request("GET", "/session/detail", headers={**headers, "Cookie": "baba_share_session=expired"})
        self.assertEqual((status, data["status"]), (401, "AUTH_REQUIRED"))
        status, data, _ = self.request("POST", "/workspace", "viewer", {"workspaceName": "still-readonly"}, headers=headers)
        self.assertEqual((status, data["status"]), (403, "READ_ONLY"))
        self.assertEqual(self.request("GET", "/session/detail", actor="viewer", headers=headers)[0], 200)

    def test_gateway_https_to_http_install_login_logout_ignore_public_origin_and_host(self):
        for configured in ("http://127.0.0.1:8080", "http://product.rd.chn-das.com", "https://other.example:9443"):
            with self.subTest(public_origin=configured), mock.patch.object(self.config, "public_origin", configured), mock.patch.object(self.config, "secure_cookie", True):
                headers = {"Origin": "https://product.rd.chn-das.com", "Host": "127.0.0.1:8080", "Sec-Fetch-Site": "same-origin"}
                for origin in (None, headers["Origin"]):
                    status, data, _ = self.request("GET", "/visitor/install/detail", headers={**headers, "Origin": origin})
                    self.assertEqual(status, 200, data)
                    self.assertFalse(data["setupRequired"])
                status, user, response_headers = self.request("POST", "/visitor/session", body={"userName": "qa-admin", "password": "qa-isolated-password-123"}, headers=headers)
                self.assertEqual((status, user["id"]), (200, self.users["admin"]["id"]))
                self.assertIn("; Secure", response_headers["set-cookie"])
                cookie = response_headers["set-cookie"].split(";", 1)[0]
                authenticated = {**headers, "Cookie": cookie}
                self.assertEqual(self.request("GET", "/session/detail", headers=authenticated)[0], 200)
                status, data, response_headers = self.request("DELETE", "/session", headers=authenticated)
                self.assertEqual((status, data), (200, {}))
                self.assertIn("Max-Age=0", response_headers["set-cookie"])
                status, data, _ = self.request("GET", "/session/detail", headers=authenticated)
                self.assertEqual((status, data["status"]), (401, "AUTH_REQUIRED"))

    def test_gateway_without_fetch_metadata_does_not_require_origin_or_forwarded_headers(self):
        for headers in ({"Origin": None, "Host": "internal-gateway:8080"},
                        {"Origin": "https://tenant.example", "Host": "internal-gateway:8080"},
                        {"Origin": "https://tenant.example", "Host": "other-internal:8080", "X-Forwarded-Host": "untrusted.invalid", "X-Forwarded-Proto": "http", "Forwarded": "host=untrusted.invalid;proto=http"}):
            with self.subTest(headers=headers):
                self.assertEqual(self.request("GET", "/visitor/install/detail", headers=headers)[0], 200)
                status, _, response_headers = self.request("POST", "/visitor/session", body={"userName": "qa-admin", "password": "qa-isolated-password-123"}, headers=headers)
                self.assertEqual(status, 200)
                self.assertNotIn("; Secure", response_headers["set-cookie"])
                authenticated = {**headers, "Cookie": response_headers["set-cookie"].split(";", 1)[0]}
                self.assertEqual(self.request("DELETE", "/session", headers=authenticated)[0], 200)

    def test_preview_csp_is_not_bound_to_configured_public_origin(self):
        share = self.make_share()
        with mock.patch.object(self.config, "public_origin", "https://other.example"):
            status, _, headers = self.request("GET", "/baba-share/preview/s/" + share["token"] + "/index.html", preview=True,
                                              headers={"Origin": "null", "Host": "127.0.0.1:8080", "Sec-Fetch-Site": "cross-site"})
        self.assertEqual(status, 200)
        self.assert_sandbox(headers)
        self.assertIn("frame-ancestors 'self'", headers["content-security-policy"])
        self.assertNotIn("https://other.example", headers["content-security-policy"])

    @unittest.skipUnless(shutil.which("node"), "认证导航动态执行需要Node.js")
    def test_frontend_login_and_session_expiry_regressions(self):
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const assets=process.argv[1],origin='http://127.0.0.1:12345';
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.events={};this.dataset={};this.style={};this.value='';this.textContent='';this.disabled=false;this.attributes={};this.classList={add(){},remove(){},toggle(){}};}
 append(...items){this.children.push(...items.filter(x=>x!=null));}
 prepend(...items){this.children.unshift(...items);}
 replaceChildren(...items){this.children=[];this.append(...items);}
 setAttribute(k,v){this.attributes[k]=v;if(k==='value')this.value=v;if(k==='name')this.name=v;if(k==='id')this.id=v;}
 getAttribute(k){return this.attributes[k];}
 addEventListener(k,fn){this.events[k]=fn;}
 removeEventListener(k,fn){if(this.events[k]===fn)delete this.events[k];}
 querySelector(){return null;}
 querySelectorAll(){return [];}
 get elements(){const found=[];const walk=n=>{if(n.name)found.push(n);for(const x of n.children||[])if(typeof x==='object')walk(x);};walk(this);found.namedItem=name=>found.find(x=>x.name===name);return found;}
}
function runtime(path='workspace.html'){
 const nodes=new Map(),events=new Map(),replaces=[],requests=[];
 const get=s=>{if(!nodes.has(s))nodes.set(s,new Element());return nodes.get(s);};
 const location={href:origin+'/baba-share/'+path,origin,protocol:'http:',pathname:'/baba-share/'+path,replace:u=>replaces.push(u),reload(){}};
 const document={readyState:'complete',documentElement:{lang:'zh-CN',dataset:{mode:'dark'}},body:new Element('body'),createElement:t=>new Element(t),createElementNS:(ns,t)=>new Element(t),createTextNode:text=>String(text),querySelector:s=>s==='script[src$="common.js"]'?{src:origin+'/baba-share/assets/common.js'}:get(s),querySelectorAll:()=>[]};
 const context={URL,console,setTimeout,clearTimeout,queueMicrotask,location,document,history:{replaceState(){}},FormData:class{constructor(form){return form.elements.filter(n=>n.name&&!n.disabled).map(n=>[n.name,n.value]);}},I18n:{t:k=>k,accents:['blue','green','purple','red','orange','teal'],normalizeContext:ctx=>({locale:ctx.locale,theme:ctx.theme,dir:ctx.dir,accent:ctx.accent||'blue'}),ctx:{locale:'zh-CN',theme:'dark',dir:'ltr',accent:'blue'},subscribe(){},apply(){},persist(){}},fetch:async(url,options)=>{requests.push({url:String(url),options});return {status:context.code,ok:context.code<400,json:async()=>context.data};},code:401,data:{status:'AUTH_REQUIRED'},addEventListener:(name,fn)=>{if(!events.has(name))events.set(name,new Set());events.get(name).add(fn);},removeEventListener:(name,fn)=>events.get(name)?.delete(fn)};
 context.window=context;context.parent=context;vm.createContext(context);
 const load=file=>vm.runInContext(fs.readFileSync(assets+'/'+file,'utf8'),context);
 load('common.js');load('api.js');
 return {context,load,get,events,replaces,requests};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
(async()=>{
 // 未登录及并发401使用固定安全地址，忽略恶意returnUrl。
 for(const path of ['index.html?returnUrl=https://evil.invalid','', 'workspace.html','account.html','users.html']){
  const r=runtime(path);r.context.location.pathname='/baba-share/'+path.split('?')[0];
  await Promise.allSettled([r.context.API('me'),r.context.API('workspaces'),r.context.API('users')]);
  assert.deepEqual(r.replaces,[origin+'/baba-share/auth.html']);
 }
 // 只有固定退出DELETE例外，业务调用即使传authRequired:false也不能绕过401处理。
 {
  const r=runtime();await assert.rejects(r.context.API('me',{authRequired:false}));assert.equal(r.replaces.length,1);
  const other=runtime();await assert.rejects(other.context.API('session',{method:'GET',authRequired:false}));assert.equal(other.replaces.length,1);
 }
 // 错误凭据、匿名安装/注册/分享请求不引发注销；业务403保持当前会话。
 for(const key of ['install','login','setup','registration','shareDetail']){
  const r=runtime();await assert.rejects(r.context.API(key));assert.equal(r.replaces.length,0,key);
 }
 for(const status of ['PERMISSION_DENIED','READ_ONLY','ORIGIN_DENIED']){
  const r=runtime();r.context.code=403;r.context.data={status};await assert.rejects(r.context.API('workspace',{method:'POST',body:{}}),e=>e.httpStatus===403&&e.status===status);assert.equal(r.replaces.length,0);
 }
 for(const path of ['auth.html','share.html','s/anonymous-token']){
  const r=runtime(path);await assert.rejects(r.context.API('me'));assert.equal(r.replaces.length,0,path);
 }
 // 独立页面通过真实adapter跳转，即使有未保存状态也不会被拦住。
 {
  const r=runtime();r.load('page-bridge.js');const page=r.context.UI.page();await page.ready;page.setDirty(true);
  await assert.rejects(r.context.API('me'));assert.equal(page.dirty,false);assert.deepEqual(r.replaces,[origin+'/baba-share/auth.html']);
 }
 // 运行实际母版、版本化桥接、子页公共API。子页只通知母版，母版并发也只replace一次。
 {
  const host=runtime('index.html'),child=runtime('workspace.html');
  const dispatch=(runtime,event)=>{for(const fn of runtime.events.get('message')||[])fn(event);};
  const hostProxy={location:{origin},postMessage:message=>queueMicrotask(()=>dispatch(host,{origin,source:childProxy,data:message}))};
  const childProxy={postMessage:message=>queueMicrotask(()=>dispatch(child,{origin,source:hostProxy,data:message}))};
  child.context.parent=hostProxy;host.get('#page-frame').contentWindow=childProxy;
  host.load('bridge-core.js');host.load('app-bridge.js');child.load('bridge-core.js');child.load('page-bridge.js');
  host.context.API=async key=>key==='install'?{setupRequired:false}:key==='me'?{nickname:'Viewer',role:'viewer'}:[];
  await host.load('shell.js');assert.equal(host.get('#new-workspace').hidden,true);
  const page=child.context.UI.page();await page.ready;assert.equal(page.embedded,true);page.setDirty(true);
  await Promise.allSettled([child.context.API('me'),child.context.API('workspaces'),host.context.UI.sessionExpired()]);
  assert.equal(child.replaces.length,0);assert.deepEqual(host.replaces,[origin+'/baba-share/auth.html']);assert.equal(page.dirty,false);
  for(const fn of host.events.get('pagehide')||[])fn();for(const fn of child.events.get('pagehide')||[])fn();
 }
 // 退出401已无有效会话；403/网络未确认退出，均不阻塞返回登录。
 for(const code of [200,401,403,'network']){
  const r=runtime('index.html'),api=r.context.API;r.load('bridge-core.js');r.load('app-bridge.js');
  r.context.API=async key=>key==='install'?{setupRequired:false}:key==='me'?{nickname:'Viewer',role:'viewer'}:[];
  await r.load('shell.js');r.context.API=api;
  r.context.code=code;r.context.data=code===403?{status:'ORIGIN_DENIED'}:code===401?{status:'AUTH_REQUIRED'}:{};
  if(code==='network')r.context.fetch=async()=>{throw new TypeError('offline')};
  await r.get('#logout').events.click();
  assert.deepEqual(r.replaces,[origin+'/baba-share/auth.html'+([200,401].includes(code)?'':'?logout=failed')]);
  for(const fn of r.events.get('pagehide')||[])fn();
 }
 // 实际母版启动请求未登录me401时立即自动跳登录，不依赖退出按钮。
 {
  const r=runtime('index.html');r.load('bridge-core.js');r.load('app-bridge.js');
  r.context.fetch=async url=>String(url).endsWith('/visitor/install/detail')?{status:200,ok:true,json:async()=>({setupRequired:false})}:{status:401,ok:false,json:async()=>({status:'AUTH_REQUIRED'})};
  await r.load('shell.js');assert.deepEqual(r.replaces,[origin+'/baba-share/auth.html']);
  for(const fn of r.events.get('pagehide')||[])fn();
 }
 // 登录页将退出未确认状态保留下来；即使install仍403也不会丢失告知。
 for(const code of [200,403]){
  const r=runtime('auth.html?logout=failed');r.context.location.pathname='/baba-share/auth.html';r.context.code=code;
  r.context.data=code===200?{setupRequired:false,registrationEnabled:false}:{status:'ORIGIN_DENIED'};
  await r.load('auth.js');assert(r.get('#auth-status').textContent.includes('logoutUnconfirmed'));
  if(code===403)assert(r.get('#auth-status').textContent.includes('originDenied'));
 }
 // 握手降级和连接失败也有安全的本页登录导航，不向父文档读写DOM。
 {
  const r=runtime();r.context.AppPage={setDirty(){},request:async()=>{throw Error('BRIDGE_CLOSED')}};
  await assert.rejects(r.context.API('me'));assert.deepEqual(r.replaces,[origin+'/baba-share/auth.html']);
 }
 // 真实auth脚本：安装状态成功后匿名登录/初始化/注册均可提交；失败凭据留在登录页并恢复按钮。
 for(const [setupRequired,registrationEnabled,query,mode] of [[false,false,'','login'],[true,false,'','setup'],[false,true,'?mode=register','registration']]){
  const r=runtime('auth.html'+query);r.context.location.pathname='/baba-share/auth.html';r.context.code=200;r.context.data={setupRequired,registrationEnabled};
  await r.load('auth.js');assert.equal(r.get('#auth-submit').disabled,false,mode);
  for(const input of r.get('#auth-fields').elements)input.value=input.name==='password'?'123456':'anonymous';
  const password=r.get('#auth-fields').elements.namedItem('password');
  password.value='12345';assert.equal(password.validate(),mode==='login',mode+' 五字符边界');
  password.value='123456';assert.equal(password.validate(),true,mode+' 六字符边界');
  password.value='x'.repeat(257);assert.equal(password.validate(),mode==='login',mode+' 密码上限');
  password.value='123456';
  r.get('#auth-form').append(r.get('#auth-fields'));r.context.code=401;r.context.data={status:'LOGIN_FAILED'};
  await r.get('#auth-form').events.submit({preventDefault(){}});
  assert(r.requests.at(-1).url.includes(mode==='setup'?'/visitor/account/setup':mode==='registration'?'/visitor/account/registration':'/visitor/session'));
  assert.equal(r.replaces.length,0);assert.equal(r.get('#auth-submit').disabled,false);assert.equal(r.get('#auth-status').textContent,'loginFailed');
 }
 // 初始化来源拒绝时保留失败关闭行为，但明确显示来源配置错误，不再误称权限不足。
 {
  const r=runtime('auth.html');r.context.code=403;r.context.data={status:'ORIGIN_DENIED'};await r.load('auth.js');
  assert.equal(r.get('#auth-submit').disabled,true);assert.equal(r.get('#auth-status').textContent,'originDenied');assert.equal(r.replaces.length,0);
 }
})().catch(e=>{console.error(e);process.exitCode=1});
'''
        executed = subprocess.run(["node", "-e", script, str(self.config.web_dir / "assets")], capture_output=True, text=True, timeout=20)
        self.assertEqual(executed.returncode, 0, executed.stderr)

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
        for headers in ({"Origin": "http://untrusted.invalid", "Sec-Fetch-Site": "cross-site"}, {"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}, {"Sec-Fetch-Site": "same-site"}):
            with self.subTest(headers=headers):
                status, data, _ = self.request("POST", "/folder", "owner", body, headers=headers)
                self.assertEqual(status, 403)
                self.assertEqual(data["status"], "ORIGIN_DENIED")
                self.assertEqual(data["code"], 403)
                self.assertEqual(set(data), {"msg", "code", "status"})
        self.assertFalse(self.app.service.disk_path(self.workspace, "csrf-body-test").exists())

    def test_csrf_and_auth_guards(self):
        self.denied("GET", "/workspace/list", None, expected=401)
        for site in ("cross-site", "same-site", "", "invalid"):
            for origin in (None, "https://product.rd.chn-das.com"):
                with self.subTest(site=site, origin=origin):
                    headers = {"Origin": origin, "Sec-Fetch-Site": site, "Host": "internal-gateway:8080", "X-Forwarded-Host": "product.rd.chn-das.com", "X-Forwarded-Proto": "https"}
                    for method, route, body in (("GET", "/session/detail", None),
                                                ("POST", "/folder", {"workspaceId": self.workspace, "path": "csrf"}),
                                                ("DELETE", "/session", None)):
                        status, data, _ = self.request(method, route, "owner", body, headers=headers)
                        self.assertEqual((status, data["status"]), (403, "ORIGIN_DENIED"))
        for site in (None, "same-origin", "none"):
            self.assertEqual(self.request("GET", "/session/detail", "owner", headers={"Sec-Fetch-Site": site, "Host": "internal-gateway:8080"})[0], 200)
        self.assertFalse(self.app.service.disk_path(self.workspace, "csrf").exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
