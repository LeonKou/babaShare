"""启动预检、数据目录单实例锁与有界关闭。"""
import hmac
import logging
import os
import shutil
import socket
import sqlite3
import stat
import sys
import threading
import time
import warnings
from contextlib import closing
from http.server import ThreadingHTTPServer
from pathlib import Path

from .repository import Repository


class ManagedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    block_on_close = False
    request_queue_size = 64

    def __init__(self, *args, **kwargs):
        self.active = {}
        self.active_changed = threading.Condition()
        super().__init__(*args, **kwargs)

    def process_request(self, request, client_address):
        with self.active_changed:
            self.active[request] = None
        try:
            super().process_request(request, client_address)
        except BaseException:
            with self.active_changed:
                self.active.pop(request, None)
                self.active_changed.notify_all()
            raise

    def process_request_thread(self, request, client_address):
        with self.active_changed:
            self.active[request] = threading.current_thread()
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self.active_changed:
                self.active.pop(request, None)
                self.active_changed.notify_all()

    def drain(self, deadline):
        with self.active_changed:
            while self.active:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    break
                self.active_changed.wait(remaining)
            return not self.active

    def abort_connections(self):
        with self.active_changed:
            requests = tuple(self.active)
        for request in requests:
            try:
                request.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass
            request.close()
        return len(requests)


