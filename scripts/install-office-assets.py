"""校验并安装固定发行的 Office 静态依赖，仅使用 Python 标准库。"""
import argparse
import hashlib
import io
import json
import os
import re
import shutil
import zipfile
from pathlib import Path

VERSION = "v9.3.0.24"
SOURCE_COMMIT = "02befd843ff32257a3d796d9e0d8d77914f8886f"
ARCHIVE_SIZE = 606149075
ARCHIVE_SHA256 = "0b91dcd9772d46effc7512681e4b5d1a41322dd06c6063c5bd21f509f1daf69b"
CONVERTER_SHA256 = {"x2t.js": "9710cc63098b20529d65f26ccfd6fc3b3c36c808220fb47728fcc70287d0daa9",
                    "x2t.wasm": "b15914a9cad355734503417a3b1e313971de73760ec34f5e698104250cbd023a"}
RESOURCE_ROOT = "/baba-share/vendor/office/"
BRIDGE = '<script src="/baba-share/assets/preview-office-engine.js"></script>'


def replace_once(text, old, new):
    if text.count(old) != 1:
        raise ValueError("固定发行补丁匹配数量不符：" + old)
    return text.replace(old, new, 1)


def sanitize_source_member(name, content):
    if Path(name).suffix.lower() not in {".xlsx", ".xlsm", ".xltx", ".xltm"}:
        return content
    with zipfile.ZipFile(io.BytesIO(content)) as original:
        if "xl/workbook.xml" not in original.namelist():
            return content
        workbook = original.read("xl/workbook.xml")
        # 仅删除保存位置元数据，不重序列化 XML，保留工作表和其他属性原文。
        sanitized = re.sub(
            rb'''<(?:[A-Za-z_][\w.-]*:)?absPath\b(?:[^>"']|"[^"]*"|'[^']*')*/\s*>''',
            b"", workbook,
        )
        if sanitized == workbook:
            return content
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as cleaned:
            cleaned.comment = original.comment
            for member in original.infolist():
                data = sanitized if member.filename == "xl/workbook.xml" else original.read(member)
                cleaned.writestr(member, data)
        return output.getvalue()


def validate_source_output(destination, source_output):
    if source_output.resolve().is_relative_to(destination.resolve()):
        raise ValueError("源码输出目录不得位于 destination 运行目录内")


def include_runtime_member(name):
    path = Path(name)
    if path.suffix.lower() == ".map":
        return False
    parts = path.parts
    # 仅固定发行的六个 IE 独立 bundle；不吞掉同目录的法律通知或未知依赖。
    if (len(parts) == 7 and parts[0] == "v9.3.0.24-1"
            and parts[1:3] == ("web-apps", "apps")
            and parts[3] in {"documenteditor", "spreadsheeteditor", "presentationeditor"}
            and parts[4:6] == ("main", "ie") and parts[6] in {"app.js", "code.js"}):
        return False
    # 只裁剪 web-apps/apps 下的帮助目录，不按 src/mobile 等名字推测运行依赖。
    for index in range(len(parts) - 2):
        if parts[index:index + 2] == ("web-apps", "apps"):
            for help_index in range(index + 3, len(parts) - 1):
                if parts[help_index:help_index + 2] == ("resources", "help"):
                    return path.name == "Contents.json" or bool(re.search(
                        r"licen[cs]|notice|copying|copyright", path.name, re.IGNORECASE))
    return True


def patch_desktop_entry(text):
    text = replace_once(
        text,
        """        isIEBrowser === true &&
            (document.write('<script src=\"../../common/main/lib/util/fix-ie-compat.js\"><\\/script>'),
            document.write('<script src=\"../../../../sdkjs/vendor/string.js\"><\\/script>'));
""",
        "",
    )
    text = replace_once(text, "isIEBrowser === true ? require(['ie/app']) : require(['app']);",
                        "require(['app']);")
    return text


def patch_desktop_app(text, editor):
    return replace_once(text, 'window.isIEBrowser?"' + editor + '/main/ie/code":"' + editor + '/main/code"',
                        '"' + editor + '/main/code"')


