"""临时数据库验证MCP纯目录快照、选择凭证和创建边界。"""
import base64
import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from backend.config import Config
from backend.mcp import MCP
from backend.mcp_tree import DirectoryTree, TREE_META_KEY
from backend.repository import db_id, new_id
from backend.service import BizError, Service


class DirectoryTreeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="baba-tree-")
        self.addCleanup(self.temp.cleanup)
        self.service = Service(Config(Path(self.temp.name), port=1))
        view = self.service.account({"userName": "admin", "password": "tree-test-password"}, mode="setup")
        self.admin = self.service.repo.user(view["id"])
        self.workspace = self.service.workspace_create(self.admin, {"workspaceName": "完整工作区"})
        self.workspace_id = self.workspace["id"]
        self.tree = DirectoryTree(self.service)

    def account(self, name):
        view = self.service.account({"userName": name, "password": "tree-test-password", "role": "editor"},
                                    mode="admin", actor=self.admin)
        return self.service.repo.user(view["id"])

    def member(self, user, role):
        return self.service.member_change(self.admin, {"workspaceId": self.workspace_id,
                                          "userId": user["id"], "memberRole": role})

    def folder(self, path):
        self.service.folder_create(self.admin, {"workspaceId": self.workspace_id, "path": path})

    def selection(self, user=None, path="", workspace_id=None):
        result = self.tree.snapshot(user or self.admin)
        target = next(node for node in result["nodes"] if node["workspaceId"] == (workspace_id or self.workspace_id) and node["path"] == path)
        return {"treeToken": result["treeToken"], "targetId": target["targetId"]}

    def assert_status(self, status, function, *args):
        with self.assertRaises(BizError) as error:
            function(*args)
        self.assertEqual(error.exception.status, status)

    def test_complete_tree_has_all_workspaces_empty_folders_and_no_files(self):
        empty = self.service.workspace_create(self.admin, {"workspaceName": "空工作区"})
        self.folder("父目录/空目录")
        self.service.file_write(self.admin, {"workspaceId": self.workspace_id, "path": "父目录/不可泄露.txt", "content": "私密正文"})
        with mock.patch.object(self.service, "disk_path", side_effect=AssertionError("目录树不得扫描磁盘")):
            result = self.tree.snapshot(self.admin)
        serialized = json.dumps(result, ensure_ascii=False)
        self.assertNotIn("不可泄露.txt", serialized)
        self.assertNotIn("私密正文", serialized)
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["nodes"]), 4)
        roots = [node for node in result["nodes"] if node["nodeType"] == "workspaceRoot"]
        self.assertEqual({node["workspaceId"] for node in roots}, {self.workspace_id, empty["id"]})
        self.assertTrue(all(node["nodeId"] is None and node["parentId"] is None for node in roots))
        parent = next(node for node in result["nodes"] if node["path"] == "父目录")
        child = next(node for node in result["nodes"] if node["path"] == "父目录/空目录")
        self.assertEqual(child["parentId"], parent["nodeId"])
        self.assertEqual(child["displayPath"], "完整工作区/父目录/空目录")
        snapshot_id = result["treeToken"].split(".")[0]
        self.assertNotIn("不可泄露.txt", self.tree.snapshots[snapshot_id]["payload"].decode())
        self.assertEqual(len(result["treeToken"]), 97)

    def test_no_pagination_or_silent_truncation(self):
        initial_token = self.tree.snapshot(self.admin)["treeToken"]
        with self.service.repo.connection() as connection:
            for index in range(205):
                connection.execute("INSERT INTO workspace_node (id,workspace_id,node_path,node_kind,owner_id,create_time,update_time) VALUES (?,?,?,'folder',?,1,1)",
                                   (db_id(new_id()), db_id(self.workspace_id), f"目录{index:03}", db_id(self.admin["id"])))
        result = self.tree.snapshot(self.admin)
        self.assertTrue(result["complete"])
        self.assertEqual(len(result["nodes"]), 206)
        self.assertEqual(len(result["treeToken"]), len(initial_token))
        entries_before = len(self.tree.snapshots)
        self.tree.max_response_bytes = 200
        result = self.tree.snapshot(self.admin)
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "DIRECTORY_TREE_TOO_LARGE")
        self.assertIsNone(result["treeToken"])
        self.assertEqual(len(self.tree.snapshots), entries_before)
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "folder_create", self.admin,
                           {"treeToken": result["treeToken"], "targetId": "workspace:" + self.workspace_id, "relativePath": "禁止"})

    def test_access_filter_and_role_capabilities(self):
        editor = self.account("editor")
        self.assertEqual(self.tree.snapshot(editor)["nodes"], [])
        self.folder("他人的目录")
        for role in ("viewer", "editor", "manager"):
            with self.subTest(role=role):
                self.member(editor, role)
                result = self.tree.snapshot(editor)
                self.assertEqual(len(result["nodes"]), 2)
                self.assertTrue(all(node["memberRole"] == role and node["canCreateChild"] == (role != "viewer") for node in result["nodes"]))
                selection = self.selection(editor, "他人的目录")
                args = {**selection, "relativePath": role + ".txt", "content": "内容"}
                if role == "viewer":
                    self.assert_status("READ_ONLY", self.tree.create, "file_write", editor, args)
                else:
                    self.tree.create("file_write", editor, args)
                    node = self.service.repo.node(self.workspace_id, "他人的目录/" + role + ".txt")
                    self.assertEqual(node["owner_id"], editor["id"])

    def test_cross_user_tampering_expiration_and_unknown_target(self):
        editor = self.account("other")
        self.member(editor, "manager")
        selection = self.selection()
        args = {**selection, "relativePath": "新目录"}
        self.assert_status("MCP_TREE_INVALID", self.tree.create, "folder_create", editor, args)
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "folder_create", self.admin,
                           {**args, "treeToken": selection["treeToken"] + "x"})
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "folder_create", self.admin,
                           {**args, "targetId": new_id()})
        with mock.patch("backend.mcp_tree.now_ms", return_value=10**16):
            self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "folder_create", self.admin, args)
        fresh_instance = DirectoryTree(self.service)
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", fresh_instance.create, "folder_create", self.admin, args)

    def test_moved_deleted_replaced_and_revoked_targets_require_refresh(self):
        editor = self.account("selected-editor")
        self.member(editor, "editor")
        self.folder("目标")
        selection = self.selection(editor, "目标")
        args = {**selection, "relativePath": "文件.txt", "content": "内容"}
        self.service.node_move(self.admin, {"workspaceId": self.workspace_id, "path": "目标", "newPath": "已移动"}, "folder")
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", editor, args)
        self.folder("目标")
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", editor, args)
        args.update(self.selection(editor, "目标"))
        self.service.node_delete(self.admin, self.workspace_id, "目标", "folder")
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", editor, args)
        args.update(self.selection(editor))
        self.member(editor, "viewer")
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", editor, args)
        self.member(editor, "editor")
        args.update(self.selection(editor))
        self.service.member_delete(self.admin, self.workspace_id, editor["id"])
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", editor, args)

    def test_workspace_rename_delete_and_disabled_user_require_revalidation(self):
        selection = self.selection()
        args = {**selection, "relativePath": "文件.txt", "content": "内容"}
        self.service.workspace_change(self.admin, {"id": self.workspace_id, "workspaceName": "新名称"})
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", self.admin, args)
        args.update(self.selection())
        self.service.workspace_delete(self.admin, self.workspace_id)
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", self.admin, args)
        self.service.repo.execute("UPDATE sys_user SET is_disabled=1 WHERE id=?", (db_id(self.admin["id"]),))
        self.assert_status("AUTH_REQUIRED", self.tree.snapshot, self.admin)

    def test_relative_paths_cannot_escape_target_and_upload_keeps_subpaths(self):
        self.folder("目标")
        selection = self.selection(path="目标")
        for path in ("../逃逸.txt", "/绝对.txt", "a/../../逃逸.txt", "C:/文件.txt", "a\\文件.txt"):
            for operation in ("folder_create", "file_write", "upload"):
                with self.subTest(path=path, operation=operation):
                    args = {**selection, "relativePath": path, "content": "内容"} if operation != "upload" else {
                        **selection, "files": [{"path": path, "contentBase64": "eA=="}]}
                    self.assert_status("PARAM_INVALID", self.tree.create, operation, self.admin, args)
        result = self.tree.create("upload", self.admin, {**selection, "requestId": "tree-upload-idempotent", "files": [
            {"path": "站点/index.html", "contentBase64": "eA=="}, {"path": "站点/js/app.js", "contentBase64": "eQ=="}]})
        self.assertEqual(result["count"], 2)
        self.assertIsNotNone(self.service.repo.node(self.workspace_id, "目标/站点/js/app.js"))
        repeated = self.tree.create("upload", self.admin, {**selection, "requestId": "tree-upload-idempotent", "files": [
            {"path": "站点/index.html", "contentBase64": "eA=="}, {"path": "站点/js/app.js", "contentBase64": "eQ=="}]})
        self.assertEqual(result, repeated)

    def test_snapshot_cache_lru_count_bytes_expiry_and_stable_version(self):
        self.tree.max_cache_entries = 2
        first = self.selection()
        second = self.selection()
        self.tree.create("folder_create", self.admin, {**first, "relativePath": "保持活跃"})
        third = self.selection()
        self.assertEqual(len(self.tree.snapshots), 2)
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "folder_create", self.admin,
                           {**second, "relativePath": "已淘汰"})
        self.assertEqual(self.tree.snapshot(self.admin)["treeVersion"], self.tree.snapshot(self.admin)["treeVersion"])
        entry = next(iter(self.tree.snapshots.values()))
        self.tree.max_cache_bytes = entry["size"] + 16
        self.tree.snapshot(self.admin)
        self.assertLessEqual(self.tree.cache_bytes, self.tree.max_cache_bytes)
        self.assertEqual(len(self.tree.snapshots), 1)
        with mock.patch("backend.mcp_tree.now_ms", return_value=10**16):
            self.tree.prune()
        self.assertEqual((len(self.tree.snapshots), self.tree.cache_bytes), (0, 0))

    def test_orphan_folder_metadata_returns_incomplete_tree(self):
        self.service.repo.execute("INSERT INTO workspace_node (id,workspace_id,node_path,node_kind,owner_id,create_time,update_time) VALUES (?,?,?,'folder',?,1,1)",
                                  (db_id(new_id()), db_id(self.workspace_id), "缺失父目录/子目录", db_id(self.admin["id"])))
        result = self.tree.snapshot(self.admin)
        self.assertFalse(result["complete"])
        self.assertEqual(result["reason"], "DIRECTORY_METADATA_INCONSISTENT")
        self.assertIsNone(result["treeToken"])

    def test_unrelated_tree_refresh_does_not_invalidate_other_clients(self):
        editor = self.account("parallel-client")
        self.member(editor, "editor")
        selected = self.selection(editor)
        second = self.tree.snapshot(editor)
        self.assertTrue(second["complete"])
        self.tree.create("folder_create", editor, {**selected, "relativePath": "原客户端目录"})
        self.assertIsNotNone(self.service.repo.node(self.workspace_id, "原客户端目录"))

    def test_missing_physical_target_does_not_recreate_it(self):
        self.folder("消失目录")
        selection = self.selection(path="消失目录")
        self.service.disk_path(self.workspace_id, "消失目录").rmdir()
        self.assert_status("MCP_TREE_REFRESH_REQUIRED", self.tree.create, "file_write", self.admin,
                           {**selection, "relativePath": "不应重建.txt", "content": "x"})
        self.assertFalse(self.service.disk_path(self.workspace_id, "消失目录").exists())

    def test_shared_service_quotas_still_apply(self):
        editor = self.account("quota-editor")
        self.member(editor, "editor")
        selection = self.selection(editor)
        self.service.repo.execute("UPDATE sys_user SET file_count_limit=1,storage_bytes_limit=4 WHERE id=?", (db_id(editor["id"]),))
        self.tree.create("file_write", editor, {**selection, "relativePath": "first.txt", "content": "x"})
        with self.assertRaises(BizError) as error:
            self.tree.create("file_write", editor, {**selection, "relativePath": "second.txt", "content": "x"})
        self.assertIn("QUOTA", error.exception.status)
        self.assertIsNone(self.service.repo.node(self.workspace_id, "second.txt"))
        with self.assertRaises(BizError) as error:
            self.tree.create("file_write", editor, {**selection, "relativePath": "first.txt", "content": "12345"})
        self.assertIn("QUOTA", error.exception.status)
        self.assertEqual(self.service.disk_path(self.workspace_id, "first.txt").read_text(), "x")

    def test_resolve_and_write_hold_the_shared_lock(self):
        selection = self.selection()
        original = self.service.folder_create
        def locked_create(user, args):
            self.assertTrue(self.service.lock._is_owned())
            return original(user, args)
        with mock.patch.object(self.service, "folder_create", side_effect=locked_create):
            self.tree.create("folder_create", self.admin, {**selection, "relativePath": "锁内创建"})

    def test_initialize_tree_and_standard_tool(self):
        mcp = MCP(self.service)
        _, response = mcp.dispatch(self.admin, {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2025-11-25", "capabilities": {}, "clientInfo": {"name": "测试客户端"}}})
        result = response["result"]
        self.assertTrue(result["_meta"][TREE_META_KEY]["complete"])
        self.assertIn("directory_tree", result["instructions"])
        self.assertIn("不能证明用户实际点击", result["instructions"])
        _, response = mcp.dispatch(self.admin, {"jsonrpc": "2.0", "id": 2, "method": "tools/call", "params": {
            "name": "directory_tree", "arguments": {}}})
        snapshot = response["result"]["structuredContent"]
        root = next(node for node in snapshot["nodes"] if node["workspaceId"] == self.workspace_id)
        _, response = mcp.dispatch(self.admin, {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "file_write", "arguments": {"treeToken": snapshot["treeToken"], "targetId": root["targetId"],
                                                   "relativePath": "协议.txt", "content": "x"}}})
        self.assertFalse(response["result"]["isError"], response)
        for name in ("file_write", "folder_create", "file_upload"):
            _, response = mcp.dispatch(self.admin, {"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
                "name": name, "arguments": {"workspaceId": self.workspace_id, "path": "绕过.txt"}}})
            self.assertEqual(response["error"]["code"], -32602)


if __name__ == "__main__":
    unittest.main()
