"""新手任务在临时数据库和随机HTTP端口下的安全及事务回归。"""
import base64
import concurrent.futures
import unittest
from unittest import mock
from urllib.parse import urlsplit

from backend.repository import Repository, db_id, now_ms
from backend.service import BizError, Service, digest
import test_backend


class OnboardingTests(unittest.TestCase):
    setUp = test_backend.BackendTests.setUp
    tearDown = test_backend.BackendTests.tearDown
    request = test_backend.BackendTests.request
    setup_admin = test_backend.BackendTests.setup_admin
    add_user = test_backend.BackendTests.add_user
    workspace = test_backend.BackendTests.workspace
    invite = test_backend.BackendTests.invite

    def actor(self, name="learner"):
        view, cookie = self.add_user(name)
        return self.app.service.repo.user(view["id"]), cookie

    def detail(self, cookie):
        status, result, _ = self.request("GET", "/onboarding/detail", cookie=cookie)
        self.assertEqual(status, 200, result)
        return result

    def done(self, cookie):
        return {task["key"] for task in self.detail(cookie)["tasks"] if task["completed"]}

    def upload(self, user, workspace, path="hello.txt", policy="ask", request_id=None):
        return self.app.service.upload(user, {"workspaceId": workspace, "conflictPolicy": policy,
            "requestId": request_id, "files": [{"path": path, "contentBase64": base64.b64encode(b"hello").decode()}]})

    def create_key(self, user, request_id="onboarding-mcp-key-0001"):
        return self.app.service.mcp_key_create(user, {"keyName": "引导测试", "requestId": request_id, "expireHours": 1})

    def rpc(self, user, method, params=None):
        return self.app.mcp.dispatch(user, {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}})[1]

    def ticket(self, user, workspace):
        return self.app.service.ticket(user, {"workspaceId": workspace, "path": "hello.txt"})

    def fetch(self, ticket, path="hello.txt", download=False):
        route = urlsplit(ticket["previewBaseUrl"]).path + path
        return self.request("GET", route, preview=True, query={"download": "1"} if download else None)

    def receipt(self, cookie, ticket):
        return self.request("POST", "/onboarding/preview", {"ticket": ticket["onboardingTicket"]}, cookie)

    def test_contract_preferences_admin_and_no_forged_task(self):
        user, cookie = self.actor()
        detail = self.detail(cookie)
        self.assertEqual(detail["completedCount"], 0)
        self.assertTrue(detail["enabled"])
        self.assertEqual(detail["version"], 1)
        self.assertEqual(detail["totalCount"], 6)
        self.assertEqual([task["key"] for task in detail["tasks"]], [
            "enter_workspace", "create_folder", "upload_file", "preview_file", "create_mcp_key", "mcp_tool_call"])
        self.assertTrue(all(task["completedTime"] is None for task in detail["tasks"]))
        self.assertFalse(self.detail(self.admin_cookie)["enabled"])
        for body in ({"complete": True}, {"userId": self.admin["id"]}, {"dismissed": 1}, {}):
            self.assertEqual(self.request("PATCH", "/onboarding", body, cookie)[0], 400)
        self.assertEqual(self.request("PATCH", "/onboarding", {"celebrationSeen": True}, cookie)[0], 409)
        self.assertFalse(self.detail(cookie)["celebrationSeen"])
        self.assertEqual(self.request("PATCH", "/onboarding", {"dismissed": True}, cookie)[0], 200)
        session = self.app.service.new_session(user["id"])
        self.assertTrue(self.detail("baba_share_session=" + session)["dismissed"])
        self.assertEqual(self.request("GET", "/onboarding/detail")[0], 401)

    def test_listing_only_after_success_and_viewer_own_workspace(self):
        user, cookie = self.actor()
        workspace = self.workspace()
        self.assertEqual(self.request("GET", "/node/list", cookie=cookie, query={"workspaceId": workspace})[0], 403)
        self.assertEqual(self.done(cookie), set())
        self.invite(workspace, user, "viewer")
        self.assertEqual(self.request("GET", "/node/list", cookie=cookie, query={"workspaceId": workspace, "path": "missing"})[0], 404)
        self.assertEqual(self.done(cookie), set())
        self.assertEqual(self.request("GET", "/node/list", cookie=cookie, query={"workspaceId": workspace})[0], 200)
        self.assertEqual(self.done(cookie), set())
        self.assertEqual(self.request("POST", "/onboarding/visit", {"workspaceId": workspace}, cookie)[0], 200)
        self.assertEqual(self.done(cookie), {"enter_workspace"})
        self.assertEqual(self.request("POST", "/folder", {"workspaceId": workspace, "path": "no"}, cookie)[0], 403)
        own = self.workspace(cookie)
        self.assertEqual(self.request("POST", "/folder", {"workspaceId": own, "path": "yes"}, cookie)[0], 200)
        self.assertIn("create_folder", self.done(cookie))

    def test_upload_ask_cancel_invalid_rollback_and_retry(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        self.upload(user, workspace)
        self.assertEqual(self.done(cookie), {"upload_file"})
        result = self.upload(user, workspace)
        self.assertTrue(result["requiresConfirmation"])
        self.assertEqual(result["count"], 0)
        self.assertEqual(self.done(cookie), {"upload_file"})
        with self.assertRaises(BizError):
            service.upload(user, {"workspaceId": workspace, "files": []})
        with self.assertRaises(BizError):
            service.upload(user, {"workspaceId": workspace, "files": [{"path": "bad", "contentBase64": "!"}]})
        original = service.onboarding_record
        def fail_after_record(connection, actor, task):
            original(connection, actor, task)
            if task == "upload_file":
                raise RuntimeError("模拟事务失败")
        with mock.patch.object(service, "onboarding_record", side_effect=fail_after_record), self.assertRaises(RuntimeError):
            self.upload(user, workspace, policy="overwrite")
        self.assertEqual(service.disk_path(workspace, "hello.txt").read_bytes(), b"hello")
        self.assertEqual(self.done(cookie), {"upload_file"})
        self.upload(user, workspace, policy="overwrite", request_id="retry-onboarding-0001")
        before = self.detail(cookie)
        self.upload(user, workspace, policy="overwrite", request_id="retry-onboarding-0001")
        self.assertEqual(before, self.detail(cookie))
        self.assertEqual(self.done(cookie), {"upload_file"})

    def test_folder_and_rename_rollback_and_folder_rename_not_edit(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        original = service.onboarding_record
        def fail_after_record(connection, actor, task):
            original(connection, actor, task)
            raise RuntimeError("模拟事务失败")
        with mock.patch.object(service, "onboarding_record", side_effect=fail_after_record), self.assertRaises(RuntimeError):
            service.folder_create(user, {"workspaceId": workspace, "path": "a/b"})
        self.assertFalse(service.disk_path(workspace, "a").exists())
        self.assertEqual(self.done(cookie), set())
        service.folder_create(user, {"workspaceId": workspace, "path": "a"})
        service.node_move(user, {"workspaceId": workspace, "path": "a", "newPath": "b"}, "folder")
        self.assertEqual(self.done(cookie), {"create_folder"})
        self.upload(user, workspace)
        with mock.patch.object(service, "invalidate_roots", side_effect=RuntimeError("模拟事务失败")), self.assertRaises(RuntimeError):
            service.node_move(user, {"workspaceId": workspace, "path": "hello.txt", "newPath": "renamed.txt"}, "file")
        self.assertTrue(service.disk_path(workspace, "hello.txt").is_file())
        self.assertIsNotNone(service.repo.node(workspace, "hello.txt"))
        before = self.detail(cookie)
        service.node_move(user, {"workspaceId": workspace, "path": "hello.txt", "newPath": "renamed.txt"}, "file")
        self.assertEqual(before, self.detail(cookie))

    def test_existing_folder_no_task_and_successful_overwrite_counts_upload(self):
        user, cookie = self.actor()
        workspace = self.workspace()
        self.app.service.folder_create(self.app.service.repo.user(self.admin["id"]), {"workspaceId": workspace, "path": "existing"})
        self.upload(self.app.service.repo.user(self.admin["id"]), workspace)
        self.invite(workspace, user, "manager")
        self.app.service.folder_create(user, {"workspaceId": workspace, "path": "existing"})
        self.assertEqual(self.done(cookie), set())
        self.upload(user, workspace, policy="overwrite")
        self.assertEqual(self.done(cookie), {"upload_file"})

    def test_preview_requires_fetch_user_session_purpose_and_receipt(self):
        user, cookie = self.actor()
        other, other_cookie = self.actor("other")
        workspace = self.workspace(cookie)
        self.upload(user, workspace)
        ticket = self.ticket(user, workspace)
        self.assertEqual(self.receipt(cookie, ticket)[1]["status"], "PREVIEW_NOT_READY")
        self.assertEqual(self.fetch(ticket, "missing.txt")[0], 404)
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.assertEqual(self.fetch(ticket, download=True)[0], 200)
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.assertEqual(self.fetch(ticket)[0], 200)
        self.assertNotIn("preview_file", self.done(cookie))
        self.assertEqual(self.receipt(other_cookie, ticket)[0], 404)
        self.assertEqual(self.receipt("", ticket)[0], 401)
        self.assertEqual(self.request("POST", "/onboarding/preview", {"ticket": ticket["onboardingTicket"], "complete": True}, cookie)[0], 400)
        self.assertEqual(self.request("POST", "/onboarding/preview", {"ticket": "x" * 43}, cookie)[0], 404)
        self.assertEqual(self.receipt(cookie, ticket)[0], 200)
        before = self.detail(cookie)
        self.assertEqual(self.receipt(cookie, ticket)[0], 200)
        self.assertEqual(before, self.detail(cookie))
        proof = self.app.service.repo.one("SELECT ticket_hash,proof_purpose FROM onboarding_preview_proof WHERE user_id=?", (db_id(user["id"]),))
        self.assertEqual(proof["ticket_hash"], digest(ticket["onboardingTicket"]))
        self.assertEqual(proof["proof_purpose"], "preview_file")
        self.assertNotIn(ticket["onboardingTicket"], str(before))

    def test_preview_proof_expiry_ticket_expiry_and_permission_revoked(self):
        user, cookie = self.actor()
        workspace = self.workspace()
        self.upload(self.app.service.repo.user(self.admin["id"]), workspace)
        self.invite(workspace, user, "viewer")
        ticket = self.ticket(user, workspace)
        self.assertEqual(self.fetch(ticket)[0], 200)
        self.app.service.repo.execute("UPDATE onboarding_preview_proof SET expire_time=? WHERE user_id=?", (now_ms() - 1, db_id(user["id"])))
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.assertEqual(self.fetch(ticket)[0], 200)
        self.app.service.member_delete(self.app.service.repo.user(self.admin["id"]), workspace, user["id"])
        self.assertEqual(self.receipt(cookie, ticket)[0], 403)
        self.invite(workspace, user, "viewer")
        self.app.service.repo.execute("UPDATE preview_ticket SET expire_time=? WHERE user_id=?", (now_ms() - 1, db_id(user["id"])))
        self.assertEqual(self.receipt(cookie, ticket)[0], 404)
        self.assertNotIn("preview_file", self.done(cookie))

    def test_last_task_celebration_delete_and_restart_persistence(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        service.folder_create(user, {"workspaceId": workspace, "path": "folder"})
        self.upload(user, workspace)
        service.listing(workspace, "", user)
        self.assertEqual(self.request("POST", "/onboarding/visit", {"workspaceId": workspace}, cookie)[0], 200)
        self.create_key(user)
        self.assertFalse(self.rpc(user, "tools/call", {"name": "workspace_list"})["result"]["isError"])
        ticket = self.ticket(user, workspace)
        self.fetch(ticket)
        self.assertFalse(self.detail(cookie)["allComplete"])
        status, detail, _ = self.receipt(cookie, ticket)
        self.assertEqual(status, 200)
        self.assertTrue(detail["allComplete"])
        self.assertEqual(detail["completedCount"], 6)
        self.assertTrue(all(type(task["completedTime"]) is int and task["completedTime"] > 10**12 for task in detail["tasks"]))
        self.assertEqual(self.request("PATCH", "/onboarding", {"celebrationSeen": True}, cookie)[0], 200)
        service.node_delete(user, workspace, "hello.txt", "file")
        service.workspace_delete(user, workspace)
        self.assertTrue(self.detail(cookie)["allComplete"])
        restarted = Service(self.config)
        self.assertTrue(restarted.onboarding_detail(user)["celebrationSeen"])
        service.user_delete(service.repo.user(self.admin["id"]), user["id"])
        for table in ("onboarding_task", "onboarding_preference", "onboarding_preview_proof", "onboarding_preview_target"):
            with service.repo.connection() as connection:
                self.assertEqual(connection.execute("SELECT count(*) FROM " + table + " WHERE user_id=?", (db_id(user["id"]),)).fetchone()[0], 0)

    def test_concurrent_services_and_upload_retry_are_idempotent(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        second = Service(self.config)
        def work(index):
            service = self.app.service if index % 2 else second
            service.listing(workspace, "", user)
            service.onboarding_visit(user, cookie.split("=", 1)[1], {"workspaceId": workspace})
            return service.upload(user, {"workspaceId": workspace, "requestId": "concurrent-upload-0001", "files": [{"path": "folder/a.txt", "contentBase64": "YQ=="}]})
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as executor:
            results = list(executor.map(work, range(12)))
        self.assertTrue(all(result == results[0] for result in results))
        self.assertEqual(self.done(cookie), {"enter_workspace", "create_folder", "upload_file"})
        self.assertEqual(self.app.service.repo.one("SELECT count(*) AS task_count FROM onboarding_task WHERE user_id=?", (db_id(user["id"]),))["task_count"], 3)

    def test_visit_requires_successful_get_then_explicit_post(self):
        user, cookie = self.actor()
        other, other_cookie = self.actor("other")
        workspace = self.workspace(cookie)
        service = self.app.service
        body = {"workspaceId": workspace}
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[1]["status"], "ONBOARDING_VISIT_REQUIRED")
        self.upload(user, workspace)
        self.ticket(user, workspace)
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 409)
        self.assertEqual(self.request("GET", "/node/list", cookie=cookie, query=body)[0], 200)
        self.assertNotIn("enter_workspace", self.done(cookie))
        self.assertEqual(self.request("POST", "/onboarding/visit", body, other_cookie)[0], 403)
        self.assertEqual(self.request("POST", "/onboarding/visit", {**body, "userId": user["id"]}, cookie)[0], 400)
        service.onboarding_visits[(user["id"], workspace)] = now_ms() - 1
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 409)
        service.listing(workspace, "", user)
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 200)
        before = self.detail(cookie)
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 200)
        self.assertEqual(before, self.detail(cookie))
        service.onboarding_visits = {(user["id"], str(index)): now_ms() + 300000 for index in range(4096)}
        service.onboarding_visited(user, workspace)
        self.assertEqual(len(service.onboarding_visits), 4096)

    def test_visit_rechecks_permission_and_current_session(self):
        user, cookie = self.actor()
        workspace = self.workspace()
        service = self.app.service
        admin = service.repo.user(self.admin["id"])
        self.invite(workspace, user, "viewer")
        service.listing(workspace, "", user)
        service.member_delete(admin, workspace, user["id"])
        body = {"workspaceId": workspace}
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 403)
        self.assertNotIn("enter_workspace", self.done(cookie))
        self.invite(workspace, user, "viewer")
        service.repo.execute("UPDATE auth_session SET expire_time=? WHERE user_id=?", (now_ms() - 1, db_id(user["id"])))
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 401)
        with self.assertRaises(BizError):
            service.onboarding_visit(user, cookie.split("=", 1)[1], body)

    def test_visit_get_has_no_business_writes_and_session_revocation(self):
        user, cookie = self.actor()
        other, other_cookie = self.actor("other")
        workspace = self.workspace()
        service = self.app.service
        self.invite(workspace, user, "viewer")
        self.invite(workspace, other, "viewer")
        body = {"workspaceId": workspace}
        with service.repo.connection() as connection:
            before = connection.iterdump()
            snapshot = list(before)
        self.assertEqual(self.request("GET", "/node/list", cookie=cookie, query=body)[0], 200)
        self.assertEqual(self.request("GET", "/onboarding/visit", cookie=cookie, query=body)[0], 404)
        with service.repo.connection() as connection:
            self.assertEqual(snapshot, list(connection.iterdump()))
        self.assertEqual(self.request("POST", "/onboarding/visit", body, other_cookie)[0], 409)
        service.member_delete(service.repo.user(self.admin["id"]), workspace, user["id"])
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 403)
        self.invite(workspace, user, "viewer")
        service.repo.execute("UPDATE auth_session SET expire_time=? WHERE user_id=?", (now_ms() - 1, db_id(user["id"])))
        self.assertEqual(self.request("POST", "/onboarding/visit", body, cookie)[0], 401)
        with self.assertRaises(BizError):
            service.onboarding_visit(user, cookie.split("=", 1)[1], body)
        self.assertFalse(next(task for task in service.onboarding_detail(user)["tasks"] if task["key"] == "enter_workspace")["completed"])

    def test_visit_transaction_failure_does_not_complete(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        service.listing(workspace, "", user)
        with mock.patch.object(service, "onboarding_detail", side_effect=RuntimeError("模拟事务回滚")):
            self.assertEqual(self.request("POST", "/onboarding/visit", {"workspaceId": workspace}, cookie)[0], 500)
        self.assertEqual(self.done(cookie), set())
        self.assertEqual(self.request("POST", "/onboarding/visit", {"workspaceId": workspace}, cookie)[0], 200)

    def test_preview_file_ticket_binds_target_and_closing_without_receipt(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        for path in ("nested/page.html", "nested/style.css", "nested/other.html"):
            self.upload(user, workspace, path)
        ticket = service.ticket(user, {"workspaceId": workspace, "path": "nested/page.html"})
        self.assertTrue(ticket["previewUrl"].endswith("/page.html"))
        self.assertEqual(self.fetch(ticket, "style.css")[0], 200)
        self.assertEqual(self.fetch(ticket, "other.html")[0], 200)
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.assertEqual(self.fetch(ticket, "page.html", download=True)[0], 200)
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.assertEqual(self.fetch(ticket, "page.html")[0], 200)
        # 主资源读取后关闭预览而不提交可信UI回执，任务仍未完成。
        self.assertNotIn("preview_file", self.done(cookie))
        self.assertEqual(self.receipt(cookie, ticket)[0], 200)

    def test_preview_directory_entry_change_cannot_reuse_proof(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        self.upload(user, workspace, "home.html")
        ticket = service.ticket(user, {"workspaceId": workspace, "path": ""})
        self.assertEqual(self.fetch(ticket, "home.html")[0], 200)
        self.upload(user, workspace, "index.html")
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.assertEqual(self.fetch(ticket, "index.html")[0], 200)
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        current = service.ticket(user, {"workspaceId": workspace, "path": ""})
        self.assertEqual(self.fetch(current, "index.html")[0], 200)
        self.assertEqual(self.receipt(cookie, current)[0], 200)

    def test_preview_main_target_not_stylesheet_other_html_or_pdf(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        for path in ("index.html", "style.css", "other.html", "document.pdf"):
            self.upload(user, workspace, path)
        ticket = service.ticket(user, {"workspaceId": workspace, "path": ""})
        self.assertEqual(self.fetch(ticket, "style.css")[0], 200)
        self.assertEqual(self.fetch(ticket, "other.html")[0], 200)
        self.assertEqual(self.receipt(cookie, ticket)[1]["status"], "PREVIEW_NOT_READY")
        service.disk_path(workspace, "index.html").unlink()
        self.assertEqual(self.fetch(ticket, "index.html")[0], 404)
        self.assertEqual(self.fetch(ticket, "style.css")[0], 200)
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        service.disk_path(workspace, "index.html").write_bytes(b"<h1>hello</h1>")
        self.assertEqual(self.fetch(ticket, "index.html")[0], 200)
        service.disk_path(workspace, "index.html").unlink()
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        service.disk_path(workspace, "index.html").write_bytes(b"<h1>hello</h1>")
        pdf = service.ticket(user, {"workspaceId": workspace, "path": "document.pdf"})
        self.assertEqual(self.fetch(pdf, "document.pdf")[0], 200)
        self.assertEqual(self.receipt(cookie, pdf)[0], 409)
        self.assertNotIn("preview_file", self.done(cookie))
        self.assertEqual(self.receipt(cookie, ticket)[0], 200)

    def test_new_upload_transaction_rollback_leaves_no_task_or_files(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        original = service.onboarding_record
        def fail_after_record(connection, actor, task):
            original(connection, actor, task)
            if task == "upload_file":
                raise RuntimeError("模拟提交前失败")
        with mock.patch.object(service, "onboarding_record", side_effect=fail_after_record), self.assertRaises(RuntimeError):
            self.upload(user, workspace, "new/a.txt", request_id="rollback-new-000001")
        self.assertEqual(self.done(cookie), set())
        self.assertFalse(service.disk_path(workspace, "new").exists())
        self.assertEqual(service.repo.nodes(workspace), [])
        self.assertIsNone(service.repo.one("SELECT id FROM upload_request WHERE user_id=?", (db_id(user["id"]),)))

    def test_preference_failure_rolls_back_and_disabled_user_cannot_write(self):
        user, cookie = self.actor()
        service = self.app.service
        original = service.onboarding_detail
        count = 0
        def fail_response(actor, connection=None):
            nonlocal count
            count += 1
            if count == 2:
                raise RuntimeError("模拟偏好事务失败")
            return original(actor, connection)
        with mock.patch.object(service, "onboarding_detail", side_effect=fail_response):
            self.assertEqual(self.request("PATCH", "/onboarding", {"dismissed": True}, cookie)[0], 500)
        self.assertFalse(self.detail(cookie)["dismissed"])
        service.repo.execute("UPDATE sys_user SET is_disabled=1 WHERE id=?", (db_id(user["id"]),))
        self.assertEqual(self.request("PATCH", "/onboarding", {"dismissed": True}, cookie)[0], 401)
        with self.assertRaises(BizError):
            service.onboarding_change(user, {"dismissed": True})

    def test_preview_read_failure_opaque_origin_and_expired_session(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        self.upload(user, workspace)
        ticket = self.ticket(user, workspace)
        from pathlib import Path
        with mock.patch.object(Path, "read_bytes", side_effect=OSError("模拟资源读取失败")):
            self.assertEqual(self.fetch(ticket)[0], 400)
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.fetch(ticket)
        self.assertEqual(self.request("POST", "/onboarding/preview", {"ticket": ticket["onboardingTicket"]}, cookie, origin="null")[0], 403)
        self.app.service.repo.execute("UPDATE auth_session SET expire_time=? WHERE user_id=?", (now_ms() - 1, db_id(user["id"])))
        self.assertEqual(self.receipt(cookie, ticket)[0], 401)
        with self.assertRaises(BizError):
            self.app.service.onboarding_preview(user, cookie.split("=", 1)[1], {"ticket": ticket["onboardingTicket"]})
        self.assertFalse(next(task for task in self.app.service.onboarding_detail(user)["tasks"] if task["key"] == "preview_file")["completed"])

    def test_non_destructive_initialization_and_read_has_no_progress_side_effect(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        self.upload(user, workspace)
        before = self.detail(cookie)
        Repository(self.config.database_path)
        self.assertEqual(before, self.detail(cookie))
        self.assertTrue(self.app.service.disk_path(workspace, "hello.txt").is_file())
        self.assertEqual(self.app.service.repo.user(user["id"])["nickname"], user["nickname"])

    def test_current_schema_initializes_all_onboarding_tables(self):
        import tempfile
        from pathlib import Path
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "current.sqlite3"
            repo = Repository(database)
            stamp = now_ms()
            repo.execute("INSERT INTO sys_user (id,user_name,nickname,password_hash,user_role,create_time,update_time) VALUES (?,?,?,?,?,?,?)",
                         (db_id(self.admin["id"]), "kept", "保留账号", "hash", "admin", stamp, stamp))
            self.assertEqual(repo.user(self.admin["id"])["nickname"], "保留账号")
            self.assertEqual(repo.one("SELECT count(*) AS task_count FROM onboarding_task")["task_count"], 0)
            self.assertEqual(repo.one("SELECT count(*) AS preference_count FROM onboarding_preference")["preference_count"], 0)
            self.assertEqual(repo.one("SELECT count(*) AS target_count FROM onboarding_preview_target")["target_count"], 0)
            self.assertEqual(repo.one("SELECT count(*) AS proof_count FROM onboarding_preview_proof")["proof_count"], 0)
            self.assertEqual(Repository(database).user(self.admin["id"]), repo.user(self.admin["id"]))

    def test_current_proof_schema_preserves_data_and_rejects_unbound_proof(self):
        import tempfile
        from pathlib import Path
        from backend.repository import new_id
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / "current-proof.sqlite3"
            repo = Repository(database)
            stamp = now_ms()
            user_id = db_id(self.admin["id"])
            with repo.connection() as connection:
                connection.execute("INSERT INTO sys_user (id,user_name,nickname,password_hash,user_role,create_time,update_time) VALUES (?,?,?,?,?,?,?)",
                                   (user_id, "kept", "保留账号", "hash", "admin", stamp, stamp))
                connection.execute("INSERT INTO onboarding_preview_proof (id,user_id,ticket_hash,proof_purpose,target_path,expire_time,create_time,update_time) VALUES (?,?,?,'preview_file',?,?,?,?)",
                                   (db_id(new_id()), user_id, "current-proof", "index.html", stamp + 300000, stamp, stamp))
                connection.execute("INSERT INTO onboarding_task (id,user_id,task_version,task_key,completed_time,create_time,update_time) VALUES (?,?,1,'enter_workspace',?,?,?)",
                                   (db_id(new_id()), user_id, stamp, stamp, stamp))
            before = repo.one("SELECT id,user_id,ticket_hash,proof_purpose,target_path,expire_time,create_time,update_time FROM onboarding_preview_proof WHERE ticket_hash=?", ("current-proof",))
            reopened = Repository(database)
            self.assertEqual(reopened.user(self.admin["id"])["nickname"], "保留账号")
            self.assertEqual(reopened.one("SELECT task_key FROM onboarding_task WHERE user_id=?", (user_id,))["task_key"], "enter_workspace")
            self.assertEqual(reopened.one("SELECT id,user_id,ticket_hash,proof_purpose,target_path,expire_time,create_time,update_time FROM onboarding_preview_proof WHERE ticket_hash=?", ("current-proof",)), before)
            self.assertEqual(reopened.one("SELECT count(*) AS proof_count FROM onboarding_preview_proof")["proof_count"], 1)
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        self.upload(user, workspace)
        ticket = self.ticket(user, workspace)
        self.fetch(ticket)
        self.app.service.repo.execute("UPDATE onboarding_preview_proof SET target_path='' WHERE user_id=?", (db_id(user["id"]),))
        self.assertEqual(self.receipt(cookie, ticket)[0], 409)
        self.fetch(ticket)
        self.assertEqual(self.receipt(cookie, ticket)[0], 200)

    def test_text_creation_edit_and_rename_do_not_count_as_upload(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        body = {"workspaceId": workspace, "path": "created.txt", "content": "first"}
        self.assertEqual(self.request("PUT", "/file/content", body, cookie)[0], 200)
        self.assertEqual(self.done(cookie), set())
        body["content"] = "edited"
        service.file_write(user, body)
        service.node_move(user, {"workspaceId": workspace, "path": "created.txt", "newPath": "renamed.txt"}, "file")
        self.assertEqual(service.disk_path(workspace, "renamed.txt").read_text(), "edited")
        self.assertEqual(self.done(cookie), set())
        self.upload(user, workspace, "renamed.txt")
        self.assertEqual(self.done(cookie), set())
        self.upload(user, workspace, "renamed.txt", policy="overwrite")
        self.assertEqual(self.done(cookie), {"upload_file"})

    def test_key_creation_is_transactional_idempotent_and_owner_scoped(self):
        user, cookie = self.actor()
        other, other_cookie = self.actor("other")
        service = self.app.service
        body = {"keyName": "测试", "requestId": "onboarding-key-http-0001", "expireHours": 1}
        self.assertEqual(self.request("POST", "/mcp-key", {**body, "keyName": ""}, cookie)[0], 400)
        self.assertEqual(self.done(cookie), set())
        original = service.onboarding_record
        def fail_after_record(connection, actor, task):
            original(connection, actor, task)
            if task == "create_mcp_key":
                raise RuntimeError("模拟密钥事务失败")
        with mock.patch.object(service, "onboarding_record", side_effect=fail_after_record):
            self.assertEqual(self.request("POST", "/mcp-key", body, cookie)[0], 500)
        self.assertEqual(service.mcp_keys(user), [])
        self.assertEqual(self.done(cookie), set())
        status, key, _ = self.request("POST", "/mcp-key", body, cookie)
        self.assertEqual(status, 200)
        before = self.detail(cookie)
        self.assertEqual(self.request("POST", "/mcp-key", body, cookie)[0], 409)
        self.assertEqual(before, self.detail(cookie))
        self.assertEqual(self.done(cookie), {"create_mcp_key"})
        self.assertEqual(self.done(other_cookie), set())
        service.mcp_key_delete(user, key["id"])
        self.assertEqual(self.done(cookie), {"create_mcp_key"})

    def test_mcp_only_successful_tool_calls_count_and_are_idempotent(self):
        user, cookie = self.actor()
        other, other_cookie = self.actor("other")
        self.create_key(user)
        initial = self.detail(cookie)
        self.rpc(user, "initialize", {"protocolVersion": "2025-03-26", "capabilities": {}, "clientInfo": {}})
        self.rpc(user, "tools/list")
        self.rpc(user, "ping")
        self.rpc(user, "tools/call", {"name": "missing"})
        self.rpc(user, "tools/call", {"name": "file_read"})
        self.rpc(user, "tools/call", {"name": "workspace_list", "arguments": {"unexpected": True}})
        forbidden = self.workspace()
        denied = self.rpc(user, "tools/call", {"name": "node_list", "arguments": {"workspaceId": forbidden}})
        self.assertTrue(denied["result"]["isError"])
        self.assertEqual(initial, self.detail(cookie))
        result = self.rpc(user, "tools/call", {"name": "workspace_list"})
        self.assertFalse(result["result"]["isError"])
        self.assertEqual(self.done(cookie), {"create_mcp_key", "mcp_tool_call"})
        self.assertEqual(self.done(other_cookie), set())
        before = self.detail(cookie)
        self.rpc(user, "tools/call", {"name": "workspace_list"})
        self.assertEqual(before, self.detail(cookie))

    def test_mcp_progress_write_failure_rolls_back_completion(self):
        user, cookie = self.actor()
        service = self.app.service
        original = service.onboarding_record
        def fail_after_record(connection, actor, task):
            original(connection, actor, task)
            if task == "mcp_tool_call":
                raise RuntimeError("模拟工具进度事务失败")
        with mock.patch.object(service, "onboarding_record", side_effect=fail_after_record), self.assertRaises(RuntimeError):
            self.rpc(user, "tools/call", {"name": "workspace_list"})
        self.assertEqual(self.done(cookie), set())
        self.assertFalse(self.rpc(user, "tools/call", {"name": "workspace_list"})["result"]["isError"])
        self.assertEqual(self.done(cookie), {"mcp_tool_call"})

    def test_mcp_http_rejects_deleted_expired_disabled_and_forged_keys_without_progress(self):
        from http.client import HTTPConnection
        import json
        from backend.controller import BASE
        user, cookie = self.actor()
        service = self.app.service
        key = self.create_key(user)
        def call(token):
            connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
            try:
                connection.request("POST", BASE + "/mcp", json.dumps({"jsonrpc": "2.0", "id": 1,
                    "method": "tools/call", "params": {"name": "workspace_list"}}),
                    {"Authorization": "Bearer " + token, "Content-Type": "application/json"})
                response = connection.getresponse()
                response.read()
                return response.status
            finally:
                connection.close()
        self.assertEqual(call("bsk-" + "x" * 43), 401)
        service.repo.execute("UPDATE auth_mcp_key SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(key["id"])))
        self.assertEqual(call(key["key"]), 401)
        key = self.create_key(user, "onboarding-second-key-01")
        service.mcp_key_delete(user, key["id"])
        self.assertIsNone(service.repo.one("SELECT id FROM auth_mcp_key WHERE id=?", (db_id(key["id"]),)))
        self.assertEqual(call(key["key"]), 401)
        key = self.create_key(user, "onboarding-third-key-001")
        service.repo.execute("UPDATE sys_user SET is_disabled=1 WHERE id=?", (db_id(user["id"]),))
        self.assertEqual(call(key["key"]), 401)
        service.repo.execute("UPDATE sys_user SET is_disabled=0 WHERE id=?", (db_id(user["id"]),))
        self.assertEqual(self.done(cookie), {"create_mcp_key"})

    def test_mcp_conflict_confirmation_failure_and_throttle_do_not_count(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        service = self.app.service
        service.file_write(user, {"workspaceId": workspace, "path": "existing.txt", "content": "kept"})
        tree = self.app.mcp.directory_tree.snapshot(user)
        target = next(node for node in tree["nodes"] if node["workspaceId"] == workspace and node["path"] == "")
        arguments = {"treeToken": tree["treeToken"], "targetId": target["targetId"],
                     "files": [{"path": "existing.txt", "contentBase64": "YQ=="}]}
        result = self.rpc(user, "tools/call", {"name": "file_upload", "arguments": arguments})
        self.assertTrue(result["result"]["structuredContent"]["requiresConfirmation"])
        self.assertEqual(self.done(cookie), set())
        with mock.patch.object(service, "workspaces", side_effect=BizError(403, "ACCESS_DENIED", "模拟权限失败")):
            self.assertTrue(self.rpc(user, "tools/call", {"name": "workspace_list"})["result"]["isError"])
        self.assertEqual(self.done(cookie), set())
        self.app.mcp.tool_windows[user["id"]] = (now_ms() // 60000, 120)
        result = self.rpc(user, "tools/call", {"name": "workspace_list"})
        self.assertTrue(result["result"]["isError"])
        self.assertEqual(result["result"]["structuredContent"]["status"], "MCP_THROTTLED")
        self.assertEqual(self.done(cookie), set())

    def test_mcp_and_http_share_service_events(self):
        user, cookie = self.actor()
        workspace = self.workspace(cookie)
        key = self.app.service.mcp_key_create(user, {"keyName": "引导测试", "requestId": "onboarding-mcp-00001", "expireHours": 1})["key"]
        from http.client import HTTPConnection
        import json
        from backend.controller import BASE
        def call(name, args):
            connection = HTTPConnection("127.0.0.1", self.port, timeout=10)
            connection.request("POST", BASE + "/mcp", json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": name, "arguments": args}}), {"Authorization": "Bearer " + key, "Content-Type": "application/json"})
            response = connection.getresponse()
            result = json.loads(response.read())
            connection.close()
            self.assertEqual(response.status, 200)
            self.assertFalse(result["result"]["isError"], result)
            return result["result"]["structuredContent"]
        tree = call("directory_tree", {})
        target = next(item for item in tree["nodes"] if item["workspaceId"] == workspace and not item["path"])
        selection = {"treeToken": tree["treeToken"], "targetId": target["targetId"]}
        call("node_list", {"workspaceId": workspace})
        call("folder_create", {**selection, "relativePath": "folder"})
        call("file_write", {**selection, "relativePath": "hello.txt", "content": "first"})
        call("file_write", {**selection, "relativePath": "hello.txt", "content": "second"})
        self.assertEqual(self.done(cookie), {"enter_workspace", "create_folder", "create_mcp_key", "mcp_tool_call"})
        call("file_upload", {**selection, "files": [{"path": "uploaded.txt", "contentBase64": "aGVsbG8="}]})
        self.assertEqual(self.done(cookie), {"enter_workspace", "create_folder", "upload_file", "create_mcp_key", "mcp_tool_call"})


if __name__ == "__main__":
    unittest.main()
