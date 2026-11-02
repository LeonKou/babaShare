"""Office静态引擎策略与上传HTML沙箱互不放宽。"""
import http.client
import importlib.util
import io
import json
import zipfile
import socket
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.config import Config
from backend.controller import Application


class OfficeInstallerTests(unittest.TestCase):
    def setUp(self):
        script = Path(__file__).resolve().parents[1] / "scripts/install-office-assets.py"
        spec = importlib.util.spec_from_file_location("office_installer", script)
        self.installer = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.installer)

    def test_patch_requires_exactly_one_match(self):
        self.assertEqual(self.installer.replace_once("before old after", "old", "new"), "before new after")
        for text in ("no match", "old old"):
            with self.assertRaises(ValueError):
                self.installer.replace_once(text, "old", "new")

    def test_source_archive_contains_direct_dependencies_and_actual_patched_api(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "LICENSE.txt").write_text("license", encoding="utf-8")
            (destination / "api.js").write_text("patched source", encoding="utf-8")
            (destination / "build-manifest.json").write_text(json.dumps({"patchedFiles": ["api.js"]}), encoding="utf-8")
            self.installer.package_source(source, destination)
            with zipfile.ZipFile(destination / "upstream-source.zip") as bundle:
                for name in ("i18n.js", "boot.js", "tokens.css", "components.css"):
                    archived = bundle.read("baba-share-integration/web/assets/" + name)
                    local = (Path(__file__).resolve().parents[1] / "web/assets" / name).read_bytes()
                    self.assertEqual(archived, local)
                self.assertEqual(bundle.read("baba-share-integration/web/vendor/office/api.js"), b"patched source")

    def test_source_archive_sanitizes_only_workbook_absolute_path_metadata(self):
        workbook = (b'<workbook xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac">'
                    b'<x15ac:absPath url="file:///synthetic-private-directory/"/>'
                    b'<sheets><sheet name="example" sheetId="1"/></sheets></workbook>')
        retained = {"xl/worksheets/sheet1.xml": b'<worksheet><sheetData/></worksheet>',
                    "docProps/core.xml": b'<coreProperties><creator>Example author</creator></coreProperties>',
                    "[Content_Types].xml": b'<Types/>', "xl/media/image1.png": b"synthetic binary"}
        original = io.BytesIO()
        with zipfile.ZipFile(original, "w", zipfile.ZIP_DEFLATED) as bundle:
            bundle.comment = b"preserve archive comment"
            bundle.writestr("xl/workbook.xml", workbook)
            for name, content in retained.items():
                bundle.writestr(name, content)
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            source.mkdir()
            destination.mkdir()
            sample = source / "example.xlsx"
            sample.write_bytes(original.getvalue())
            self.installer.package_source(source, destination)
            with zipfile.ZipFile(destination / "upstream-source.zip") as archive:
                sanitized = archive.read("office-website/example.xlsx")
            with zipfile.ZipFile(io.BytesIO(sanitized)) as bundle:
                self.assertEqual(bundle.comment, b"preserve archive comment")
                self.assertEqual(set(bundle.namelist()), {"xl/workbook.xml", *retained})
                self.assertEqual(bundle.read("xl/workbook.xml"), workbook.replace(
                    b'<x15ac:absPath url="file:///synthetic-private-directory/"/>', b""))
                for name, content in retained.items():
                    self.assertEqual(bundle.read(name), content)
            self.assertEqual(sample.read_bytes(), original.getvalue())
            self.assertEqual(self.installer.sanitize_source_member("example.xlsx", sanitized), sanitized)
            self.assertEqual(self.installer.sanitize_source_member("example.txt", original.getvalue()),
                             original.getvalue())

    def test_source_archive_excludes_secrets_runtime_data_and_local_caches(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            source.mkdir()
            destination.mkdir()
            allowed = ("LICENSE.txt", "README.md", ".env.example", "utils/editor/server.ts",
                       "src/editor.js", "src/.env.example", "public/x2t-1/x2t.js", "schema.sql")
            excluded = (
                ".env", ".env.local", ".env.production", "src/.ENV.LOCAL", ".env.example.bak",
                "certs/private.pem", "certs/private.key", "certs/certificate.p12", "certs/certificate.pfx",
                "id_rsa", "id_ed25519", ".npmrc", ".netrc", "credentials.json",
                "state.db", "state.sqlite", "state.sqlite3", "state.db-wal", "state.sqlite3-shm",
                ".git/config", ".workbuddy/session.json", "nested/.git/config", ".ssh/config",
                ".aws/credentials", ".cache/cache.json", "node_modules/package/index.js",
                ".next/cache.json", "__pycache__/module.pyc", ".venv/config.json",
                "data/example.json", "filedb/document.txt", "logs/server.log", "uploads/document.txt",
                "tmp/cached.json", "backups/state.json", "secrets/settings.json",
            )
            for name in allowed + excluded:
                path = source / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("temporary fixture", encoding="utf-8")
            self.installer.package_source(source, destination)
            with zipfile.ZipFile(destination / "upstream-source.zip") as bundle:
                upstream = {name.removeprefix("office-website/") for name in bundle.namelist()
                            if name.startswith("office-website/")}
                self.assertEqual(upstream, set(allowed))

    def test_source_archive_rejects_links_before_opening_archive(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "linked-file.ts").write_text("temporary fixture", encoding="utf-8")
            (source / "linked-directory").mkdir()
            # 无创建符号链接权限的 Windows 上也必须执行拒绝分支。
            for link_type in ("is_symlink", "is_junction"):
                for linked in (source, source / "linked-file.ts", source / "linked-directory"):
                    with self.subTest(link_type=link_type, linked=linked.name):
                        with patch.object(Path, link_type, lambda path: path == linked):
                            with self.assertRaisesRegex(ValueError, "符号链接或目录联接"):
                                self.installer.package_source(source, destination)
                        self.assertFalse((destination / "upstream-source.zip").exists())

    def test_source_archive_does_not_read_through_real_symlinks(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            source.mkdir()
            destination.mkdir()
            outside = root / "outside"
            outside.mkdir()
            (outside / "private.txt").write_text("temporary fixture", encoding="utf-8")
            link = source / "linked-directory"
            try:
                link.symlink_to(outside, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("当前环境无创建符号链接权限")
            with self.assertRaisesRegex(ValueError, "符号链接或目录联接"):
                self.installer.package_source(source, destination)
            self.assertFalse((destination / "upstream-source.zip").exists())


class OfficePreviewTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        with socket.socket() as socket_probe:
            socket_probe.bind(("127.0.0.1", 0))
            self.port = socket_probe.getsockname()[1]
        self.app = Application(Config(Path(self.temporary.name), host="127.0.0.1", port=self.port))
        self.server, = self.app.servers()
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temporary.cleanup()

    def request(self, path):
        client = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        client.request("GET", path)
        response = client.getresponse()
        raw, headers, status = response.read(), dict(response.getheaders()), response.status
        client.close()
        return status, raw, headers

    def test_trusted_viewer_has_wasm_policy_but_normal_pages_do_not(self):
        status, _, headers = self.request("/baba-share/preview-office.html")
        self.assertEqual(status, 200)
        self.assertIn("'unsafe-eval'", headers["Content-Security-Policy"])
        self.assertIn("base-uri 'self'", headers["Content-Security-Policy"])
        _, _, headers = self.request("/baba-share/workspace.html")
        self.assertNotIn("'unsafe-eval'", headers["Content-Security-Policy"])
        self.assertIn("base-uri 'none'", headers["Content-Security-Policy"])

    def test_upload_html_error_keeps_opaque_sandbox(self):
        status, _, headers = self.request("/baba-share/preview/s/invalid/index.html")
        self.assertEqual(status, 404)
        policy = headers["Content-Security-Policy"]
        self.assertTrue(policy.startswith("sandbox allow-scripts;"))
        self.assertNotIn("allow-same-origin", policy)
        self.assertIn("connect-src 'none'", policy)
        self.assertNotIn("Set-Cookie", headers)

    def test_brotli_converter_has_correct_content_encoding_and_mime(self):
        status, raw, headers = self.request("/baba-share/vendor/office/x2t-1/x2t.js")
        self.assertEqual(status, 200)
        self.assertGreater(len(raw), 1000)
        self.assertEqual(headers.get("Content-Encoding"), "br")
        self.assertEqual(headers.get("Vary"), "Accept-Encoding")
        self.assertEqual(headers["Content-Type"], "application/javascript; charset=utf-8")

    def test_local_api_source_and_license_available_with_no_cookies(self):
        for path in ("LICENSE", "build-manifest.json", "v9.3.0.24-1/web-apps/apps/api/documents/api.js"):
            status, _, headers = self.request("/baba-share/vendor/office/" + path)
            self.assertEqual(status, 200, path)
            self.assertNotIn("Set-Cookie", headers)
