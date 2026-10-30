"""MCP独立安全回归；所有数据仅写入临时目录。"""
import base64
from concurrent.futures import ThreadPoolExecutor
import hashlib
import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock

from backend.config import Config
from backend.controller import Application, BASE, COOKIE_NAME
from backend.repository import db_id, now_ms
from backend.service import BizError, Service


class McpKeySecurityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="baba-share-mcp-qa-")
        self.addCleanup(self.temp.cleanup)
        self.config = Config(Path(self.temp.name), port=1, preview_port=2)
        self.service = Service(self.config)
        account = self.service.account({"userName": "qa-admin", "password": "qa-isolated-password-123"}, "setup")
        self.admin = self.service.repo.user(account["id"])

    def create(self, service=None, user=None, **changes):
        body = {"keyName": "独立安全测试", "expireHours": None, "requestId": secrets.token_hex(16)}
        body.update(changes)
        return (service or self.service).mcp_key_create(user or self.admin, body)

    def assert_biz_error(self, status, operation, *args, **kwargs):
        with self.assertRaises(BizError) as raised:
            operation(*args, **kwargs)
        self.assertEqual(raised.exception.code, status)
        return raised.exception

    @unittest.skipUnless(shutil.which("node"), "前端动态执行需要Node.js")
    def test_frontend_instruction_output_is_dynamic_safe_and_trilingual(self):
        script = r'''
const fs = require('fs'), vm = require('vm'), assert = require('assert');
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
const warnings = [];
const context = {
  URL, console: { warn(...args) { warnings.push(args); } },
  location: new URL(input.origins[0] + '/baba-share/account.html'),
  document: { documentElement: { lang: 'zh-CN', dir: 'ltr', dataset: { mode: 'dark' } }, querySelectorAll() { return []; } },
  UI: { el() { throw Error('不应展示密钥'); }, button() { throw Error('不应展示密钥'); } },
};
context.window = context;
vm.createContext(context);
for (const file of ['i18n.js', 'mcp-help.js']) {
  const source = fs.readFileSync(input.assets + '/' + file, 'utf8');
  assert(!source.includes(input.secret));
  vm.runInContext(source, context);
}
const markers = { 'zh-CN': '只读验证', 'en-US': 'Read-only verification', 'ar-SA': 'تحقق للقراءة فقط' };
for (const [locale, marker] of Object.entries(markers)) {
  context.I18n.apply({ locale, theme: 'dark' });
  assert.equal(context.document.documentElement.dir, locale === 'ar-SA' ? 'rtl' : 'ltr');
  for (const origin of input.origins) {
    context.location = new URL(origin + '/baba-share/account.html');
    const text = context.McpHelp.instructions(input.secret);
    assert(text.includes(marker));
    assert.equal(text.split(input.secret).length - 1, 1);
    assert(text.includes('URL: ' + origin + '/api/baba-share/core/v1/mcp'));
    assert(text.includes('bearer_token_env_var'));
    assert(text.includes('--bearer-token-env-var'));
    assert(text.includes('"type": "remote"'));
    assert(text.includes('"enabled": true'));
    assert(text.includes('"oauth": false'));
    assert(text.includes('"Authorization": "Bearer {env:BABA_SHARE_MCP_KEY}"'));
    assert(text.includes('~/.config/opencode/opencode.json'));
    assert(text.includes('~/.codex/config.toml'));
    assert(text.includes('0600'));
    assert(text.includes('initialize → notifications/initialized → tools/list'));
    assert(text.includes('workspace_list {}'));
    assert(text.includes('PERMISSION_DENIED'));
    assert(text.includes('FOREIGN_CONTENT'));
    assert(!text.includes('mcp debug'));
    assert(!text.includes('printenv'));
    assert(!text.includes('Get-ChildItem Env:'));
    assert(!text.includes('YOUR_PERSONAL'));
    const json = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)[1]);
    assert.equal(json.mcp['baba-share'].url, origin + '/api/baba-share/core/v1/mcp');
    assert(!JSON.stringify(json).includes(input.secret));
    const tools = text.match(/workspace_list, workspace_create[\s\S]*?member_delete/)[0].match(/\b(?:workspace|node|folder|file|share|member)_\w+\b/g);
    assert.equal(new Set(tools).size, 19);
  }
}
assert.equal(warnings.length, 0);
assert(!JSON.stringify(context.I18n.ctx).includes(input.secret));
context.location = new URL('file:///account.html');
assert.throws(() => context.McpHelp.instructions(input.secret), error => error.status === 'mcpUnavailable');
process.stdout.write('ok');
'''
        result = subprocess.run(["node", "-e", script], input=json.dumps({
            "assets": str(self.config.web_dir / "assets"),
            "secret": "bsk-test-only-not-a-real-key",
            "origins": ["https://tenant.example:9443", "http://127.0.0.1:18099", "https://other.example:7443"],
        }), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "ok")

    def test_key_uses_256_bit_hmac_and_database_only_retains_digest(self):
        with mock.patch("backend.service.secrets.token_bytes", wraps=secrets.token_bytes) as random_master:
            created = self.create()
        self.assertGreaterEqual(random_master.call_args_list.count(mock.call(32)), 2)
        self.assertEqual((self.config.root / "data/mcp-key-master").stat().st_size, 32)
        derived = self.service.repo.one("SELECT mcp_derivation_version,mcp_derivation_nonce FROM auth_mcp_key WHERE id=?", (db_id(created["id"]),))
        self.assertEqual(derived["mcp_derivation_version"], "hmac-sha256-v1")
        self.assertRegex(derived["mcp_derivation_nonce"], r"^[0-9a-f]{64}$")
        token = created["key"]
        self.assertRegex(token, r"^bsk-[A-Za-z0-9_-]{43}$")
        self.assertEqual(created["keyPrefix"], token[:12])
        row = self.service.repo.one("SELECT key_hash,key_prefix,request_hash FROM auth_mcp_key WHERE id=?", (db_id(created["id"]),))
        self.assertEqual(row["key_hash"], hashlib.sha256(token.encode()).hexdigest())
        self.assertNotIn(token, json.dumps(row))
        listing = self.service.mcp_keys(self.admin)
        self.assertNotIn(token, json.dumps(listing))
        self.assertNotIn("key_hash", json.dumps(listing))
        self.assertNotIn("request_hash", json.dumps(listing))
        self.assertNotIn("key", listing[0])
        self.assertEqual(self.service.mcp_authenticated(token)["id"], self.admin["id"])

    def test_replay_never_reveals_secret_and_different_parameters_conflict(self):
        request_id = secrets.token_hex(16)
        created = self.create(requestId=request_id)
        error = self.assert_biz_error(409, self.create, requestId=request_id)
        self.assertEqual(error.status, "KEY_ALREADY_CREATED")
        self.assertNotIn(created["key"], str(error))
        error = self.assert_biz_error(409, self.create, requestId=request_id, keyName="不同参数")
        self.assertEqual(error.status, "REQUEST_CONFLICT")
        self.assertEqual(len(self.service.mcp_keys(self.admin)), 1)

    def test_invalid_parameters_cannot_create_keys(self):
        for field, values in {
            "keyName": [None, "", "  ", "x" * 101, [], 12],
            "expireHours": [True, False, 0, -1, 87601, 1.5, "1"],
            "requestId": [None, "", "short", "x" * 101, "x" * 15 + "/"],
        }.items():
            for value in values:
                with self.subTest(field=field, value=value):
                    self.assert_biz_error(400, self.create, **{field: value})
        self.assertEqual(self.service.mcp_keys(self.admin), [])

    def test_expiry_revocation_and_missing_or_disabled_account_are_rechecked(self):
        expired = self.create(expireHours=1)
        self.service.repo.execute("UPDATE auth_mcp_key SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(expired["id"])))
        self.assert_biz_error(401, self.service.mcp_authenticated, expired["key"])
        self.assertFalse(self.service.mcp_keys(self.admin)[0]["isActive"])
        revoked = self.create()
        self.service.mcp_key_revoke(self.admin, revoked["id"])
        self.service.mcp_key_revoke(self.admin, revoked["id"])
        self.assert_biz_error(401, self.service.mcp_authenticated, revoked["key"])
        live = self.create()
        self.service.repo.execute("UPDATE sys_user SET is_disabled=1 WHERE id=?", (db_id(self.admin["id"]),))
        self.assert_biz_error(401, self.service.mcp_authenticated, live["key"])
        self.service.repo.execute("UPDATE sys_user SET is_disabled=0,user_role='viewer' WHERE id=?", (db_id(self.admin["id"]),))
        self.assertEqual(self.service.mcp_authenticated(live["key"])["user_role"], "viewer")
        self.service.repo.execute("DELETE FROM sys_user WHERE id=?", (db_id(self.admin["id"]),))
        self.assert_biz_error(401, self.service.mcp_authenticated, live["key"])

    def test_other_user_cannot_list_or_revoke_keys(self):
        account = self.service.account({"userName": "qa-peer", "password": "qa-isolated-password-123", "role": "viewer"}, actor=self.admin)
        peer = self.service.repo.user(account["id"])
        created = self.create()
        self.assertEqual(self.service.mcp_keys(peer), [])
        self.assert_biz_error(404, self.service.mcp_key_revoke, peer, created["id"])
        self.assertEqual(self.service.mcp_authenticated(created["key"])["id"], self.admin["id"])
        self.assertRegex(self.create(user=peer)["key"], r"^bsk-")

    def test_malformed_or_session_tokens_are_not_mcp_credentials(self):
        for token in (None, "", "bsk-" + "x" * 42, "bsk-" + "x" * 44, "bsk-" + "/" * 43, self.service.new_session(self.admin["id"])):
            with self.subTest(token_type=type(token).__name__):
                self.assert_biz_error(401, self.service.mcp_authenticated, token)

    def test_active_limit_is_atomic_across_service_instances(self):
        second_service = Service(self.config)
        barrier = threading.Barrier(14)

        def create_concurrently(index):
            barrier.wait(timeout=10)
            try:
                return self.create(service=self.service if index % 2 else second_service)
            except BizError as error:
                return error

        with ThreadPoolExecutor(max_workers=14) as executor:
            results = list(executor.map(create_concurrently, range(14)))
        successful = [result for result in results if isinstance(result, dict)]
        rejected = [result for result in results if isinstance(result, BizError)]
        self.assertEqual(len(successful), 10)
        self.assertEqual(len({result["key"] for result in successful}), 10)
        self.assertEqual([(result.code, result.status) for result in rejected], [(409, "MCP_KEY_LIMIT")] * 4)
        self.assertEqual(len(self.service.mcp_keys(self.admin)), 10)
        self.service.mcp_key_revoke(self.admin, successful[0]["id"])
        self.service.repo.execute("UPDATE auth_mcp_key SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(successful[1]["id"])))
        self.create()
        self.create()
        self.assert_biz_error(409, self.create)


class McpHttpSecurityTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix="baba-share-mcp-http-qa-")
        cls.addClassCleanup(cls.temp.cleanup)
        cls.config = Config(Path(cls.temp.name), port=1, preview_port=2)
        cls.app = Application(cls.config)
        cls.main = ThreadingHTTPServer(("127.0.0.1", 0), cls.app.handler(False))
        cls.addClassCleanup(cls.main.server_close)
        cls.config.port = cls.main.server_port
        cls.config.public_origin = f"http://127.0.0.1:{cls.main.server_port}"
        cls.thread = threading.Thread(target=cls.main.serve_forever, daemon=True)
        cls.thread.start()
        cls.addClassCleanup(cls.main.shutdown)
        cls.service = cls.app.service
        cls.users, cls.cookies, cls.keys = {}, {}, {}
        admin = cls.service.account({"userName": "qa-admin", "password": "qa-isolated-password-123"}, "setup")
        cls.users["admin"] = cls.service.repo.user(admin["id"])
        for actor, role in (("owner", "editor"), ("peer", "editor"), ("viewer", "viewer")):
            user = cls.service.account({"userName": "qa-" + actor, "password": "qa-isolated-password-123", "role": role}, actor=cls.users["admin"])
            cls.users[actor] = cls.service.repo.user(user["id"])
        for actor, user in cls.users.items():
            cls.cookies[actor] = COOKIE_NAME + "=" + cls.service.new_session(user["id"])
            cls.keys[actor] = cls.service.mcp_key_create(user, {"keyName": actor, "expireHours": None, "requestId": secrets.token_hex(16)})

    @classmethod
    def tearDownClass(cls):
        cls.main.shutdown()
        cls.main.server_close()
        cls.thread.join()
        cls.temp.cleanup()

    @classmethod
    def request(cls, body=None, actor="peer", method="POST", route="/mcp", cookie_actor=None, headers=None, raw=None):
        request_headers = {"Content-Type": "application/json"}
        if actor:
            request_headers["Authorization"] = "Bearer " + cls.keys[actor]["key"]
        if cookie_actor:
            request_headers["Cookie"] = cls.cookies[cookie_actor]
        request_headers.update(headers or {})
        payload = raw if raw is not None else json.dumps(body or {"jsonrpc": "2.0", "id": 1, "method": "ping"}).encode()
        connection = http.client.HTTPConnection("127.0.0.1", cls.main.server_port, timeout=10)
        try:
            connection.request(method, BASE + route, body=payload, headers=request_headers)
            response = connection.getresponse()
            response_headers = {key.lower(): value for key, value in response.getheaders()}
            content = response.read()
            return response.status, json.loads(content) if content else None, response_headers
        finally:
            connection.close()

    def setUp(self):
        self.workspace = self.service.workspace_create(self.users["owner"], {"workspaceName": "qa-" + secrets.token_hex(12)})["id"]
        for actor in ("peer", "viewer"):
            self.service.member_change(self.users["owner"], {"workspaceId": self.workspace, "userId": self.users[actor]["id"], "collaborate": actor == "viewer"})

    def call(self, name, arguments, actor="peer"):
        return self.request({"jsonrpc": "2.0", "id": "qa-call", "method": "tools/call", "params": {"name": name, "arguments": arguments}}, actor=actor)

    def test_bearer_without_origin_is_allowed_but_cookie_cannot_authenticate_mcp(self):
        status, response, headers = self.request()
        self.assertEqual((status, response["result"]), (200, {}))
        self.assertEqual(headers["cache-control"], "no-store")
        self.assertNotIn("set-cookie", headers)
        for authorization in ("", "Basic anything", self.cookies["peer"].split("=", 1)[1]):
            status, response, headers = self.request(actor=None, cookie_actor="peer", headers={"Authorization": authorization})
            self.assertEqual(status, 401, response)
            self.assertIn("www-authenticate", headers)
        self.assertEqual(self.request(actor=None, route="/mcp?key=" + self.keys["peer"]["key"])[0], 401)

    def test_key_management_remains_cookie_only_and_csrf_protected(self):
        for method, route, body in (("GET", "/mcp-key/list", None), ("POST", "/mcp-key", {"keyName": "禁止Bearer建key", "requestId": secrets.token_hex(16)}), ("DELETE", "/mcp-key?id=" + self.keys["peer"]["id"], None)):
            with self.subTest(method=method):
                self.assertEqual(self.request(body, method=method, route=route, headers={"Origin": self.config.public_origin})[0], 401)
        status, response, _ = self.request(actor=None, method="GET", route="/mcp-key/list", cookie_actor="peer", headers={"Origin": self.config.public_origin})
        self.assertEqual(status, 200, response)
        self.assertNotIn(self.keys["peer"]["key"], json.dumps(response))
        self.assertEqual(self.request({"keyName": "no-origin", "requestId": secrets.token_hex(16)}, actor=None, route="/mcp-key", cookie_actor="peer")[0], 403)

    def test_untrusted_origin_host_and_cross_site_are_rejected(self):
        for headers in ({"Origin": "null"}, {"Origin": "http://untrusted.invalid"}, {"Host": "untrusted.invalid"}, {"Sec-Fetch-Site": "cross-site"}):
            with self.subTest(headers=headers):
                status, response, _ = self.request(headers=headers)
                self.assertEqual(status, 403, response)
                self.assertEqual(response["error"]["data"]["status"], "ORIGIN_DENIED")
        self.assertEqual(self.request(headers={"Origin": self.config.public_origin})[0], 200)

    def test_jsonrpc_envelope_and_schema_validation(self):
        cases = [([], -32600), ({"jsonrpc": "1.0", "id": 1, "method": "ping"}, -32600),
                 ({"jsonrpc": "2.0", "id": True, "method": "ping"}, -32600),
                 ({"jsonrpc": "2.0", "id": 1, "method": "unknown"}, -32601),
                 ({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": []}, -32602),
                 ({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "file_write", "arguments": {"workspaceId": self.workspace, "path": "x.txt", "content": "x", "unexpected": True}}}, -32602),
                 ({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "node_list", "arguments": {"workspaceId": self.workspace, "pageIndex": True}}}, -32602)]
        for body, error in cases:
            with self.subTest(error=error, body=body):
                status, response, _ = self.request(raw=json.dumps(body).encode())
                self.assertIn(status, (200, 400))
                self.assertEqual(response["error"]["code"], error)
        self.assertEqual(self.request(raw=b"{")[1]["error"]["code"], -32700)
        self.assertEqual(self.request(headers={"MCP-Protocol-Version": "unsupported"})[0], 400)
        self.assertEqual(self.request(headers={"Content-Type": "text/plain"})[0], 415)
        self.assertEqual(self.request(method="GET")[0], 405)
        status, response, _ = self.request({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.assertEqual((status, response), (202, None))

    def test_bearer_cannot_bypass_ownership_recursive_permissions_or_viewer_role(self):
        self.service.folder_create(self.users["peer"], {"workspaceId": self.workspace, "path": "mixed"})
        self.service.file_write(self.users["owner"], {"workspaceId": self.workspace, "path": "mixed/owner.txt", "content": "受保护"})
        for name, arguments in (("file_write", {"path": "mixed/owner.txt", "content": "禁止覆盖"}),
                                ("file_delete", {"path": "mixed/owner.txt"}),
                                ("folder_delete", {"path": "mixed"}),
                                ("folder_move", {"path": "mixed", "newPath": "moved"})):
            with self.subTest(tool=name):
                status, response, _ = self.call(name, {"workspaceId": self.workspace, **arguments})
                self.assertEqual(status, 200)
                self.assertTrue(response["result"]["isError"])
                self.assertEqual(response["result"]["structuredContent"]["code"], 403)
        status, response, _ = self.call("file_write", {"workspaceId": self.workspace, "path": "viewer.txt", "content": "禁止写入"}, "viewer")
        self.assertEqual(status, 200)
        self.assertTrue(response["result"]["isError"])
        self.assertEqual(response["result"]["structuredContent"]["status"], "READ_ONLY")
        status, response, _ = self.call("file_write", {"workspaceId": self.workspace, "path": "mine.txt", "content": "允许写入"})
        self.assertEqual(status, 200)
        self.assertFalse(response["result"]["isError"])
        self.service.member_delete(self.users["owner"], self.workspace, self.users["peer"]["id"])
        self.assertEqual(self.call("file_read", {"workspaceId": self.workspace, "path": "mixed/owner.txt"})[1]["result"]["structuredContent"]["code"], 403)
        self.assertEqual(self.service.file_read(self.users["owner"], self.workspace, "mixed/owner.txt")["content"], "受保护")

    def test_all_tool_mappings_optional_defaults_and_real_files_end_to_end(self):
        called = set()

        def success(name, arguments=None):
            status, response, _ = self.call(name, arguments or {}, "owner")
            self.assertEqual(status, 200, response)
            self.assertNotIn("error", response)
            self.assertFalse(response["result"]["isError"], response)
            called.add(name)
            return response["result"]["structuredContent"]

        workspace = success("workspace_create", {"workspaceName": "qa-tools-" + secrets.token_hex(8)})["id"]
        self.assertIn(workspace, {item["id"] for item in success("workspace_list")["items"]})
        success("workspace_change", {"id": workspace, "workspaceName": "qa-renamed-" + secrets.token_hex(8), "description": "全部参数映射"})
        success("folder_create", {"workspaceId": workspace, "path": "site/assets"})
        success("file_write", {"workspaceId": workspace, "path": "site/index.html", "content": "<link href='assets/main.css'>"})
        success("file_upload", {"workspaceId": workspace, "files": [{"path": "root.txt", "contentBase64": base64.b64encode("默认根路径".encode()).decode()}]})
        self.assertEqual(success("file_read", {"workspaceId": workspace, "path": "root.txt"})["content"], "默认根路径")
        success("file_upload", {"workspaceId": workspace, "path": "site/assets", "files": [{"path": "main.css", "contentBase64": base64.b64encode(b"body{color:blue}").decode()}]})
        self.assertEqual((self.config.root / "filedb" / workspace / "site/assets/main.css").read_bytes(), b"body{color:blue}")
        listing = success("node_list", {"workspaceId": workspace})
        self.assertEqual((listing["path"], listing["pageIndex"], listing["pageSize"]), ("", 1, 20))
        success("file_move", {"workspaceId": workspace, "path": "root.txt", "newPath": "renamed.txt"})
        success("folder_move", {"workspaceId": workspace, "path": "site", "newPath": "demo"})
        self.assertTrue((self.config.root / "filedb" / workspace / "demo/assets/main.css").is_file())
        share = success("share_create", {"workspaceId": workspace})
        self.assertEqual(share["path"], "")
        self.assertIsNone(share["expireTime"])
        self.assertIn(share["id"], {item["id"] for item in success("share_list")["items"]})
        success("member_change", {"workspaceId": workspace, "userName": self.users["peer"]["user_name"]})
        roster = success("member_list", {"workspaceId": workspace})
        self.assertIn(self.users["peer"]["id"], {item["userId"] for item in roster["items"]})
        success("member_change", {"workspaceId": workspace, "userId": self.users["peer"]["id"], "collaborate": True})
        success("member_delete", {"workspaceId": workspace, "userId": self.users["peer"]["id"]})
        success("share_revoke", {"id": share["id"]})
        self.assertNotIn(share["id"], {item["id"] for item in success("share_list")["items"]})
        success("file_delete", {"workspaceId": workspace, "path": "renamed.txt"})
        success("folder_delete", {"workspaceId": workspace, "path": "demo"})
        success("workspace_delete", {"id": workspace})
        self.assertFalse((self.config.root / "filedb" / workspace).exists())
        self.assertEqual(called, set(self.app.mcp.tools))

    def test_viewer_cannot_invoke_any_mutating_tool_even_with_collaboration(self):
        self.service.file_write(self.users["owner"], {"workspaceId": self.workspace, "path": "site/owner.txt", "content": "只读保护"})
        share = self.service.share_create(self.users["owner"], {"workspaceId": self.workspace})
        mutations = {
            "workspace_create": {"workspaceName": "viewer-forbidden"},
            "workspace_change": {"id": self.workspace, "workspaceName": "forbidden"},
            "workspace_delete": {"id": self.workspace},
            "folder_create": {"workspaceId": self.workspace, "path": "forbidden"},
            "file_write": {"workspaceId": self.workspace, "path": "new.txt", "content": "forbidden"},
            "file_upload": {"workspaceId": self.workspace, "files": [{"path": "new.txt", "contentBase64": "eA=="}]},
            "file_move": {"workspaceId": self.workspace, "path": "site/owner.txt", "newPath": "new.txt"},
            "folder_move": {"workspaceId": self.workspace, "path": "site", "newPath": "new"},
            "file_delete": {"workspaceId": self.workspace, "path": "site/owner.txt"},
            "folder_delete": {"workspaceId": self.workspace, "path": "site"},
            "share_create": {"workspaceId": self.workspace},
            "share_revoke": {"id": share["id"]},
            "member_change": {"workspaceId": self.workspace, "userId": self.users["peer"]["id"], "collaborate": True},
            "member_delete": {"workspaceId": self.workspace, "userId": self.users["owner"]["id"]},
        }
        mutating_names = {name for name, (definition, _) in self.app.mcp.tools.items() if not definition["annotations"]["readOnlyHint"]}
        self.assertEqual(set(mutations), mutating_names)
        for name, arguments in mutations.items():
            with self.subTest(tool=name):
                status, response, _ = self.call(name, arguments, "viewer")
                self.assertEqual(status, 200)
                self.assertTrue(response["result"]["isError"], response)
                self.assertEqual(response["result"]["structuredContent"]["code"], 403)
        self.assertEqual(self.service.file_read(self.users["owner"], self.workspace, "site/owner.txt")["content"], "只读保护")

    def test_tool_catalog_has_no_key_or_account_admin_tools_and_never_exposes_secrets(self):
        status, response, _ = self.request({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
        self.assertEqual(status, 200)
        tools = response["result"]["tools"]
        self.assertTrue(tools)
        self.assertFalse(any("key" in tool["name"] or tool["name"].startswith(("user_", "setting_")) for tool in tools))
        self.assertNotIn(self.keys["peer"]["key"], json.dumps(response))
        with self.assertLogs("baba-share", level="ERROR") as captured:
            with mock.patch.object(self.app.mcp, "dispatch", side_effect=RuntimeError(self.keys["peer"]["key"])):
                status, response, _ = self.request()
        self.assertEqual(status, 500)
        self.assertNotIn(self.keys["peer"]["key"], json.dumps(response) + "".join(captured.output))


if __name__ == "__main__":
    unittest.main(verbosity=2)