class RuntimeLock:
    def __init__(self, path):
        self.path = Path(path)
        self.stream = None

    def acquire(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if self.path.is_symlink():
            raise RuntimeError("实例锁路径不能是符号链接；请人工检查数据目录")
        descriptor = os.open(self.path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
        self.stream = os.fdopen(descriptor, "r+b")
        try:
            if os.name == "nt":
                import msvcrt
                self.stream.seek(0)
                if not self.stream.read(1):
                    self.stream.seek(0)
                    self.stream.write(b"0")
                    self.stream.flush()
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            self.stream.close()
            self.stream = None
            raise RuntimeError(f"数据目录已被另一个实例占用：{self.path.parent}") from None
        return self

    def release(self):
        if self.stream is None:
            return
        try:
            if os.name == "nt":
                import msvcrt
                self.stream.seek(0)
                msvcrt.locking(self.stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.stream.fileno(), fcntl.LOCK_UN)
        finally:
            self.stream.close()
            self.stream = None


class Preflight:
    def __init__(self, config):
        self.config = config

    def run(self):
        config = self.config
        if sys.version_info < (3, 12):
            raise RuntimeError("需要 Python 3.12 或更高版本；请手动安装后使用 python3.12 server.py")
        if not sqlite3.sqlite_version_info:
            raise RuntimeError("当前 Python 未提供可用的 sqlite3；请安装包含 SQLite 支持的 Python 3.12+")
        for value, name in ((config.session_hours, "SESSION_HOURS"), (config.ticket_seconds, "TICKET_SECONDS"),
                            (config.max_body_bytes, "MAX_BODY_BYTES")):
            minimum = 1 if name != "MAX_BODY_BYTES" else 1024
            maximum = 87600 if name == "SESSION_HOURS" else 86400 if name == "TICKET_SECONDS" else 1024 * 1024 * 1024
            if type(value) is not int or not minimum <= value <= maximum:
                raise RuntimeError(f"BABA_SHARE_{name} 必须在 {minimum} 到 {maximum} 之间")
        resources = ("index.html", "auth.html", "users.html", "workspace.html", "share.html", "account.html",
                     "assets/common.js", "assets/boot.js", "assets/tokens.css", "assets/components.css",
                     "assets/layout.css", "assets/api.js", "assets/i18n.js", "assets/auth.js", "assets/shell.js",
                     "assets/users.js", "assets/workspace.js", "assets/share.js", "assets/account.js",
                     "assets/pagination.js", "assets/bridge-core.js", "assets/app-bridge.js",
                     "assets/page-bridge.js", "assets/mcp-help.js")
        for name in resources:
            path = config.web_dir / name
            if not path.is_file():
                raise RuntimeError(f"网页运行资源缺失：{path}")
        for port in (config.port,):
            try:
                with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
                    sock.bind((config.host, port))
            except OSError as exc:
                raise RuntimeError(f"端口 {config.host}:{port} 不可用：{exc}; 请调整 BABA_SHARE_PORT") from None
        for path in (config.root, config.root / "data", config.root / "filedb"):
            if path.exists() and not path.is_dir():
                raise RuntimeError(f"数据路径存在但不是目录：{path}")
            path.mkdir(parents=True, exist_ok=True)
            probe = path / (".baba-share-write-" + os.urandom(8).hex())
            try:
                with probe.open("xb") as stream:
                    stream.write(b"ok")
            except OSError as exc:
                raise RuntimeError(f"数据目录不可写：{path}；请人工检查目录所有者和ACL，不要使用chmod 777或自动更改文件权限。详情：{exc}") from None
            finally:
                try:
                    probe.unlink(missing_ok=True)
                except OSError:
                    pass
        free = shutil.disk_usage(config.root).free
        if free < 100 * 1024 * 1024:
            warnings.warn(f"数据卷可用空间不足100MiB：{free}字节", RuntimeWarning, stacklevel=2)
        self._check_master()
        self._check_database()
        return {"root": str(config.root), "database": str(config.database_path), "freeBytes": free}

    def _check_database(self):
        path = self.config.database_path
        try:
            if path.exists():
                with closing(sqlite3.connect(path, timeout=2)) as connection:
                    result = connection.execute("PRAGMA quick_check").fetchone()
                    if not result or result[0] != "ok":
                        raise RuntimeError(f"SQLite数据库损坏：{path}；停止服务，先备份整个数据目录，再从一致性备份恢复或人工修复。不会清理、替换数据库。")
            repo = Repository(path)
            rows = repo.all("SELECT id,user_id,key_hash,mcp_derivation_nonce,mcp_derivation_version FROM auth_mcp_key WHERE mcp_derivation_version IS NOT NULL")
            if rows:
                from .service import BizError, Service, digest
                try:
                    service = Service.__new__(Service)
                    service.config = self.config
                    for row in rows:
                        if (row["mcp_derivation_version"] != "hmac-sha256-v1"
                                or not isinstance(row["mcp_derivation_nonce"], str)
                                or len(row["mcp_derivation_nonce"]) != 64):
                            raise RuntimeError("MCP派生信息无效，请恢复匹配备份；不会自动重建主密钥")
                        key = service.mcp_derived_key(row["user_id"], row["id"], row["mcp_derivation_nonce"])
                        if not hmac.compare_digest(digest(key), row["key_hash"]):
                            raise RuntimeError("MCP主密钥与数据库不匹配；请恢复配套备份，不会自动重建主密钥")
                except (BizError, ValueError, TypeError):
                    raise RuntimeError("MCP主密钥丢失、不可读或派生信息无效；请恢复配套受保护备份，不会自动重建主密钥") from None
        except sqlite3.DatabaseError as exc:
            code = getattr(exc, "sqlite_errorcode", 0)
            if code & 0xff in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise RuntimeError(f"SQLite暂时被其他写入/事务占用：{path}；请等待事务完成并确认其他实例已停止，再重试。此错误不代表损坏；不要删除数据库或锁文件。") from None
            raise RuntimeError(f"SQLite数据库检查或初始化失败：{path}；可能损坏或结构不兼容，请先备份再人工检查；不会清理或替换数据库。详情：{exc}") from None
        except OSError as exc:
            raise RuntimeError(f"SQLite数据库无法访问：{path}；请检查宿主目录权限和存储挂载。详情：{exc}") from None

    def _check_master(self):
        master = self.config.root / "data" / "mcp-key-master"
        if not master.exists():
            return
        try:
            info = master.lstat()
            if (not stat.S_ISREG(info.st_mode) or master.is_symlink()
                    or getattr(info, "st_file_attributes", 0) & 0x400
                    or (os.name != "nt" and info.st_mode & 0o077)):
                raise RuntimeError(f"MCP主密钥权限/类型不安全：{master}。POSIX需限制为0600；Windows必须用ACL限制服务账号，POSIX模式位检查不能代表Windows ACL。不会重建或替换密钥。")
            if master.stat().st_size != 32:
                raise RuntimeError(f"MCP主密钥长度错误：{master}。请从受保护备份恢复，不要删除后重启。")
        except OSError as exc:
            raise RuntimeError(f"MCP主密钥不可访问：{master}；请检查权限并从受保护备份恢复。详情：{exc}") from None


def close_servers(servers, threads, grace_seconds=10):
    deadline = time.monotonic() + grace_seconds
    for server in servers:
        server.shutdown()
        server.server_close()
    for server in servers:
        if not server.drain(deadline):
            count = server.abort_connections()
            logging.getLogger("baba-share").warning("关闭宽限期已用尽，强制关闭%d个未完成连接", count)
    for thread in threads:
        thread.join(timeout=max(0, deadline - time.monotonic()))
