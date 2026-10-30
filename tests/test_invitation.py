"""邀请链接与物理删除：独立临时目录、真实HTTP、实际前端JS。"""
import concurrent.futures
import json
import shutil
import subprocess
import unittest
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from backend.controller import Application
from backend.repository import db_id, now_ms
import test_security


class InvitationHttpTests(unittest.TestCase):
    setUpClass = classmethod(test_security.SecurityHttpTests.setUpClass.__func__)
    tearDownClass = classmethod(test_security.SecurityHttpTests.tearDownClass.__func__)
    request = classmethod(test_security.SecurityHttpTests.request.__func__)
    ok = test_security.SecurityHttpTests.ok
    denied = test_security.SecurityHttpTests.denied

    def setUp(self):
        self.workspace = self.ok("POST", "/workspace", "owner", {"workspaceName": self._testMethodName})["id"]

    def invite(self, actor="owner", **values):
        return self.ok("POST", "/invitation", actor, {"workspaceId": self.workspace,
                       "requestId": str(uuid.uuid4()), **values})

    @staticmethod
    def token(invitation):
        return urlsplit(invitation["inviteUrl"]).fragment.removeprefix("invite=")

    def join(self, invitation, actor="peer"):
        return self.ok("POST", "/invitation/membership", actor, {"token": self.token(invitation)})

    def test_defaults_digest_only_get_readonly_and_anonymous_privacy(self):
        invitation = self.invite()
        token = self.token(invitation)
        self.assertRegex(token, r"^[A-Za-z0-9_-]{43}$")
        self.assertEqual(invitation["expireTime"] - invitation["createTime"], 7 * 86400000)
        self.assertFalse(invitation["collaborate"])
        row = self.app.service.repo.one("SELECT invitation_hash FROM workspace_invitation WHERE id=?", (db_id(invitation["id"]),))
        self.assertNotEqual(row["invitation_hash"], token)
        self.assertNotIn(token.encode(), self.config.database_path.read_bytes())
        before = self.app.service.repo.one("SELECT count(*) AS member_count FROM workspace_member WHERE workspace_id=?", (db_id(self.workspace),))
        for actor in (None, "peer"):
            status, raw, headers = self.request("GET", "/baba-share/invite.html", actor=actor, preview=True)
            self.assertEqual(status, 200)
            self.assertEqual(headers["referrer-policy"], "no-referrer")
            self.assertNotIn(self.workspace.encode(), raw)
            self.assertEqual(self.request("GET", "/invitation/membership", actor=actor, query={"token": token})[0], 401 if actor is None else 404)
        after = self.app.service.repo.one("SELECT count(*) AS member_count FROM workspace_member WHERE workspace_id=?", (db_id(self.workspace),))
        self.assertEqual(before, after)
        for route, method, body in (("/invitation/list", "GET", None), ("/invitation/membership", "POST", {"token": token})):
            status, data, _ = self.request(method, route, body=body, query={"workspaceId": self.workspace})
            self.assertEqual(status, 401)
            self.assertNotIn("workspaceId", data)
            self.assertNotIn("members", data)
        listed = self.ok("GET", "/invitation/list", "owner", query={"workspaceId": self.workspace})
        self.assertNotIn(token, json.dumps(listed))
        self.assertNotIn("invitation_hash", json.dumps(listed))
        self.assertEqual(self.join(invitation)["workspaceId"], self.workspace)
        member = self.app.service.repo.one("SELECT is_collaborate FROM workspace_member WHERE workspace_id=? AND user_id=?", (db_id(self.workspace), db_id(self.users["peer"]["id"])))
        self.assertEqual(member["is_collaborate"], 0)

    def test_manager_scope_collaboration_and_viewer_always_readonly(self):
        for actor in ("peer", "viewer"):
            self.denied("POST", "/invitation", actor, {"workspaceId": self.workspace, "requestId": str(uuid.uuid4())})
            self.denied("GET", "/invitation/list", actor, query={"workspaceId": self.workspace})
        invitation = self.invite(collaborate=True)
        self.join(invitation)
        self.join(invitation, "viewer")
        members = self.ok("GET", "/member/list", "owner", query={"workspaceId": self.workspace})
        self.assertTrue(all(item["collaborate"] for item in members))
        self.denied("POST", "/folder", "viewer", {"workspaceId": self.workspace, "path": "denied"})
        self.denied("DELETE", "/invitation", "peer", query={"id": invitation["id"]})
        self.assertIn("id", self.invite("admin"))
        self.ok("PATCH", "/user", "admin", {"id": self.users["owner"]["id"], "role": "viewer"})
        try:
            self.denied("POST", "/invitation", "owner", {"workspaceId": self.workspace, "requestId": str(uuid.uuid4())})
        finally:
            self.ok("PATCH", "/user", "admin", {"id": self.users["owner"]["id"], "role": "editor"})

    def test_existing_member_owner_and_concurrent_join_idempotency(self):
        invitation = self.invite(collaborate=True)
        self.ok("POST", "/member", "owner", {"workspaceId": self.workspace, "userId": self.users["peer"]["id"], "collaborate": False})
        original = self.app.service.repo.one("SELECT id,is_collaborate,update_time FROM workspace_member WHERE workspace_id=? AND user_id=?", (db_id(self.workspace), db_id(self.users["peer"]["id"])))
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda _: self.join(invitation), range(16)))
        self.assertTrue(all(result["workspaceId"] == self.workspace for result in results))
        actual = self.app.service.repo.one("SELECT id,is_collaborate,update_time FROM workspace_member WHERE workspace_id=? AND user_id=?", (db_id(self.workspace), db_id(self.users["peer"]["id"])))
        self.assertEqual(actual, original)
        self.ok("POST", "/member", "owner", {"workspaceId": self.workspace, "userId": self.users["peer"]["id"], "collaborate": True})
        original = self.app.service.repo.one("SELECT id,is_collaborate,update_time FROM workspace_member WHERE workspace_id=? AND user_id=?", (db_id(self.workspace), db_id(self.users["peer"]["id"])))
        self.join(self.invite(collaborate=False))
        self.assertEqual(self.app.service.repo.one("SELECT id,is_collaborate,update_time FROM workspace_member WHERE workspace_id=? AND user_id=?", (db_id(self.workspace), db_id(self.users["peer"]["id"]))), original)
        with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(lambda _: self.join(invitation, "viewer"), range(16)))
        self.assertEqual(self.app.service.repo.one("SELECT count(*) AS member_count FROM workspace_member WHERE workspace_id=?", (db_id(self.workspace),))["member_count"], 2)
        self.join(invitation, "owner")
        self.assertIsNone(self.app.service.repo.one("SELECT id FROM workspace_member WHERE workspace_id=? AND user_id=?", (db_id(self.workspace), db_id(self.users["owner"]["id"]))))
        # 独立Service共享数据库，事务本身而非单一实例内存保证唯一插入。
        service = Application(self.config).service
        self.assertEqual(service.invitation_membership(service.repo.user(self.users["peer"]["id"]), {"token": self.token(invitation)})["workspaceId"], self.workspace)

    def test_expired_deleted_cascade_and_invalid_tokens(self):
        for token in (None, "x" * 42, "x" * 44, "x" * 42 + "/", "https://example.invalid", "x" * 43):
            self.denied("POST", "/invitation/membership", "peer", {"token": token}, expected=404)
        invitation = self.invite()
        self.app.service.repo.execute("UPDATE workspace_invitation SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(invitation["id"])))
        self.denied("POST", "/invitation/membership", "peer", {"token": self.token(invitation)}, expected=404)
        self.ok("DELETE", "/invitation", "owner", query={"id": invitation["id"]})
        invitation = self.invite()
        self.join(invitation)
        self.ok("DELETE", "/invitation", "owner", query={"id": invitation["id"]})
        self.ok("DELETE", "/invitation", "owner", query={"id": invitation["id"]})
        self.denied("POST", "/invitation/membership", "viewer", {"token": self.token(invitation)}, expected=404)
        self.assertTrue(any(w["id"] == self.workspace for w in self.ok("GET", "/workspace/list", "peer")))
        invitation = self.invite()
        self.ok("DELETE", "/workspace", "owner", query={"id": self.workspace})
        self.assertIsNone(self.app.service.repo.one("SELECT id FROM workspace_invitation WHERE id=?", (db_id(invitation["id"]),)))
        self.denied("POST", "/invitation/membership", "viewer", {"token": self.token(invitation)}, expected=404)

    def test_creator_live_disable_role_and_ownership_checks(self):
        for change, reset in (({"isDisabled": True}, {"isDisabled": False}), ({"role": "viewer"}, {"role": "editor"})):
            invitation = self.invite()
            self.ok("PATCH", "/user", "admin", {"id": self.users["owner"]["id"], **change})
            try:
                self.denied("POST", "/invitation/membership", "peer", {"token": self.token(invitation)}, expected=404)
            finally:
                self.ok("PATCH", "/user", "admin", {"id": self.users["owner"]["id"], **reset})
                _, _, headers = self.request("POST", "/visitor/session", body={"userName": "qa-owner", "password": "qa-isolated-password-123"})
                self.cookies["owner"] = headers["set-cookie"].split(";", 1)[0]
        invitation = self.invite()
        self.app.service.repo.execute("UPDATE project_workspace SET owner_id=? WHERE id=?", (db_id(self.users["admin"]["id"]), db_id(self.workspace)))
        self.denied("POST", "/invitation/membership", "peer", {"token": self.token(invitation)}, expected=404)

    def test_creation_idempotency_and_origin_guard(self):
        body = {"workspaceId": self.workspace, "requestId": str(uuid.uuid4())}
        self.ok("POST", "/invitation", "owner", body)
        self.assertEqual(self.denied("POST", "/invitation", "owner", body, expected=409)["status"], "INVITATION_ALREADY_CREATED")
        self.assertEqual(self.denied("POST", "/invitation", "owner", {**body, "collaborate": True}, expected=409)["status"], "REQUEST_CONFLICT")
        for values in ({"collaborate": "true"}, {"expireHours": 0}, {"expireHours": 721}, {"requestId": "bad"}):
            self.denied("POST", "/invitation", "owner", {**body, **values}, expected=400)
        invitation = self.invite()
        for headers in ({"Origin": "null"}, {"Sec-Fetch-Site": "cross-site"}):
            self.assertEqual(self.request("POST", "/invitation/membership", "peer", {"token": self.token(invitation)}, headers=headers)[0], 403)

    def test_mcp_physical_delete_preserves_other_key_master_and_legacy(self):
        def key(name):
            return self.ok("POST", "/mcp-key", "owner", {"keyName": name, "expireHours": None, "requestId": str(uuid.uuid4())})
        removed, retained, old = key("remove"), key("retain"), key("legacy-revoked")
        master_path = self.config.root / "data" / "mcp-key-master"
        master = master_path.read_bytes()
        nonce = self.app.service.repo.one("SELECT mcp_derivation_nonce FROM auth_mcp_key WHERE id=?", (db_id(removed["id"]),))["mcp_derivation_nonce"]
        self.app.service.repo.execute("UPDATE auth_mcp_key SET revoked_time=? WHERE id=?", (now_ms(), db_id(old["id"])))
        Application(self.config)
        self.assertIsNotNone(self.app.service.repo.one("SELECT id FROM auth_mcp_key WHERE id=?", (db_id(old["id"]),)))
        self.denied("DELETE", "/mcp-key", "peer", query={"id": removed["id"]}, expected=404)
        self.ok("DELETE", "/mcp-key", "owner", query={"id": removed["id"]})
        self.assertIsNone(self.app.service.repo.one("SELECT id FROM auth_mcp_key WHERE id=?", (db_id(removed["id"]),)))
        self.assertNotIn(nonce.encode(), self.config.database_path.read_bytes())
        self.assertEqual(master_path.read_bytes(), master)
        self.assertEqual(self.ok("POST", "/mcp-key/content", "owner", {"id": retained["id"]})["key"], retained["key"])
        self.denied("POST", "/mcp-key/content", "owner", {"id": removed["id"]}, expected=404)
        status, _, _ = self.request("POST", "/mcp", body={"jsonrpc": "2.0", "id": 1, "method": "ping"}, headers={"Authorization": "Bearer " + removed["key"]})
        self.assertEqual(status, 401)
        ids = [item["id"] for item in self.ok("GET", "/mcp-key/list", "owner")]
        self.assertNotIn(removed["id"], ids)
        self.assertIn(old["id"], ids)
        self.ok("DELETE", "/mcp-key", "owner", query={"id": old["id"]})
        self.app.service.repo.execute("UPDATE auth_mcp_key SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(retained["id"])))
        self.ok("DELETE", "/mcp-key", "owner", query={"id": retained["id"]})

    @unittest.skipUnless(shutil.which("node"), "真实JS回归需要Node.js")
    def test_real_javascript_login_handoff_and_http_join(self):
        invitation = self.invite()
        script = Path(__file__).with_name("invitation_links.test.js")
        result = subprocess.run(["node", str(script), "--http"], input=json.dumps({
            "origin": self.config.public_origin, "cookie": self.cookies["peer"],
            "token": self.token(invitation), "workspaceId": self.workspace,
        }), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
