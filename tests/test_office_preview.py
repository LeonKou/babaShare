"""Office静态引擎策略与上传HTML沙箱互不放宽。"""
import hashlib
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

    def test_desktop_patches_match_fixed_release_and_reject_drift(self):
        root = Path(__file__).resolve().parents[1] / "web/vendor/office/v9.3.0.24-1/web-apps/apps"
        for editor in ("documenteditor", "spreadsheeteditor", "presentationeditor"):
            with self.subTest(editor=editor):
                html = (root / editor / "main/index.html").read_text(encoding="utf-8")
                app = (root / editor / "main/app.js").read_text(encoding="utf-8")
                self.assertIn("require(['app']);", html)
                self.assertNotIn("require(['ie/app'])", html)
                self.assertNotIn("fix-ie-compat.js", html)
                self.assertIn('"' + editor + '/main/code"', app)
                self.assertNotIn("/main/ie/code", app)
                with self.assertRaises(ValueError):
                    self.installer.patch_desktop_entry(html)
                with self.assertRaises(ValueError):
                    self.installer.patch_desktop_app(app, editor)

    def make_release_fixture(self, root):
        source = root / "source"
        source.mkdir()
        for name, content in {
            "LICENSE.txt": b"synthetic upstream license",
            "utils/editor/server.ts": b"synthetic upstream source",
            "public/x2t-1/x2t.js": b"synthetic converter script",
            "public/x2t-1/x2t.wasm": b"synthetic converter binary",
            "public/x2t-1/x2t.js.map": b"excluded converter map",
            "public/x2t-1/nested/debug.MAP": b"excluded nested converter map",
            "public/x2t-1/runtime.map/dependency.js": b"synthetic runtime dependency",
            "public/x2t-1/_headers": b"synthetic converter headers",
            "public/x2t-1/ThirdPartyNotices.txt": b"synthetic converter notices",
        }.items():
            path = source / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
        engine = "v9.3.0.24-1/"
        api = (b'// TODO: check message origin\n_scope.frameOrigin==msg.origin\n'
               b'wnd.postMessage(msg, "*", [buffer])\n'
               b'wnd.postMessage(window.JSON.stringify(msg), "*")\n'
               b'iframe.setAttribute("allow", "autoplay; camera; microphone; display-capture; clipboard-write;");')
        retained = {
            engine + "web-apps/apps/api/documents/api.js": api,
            engine + "web-apps/apps/documenteditor/main/ie/ThirdPartyNotices.txt": b"synthetic legal notice",
            engine + "fonts/arial.ttf": b"synthetic font",
            engine + "fonts/LICENSE.txt": b"synthetic font license",
            engine + "sdkjs/common/src/runtime.js": b"synthetic SDK dependency",
            engine + "sdkjs/word/sdk-all.js": b"synthetic SDK bundle",
            engine + "sdkjs/LICENSE": b"synthetic SDK license",
            engine + "web-apps/vendor/monaco/ThirdPartyNotices.txt": b"synthetic vendor notices",
            engine + "web-apps/apps/common/main/resources/images/icon.png": b"synthetic UI image",
            engine + "web-apps/apps/common/main/resources/help/en/Contents.json": b"[]",
            engine + "web-apps/apps/common/main/resources/help/en/LICENSE.txt": b"synthetic help license",
            engine + "web-apps/apps/common/main/resources/help/NOTICE.html": b"synthetic help notice",
            engine + "web-apps/apps/common/main/resources/help/COPYING": b"synthetic help terms",
            engine + "web-apps/apps/common/main/resources/help/COPYRIGHT": b"synthetic help attribution",
        }
        excluded = {
            "release.MAP": b"excluded top-level map",
            engine + "sdkjs/word/sdk-all.js.map": b"excluded SDK map",
            engine + "fonts/debug.map": b"excluded font map",
            engine + "web-apps/apps/common/main/resources/help/en/guide.html": b"excluded help page",
            engine + "web-apps/apps/common/main/resources/help/en/images/guide.png": b"excluded help image",
            engine + "web-apps/apps/common/main/resources/help/LICENSE.txt.map": b"excluded notice map",
        }
        for editor in ("documenteditor", "spreadsheeteditor", "presentationeditor"):
            app = engine + "web-apps/apps/" + editor + "/"
            retained.update({
                app + "main/index.html": (
                    '<html><head><base href="https://office-editor.ziziyi.com/"></head><script>\n'
                    '        isIEBrowser === true &&\n'
                    '            (document.write(\'<script src="../../common/main/lib/util/fix-ie-compat.js"><\\/script>\'),\n'
                    '            document.write(\'<script src="../../../../sdkjs/vendor/string.js"><\\/script>\'));\n'
                    "isIEBrowser === true ? require(['ie/app']) : require(['app']);\n"
                    '</script></html>'
                ).encode(),
                app + "main/app.css": b"synthetic desktop CSS",
                app + "main/locale/zh.json": b'{"test":"zh"}',
                app + "main/locale/en.json": b'{"test":"en"}',
                app + "main/locale/ar.json": b'{"test":"ar"}',
                app + "main/resources/css/rtl.css": b"synthetic RTL CSS",
                app + "main/app.js": ('const t=window.isIEBrowser?"' + editor + '/main/ie/code":"'
                                       + editor + '/main/code";').encode(),
                app + "main/resources/help/en/Contents.json": b"[]",
                app + "main/resources/help/licensing-notice.txt": b"synthetic help licensing notice",
                app + "mobile/index.html": b"<html><head></head></html>",
                app + "mobile/dist/js/app.js": b"synthetic mobile JS",
                app + "mobile/dist/js/app.js.LICENSE.txt": b"synthetic mobile license",
            })
            excluded.update({
                app + "main/ie/app.js": b"excluded IE app bundle",
                app + "main/ie/code.js": b"excluded IE SDK loader",
                app + "main/app.js.map": b"excluded desktop map",
                app + "main/app.css.map": b"excluded CSS map",
                app + "main/resources/help/en/guide.html": b"excluded editor help",
                app + "main/resources/help/en/images/guide.svg": b"excluded editor help image",
                app + "mobile/dist/js/app.js.map": b"excluded mobile map",
            })
        archive = root / "release.zip"
        with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
            for name, content in {**retained, **excluded}.items():
                bundle.writestr("release/" + name, content)
        return archive, source, retained, excluded

    def install_fixture(self, archive, source, destination, source_output=None):
        converter_hashes = {name: hashlib.sha256((source / "public/x2t-1" / name).read_bytes()).hexdigest()
                            for name in ("x2t.js", "x2t.wasm")}
        with patch.object(self.installer, "ARCHIVE_SIZE", archive.stat().st_size), \
                patch.object(self.installer, "ARCHIVE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest()), \
                patch.object(self.installer, "CONVERTER_SHA256", converter_hashes):
            self.installer.install(archive, source, destination, source_output)

    def test_default_install_filters_before_reading_and_preserves_runtime_dependencies(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, source, retained, excluded = self.make_release_fixture(root)
            destination = root / "runtime"
            original_open = zipfile.ZipFile.open
            opened_members = []

            def open_member(bundle, member, *args, **kwargs):
                name = member.filename if isinstance(member, zipfile.ZipInfo) else member
                opened_members.append(name)
                return original_open(bundle, member, *args, **kwargs)

            with patch.object(zipfile.ZipFile, "open", open_member), \
                    patch.object(self.installer, "package_source") as package_source:
                self.install_fixture(archive, source, destination)
            package_source.assert_not_called()
            self.assertTrue(opened_members)
            self.assertFalse(set(opened_members) & {"release/" + name for name in excluded})
            engine = "v9.3.0.24-1/"
            patched = {engine + "web-apps/apps/api/documents/api.js"}
            for editor in ("documenteditor", "spreadsheeteditor", "presentationeditor"):
                name = engine + "web-apps/apps/" + editor + "/main/index.html"
                patched.add(name)
                patched.add(engine + "web-apps/apps/" + editor + "/main/app.js")
                app_text = (destination / (engine + "web-apps/apps/" + editor + "/main/app.js")).read_text(encoding="utf-8")
                self.assertIn('"' + editor + '/main/code"', app_text)
                self.assertNotIn("/main/ie/code", app_text)
                html = (destination / name).read_text(encoding="utf-8")
                self.assertIn(self.installer.BRIDGE, html)
                self.assertIn(self.installer.RESOURCE_ROOT, html)
                self.assertIn("require(['app']);", html)
                self.assertNotIn("require(['ie/app'])", html)
                self.assertNotIn("fix-ie-compat.js", html)
                self.assertNotIn("sdkjs/vendor/string.js", html)
            for name, content in retained.items():
                with self.subTest(retained=name):
                    self.assertTrue((destination / name).is_file())
                    if name not in patched:
                        self.assertEqual((destination / name).read_bytes(), content)
            for name in excluded:
                with self.subTest(excluded=name):
                    self.assertFalse((destination / name).exists())
            for name in ("x2t.js", "x2t.wasm", "_headers", "ThirdPartyNotices.txt", "runtime.map/dependency.js"):
                self.assertEqual((destination / "x2t-1" / name).read_bytes(),
                                 (source / "public/x2t-1" / name).read_bytes())
            self.assertEqual((destination / "LICENSE").read_bytes(), (source / "LICENSE.txt").read_bytes())
            runtime_files = {path.relative_to(destination).as_posix()
                             for path in destination.rglob("*") if path.is_file()}
            self.assertEqual(runtime_files, {*retained, "LICENSE", "build-manifest.json",
                                            *("x2t-1/" + name for name in
                                              ("x2t.js", "x2t.wasm", "_headers", "ThirdPartyNotices.txt",
                                               "runtime.map/dependency.js"))})
            self.assertFalse(list(destination.rglob("*.zip")))
            manifest = json.loads((destination / "build-manifest.json").read_text(encoding="utf-8"))
            self.assertIsNone(manifest["sourceArchive"])
            self.assertEqual(manifest["sourceCommit"], self.installer.SOURCE_COMMIT)
            self.assertEqual(manifest["sourceRepository"], manifest["repository"])
            self.assertIn("--source-output", manifest["sourcePublication"])
            self.assertIn("不表示对应源码已对外发布", manifest["sourcePublication"])
            self.assertEqual(set(manifest["patchedFiles"]), patched)
            repeated = root / "repeated-runtime"
            self.install_fixture(archive, source, repeated)
            for name in runtime_files:
                self.assertEqual((destination / name).read_bytes(), (repeated / name).read_bytes(), name)

    def test_explicit_source_output_is_separate_and_contains_corresponding_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            archive, source, _, _ = self.make_release_fixture(root)
            destination, output = root / "runtime", root / "publication/source"
            self.install_fixture(archive, source, destination, output)
            self.assertFalse(list(destination.rglob("*.zip")))
            with zipfile.ZipFile(output / "upstream-source.zip") as bundle:
                manifest = json.loads(bundle.read("baba-share-integration/build-manifest.json"))
                self.assertIsNone(manifest["sourceArchive"])
                self.assertEqual(bundle.read("office-website/utils/editor/server.ts"),
                                 (source / "utils/editor/server.ts").read_bytes())
                for name in manifest["patchedFiles"]:
                    self.assertEqual(bundle.read("baba-share-integration/web/vendor/office/" + name),
                                     (destination / name).read_bytes())

    def test_source_output_rejects_runtime_directory_and_descendants_before_install(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination = root / "runtime"
            for output in (destination, destination / "source", destination / "nested/../source"):
                with self.subTest(output=output):
                    with self.assertRaisesRegex(ValueError, "源码输出目录不得"):
                        self.installer.install(root / "missing.zip", root / "source", destination, output)
                    with self.assertRaisesRegex(ValueError, "源码输出目录不得"):
                        self.installer.package_source(root / "source", destination, output)
                    self.assertFalse(destination.exists())

    def test_source_output_rejects_resolved_alias_into_runtime(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            destination, alias = root / "runtime", root / "alias"
            destination.mkdir()
            try:
                alias.symlink_to(destination, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("当前环境无创建符号链接权限")
            with self.assertRaisesRegex(ValueError, "源码输出目录不得"):
                self.installer.package_source(root / "source", destination, alias / "source")
            self.assertFalse(list(destination.iterdir()))

    def test_existing_source_archive_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination, output = root / "source", root / "runtime", root / "publication"
            source.mkdir()
            output.mkdir()
            archive = output / "upstream-source.zip"
            archive.write_bytes(b"existing source archive")
            with self.assertRaisesRegex(ValueError, "源码输出文件已存在"):
                self.installer.install(root / "missing.zip", source, destination, output)
            with self.assertRaises(FileExistsError):
                self.installer.package_source(source, destination, output)
            self.assertEqual(archive.read_bytes(), b"existing source archive")
            self.assertFalse(destination.exists())

    def test_runtime_filter_is_limited_to_maps_app_help_and_six_fixed_ie_bundles(self):
        for name in ("fonts/src/font.ttf", "sdkjs/common/src/dependency.js",
                     "web-apps/apps/documenteditor/mobile/dist/js/app.js",
                     "web-apps/apps/documenteditor/embed/index.html",
                     "v9.3.0.24-1/web-apps/apps/visioeditor/main/ie/app.js",
                     "v9.3.0.24-1/web-apps/apps/pdfeditor/main/ie/code.js",
                     "v9.3.0.24-1/web-apps/apps/documenteditor/main/ie/unknown.js",
                     "v9.3.0.24-2/web-apps/apps/documenteditor/main/ie/app.js",
                     "v9.3.0.24-1/sdkjs/visio/sdk-all.js",
                     "v9.3.0.24-1/web-apps/apps/documenteditor/main/ie/ThirdPartyNotices.txt",
                     "other/resources/help/guide.html", "web-apps/vendor/resources/help/guide.html",
                     "web-apps/apps/common/main/resources/helpful/guide.html",
                     "web-apps/apps/common/main/resources/help/en/Contents.json",
                     "web-apps/apps/common/main/resources/help/en/ThirdPartyNotices.txt",
                     "web-apps/apps/common/main/resources/help/en/LICENCE.md"):
            with self.subTest(retained=name):
                self.assertTrue(self.installer.include_runtime_member(name))
        for name in ("app.js.map", "APP.CSS.MAP",
                     "v9.3.0.24-1/web-apps/apps/documenteditor/main/ie/app.js",
                     "v9.3.0.24-1/web-apps/apps/documenteditor/main/ie/code.js",
                     "v9.3.0.24-1/web-apps/apps/spreadsheeteditor/main/ie/app.js",
                     "v9.3.0.24-1/web-apps/apps/spreadsheeteditor/main/ie/code.js",
                     "v9.3.0.24-1/web-apps/apps/presentationeditor/main/ie/app.js",
                     "v9.3.0.24-1/web-apps/apps/presentationeditor/main/ie/code.js",
                     "web-apps/apps/common/main/resources/help/en/guide.html",
                     "web-apps/apps/common/main/resources/help/en/images/icon.png"):
            with self.subTest(excluded=name):
                self.assertFalse(self.installer.include_runtime_member(name))

    def test_desktop_patch_rejects_missing_or_duplicate_release_markers(self):
        with tempfile.TemporaryDirectory() as temporary:
            _, _, retained, _ = self.make_release_fixture(Path(temporary))
            for editor in ("documenteditor", "spreadsheeteditor", "presentationeditor"):
                prefix = "v9.3.0.24-1/web-apps/apps/" + editor + "/main/"
                html, app = (retained[prefix + name].decode() for name in ("index.html", "app.js"))
                for text in ("", html + html):
                    with self.subTest(editor=editor, marker="html", count=bool(text)):
                        with self.assertRaises(ValueError):
                            self.installer.patch_desktop_entry(text)
                for text in ("", app + app):
                    with self.subTest(editor=editor, marker="app", count=bool(text)):
                        with self.assertRaises(ValueError):
                            self.installer.patch_desktop_app(text, editor)

    def test_source_archive_contains_direct_dependencies_and_actual_patched_api(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source, destination = root / "source", root / "destination"
            source.mkdir()
            destination.mkdir()
            (source / "LICENSE.txt").write_text("license", encoding="utf-8")
            (destination / "api.js").write_text("patched source", encoding="utf-8")
            (destination / "build-manifest.json").write_text(json.dumps({"patchedFiles": ["api.js"]}), encoding="utf-8")
            self.installer.package_source(source, destination, root / "source-output")
            with zipfile.ZipFile(root / "source-output/upstream-source.zip") as bundle:
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
            self.installer.package_source(source, destination, root / "source-output")
            with zipfile.ZipFile(root / "source-output/upstream-source.zip") as archive:
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
            self.installer.package_source(source, destination, root / "source-output")
            with zipfile.ZipFile(root / "source-output/upstream-source.zip") as bundle:
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
                                self.installer.package_source(source, destination, root / "source-output")
                        self.assertFalse((root / "source-output/upstream-source.zip").exists())

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
                self.installer.package_source(source, destination, root / "source-output")
            self.assertFalse((root / "source-output/upstream-source.zip").exists())


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
