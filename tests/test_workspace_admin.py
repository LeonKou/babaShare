"""管理员物理删除与资产托管专项；所有数据仅存于临时目录。"""
import base64
import http.client
import json
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode

from backend.config import Config
from backend.controller import Application, BASE, COOKIE_NAME
from backend.repository import Repository, db_id, new_id, now_ms
from backend.service import BizError, Service, digest


class WorkspaceAdminTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="baba-admin-test-")
        self.addCleanup(self.temp.cleanup)
        self.config = Config(Path(self.temp.name))
        self.service = Service(self.config)
        self.repo = self.service.repo
        view = self.service.account({"userName": "admin", "password": "test-admin-password"}, "setup")
        self.admin = self.repo.user(view["id"])
        self.owner = self.user("owner", "editor", "原始创建人")
        self.peer = self.user("peer", "editor")
        self.viewer = self.user("viewer", "editor")
        self.target = self.user("target", "editor")
        self.space = self.service.workspace_create(self.owner, {"workspaceName": "Shared"})["id"]
        for user, member_role in ((self.peer, "editor"), (self.viewer, "viewer")):
            self.service.member_change(self.owner, {"workspaceId": self.space, "userId": user["id"], "memberRole": member_role})
        self.write(self.owner, "owner.html")
        self.write(self.peer, "peer.html")

    def user(self, name, role, nickname=None):
        view = self.service.account({"userName": name, "password": "test-user-password", "nickname": nickname or name, "role": role}, actor=self.admin)
        return self.repo.user(view["id"])

    def write(self, user, path):
        return self.service.file_write(user, {"workspaceId": self.space, "path": path, "content": "<h1>保留文件</h1>"})

    def denied(self, status, callback, *args):
        with self.assertRaises(BizError) as context:
            callback(*args)
        self.assertEqual(context.exception.status, status)
        return context.exception

    def test_delete_preserves_files_and_clears_all_credentials(self):
        session = self.service.new_session(self.owner["id"])
        key = self.service.mcp_key_create(self.owner, {"keyName": "test", "requestId": "delete-test-key-0001"})["key"]
        invitation = self.service.invitation_create(self.owner, {"workspaceId": self.space, "requestId": "delete-test-invite-0001"})
        self.service.share_create(self.owner, {"workspaceId": self.space, "path": ""})
        self.service.ticket(self.owner, {"workspaceId": self.space, "path": ""})
        self.service.upload(self.owner, {"workspaceId": self.space, "requestId": "delete-test-upload-0001", "files": [{"path": "upload.txt", "contentBase64": base64.b64encode(b"keep").decode()}]})
        disk = self.service.disk_path(self.space, "owner.html")
        before = disk.read_bytes()
        with mock.patch.object(self.service, "workspace_delete", side_effect=AssertionError("禁止删空间")), mock.patch("backend.service.shutil.rmtree", side_effect=AssertionError("禁止删文件")):
            self.assertEqual(self.service.user_delete(self.admin, self.owner["id"]), {})
            self.assertEqual(self.service.user_delete(self.admin, self.owner["id"]), {})
        self.assertEqual(disk.read_bytes(), before)
        self.assertTrue(self.service.disk_path(self.space, "upload.txt").exists())
        self.assertIsNone(self.repo.user(self.owner["id"]))
        workspace = self.repo.workspace(self.space)
        self.assertIsNone(workspace["owner_id"])
        self.assertIsNone(workspace["creator_id"])
        self.assertEqual(workspace["creator_nickname"], "原始创建人")
        self.assertIsNone(self.repo.node(self.space, "owner.html")["owner_id"])
        self.assertEqual(self.repo.node(self.space, "peer.html")["owner_id"], self.peer["id"])
        for table in ("auth_session", "auth_mcp_key", "workspace_member", "upload_request", "preview_ticket"):
            self.assertEqual(self.repo.one("SELECT count(*) AS item_count FROM " + table + " WHERE user_id=?", (db_id(self.owner["id"]),))["item_count"], 0)
        self.assertEqual(self.repo.one("SELECT count(*) AS item_count FROM folder_share WHERE owner_id=?", (db_id(self.owner["id"]),))["item_count"], 0)
        self.assertEqual(self.repo.one("SELECT count(*) AS item_count FROM workspace_invitation WHERE creator_id=?", (db_id(self.owner["id"]),))["item_count"], 0)
        self.denied("AUTH_REQUIRED", self.service.authenticated, session)
        self.denied("AUTH_REQUIRED", self.service.mcp_authenticated, key)
        self.denied("LOGIN_FAILED", self.service.login, {"userName": "owner", "password": "test-user-password"}, "test")
        self.denied("INVITATION_INVALID", self.service.invitation_membership, self.peer, {"token": invitation["inviteUrl"].split("=")[-1]})
        self.assertEqual(self.repo.one("SELECT count(*) AS item_count FROM sys_user")["item_count"], 4)

    def test_delete_preserves_registration_rate_limit_history(self):
        stamp = now_ms()
        attempt_id = db_id(new_id())
        with self.repo.connection() as connection:
            connection.execute("INSERT INTO registration_attempt (id,email_hash,client_hash,create_time,update_time) VALUES (?,?,?,?,?)",
                               (attempt_id, digest(self.owner["user_name"].lower()), digest("test-client"), stamp, stamp))
        self.service.user_delete(self.admin, self.owner["id"])
        self.assertEqual(self.repo.one("SELECT email_hash,client_hash,create_time,update_time FROM registration_attempt WHERE id=?", (attempt_id,)),
                         {"email_hash": digest(self.owner["user_name"].lower()), "client_hash": digest("test-client"), "create_time": stamp, "update_time": stamp})

    def test_custody_members_and_readonly_permissions_survive(self):
        self.service.user_delete(self.admin, self.owner["id"])
        members = self.service.members(self.admin, self.space)
        self.assertEqual({member["userId"] for member in members}, {self.peer["id"], self.viewer["id"]})
        self.denied("FOREIGN_CONTENT", self.write, self.peer, "owner.html")
        self.denied("READ_ONLY", self.write, self.viewer, "viewer.html")
        self.write(self.peer, "peer.html")
        self.write(self.admin, "owner.html")
        self.assertTrue(self.service.workspace_view(self.admin, self.repo.workspace(self.space))["canManage"])
        self.service.member_change(self.admin, {"workspaceId": self.space, "userId": self.peer["id"], "memberRole": "manager"})
        self.write(self.peer, "owner.html")
        self.denied("READ_ONLY", self.write, self.viewer, "owner.html")

    def test_deleting_member_custodies_their_nodes_in_other_owned_space(self):
        original_members = self.service.members(self.admin, self.space)
        self.service.user_delete(self.admin, self.peer["id"])
        self.assertEqual(self.repo.workspace(self.space)["owner_id"], self.owner["id"])
        self.assertIsNone(self.repo.node(self.space, "peer.html")["owner_id"])
        self.assertTrue(self.service.disk_path(self.space, "peer.html").exists())
        remaining = self.service.members(self.admin, self.space)
        self.assertEqual(remaining, [member for member in original_members if member["id"] != self.peer["id"]])
        self.assertEqual(self.repo.one("SELECT count(*) AS member_count FROM workspace_member WHERE user_id=?", (db_id(self.admin["id"]),))["member_count"], 0)

    def test_multiple_equal_named_spaces_can_be_in_system_custody(self):
        second = self.service.workspace_create(self.peer, {"workspaceName": "Shared"})["id"]
        self.service.user_delete(self.admin, self.owner["id"])
        self.service.user_delete(self.admin, self.peer["id"])
        self.assertIsNone(self.repo.workspace(self.space)["owner_id"])
        self.assertIsNone(self.repo.workspace(second)["owner_id"])
        self.assertNotEqual(self.space, second)
        self.assertEqual(self.service.workspace_admin(self.admin, {"ownerStatus": "system"})["totalCount"], 2)

    def test_transfer_only_original_owner_and_custodied_nodes(self):
        self.service.user_delete(self.admin, self.owner["id"])
        original = self.repo.workspace(self.space)
        self.assertEqual(self.service.workspace_ownership(self.admin, {"id": self.space, "ownerId": self.target["id"]}), {})
        self.assertEqual(self.service.workspace_ownership(self.admin, {"id": self.space, "ownerId": self.target["id"]}), {})
        row = self.repo.workspace(self.space)
        self.assertEqual(row["owner_id"], self.target["id"])
        self.assertEqual(row["creator_nickname"], original["creator_nickname"])
        self.assertEqual(row["creator_id"], original["creator_id"])
        self.assertEqual(self.repo.node(self.space, "owner.html")["owner_id"], self.target["id"])
        self.assertEqual(self.repo.node(self.space, "peer.html")["owner_id"], self.peer["id"])
        self.service.workspace_ownership(self.admin, {"id": self.space, "ownerId": self.admin["id"]})
        self.assertEqual(self.repo.node(self.space, "owner.html")["owner_id"], self.admin["id"])
        self.assertEqual(self.repo.node(self.space, "peer.html")["owner_id"], self.peer["id"])

    def test_transfer_active_owner_preserves_creator(self):
        self.service.workspace_ownership(self.admin, {"id": self.space, "ownerId": self.target["id"]})
        self.assertEqual(self.repo.workspace(self.space)["creator_id"], self.owner["id"])
        self.assertEqual(self.repo.node(self.space, "owner.html")["owner_id"], self.target["id"])
        self.assertEqual(self.repo.node(self.space, "peer.html")["owner_id"], self.peer["id"])

    def test_transfer_conflict_and_invalid_recipients_are_atomic(self):
        conflict = self.service.workspace_create(self.target, {"workspaceName": "Shared"})["id"]
        self.denied("WORKSPACE_NAME_CONFLICT", self.service.workspace_ownership, self.admin, {"id": self.space, "ownerId": self.target["id"]})
        self.assertEqual(self.repo.workspace(self.space)["owner_id"], self.owner["id"])
        self.assertEqual(self.repo.workspace(conflict)["workspace_name"], "Shared")
        self.service.change_user(self.admin, {"id": self.viewer["id"], "isDisabled": True})
        self.denied("OWNER_INVALID", self.service.workspace_ownership, self.admin, {"id": self.space, "ownerId": self.viewer["id"]})
        self.service.change_user(self.admin, {"id": self.target["id"], "isDisabled": True})
        self.denied("OWNER_INVALID", self.service.workspace_ownership, self.admin, {"id": self.space, "ownerId": self.target["id"]})
        self.denied("OWNER_INVALID", self.service.workspace_ownership, self.admin, {"id": self.space, "ownerId": new_id()})
        self.assertEqual(self.repo.node(self.space, "owner.html")["owner_id"], self.owner["id"])

    def test_admin_filters_and_bounded_member_queries(self):
        other = self.service.workspace_create(self.peer, {"workspaceName": "Other"})["id"]
        page = self.service.workspace_admin(self.admin, {"userId": self.peer["id"], "relation": "member"})
        self.assertEqual([row["id"] for row in page["data"]], [self.space])
        self.assertEqual(page["data"][0]["memberCount"], 3)
        self.assertFalse(any("password" in key.lower() for member in page["data"][0]["members"] for key in member))
        self.assertEqual(self.service.workspace_admin(self.admin, {"userId": self.peer["id"], "relation": "owner"})["data"][0]["id"], other)
        self.assertEqual(self.service.workspace_admin(self.admin, {"creator": "原始", "search": "Sha"})["totalCount"], 1)
        self.assertEqual(self.service.workspace_admin(self.admin, {"creator": "不存在"})["totalCount"], 0)
        self.assertEqual(len(self.service.workspace_admin(self.admin, {"pageSize": 1, "pageIndex": 2})["data"]), 1)
        self.assertEqual(self.service.workspace_admin(self.admin, {"pageSize": 999})["pageSize"], 200)
        self.assertEqual(self.denied("USER_NOT_EXIST", self.service.workspace_admin, self.admin, {"userId": new_id()}).code, 404)
        with mock.patch.object(self.repo, "connection", wraps=self.repo.connection) as connection:
            self.service.workspace_admin(self.admin, {})
            self.assertEqual(connection.call_count, 1)

    def test_stale_deleted_actor_cannot_recreate_assets_or_session(self):
        stale = dict(self.owner)
        self.service.user_delete(self.admin, self.owner["id"])
        self.denied("AUTH_REQUIRED", self.service.new_session, stale["id"])
        self.denied("AUTH_REQUIRED", self.service.workspace_create, stale, {"workspaceName": "orphan"})
        self.denied("AUTH_REQUIRED", self.service.access, stale, self.space)
        self.denied("AUTH_REQUIRED", self.service.folder_create, stale, {"workspaceId": self.space, "path": "orphan-folder"})
        self.denied("AUTH_REQUIRED", self.service.member_change, stale, {"workspaceId": self.space, "userId": self.target["id"]})
        self.denied("AUTH_REQUIRED", self.service.share_create, stale, {"workspaceId": self.space})
        self.denied("AUTH_REQUIRED", self.service.ticket, stale, {"workspaceId": self.space})
        self.denied("AUTH_REQUIRED", self.write, stale, "orphan.html")
        self.assertFalse(self.service.disk_path(self.space, "orphan.html").exists())
        self.assertFalse(self.service.disk_path(self.space, "orphan-folder").exists())
        cached_admin = self.user("cached-admin", "admin")
        self.service.user_delete(self.admin, cached_admin["id"])
        self.denied("PERMISSION_DENIED", self.service.user_delete, cached_admin, self.target["id"])
        self.denied("PERMISSION_DENIED", self.service.change_user, cached_admin, {"id": self.target["id"], "role": "admin"})
        self.denied("PERMISSION_DENIED", self.service.workspace_ownership, cached_admin, {"id": self.space, "ownerId": self.target["id"]})
        self.denied("AUTH_REQUIRED", self.service.mcp_key_create, cached_admin, {"keyName": "orphan", "requestId": "deleted-admin-key-0001"})
        self.assertIsNotNone(self.repo.user(self.target["id"]))
        self.assertIsNone(self.repo.workspace(self.space)["owner_id"])

    def test_stale_admin_cannot_create_or_replay_accounts(self):
        for state in ("deleted", "disabled", "downgraded"):
            with self.subTest(state=state):
                stale = self.user("stale-" + state, "admin")
                if state == "deleted":
                    self.service.user_delete(self.admin, stale["id"])
                else:
                    patch = {"isDisabled": True} if state == "disabled" else {"role": "editor"}
                    self.service.change_user(self.admin, {"id": stale["id"], **patch})
                body = {"userName": "forbidden-" + state, "password": "test-user-password", "role": "admin"}
                with self.assertRaises(BizError) as context:
                    self.service.account(body, actor=stale)
                self.assertEqual((context.exception.code, context.exception.status), (403, "PERMISSION_DENIED"))
                self.assertIsNone(self.repo.user_by_name(body["userName"]))
                with self.assertRaises(BizError) as context:
                    self.service.account({"userName": "target", "nickname": "target", "role": "editor"}, actor=stale)
                self.assertEqual((context.exception.code, context.exception.status), (403, "PERMISSION_DENIED"))

    def test_http_account_creation_rechecks_admin_after_waiting_for_lock(self):
        application = Application.__new__(Application)
        application.config, application.service = self.config, self.service
        server = ThreadingHTTPServer(("127.0.0.1", 0), application.handler())
        server_thread = threading.Thread(target=server.serve_forever, daemon=True)
        server_thread.start()
        try:
            for state in ("deleted", "disabled", "downgraded"):
                with self.subTest(state=state):
                    actor = self.user("http-stale-" + state, "admin")
                    cookie = COOKIE_NAME + "=" + self.service.new_session(actor["id"])
                    authenticated = threading.Event()
                    responses, errors = [], []
                    original_authenticate = self.service.authenticated
                    def authenticate(token):
                        user = original_authenticate(token)
                        if user["id"] == actor["id"]:
                            authenticated.set()
                        return user
                    name = "http-forbidden-" + state
                    def request():
                        connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
                        try:
                            connection.request("POST", BASE + "/user", json.dumps({"userName": name, "password": "test-user-password", "role": "admin"}),
                                               {"Cookie": cookie, "Content-Type": "application/json"})
                            response = connection.getresponse()
                            responses.append((response.status, json.loads(response.read())))
                        except Exception as exc:
                            errors.append(exc)
                        finally:
                            connection.close()
                    worker = threading.Thread(target=request, daemon=True)
                    with mock.patch.object(self.service, "authenticated", side_effect=authenticate):
                        try:
                            with self.service.lock:
                                worker.start()
                                self.assertTrue(authenticated.wait(5), "HTTP请求应先取得有效管理员快照")
                                if state == "deleted":
                                    self.service.user_delete(self.admin, actor["id"])
                                else:
                                    patch = {"isDisabled": True} if state == "disabled" else {"role": "editor"}
                                    self.service.change_user(self.admin, {"id": actor["id"], **patch})
                        finally:
                            worker.join(10)
                    self.assertFalse(worker.is_alive(), "HTTP请求应在业务锁释放后结束")
                    self.assertEqual(errors, [])
                    self.assertEqual(len(responses), 1)
                    self.assertEqual((responses[0][0], responses[0][1].get("status")), (403, "PERMISSION_DENIED"))
                    self.assertIsNone(self.repo.user_by_name(name))
        finally:
            server.shutdown()
            server.server_close()
            server_thread.join()

    def test_sql_pagination_prefix_wildcards_and_empty_count_short_circuit(self):
        for name in ("Sha_other", "Sha%literal", "shaMixed", "not-matching"):
            self.service.workspace_create(self.owner, {"workspaceName": name})
        page = self.service.workspace_admin(self.admin, {"search": "Sha", "pageSize": 1, "pageIndex": 2})
        self.assertEqual(page["totalCount"], 4)
        self.assertEqual(len(page["data"]), 1)
        self.assertEqual(self.service.workspace_admin(self.admin, {"search": "Sha%"})["totalCount"], 1)
        self.assertEqual(self.service.workspace_admin(self.admin, {"search": "Sha_"})["totalCount"], 1)
        statements = []
        original_connection = self.repo.connection
        from contextlib import contextmanager
        @contextmanager
        def traced_connection():
            with original_connection() as connection:
                connection.set_trace_callback(statements.append)
                yield connection
        with mock.patch.object(self.repo, "connection", traced_connection):
            self.assertEqual(len(self.service.workspace_admin(self.admin, {"pageSize": 1})["data"]), 1)
        self.assertFalse(any("json_each" in statement or "uuid_blob" in statement for statement in statements))
        self.assertTrue(any(" IN (" in statement for statement in statements))
        statements.clear()
        with mock.patch.object(self.repo, "connection", traced_connection):
            self.service.workspace_admin(self.admin, {"search": "no-record"})
        self.assertFalse(any("WHERE t1.workspace_id IN (" in statement or "WHERE id IN (" in statement for statement in statements))
        self.assertFalse(any("ORDER BY t1.create_time" in statement for statement in statements))

    def test_self_last_admin_and_nonadmin_guards(self):
        self.denied("SELF_DELETE_FORBIDDEN", self.service.user_delete, self.admin, self.admin["id"])
        for actor in (self.peer, self.viewer):
            self.denied("PERMISSION_DENIED", self.service.user_delete, actor, self.owner["id"])
            self.denied("PERMISSION_DENIED", self.service.workspace_admin, actor, {})
            self.denied("PERMISSION_DENIED", self.service.workspace_ownership, actor, {"id": self.space, "ownerId": actor["id"]})
        second = self.user("second-admin", "admin")
        self.service.change_user(self.admin, {"id": self.admin["id"], "role": "editor"})
        self.denied("PERMISSION_DENIED", self.service.user_delete, self.admin, second["id"])
        self.denied("SELF_DELETE_FORBIDDEN", self.service.user_delete, second, second["id"])
        self.assertEqual(self.repo.user(second["id"])["user_role"], "admin")

    def test_http_routes_require_session_and_admin(self):
        application = Application.__new__(Application)
        application.config, application.service = self.config, self.service
        server = ThreadingHTTPServer(("127.0.0.1", 0), application.handler())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            cookies = {role: COOKIE_NAME + "=" + self.service.new_session(user["id"]) for role, user in (("admin", self.admin), ("peer", self.peer))}
            def request(method, route, actor=None, body=None, query=None):
                connection = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
                headers = {"Content-Type": "application/json"}
                if actor:
                    headers["Cookie"] = cookies[actor]
                connection.request(method, BASE + route + ("?" + urlencode(query) if query else ""), json.dumps(body) if body else None, headers)
                response = connection.getresponse()
                payload = json.loads(response.read())
                status = response.status
                connection.close()
                return status, payload
            for method, route, body, query in (("DELETE", "/user", None, {"id": self.owner["id"]}), ("GET", "/workspace-admin/list", None, None), ("PATCH", "/workspace/ownership", {"id": self.space, "ownerId": self.target["id"]}, None)):
                self.assertEqual(request(method, route, body=body, query=query)[0], 401)
                self.assertEqual(request(method, route, "peer", body, query)[0], 403)
            self.assertEqual(request("GET", "/workspace-admin/list", "admin")[0], 200)
            self.assertEqual(request("PATCH", "/workspace/ownership", "admin", {"id": self.space, "ownerId": self.target["id"]}), (200, {}))
            self.assertEqual(request("DELETE", "/user", "admin", query={"id": self.owner["id"]}), (200, {}))
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


