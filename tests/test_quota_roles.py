"""配额与两层权限专项；仅使用全新临时数据库和文件目录。"""
import base64
from concurrent.futures import ThreadPoolExecutor
import http.client
import json
import sqlite3
import tempfile
from http.server import ThreadingHTTPServer
import threading
import unittest
from pathlib import Path
from unittest import mock

from backend.config import Config
from backend.controller import Application, BASE, COOKIE_NAME
from backend.mcp import MCP
from backend.repository import Repository, SCHEMA, db_id, new_id
from backend.service import BizError, Service


class QuotaRoleTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="baba-quota-")
        self.addCleanup(self.temp.cleanup)
        self.config = Config(Path(self.temp.name))
        self.service = Service(self.config)
        self.repo = self.service.repo
        view = self.service.account({"userName": "admin", "password": "password-123"}, "setup")
        self.admin = self.repo.user(view["id"])
        self.owner = self.user("owner")
        self.editor = self.user("editor")
        self.viewer = self.user("viewer")
        self.manager = self.user("manager")
        self.space = self.service.workspace_create(self.owner, {"workspaceName": "共享空间"})["id"]
        for user, role in ((self.editor, "editor"), (self.viewer, "viewer"), (self.manager, "manager")):
            self.member(user, role)

    def user(self, name):
        view = self.service.account({"userName": name, "password": "password-123"}, actor=self.admin)
        self.assertEqual(view["role"], "editor")
        return self.repo.user(view["id"])

    def member(self, user, role):
        return self.service.member_change(self.owner, {"workspaceId": self.space, "userId": user["id"], "memberRole": role})

    def write(self, user, path, content="abc", space=None, service=None):
        return (service or self.service).file_write(user, {"workspaceId": space or self.space, "path": path, "content": content})

    def quota(self, user=None):
        return self.service.quota_detail(user or self.owner)

    def limits(self, user=None, **values):
        return self.service.change_user(self.admin, {"id": (user or self.owner)["id"], **values})

    def denied(self, status, function, *args, **kwargs):
        with self.assertRaises(BizError) as error:
            function(*args, **kwargs)
        self.assertEqual(error.exception.status, status)
        return error.exception

    def test_default_inheritance_independent_override_null_and_zero(self):
        self.assertEqual(self.quota()["effectiveFileCountLimit"], 0)
        self.service.settings(self.admin, {"defaultFileCountLimit": 3, "defaultStorageBytesLimit": 10})
        quota = self.quota()
        self.assertIsNone(quota["fileCountLimit"])
        self.assertEqual((quota["effectiveFileCountLimit"], quota["effectiveStorageBytesLimit"]), (3, 10))
        self.limits(fileCountLimit=0)
        self.assertEqual((self.quota()["effectiveFileCountLimit"], self.quota()["effectiveStorageBytesLimit"]), (0, 10))
        result = self.limits(storageBytesLimit=4)
        self.assertEqual(result["quota"]["effectiveStorageBytesLimit"], 4)
        self.service.settings(self.admin, {"defaultFileCountLimit": 2, "defaultStorageBytesLimit": 8})
        self.assertEqual((self.quota()["effectiveFileCountLimit"], self.quota()["effectiveStorageBytesLimit"]), (0, 4))
        self.limits(fileCountLimit=None, storageBytesLimit=None)
        self.assertEqual((self.quota()["effectiveFileCountLimit"], self.quota()["effectiveStorageBytesLimit"]), (2, 8))
        self.service.settings(self.admin, {"defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})
        self.assertEqual(self.quota()["effectiveStorageBytesLimit"], 0)

    def test_invalid_limits_are_atomic_and_admin_only(self):
        for value in (-1, True, "1", 1.5, 9007199254740992):
            self.denied("QUOTA_INVALID", self.limits, fileCountLimit=value)
            self.denied("QUOTA_INVALID", self.service.settings, self.admin, {"defaultStorageBytesLimit": value})
        self.denied("QUOTA_INVALID", self.service.settings, self.admin, {"defaultFileCountLimit": None})
        self.denied("PERMISSION_DENIED", self.service.settings, self.manager, {"defaultFileCountLimit": 1})
        self.denied("PERMISSION_DENIED", self.service.change_user, self.manager, {"id": self.manager["id"], "fileCountLimit": 0})
        self.assertEqual(self.quota()["effectiveFileCountLimit"], 0)

    def test_cross_workspace_usage_folders_and_deletion_release(self):
        other = self.service.workspace_create(self.owner, {"workspaceName": "第二空间"})["id"]
        self.limits(fileCountLimit=2, storageBytesLimit=6)
        self.write(self.owner, "a/b.txt")
        self.write(self.owner, "c.txt", space=other)
        self.assertEqual((self.quota()["usedFileCount"], self.quota()["usedStorageBytes"]), (2, 6))
        self.denied("FILE_COUNT_QUOTA_EXCEEDED", self.write, self.owner, "d.txt", "")
        self.service.folder_create(self.owner, {"workspaceId": self.space, "path": "empty"})
        self.service.node_delete(self.owner, self.space, "a", "folder")
        self.assertEqual(self.quota()["usedStorageBytes"], 3)
        self.write(self.owner, "d.txt")
        self.service.workspace_delete(self.owner, other)
        self.assertEqual(self.quota()["usedFileCount"], 1)

    def test_over_quota_blocks_only_growth_and_allows_shrinking(self):
        self.write(self.owner, "a.txt", "123456")
        self.write(self.owner, "b.txt", "1234")
        self.limits(fileCountLimit=1, storageBytesLimit=3)
        self.assertEqual(self.quota()["usedStorageBytes"], 10)
        self.write(self.owner, "a.txt", "123456")
        self.write(self.owner, "a.txt", "1")
        self.assertEqual(self.quota()["usedStorageBytes"], 5)
        self.denied("STORAGE_QUOTA_EXCEEDED", self.write, self.owner, "a.txt", "12")
        self.denied("FILE_COUNT_QUOTA_EXCEEDED", self.write, self.owner, "c.txt", "")
        self.service.node_move(self.owner, {"workspaceId": self.space, "path": "a.txt", "newPath": "renamed.txt"}, "file")
        self.service.node_delete(self.owner, self.space, "b.txt", "file")
        self.assertEqual((self.quota()["usedFileCount"], self.quota()["usedStorageBytes"]), (1, 1))

    def test_rejection_occurs_before_any_disk_or_metadata_write(self):
        self.write(self.owner, "existing.txt")
        self.limits(fileCountLimit=1, storageBytesLimit=3)
        before = self.repo.nodes(self.space)
        body = {"workspaceId": self.space, "conflictPolicy": "overwrite", "requestId": "quota-no-write-0001", "files": [
            {"path": "existing.txt", "contentBase64": base64.b64encode(b"xy").decode()},
            {"path": "new/sub/file.txt", "contentBase64": ""}]}
        with mock.patch("backend.service.tempfile.mkdtemp", side_effect=AssertionError("超限不能创建暂存")), mock.patch("backend.service.os.replace", side_effect=AssertionError("超限不能覆盖文件")):
            self.denied("FILE_COUNT_QUOTA_EXCEEDED", self.service.upload, self.owner, body)
        self.assertEqual(self.repo.nodes(self.space), before)
        self.assertEqual(self.service.disk_path(self.space, "existing.txt").read_bytes(), b"abc")
        self.assertFalse(self.service.disk_path(self.space, "new").exists())
        self.assertIsNone(self.repo.one("SELECT id FROM upload_request WHERE request_id=?", (body["requestId"],)))

    def test_override_owner_and_rename_upload_owner_and_idempotency(self):
        self.write(self.owner, "a.txt")
        self.limits(storageBytesLimit=3)
        self.limits(self.manager, fileCountLimit=1, storageBytesLimit=5)
        self.denied("STORAGE_QUOTA_EXCEEDED", self.write, self.manager, "a.txt", "1234")
        self.write(self.manager, "a.txt", "12")
        self.assertEqual(self.repo.node(self.space, "a.txt")["owner_id"], self.owner["id"])
        self.assertEqual((self.quota()["usedStorageBytes"], self.quota(self.manager)["usedFileCount"]), (2, 0))
        body = {"workspaceId": self.space, "conflictPolicy": "rename", "requestId": "quota-rename-0001", "files": [{"path": "a.txt", "contentBase64": base64.b64encode(b"12345").decode()}]}
        result = self.service.upload(self.manager, body)
        self.assertEqual(self.service.upload(self.manager, body), result)
        self.assertEqual(self.repo.node(self.space, result["files"][0]["targetPath"])["owner_id"], self.manager["id"])
        self.assertEqual((self.quota(self.manager)["usedFileCount"], self.quota(self.manager)["usedStorageBytes"]), (1, 5))
        self.denied("FILE_COUNT_QUOTA_EXCEEDED", self.service.upload, self.manager, {**body, "requestId": "quota-rename-0002"})

    def test_batch_net_bytes_per_owner_and_no_cross_owner_subsidy(self):
        self.write(self.owner, "a.txt", "12345")
        self.write(self.owner, "b.txt", "1")
        self.write(self.editor, "c.txt", "12345")
        self.limits(storageBytesLimit=6)
        self.limits(self.editor, storageBytesLimit=5)
        def upload(values):
            return self.service.upload(self.manager, {"workspaceId": self.space, "conflictPolicy": "overwrite", "files": [{"path": path, "contentBase64": base64.b64encode(content.encode()).decode()} for path, content in values]})
        upload([("a.txt", "1"), ("b.txt", "12345")])
        self.assertEqual(self.quota()["usedStorageBytes"], 6)
        self.denied("STORAGE_QUOTA_EXCEEDED", upload, [("a.txt", "12"), ("c.txt", "")])
        self.assertEqual(self.quota(self.editor)["usedStorageBytes"], 5)

    def test_admin_has_no_quota_bypass_and_parallel_limit_is_atomic(self):
        self.service.settings(self.admin, {"defaultFileCountLimit": 1})
        self.write(self.admin, "admin.txt")
        self.denied("FILE_COUNT_QUOTA_EXCEEDED", self.write, self.admin, "admin2.txt")
        other_service = Service(self.config)
        def attempt(index):
            try:
                self.write(self.owner, "parallel/" + str(index) + ".txt", service=other_service if index % 2 else self.service)
                return "ok"
            except BizError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(attempt, range(12)))
        self.assertEqual(results.count("ok"), 1)
        self.assertEqual(results.count("FILE_COUNT_QUOTA_EXCEEDED"), 11)
        self.assertEqual(self.quota()["usedFileCount"], 1)

    def test_parallel_byte_limit_and_duplicate_request_charge_once(self):
        self.limits(storageBytesLimit=5)
        other_service = Service(self.config)
        def attempt(index):
            try:
                self.write(self.owner, str(index) + ".txt", "123", service=other_service if index % 2 else self.service)
                return "ok"
            except BizError as error:
                return error.status
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(attempt, range(6)))
        self.assertEqual(results.count("ok"), 1)
        self.assertEqual(results.count("STORAGE_QUOTA_EXCEEDED"), 5)
        body = {"workspaceId": self.space, "requestId": "parallel-duplicate-001", "files": [{"path": "duplicate.txt", "contentBase64": "MTI="}]}
        with ThreadPoolExecutor(max_workers=6) as pool:
            responses = list(pool.map(lambda index: (other_service if index % 2 else self.service).upload(self.owner, body), range(6)))
        self.assertTrue(all(response == responses[0] for response in responses))
        self.assertEqual((self.quota()["usedFileCount"], self.quota()["usedStorageBytes"]), (2, 5))

    def test_transfer_and_deleted_owner_custody_respect_quota(self):
        self.write(self.owner, "owner.txt", "12345")
        self.write(self.editor, "editor.txt")
        self.limits(self.manager, storageBytesLimit=4)
        self.denied("STORAGE_QUOTA_EXCEEDED", self.service.workspace_ownership, self.admin, {"id": self.space, "ownerId": self.manager["id"]})
        self.assertEqual(self.repo.workspace(self.space)["owner_id"], self.owner["id"])
        self.service.user_delete(self.admin, self.owner["id"])
        self.assertIsNone(self.repo.node(self.space, "owner.txt")["owner_id"])
        self.denied("STORAGE_QUOTA_EXCEEDED", self.service.workspace_ownership, self.admin, {"id": self.space, "ownerId": self.manager["id"]})
        self.limits(self.manager, storageBytesLimit=5, fileCountLimit=1)
        self.service.workspace_ownership(self.admin, {"id": self.space, "ownerId": self.manager["id"]})
        self.assertEqual(self.quota(self.manager)["usedStorageBytes"], 5)
        self.assertEqual(self.quota(self.editor)["usedStorageBytes"], 3)
        self.assertEqual(self.service.workspace_ownership(self.admin, {"id": self.space, "ownerId": self.manager["id"]}), {})

    def test_three_member_roles_scope_and_recursive_foreign_protection(self):
        self.write(self.owner, "site/index.txt")
        self.write(self.editor, "site/own.txt")
        self.assertEqual(self.service.file_read(self.viewer, self.space, "site/index.txt")["content"], "abc")
        self.denied("READ_ONLY", self.write, self.viewer, "mine.txt")
        self.denied("FOREIGN_CONTENT", self.write, self.editor, "site/index.txt")
        self.denied("FOREIGN_CONTENT", self.service.node_delete, self.editor, self.space, "site", "folder")
        self.denied("FOREIGN_CONTENT", self.service.node_move, self.editor, {"workspaceId": self.space, "path": "site", "newPath": "other"}, "folder")
        self.write(self.editor, "site/own.txt", "own")
        self.write(self.manager, "site/index.txt", "managed")
        self.service.workspace_change(self.manager, {"id": self.space, "description": "管理"})
        self.service.member_change(self.manager, {"workspaceId": self.space, "userId": self.viewer["id"], "memberRole": "editor"})
        self.assertEqual(self.repo.user(self.manager["id"])["user_role"], "editor")
        self.denied("PERMISSION_DENIED", self.service.users, self.manager)
        other = self.service.workspace_create(self.editor, {"workspaceName": "独立空间"})["id"]
        self.denied("PERMISSION_DENIED", self.service.workspace_change, self.manager, {"id": other, "description": "越权"})
        self.denied("PERMISSION_DENIED", self.service.member_change, self.manager, {"workspaceId": self.space, "userId": self.owner["id"], "memberRole": "viewer"})
        self.denied("PERMISSION_DENIED", self.service.member_delete, self.manager, self.space, self.owner["id"])
        self.assertNotIn("quota", self.service.members(self.viewer, self.space)[0])
        self.service.workspace_delete(self.manager, self.space)
        self.assertIsNone(self.repo.workspace(self.space))

    def test_manager_invitations_repeat_accept_does_not_escalate(self):
        invitation = self.service.invitation_create(self.manager, {"workspaceId": self.space, "memberRole": "manager", "requestId": "role-invitation-0001"})
        self.assertEqual(invitation["memberRole"], "manager")
        token = invitation["inviteUrl"].split("=")[-1]
        self.service.invitation_membership(self.viewer, {"token": token})
        self.assertEqual(self.service.workspace_view(self.viewer, self.repo.workspace(self.space))["memberRole"], "viewer")
        fresh = self.user("fresh")
        self.service.invitation_membership(fresh, {"token": token})
        self.assertTrue(self.service.workspace_view(fresh, self.repo.workspace(self.space))["canManage"])
        self.member(self.manager, "editor")
        self.denied("INVITATION_INVALID", self.service.invitation_membership, self.editor, {"token": token})

    def test_default_lowering_keeps_files_and_manager_share_permissions(self):
        self.write(self.owner, "folder/a.txt", "1234")
        self.write(self.owner, "folder/b.txt", "12")
        share = self.service.share_create(self.owner, {"workspaceId": self.space, "path": "folder"})
        self.service.settings(self.admin, {"defaultFileCountLimit": 1, "defaultStorageBytesLimit": 3})
        self.assertEqual((self.quota()["usedFileCount"], self.quota()["usedStorageBytes"]), (2, 6))
        self.assertEqual(self.service.disk_path(self.space, "folder/a.txt").read_bytes(), b"1234")
        self.write(self.owner, "folder/a.txt", "1")
        self.denied("FILE_COUNT_QUOTA_EXCEEDED", self.write, self.owner, "new.txt", "")
        self.denied("READ_ONLY", self.service.share_delete, self.viewer, share["id"])
        self.service.share_delete(self.manager, share["id"])
        self.denied("SHARE_NOT_EXIST", self.service.share_access, share["token"])
        self.limits(fileCountLimit=0, storageBytesLimit=0)
        self.write(self.owner, "new.txt", "unlimited")

    def test_global_viewer_rejected_and_registration_cannot_elevate(self):
        self.denied("PARAM_INVALID", self.service.account, {"userName": "invalid", "password": "password-123", "role": "viewer"}, actor=self.admin)
        self.denied("PARAM_INVALID", self.service.change_user, self.admin, {"id": self.editor["id"], "role": "viewer"})
        self.service.settings(self.admin, {"registrationEnabled": True})
        registered = self.service.account({"userName": "registered", "password": "password-123", "role": "admin"}, "registration")
        self.assertEqual(registered["role"], "editor")
        self.denied("LAST_ADMIN", self.service.change_user, self.admin, {"id": self.admin["id"], "role": "editor"})

    def test_http_and_mcp_same_quota_and_live_permissions(self):
        application = Application(self.config)
        server = ThreadingHTTPServer(("127.0.0.1", 0), application.handler())
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        cookie = COOKIE_NAME + "=" + self.service.new_session(self.owner["id"])
        def request(method, path, body=None):
            client = http.client.HTTPConnection("127.0.0.1", server.server_port, timeout=10)
            client.request(method, BASE + path, json.dumps(body) if body is not None else None, {"Content-Type": "application/json", "Cookie": cookie})
            response = client.getresponse()
            result = response.status, json.loads(response.read())
            client.close()
            return result
        self.limits(fileCountLimit=1, storageBytesLimit=3)
        self.assertEqual(request("GET", "/quota/detail")[1]["effectiveFileCountLimit"], 1)
        self.assertEqual(request("PUT", "/file/content", {"workspaceId": self.space, "path": "http.txt", "content": "abc"})[0], 200)
        status, result = request("POST", "/file/upload", {"workspaceId": self.space, "files": [{"path": "second.txt", "contentBase64": ""}]})
        self.assertEqual((status, result["code"], result["status"]), (409, 409, "FILE_COUNT_QUOTA_EXCEEDED"))
        mcp = MCP(self.service)
        def call(user, name, args):
            if name == "file_write":
                snapshot = mcp.call(user, 1, {"name": "directory_tree", "arguments": {}})[1]["result"]["structuredContent"]
                target = next(node for node in snapshot["nodes"] if node["workspaceId"] == args["workspaceId"] and node["path"] == "")
                args = {"treeToken": snapshot["treeToken"], "targetId": target["targetId"], "relativePath": args["path"], "content": args["content"]}
            return mcp.call(user, 1, {"name": name, "arguments": args})[1]["result"]
        error = call(self.owner, "file_write", {"workspaceId": self.space, "path": "http.txt", "content": "abcd"})
        self.assertTrue(error["isError"])
        self.assertEqual(error["structuredContent"]["status"], "STORAGE_QUOTA_EXCEEDED")
        self.assertEqual(call(self.viewer, "file_write", {"workspaceId": self.space, "path": "view.txt", "content": ""})["structuredContent"]["status"], "READ_ONLY")
        self.assertEqual(call(self.editor, "file_write", {"workspaceId": self.space, "path": "http.txt", "content": ""})["structuredContent"]["status"], "FOREIGN_CONTENT")
        self.assertFalse(call(self.manager, "member_change", {"workspaceId": self.space, "userId": self.viewer["id"], "memberRole": "editor"})["isError"])
        self.assertFalse(call(self.viewer, "file_write", {"workspaceId": self.space, "path": "view.txt", "content": ""})["isError"])
        self.assertEqual(self.repo.node(self.space, "http.txt")["size_bytes"], 3)


