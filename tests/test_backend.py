"""标准库HTTP集成测试，覆盖鉴权、权限、分享和真实资源。"""
import base64
import http.client
import json
import os
import socket
import shutil
import subprocess
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock
from urllib.parse import urlencode, urlsplit

from backend.config import Config
from backend.controller import Application, BASE, COOKIE_NAME
from backend.repository import db_id, now_ms


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class ConfigTests(unittest.TestCase):
    def test_new_install_uses_baba_share_database(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Config(Path(directory))
            self.assertEqual(config.database_path, Path(directory).resolve() / "data" / "baba-share.sqlite3")
            self.assertTrue((config.root / "filedb").is_dir())

    def test_unrelated_database_is_untouched_and_not_selected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "data").mkdir()
            unrelated = root / "data" / "product-share.sqlite3"
            unrelated.write_bytes(b"existing-database")
            config = Config(root)
            self.assertEqual(config.database_path, root.resolve() / "data" / "baba-share.sqlite3")
            self.assertEqual(unrelated.read_bytes(), b"existing-database")
            self.assertFalse(config.database_path.exists())
            config.database_path.write_bytes(b"current-database")
            self.assertEqual(Config(root).database_path.read_bytes(), b"current-database")
            self.assertEqual(unrelated.read_bytes(), b"existing-database")

    def test_origin_validation_and_normalization(self):
        with tempfile.TemporaryDirectory() as directory:
            invalid = ("https://example.com/path", "https://user:secret@example.com", "https://example.com?x=1",
                       "https://example.com#fragment", "ftp://example.com", "https://[::1]", "https://example.com:invalid",
                       "https://example.com:0", "https://example.com:65536", "https://bad host.example")
            for origin in invalid:
                with self.subTest(origin=origin), self.assertRaises(ValueError):
                    Config(Path(directory), public_origin=origin)
            config = Config(Path(directory), public_origin="https://EXAMPLE.COM:443/")
            self.assertEqual(config.public_origin, "https://example.com")
            self.assertFalse(hasattr(config, "preview_origin"))
            self.assertFalse(hasattr(config, "preview_port"))
            with self.assertRaisesRegex(ValueError, "IPv4"):
                Config(Path(directory), host="::")

    def test_dotenv_reads_only_current_prefix(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / ".env").write_text("BABA_SHARE_DATA_DIR=.\nBABA_SHARE_PORT=12080\nBABA_SHARE_PREVIEW_PORT=12081\n", encoding="utf-8")
            with mock.patch("backend.config.__file__", str(project / "backend" / "config.py")), mock.patch.dict(os.environ, {"PRODUCT_SHARE_PORT": "13080"}, clear=True):
                self.assertEqual(Config.from_env().port, 12080)

    def test_new_environment_variables_take_priority(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {
                "BABA_SHARE_DATA_DIR": directory,
                "PRODUCT_SHARE_DATA_DIR": "unused-legacy-directory",
                "BABA_SHARE_PORT": "12080", "PRODUCT_SHARE_PORT": "13080",
                "BABA_SHARE_PREVIEW_PORT": "12081", "PRODUCT_SHARE_PREVIEW_PORT": "13081",
                "BABA_SHARE_SECURE_COOKIE": "1", "PRODUCT_SHARE_SECURE_COOKIE": "0",
            }
            with mock.patch("backend.config.__file__", str(Path(directory) / "backend" / "config.py")), mock.patch.dict(os.environ, environment, clear=True):
                config = Config.from_env()
            self.assertEqual(config.root, Path(directory).resolve())
            self.assertEqual((config.port, config.secure_cookie), (12080, True))

    def test_old_environment_and_preview_settings_are_ignored(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory)
            (project / ".env").write_text("PRODUCT_SHARE_PORT=12080\nBABA_SHARE_PREVIEW_PORT=12081\n", encoding="utf-8")
            environment = {"PRODUCT_SHARE_DATA_DIR": "unused", "PRODUCT_SHARE_PORT": "13080"}
            with mock.patch("backend.config.__file__", str(project / "backend" / "config.py")), mock.patch.dict(os.environ, environment, clear=True):
                config = Config.from_env()
                self.assertNotIn("PRODUCT_SHARE_PREVIEW_PORT", os.environ)
            self.assertEqual(config.root, project.resolve())
            self.assertEqual(config.port, 8080)
            self.assertFalse(hasattr(config, "preview_port"))

    def test_relative_data_dir_and_dotenv_resolve_from_project(self):
        with tempfile.TemporaryDirectory() as directory:
            project = Path(directory).resolve()
            (project / ".env").write_text("BABA_SHARE_DATA_DIR=./isolated\nBABA_SHARE_PORT=12080\nBABA_SHARE_PREVIEW_PORT=12081\n", encoding="utf-8")
            with mock.patch("backend.config.__file__", str(project / "backend" / "config.py")), mock.patch.dict(os.environ, {}, clear=True):
                config = Config.from_env()
            self.assertEqual(config.root, project / "isolated")
            self.assertEqual(config.database_path, project / "isolated" / "data" / "baba-share.sqlite3")
            self.assertEqual(config.port, 12080)


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.port = free_port()
        self.config = Config(Path(self.temporary.name), port=self.port)
        self.app = Application(self.config)
        self.main, = self.app.servers()
        self.threads = [threading.Thread(target=self.main.serve_forever, daemon=True)]
        for thread in self.threads:
            thread.start()
        self.admin, self.admin_cookie = self.setup_admin()

    def tearDown(self):
        for server in (self.main,):
            server.shutdown()
            server.server_close()
        for thread in self.threads:
            thread.join()
        self.temporary.cleanup()

    def request(self, method, route, body=None, cookie="", query=None, origin=True, preview=False):
        port = self.port
        path = route if preview else BASE + route
        if query:
            path += "?" + urlencode(query)
        headers = {}
        if origin:
            headers["Origin"] = self.config.public_origin if origin is True else origin
        if cookie:
            headers["Cookie"] = cookie
        if body is not None:
            headers["Content-Type"] = "application/json"
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        connection.request(method, path, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        data = response.read()
        response_headers = dict(response.getheaders())
        status = response.status
        connection.close()
        if data and response_headers.get("Content-Type", "").startswith("application/json"):
            data = json.loads(data)
        return status, data, response_headers

    def setup_admin(self):
        status, user, headers = self.request("POST", "/visitor/account/setup", {"userName": "admin", "password": "admin-pass-123"})
        self.assertEqual(status, 200)
        return user, headers["Set-Cookie"].split(";", 1)[0]

    def add_user(self, name, role="editor"):
        status, user, _ = self.request("POST", "/user", {"userName": name, "password": "password-123", "role": role}, self.admin_cookie)
        self.assertEqual(status, 200, user)
        status, _, headers = self.request("POST", "/visitor/session", {"userName": name, "password": "password-123"})
        self.assertEqual(status, 200)
        return user, headers["Set-Cookie"].split(";", 1)[0]

    def workspace(self, cookie=None, name="演示空间"):
        status, result, _ = self.request("POST", "/workspace", {"workspaceName": name}, cookie or self.admin_cookie)
        self.assertEqual(status, 200, result)
        return result["id"]

    def invite(self, workspace_id, user, collaborate=False):
        status, result, _ = self.request("POST", "/member", {"workspaceId": workspace_id, "userId": user["id"], "collaborate": collaborate}, self.admin_cookie)
        self.assertEqual(status, 200, result)

    def write(self, workspace_id, path, content="<h1>页面</h1>", cookie=None):
        return self.request("PUT", "/file/content", {"workspaceId": workspace_id, "path": path, "content": content}, cookie or self.admin_cookie)

    def test_setup_registration_and_cookie(self):
        status, detail, _ = self.request("GET", "/visitor/install/detail", origin=False)
        self.assertEqual((status, detail), (200, {"setupRequired": False, "registrationEnabled": False}))
        status, _, _ = self.request("POST", "/visitor/account/setup", {"userName": "other", "password": "password-123"})
        self.assertEqual(status, 409)
        status, _, _ = self.request("POST", "/visitor/account/registration", {"userName": "signup", "password": "password-123", "role": "admin"})
        self.assertEqual(status, 403)
        self.request("PATCH", "/setting", {"registrationEnabled": True}, self.admin_cookie)
        status, user, headers = self.request("POST", "/visitor/account/registration", {"userName": "signup", "password": "password-123", "role": "admin"})
        self.assertEqual(status, 200)
        self.assertEqual(user["role"], "viewer")
        cookie = headers["Set-Cookie"]
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=Strict", cookie)
        self.assertIn("Path=" + BASE, cookie)
        self.assertNotIn("password", user)

    def test_login_logout_disable_and_last_admin(self):
        status, result, _ = self.request("POST", "/visitor/session", {"userName": "admin", "password": "bad"})
        self.assertEqual(status, 401)
        self.assertEqual(set(result), {"code", "msg", "status"})
        status, _, _ = self.request("PATCH", "/user", {"id": self.admin["id"], "role": "viewer"}, self.admin_cookie)
        self.assertEqual(status, 409)
        user, cookie = self.add_user("editor")
        self.request("PATCH", "/user", {"id": user["id"], "isDisabled": True}, self.admin_cookie)
        self.assertEqual(self.request("GET", "/session/detail", cookie=cookie)[0], 401)
        status, _, headers = self.request("DELETE", "/session", cookie=self.admin_cookie)
        self.assertEqual(status, 200)
        self.assertIn("Max-Age=0", headers["Set-Cookie"])
        self.assertEqual(self.request("GET", "/session/detail", cookie=self.admin_cookie)[0], 401)

    def test_origin_csrf_and_preview_has_no_api(self):
        for origin in (False, "null", "http://evil.example"):
            status, result, _ = self.request("POST", "/workspace", {"workspaceName": "blocked"}, self.admin_cookie, origin=origin)
            self.assertEqual(status, 403, result)
        status, _, _ = self.request("GET", "/session/detail", cookie=self.admin_cookie, origin="null")
        self.assertEqual(status, 403)
        status, _, _ = self.request("GET", "/baba-share/preview/api/session/detail", cookie=self.admin_cookie, preview=True)
        self.assertEqual(status, 404)
        status, _, _ = self.request("GET", "/session/detail", cookie=self.admin_cookie, origin=False)
        self.assertEqual(status, 200)

    def test_repeated_invalid_origin_body_returns_complete_error(self):
        for index in range(20):
            status, result, headers = self.request("POST", "/workspace", {"workspaceName": "blocked-" + str(index), "description": "x" * 8192}, self.admin_cookie, origin="null")
            self.assertEqual(status, 403)
            self.assertEqual(result["status"], "ORIGIN_DENIED")
            self.assertEqual(headers["Connection"], "close")
        self.assertEqual(self.request("GET", "/workspace/list", cookie=self.admin_cookie)[1], [])

    def test_preview_directory_redirect_preserves_relative_resources(self):
        workspace_id, share = self.create_site_share()
        self.write(workspace_id, "site/subdir/home.html", "<link href='style.css' rel='stylesheet'>")
        self.write(workspace_id, "site/subdir/style.css", "body{color:blue}")
        root = "/baba-share/preview/s/" + share["token"] + "/"
        status, _, headers = self.request("GET", root + "subdir", preview=True, origin=False)
        self.assertEqual(status, 307)
        self.assertEqual(headers["Location"], root + "subdir/")
        status, raw, _ = self.request("GET", headers["Location"], preview=True, origin=False)
        self.assertEqual(status, 200)
        self.assertIn(b"style.css", raw)
        self.assertEqual(self.request("GET", root + "subdir/style.css", preview=True, origin=False)[0], 200)
        self.assertEqual(self.request("GET", "/assets/style.css", preview=True, origin=False)[0], 404)

    def test_share_directory_pagination_and_preview_base(self):
        workspace_id, share = self.create_site_share()
        for index in range(25):
            self.write(workspace_id, "site/page-" + str(index).zfill(2) + ".html")
        status, detail, _ = self.request("GET", "/visitor/share/detail", query={"token": share["token"], "pageIndex": 2, "pageSize": 10})
        self.assertEqual(status, 200)
        listing = detail["listing"]
        self.assertEqual((listing["pageIndex"], listing["pageSize"], len(listing["entries"])), (2, 10, 10))
        self.assertEqual(listing["entryPath"], "INDEX.HTML")
        self.assertEqual(listing["data"], listing["entries"])
        self.assertTrue(detail["previewBaseUrl"].endswith("/baba-share/preview/s/" + share["token"] + "/"))

    def test_node_search_and_sort_apply_before_sql_pagination(self):
        workspace_id = self.workspace()
        for name, content in (("Alpha.txt", "a"), ("alpha-two.txt", "aa"), ("Beta.txt", "bbb"), ("Gamma.txt", "gggg")):
            self.write(workspace_id, name, content)
        query = {"workspaceId": workspace_id, "pageIndex": 2, "pageSize": 1, "search": "ALPHA"}
        status, listing, _ = self.request("GET", "/node/list", cookie=self.admin_cookie, query=query)
        self.assertEqual(status, 200)
        self.assertEqual(listing["totalCount"], 2)
        self.assertEqual(listing["entries"][0]["name"], "Alpha.txt")
        query.update({"search": "", "sort": "size", "order": "desc"})
        status, listing, _ = self.request("GET", "/node/list", cookie=self.admin_cookie, query=query)
        self.assertEqual(status, 200)
        self.assertEqual(listing["entries"][0]["name"], "Beta.txt")
        self.app.service.repo.execute("UPDATE workspace_node SET update_time=? WHERE workspace_id=? AND node_path=?", (now_ms() + 99999, db_id(workspace_id), "Alpha.txt"))
        query.update({"pageIndex": 1, "sort": "updateTime"})
        self.assertEqual(self.request("GET", "/node/list", cookie=self.admin_cookie, query=query)[1]["entries"][0]["name"], "Alpha.txt")
        query.update({"sort": "name", "search": "%"})
        self.assertEqual(self.request("GET", "/node/list", cookie=self.admin_cookie, query=query)[1]["totalCount"], 0)
        query["sort"] = "node_path; DROP TABLE sys_user"
        self.assertEqual(self.request("GET", "/node/list", cookie=self.admin_cookie, query=query)[0], 400)

    def test_workspace_roles_membership_and_admin_authority(self):
        editor, editor_cookie = self.add_user("editor")
        viewer, viewer_cookie = self.add_user("viewer", "viewer")
        workspace_id = self.workspace(editor_cookie)
        self.assertEqual(self.request("POST", "/workspace", {"workspaceName": "no"}, viewer_cookie)[0], 403)
        self.assertEqual(self.request("GET", "/node/list", cookie=viewer_cookie, query={"workspaceId": workspace_id})[0], 403)
        self.invite(workspace_id, viewer, True)
        self.assertEqual(self.request("GET", "/node/list", cookie=viewer_cookie, query={"workspaceId": workspace_id})[0], 200)
        self.assertEqual(self.write(workspace_id, "no.html", cookie=viewer_cookie)[0], 403)
        self.assertEqual(self.request("POST", "/share", {"workspaceId": workspace_id}, viewer_cookie)[0], 403)
        self.assertEqual(self.request("GET", "/user/list", cookie=editor_cookie)[0], 403)
        self.assertEqual(self.write(workspace_id, "admin.html")[0], 200)
        self.assertEqual(self.request("PATCH", "/workspace", {"id": workspace_id, "workspaceName": "管理改名"}, self.admin_cookie)[0], 200)

    def test_noncollaborator_cannot_change_foreign_descendants(self):
        editor, cookie = self.add_user("editor")
        workspace_id = self.workspace()
        self.invite(workspace_id, editor)
        self.assertEqual(self.write(workspace_id, "mixed/admin.html")[0], 200)
        self.assertEqual(self.write(workspace_id, "mixed/mine.html", cookie=cookie)[0], 200)
        self.assertEqual(self.write(workspace_id, "mixed/admin.html", cookie=cookie)[0], 403)
        status, _, _ = self.request("DELETE", "/folder", cookie=cookie, query={"workspaceId": workspace_id, "path": "mixed"})
        self.assertEqual(status, 403)
        status, _, _ = self.request("PATCH", "/folder", {"workspaceId": workspace_id, "path": "mixed", "newPath": "moved"}, cookie)
        self.assertEqual(status, 403)
        self.assertEqual(self.request("DELETE", "/file", cookie=cookie, query={"workspaceId": workspace_id, "path": "mixed/mine.html"})[0], 200)
        self.invite(workspace_id, editor, True)
        self.assertEqual(self.write(workspace_id, "mixed/admin.html", cookie=cookie)[0], 200)
        self.assertEqual(self.request("PATCH", "/folder", {"workspaceId": workspace_id, "path": "mixed", "newPath": "moved"}, cookie)[0], 200)
        self.assertTrue((self.config.root / "filedb" / workspace_id / "moved/admin.html").is_file())

    @unittest.skipUnless(__import__("os").name == "nt", "仅Windows大小写不敏感文件系统适用")
    def test_case_alias_cannot_bypass_file_ownership(self):
        editor, cookie = self.add_user("editor")
        workspace_id = self.workspace()
        self.invite(workspace_id, editor)
        self.assertEqual(self.write(workspace_id, "Folder/Owned.html")[0], 200)
        self.assertEqual(self.write(workspace_id, "folder/owned.html", cookie=cookie)[0], 409)
        payload = {"workspaceId": workspace_id, "files": [
            {"path": "A.html", "contentBase64": "YQ=="},
            {"path": "a.html", "contentBase64": "Yg=="}]}
        self.assertEqual(self.request("POST", "/file/upload", payload, cookie)[0], 400)
        self.assertEqual((self.config.root / "filedb" / workspace_id / "Folder/Owned.html").read_text(encoding="utf-8"), "<h1>页面</h1>")

    def test_directory_upload_real_hierarchy_text_and_idempotency(self):
        workspace_id = self.workspace()
        payload = {"workspaceId": workspace_id, "path": "site", "files": [
            {"path": path, "contentBase64": base64.b64encode(content.encode()).decode()}
            for path, content in [("deep/INDEX.HTML", "<h1>入口</h1>"), ("deep/assets/style.css", "h1{color:red}")]]}
        for _ in range(2):
            self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[0], 200)
        disk = self.config.root / "filedb" / workspace_id
        self.assertEqual((disk / "site/deep/assets/style.css").read_text(), "h1{color:red}")
        status, listing, _ = self.request("GET", "/node/list", cookie=self.admin_cookie, query={"workspaceId": workspace_id, "path": "site/deep"})
        self.assertEqual(status, 200)
        self.assertEqual(listing["entryPath"], "site/deep/INDEX.HTML")
        self.assertEqual(len(listing["entries"]), 2)
        status, text, _ = self.request("GET", "/file/content", cookie=self.admin_cookie, query={"workspaceId": workspace_id, "path": "site/deep/INDEX.HTML"})
        self.assertEqual((status, text["content"]), (200, "<h1>入口</h1>"))
        self.assertEqual(self.request("POST", "/workspace", {"workspaceName": "演示空间"}, self.admin_cookie)[1]["id"], workspace_id)

    def test_upload_default_ask_preflights_entire_batch_without_writes(self):
        workspace = self.workspace()
        self.write(workspace, "existing.txt", "original")
        disk = self.config.root / "filedb" / workspace
        before_nodes = self.app.service.repo.nodes(workspace)
        payload = {"workspaceId": workspace, "files": [
            {"path": "new/deep.txt", "contentBase64": "bmV3"},
            {"path": "existing.txt", "contentBase64": "Y2hhbmdlZA=="}]}
        status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual(status, 200)
        self.assertTrue(result["requiresConfirmation"])
        self.assertEqual(result["conflicts"], [{"path": "existing.txt"}])
        self.assertEqual((result["count"], result["files"]), (0, []))
        self.assertEqual((disk / "existing.txt").read_text(), "original")
        self.assertFalse((disk / "new").exists())
        self.assertEqual(before_nodes, self.app.service.repo.nodes(workspace))
        again = self.request("POST", "/file/upload", payload, self.admin_cookie)[1]
        self.assertTrue(again["requiresConfirmation"])
        self.assertEqual((again["count"], again["files"]), (0, []))
        self.assertFalse((disk / "new").exists())
        payload["conflictPolicy"] = "overwrite"
        status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["count"], result["requiresConfirmation"]), (200, 2, False))
        self.assertEqual(result["files"][1], {"sourcePath": "existing.txt", "targetPath": "existing.txt", "overwritten": True})
        self.assertEqual((disk / "existing.txt").read_text(), "changed")
        self.assertEqual((disk / "new/deep.txt").read_text(), "new")

    def test_upload_rename_timestamp_sequences_and_persistent_retry(self):
        workspace = self.workspace()
        self.write(workspace, "site/index.html", "original")
        self.write(workspace, "site/index_1793376000123.html", "occupied")
        payload = {"workspaceId": workspace, "path": "site", "conflictPolicy": "rename",
                   "requestId": "rename-request-0001", "files": [
                       {"path": "index.html", "contentBase64": "bmV3"},
                       {"path": "assets/app.js", "contentBase64": "anM="}]}
        with mock.patch("backend.service.now_ms", return_value=1793376000123):
            status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual(status, 200, result)
        self.assertEqual(result["uploadTime"], 1793376000123)
        self.assertEqual([x["targetPath"] for x in result["files"]],
                         ["site/index_1793376000123_1.html", "site/assets/app.js"])
        self.assertTrue(all(not item["overwritten"] for item in result["files"]))
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[1], result)
        restarted = Application(self.config)
        user = restarted.service.repo.user(self.admin["id"])
        self.assertEqual(restarted.service.upload(user, payload), result)
        disk = self.config.root / "filedb" / workspace
        self.assertEqual((disk / "site/index.html").read_text(), "original")
        self.assertEqual((disk / "site/index_1793376000123.html").read_text(), "occupied")
        self.assertEqual((disk / "site/index_1793376000123_1.html").read_text(), "new")
        payload["files"][0]["contentBase64"] = "YmFk"
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[1]["status"], "REQUEST_CONFLICT")
        payload.pop("requestId")
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[0], 400)

    def test_upload_all_policies_respect_foreign_ownership_and_viewer(self):
        editor, cookie = self.add_user("upload-editor")
        viewer, view_cookie = self.add_user("upload-viewer", "viewer")
        workspace = self.workspace()
        self.invite(workspace, editor)
        self.invite(workspace, viewer, True)
        self.write(workspace, "owned.txt", "owner")
        for policy in ("ask", "overwrite", "rename"):
            payload = {"workspaceId": workspace, "conflictPolicy": policy, "requestId": "permission-test-001", "files": [
                {"path": "new/first.txt", "contentBase64": "bmV3"},
                {"path": "owned.txt", "contentBase64": "bmV3"}]}
            self.assertEqual(self.request("POST", "/file/upload", payload, cookie)[1]["status"], "FOREIGN_CONTENT")
            self.assertEqual(self.request("POST", "/file/upload", payload, view_cookie)[1]["status"], "READ_ONLY")
            self.assertFalse((self.config.root / "filedb" / workspace / "new").exists())
        self.invite(workspace, editor, True)
        self.assertEqual(self.request("POST", "/file/upload", payload, cookie)[1]["count"], 2)

    def test_upload_type_invalid_and_batch_case_conflicts_never_write(self):
        workspace = self.workspace()
        self.write(workspace, "file.txt", "original")
        self.request("POST", "/folder", {"workspaceId": workspace, "path": "folder"}, self.admin_cookie)
        for policy in ("ask", "overwrite", "rename"):
            for bad in ("folder", "file.txt/child.txt"):
                payload = {"workspaceId": workspace, "conflictPolicy": policy, "requestId": "type-test-request-1", "files": [
                    {"path": "new/first.txt", "contentBase64": "bmV3"},
                    {"path": bad, "contentBase64": "bmV3"}]}
                status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
                self.assertEqual((status, result["status"]), (409, "PATH_CONFLICT"))
                self.assertFalse((self.config.root / "filedb" / workspace / "new").exists())
        for policy in (None, True, [], "replace"):
            payload = {"workspaceId": workspace, "conflictPolicy": policy, "files": [{"path": "new.txt", "contentBase64": "bmV3"}]}
            self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[0], 400)
        if os.name == "nt":
            for policy in ("ask", "overwrite", "rename"):
                for names in (("FILE.txt",), ("New/a.txt", "new/b.txt"), ("A", "a/b")):
                    payload = {"workspaceId": workspace, "conflictPolicy": policy, "requestId": "case-conflict-0001",
                               "files": [{"path": name, "contentBase64": "bmV3"} for name in names]}
                    self.assertIn(self.request("POST", "/file/upload", payload, self.admin_cookie)[0], (400, 409))
        self.assertEqual((self.config.root / "filedb" / workspace / "file.txt").read_text(), "original")

    def test_upload_concurrent_ask_and_rename_do_not_overwrite(self):
        from concurrent.futures import ThreadPoolExecutor
        workspace = self.workspace()
        payload = {"workspaceId": workspace, "files": [{"path": "same.txt", "contentBase64": "bmV3"}]}
        with ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda _: self.request("POST", "/file/upload", payload, self.admin_cookie)[1], range(6)))
        self.assertEqual(sum(item["count"] for item in results), 1)
        self.assertEqual(sum(item["requiresConfirmation"] for item in results), 5)
        def rename(index):
            return self.request("POST", "/file/upload", {**payload, "conflictPolicy": "rename", "requestId": "parallel-rename-" + str(index).zfill(3)}, self.admin_cookie)[1]
        with mock.patch("backend.service.now_ms", return_value=1793376000123), ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(rename, range(6)))
        targets = [item["files"][0]["targetPath"] for item in results]
        self.assertEqual(len(set(targets)), 6)
        self.assertEqual(len(list((self.config.root / "filedb" / workspace).iterdir())), 7)

    def test_upload_batch_body_limit_and_count_never_partially_write(self):
        workspace = self.workspace()
        payload = {"workspaceId": workspace, "files": [{"path": "new/file.txt", "contentBase64": "YQ=="}] * 501}
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[0], 400)
        self.config.max_body_bytes = 180
        payload["files"] = [{"path": "new/file.txt", "contentBase64": base64.b64encode(b"x" * 200).decode()}]
        status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["status"]), (413, "PAYLOAD_TOO_LARGE"))
        self.assertFalse((self.config.root / "filedb" / workspace / "new").exists())
        self.assertEqual(self.app.service.repo.nodes(workspace), [])

    def test_upload_replace_failure_restores_files_nodes_and_retry(self):
        workspace = self.workspace()
        self.write(workspace, "one.txt", "original-one")
        self.write(workspace, "two.txt", "original-two")
        disk = self.config.root / "filedb" / workspace
        for policy in ("overwrite", "rename"):
            before = self.app.service.repo.nodes(workspace)
            payload = {"workspaceId": workspace, "conflictPolicy": policy, "requestId": "replace-failure-" + policy,
                       "files": [{"path": "one.txt", "contentBase64": "bmV3"},
                                 {"path": "new/deep.txt", "contentBase64": "bmV3"},
                                 {"path": "two.txt", "contentBase64": "bmV3"}]}
            actual_replace, calls = os.replace, []
            def fail_second(source, target):
                calls.append(str(source))
                if len(calls) == 2:
                    raise OSError("模拟第二个文件替换失败")
                return actual_replace(source, target)
            with mock.patch("backend.service.os.replace", side_effect=fail_second):
                status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
            self.assertEqual((status, result["status"]), (400, "STORAGE_ERROR"))
            self.assertEqual(before, self.app.service.repo.nodes(workspace))
            self.assertEqual((disk / "one.txt").read_text(), "original-one")
            self.assertEqual((disk / "two.txt").read_text(), "original-two")
            self.assertFalse((disk / "new").exists())
            self.assertEqual(sorted(x.name for x in disk.iterdir()), ["one.txt", "two.txt"])
            self.assertIsNone(self.app.service.repo.one("SELECT id FROM upload_request WHERE request_id=?", (payload["requestId"],)))
            self.assertFalse(list((self.config.root / "filedb").glob(".upload-*")))
        status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["count"]), (200, 3))
        self.assertEqual(len(list(disk.glob("one_*.txt"))), 1)
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[1], result)

    def test_upload_idempotency_insert_failure_rolls_back_batch(self):
        from contextlib import contextmanager
        workspace = self.workspace()
        self.write(workspace, "one.txt", "original")
        disk = self.config.root / "filedb" / workspace
        before = self.app.service.repo.nodes(workspace)
        payload = {"workspaceId": workspace, "conflictPolicy": "rename", "requestId": "insert-failure-0001", "files": [
            {"path": "one.txt", "contentBase64": "bmV3"}, {"path": "new/deep.txt", "contentBase64": "bmV3"}]}
        original_connection = self.app.service.repo.connection
        class FailingConnection:
            def __init__(self, connection):
                self.connection = connection
            def execute(self, sql, args=()):
                if sql.startswith("INSERT INTO upload_request"):
                    raise __import__("sqlite3").IntegrityError("模拟幂等记录写入失败")
                return self.connection.execute(sql, args)
            def commit(self):
                return self.connection.commit()
            def rollback(self):
                return self.connection.rollback()
        @contextmanager
        def connection():
            with original_connection() as current:
                yield FailingConnection(current)
        with mock.patch.object(self.app.service.repo, "connection", connection):
            status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["status"]), (409, "RESOURCE_CONFLICT"))
        self.assertEqual(before, self.app.service.repo.nodes(workspace))
        self.assertEqual((disk / "one.txt").read_text(), "original")
        self.assertEqual([item.name for item in disk.iterdir()], ["one.txt"])
        self.assertIsNone(self.app.service.repo.one("SELECT id FROM upload_request WHERE request_id=?", (payload["requestId"],)))
        status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["count"]), (200, 2))
        self.assertEqual(len(list(disk.glob("one_*.txt"))), 1)
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[1], result)

    def test_upload_recovery_failure_retains_backup_and_continues_other_files(self):
        workspace = self.workspace()
        for name in ("one.txt", "two.txt", "three.txt"):
            self.write(workspace, name, "original-" + name)
        disk = self.config.root / "filedb" / workspace
        payload = {"workspaceId": workspace, "conflictPolicy": "overwrite", "requestId": "recovery-failure-01", "files": [
            {"path": name, "contentBase64": "bmV3"} for name in ("one.txt", "two.txt", "three.txt")]}
        actual_replace, calls = os.replace, []
        def fail(source, target):
            calls.append((Path(source).name, Path(target).name))
            if Path(source).name in ("2.new", "1.old"):
                raise OSError("模拟替换及首项恢复失败")
            return actual_replace(source, target)
        with self.assertLogs("baba-share", level="ERROR") as captured, mock.patch("backend.service.os.replace", side_effect=fail):
            status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["status"]), (500, "UPLOAD_RECOVERY_REQUIRED"))
        self.assertIn(("0.old", "one.txt"), calls)
        self.assertEqual((disk / "one.txt").read_text(), "original-one.txt")
        retained = list((self.config.root / "filedb").glob(".upload-*"))
        self.assertEqual(len(retained), 1)
        self.assertEqual((retained[0] / "1.old").read_text(), "original-two.txt")
        self.assertIn(str(retained[0]).replace("\\", "\\\\"), "".join(captured.output))
        self.assertNotIn("original-two.txt", "".join(captured.output))
        self.assertIsNone(self.app.service.repo.one("SELECT id FROM upload_request WHERE request_id=?", (payload["requestId"],)))

    def test_upload_rollback_failure_still_restores_files_and_retains_staging(self):
        from contextlib import contextmanager
        workspace = self.workspace()
        self.write(workspace, "one.txt", "original")
        payload = {"workspaceId": workspace, "conflictPolicy": "overwrite", "requestId": "rollback-failure-01", "files": [
            {"path": "one.txt", "contentBase64": "bmV3"}, {"path": "new/deep.txt", "contentBase64": "bmV3"}]}
        original_connection = self.app.service.repo.connection
        class BrokenRollback:
            def __init__(self, current):
                self.current = current
            def execute(self, sql, args=()):
                if sql.startswith("INSERT INTO upload_request"):
                    raise OSError("模拟写入失败")
                return self.current.execute(sql, args)
            def commit(self):
                self.current.commit()
            def rollback(self):
                raise OSError("模拟rollback失败")
        @contextmanager
        def connection():
            with original_connection() as current:
                yield BrokenRollback(current)
        with self.assertLogs("baba-share", level="ERROR"), mock.patch.object(self.app.service.repo, "connection", connection):
            status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["status"]), (500, "UPLOAD_RECOVERY_REQUIRED"))
        disk = self.config.root / "filedb" / workspace
        self.assertEqual((disk / "one.txt").read_text(), "original")
        self.assertFalse((disk / "new").exists())
        self.assertEqual(len(list((self.config.root / "filedb").glob(".upload-*"))), 1)
        self.assertIsNone(self.app.service.repo.one("SELECT id FROM upload_request WHERE request_id=?", (payload["requestId"],)))

    def test_upload_committed_cleanup_failure_is_warning_not_failure(self):
        workspace = self.workspace()
        payload = {"workspaceId": workspace, "conflictPolicy": "rename", "requestId": "cleanup-failure-01",
                   "files": [{"path": "one.txt", "contentBase64": "bmV3"}]}
        with self.assertLogs("baba-share", level="WARNING"), mock.patch("backend.service.shutil.rmtree", side_effect=OSError("模拟清理失败")):
            status, result, _ = self.request("POST", "/file/upload", payload, self.admin_cookie)
        self.assertEqual((status, result["count"]), (200, 1))
        self.assertEqual((self.config.root / "filedb" / workspace / "one.txt").read_text(), "new")
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[1], result)
        self.assertEqual(len(list((self.config.root / "filedb").glob(".upload-*"))), 1)

    def test_upload_cross_service_same_id_user_isolation_and_replay_permissions(self):
        from concurrent.futures import ThreadPoolExecutor
        from backend.service import BizError
        workspace = self.workspace()
        editor, cookie = self.add_user("replay-editor")
        self.invite(workspace, editor, True)
        self.write(workspace, "one.txt", "original")
        services = [Application(self.config).service for _ in range(4)]
        user = services[0].repo.user(editor["id"])
        payload = {"workspaceId": workspace, "conflictPolicy": "rename", "requestId": "shared-service-id-01", "files": [
            {"path": "one.txt", "contentBase64": "bmV3"}]}
        with ThreadPoolExecutor(max_workers=8) as pool:
            results = list(pool.map(lambda index: services[index % 4].upload(user, payload), range(8)))
        self.assertTrue(all(item == results[0] for item in results))
        disk = self.config.root / "filedb" / workspace
        self.assertEqual(len(list(disk.glob("one_*.txt"))), 1)
        self.assertEqual(self.app.service.repo.one("SELECT count(*) AS request_count FROM upload_request")["request_count"], 1)
        admin_result = services[0].upload(self.app.service.repo.user(self.admin["id"]), payload)
        self.assertNotEqual(results[0]["files"], admin_result["files"])
        self.assertEqual(len(list(disk.glob("one_*.txt"))), 2)
        self.invite(workspace, editor, False)
        with self.assertRaises(BizError) as raised:
            services[0].upload(user, payload)
        self.assertEqual(raised.exception.status, "FOREIGN_CONTENT")
        self.invite(workspace, editor, True)
        self.app.service.change_user(self.app.service.repo.user(self.admin["id"]), {"id": editor["id"], "role": "viewer"})
        with self.assertRaises(BizError) as raised:
            services[0].upload(user, payload)
        self.assertEqual(raised.exception.status, "READ_ONLY")
        self.app.service.change_user(self.app.service.repo.user(self.admin["id"]), {"id": editor["id"], "isDisabled": True})
        with self.assertRaises(BizError) as raised:
            services[0].upload(user, payload)
        self.assertEqual(raised.exception.status, "AUTH_REQUIRED")

    @unittest.skipUnless(shutil.which("node"), "前端上传流程实际执行需要Node.js")
    def test_frontend_upload_conflict_confirmation_and_cancel(self):
        workspace = self.workspace()
        self.write(workspace, "site/index.html", "original")
        script = r'''
const fs=require('fs'),vm=require('vm'),assert=require('assert'),input=JSON.parse(fs.readFileSync(0,'utf8'));
class Node {
 constructor(tag,attrs={}){this.tag=tag;this.attrs=attrs;this.children=[];this.events={};this.style={};this.value=attrs.value||'';this.textContent=attrs.text||'';this.classList={add(){},remove(){}};this.parentElement=this;}
 append(...nodes){this.children.push(...nodes.filter(x=>x!=null));}replaceChildren(...nodes){this.children=[];this.append(...nodes);}
 get lastChild(){return this.children.at(-1);}setAttribute(k,v){this.attrs[k]=v;}addEventListener(k,f){this.events[k]=f;}focus(){}click(){}
}
const nodes=new Map(),$=s=>{if(!nodes.has(s))nodes.set(s,new Node('div'));return nodes.get(s);};
const el=(tag,attrs,...children)=>{const n=new Node(tag,attrs);n.append(...children);return n;};
const flatten=n=>n instanceof Node?[n,...n.children.flatMap(flatten)]:[];
let choice=null,uploads=[],dialogs=[],notices=[],readHook=null;
const button=(key,fn)=>{const n=el('button',{text:key});n.fn=fn;return n;};
const context={console,URL,AbortController,crypto:require('crypto').webcrypto,Date,location:new URL(input.origin+'/baba-share/workspace.html'),history:{replaceState(){}},
 document:{documentElement:{lang:'zh-CN',dir:'ltr',dataset:{mode:'dark'}},querySelectorAll:()=>[],createTextNode:t=>t},
 FileReader:class{readAsDataURL(file){if(readHook){const hook=readHook;readHook=null;hook();}this.result='data:;base64,'+Buffer.from(file.content).toString('base64');this.onload();}},
 LocalPager:()=>({pageIndex:1,pageSize:20,reset(){},accept:()=>true,busy(){}}),addEventListener(){},
 UI:{$,el,button,icon:()=>el('svg'),empty:()=>el('div'),date:String,toast:t=>notices.push(t),formDialog(){},errorText:e=>e.status||String(e),page:()=>({ready:Promise.resolve()}),
 dialog:(title,build)=>{let resolve;const result=new Promise(r=>resolve=r),node=el('dialog');const close=value=>resolve(value);build(node,close);dialogs.push(node);if(choice)flatten(node).find(x=>x.textContent===choice).fn();else close(null);return{result,close};}},
 API:async(name,options={})=>{if(name==='me')return{id:'admin',role:'admin'};if(name==='workspaces')return[];if(name==='members')return[];if(name==='nodes')return{entries:[],pageIndex:1,pageSize:20,totalCount:0,totalPage:0};if(name!=='upload')throw Error(name);uploads.push(JSON.parse(JSON.stringify(options.body)));const response=await fetch(input.origin+'/api/baba-share/core/v1/file/upload',{method:'POST',headers:{Cookie:input.cookie,Origin:input.origin,'Content-Type':'application/json'},body:JSON.stringify(options.body)});const value=await response.json();if(!response.ok)throw value;return value;}};
context.window=context;vm.createContext(context);
vm.runInContext(fs.readFileSync(input.assets+'/i18n.js','utf8'),context);
let source=fs.readFileSync(input.assets+'/workspace.js','utf8');
source=source.replace('  await page.ready;', '  window.uploadTest={uploadFiles,selectWorkspace,setWorkspace(value){workspace=value;path="site";},setWorkspaces(value){workspaces=value;},setAlways(value){alwaysOverwrite=value;},getAlways(){return alwaysOverwrite;}};\n  await page.ready;');
(async()=>{await vm.runInContext(source,context);context.uploadTest.setWorkspace({id:input.workspace,canWrite:true});
 const files=[{name:'index.html',content:'new'},{name:'script.js',content:'script'}];
 for(const locale of ['zh-CN','en-US','ar-SA']){context.I18n.apply({locale,theme:'dark'});assert.notEqual(context.I18n.t('uploadConflictTitle'),context.I18n.t('unknownError'));assert(context.I18n.t('mcpUploadConflict').includes('requiresConfirmation'));}
 $('#upload-input').value='retained-selection';$('#directory-input').value='retained-directory';
 await context.uploadTest.uploadFiles(files);assert.equal($('#upload-input').value,'retained-selection');assert.equal($('#directory-input').value,'retained-directory');assert.equal(uploads.length,1);assert.equal(uploads[0].conflictPolicy,'ask');assert.equal(uploads[0].files.length,2);assert.equal(notices.length,0);assert(flatten(dialogs[0]).some(n=>n.textContent==='site/index.html'));
 choice='uploadKeepBoth';await context.uploadTest.uploadFiles(files);assert.equal(uploads.length,3);assert.equal(uploads[2].conflictPolicy,'rename');assert.equal(uploads[1].requestId,uploads[2].requestId);
 choice='uploadOverwrite';await context.uploadTest.uploadFiles(files);assert.equal(uploads.length,5);assert.equal(uploads[4].conflictPolicy,'overwrite');
 context.uploadTest.setAlways(true);await context.uploadTest.uploadFiles(files);assert.equal(uploads.length,6);assert.equal(uploads[5].conflictPolicy,'overwrite');assert.equal($('#upload-input').value,'');
 context.uploadTest.setAlways(false);choice=null;readHook=()=>context.uploadTest.setAlways(true);await context.uploadTest.uploadFiles(files);assert.equal(uploads.length,7);assert.equal(uploads[6].conflictPolicy,'ask');
 context.uploadTest.setWorkspaces([{id:input.workspace,canWrite:true,workspaceName:'first'},{id:'other-space',canWrite:true,workspaceName:'other'}]);
 await context.uploadTest.selectWorkspace('other-space');assert.equal(context.uploadTest.getAlways(),false);assert.equal(flatten($('#file-actions')).find(n=>n.attrs.id==='upload-always-overwrite').checked,false);
 context.uploadTest.setWorkspace({id:input.workspace,canWrite:true});context.uploadTest.setAlways(true);readHook=()=>{context.uploadTest.selectWorkspace('other-space');};await context.uploadTest.uploadFiles(files);assert.equal(uploads.length,8);assert.equal(uploads[7].workspaceId,input.workspace);assert.equal(uploads[7].path,'site');assert.equal(uploads[7].conflictPolicy,'overwrite');
 process.stdout.write('取消零重试、保留两份和覆盖策略及三语实际执行通过');
})().catch(e=>{console.error(e);process.exit(1);});
'''
        result = subprocess.run(["node", "-e", script], input=json.dumps({"origin": self.config.public_origin,
                                "cookie": self.admin_cookie, "workspace": workspace,
                                "assets": str(self.config.web_dir / "assets")}), capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        disk = self.config.root / "filedb" / workspace / "site"
        self.assertEqual((disk / "index.html").read_text(), "new")
        self.assertEqual(len(list(disk.glob("index_*.html"))), 1)
        self.assertTrue((disk / "script.js").exists())

    def test_paths_traversal_and_conflicting_upload(self):
        workspace_id = self.workspace()
        for path in ("../outside", "/absolute", "a/../../bad", "a\\bad", "a//b", "a/./b", "C:/file", "NUL.html", "a/b. "):
            self.assertEqual(self.write(workspace_id, path)[0], 400, path)
        payload = {"workspaceId": workspace_id, "files": [
            {"path": "a", "contentBase64": "YQ=="}, {"path": "a/b", "contentBase64": "Yg=="}]}
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[0], 400)
        self.assertFalse((self.config.root / "filedb" / workspace_id / "a").exists())
        payload["files"] = [{"path": "a", "contentBase64": "not-base64"}]
        self.assertEqual(self.request("POST", "/file/upload", payload, self.admin_cookie)[0], 400)

    def test_symlink_protection(self):
        workspace_id = self.workspace()
        outside = self.config.root / "outside"
        outside.mkdir()
        (outside / "secret.html").write_text("private")
        link = self.config.root / "filedb" / workspace_id / "link"
        try:
            link.symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("当前系统未开放创建符号链接权限")
        self.assertEqual(self.write(workspace_id, "link/secret.html")[0], 403)
        self.assertEqual(self.request("GET", "/node/list", cookie=self.admin_cookie, query={"workspaceId": workspace_id})[0], 403)
        self.assertEqual((outside / "secret.html").read_text(), "private")

    def create_site_share(self):
        workspace_id = self.workspace()
        self.write(workspace_id, "site/home.html", "home")
        self.write(workspace_id, "site/INDEX.HTML", '<link rel="stylesheet" href="assets/site.css"><script src="assets/app.js"></script><img src="assets/logo.svg">')
        self.write(workspace_id, "site/assets/site.css", "body{color:red}")
        self.write(workspace_id, "site/assets/app.js", "document.body.dataset.loaded='yes'")
        self.write(workspace_id, "site/assets/logo.svg", '<svg xmlns="http://www.w3.org/2000/svg"/>')
        self.write(workspace_id, "private.html", "secret")
        status, share, _ = self.request("POST", "/share", {"workspaceId": workspace_id, "path": "site", "expireHours": 1}, self.admin_cookie)
        self.assertEqual(status, 200, share)
        return workspace_id, share

    def test_share_anonymous_index_resources_and_revocation(self):
        workspace_id, share = self.create_site_share()
        self.assertEqual(share["shareUrl"], self.config.public_origin + "/baba-share/s/" + share["token"])
        status, detail, _ = self.request("GET", "/visitor/share/detail", query={"token": share["token"]}, origin=False)
        self.assertEqual(status, 200, detail)
        self.assertEqual(detail["listing"]["entryPath"], "INDEX.HTML")
        self.assertNotIn("workspaceId", detail["share"])
        resource_root = "/baba-share/preview/s/" + share["token"] + "/"
        for path in ("", "INDEX.HTML", "assets/site.css", "assets/app.js", "assets/logo.svg"):
            status, raw, headers = self.request("GET", resource_root + path, preview=True, origin=False)
            self.assertEqual(status, 200, path)
            self.assertIn("sandbox allow-scripts", headers["Content-Security-Policy"])
            self.assertNotIn("allow-same-origin", headers["Content-Security-Policy"])
            self.assertNotIn("Set-Cookie", headers)
        for path in ("../private.html", "%2e%2e/private.html", "%2e%2e%2fprivate.html", "%5cprivate.html"):
            self.assertEqual(self.request("GET", resource_root + path, preview=True, origin=False)[0], 400)
        self.assertEqual(self.request("DELETE", "/share", cookie=self.admin_cookie, query={"id": share["id"]})[0], 200)
        self.assertEqual(self.request("GET", "/visitor/share/detail", query={"token": share["token"]})[0], 404)
        self.assertEqual(self.request("GET", resource_root + "assets/site.css", preview=True)[0], 404)

    def test_share_expiry_and_current_permission_recheck(self):
        workspace_id, share = self.create_site_share()
        self.app.service.repo.execute("UPDATE folder_share SET expire_time=? WHERE id=?", (now_ms() - 1, db_id(share["id"])))
        self.assertEqual(self.request("GET", "/visitor/share/detail", query={"token": share["token"]})[0], 404)
        self.assertEqual(self.request("GET", "/baba-share/preview/s/" + share["token"] + "/INDEX.HTML", preview=True)[0], 404)
        editor, cookie = self.add_user("editor")
        self.invite(workspace_id, editor)
        _, shared, _ = self.request("POST", "/share", {"workspaceId": workspace_id, "path": "site"}, cookie)
        self.request("DELETE", "/member", cookie=self.admin_cookie, query={"workspaceId": workspace_id, "userId": editor["id"]})
        self.assertEqual(self.request("GET", "/baba-share/preview/s/" + shared["token"] + "/assets/app.js", preview=True)[0], 404)

    def test_preview_ticket_expiry_permission_and_resource_isolation(self):
        workspace_id, _ = self.create_site_share()
        editor, cookie = self.add_user("editor")
        self.invite(workspace_id, editor)
        status, ticket, _ = self.request("POST", "/preview/ticket", {"workspaceId": workspace_id, "path": "site"}, cookie)
        self.assertEqual(status, 200)
        path = urlsplit(ticket["previewUrl"]).path
        self.assertTrue(path.endswith("/INDEX.HTML"))
        self.assertEqual(self.request("GET", path, preview=True)[0], 200)
        root = path.rsplit("/", 1)[0] + "/"
        self.assertEqual(self.request("GET", root + "assets/app.js", preview=True)[0], 200)
        self.assertEqual(self.request("GET", root + "../private.html", preview=True)[0], 400)
        self.request("PATCH", "/user", {"id": editor["id"], "isDisabled": True}, self.admin_cookie)
        self.assertEqual(self.request("GET", root + "assets/app.js", preview=True)[0], 404)
        _, admin_ticket, _ = self.request("POST", "/preview/ticket", {"workspaceId": workspace_id, "path": "site"}, self.admin_cookie)
        self.app.service.repo.execute("UPDATE preview_ticket SET expire_time=? WHERE expire_time>?", (now_ms() - 1, now_ms()))
        self.assertEqual(self.request("GET", urlsplit(admin_ticket["previewUrl"]).path, preview=True)[0], 404)

    def test_move_delete_invalidate_shares_and_metadata(self):
        workspace_id, share = self.create_site_share()
        status, _, _ = self.request("PATCH", "/folder", {"workspaceId": workspace_id, "path": "site", "newPath": "nested/moved"}, self.admin_cookie)
        self.assertEqual(status, 200)
        self.assertEqual(self.request("GET", "/visitor/share/detail", query={"token": share["token"]})[0], 404)
        self.assertEqual(self.request("GET", "/file/content", cookie=self.admin_cookie, query={"workspaceId": workspace_id, "path": "nested/moved/INDEX.HTML"})[0], 200)
        self.assertEqual(self.request("DELETE", "/folder", cookie=self.admin_cookie, query={"workspaceId": workspace_id, "path": "nested"})[0], 200)
        self.assertFalse((self.config.root / "filedb" / workspace_id / "nested").exists())
        self.assertEqual(len(self.app.service.repo.nodes(workspace_id)), 1)
        self.assertEqual(self.request("DELETE", "/workspace", cookie=self.admin_cookie, query={"id": workspace_id})[0], 200)
        self.assertEqual(self.request("GET", "/workspace/list", cookie=self.admin_cookie)[1], [])

    def test_invalid_json_and_parameter_errors_have_uniform_envelope(self):
        for route, body in (("/workspace", {}), ("/user", {"userName": "bad", "password": "short"}), ("/folder", {"workspaceId": "not-a-uuid", "path": "test"})):
            status, data, _ = self.request("POST", route, body, self.admin_cookie)
            self.assertEqual(status, 400, data)
            self.assertEqual(set(data), {"code", "msg", "status"})
        self.assertEqual(self.request("GET", "/workspace/list")[0], 401)


if __name__ == "__main__":
    unittest.main()