class CustodySchemaTests(unittest.TestCase):
    def test_current_schema_supports_custody_and_preserves_rows_on_reopen(self):
        with tempfile.TemporaryDirectory(prefix="baba-custody-schema-") as directory:
            path = Path(directory) / "current.sqlite3"
            repository = Repository(path)
            stamp, owner, workspace, node = now_ms(), db_id(new_id()), db_id(new_id()), db_id(new_id())
            with repository.connection() as connection:
                workspace_columns = {row["name"]: row for row in connection.execute("PRAGMA table_info(project_workspace)")}
                node_columns = {row["name"]: row for row in connection.execute("PRAGMA table_info(workspace_node)")}
                self.assertFalse(workspace_columns["owner_id"]["notnull"])
                self.assertFalse(workspace_columns["creator_id"]["notnull"])
                self.assertFalse(node_columns["owner_id"]["notnull"])
                connection.execute("INSERT INTO project_workspace (id,workspace_name,description,owner_id,creator_id,creator_nickname,create_time,update_time) VALUES (?, 'same', 'keep', ?, ?, '创建人昵称', ?, ?)", (workspace, owner, owner, stamp, stamp))
                connection.execute("INSERT INTO workspace_node (id,workspace_id,node_path,node_kind,owner_id,size_bytes,create_time,update_time) VALUES (?,?,'index.html','file',?,12,?,?)", (node, workspace, owner, stamp, stamp))
            before_workspace = repository.one("SELECT id,workspace_name,description,owner_id,creator_id,creator_nickname,create_time,update_time FROM project_workspace WHERE id=?", (workspace,))
            before_node = repository.one("SELECT id,owner_id,size_bytes,create_time,update_time FROM workspace_node WHERE id=?", (node,))
            reopened = Repository(path)
            self.assertEqual(reopened.workspace(before_workspace["id"]), before_workspace)
            self.assertEqual(reopened.one("SELECT id,owner_id,size_bytes,create_time,update_time FROM workspace_node WHERE id=?", (node,)), before_node)
            with reopened.connection() as connection:
                connection.execute("UPDATE project_workspace SET owner_id=NULL,creator_id=NULL WHERE id=?", (workspace,))
                connection.execute("UPDATE workspace_node SET owner_id=NULL WHERE id=?", (node,))
            reopened = Repository(path)
            self.assertIsNone(reopened.workspace(before_workspace["id"])["owner_id"])
            self.assertIsNone(reopened.workspace(before_workspace["id"])["creator_id"])
            self.assertEqual(reopened.workspace(before_workspace["id"])["creator_nickname"], "创建人昵称")
            self.assertEqual(reopened.one("SELECT owner_id,size_bytes FROM workspace_node WHERE id=?", (node,)), {"owner_id": None, "size_bytes": 12})


if __name__ == "__main__":
    unittest.main()
