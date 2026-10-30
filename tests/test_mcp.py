"""使用临时数据库与真实HTTP验证个人密钥和MCP协议权限。"""
import base64
import concurrent.futures
import http.client
import json
import hashlib
import hmac
import os
import secrets
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import unittest
import uuid
from unittest import mock
from http.server import ThreadingHTTPServer
from pathlib import Path

from backend.config import Config
from backend.controller import Application, BASE, COOKIE_NAME
from backend.repository import Repository, db_id, now_ms
from backend.service import BizError, digest


class MCPTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="baba-share-mcp-")
        self.config = Config(Path(self.temp.name), port=1, preview_port=2)
        self.app = Application(self.config)
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.app.handler(False))
        self.config.public_origin = f"http://127.0.0.1:{self.server.server_port}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.admin, self.cookie = self.account("admin", "setup")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()

    def account(self, name, mode="admin", role="editor"):
        service = self.app.service
        view = service.account({"userName": name, "password": "mcp-test-password", "role": role},
                               mode=mode, actor=getattr(self, "admin", None))
        user = service.repo.user(view["id"])
        cookie = COOKIE_NAME + "=" + service.new_session(user["id"])
        return user, cookie

    def request(self, method, route, body=None, cookie=None, key=None, headers=None, raw=None):
        request_headers = {"Content-Type": "application/json"}
        if cookie:
            request_headers.update({"Cookie": cookie, "Origin": self.config.public_origin})
        if key:
            request_headers["Authorization"] = "Bearer " + key
        request_headers.update(headers or {})
        payload = raw if raw is not None else json.dumps(body).encode() if body is not None else None
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=5)
        try:
            connection.request(method, BASE + route, payload, request_headers)
            response = connection.getresponse()
            content = response.read()
            return response.status, json.loads(content) if content else None, dict(response.getheaders())
        finally:
            connection.close()

    def create_key(self, cookie=None, hours=24, request_id=None, name="测试密钥"):
        status, result, _ = self.request("POST", "/mcp-key", {"keyName": name, "expireHours": hours,
                  "requestId": request_id or str(uuid.uuid4())}, cookie=cookie or self.cookie)
        self.assertEqual(status, 200, result)
        return result

    def rpc(self, key, method, params=None, request_id=1, headers=None):
        body = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if request_id is not None:
            body["id"] = request_id
        return self.request("POST", "/mcp", body=body, key=key, headers=headers)

    def call(self, key, name, arguments=None):
        status, result, _ = self.rpc(key, "tools/call", {"name": name, "arguments": arguments or {}})
        self.assertEqual(status, 200, result)
        return result

    def test_key_storage_list_and_no_secret_replay(self):
        request_id = str(uuid.uuid4())
        key = self.create_key(request_id=request_id, hours=None)
        self.assertTrue(key["key"].startswith("bsk-"))
        self.assertIsNone(key["expireTime"])
        row = self.app.service.repo.one("SELECT key_hash,key_prefix FROM auth_mcp_key WHERE id=?", (db_id(key["id"]),))
        self.assertEqual(row["key_hash"], digest(key["key"]))
        self.assertNotIn(key["key"], json.dumps(row))
        status, listing, _ = self.request("GET", "/mcp-key/list", cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(listing[0]["id"], key["id"])
        self.assertNotIn("key", listing[0])
        self.assertNotIn("key_hash", listing[0])
        body = {"keyName": "测试密钥", "expireHours": None, "requestId": request_id}
        status, result, _ = self.request("POST", "/mcp-key", body, cookie=self.cookie)
        self.assertEqual((status, result["status"]), (409, "KEY_ALREADY_CREATED"))
        body["expireHours"] = 1
        self.assertEqual(self.request("POST", "/mcp-key", body, cookie=self.cookie)[1]["status"], "REQUEST_CONFLICT")
        self.assertEqual(len(self.app.service.mcp_keys(self.admin)), 1)
        Repository(self.config.database_path)
        self.assertEqual(self.rpc(key["key"], "ping")[0], 200)
        self.assertIsNotNone(self.app.service.repo.user(self.admin["id"]))

    def test_copy_content_recovery_owner_cookie_and_lifecycle(self):
        key = self.create_key(hours=None)
        status, result, _ = self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(result["key"], key["key"])
        restarted = Application(self.config)
        self.assertEqual(restarted.service.mcp_key_content(self.admin, key["id"])["key"], key["key"])
        row = self.app.service.repo.one("SELECT mcp_derivation_nonce FROM auth_mcp_key WHERE id=?", (db_id(key["id"]),))
        master = (self.config.root / "data/mcp-key-master").read_bytes()
        context = b"babaShare/mcp-key/hmac-sha256/v1\0" + db_id(self.admin["id"]) + db_id(key["id"]) + bytes.fromhex(row["mcp_derivation_nonce"])
        expected = "bsk-" + base64.urlsafe_b64encode(hmac.new(master, context, hashlib.sha256).digest()).decode().rstrip("=")
        self.assertEqual(expected, key["key"])
        _, other_cookie = self.account("other-copy")
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=other_cookie)[0], 404)
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, key=key["key"], headers={"Origin": self.config.public_origin})[0], 401)
        for headers in ({"Origin": ""}, {"Origin": "https://untrusted.invalid"}, {"Sec-Fetch-Site": "cross-site"}, {"Host": "untrusted.invalid"}):
            self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie, headers=headers)[0], 403)
        self.assertEqual(self.request("GET", "/mcp-key/content?id=" + key["id"], cookie=self.cookie)[0], 404)
        user, disabled_cookie = self.account("disabled-copy")
        disabled_key = self.create_key(cookie=disabled_cookie)
        self.app.service.repo.execute("UPDATE sys_user SET is_disabled=1 WHERE id=?", (db_id(user["id"]),))
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": disabled_key["id"]}, cookie=disabled_cookie)[0], 401)
        expired = self.create_key()
        self.app.service.repo.execute("UPDATE auth_mcp_key SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(expired["id"])))
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": expired["id"]}, cookie=self.cookie)[1]["status"], "MCP_KEY_INACTIVE")
        self.app.service.mcp_key_revoke(self.admin, key["id"])
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)[1]["status"], "MCP_KEY_INACTIVE")

    def test_old_key_and_master_loss_fail_closed(self):
        key = self.create_key()
        self.app.service.repo.execute("UPDATE auth_mcp_key SET mcp_derivation_version=NULL,mcp_derivation_nonce=NULL WHERE id=?", (db_id(key["id"]),))
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)[1]["status"], "MCP_KEY_NOT_RECOVERABLE")
        fresh = self.create_key(name="master-loss")
        master = self.config.root / "data/mcp-key-master"
        master.unlink()
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": fresh["id"]}, cookie=self.cookie)[1]["status"], "MCP_KEY_RECOVERY_UNAVAILABLE")

    def test_master_replacement_corruption_permissions_and_symlink_fail_closed(self):
        key = self.create_key()
        path = self.config.root / "data/mcp-key-master"
        original = path.read_bytes()
        for contents in (secrets.token_bytes(32), b"", b"bad", secrets.token_bytes(33)):
            path.write_bytes(contents)
            response = self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)
            self.assertEqual((response[0], response[1]["status"]), (503, "MCP_KEY_RECOVERY_UNAVAILABLE"))
            self.assertNotIn("key", response[1])
            self.assertEqual(self.rpc(key["key"], "ping")[0], 200)
            body = {"keyName": "拒绝错误master", "expireHours": 1, "requestId": secrets.token_hex(16)}
            self.assertEqual(self.request("POST", "/mcp-key", body, cookie=self.cookie)[0], 503)
        path.write_bytes(original)
        if os.name != "nt":
            path.chmod(0o644)
            self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)[0], 503)
            path.chmod(0o600)
        path.unlink()
        self.assertEqual(self.request("POST", "/mcp-key", {"keyName": "missing", "requestId": secrets.token_hex(16)}, cookie=self.cookie)[0], 503)
        self.assertFalse(path.exists())
        target = self.config.root / "data/master-target"
        target.write_bytes(original)
        try:
            path.symlink_to(target)
        except OSError:
            return
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)[0], 503)
        self.assertTrue(path.is_symlink())
        self.assertEqual(target.read_bytes(), original)

    def test_recovery_does_not_log_secrets_and_read_errors_fail_closed(self):
        key = self.create_key()
        with mock.patch("backend.service.os.open", side_effect=PermissionError("denied")):
            status, response, _ = self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)
        self.assertEqual((status, response["status"]), (503, "MCP_KEY_RECOVERY_UNAVAILABLE"))
        with self.assertLogs("baba-share", level="ERROR") as captured:
            with mock.patch.object(self.app.service, "mcp_key_content", side_effect=RuntimeError(key["key"])):
                status, response, _ = self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)
        self.assertEqual(status, 500)
        self.assertNotIn(key["key"], json.dumps(response) + "".join(captured.output))
        self.assertEqual(self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie)[1]["key"], key["key"])

    def test_legacy_database_migration_is_nullable_and_master_is_lazy(self):
        with tempfile.TemporaryDirectory(prefix="baba-share-old-db-") as root:
            config = Config(Path(root), port=1, preview_port=2)
            connection = sqlite3.connect(config.database_path)
            try:
                connection.execute("CREATE TABLE auth_mcp_key (id BLOB PRIMARY KEY,user_id BLOB NOT NULL,key_name TEXT NOT NULL,key_prefix TEXT NOT NULL,key_hash TEXT NOT NULL,request_id TEXT NOT NULL,request_hash TEXT NOT NULL,expire_time BIGINT,revoked_time BIGINT,create_time BIGINT NOT NULL,update_time BIGINT NOT NULL)")
                connection.commit()
            finally:
                connection.close()
            Repository(config.database_path)
            connection = sqlite3.connect(config.database_path)
            try:
                columns = {row[1]: row for row in connection.execute("PRAGMA table_info(auth_mcp_key)")}
            finally:
                connection.close()
            self.assertEqual(columns["mcp_derivation_version"][3], 0)
            self.assertEqual(columns["mcp_derivation_nonce"][3], 0)
            self.assertFalse((config.root / "data/mcp-key-master").exists())

    def test_concurrent_http_creation_and_recovery_keep_master_and_request_id(self):
        body = {"keyName": "并发", "expireHours": None, "requestId": secrets.token_hex(16)}
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/mcp-key", body, cookie=self.cookie), range(8)))
        created = [entry[1] for entry in results if entry[0] == 200]
        self.assertEqual(len(created), 1)
        self.assertEqual(sum(entry[0] == 409 for entry in results), 7)
        key = created[0]
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/mcp-key/content", {"id": key["id"]}, cookie=self.cookie), range(16)))
        self.assertTrue(all(entry[0] == 200 and entry[1]["key"] == key["key"] for entry in results))
        self.assertTrue(all(entry[2]["Cache-Control"] == "no-store" for entry in results))
        self.assertEqual(len(self.app.service.mcp_keys(self.admin)), 1)

    @unittest.skipUnless(shutil.which("node"), "前端动态执行需要Node.js")
    def test_frontend_copy_uses_live_recovery_and_each_browser_origin(self):
        active = self.create_key()
        expired = self.create_key(name="expired")
        revoked = self.create_key(name="revoked")
        self.app.service.repo.execute("UPDATE auth_mcp_key SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(expired["id"])))
        self.app.service.mcp_key_revoke(self.admin, revoked["id"])
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert');
const input=JSON.parse(fs.readFileSync(0,'utf8'));
class Node {
  constructor(tag,attrs={}) { this.tag=tag; this.children=[];this.attrs=attrs;this.value=attrs.value||'';this.events={};this.hidden=false;this.disabled=false;this.textContent=attrs.text||'';this.classList={add(){},remove(){}}; }
  append(...nodes){ this.children.push(...nodes.filter(x=>x!=null)); }
  replaceChildren(...nodes){this.children=[];this.append(...nodes);}
  setAttribute(k,v){this.attrs[k]=v;}
  addEventListener(name,fn){this.events[name]=fn;}
  removeEventListener(){} focus(){} select(){}
}
const ids=new Map(),buttons=[];let copied=[],dialogs=[],notices=[],fallback=false;
const $=selector=>{if(!ids.has(selector))ids.set(selector,new Node('div'));return ids.get(selector);};
$('#mcp-filter').value='all';
const el=(tag,attrs,...children)=>{const n=new Node(tag,attrs);n.append(...children);return n;};
const button=(label,fn)=>{const n=el('button',{text:label});n.fn=fn;buttons.push(n);return n;};
const pending=[];
const location=new URL(input.origin+'/baba-share/account.html');
const context={console,URL,AbortController,crypto:require('crypto').webcrypto,queueMicrotask,Date,Uint8Array,
  location,history:{replaceState(){}},navigator:{clipboard:{writeText:async text=>{if(fallback)throw Error('blocked');copied.push(text);}}},
  document:{documentElement:{lang:'zh-CN',dir:'ltr',dataset:{mode:'dark'}},querySelectorAll(){return[];}},
  UI:{$,el,button,toast:t=>notices.push(t),errorText:e=>e.status||'error',date:String,empty:()=>el('div'),page:()=>({ready:Promise.resolve()}),
    confirm:()=>{throw Error('不允许复制确认弹窗');},
    api:async(path,options={})=>{const response=await fetch(input.origin+path,{method:options.method||'GET',headers:{Cookie:input.cookie,Origin:input.origin,'Content-Type':'application/json'},body:options.body?JSON.stringify(options.body):undefined});const data=await response.json();if(!response.ok)throw data;return data;},
    dialog:(title,build)=>{const node=el('dialog');let resolve;const result=new Promise(r=>resolve=r);const close=()=>{node.events.close?.();resolve(null);};dialogs.push({node,close,title});build(node,close);return{result,close};}},
  LocalPager:()=>({slice:x=>x,busy(){}}),addEventListener(){},removeEventListener(){}};
context.window=context;vm.createContext(context);
for(const file of ['i18n.js','api.js','mcp-help.js'])vm.runInContext(fs.readFileSync(input.assets+'/'+file,'utf8'),context);
(async()=>{
  const source=fs.readFileSync(input.assets+'/account.js','utf8');
  const html=fs.readFileSync(input.assets+'/../account.html','utf8');
  assert(!html.includes('mcp-install'));assert(!html.includes('mcp-help"'));assert(!source.includes('McpHelp.render'));
  await vm.runInContext(source,context);
  const cards=$('#mcp-cards').children;
  assert.equal(cards.length,3);
  const flatten=n=>n instanceof Node?[n,...n.children.flatMap(flatten)]:[];
  for(const card of cards){const title=flatten(card).find(n=>n.tag==='h3').textContent;const b=flatten(card).find(n=>n.textContent==='mcpCopyUse');assert(b);assert.equal(b.disabled,title==='expired'||title==='revoked');}
  for(const locale of ['zh-CN','en-US','ar-SA']){
    context.I18n.apply({locale,theme:'dark'});
    assert.notEqual(context.I18n.t('MCP_KEY_NOT_RECOVERABLE'),'MCP_KEY_NOT_RECOVERABLE');
    for(const origin of ['https://tenant.example:9443','http://127.0.0.1:18099','https://other.example']){
      context.location=new URL(origin+'/baba-share/account.html');
      await context.McpHelp.copyUse(input.id);
      const text=copied.at(-1);assert(text.includes(origin+'/api/baba-share/core/v1/mcp'));assert(text.includes(input.secret));assert(text.includes('bearer_token_env_var'));assert(text.includes('0600'));assert(text.includes('workspace_list'));assert(!text.includes('YOUR_PERSONAL'));assert(!text.includes(input.origin));
    }
  }
  context.location=new URL('https://created.example:7443/baba-share/account.html');
  const created=context.McpHelp.showCreated(input.id,e=>{throw e;});
  const createdDialog=dialogs.at(-1);const use=flatten(createdDialog.node).find(n=>n.textContent==='mcpCopyUse');
  await use.fn();assert(copied.at(-1).includes('https://created.example:7443/api/'));createdDialog.close();await created;
  fallback=true;const copying=context.McpHelp.copyUse(input.id);
  await new Promise(r=>setImmediate(r));
  for(let i=0;i<50&&!dialogs.some(d=>flatten(d.node).some(n=>n.tag==='textarea'));i++)await new Promise(r=>setTimeout(r,10));
  const dialog=dialogs.at(-1),area=flatten(dialog.node).find(n=>n.tag==='textarea');assert(area);assert(area.value.includes(input.secret));dialog.close();await copying;assert.equal(area.value,'');
  context.location=new URL('file:///account.html');
  await assert.rejects(context.McpHelp.copyUse(input.id),e=>e.status==='mcpUnavailable');
  process.stdout.write('前端真实HTTP复制与动态origin验证通过');
})().catch(e=>{console.error(e.name);process.exit(1);});
'''
        result = subprocess.run(["node", "-e", script], input=json.dumps({"origin": self.config.public_origin,
                                "cookie": self.cookie, "id": active["id"], "secret": active["key"],
                                "assets": str(self.config.web_dir / "assets")}), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_key_limits_expiry_revocation_and_owner_scope(self):
        keys = [self.create_key(name=str(index)) for index in range(10)]
        body = {"keyName": "超额", "expireHours": 1, "requestId": str(uuid.uuid4())}
        self.assertEqual(self.request("POST", "/mcp-key", body, cookie=self.cookie)[1]["status"], "MCP_KEY_LIMIT")
        self.app.service.repo.execute("UPDATE auth_mcp_key SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(keys[0]["id"])))
        self.assertEqual(self.rpc(keys[0]["key"], "ping")[0], 401)
        self.create_key()
        status, _, _ = self.request("DELETE", "/mcp-key?id=" + keys[1]["id"], cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertEqual(self.rpc(keys[1]["key"], "ping")[0], 401)
        self.assertEqual(self.request("DELETE", "/mcp-key?id=" + keys[1]["id"], cookie=self.cookie)[0], 200)
        _, other_cookie = self.account("other")
        self.assertEqual(self.request("DELETE", "/mcp-key?id=" + keys[2]["id"], cookie=other_cookie)[0], 404)
        self.assertEqual(self.request("GET", "/mcp-key/list", cookie=other_cookie)[1], [])

    def test_concurrent_quota_and_idempotency(self):
        service = self.app.service
        def create(index):
            try:
                return service.mcp_key_create(self.admin, {"keyName": str(index), "expireHours": 1,
                                              "requestId": str(uuid.uuid4())})
            except BizError as exc:
                return exc.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
            results = list(pool.map(create, range(15)))
        self.assertEqual(sum(isinstance(item, dict) for item in results), 10)
        self.assertEqual(results.count("MCP_KEY_LIMIT"), 5)

    def test_cookie_only_management_bearer_only_mcp_and_live_disable(self):
        user, cookie = self.account("editor")
        key = self.create_key(cookie=cookie)["key"]
        for route, method in (("/mcp-key/list", "GET"), ("/setting/detail", "GET"), ("/user/list", "GET")):
            self.assertEqual(self.request(method, route, key=key)[0], 401)
        self.assertEqual(self.request("POST", "/mcp-key", {"keyName": "非法", "requestId": str(uuid.uuid4())}, key=key,
                                      headers={"Origin": self.config.public_origin})[0], 401)
        self.assertEqual(self.request("POST", "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "ping"}, cookie=cookie)[0], 401)
        self.assertEqual(self.rpc(key, "ping")[0], 200)
        self.app.service.change_user(self.admin, {"id": user["id"], "isDisabled": True})
        self.assertEqual(self.rpc(key, "ping")[0], 401)

    def test_protocol_negotiation_transport_and_errors(self):
        key = self.create_key()["key"]
        for version in ("2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"):
            status, response, headers = self.rpc(key, "initialize", {"protocolVersion": version,
                              "clientInfo": {"name": "test", "version": "1"}, "capabilities": {}})
            self.assertEqual(status, 200)
            self.assertEqual(response["result"]["protocolVersion"], version if version.startswith("2025") else "2025-11-25")
            self.assertTrue(headers["Content-Type"].startswith("application/json"))
        self.assertEqual(self.rpc(key, "notifications/initialized", request_id=None)[:2], (202, None))
        self.assertEqual(self.rpc(key, "unknown")[1]["error"]["code"], -32601)
        self.assertEqual(self.call(key, "authenticated")["error"]["code"], -32602)
        self.assertEqual(self.call(key, "workspace_create", {"workspaceName": 123})["error"]["code"], -32602)
        self.assertEqual(self.call(key, "workspace_list", {"unexpected": True})["error"]["code"], -32602)
        self.assertEqual(self.rpc(key, "ping", headers={"MCP-Protocol-Version": "unsupported"})[0], 400)
        self.assertEqual(self.rpc(key, "ping", headers={"Origin": "http://untrusted.example"})[0], 403)
        self.assertEqual(self.request("POST", "/mcp", key=key, raw=b"{")[1]["error"]["code"], -32700)
        self.assertEqual(self.request("POST", "/mcp", key=key, raw=b"[]")[1]["error"]["code"], -32600)
        self.assertEqual(self.request("POST", "/mcp", body={"id": 1}, key=key)[1]["error"]["code"], -32600)
        for method in ("GET", "DELETE"):
            status, _, headers = self.request(method, "/mcp", key=key)
            self.assertEqual(status, 405)
            self.assertEqual(headers["Allow"], "POST")
        status, _, headers = self.request("POST", "/mcp", body={})
        self.assertEqual(status, 401)
        self.assertIn("Bearer", headers["WWW-Authenticate"])
        self.config.max_body_bytes = 10
        self.assertEqual(self.rpc(key, "ping")[0], 413)

    def test_legacy_batch_and_common_metadata(self):
        key = self.create_key()["key"]
        batch = [{"jsonrpc": "2.0", "id": 1, "method": "ping"},
                 {"jsonrpc": "2.0", "method": "notifications/initialized"},
                 {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {"_meta": {"progressToken": 5}}}]
        status, result, _ = self.request("POST", "/mcp", key=key, body=batch)
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in result], [1, 2])
        self.assertIn("tools", result[1]["result"])
        for version in ("2025-06-18", "2025-11-25"):
            self.assertEqual(self.request("POST", "/mcp", key=key, body=batch,
                                        headers={"MCP-Protocol-Version": version})[0], 400)
        notifications = [{"jsonrpc": "2.0", "method": "notifications/initialized"}]
        self.assertEqual(self.request("POST", "/mcp", key=key, body=notifications)[:2], (202, None))

    def test_tool_calls_have_per_account_rate_limit(self):
        key = self.create_key()["key"]
        self.app.mcp.tool_windows[self.admin["id"]] = (now_ms() // 60000, 120)
        result = self.call(key, "workspace_list")["result"]
        self.assertTrue(result["isError"])
        self.assertEqual(result["structuredContent"]["status"], "MCP_THROTTLED")
        self.assertEqual(self.rpc(key, "ping")[0], 200)

    def test_tools_upload_assets_move_share_and_members(self):
        key = self.create_key()["key"]
        response = self.call(key, "workspace_create", {"workspaceName": "原型"})
        workspace = response["result"]["structuredContent"]["id"]
        files = [{"path": path, "contentBase64": base64.b64encode(content.encode()).decode()}
                 for path, content in (("index.html", "<link href='assets/style.css' rel='stylesheet'>"),
                                       ("assets/style.css", "body{color:red}"))]
        args = {"workspaceId": workspace, "path": "site", "files": files}
        self.assertFalse(self.call(key, "file_upload", args)["result"]["isError"])
        self.assertTrue((self.config.root / "filedb" / workspace / "site/assets/style.css").is_file())
        read = self.call(key, "file_read", {"workspaceId": workspace, "path": "site/index.html"})
        self.assertIn("assets/style.css", read["result"]["structuredContent"]["content"])
        self.assertFalse(self.call(key, "folder_move", {"workspaceId": workspace, "path": "site", "newPath": "demo"})["result"]["isError"])
        share = self.call(key, "share_create", {"workspaceId": workspace, "path": "demo"})["result"]["structuredContent"]
        self.assertIn("/baba-share/s/", share["shareUrl"])
        member, _ = self.account("member")
        self.assertFalse(self.call(key, "member_change", {"workspaceId": workspace, "userId": member["id"]})["result"]["isError"])
        self.assertFalse(self.call(key, "member_delete", {"workspaceId": workspace, "userId": member["id"]})["result"]["isError"])
        self.assertFalse(self.call(key, "share_revoke", {"id": share["id"]})["result"]["isError"])
        self.assertFalse(self.call(key, "folder_delete", {"workspaceId": workspace, "path": "demo"})["result"]["isError"])
        names = {item["name"] for item in self.rpc(key, "tools/list")[1]["result"]["tools"]}
        self.assertNotIn("mcp_key_create", names)
        self.assertNotIn("change_user", names)
        self.assertNotIn("new_session", names)

    def test_upload_conflict_contract_schema_and_real_mcp_retries(self):
        key = self.create_key()["key"]
        workspace = self.call(key, "workspace_create", {"workspaceName": "冲突策略"})["result"]["structuredContent"]["id"]
        tools = self.rpc(key, "tools/list")[1]["result"]["tools"]
        self.assertEqual(len(tools), 19)
        schema = next(item for item in tools if item["name"] == "file_upload")["inputSchema"]
        self.assertEqual(schema["properties"]["conflictPolicy"]["enum"], ["ask", "overwrite", "rename"])
        self.assertEqual(schema["properties"]["conflictPolicy"]["default"], "ask")
        args = {"workspaceId": workspace, "path": "site", "files": [{"path": "index.html", "contentBase64": "b2xk"}]}
        self.assertEqual(self.call(key, "file_upload", args)["result"]["structuredContent"]["count"], 1)
        args["files"] = [{"path": "assets/new.js", "contentBase64": "anM="}, {"path": "index.html", "contentBase64": "bmV3"}]
        result = self.call(key, "file_upload", args)["result"]
        self.assertFalse(result["isError"])
        self.assertTrue(result["structuredContent"]["requiresConfirmation"])
        self.assertEqual(result["structuredContent"]["count"], 0)
        disk = self.config.root / "filedb" / workspace / "site"
        self.assertFalse((disk / "assets").exists())
        self.assertEqual((disk / "index.html").read_text(), "old")
        renamed = {**args, "conflictPolicy": "rename", "requestId": "mcp-rename-request-1"}
        with mock.patch("backend.service.now_ms", return_value=1793376000123):
            result = self.call(key, "file_upload", renamed)["result"]
        self.assertFalse(result["isError"])
        self.assertEqual(result["structuredContent"]["files"][1]["targetPath"], "site/index_1793376000123.html")
        self.assertEqual(self.call(key, "file_upload", renamed)["result"]["structuredContent"], result["structuredContent"])
        self.assertEqual(self.call(key, "file_upload", {**args, "conflictPolicy": "overwrite"})["result"]["structuredContent"]["count"], 2)
        self.assertEqual((disk / "index.html").read_text(), "new")
        self.assertEqual(self.call(key, "file_upload", {**args, "conflictPolicy": "invalid"})["error"]["code"], -32602)
        self.assertEqual(self.call(key, "file_upload", {**args, "conflictPolicy": "rename"})["result"]["structuredContent"]["status"], "PARAM_INVALID")
        self.app.service.folder_create(self.admin, {"workspaceId": workspace, "path": "folder"})
        bad = {**args, "conflictPolicy": "overwrite", "path": "", "files": [{"path": "folder", "contentBase64": "YQ=="}]}
        self.assertEqual(self.call(key, "file_upload", bad)["result"]["structuredContent"]["status"], "PATH_CONFLICT")

    def test_upload_policies_never_bypass_mcp_ownership_or_viewer(self):
        editor, editor_cookie = self.account("conflict-editor")
        viewer, viewer_cookie = self.account("conflict-viewer", role="viewer")
        editor_key, viewer_key = self.create_key(cookie=editor_cookie)["key"], self.create_key(cookie=viewer_cookie)["key"]
        workspace = self.app.service.workspace_create(self.admin, {"workspaceName": "冲突权限"})["id"]
        self.app.service.file_write(self.admin, {"workspaceId": workspace, "path": "owned.txt", "content": "owner"})
        for user in (editor, viewer):
            self.app.service.member_change(self.admin, {"workspaceId": workspace, "userId": user["id"]})
        for policy in ("ask", "overwrite", "rename"):
            args = {"workspaceId": workspace, "conflictPolicy": policy, "requestId": "mcp-permission-test", "files": [
                {"path": "new/first.txt", "contentBase64": "YQ=="}, {"path": "owned.txt", "contentBase64": "Yg=="}]}
            for key, status in ((editor_key, "FOREIGN_CONTENT"), (viewer_key, "READ_ONLY")):
                result = self.call(key, "file_upload", args)["result"]
                self.assertTrue(result["isError"])
                self.assertEqual(result["structuredContent"]["status"], status)
            self.assertFalse((self.config.root / "filedb" / workspace / "new").exists())

    def test_tools_respect_membership_foreign_content_and_role_changes(self):
        owner, owner_cookie = self.account("owner")
        editor, editor_cookie = self.account("editor")
        viewer, viewer_cookie = self.account("viewer", role="viewer")
        owner_key = self.create_key(cookie=owner_cookie)["key"]
        editor_key = self.create_key(cookie=editor_cookie)["key"]
        viewer_key = self.create_key(cookie=viewer_cookie)["key"]
        workspace = self.app.service.workspace_create(owner, {"workspaceName": "权限"})["id"]
        self.app.service.file_write(owner, {"workspaceId": workspace, "path": "index.html", "content": "owner"})
        args = {"workspaceId": workspace, "path": "index.html", "content": "changed"}
        self.assertTrue(self.call(editor_key, "file_write", args)["result"]["isError"])
        for member in (editor, viewer):
            self.app.service.member_change(owner, {"workspaceId": workspace, "userId": member["id"]})
        self.assertEqual(self.call(editor_key, "file_write", args)["result"]["structuredContent"]["status"], "FOREIGN_CONTENT")
        self.assertEqual(self.call(viewer_key, "file_write", args)["result"]["structuredContent"]["status"], "READ_ONLY")
        self.app.service.member_change(owner, {"workspaceId": workspace, "userId": editor["id"], "collaborate": True})
        self.assertFalse(self.call(editor_key, "file_write", args)["result"]["isError"])
        self.app.service.change_user(self.admin, {"id": editor["id"], "role": "viewer"})
        self.assertEqual(self.call(editor_key, "file_write", args)["result"]["structuredContent"]["status"], "READ_ONLY")
        self.app.service.member_delete(owner, workspace, viewer["id"])
        self.assertTrue(self.call(viewer_key, "file_read", {"workspaceId": workspace, "path": "index.html"})["result"]["isError"])
        self.assertFalse(self.call(owner_key, "node_list", {"workspaceId": workspace})["result"]["isError"])


if __name__ == "__main__":
    unittest.main()
