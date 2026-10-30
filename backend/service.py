"""认证、权限、真实文件与分享业务。"""
import base64
import hashlib
import hmac
import json
import logging
import os
import re
import secrets
import shutil
import sqlite3
import stat
import threading
import tempfile
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import quote

LOGGER = logging.getLogger("baba-share")

from .repository import (Repository, USER_COLUMNS, WORKSPACE_COLUMNS, SHARE_COLUMNS,
                         db_id, new_id, now_ms, public_row)


class BizError(Exception):
    def __init__(self, code, status, msg):
        super().__init__(msg)
        self.code, self.status, self.msg = code, status, msg


def require(condition, code=400, status="PARAM_INVALID", msg="参数不合法"):
    if not condition:
        raise BizError(code, status, msg)


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def password_hash(password):
    require(isinstance(password, str) and 10 <= len(password) <= 256,
            msg="密码长度必须为10至256位")
    salt = secrets.token_bytes(16)
    encoded = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, 310000)
    return salt.hex() + ":" + encoded.hex()


def password_valid(password, stored):
    if not isinstance(password, str) or len(password) > 256:
        return False
    salt, expected = stored.split(":", 1)
    actual = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), 310000)
    return hmac.compare_digest(actual.hex(), expected)


def clean_path(value, allow_empty=True):
    require(isinstance(value, str), msg="路径必须为字符串")
    require("\\" not in value and "\x00" not in value,
            msg="路径包含非法字符")
    require(not value.startswith("/"), msg="禁止绝对路径")
    parts = value.split("/") if value else []
    require(all(part not in ("", ".", "..") and len(part) <= 240 and
                not re.search(r'[<>:"|?*\x00-\x1f]', part) and
                not part.endswith((" ", ".")) and
                part.split(".")[0].upper() not in
                {"CON", "PRN", "AUX", "NUL", *("COM" + str(i) for i in range(1, 10)), *("LPT" + str(i) for i in range(1, 10))}
                for part in parts), msg="路径包含非法层级或系统保留名")
    require(allow_empty or bool(parts), msg="不允许操作根目录")
    return "/".join(parts)


def beneath(path, root):
    return path == root or not root or path.startswith(root + "/")