class SchemaInitializationTests(unittest.TestCase):
    def test_schema_script_defines_complete_current_model(self):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.executescript(SCHEMA)
        expected = {
            "sys_user": {"email", "is_email_verified", "file_count_limit", "storage_bytes_limit", "user_role"},
            "app_setting": {"is_email_registration_enabled", "registration_revision", "mail_settings", "default_file_count_limit", "default_storage_bytes_limit"},
            "email_activation": {"user_name"},
            "auth_mcp_key": {"mcp_derivation_version", "mcp_derivation_nonce"},
            "project_workspace": {"creator_id", "creator_nickname", "owner_id"},
            "workspace_node": {"size_bytes"},
            "workspace_member": {"member_role"},
            "workspace_invitation": {"member_role"},
            "onboarding_preview_proof": {"target_path"},
        }
        for table, columns in expected.items():
            with self.subTest(table=table):
                actual = {row[0] for row in connection.execute("SELECT name FROM pragma_table_info(?)", (table,))}
                self.assertTrue(columns.issubset(actual), columns - actual)
        self.assertEqual(connection.execute("SELECT [notnull] FROM pragma_table_info('email_activation') WHERE name='user_name'").fetchone()[0], 1)
        self.assertNotIn("revoked_time", {row[0] for row in connection.execute("SELECT name FROM pragma_table_info('auth_mcp_key')")})
        indexes = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        self.assertTrue({"uk_sys_user_email", "idx_workspace_node_owner_kind", "uk_auth_mcp_key_hash", "uk_auth_mcp_key_request"}.issubset(indexes))
        before = connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall()
        connection.executescript(SCHEMA)
        self.assertEqual(connection.execute("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").fetchall(), before)

    def test_empty_database_initializes_and_reopens_without_schema_or_data_changes(self):
        for empty_file in (False, True):
            with self.subTest(empty_file=empty_file), tempfile.TemporaryDirectory(prefix="baba-schema-") as directory:
                path = Path(directory) / "new.sqlite3"
                if empty_file:
                    path.touch()
                repository = Repository(path)
                before = repository.all("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name")
                setting = repository.one("SELECT id,is_registration_enabled,is_email_registration_enabled,registration_revision,mail_settings,default_file_count_limit,default_storage_bytes_limit,create_time,update_time FROM app_setting")
                self.assertEqual({key: setting[key] for key in ("is_registration_enabled", "is_email_registration_enabled", "registration_revision", "default_file_count_limit", "default_storage_bytes_limit")},
                                 {"is_registration_enabled": 0, "is_email_registration_enabled": 0, "registration_revision": 0, "default_file_count_limit": 0, "default_storage_bytes_limit": 0})
                self.assertEqual(setting["mail_settings"], "{}")
                self.assertIsInstance(setting["create_time"], int)
                self.assertGreater(setting["create_time"], 1_000_000_000_000)
                reopened = Repository(path)
                self.assertEqual(reopened.all("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name"), before)
                self.assertEqual(reopened.one("SELECT id,is_registration_enabled,is_email_registration_enabled,registration_revision,mail_settings,default_file_count_limit,default_storage_bytes_limit,create_time,update_time FROM app_setting"), setting)
                self.assertEqual(reopened.one("SELECT count(*) AS setting_count FROM app_setting")["setting_count"], 1)
                self.assertEqual(sorted(item.name for item in Path(directory).iterdir()), ["new.sqlite3"])

    def test_current_schema_damage_is_rejected_readonly_without_repair(self):
        damage = (
            "DROP INDEX uk_sys_user_email",
            "DROP TABLE onboarding_preview_target",
            "ALTER TABLE sys_user ADD COLUMN unexpected_field TEXT",
        )
        for statement in damage:
            with self.subTest(statement=statement), tempfile.TemporaryDirectory(prefix="baba-schema-integrity-") as directory:
                path = Path(directory) / "current.sqlite3"
                repository = Repository(path)
                repository.execute(statement)
                before = path.read_bytes()
                with mock.patch.object(Repository, "connection", side_effect=AssertionError("结构损坏不能开启写连接")):
                    with self.assertRaisesRegex(RuntimeError, "SCHEMA_INVALID.*结构"):
                        Repository(path)
                self.assertEqual(path.read_bytes(), before)
                self.assertEqual(sorted(item.name for item in Path(directory).iterdir()), ["current.sqlite3"])

    def test_current_schema_constraint_damage_is_rejected_before_writes(self):
        with tempfile.TemporaryDirectory(prefix="baba-schema-integrity-") as directory:
            path = Path(directory) / "current.sqlite3"
            connection = sqlite3.connect(path)
            try:
                connection.executescript(SCHEMA.replace("user_name TEXT NOT NULL COLLATE NOCASE, nickname", "user_name TEXT COLLATE NOCASE, nickname"))
            finally:
                connection.close()
            before = path.read_bytes()
            with self.assertRaisesRegex(RuntimeError, "SCHEMA_INVALID.*email_activation"):
                Repository(path)
            self.assertEqual(path.read_bytes(), before)

    def test_current_model_rejects_invalid_roles_and_negative_quotas(self):
        connection = sqlite3.connect(":memory:")
        self.addCleanup(connection.close)
        connection.executescript(SCHEMA)
        user, workspace = db_id(new_id()), db_id(new_id())
        for role, quota in (("viewer", None), ("editor", -1)):
            with self.subTest(role=role, quota=quota), self.assertRaises(sqlite3.IntegrityError):
                connection.execute("INSERT INTO sys_user (id,user_name,nickname,password_hash,user_role,file_count_limit,create_time,update_time) VALUES (?,'user','成员','hash',?,?,1,1)", (user, role, quota))
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute("INSERT INTO workspace_member (id,workspace_id,user_id,member_role,create_time,update_time) VALUES (?,?,?,'admin',1,1)", (db_id(new_id()), workspace, user))
        with self.assertRaises(sqlite3.IntegrityError):
            connection.execute("INSERT INTO app_setting (id,default_storage_bytes_limit,create_time,update_time) VALUES (?,-1,1,1)", (db_id(new_id()),))


if __name__ == "__main__":
    unittest.main()
