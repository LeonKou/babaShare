"""单端口线程HTTP服务与API控制器。"""
import json
import logging
import mimetypes
import platform
import signal
import sqlite3
import threading
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, unquote, urlsplit

from .service import BizError, Service, clean_path, digest, require
from .mcp import MCP, PROTOCOL_VERSIONS, rpc_error
from .runtime import ManagedHTTPServer, Preflight, RuntimeLock, close_servers

BASE = "/api/baba-share/core/v1"
WEB_BASE = "/baba-share"
COOKIE_NAME = "baba_share_session"
LOGGER = logging.getLogger("baba-share")


class Application:
    def __init__(self, config):
        self.config = config
        self.service = Service(config)
        self.mcp = MCP(self.service)

    def servers(self):
        return (ManagedHTTPServer((self.config.host, self.config.port), self.handler()),)

    def handler(self):
        app = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "babaShare"
            sys_version = ""

            def setup(self):
                self.request.settimeout(30)
                super().setup()

            def log_message(self, fmt, *args):
                # 不使用默认HTTP日志，避免share token、ticket或query泄漏。
                pass

            def parse_request(self):
                if not super().parse_request():
                    return False
                if self.request_version == "HTTP/0.9":
                    self.send_error(400)
                    return False
                return True

            def do_GET(self):
                self.handle_request()

            def do_POST(self):
                self.handle_request()

            def do_PUT(self):
                self.handle_request()

            def do_PATCH(self):
                self.handle_request()

            def do_DELETE(self):
                self.handle_request()

            def is_preview_request(self):
                target = getattr(self, "path", "")
                if not target:
                    parts = getattr(self, "raw_requestline", b"").decode("iso-8859-1").split()
                    target = parts[1] if len(parts) > 1 else ""
                try:
                    path = urlsplit(target).path
                except ValueError:
                    path = target.split("?", 1)[0]
                path = unquote(path, errors="replace")
                return path == WEB_BASE + "/preview" or path.startswith(WEB_BASE + "/preview/")

            def send_header(self, keyword, value):
                if keyword.lower() == "set-cookie" and self.is_preview_request():
                    return
                super().send_header(keyword, value)

            def end_headers(self):
                # 统一出口按请求分类，默认HTTP错误和重定向也不能丢失沙箱。
                if self.is_preview_request():
                    self.send_header("Content-Security-Policy", "sandbox allow-scripts; default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'")
                    self.send_header("Cross-Origin-Resource-Policy", "cross-origin")
                    self.send_header("Access-Control-Allow-Origin", "*")
                else:
                    self.send_header("X-Frame-Options", "SAMEORIGIN")
                    path = unquote(urlsplit(self.path).path, errors="replace")
                    office_asset = path.startswith(WEB_BASE + "/vendor/office/")
                    office_viewer = path in (WEB_BASE + "/preview-office.html", WEB_BASE + "/assets/preview-office-worker.js")
                    code_viewer = path in (WEB_BASE + "/preview-code.html", WEB_BASE + "/assets/preview-code-worker.js")
                    if office_asset or office_viewer:
                        # 仅可信本地 Office 引擎需要内联脚本、WASM和本地 blob；上传HTML仍走上方opaque沙箱。
                        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; connect-src 'self' blob:; worker-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'")
                    else:
                        script_policy = "'self' 'unsafe-eval'" if code_viewer else "'self'"
                        self.send_header("Content-Security-Policy", "default-src 'self'; script-src " + script_policy + "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; worker-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'")
                super().end_headers()

            def send_error(self, code, message=None, explain=None):
                if self.request_version == "HTTP/0.9":
                    self.request_version = "HTTP/1.1"
                self.reply({"msg": "HTTP请求不合法或方法不支持", "code": code, "status": "HTTP_REQUEST_INVALID"}, code)

            def reply(self, payload, status=200, content_type="application/json; charset=utf-8", cookie=None, headers=None):
                raw = b"" if payload is None else payload if isinstance(payload, bytes) else json.dumps(payload, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store")
                self.send_header("X-Content-Type-Options", "nosniff")
                self.send_header("Referrer-Policy", "no-referrer")
                self.send_header("Connection", "close")
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                if cookie is not None:
                    value = COOKIE_NAME + "=" + cookie + "; Path=" + BASE + "; HttpOnly; SameSite=Strict"
                    value += "; Max-Age=" + str(app.config.session_hours * 3600 if cookie else 0)
                    if app.config.secure_cookie:
                        value += "; Secure"
                    self.send_header("Set-Cookie", value)
                self.end_headers()
                if getattr(self, "command", None) != "HEAD":
                    self.wfile.write(raw)
                self.close_connection = True

            def token(self):
                cookie = SimpleCookie()
                try:
                    cookie.load(self.headers.get("Cookie", ""))
                except Exception:
                    return ""
                return cookie[COOKIE_NAME].value if COOKIE_NAME in cookie else ""

            def body(self):
                require(not self.headers.get("Transfer-Encoding"), msg="不支持传输编码")
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    raise BizError(400, "PARAM_INVALID", "请求长度错误") from None
                if length > app.config.max_body_bytes:
                    self.drain_body()
                require(0 <= length <= app.config.max_body_bytes, 413, "PAYLOAD_TOO_LARGE", "请求过大")
                if not length:
                    return {}
                require(self.headers.get_content_type() == "application/json", 400, "PARAM_INVALID", "请求必须为JSON")
                try:
                    value = json.loads(self.rfile.read(length))
                except (ValueError, UnicodeError):
                    raise BizError(400, "PARAM_INVALID", "JSON格式错误") from None
                require(isinstance(value, dict))
                return value

            def drain_body(self):
                try:
                    length = int(self.headers.get("Content-Length", "0"))
                except ValueError:
                    return
                if 0 < length <= max(65536, app.config.max_body_bytes) and not self.headers.get("Transfer-Encoding"):
                    self.connection.settimeout(1)
                    try:
                        remaining = length
                        while remaining:
                            chunk = self.rfile.read(min(65536, remaining))
                            if not chunk:
                                break
                            remaining -= len(chunk)
                    except (OSError, TimeoutError):
                        pass
                    finally:
                        self.connection.settimeout(30)

            def check_origin(self):
                # 域名、TLS和来源准入由网关负责；不可拿内部Host或转发头推断浏览器来源。
                origin = self.headers.get("Origin")
                require(origin not in ("null", ""), 403, "ORIGIN_DENIED", "拒绝不透明来源接口请求")
                # sandbox请求的Origin为null；GET即使省略Origin也会携带跨站Fetch Metadata。
                # same-site仍可能来自不可信兄弟子域。无元数据的非浏览器客户端交网关准入。
                require(self.headers.get("Sec-Fetch-Site") in (None, "same-origin", "none"),
                        403, "ORIGIN_DENIED", "拒绝跨来源接口请求")

            def mail_request_origin(self):
                require(self.headers.get("Sec-Fetch-Site") in (None, "same-origin"),
                        403, "ORIGIN_DENIED", "邮件请求必须来自同源页面")
                require(len(self.headers.get_all("Origin", [])) <= 1 and
                        len(self.headers.get_all("Sec-Fetch-Site", [])) <= 1,
                        403, "ORIGIN_DENIED", "来源与浏览器元数据必须唯一")
                origin = self.headers.get("Origin")
                if origin is not None:
                    app.service.mail_origin({}, origin)
                return origin

            def handle_request(self):
                api = False
                raw_preview = self.is_preview_request()
                try:
                    self.connection.settimeout(30)
                    parsed = urlsplit(self.path)
                    path = unquote(parsed.path, errors="strict")
                    if raw_preview:
                        self.preview(path)
                        return
                    if path.startswith("/api/"):
                        api = True
                        require(path.startswith(BASE + "/"), 404, "ROUTE_NOT_EXIST", "接口不存在")
                        if path == BASE + "/mcp":
                            self.mcp_request()
                            return
                        try:
                            self.check_origin()
                        except BizError:
                            self.drain_body()
                            raise
                        query = {key: values[-1] for key, values in parse_qs(parsed.query, keep_blank_values=True).items()}
                        data, cookie = self.api(path[len(BASE):], query)
                        self.reply(data, cookie=cookie)
                    else:
                        require(self.command == "GET", 405, "METHOD_NOT_ALLOWED", "请求方法不允许")
                        if path in ("/", WEB_BASE):
                            self.reply(None, 302, headers={"Location": WEB_BASE + "/"})
                            return
                        require(path.startswith(WEB_BASE + "/"), 404, "FILE_NOT_EXIST", "页面不存在")
                        path = path[len(WEB_BASE):]
                        if path == "/":
                            path = "/index.html"
                        elif path.startswith("/s/"):
                            path = "/share.html"
                        relative = clean_path(path.lstrip("/"), False)
                        file = app.config.web_dir / relative
                        require(file.resolve().is_relative_to(app.config.web_dir.resolve()) and not file.is_symlink(), 403, "UNSAFE_PATH", "禁止越界路径")
                        require(file.is_file(), 404, "FILE_NOT_EXIST", "页面不存在")
                        raw = file.read_bytes()
                        headers = None
                        if relative.startswith("vendor/office/x2t-1/") and file.suffix.lower() in (".js", ".wasm"):
                            # 上游 _headers 明确指定 x2t-1 为 Brotli；只压缩存储，不引入Python解压依赖。
                            if not raw.startswith((b"//", b"var ", b"\x00asm")):
                                headers = {"Content-Encoding": "br", "Vary": "Accept-Encoding"}
                        self.reply(raw, content_type=self.mime(file), headers=headers)
                except BizError as exc:
                    self.reply({"msg": exc.msg, "code": exc.code, "status": exc.status}, exc.code)
                except (ValueError, TypeError, KeyError, AttributeError) as exc:
                    self.reply({"msg": "请求参数不合法", "code": 400, "status": "PARAM_INVALID"}, 400)
                except sqlite3.IntegrityError:
                    self.reply({"msg": "资源已存在或发生冲突", "code": 409, "status": "RESOURCE_CONFLICT"}, 409)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    pass
                except OSError:
                    self.reply({"msg": "文件系统操作失败，请检查路径长度、磁盘空间与权限", "code": 400, "status": "STORAGE_ERROR"}, 400)
                except Exception as exc:
                    LOGGER.error(json.dumps({"event": "request-error", "errorType": type(exc).__name__, "api": api, "preview": self.is_preview_request()}))
                    self.reply({"msg": "服务内部错误", "code": 500, "status": "INTERNAL_ERROR"}, 500)

            @staticmethod
            def mime(path):
                overrides = {".wasm": "application/wasm", ".js": "application/javascript", ".mjs": "application/javascript", ".svg": "image/svg+xml"}
                content_type = overrides.get(path.suffix.lower()) or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
                if content_type.startswith("text/") or content_type in ("application/javascript", "application/json"):
                    content_type += "; charset=utf-8"
                return content_type

            def preview(self, path):
                require(self.command == "GET", 405, "METHOD_NOT_ALLOWED", "预览服务只允许读取")
                prefix = WEB_BASE + "/preview"
                require(path.startswith(prefix + "/"), 404, "FILE_NOT_EXIST", "预览资源不存在")
                path = path[len(prefix):]
                parts = path.split("/", 3)
                require(len(parts) >= 3 and parts[1] in ("s", "p"), 404, "FILE_NOT_EXIST", "预览资源不存在")
                kind, token, relative = parts[1], parts[2], parts[3] if len(parts) == 4 else ""
                with app.service.lock:
                    disk, entry_path = app.service.preview_resource(kind, token, relative)
                    if entry_path and not path.endswith("/"):
                        self.reply(None, 307, headers={"Location": prefix + quote(path, safe="/") + "/"})
                        return
                    if entry_path:
                        disk = disk / entry_path
                    raw = disk.read_bytes()
                download = parse_qs(urlsplit(self.path).query).get("download") == ["1"]
                headers = {"Content-Disposition": "attachment; filename*=UTF-8''" + quote(disk.name, safe="")} if download else None
                self.reply(raw, content_type=self.mime(disk), headers=headers)

            def mcp_request(self):
                request_id = None
                try:
                    self.check_origin()
                    authorization = self.headers.get("Authorization", "").split()
                    require(len(authorization) == 2 and authorization[0].lower() == "bearer",
                            401, "AUTH_REQUIRED", "MCP需要Bearer密钥")
                    user = app.service.mcp_authenticated(authorization[1])
                    version = self.headers.get("MCP-Protocol-Version")
                    require(version is None or version in PROTOCOL_VERSIONS,
                            400, "MCP_VERSION_UNSUPPORTED", "不支持此MCP协议版本")
                    require(self.command == "POST", 405, "METHOD_NOT_ALLOWED", "无会话MCP只支持POST")
                    require(not self.headers.get("Transfer-Encoding"), msg="不支持传输编码")
                    require(len(self.headers.get_all("Content-Length", [])) == 1, msg="必须提供唯一Content-Length")
                    try:
                        length = int(self.headers.get("Content-Length", "0"))
                    except ValueError:
                        raise BizError(400, "PARAM_INVALID", "请求长度错误") from None
                    require(0 <= length <= app.config.max_body_bytes, 413, "PAYLOAD_TOO_LARGE", "MCP请求过大")
                    require(self.headers.get_content_type() == "application/json", 415,
                            "PARAM_INVALID", "MCP请求必须为application/json")
                    raw = self.rfile.read(length)
                    try:
                        value = json.loads(raw.decode("utf-8"))
                    except (ValueError, UnicodeError):
                        self.reply(rpc_error(None, -32700, "JSON解析失败"), 400)
                        return
                    if isinstance(value, dict):
                        request_id = value.get("id") if type(value.get("id")) in (str, int) else None
                    status, result = app.mcp.dispatch(user, value, version or "2025-03-26")
                    self.reply(result, status)
                except BizError as exc:
                    self.drain_body()
                    headers = {"WWW-Authenticate": 'Bearer realm="babaShare"'} if exc.code == 401 else {}
                    if exc.code == 405:
                        headers["Allow"] = "POST"
                    self.reply(rpc_error(request_id, -32600 if exc.code == 400 else -32000,
                                         exc.msg, {"status": exc.status, "code": exc.code}), exc.code, headers=headers)
                except Exception as exc:
                    LOGGER.error(json.dumps({"event": "mcp-error", "errorType": type(exc).__name__}))
                    self.reply(rpc_error(request_id, -32603, "MCP服务内部错误"), 500)

            def api(self, route, query):
                service, method = app.service, self.command
                body = self.body() if method in ("POST", "PUT", "PATCH") else {}
                if route == "/visitor/install/detail" and method == "GET":
                    return service.install_detail(), None
                if route == "/visitor/share/detail" and method == "GET":
                    return service.share_detail(query.get("token"), query.get("path", ""),
                                                query.get("pageIndex", 1), query.get("pageSize", 20)), None
                if route in ("/visitor/account/setup", "/visitor/account/registration") and method == "POST":
                    mode = "setup" if route.endswith("setup") else "registration"
                    user = service.account(body, mode)
                    return user, service.new_session(user["id"])
                if route == "/visitor/email/registration" and method == "POST":
                    return service.email_registration(body, self.client_address[0], self.mail_request_origin()), None
                if route == "/visitor/email/activation" and method == "POST":
                    return service.email_activation(body, self.client_address[0], self.token())
                if route == "/visitor/password-reset/request" and method == "POST":
                    return service.password_reset_request(body, self.client_address[0], self.mail_request_origin()), None
                if route == "/visitor/password-reset/confirmation" and method == "POST":
                    self.mail_request_origin()
                    return service.password_reset_confirmation(body), None
                if route == "/visitor/session" and method == "POST":
                    return service.login(body, self.client_address[0])
                user = service.authenticated(self.token())
                result = None
                if route == "/account/email/detail" and method == "GET":
                    result = service.email_detail(user, self.token())
                elif route == "/account/email-change/request" and method == "POST":
                    result = service.email_request(user, self.token(), self.client_address[0], self.mail_request_origin())
                elif route == "/account/email-change/verification" and method == "POST":
                    self.mail_request_origin()
                    result = service.email_verification(user, self.token(), body)
                elif route == "/account/email-change/proposal" and method == "POST":
                    result = service.email_proposal(user, self.token(), body, self.client_address[0], self.mail_request_origin(), binding=False)
                elif route == "/account/email-change/confirmation" and method == "POST":
                    self.mail_request_origin()
                    result = service.email_confirmation(user, self.token(), body, binding=False)
                elif route == "/account/email-binding/request" and method == "POST":
                    result = service.email_proposal(user, self.token(), body, self.client_address[0], self.mail_request_origin(), binding=True)
                elif route == "/account/email-binding/confirmation" and method == "POST":
                    self.mail_request_origin()
                    result = service.email_confirmation(user, self.token(), body, binding=True)
                elif route == "/session/detail" and method == "GET":
                    result = service.user_view(user)
                elif route == "/session" and method == "DELETE":
                    service.repo.execute("DELETE FROM auth_session WHERE session_hash=?", (digest(self.token()),))
                    return {}, ""
                elif route == "/mcp-key/list" and method == "GET":
                    result = service.mcp_keys(user)
                elif route == "/mcp-key" and method == "POST":
                    result = service.mcp_key_create(user, body)
                elif route == "/mcp-key" and method == "DELETE":
                    result = service.mcp_key_delete(user, query.get("id"))
                elif route == "/mcp-key/content" and method == "POST":
                    result = service.mcp_key_content(user, body.get("id"))
                elif route == "/user/list" and method == "GET":
                    result = service.users(user)
                elif route == "/user" and method == "POST":
                    result = service.account(body, actor=user)
                elif route == "/user" and method == "PATCH":
                    result = service.change_user(user, body)
                elif route == "/user" and method == "DELETE":
                    result = service.user_delete(user, query.get("id"))
                elif route == "/workspace-admin/list" and method == "GET":
                    result = service.workspace_admin(user, query)
                elif route == "/workspace/ownership" and method == "PATCH":
                    result = service.workspace_ownership(user, body)
                elif route == "/setting/detail" and method == "GET":
                    result = service.settings(user)
                elif route == "/setting" and method == "PATCH":
                    result = service.settings(user, body)
                elif route == "/mail-setting/detail" and method == "GET":
                    result = service.mail_settings(user)
                elif route == "/mail-setting" and method == "PATCH":
                    result = service.mail_settings(user, body)
                elif route == "/mail-setting/test" and method == "POST":
                    result = service.mail_test(user, body)
                elif route == "/workspace/list" and method == "GET":
                    result = service.workspaces(user)
                elif route == "/workspace" and method == "POST":
                    result = service.workspace_create(user, body)
                elif route == "/workspace" and method == "PATCH":
                    result = service.workspace_change(user, body)
                elif route == "/workspace" and method == "DELETE":
                    result = service.workspace_delete(user, query.get("id"))
                elif route == "/invitation/list" and method == "GET":
                    result = service.invitations(user, query.get("workspaceId"))
                elif route == "/invitation" and method == "POST":
                    result = service.invitation_create(user, body)
                elif route == "/invitation" and method == "DELETE":
                    result = service.invitation_delete(user, query.get("id"))
                elif route == "/invitation/membership" and method == "POST":
                    result = service.invitation_membership(user, body)
                elif route == "/member/list" and method == "GET":
                    result = service.members(user, query.get("workspaceId"))
                elif route == "/member" and method in ("POST", "PATCH"):
                    result = service.member_change(user, body)
                elif route == "/member" and method == "DELETE":
                    result = service.member_delete(user, query.get("workspaceId"), query.get("userId"))
                elif route == "/node/list" and method == "GET":
                    result = service.listing(query.get("workspaceId"), query.get("path", ""), user,
                                             query.get("pageIndex", 1), query.get("pageSize", 20),
                                             query.get("search", ""), query.get("sort", "name"), query.get("order", "asc"))
                elif route == "/folder" and method == "POST":
                    result = service.folder_create(user, body)
                elif route in ("/folder", "/file") and method == "PATCH":
                    result = service.node_move(user, body, route[1:])
                elif route in ("/folder", "/file") and method == "DELETE":
                    result = service.node_delete(user, query.get("workspaceId"), query.get("path"), route[1:])
                elif route == "/file/content" and method == "GET":
                    result = service.file_read(user, query.get("workspaceId"), query.get("path"))
                elif route == "/file/content" and method == "PUT":
                    result = service.file_write(user, body)
                elif route == "/file/upload" and method == "POST":
                    result = service.upload(user, body)
                elif route == "/preview/ticket" and method == "POST":
                    result = service.ticket(user, body)
                elif route == "/share/list" and method == "GET":
                    result = service.shares(user)
                elif route == "/share" and method == "POST":
                    result = service.share_create(user, body)
                elif route == "/share" and method == "DELETE":
                    result = service.share_delete(user, query.get("id"))
                require(result is not None, 404, "ROUTE_NOT_EXIST", "接口不存在或方法不匹配")
                return result, None

        return Handler


def run(config, check_only=False):
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    stopping = threading.Event()
    failures = []
    servers, threads = [], []
    runtime_lock = RuntimeLock(config.root / "data" / ".baba-share.lock").acquire()
    previous_signals = {}

    def request_stop(signum, frame):
        stopping.set()

    def serve(server):
        try:
            server.serve_forever(poll_interval=0.2)
        except Exception as exc:
            failures.append(type(exc).__name__)
        finally:
            stopping.set()

    try:
        report = Preflight(config).run()
        LOGGER.info(json.dumps({"event": "preflight-ok", "initializesDatabase": True,
                                "dataDir": report["root"], "database": report["database"],
                                "freeBytes": report["freeBytes"]}, ensure_ascii=False))
        if check_only:
            return
        application = Application(config)
        servers = list(application.servers())
        if threading.current_thread() is threading.main_thread():
            for signum in (signal.SIGTERM, signal.SIGINT):
                previous_signals[signum] = signal.signal(signum, request_stop)
        for server in servers:
            thread = threading.Thread(target=serve, args=(server,), daemon=True)
            thread.start()
            threads.append(thread)
        LOGGER.info(json.dumps({"event": "started", "dataDir": str(config.root),
                                "database": str(config.database_path),
                                "page": config.public_origin + "/baba-share/",
                                "preview": config.public_origin + WEB_BASE + "/preview/", "python": platform.python_version(),
                                "sqlite": sqlite3.sqlite_version}, ensure_ascii=False))
        try:
            stopping.wait()
        except KeyboardInterrupt:
            stopping.set()
        if failures:
            raise RuntimeError("HTTP服务线程异常退出：" + ", ".join(failures))
    finally:
        close_servers(servers, threads)
        for signum, handler in previous_signals.items():
            signal.signal(signum, handler)
        runtime_lock.release()