class Service:
    _locks = {}
    _locks_guard = threading.Lock()

    def __init__(self, config):
        self.config = config
        self.repo = Repository(config.database_path)
        with self._locks_guard:
            self.lock = self._locks.setdefault(str(config.root.resolve()), threading.RLock())
        self.login_attempts = {}

    def install_detail(self):
        count = self.repo.one("SELECT count(*) AS user_count FROM sys_user")["user_count"]
        setting = self.repo.one("SELECT is_registration_enabled FROM app_setting LIMIT 1")
        return {"setupRequired": count == 0, "registrationEnabled": bool(setting["is_registration_enabled"])}

    @staticmethod
    def user_view(user):
        return {"id": user["id"], "userName": user["user_name"], "nickname": user["nickname"],
                "role": user["user_role"], "isDisabled": bool(user["is_disabled"]),
                "createTime": user["create_time"]}

    def account(self, body, mode="admin", actor=None):
        with self.lock:
            state = self.install_detail()
            if mode == "setup":
                require(state["setupRequired"], 409, "SETUP_COMPLETED", "初始化已经完成")
                role = "admin"
            elif mode == "registration":
                require(not state["setupRequired"] and state["registrationEnabled"], 403,
                        "REGISTRATION_DISABLED", "注册功能未开放")
                role = "viewer"
            else:
                self.admin(actor)
                role = body.get("role", "viewer")
            name = body.get("userName", "")
            require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.@-]{3,64}", name),
                    msg="账号为3至64位字母数字或_.@-")
            require(role in ("admin", "editor", "viewer"))
            nickname = body.get("nickname", name)
            require(isinstance(nickname, str) and 1 <= len(nickname) <= 64)
            existing = self.repo.user_by_name(name)
            if existing and mode == "admin":
                require(existing["user_role"] == role and existing["nickname"] == nickname,
                        409, "USER_EXISTS", "账号已经存在")
                return self.user_view(existing)
            require(existing is None, 409, "USER_EXISTS", "账号已经存在")
            user_id, stamp = new_id(), now_ms()
            hashed = password_hash(body.get("password"))
            self.repo.execute("INSERT INTO sys_user (id,user_name,nickname,password_hash,user_role,is_disabled,create_time,update_time) VALUES (?,?,?,?,?,0,?,?)",
                              (db_id(user_id), name, nickname, hashed, role, stamp, stamp))
            return self.user_view(self.repo.user(user_id))

    def new_session(self, user_id):
        token, stamp = secrets.token_urlsafe(32), now_ms()
        self.repo.execute("DELETE FROM auth_session WHERE expire_time<=?", (stamp,))
        self.repo.execute("INSERT INTO auth_session (id,session_hash,user_id,expire_time,create_time,update_time) VALUES (?,?,?,?,?,?)",
                          (db_id(new_id()), digest(token), db_id(user_id),
                           stamp + self.config.session_hours * 3600000, stamp, stamp))
        return token

    def login(self, body, client_ip):
        name = body.get("userName", "")
        require(isinstance(name, str) and len(name) <= 64)
        key, stamp = (client_ip, name.casefold()), now_ms()
        with self.lock:
            attempts = [at for at in self.login_attempts.get(key, []) if at > stamp - 300000]
            require(len(attempts) < 10, 429, "LOGIN_THROTTLED", "登录失败过多，请稍后重试")
            self.login_attempts[key] = attempts + [stamp]
        user = self.repo.user_by_name(name)
        valid = password_valid(body.get("password"), user["password_hash"]) if user else password_valid(body.get("password"), "00" * 16 + ":" + "00" * 32)
        require(user and valid and not user["is_disabled"], 401, "LOGIN_FAILED", "账号或密码错误，或账号被禁用")
        with self.lock:
            self.login_attempts.pop(key, None)
        return self.user_view(user), self.new_session(user["id"])

    def authenticated(self, token):
        require(token, 401, "AUTH_REQUIRED", "请先登录")
        session = self.repo.one("SELECT user_id FROM auth_session WHERE session_hash=? AND expire_time>?", (digest(token), now_ms()))
        user = self.repo.user(session["user_id"]) if session else None
        require(user and not user["is_disabled"], 401, "AUTH_REQUIRED", "登录已失效")
        return user

    @staticmethod
    def mcp_key_view(row):
        stamp = now_ms()
        return {"id": row["id"], "keyName": row["key_name"], "keyPrefix": row["key_prefix"],
                "expireTime": row["expire_time"], "revokedTime": row["revoked_time"],
                "createTime": row["create_time"], "updateTime": row["update_time"],
                "isActive": row["revoked_time"] is None and
                (row["expire_time"] is None or row["expire_time"] > stamp)}

    def mcp_keys(self, user):
        rows = self.repo.all("SELECT id,key_name,key_prefix,expire_time,revoked_time,create_time,update_time FROM auth_mcp_key WHERE user_id=? ORDER BY create_time DESC",
                             (db_id(user["id"]),))
        return [self.mcp_key_view(row) for row in rows]

    def mcp_master(self, create=False):
        path = self.config.root / "data" / "mcp-key-master"
        try:
            parent = path.parent.lstat()
            if (not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or
                    getattr(parent, "st_file_attributes", 0) & 0x400):
                raise OSError("不安全的主密钥目录")
            if create:
                try:
                    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL |
                                         getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0), 0o600)
                except FileExistsError:
                    pass
                else:
                    with os.fdopen(descriptor, "wb") as stream:
                        stream.write(secrets.token_bytes(32))
                        stream.flush()
                        os.fsync(stream.fileno())
            before = path.lstat()
            if (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or
                    getattr(before, "st_file_attributes", 0) & 0x400 or
                    (os.name != "nt" and before.st_mode & 0o077)):
                raise OSError("不安全的主密钥文件")
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) |
                                 getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(descriptor, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not os.path.samestat(before, opened) or not os.path.samestat(opened, path.lstat()):
                    raise OSError("主密钥文件已变化")
                master = stream.read(33)
            if len(master) != 32:
                raise OSError("主密钥长度无效")
            return master
        except OSError:
            raise BizError(503, "MCP_KEY_RECOVERY_UNAVAILABLE", "主密钥不可用，请检查受保护备份；不会重建或返回错误密钥") from None

    def mcp_derived_key(self, user_id, key_id, nonce, create_master=False):
        master = self.mcp_master(create=create_master)
        context = b"babaShare/mcp-key/hmac-sha256/v1\0" + db_id(user_id) + db_id(key_id) + bytes.fromhex(nonce)
        secret = hmac.new(master, context, hashlib.sha256).digest()
        return "bsk-" + base64.urlsafe_b64encode(secret).decode().rstrip("=")

    def mcp_key_content(self, user, key_id):
        require(isinstance(key_id, str), msg="密钥ID不合法")
        with self.lock, self.repo.connection() as connection:
            # 与创建及撤销串行；恢复只读取，不生成主密钥或新MCP凭据。
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT id,key_hash,expire_time,revoked_time,mcp_derivation_version,mcp_derivation_nonce FROM auth_mcp_key WHERE id=? AND user_id=?",
                                     (db_id(key_id), db_id(user["id"]))).fetchone()
            require(row, 404, "MCP_KEY_NOT_EXIST", "密钥不存在")
            require(row["revoked_time"] is None and (row["expire_time"] is None or row["expire_time"] > now_ms()),
                    409, "MCP_KEY_INACTIVE", "已撤销或过期的密钥不能复制")
            require(row["mcp_derivation_version"] is not None, 409, "MCP_KEY_NOT_RECOVERABLE", "旧密钥仅保存摘要，请另行创建新密钥；不会自动撤销旧密钥")
            require(row["mcp_derivation_version"] == "hmac-sha256-v1" and
                    isinstance(row["mcp_derivation_nonce"], str) and
                    re.fullmatch(r"[0-9a-f]{64}", row["mcp_derivation_nonce"]),
                    503, "MCP_KEY_RECOVERY_UNAVAILABLE", "派生信息不可用")
            token = self.mcp_derived_key(user["id"], key_id, row["mcp_derivation_nonce"])
            require(hmac.compare_digest(digest(token), row["key_hash"]),
                    503, "MCP_KEY_RECOVERY_UNAVAILABLE", "主密钥与凭据摘要不匹配，请恢复正确备份")
            return {"key": token}

    def mcp_key_create(self, user, body):
        name, hours, request_id = body.get("keyName"), body.get("expireHours"), body.get("requestId")
        require(isinstance(name, str) and 1 <= len(name.strip()) <= 100, msg="密钥名称必须为1至100字")
        require(hours is None or type(hours) is int and 1 <= hours <= 87600,
                msg="expireHours必须为1至87600的整数小时，或null表示永久")
        require(isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,100}", request_id),
                msg="requestId必须为16至100位随机请求标识")
        name = name.strip()
        request_hash = digest(name + "\n" + str(hours))
        with self.lock, self.repo.connection() as connection:
            # 数据库写事务使多线程、多进程配额检查和幂等占位成为同一原子操作。
            connection.execute("BEGIN IMMEDIATE")
            existing = connection.execute("SELECT request_hash FROM auth_mcp_key WHERE user_id=? AND request_id=?",
                                          (db_id(user["id"]), request_id)).fetchone()
            if existing:
                require(existing["request_hash"] == request_hash, 409, "REQUEST_CONFLICT", "同一requestId不能用于不同参数")
                raise BizError(409, "KEY_ALREADY_CREATED", "密钥已经创建，请在列表中复制使用；不会重复创建")
            stamp = now_ms()
            count = connection.execute("SELECT count(*) AS key_count FROM auth_mcp_key WHERE user_id=? AND revoked_time IS NULL AND (expire_time IS NULL OR expire_time>?)",
                                       (db_id(user["id"]), stamp)).fetchone()["key_count"]
            require(count < 10, 409, "MCP_KEY_LIMIT", "有效密钥最多10个")
            sample = connection.execute("SELECT id,user_id,key_hash,mcp_derivation_nonce FROM auth_mcp_key WHERE mcp_derivation_version IS NOT NULL LIMIT 1").fetchone()
            if sample:
                expected = self.mcp_derived_key(str(uuid.UUID(bytes=sample["user_id"])),
                                                str(uuid.UUID(bytes=sample["id"])), sample["mcp_derivation_nonce"])
                require(hmac.compare_digest(digest(expected), sample["key_hash"]),
                        503, "MCP_KEY_RECOVERY_UNAVAILABLE", "主密钥不匹配，请恢复正确备份")
            key_id, nonce = new_id(), secrets.token_hex(32)
            token = self.mcp_derived_key(user["id"], key_id, nonce, create_master=sample is None)
            expiry = stamp + hours * 3600000 if hours is not None else None
            connection.execute("INSERT INTO auth_mcp_key (id,user_id,key_name,key_prefix,key_hash,request_id,request_hash,expire_time,revoked_time,mcp_derivation_version,mcp_derivation_nonce,create_time,update_time) VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?)",
                               (db_id(key_id), db_id(user["id"]), name, token[:12], digest(token), request_id,
                                request_hash, expiry, "hmac-sha256-v1", nonce, stamp, stamp))
            row = {"id": key_id, "key_name": name, "key_prefix": token[:12], "expire_time": expiry,
                   "revoked_time": None, "create_time": stamp, "update_time": stamp}
            return {**self.mcp_key_view(row), "key": token}

    def mcp_key_revoke(self, user, key_id):
        with self.lock:
            row = self.repo.one("SELECT id,revoked_time FROM auth_mcp_key WHERE id=? AND user_id=?",
                                (db_id(key_id), db_id(user["id"])))
            require(row, 404, "MCP_KEY_NOT_EXIST", "密钥不存在")
            if row["revoked_time"] is None:
                stamp = now_ms()
                self.repo.execute("UPDATE auth_mcp_key SET revoked_time=?,update_time=? WHERE id=? AND user_id=? AND revoked_time IS NULL",
                                  (stamp, stamp, db_id(key_id), db_id(user["id"])))
        return {}

    def mcp_authenticated(self, token):
        require(isinstance(token, str) and re.fullmatch(r"bsk-[A-Za-z0-9_-]{43}", token),
                401, "AUTH_REQUIRED", "MCP密钥无效")
        row = self.repo.one("SELECT user_id FROM auth_mcp_key WHERE key_hash=? AND revoked_time IS NULL AND (expire_time IS NULL OR expire_time>?)",
                            (digest(token), now_ms()))
        user = self.repo.user(row["user_id"]) if row else None
        require(user and not user["is_disabled"], 401, "AUTH_REQUIRED", "MCP密钥无效或账号已禁用")
        return user

    @staticmethod
    def admin(user):
        require(user and user["user_role"] == "admin", 403, "PERMISSION_DENIED", "仅管理员可操作")

    def users(self, user):
        self.admin(user)
        return [self.user_view(row) for row in self.repo.all("SELECT " + USER_COLUMNS + " FROM sys_user ORDER BY create_time")]

    def change_user(self, actor, body):
        self.admin(actor)
        with self.lock:
            target = self.repo.user(body.get("id"))
            require(target, 404, "USER_NOT_EXIST", "账号不存在")
            role = body.get("role", target["user_role"])
            disabled = body.get("isDisabled", bool(target["is_disabled"]))
            require(role in ("admin", "editor", "viewer") and isinstance(disabled, bool))
            if target["user_role"] == "admin" and (role != "admin" or disabled):
                count = self.repo.one("SELECT count(*) AS user_count FROM sys_user WHERE user_role='admin' AND is_disabled=0")["user_count"]
                require(count > 1, 409, "LAST_ADMIN", "必须保留至少一个可用管理员")
            nickname = body.get("nickname", target["nickname"])
            require(isinstance(nickname, str) and 1 <= len(nickname) <= 64)
            hashed = password_hash(body["password"]) if "password" in body else target["password_hash"]
            self.repo.execute("UPDATE sys_user SET user_role=?,is_disabled=?,nickname=?,password_hash=?,update_time=? WHERE id=?",
                              (role, int(disabled), nickname, hashed, now_ms(), db_id(target["id"])))
            if disabled or "password" in body:
                self.repo.execute("DELETE FROM auth_session WHERE user_id=?", (db_id(target["id"]),))
            return self.user_view(self.repo.user(target["id"]))

    def settings(self, user, body=None):
        self.admin(user)
        if body is not None:
            require(isinstance(body.get("registrationEnabled"), bool))
            self.repo.execute("UPDATE app_setting SET is_registration_enabled=?,update_time=? WHERE id IN (SELECT id FROM app_setting LIMIT 1)",
                              (int(body["registrationEnabled"]), now_ms()))
        return {"registrationEnabled": self.install_detail()["registrationEnabled"]}

    def access(self, user, workspace_id, manage=False, write=False):
        workspace = self.repo.workspace(workspace_id)
        require(workspace, 404, "WORKSPACE_NOT_EXIST", "工作空间不存在")
        manager = user["user_role"] == "admin" or workspace["owner_id"] == user["id"]
        member = self.repo.one("SELECT is_collaborate FROM workspace_member WHERE workspace_id=? AND user_id=?",
                               (db_id(workspace_id), db_id(user["id"])))
        require(manager or member, 403, "PERMISSION_DENIED", "无权访问工作空间")
        require(not manage or manager, 403, "PERMISSION_DENIED", "仅所有者和管理员可管理")
        require(not write or user["user_role"] in ("admin", "editor"), 403,
                "READ_ONLY", "查看者始终只读")
        return workspace, manager, bool(member and member["is_collaborate"])

    def workspace_view(self, user, row):
        _, manager, collaborate = self.access(user, row["id"])
        return {"id": row["id"], "workspaceName": row["workspace_name"], "description": row["description"],
                "ownerId": row["owner_id"], "canManage": manager,
                "canWrite": user["user_role"] in ("admin", "editor"), "collaborate": collaborate,
                "createTime": row["create_time"]}

    def workspaces(self, user):
        if user["user_role"] == "admin":
            rows = self.repo.all("SELECT " + WORKSPACE_COLUMNS + " FROM project_workspace ORDER BY create_time DESC")
        else:
            rows = self.repo.all("SELECT " + WORKSPACE_COLUMNS + " FROM project_workspace WHERE owner_id=? OR id IN (SELECT workspace_id FROM workspace_member WHERE user_id=?) ORDER BY create_time DESC",
                                 (db_id(user["id"]), db_id(user["id"])))
        return [self.workspace_view(user, row) for row in rows]

    def workspace_create(self, user, body):
        require(user["user_role"] in ("admin", "editor"), 403, "READ_ONLY", "查看者不能创建工作空间")
        name, description = body.get("workspaceName"), body.get("description", "")
        require(isinstance(name, str) and 1 <= len(name.strip()) <= 100)
        require(isinstance(description, str) and len(description) <= 500)
        with self.lock:
            existing = self.repo.one("SELECT " + WORKSPACE_COLUMNS + " FROM project_workspace WHERE owner_id=? AND workspace_name=?", (db_id(user["id"]), name.strip()))
            if existing:
                return self.workspace_view(user, existing)
            workspace_id, stamp = new_id(), now_ms()
            self.repo.execute("INSERT INTO project_workspace (id,workspace_name,description,owner_id,create_time,update_time) VALUES (?,?,?,?,?,?)",
                              (db_id(workspace_id), name.strip(), description, db_id(user["id"]), stamp, stamp))
            self.disk_path(workspace_id, "").mkdir(exist_ok=True)
            return self.workspace_view(user, self.repo.workspace(workspace_id))

    def workspace_change(self, user, body):
        workspace, _, _ = self.access(user, body.get("id"), manage=True, write=True)
        name = body.get("workspaceName", workspace["workspace_name"])
        description = body.get("description", workspace["description"])
        require(isinstance(name, str) and 1 <= len(name.strip()) <= 100)
        require(isinstance(description, str) and len(description) <= 500)
        self.repo.execute("UPDATE project_workspace SET workspace_name=?,description=?,update_time=? WHERE id=?",
                          (name.strip(), description, now_ms(), db_id(workspace["id"])))
        return self.workspace_view(user, self.repo.workspace(workspace["id"]))

    def workspace_delete(self, user, workspace_id):
        with self.lock:
            if not self.repo.workspace(workspace_id):
                return {}
            self.access(user, workspace_id, manage=True, write=True)
            path = self.disk_path(workspace_id, "")
            self.scan_safe(path)
            if path.exists():
                shutil.rmtree(path)
            with self.repo.connection() as connection:
                args = (db_id(workspace_id),)
                connection.execute("DELETE FROM workspace_node WHERE workspace_id=?", args)
                connection.execute("DELETE FROM workspace_member WHERE workspace_id=?", args)
                connection.execute("DELETE FROM folder_share WHERE workspace_id=?", args)
                connection.execute("DELETE FROM preview_ticket WHERE workspace_id=?", args)
                connection.execute("DELETE FROM project_workspace WHERE id=?", args)
            return {}

    def members(self, user, workspace_id):
        workspace, _, _ = self.access(user, workspace_id)
        rows = self.repo.all("SELECT t1." + USER_COLUMNS.replace(",", ",t1.") + ",t2.is_collaborate FROM sys_user AS t1 JOIN workspace_member AS t2 ON t2.user_id=t1.id WHERE t2.workspace_id=? AND t1.id<>? ORDER BY t1.create_time",
                             (db_id(workspace_id), db_id(workspace["owner_id"])))
        owner = self.repo.user(workspace["owner_id"])
        result = []
        if owner:
            result.append({**self.user_view(owner), "userId": owner["id"], "collaborate": True, "isOwner": True})
        result.extend({**self.user_view(row), "userId": row["id"], "collaborate": bool(row["is_collaborate"]), "isOwner": row["id"] == workspace["owner_id"]} for row in rows)
        return result

    def member_change(self, user, body):
        workspace_id = body.get("workspaceId")
        self.access(user, workspace_id, manage=True, write=True)
        target = self.repo.user(body["userId"]) if body.get("userId") else self.repo.user_by_name(body.get("userName", ""))
        require(target, 404, "USER_NOT_EXIST", "受邀账号不存在")
        collaborate = body.get("collaborate", False)
        require(isinstance(collaborate, bool))
        stamp = now_ms()
        self.repo.execute("INSERT INTO workspace_member (id,workspace_id,user_id,is_collaborate,create_time,update_time) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET is_collaborate=excluded.is_collaborate,update_time=excluded.update_time",
                          (db_id(new_id()), db_id(workspace_id), db_id(target["id"]), int(collaborate), stamp, stamp))
        return {**self.user_view(target), "userId": target["id"], "collaborate": collaborate}

    def member_delete(self, user, workspace_id, user_id):
        self.access(user, workspace_id, manage=True, write=True)
        self.repo.execute("DELETE FROM workspace_member WHERE workspace_id=? AND user_id=?", (db_id(workspace_id), db_id(user_id)))
        return {}

    def disk_path(self, workspace_id, path):
        workspace_id = str(uuid.UUID(str(workspace_id)))
        path = clean_path(path)
        root = self.config.root / "filedb"
        require(not root.is_symlink(), 403, "UNSAFE_PATH", "禁止符号链接")
        current = root
        for part in (workspace_id, *PurePosixPath(path).parts):
            if os.name == "nt" and current.is_dir():
                aliases = [child.name for child in current.iterdir() if child.name.casefold() == part.casefold()]
                require(not aliases or part in aliases, 409, "PATH_CASE_CONFLICT", "路径大小写与实际文件不一致")
            current = current / part
            require(not current.is_symlink() and not (hasattr(current, "is_junction") and current.is_junction()),
                    403, "UNSAFE_PATH", "禁止符号链接或目录联接")
        require(current.resolve().is_relative_to(root.resolve()), 403, "UNSAFE_PATH", "禁止越界路径")
        return current

    @staticmethod
    def scan_safe(path):
        if path.is_dir():
            for parent, directories, files in os.walk(path, followlinks=False):
                for name in directories + files:
                    child = Path(parent) / name
                    require(not child.is_symlink() and not (hasattr(child, "is_junction") and child.is_junction()),
                            403, "UNSAFE_PATH", "目录包含符号链接或目录联接")

    def node_writable(self, user, workspace_id, node):
        _, manager, collaborate = self.access(user, workspace_id)
        return user["user_role"] in ("admin", "editor") and (manager or collaborate or not node or node["owner_id"] == user["id"])

    def check_write(self, user, workspace_id, path, recursive=False):
        self.access(user, workspace_id, write=True)
        nodes = self.repo.nodes(workspace_id, path) if recursive else [self.repo.node(workspace_id, path)]
        for node in nodes:
            if node:
                require(self.node_writable(user, workspace_id, node), 403, "FOREIGN_CONTENT", "操作将影响他人的内容")

    def ensure_parents(self, user, workspace_id, path):
        parts = PurePosixPath(path).parts
        for index in range(1, len(parts)):
            relative = "/".join(parts[:index])
            disk = self.disk_path(workspace_id, relative)
            require(not disk.exists() or disk.is_dir(), 409, "PATH_CONFLICT", "父路径不是目录")
            if not disk.exists():
                disk.mkdir()
                self.record_node(user, workspace_id, relative, "folder")

    def record_node(self, user, workspace_id, path, kind, connection=None):
        stamp = now_ms()
        execute = connection.execute if connection is not None else self.repo.execute
        execute("INSERT INTO workspace_node (id,workspace_id,node_path,node_kind,owner_id,create_time,update_time) VALUES (?,?,?,?,?,?,?) ON CONFLICT(workspace_id,node_path) DO UPDATE SET update_time=excluded.update_time",
                (db_id(new_id()), db_id(workspace_id), path, kind, db_id(user["id"]), stamp, stamp))

    def listing(self, workspace_id, path, user=None, page_index=1, page_size=20, search="", sort="name", order="asc"):
        path = clean_path(path)
        page_index, page_size = max(1, int(page_index)), min(200, max(1, int(page_size)))
        require(isinstance(search, str) and len(search) <= 240 and "/" not in search)
        require(sort in ("name", "size", "updateTime") and order in ("asc", "desc"))
        if user:
            self.access(user, workspace_id)
        disk = self.disk_path(workspace_id, path)
        require(disk.is_dir(), 404, "FOLDER_NOT_EXIST", "目录不存在")
        # 物理目录仅作安全巡检，业务结果由SQL按直接子层筛选分页。
        sizes = {}
        for item in disk.iterdir():
            relative = path + "/" + item.name if path else item.name
            self.disk_path(workspace_id, relative)
            if sort == "size":
                sizes[relative] = 0 if item.is_dir() else item.stat().st_size
        total, nodes = self.repo.directory_page(workspace_id, path, page_index, page_size, search, sort, order, sizes)
        entries = []
        for node in nodes:
            item = self.disk_path(workspace_id, node["node_path"])
            require(item.exists(), 409, "STORAGE_INCONSISTENT", "磁盘文件与元数据不一致")
            stat = item.stat()
            entries.append({"name": item.name, "path": node["node_path"], "kind": node["node_kind"],
                            "size": 0 if item.is_dir() else stat.st_size, "ownerId": node["owner_id"],
                            "canWrite": bool(user and self.node_writable(user, workspace_id, node)),
                            "updateTime": node["update_time"]})
        entry = self.repo.entry_node(workspace_id, path)
        return {"path": path, "entries": entries, "entryPath": entry["node_path"] if entry else None,
                "pageIndex": page_index, "pageSize": page_size, "totalCount": total,
                "totalPage": (total + page_size - 1) // page_size, "data": entries}

    def folder_create(self, user, body):
        workspace_id, path = body.get("workspaceId"), clean_path(body.get("path"), False)
        with self.lock:
            self.check_write(user, workspace_id, path)
            disk = self.disk_path(workspace_id, path)
            require(not disk.exists() or disk.is_dir(), 409, "PATH_CONFLICT", "路径已被文件占用")
            self.ensure_parents(user, workspace_id, path)
            if not disk.exists():
                disk.mkdir()
                self.record_node(user, workspace_id, path, "folder")
            return {"path": path}

    def file_write(self, user, body):
        content = body.get("content")
        require(isinstance(content, str))
        return self.upload(user, {"workspaceId": body.get("workspaceId"), "path": "", "conflictPolicy": "overwrite",
                                 "files": [{"path": body.get("path"), "contentBase64": base64.b64encode(content.encode()).decode()}]})

    def upload(self, user, body):
        workspace_id, root = body.get("workspaceId"), clean_path(body.get("path", ""))
        files, policy, request_id = body.get("files"), body.get("conflictPolicy", "ask"), body.get("requestId")
        require(isinstance(policy, str) and policy in ("ask", "overwrite", "rename"))
        require(isinstance(files, list) and 1 <= len(files) <= 500)
        require(request_id is None or isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,100}", request_id),
                msg="requestId必须为16至100位随机请求标识")
        require(policy != "rename" or request_id is not None, msg="保留两份必须提供requestId以支持安全重试")
        # 同根目录各Service共用锁；数据库写事务串行幂等占位与节点提交。
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            user = self.repo.user(user["id"])
            require(user and not user["is_disabled"], 401, "AUTH_REQUIRED", "账号已禁用或不存在")
            prepared, total, conflicts = [], 0, []
            stamp = now_ms()
            self.access(user, workspace_id, write=True)
            for item in files:
                require(isinstance(item, dict))
                relative = clean_path(item.get("path"), False)
                path = clean_path(root + "/" + relative if root else relative, False)
                # 即使选择保留两份，也不能通过重命名绕过原路径归属检查。
                self.check_write(user, workspace_id, path, recursive=True)
                disk = self.disk_path(workspace_id, path)
                require(not disk.exists() or disk.is_file(), 409, "PATH_CONFLICT", "路径已被目录或特殊文件占用")
                for parent in PurePosixPath(path).parents:
                    parent_disk = self.disk_path(workspace_id, str(parent) if str(parent) != "." else "")
                    require(not parent_disk.exists() or parent_disk.is_dir(), 409, "PATH_CONFLICT", "父路径不是目录")
                encoded = item.get("contentBase64")
                require(isinstance(encoded, str))
                try:
                    content = base64.b64decode(encoded, validate=True)
                except (ValueError, TypeError):
                    raise BizError(400, "PARAM_INVALID", "文件内容不是合法Base64") from None
                total += len(content)
                require(total <= self.config.max_body_bytes, 413, "PAYLOAD_TOO_LARGE", "上传内容过大")
                prepared.append((path, disk, content))
                if disk.exists():
                    conflicts.append({"path": path})
            paths = [os.path.normcase(item[0]).replace("\\", "/") for item in prepared]
            require(len(set(paths)) == len(paths), msg="上传包含重复或大小写冲突路径")
            require(not any(a != b and beneath(a, b) for a in paths for b in paths), msg="上传文件路径互相冲突")
            # Windows尚未创建的父目录同样不能出现大小写别名。
            directories = {}
            for path, _, _ in prepared:
                for parent in PurePosixPath(path).parents:
                    key = os.path.normcase(str(parent)).replace("\\", "/")
                    require(key not in directories or directories[key] == str(parent), msg="上传父目录大小写互相冲突")
                    directories[key] = str(parent)
            fingerprint = digest(json.dumps({"workspaceId": workspace_id, "path": root, "policy": policy,
                "files": [(path, hashlib.sha256(content).hexdigest()) for path, _, content in prepared]}, sort_keys=True))
            if request_id:
                previous = connection.execute("SELECT workspace_id,request_hash,response_json FROM upload_request WHERE user_id=? AND request_id=?",
                                              (db_id(user["id"]), request_id)).fetchone()
                if previous:
                    require(previous["request_hash"] == fingerprint, 409, "REQUEST_CONFLICT", "同一requestId不能用于不同上传参数")
                    result = json.loads(previous["response_json"])
                    for item in result["files"]:
                        self.check_write(user, workspace_id, item["targetPath"], recursive=True)
                        self.disk_path(workspace_id, item["targetPath"])
                    return result
            result = {"count": 0, "requiresConfirmation": bool(conflicts and policy == "ask"),
                      "conflictPolicy": policy, "conflicts": conflicts, "files": [], "uploadTime": stamp}
            if result["requiresConfirmation"]:
                return result
            reserved = set(paths) | set(directories)
            targets = []
            for source, disk, content in prepared:
                target, overwritten = source, disk.exists()
                if overwritten and policy == "rename":
                    original = PurePosixPath(source)
                    suffix = original.suffix
                    stem = original.name[:-len(suffix)] if suffix else original.name
                    sequence = 0
                    while True:
                        tag = "_" + str(stamp) + ("_" + str(sequence) if sequence else "")
                        name = stem[:240 - len(suffix) - len(tag)] + tag + suffix
                        target = clean_path(str(original.with_name(name)), False)
                        disk = self.disk_path(workspace_id, target)
                        if os.path.normcase(target).replace("\\", "/") not in reserved and not disk.exists() and not self.repo.node(workspace_id, target):
                            break
                        sequence += 1
                    self.check_write(user, workspace_id, target, recursive=True)
                    overwritten = False
                reserved.add(os.path.normcase(target).replace("\\", "/"))
                targets.append((target, disk, content))
                result["files"].append({"sourcePath": source, "targetPath": target, "overwritten": overwritten})
            result["count"] = len(targets)
            created_directories, replaced, staged = [], [], []
            # 同文件系统独立暂存；全部内容和旧文件备份就绪后才改目标。
            staging = tempfile.mkdtemp(prefix=".upload-", dir=self.config.root / "filedb")
            cleanup_staging = True
            try:
                try:
                    for index, (path, disk, content) in enumerate(targets):
                        temporary = Path(staging) / (str(index) + ".new")
                        with temporary.open("xb") as stream:
                            stream.write(content)
                        backup = Path(staging) / (str(index) + ".old") if disk.exists() else None
                        if backup is not None:
                            shutil.copy2(disk, backup)
                        staged.append((path, disk, temporary, backup))
                    for path, disk, temporary, backup in staged:
                        parts = PurePosixPath(path).parts
                        for index in range(1, len(parts)):
                            relative = "/".join(parts[:index])
                            parent_disk = self.disk_path(workspace_id, relative)
                            if not parent_disk.exists():
                                parent_disk.mkdir()
                                created_directories.append(parent_disk)
                                self.record_node(user, workspace_id, relative, "folder", connection)
                        os.replace(temporary, disk)
                        replaced.append((disk, backup))
                        self.record_node(user, workspace_id, path, "file", connection)
                    if request_id:
                        connection.execute("INSERT INTO upload_request (id,user_id,workspace_id,request_id,request_hash,response_json,create_time,update_time) VALUES (?,?,?,?,?,?,?,?)",
                                           (db_id(new_id()), db_id(user["id"]), db_id(workspace_id), request_id, fingerprint,
                                            json.dumps(result, ensure_ascii=False), stamp, stamp))
                    # 显式commit置于补偿范围内，节点和幂等结果同事务提交。
                    connection.commit()
                except Exception:
                    recovery_errors = []
                    try:
                        connection.rollback()
                    except Exception as exc:
                        recovery_errors.append(type(exc).__name__)
                    for disk, backup in reversed(replaced):
                        try:
                            if backup is None:
                                disk.unlink(missing_ok=True)
                            else:
                                os.replace(backup, disk)
                        except Exception as exc:
                            recovery_errors.append(type(exc).__name__)
                    for directory in reversed(created_directories):
                        try:
                            directory.rmdir()
                        except Exception as exc:
                            recovery_errors.append(type(exc).__name__)
                    if recovery_errors:
                        # 任何补偿失败都保留剩余备份，不因首项失败跳过其他文件。
                        cleanup_staging = False
                        LOGGER.error(json.dumps({"event": "upload-recovery-required", "staging": staging,
                                                 "errorTypes": recovery_errors}))
                        raise BizError(500, "UPLOAD_RECOVERY_REQUIRED", "上传恢复未完成，请管理员检查保留的恢复备份") from None
                    raise
            finally:
                if cleanup_staging:
                    try:
                        shutil.rmtree(staging)
                    except OSError as exc:
                        # 已提交结果不因暂存清理失败而变成失败响应。
                        LOGGER.warning(json.dumps({"event": "upload-staging-cleanup-failed", "staging": staging,
                                                   "errorType": type(exc).__name__}))
            return result

    def file_read(self, user, workspace_id, path):
        path = clean_path(path, False)
        self.access(user, workspace_id)
        disk = self.disk_path(workspace_id, path)
        require(disk.is_file(), 404, "FILE_NOT_EXIST", "文件不存在")
        require(disk.stat().st_size <= 4 * 1024 * 1024, 413, "TEXT_TOO_LARGE", "在线编辑只支持4MB以内文本")
        try:
            content = disk.read_text(encoding="utf-8")
        except UnicodeError:
            raise BizError(400, "NOT_TEXT_FILE", "文件不是UTF-8文本") from None
        return {"path": path, "content": content,
                "canWrite": self.node_writable(user, workspace_id, self.repo.node(workspace_id, path))}

    def node_delete(self, user, workspace_id, path, kind):
        path = clean_path(path, False)
        with self.lock:
            self.check_write(user, workspace_id, path, recursive=True)
            disk = self.disk_path(workspace_id, path)
            if not disk.exists():
                return {}
            require((kind == "folder") == disk.is_dir(), 400, "PATH_KIND_INVALID", "文件类型不匹配")
            self.scan_safe(disk)
            if disk.is_dir():
                shutil.rmtree(disk)
            else:
                disk.unlink()
            with self.repo.connection() as connection:
                for node in self.repo.nodes(workspace_id, path):
                    connection.execute("DELETE FROM workspace_node WHERE id=?", (db_id(node["id"]),))
                self.invalidate_roots(connection, workspace_id, path)
            return {}

    def invalidate_roots(self, connection, workspace_id, path):
        args = (db_id(workspace_id), path, path + "/", path + "0")
        connection.execute("DELETE FROM folder_share WHERE workspace_id=? AND (root_path=? OR (root_path>=? AND root_path<?))", args)
        connection.execute("DELETE FROM preview_ticket WHERE workspace_id=? AND (root_path=? OR (root_path>=? AND root_path<?))", args)

    def node_move(self, user, body, kind):
        workspace_id = body.get("workspaceId")
        path, new_path = clean_path(body.get("path"), False), clean_path(body.get("newPath"), False)
        require(not beneath(new_path, path) or new_path == path, msg="不能移动到自己的子目录")
        with self.lock:
            self.check_write(user, workspace_id, path, recursive=True)
            disk, target = self.disk_path(workspace_id, path), self.disk_path(workspace_id, new_path)
            if path == new_path:
                return {"path": new_path}
            if not disk.exists() and target.exists():
                self.check_write(user, workspace_id, new_path, recursive=True)
                return {"path": new_path}
            require(disk.exists(), 404, "FILE_NOT_EXIST", "源路径不存在")
            require((kind == "folder") == disk.is_dir(), 400, "PATH_KIND_INVALID", "文件类型不匹配")
            require(not target.exists(), 409, "PATH_CONFLICT", "目标路径已存在")
            self.scan_safe(disk)
            self.ensure_parents(user, workspace_id, new_path)
            nodes = self.repo.nodes(workspace_id, path)
            disk.rename(target)
            with self.repo.connection() as connection:
                for node in nodes:
                    replacement = new_path + node["node_path"][len(path):]
                    connection.execute("UPDATE workspace_node SET node_path=?,update_time=? WHERE id=?", (replacement, now_ms(), db_id(node["id"])))
                self.invalidate_roots(connection, workspace_id, path)
            return {"path": new_path}

    def share_view(self, row):
        return {"id": row["id"], "token": row["share_token"], "workspaceId": row["workspace_id"],
                "path": row["root_path"], "expireTime": row["expire_time"], "createTime": row["create_time"],
                "shareUrl": self.config.public_origin + "/baba-share/s/" + row["share_token"]}

    def share_create(self, user, body):
        workspace_id, path = body.get("workspaceId"), clean_path(body.get("path", ""))
        self.access(user, workspace_id, write=True)
        require(self.disk_path(workspace_id, path).is_dir(), 404, "FOLDER_NOT_EXIST", "目录不存在")
        hours = body.get("expireHours", 0)
        require(type(hours) is int and 0 <= hours <= 87600)
        with self.lock:
            existing = self.repo.one("SELECT " + SHARE_COLUMNS + " FROM folder_share WHERE owner_id=? AND workspace_id=? AND root_path=? AND (expire_time IS NULL OR expire_time>?) ORDER BY create_time DESC LIMIT 1",
                                     (db_id(user["id"]), db_id(workspace_id), path, now_ms()))
            if existing and ((existing["expire_time"] is None and hours == 0) or
                             (existing["expire_time"] is not None and existing["expire_time"] - existing["create_time"] == hours * 3600000)):
                return self.share_view(existing)
            share_id, token, stamp = new_id(), secrets.token_urlsafe(32), now_ms()
            expiry = stamp + hours * 3600000 if hours else None
            self.repo.execute("INSERT INTO folder_share (id,share_token,workspace_id,owner_id,root_path,expire_time,create_time,update_time) VALUES (?,?,?,?,?,?,?,?)",
                              (db_id(share_id), token, db_id(workspace_id), db_id(user["id"]), path, expiry, stamp, stamp))
            return self.share_view(self.repo.one("SELECT " + SHARE_COLUMNS + " FROM folder_share WHERE id=?", (db_id(share_id),)))

    def shares(self, user):
        rows = self.repo.all("SELECT " + SHARE_COLUMNS + " FROM folder_share WHERE owner_id=? ORDER BY create_time DESC", (db_id(user["id"]),))
        return [self.share_view(row) for row in rows]

    def share_delete(self, user, share_id):
        share = self.repo.one("SELECT " + SHARE_COLUMNS + " FROM folder_share WHERE id=?", (db_id(share_id),))
        if share:
            require(share["owner_id"] == user["id"] or user["user_role"] == "admin", 403, "PERMISSION_DENIED", "无权撤销分享")
            self.repo.execute("DELETE FROM folder_share WHERE id=?", (db_id(share_id),))
        return {}

    def share_access(self, token):
        require(isinstance(token, str) and 20 <= len(token) <= 100, 404, "SHARE_NOT_EXIST", "分享不存在或已失效")
        share = self.repo.one("SELECT " + SHARE_COLUMNS + " FROM folder_share WHERE share_token=? AND (expire_time IS NULL OR expire_time>?)", (token, now_ms()))
        require(share, 404, "SHARE_NOT_EXIST", "分享不存在或已失效")
        owner = self.repo.user(share["owner_id"])
        require(owner and not owner["is_disabled"], 404, "SHARE_NOT_EXIST", "分享不存在或已失效")
        try:
            self.access(owner, share["workspace_id"])
        except BizError:
            raise BizError(404, "SHARE_NOT_EXIST", "分享不存在或已失效") from None
        return share

    def share_detail(self, token, path="", page_index=1, page_size=20):
        share = self.share_access(token)
        relative = clean_path(path)
        full = share["root_path"] + "/" + relative if share["root_path"] and relative else share["root_path"] or relative
        listing = self.listing(share["workspace_id"], full, page_index=page_index, page_size=page_size)
        root = share["root_path"]
        def relative_to_root(value):
            return value[len(root) + 1:] if root else value
        listing["path"] = relative
        for entry in listing["entries"]:
            entry["path"] = relative_to_root(entry["path"])
            entry["ownerId"] = None
        if listing["entryPath"]:
            listing["entryPath"] = relative_to_root(listing["entryPath"])
        preview_base = self.config.public_origin + "/baba-share/preview/s/" + token + "/"
        preview = preview_base + quote(listing["entryPath"] or relative, safe="/")
        if not listing["entryPath"] and relative:
            preview += "/"
        view = self.share_view(share)
        # 匿名目录响应不泄露内部工作空间或所有者标识。
        view.pop("workspaceId")
        view["path"] = ""
        return {"share": view, "listing": listing, "previewUrl": preview, "previewBaseUrl": preview_base}

    def ticket(self, user, body):
        workspace_id, path = body.get("workspaceId"), clean_path(body.get("path", ""))
        self.access(user, workspace_id)
        listing = self.listing(workspace_id, path, user)
        token, stamp = secrets.token_urlsafe(32), now_ms()
        expiry = stamp + self.config.ticket_seconds * 1000
        self.repo.execute("DELETE FROM preview_ticket WHERE expire_time<=?", (stamp,))
        self.repo.execute("INSERT INTO preview_ticket (id,ticket_hash,workspace_id,user_id,root_path,expire_time,create_time,update_time) VALUES (?,?,?,?,?,?,?,?)",
                          (db_id(new_id()), digest(token), db_id(workspace_id), db_id(user["id"]), path, expiry, stamp, stamp))
        entry = listing["entryPath"]
        relative_entry = entry[len(path) + 1:] if path and entry else entry
        preview_base = self.config.public_origin + "/baba-share/preview/p/" + token + "/"
        return {"previewUrl": preview_base + quote(relative_entry or "", safe="/"),
                "previewBaseUrl": preview_base, "expireTime": expiry, "entryPath": entry}

    def preview_resource(self, kind, token, relative):
        relative = clean_path(relative.rstrip("/"))
        if kind == "s":
            source = self.share_access(token)
        else:
            source = self.repo.one("SELECT workspace_id,user_id,root_path,expire_time FROM preview_ticket WHERE ticket_hash=? AND expire_time>?", (digest(token), now_ms()))
            require(source, 404, "PREVIEW_EXPIRED", "预览凭据已失效")
            user = self.repo.user(source["user_id"])
            require(user and not user["is_disabled"], 404, "PREVIEW_EXPIRED", "预览凭据已失效")
            self.access(user, source["workspace_id"])
        root = source["root_path"]
        path = root + "/" + relative if root and relative else root or relative
        disk = self.disk_path(source["workspace_id"], path)
        if disk.is_dir():
            listing = self.listing(source["workspace_id"], path)
            require(listing["entryPath"], 404, "ENTRY_NOT_EXIST", "目录内没有index.html或home.html")
            return disk, PurePosixPath(listing["entryPath"]).name
        require(disk.is_file(), 404, "FILE_NOT_EXIST", "文件不存在")
        return disk, None