def package_source(source, destination, source_output, manifest=None):
    validate_source_output(destination, source_output)
    project = Path(__file__).resolve().parents[1]
    excluded_directories = {
        ".git", ".workbuddy", ".claude", ".codex", ".cursor", ".idea", ".vscode",
        ".ssh", ".aws", ".azure", ".config", ".cache", ".next", ".nuxt",
        ".venv", "venv", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache",
        ".ruff_cache", "coverage", ".nyc_output", "data", "filedb", "logs", "uploads",
        "tmp", "temp", "backups", "secrets",
    }
    excluded_names = {".npmrc", ".pypirc", ".netrc", "credentials.json", "credentials", ".ds_store"}
    excluded_suffixes = {".pem", ".key", ".p12", ".pfx", ".jks", ".keystore", ".db",
                         ".sqlite", ".sqlite3", ".log", ".pyc", ".pyo", ".bak", ".dump"}
    if source.is_symlink() or source.is_junction():
        raise ValueError("源码目录不能是符号链接或目录联接")
    source_files = []
    for directory, directories, files in os.walk(source, followlinks=False):
        for name in directories + files:
            path = Path(directory) / name
            if path.is_symlink() or path.is_junction():
                raise ValueError("源码包含符号链接或目录联接：" + path.relative_to(source).as_posix())
        # 在遍历前剪枝，避免读取个人环境与运行数据目录。
        directories[:] = [name for name in directories if name.lower() not in excluded_directories]
        for name in files:
            path = Path(directory) / name
            lower = name.lower()
            if (lower in excluded_names or lower in excluded_directories
                    or (lower.startswith(".env") and lower != ".env.example")
                    or lower.startswith(("id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"))
                    or path.suffix.lower() in excluded_suffixes
                    or lower.endswith((".db-wal", ".db-shm", ".db-journal", ".sqlite-wal",
                                       ".sqlite-shm", ".sqlite-journal", ".sqlite3-wal",
                                       ".sqlite3-shm", ".sqlite3-journal"))):
                continue
            if path.is_file():
                source_files.append(path)
    source_output.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source_output / "upstream-source.zip", "x", zipfile.ZIP_DEFLATED) as bundle:
        for path in source_files:
            archive_name = "office-website/" + path.relative_to(source).as_posix()
            if path.suffix.lower() in {".xlsx", ".xlsm", ".xltx", ".xltm"}:
                bundle.writestr(zipfile.ZipInfo.from_file(path, archive_name),
                                sanitize_source_member(archive_name, path.read_bytes()),
                                compress_type=zipfile.ZIP_DEFLATED)
            else:
                bundle.write(path, archive_name)
        for name in ("scripts/install-office-assets.py", "web/preview-office.html", "web/assets/preview-office.js",
                     "web/assets/preview-office-engine.js", "web/assets/preview-office-worker.js",
                     "web/assets/preview.js", "web/assets/preview.css", "web/assets/i18n.js",
                     "web/assets/boot.js", "web/assets/tokens.css", "web/assets/components.css", "backend/controller.py"):
            bundle.write(project / name, "baba-share-integration/" + name)
        manifest_path = destination / "build-manifest.json"
        if manifest is None and manifest_path.is_file():
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        if manifest is not None:
            bundle.writestr("baba-share-integration/build-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
            for name in manifest["patchedFiles"]:
                bundle.write(destination / name, "baba-share-integration/web/vendor/office/" + name)


def install(archive, source, destination, source_output=None):
    if source_output is not None:
        validate_source_output(destination, source_output)
        if (source_output / "upstream-source.zip").exists():
            raise ValueError("源码输出文件已存在，拒绝覆盖")
    if archive.stat().st_size != ARCHIVE_SIZE:
        raise ValueError("Office 发行包大小不符")
    with archive.open("rb") as reader:
        checksum = hashlib.file_digest(reader, "sha256").hexdigest()
    if checksum != ARCHIVE_SHA256:
        raise ValueError("Office 发行包 SHA256 不符")
    if destination.exists():
        raise ValueError("目标目录已存在，拒绝覆盖")
    if not destination.parent.is_dir():
        raise ValueError("目标父目录不存在")
    license_file = source / "LICENSE.txt"
    if not (source / "utils/editor/server.ts").is_file() or not license_file.is_file():
        raise ValueError("缺少官方源码与许可证")
    for name, expected in CONVERTER_SHA256.items():
        converter = source / "public/x2t-1" / name
        if not converter.is_file() or hashlib.sha256(converter.read_bytes()).hexdigest() != expected:
            raise ValueError("固定 tag 转换器 SHA256 不符：" + name)
    with zipfile.ZipFile(archive) as bundle:
        names = [item.filename for item in bundle.infolist() if not item.is_dir()]
        suffix = "v9.3.0.24-1/web-apps/apps/api/documents/api.js"
        marker = next((name for name in names if name.endswith(suffix)), None)
        if not marker:
            raise ValueError("发行包缺少 DocsAPI")
        prefix = marker[:-len(suffix)]
        for item in bundle.infolist():
            relative = Path(item.filename)
            if relative.is_absolute() or ".." in relative.parts or "\\" in item.filename or ":" in item.filename or (item.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError("发行包包含越界路径或符号链接")
        destination.mkdir()
        for item in bundle.infolist():
            if item.is_dir() or not item.filename.startswith(prefix):
                continue
            relative = Path(item.filename[len(prefix):])
            if relative.is_absolute() or ".." in relative.parts or "\\" in item.filename:
                raise ValueError("发行包包含越界路径")
            target = destination / relative
            if not target.resolve().is_relative_to(destination.resolve()):
                raise ValueError("发行包包含越界路径")
            if not include_runtime_member(relative.as_posix()):
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with bundle.open(item) as reader, target.open("wb") as writer:
                shutil.copyfileobj(reader, writer)
    # 固定发行包提供 SDK/web-apps/fonts；x2t-1 由同一固定 tag 源码仓库提供。
    if not (source / "public/x2t-1/x2t.js").is_file() or not (source / "public/x2t-1/x2t.wasm").is_file():
        raise ValueError("固定 tag 源码缺少 x2t-1 转换器")
    shutil.copytree(source / "public/x2t-1", destination / "x2t-1",
                    ignore=lambda directory, names: [name for name in names
                                                     if (Path(directory) / name).is_file()
                                                     and not include_runtime_member(name)])
    engine = destination / "v9.3.0.24-1"
    required = [destination / "x2t-1/x2t.js", destination / "x2t-1/x2t.wasm", engine / "web-apps/apps/api/documents/api.js", engine / "sdkjs", engine / "fonts"]
    for path in required:
        if not path.exists():
            raise ValueError("发行包缺少必须资源：" + str(path))
    patched = []
    # 上游 HTML 使用远程 base；安装时全部本地化，不运行第二个服务。
    for path in destination.rglob("*.html"):
        text = path.read_text(encoding="utf-8")
        original = text
        for origin in ("https://office-editor.ziziyi.com/", "http://office-editor.ziziyi.com/"):
            if origin in text:
                text = replace_once(text, origin, RESOURCE_ROOT)
        if path.parent.name == "main" and path.name == "index.html" and path.parent.parent.name in ("documenteditor", "spreadsheeteditor", "presentationeditor"):
            text = replace_once(text, "<head>", "<head>\n    " + BRIDGE)
            text = patch_desktop_entry(text)
        if text != original:
            path.write_text(text, encoding="utf-8")
            patched.append(path.relative_to(destination).as_posix())
    for editor in ("documenteditor", "spreadsheeteditor", "presentationeditor"):
        app = engine / "web-apps/apps" / editor / "main/app.js"
        app.write_text(patch_desktop_app(app.read_text(encoding="utf-8"), editor), encoding="utf-8")
        patched.append(app.relative_to(destination).as_posix())
    api = engine / "web-apps/apps/api/documents/api.js"
    text = api.read_text(encoding="utf-8")
    text = replace_once(text, "// TODO: check message origin", "// 本地只读桥只接收当前编辑器窗口。")
    text = replace_once(text, "_scope.frameOrigin==msg.origin", "_scope.frameOrigin==msg.origin && msg.source === document.querySelector('iframe[name=\"frameEditor\"]')?.contentWindow")
    text = replace_once(text, 'wnd.postMessage(msg, "*", [buffer])', 'wnd.postMessage(msg, location.origin, [buffer])')
    text = replace_once(text, 'wnd.postMessage(window.JSON.stringify(msg), "*")', 'wnd.postMessage(window.JSON.stringify(msg), location.origin)')
    text = replace_once(text, 'iframe.setAttribute("allow", "autoplay; camera; microphone; display-capture; clipboard-write;");', 'iframe.setAttribute("allow", "fullscreen");\n        iframe.setAttribute("sandbox", "allow-scripts allow-same-origin");')
    api.write_text(text, encoding="utf-8")
    patched.append(api.relative_to(destination).as_posix())
    shutil.copyfile(license_file, destination / "LICENSE")
    # 运行产物仅记录源码出处；对应源码由发布者独立提供。
    manifest = {"version": VERSION, "sourceCommit": SOURCE_COMMIT,
                "sourceRepository": "https://github.com/baotlake/office-website",
                "repository": "https://github.com/baotlake/office-website",
                "release": "https://github.com/baotlake/office-website/releases/download/v9.3.0.24/public-260304.zip",
                "archiveBytes": ARCHIVE_SIZE, "archiveSha256": checksum,
                "converterSource": "office-website 固定 sourceCommit 的 public/x2t-1（Brotli，沿用上游 _headers）",
                "converterSha256": {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in (destination / "x2t-1").iterdir() if path.is_file()},
                "license": "AGPL-3.0", "sourceArchive": None,
                "sourcePublication": "运行目录不附带源码包。发布者须按 AGPL-3.0 要求提供对应源码，"
                                     "包括 sourceRepository 的 sourceCommit 版本、本地集成源码与补丁；"
                                     "可使用 --source-output 在运行目录之外生成 upstream-source.zip 并另行发布，"
                                     "同时向接收者提供真实获取方式。此清单不表示对应源码已对外发布。",
                "runtimeExclusions": ["所有 *.map（扩展名不区分大小写）",
                                      "web-apps/apps/*/**/resources/help/** 仅保留 Contents.json 与许可、notice、copying、copyright 文件",
                                      "v9.3.0.24-1/web-apps/apps/{documenteditor,spreadsheeteditor,presentationeditor}/main/ie/{app.js,code.js}（六个 IE bundle；保留法律通知）"],
                "installer": "scripts/install-office-assets.py", "patchedFiles": patched,
                "changes": ["远程 HTML base 改为本地单端口路径", "预装子页自有只读通信桥，禁止父页写入 iframe DOM", "DocsAPI 固定消息来源、窗口与目标来源", "编辑器 iframe 关闭摄像头、麦克风与写剪贴板授权", "三个桌面编辑器 index.html 直接加载现代 app，不加载 IE 专用兼容脚本；main/app.js 固定现代 code 入口（仅支持现代浏览器，不提供备用 loader/internal 入口的 IE 模式）"],
                "runtime": "Python 标准库单服务；浏览器本地 WebAssembly 转换；不运行 npm、Next.js 或远程文档服务"}
    if source_output is not None:
        package_source(source, destination, source_output, manifest)
    (destination / "build-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--destination", type=Path, default=Path(__file__).resolve().parents[1] / "web/vendor/office")
    parser.add_argument("--source-output", type=Path,
                        help="显式生成对应源码包的独立目录，不能位于 --destination 运行目录内；默认不打包源码")
    args = parser.parse_args()
    install(args.archive.resolve(), args.source.resolve(), args.destination.resolve(),
            args.source_output.resolve() if args.source_output is not None else None)
