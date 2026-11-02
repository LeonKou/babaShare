"""认证、权限、真实文件与分享业务。"""
import base64
import hashlib
import hmac
from html import escape
import json
import logging
import os
import re
import secrets
import shutil
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr
import sqlite3
import stat
import threading
import tempfile
import uuid
from pathlib import Path, PurePosixPath
from urllib.parse import quote, urlsplit

LOGGER = logging.getLogger("baba-share")

from .config import normalize_origin
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
    require(isinstance(password, str) and 6 <= len(password) <= 256,
            msg="密码长度必须为6至256位")
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
        self.mail_test_time = 0
        self.mail_slots = threading.BoundedSemaphore(4)
        self.activation_attempts = {}

    def install_detail(self):
        count = self.repo.one("SELECT count(*) AS user_count FROM sys_user")["user_count"]
        setting = self.repo.one("SELECT is_registration_enabled,is_email_registration_enabled FROM app_setting LIMIT 1")
        return {"setupRequired": count == 0, "registrationEnabled": bool(setting["is_registration_enabled"]),
                "emailRegistrationEnabled": bool(setting["is_email_registration_enabled"])}

    @staticmethod
    def user_view(user):
        return {"id": user["id"], "userName": user["user_name"], "nickname": user["nickname"],
                "role": user["user_role"], "isDisabled": bool(user["is_disabled"]),
                "email": user.get("email"), "emailVerified": bool(user.get("is_email_verified")),
                "createTime": user["create_time"], "updateTime": user["update_time"]}

    def account(self, body, mode="admin", actor=None):
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            count = connection.execute("SELECT count(*) AS user_count FROM sys_user").fetchone()["user_count"]
            setting = connection.execute("SELECT is_registration_enabled,is_email_registration_enabled FROM app_setting LIMIT 1").fetchone()
            state = {"setupRequired": count == 0, "registrationEnabled": bool(setting["is_registration_enabled"]),
                     "emailRegistrationEnabled": bool(setting["is_email_registration_enabled"])}
            if mode == "setup":
                require(state["setupRequired"], 409, "SETUP_COMPLETED", "初始化已经完成")
                role = "admin"
            elif mode == "registration":
                require(not state["setupRequired"] and state["registrationEnabled"], 403,
                        "REGISTRATION_DISABLED", "注册功能未开放")
                require(not state["emailRegistrationEnabled"], 403,
                        "EMAIL_VERIFICATION_REQUIRED", "请通过邮箱激活完成注册")
                role = "editor"
            else:
                self.admin(actor)
                self.active_admin(connection, actor)
                role = body.get("role", "viewer")
            name = body.get("userName", "")
            require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.@-]{3,64}", name),
                    msg="账号为3至64位字母数字或_.@-")
            require(role in ("admin", "editor", "viewer"))
            nickname = body.get("nickname", name)
            require(isinstance(nickname, str) and 1 <= len(nickname) <= 64)
            # 邮箱所有权仅由登录用户的验证流程建立，管理员建号也不能代为绑定。
            require(body.get("email") in (None, ""), 400, "EMAIL_VERIFICATION_REQUIRED", "请由账户本人登录后验证绑定邮箱")
            email = None
            existing = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE user_name=?", (name,)).fetchone())
            if existing and mode == "admin":
                require(existing["user_role"] == role and existing["nickname"] == nickname and
                        ("email" not in body or existing["email"] == email),
                        409, "USER_EXISTS", "账号已经存在")
                return self.user_view(existing)
            require(existing is None, 409, "USER_EXISTS", "账号已经存在")
            user_id, stamp = new_id(), now_ms()
            hashed = password_hash(body.get("password"))
            connection.execute("INSERT INTO sys_user (id,user_name,nickname,password_hash,user_role,is_disabled,email,create_time,update_time) VALUES (?,?,?,?,?,0,?,?,?)",
                               (db_id(user_id), name, nickname, hashed, role, email, stamp, stamp))
            return self.user_view(public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?", (db_id(user_id),)).fetchone()))

    def new_session(self, user_id, connection=None):
        if connection is None:
            with self.lock, self.repo.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                return self.new_session(user_id, connection)
        actor = connection.execute("SELECT is_disabled FROM sys_user WHERE id=?", (db_id(user_id),)).fetchone()
        require(actor and not actor["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
        token, stamp = secrets.token_urlsafe(32), now_ms()
        connection.execute("DELETE FROM auth_session WHERE expire_time<=?", (stamp,))
        connection.execute("INSERT INTO auth_session (id,session_hash,user_id,expire_time,create_time,update_time) VALUES (?,?,?,?,?,?)",
                           (db_id(new_id()), digest(token), db_id(user_id),
                            stamp + self.config.session_hours * 3600000, stamp, stamp))
        return token

    def login(self, body, client_ip):
        name = body.get("userName", "")
        require(isinstance(name, str) and len(name) <= 254)
        key, stamp = (client_ip, name.casefold()), now_ms()
        with self.lock:
            attempts = [at for at in self.login_attempts.get(key, []) if at > stamp - 300000]
            require(len(attempts) < 10, 429, "LOGIN_THROTTLED", "登录失败过多，请稍后重试")
            self.login_attempts[key] = attempts + [stamp]
        user = self.repo.user_by_name(name)
        valid = password_valid(body.get("password"), user["password_hash"]) if user else password_valid(body.get("password"), "00" * 16 + ":" + "00" * 32)
        require(user and valid and not user["is_disabled"], 401, "LOGIN_FAILED", "账号或密码错误，或账号被禁用")
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            current = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?", (db_id(user["id"]),)).fetchone())
            require(current and not current["is_disabled"] and current["password_hash"] == user["password_hash"] and
                    current["user_name"].lower() == name.lower(), 401, "LOGIN_FAILED", "账号或密码已变化，请重新登录")
            session = self.new_session(current["id"], connection)
            self.login_attempts.pop(key, None)
        return self.user_view(current), session

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
            # 与创建及删除串行；恢复只读取，不生成主密钥或新MCP凭据。
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
            current = connection.execute("SELECT is_disabled FROM sys_user WHERE id=?", (db_id(user["id"]),)).fetchone()
            require(current and not current["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
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

    def mcp_key_delete(self, user, key_id):
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT user_id FROM auth_mcp_key WHERE id=?", (db_id(key_id),)).fetchone()
            if row:
                require(row["user_id"] == db_id(user["id"]), 404, "MCP_KEY_NOT_EXIST", "密钥不存在")
                connection.execute("DELETE FROM auth_mcp_key WHERE id=? AND user_id=?",
                                   (db_id(key_id), db_id(user["id"])))
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
        require(isinstance(body, dict) and not (set(body) - {"id", "userName", "nickname", "role", "isDisabled", "password"}))
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.active_admin(connection, actor)
            target = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?",
                                                   (db_id(body.get("id")),)).fetchone())
            require(target, 404, "USER_NOT_EXIST", "账号不存在")
            name = body.get("userName", target["user_name"])
            require(isinstance(name, str) and (re.fullmatch(r"[A-Za-z0-9_.@-]{3,64}", name) or self.valid_email(name)),
                    msg="登录账号须为3至64位字母数字或_.@-，或最多254字符的有效邮箱")
            role = body.get("role", target["user_role"])
            disabled = body.get("isDisabled", bool(target["is_disabled"]))
            require(role in ("admin", "editor", "viewer") and isinstance(disabled, bool))
            require(not (target["id"] == actor["id"] and disabled), 409,
                    "SELF_DISABLE_FORBIDDEN", "不能禁用当前登录的本人账户")
            if target["user_role"] == "admin" and not target["is_disabled"] and (role != "admin" or disabled):
                count = connection.execute("SELECT count(*) AS user_count FROM sys_user WHERE user_role='admin' AND is_disabled=0").fetchone()["user_count"]
                require(count > 1, 409, "LAST_ADMIN", "必须保留至少一个可用管理员")
            nickname = body.get("nickname", target["nickname"])
            require(isinstance(nickname, str) and 1 <= len(nickname) <= 64 and nickname.strip())
            password = body.get("password", "")
            require(isinstance(password, str))
            hashed = password_hash(password) if password else target["password_hash"]
            try:
                connection.execute("UPDATE sys_user SET user_name=?,user_role=?,is_disabled=?,nickname=?,password_hash=?,update_time=? WHERE id=?",
                                   (name, role, int(disabled), nickname, hashed, now_ms(), db_id(target["id"])))
            except sqlite3.IntegrityError:
                raise BizError(409, "USER_EXISTS", "登录账号已经存在") from None
            if disabled or password:
                connection.execute("DELETE FROM auth_session WHERE user_id=?", (db_id(target["id"]),))
                connection.execute("DELETE FROM account_email_token WHERE user_id=?", (db_id(target["id"]),))
            updated = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?",
                                                    (db_id(target["id"]),)).fetchone())
            return self.user_view(updated)

    def user_delete(self, actor, user_id):
        self.admin(actor)
        target_id = db_id(user_id)
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.active_admin(connection, actor)
            target = connection.execute("SELECT id,user_name,user_role,is_disabled FROM sys_user WHERE id=?", (target_id,)).fetchone()
            if not target:
                return {}
            require(target_id != db_id(actor["id"]), 409, "SELF_DELETE_FORBIDDEN", "不能删除当前登录的本人账户")
            if target["user_role"] == "admin" and not target["is_disabled"]:
                count = connection.execute("SELECT count(*) AS user_count FROM sys_user WHERE user_role='admin' AND is_disabled=0").fetchone()["user_count"]
                require(count > 1, 409, "LAST_ADMIN", "必须保留至少一个可用管理员")
            stamp = now_ms()
            connection.execute("UPDATE project_workspace SET owner_id=NULL,update_time=? WHERE owner_id=?", (stamp, target_id))
            connection.execute("UPDATE project_workspace SET creator_id=NULL WHERE creator_id=?", (target_id,))
            connection.execute("UPDATE workspace_node SET owner_id=NULL,update_time=? WHERE owner_id=?", (stamp, target_id))
            connection.execute("DELETE FROM auth_session WHERE user_id=?", (target_id,))
            connection.execute("DELETE FROM auth_mcp_key WHERE user_id=?", (target_id,))
            connection.execute("DELETE FROM workspace_member WHERE user_id=?", (target_id,))
            connection.execute("DELETE FROM upload_request WHERE user_id=?", (target_id,))
            connection.execute("DELETE FROM folder_share WHERE owner_id=?", (target_id,))
            connection.execute("DELETE FROM workspace_invitation WHERE creator_id=?", (target_id,))
            connection.execute("DELETE FROM preview_ticket WHERE user_id=?", (target_id,))
            connection.execute("DELETE FROM email_activation WHERE user_name=?", (target["user_name"],))
            connection.execute("DELETE FROM account_email_token WHERE user_id=?", (target_id,))
            connection.execute("DELETE FROM sys_user WHERE id=?", (target_id,))
        return {}

    @staticmethod
    def active_admin(connection, actor):
        current = connection.execute("SELECT user_role,is_disabled FROM sys_user WHERE id=?", (db_id(actor["id"]),)).fetchone()
        require(current and not current["is_disabled"] and current["user_role"] == "admin", 403,
                "PERMISSION_DENIED", "仅有效管理员可操作")

    def workspace_admin(self, actor, query):
        self.admin(actor)
        relation, owner_status = query.get("relation", "any"), query.get("ownerStatus", "all")
        require(relation in ("any", "owner", "member") and owner_status in ("all", "system", "account"))
        user_id = query.get("userId", "")
        if user_id:
            db_id(user_id)
        search, creator = query.get("search", ""), query.get("creator", "")
        require(isinstance(search, str) and len(search) <= 100 and isinstance(creator, str) and len(creator) <= 64)
        page_index, page_size = max(1, int(query.get("pageIndex", 1))), min(200, max(1, int(query.get("pageSize", 20))))
        target_id = db_id(user_id) if user_id else None
        # 前缀按原文匹配，转义LIKE通配符，不允许将用户输入拼成SQL。
        prefix = lambda value: value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        conditions = " WHERE (? IS NULL OR ((? IN ('any','owner') AND t1.owner_id=?) OR (? IN ('any','member') AND (t1.owner_id IS NULL OR t1.owner_id<>?) AND EXISTS (SELECT id FROM workspace_member AS t2 WHERE t2.workspace_id=t1.id AND t2.user_id=?)))) AND (?='all' OR (?='system' AND t1.owner_id IS NULL) OR (?='account' AND t1.owner_id IS NOT NULL)) AND t1.workspace_name LIKE ? ESCAPE '\\' AND t1.creator_nickname LIKE ? ESCAPE '\\'"
        args = (target_id, relation, target_id, relation, target_id, target_id,
                owner_status, owner_status, owner_status, prefix(search), prefix(creator))
        with self.repo.connection() as connection:
            connection.execute("BEGIN")
            self.active_admin(connection, actor)
            if target_id:
                require(connection.execute("SELECT id FROM sys_user WHERE id=?", (target_id,)).fetchone(),
                        404, "USER_NOT_EXIST", "账号不存在")
            total = connection.execute("SELECT count(*) AS workspace_count FROM project_workspace AS t1" + conditions, args).fetchone()["workspace_count"]
            if not total:
                return {"pageIndex": page_index, "pageSize": page_size, "totalCount": 0, "totalPage": 0, "data": []}
            rows = [public_row(row) for row in connection.execute("SELECT t1." + WORKSPACE_COLUMNS.replace(",", ",t1.") + " FROM project_workspace AS t1" + conditions + " ORDER BY t1.create_time DESC,t1.id LIMIT ? OFFSET ?", args + (page_size, (page_index - 1) * page_size))]
            page_ids = [db_id(row["id"]) for row in rows]
            owner_ids = [db_id(row["owner_id"]) for row in rows if row["owner_id"]]
            users = {row["id"]: row for row in (public_row(row) for row in connection.execute("SELECT id,user_name,nickname,user_role,is_disabled,create_time,update_time FROM sys_user WHERE id IN (" + ",".join("?" for _ in owner_ids) + ")", owner_ids))} if owner_ids else {}
            membership = [public_row(row) for row in connection.execute("SELECT t1.workspace_id,t1.is_collaborate,t2.id,t2.user_name,t2.nickname,t2.user_role,t2.is_disabled,t2.create_time,t2.update_time FROM workspace_member AS t1 JOIN sys_user AS t2 ON t2.id=t1.user_id WHERE t1.workspace_id IN (" + ",".join("?" for _ in page_ids) + ") ORDER BY t2.create_time,t2.id", page_ids)] if page_ids else []
        by_workspace = {}
        for member in membership:
            by_workspace.setdefault(member["workspace_id"], []).append({**self.user_view(member), "userId": member["id"], "collaborate": bool(member["is_collaborate"]), "isOwner": False})
        result = []
        for row in rows:
            owner = users.get(row["owner_id"])
            members = [member for member in by_workspace.get(row["id"], []) if member["id"] != row["owner_id"]]
            if owner:
                members.insert(0, {**self.user_view(owner), "userId": owner["id"], "collaborate": True, "isOwner": True})
            result.append({"id": row["id"], "workspaceName": row["workspace_name"], "description": row["description"],
                           "ownerId": row["owner_id"], "owner": self.user_view(owner) if owner else None,
                           "ownerStatus": "system" if row["owner_id"] is None else "account",
                           "creatorId": row["creator_id"], "creatorNickname": row["creator_nickname"],
                           "members": members, "memberCount": len(members),
                           "collaboratorCount": sum(member["collaborate"] and not member["isDisabled"] and member["role"] in ("admin", "editor") for member in members),
                           "createTime": row["create_time"], "updateTime": row["update_time"]})
        return {"pageIndex": page_index, "pageSize": page_size, "totalCount": total,
                "totalPage": (total + page_size - 1) // page_size, "data": result}

    def workspace_ownership(self, actor, body):
        self.admin(actor)
        require(isinstance(body, dict) and set(body) == {"id", "ownerId"})
        workspace_id, owner_id = db_id(body["id"]), db_id(body["ownerId"])
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.active_admin(connection, actor)
            row = connection.execute("SELECT owner_id,workspace_name FROM project_workspace WHERE id=?", (workspace_id,)).fetchone()
            require(row, 404, "WORKSPACE_NOT_EXIST", "工作空间不存在")
            target = connection.execute("SELECT user_role,is_disabled FROM sys_user WHERE id=?", (owner_id,)).fetchone()
            require(target and not target["is_disabled"] and target["user_role"] in ("admin", "editor"), 400,
                    "OWNER_INVALID", "接收人必须是有效协作者或管理员，不能为只读成员")
            if row["owner_id"] == owner_id:
                return {}
            conflict = connection.execute("SELECT id FROM project_workspace WHERE owner_id=? AND workspace_name=? AND id<>?",
                                          (owner_id, row["workspace_name"], workspace_id)).fetchone()
            require(not conflict, 409, "WORKSPACE_NAME_CONFLICT", "接收人已有同名工作空间，请先处理重名；不会覆盖或自动改名")
            stamp = now_ms()
            connection.execute("UPDATE project_workspace SET owner_id=?,update_time=? WHERE id=?", (owner_id, stamp, workspace_id))
            # 仅转交系统托管节点与原所有者节点；其他成员的节点及成员配置保持原样。
            connection.execute("UPDATE workspace_node SET owner_id=?,update_time=? WHERE workspace_id=? AND (owner_id IS NULL OR owner_id=?)",
                               (owner_id, stamp, workspace_id, row["owner_id"]))
        return {}

    def settings(self, user, body=None):
        self.admin(user)
        with self.lock:
            changed_secret = False
            secret_written = False
            previous = None
            try:
                with self.repo.connection() as connection:
                    connection.execute("BEGIN IMMEDIATE")
                    row = connection.execute("SELECT id,is_registration_enabled,is_email_registration_enabled FROM app_setting LIMIT 1").fetchone()
                    enabled, email_enabled = bool(row["is_registration_enabled"]), bool(row["is_email_registration_enabled"])
                    if body is not None:
                        require(isinstance(body, dict) and not (set(body) - {"registrationEnabled", "emailRegistrationEnabled", "mailSettings"}))
                        enabled = body.get("registrationEnabled", enabled)
                        email_enabled = body.get("emailRegistrationEnabled", email_enabled)
                        require(type(enabled) is bool and type(email_enabled) is bool)
                        settings = self.mail_config(connection)
                        mail_body = body.get("mailSettings")
                        if "mailSettings" in body:
                            settings = self.validate_mail_settings(settings, mail_body)
                            clear = mail_body.get("clearPassword", False)
                            changed_secret = bool(mail_body.get("password")) or clear
                            require(not changed_secret or not os.environ.get("BABA_SHARE_SMTP_PASSWORD"), 409,
                                    "SMTP_PASSWORD_ENVIRONMENT", "环境变量密码不能通过页面覆盖或清除")
                            if changed_secret:
                                previous = self.smtp_password()
                        candidate = ("" if mail_body and mail_body.get("clearPassword") else
                                     (mail_body.get("password") or None) if mail_body else None)
                        if email_enabled and (enabled or not bool(row["is_email_registration_enabled"])):
                            self.mail_ready(settings, candidate)
                        if changed_secret:
                            self.smtp_password(mail_body.get("password") or None, clear=mail_body.get("clearPassword", False))
                            secret_written = True
                        if enabled != bool(row["is_registration_enabled"]) or email_enabled != bool(row["is_email_registration_enabled"]):
                            connection.execute("DELETE FROM email_activation WHERE id IS NOT NULL")
                        connection.execute("UPDATE app_setting SET is_registration_enabled=?,is_email_registration_enabled=?,mail_settings=?,registration_revision=registration_revision+1,update_time=? WHERE id=?",
                                           (int(enabled), int(email_enabled), json.dumps(settings), now_ms(), row["id"]))
            except Exception:
                if secret_written:
                    self.smtp_password(previous or None, clear=not bool(previous))
                raise
        return {"registrationEnabled": enabled, "emailRegistrationEnabled": email_enabled}

    @staticmethod
    def valid_email(value):
        if not isinstance(value, str) or len(value) > 254 or value != value.strip():
            return False
        local, separator, domain = value.rpartition("@")
        return bool(separator and 1 <= len(local) <= 64 and
                    re.fullmatch(r"[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+", local) and
                    not local.startswith(".") and not local.endswith(".") and ".." not in local and
                    len(domain) <= 253 and "." in domain and
                    all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                        for label in domain.split(".")))

    def mail_config(self, connection=None):
        defaults = {"host": "", "port": 465, "security": "ssl", "username": "",
                    "fromAddress": "", "fromName": "babaShare", "activationHours": 24, "siteOrigin": ""}
        row = (connection.execute("SELECT mail_settings FROM app_setting LIMIT 1").fetchone() if connection
               else self.repo.one("SELECT mail_settings FROM app_setting LIMIT 1"))
        return {**defaults, **json.loads(row["mail_settings"])}

    def smtp_password(self, value=None, clear=False):
        environment = os.environ.get("BABA_SHARE_SMTP_PASSWORD", "")
        if environment:
            require(value is None and not clear, 409, "SMTP_PASSWORD_ENVIRONMENT", "环境变量密码不能通过页面覆盖或清除")
            return environment
        path = self.config.root / "data" / "smtp-password"
        temporary = None
        try:
            parent = path.parent.lstat()
            if (not stat.S_ISDIR(parent.st_mode) or stat.S_ISLNK(parent.st_mode) or
                    getattr(parent, "st_file_attributes", 0) & 0x400):
                raise OSError
            try:
                before = path.lstat()
            except FileNotFoundError:
                before = None
            if before is not None and (not stat.S_ISREG(before.st_mode) or stat.S_ISLNK(before.st_mode) or
                                       getattr(before, "st_file_attributes", 0) & 0x400 or
                                       (os.name != "nt" and before.st_mode & 0o077)):
                raise OSError
            if clear:
                if before is not None:
                    path.unlink()
                return ""
            if value is not None:
                descriptor, temporary = tempfile.mkstemp(prefix=".smtp-secret-", dir=path.parent)
                with os.fdopen(descriptor, "wb") as stream:
                    if os.name != "nt":
                        os.fchmod(stream.fileno(), 0o600)
                    stream.write(value.encode("utf-8"))
                    stream.flush()
                    os.fsync(stream.fileno())
                if before is not None and not os.path.samestat(before, path.lstat()):
                    raise OSError
                if before is None and (path.exists() or path.is_symlink()):
                    raise OSError
                os.replace(temporary, path)
                temporary = None
                return value
            if before is None:
                return ""
            descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) |
                                 getattr(os, "O_BINARY", 0) | getattr(os, "O_NONBLOCK", 0))
            with os.fdopen(descriptor, "rb") as stream:
                opened = os.fstat(stream.fileno())
                if not os.path.samestat(before, opened) or not os.path.samestat(opened, path.lstat()):
                    raise OSError
                secret = stream.read(4097)
            if len(secret) > 4096:
                raise OSError
            result = secret.decode("utf-8")
            if any(character in result for character in "\r\n\x00"):
                raise OSError
            return result
        except (OSError, UnicodeError):
            raise BizError(503, "SMTP_SECRET_UNAVAILABLE", "邮件密码文件不可用，请检查私有权限及文件完整性") from None
        finally:
            if temporary is not None:
                Path(temporary).unlink(missing_ok=True)

    def mail_ready(self, settings, candidate_password=None):
        password = self.smtp_password() if settings["username"] and candidate_password is None else candidate_password
        require(settings["host"] and settings["fromAddress"] and
                (not settings["username"] or password), 400,
                "MAIL_NOT_CONFIGURED", "请先配置邮件服务器、发件人及所需密码")

    def mail_origin(self, settings, request_origin=None):
        # 浏览器Origin优先；域名准入由受信网关负责，不比较代理内部Host。
        value = request_origin if request_origin is not None else settings["siteOrigin"]
        require(value, 400, "MAIL_ORIGIN_REQUIRED", "无浏览器来源时须配置可信站点地址")
        try:
            require(isinstance(value, str) and not any(ord(char) < 32 or ord(char) == 127 for char in value),
                    403, "ORIGIN_DENIED", "来源包含非法字符")
            require(urlsplit(value).path == "", 403, "ORIGIN_DENIED", "来源不得包含路径")
            return normalize_origin(value)
        except (ValueError, TypeError):
            raise BizError(403, "ORIGIN_DENIED", "邮件链接来源不合法") from None

    def validate_mail_settings(self, settings, body):
        require(isinstance(body, dict) and not (set(body) - set(settings) - {"password", "clearPassword"}))
        require(type(body.get("clearPassword", False)) is bool)
        require(not (body.get("clearPassword") and body.get("password")))
        settings = {**settings, **{key: value for key, value in body.items() if key not in ("password", "clearPassword")}}
        for key, maximum in (("host", 253), ("username", 254), ("fromName", 100), ("fromAddress", 254), ("siteOrigin", 2048)):
            value = settings[key]
            require(isinstance(value, str) and len(value) <= maximum and
                    not any(ord(character) < 32 or ord(character) == 127 for character in value))
            settings[key] = value.strip()
        require(not settings["host"] or re.fullmatch(r"[A-Za-z0-9.-]+", settings["host"]))
        require(type(settings["port"]) is int and 1 <= settings["port"] <= 65535)
        require(settings["security"] in ("ssl", "starttls"))
        require(type(settings["activationHours"]) is int and 1 <= settings["activationHours"] <= 720,
                msg="激活有效期必须为1至720小时")
        require(not settings["fromAddress"] or self.valid_email(settings["fromAddress"]), msg="发件邮箱不合法")
        if settings["siteOrigin"]:
            try:
                settings["siteOrigin"] = normalize_origin(settings["siteOrigin"])
            except ValueError:
                raise BizError(400, "PARAM_INVALID", "站点地址必须为可信HTTP(S)来源，不含路径") from None
        if "password" in body:
            require(isinstance(body["password"], str) and len(body["password"]) <= 1024 and
                    not any(character in body["password"] for character in "\r\n\x00"))
        return settings

    def mail_settings(self, user, body=None):
        self.admin(user)
        with self.lock:
            settings = self.mail_config()
            if body is not None:
                settings = self.validate_mail_settings(settings, body)
                clear = body.get("clearPassword", False)
                changed_secret = bool(body.get("password")) or clear
                require(not changed_secret or not os.environ.get("BABA_SHARE_SMTP_PASSWORD"), 409,
                        "SMTP_PASSWORD_ENVIRONMENT", "环境变量密码不能通过页面覆盖或清除")
                previous = self.smtp_password()
                if clear and self.install_detail()["emailRegistrationEnabled"] and settings["username"]:
                    raise BizError(400, "MAIL_NOT_CONFIGURED", "请先关闭邮箱验证或清除SMTP用户名再清除认证密码")
                if self.install_detail()["emailRegistrationEnabled"]:
                    self.mail_ready(settings, body.get("password") or None)
                if changed_secret:
                    self.smtp_password(body.get("password") or None, clear=clear)
                try:
                    self.repo.execute("UPDATE app_setting SET mail_settings=?,registration_revision=registration_revision+1,update_time=? WHERE id IN (SELECT id FROM app_setting LIMIT 1)",
                                      (json.dumps(settings), now_ms()))
                except Exception:
                    if changed_secret:
                        self.smtp_password(previous or None, clear=not bool(previous))
                    raise
            return {**settings, "hasPassword": bool(self.smtp_password())}

    def send_mail(self, settings, recipient, subject, content, html_content=None):
        message = EmailMessage()
        message["From"] = formataddr((settings["fromName"], settings["fromAddress"]))
        message["To"], message["Subject"] = recipient, subject
        message.set_content(content)
        if html_content is not None:
            message.add_alternative(html_content, subtype="html")
        context = ssl.create_default_context()
        try:
            if settings["security"] == "ssl":
                client = smtplib.SMTP_SSL(settings["host"], settings["port"], timeout=10, context=context)
            else:
                client = smtplib.SMTP(settings["host"], settings["port"], timeout=10)
            with client:
                if settings["security"] == "starttls":
                    client.ehlo()
                    client.starttls(context=context)
                    client.ehlo()
                if settings["username"]:
                    client.login(settings["username"], settings["_password"] if "_password" in settings else self.smtp_password())
                refused = client.send_message(message)
                require(not refused, 503, "MAIL_SEND_FAILED", "邮件服务器拒绝接收邮件")
        except (OSError, smtplib.SMTPException, ValueError, UnicodeError):
            raise BizError(503, "MAIL_SEND_FAILED", "邮件发送失败，请联系管理员检查邮件配置") from None

    def mail_test(self, user, body):
        self.admin(user)
        recipient = body.get("email")
        require(self.valid_email(recipient), msg="收件邮箱不合法")
        with self.lock:
            settings = self.mail_config()
            self.mail_ready(settings)
            stamp = now_ms()
            require(stamp - self.mail_test_time >= 10000, 429, "REGISTRATION_THROTTLED", "测试邮件发送过于频繁")
            self.mail_test_time = stamp
            settings["_password"] = self.smtp_password()
        plain, html = self.activation_mail(recipient, "管理员", settings["siteOrigin"] + "/baba-share/" if settings["siteOrigin"] else "", 1, "test")
        self.send_mail(settings, recipient, "babaShare SMTP test", plain, html)
        return {}

    @staticmethod
    def activation_mail(email, nickname, link, hours, purpose="activation"):
        titles = {
            "activation": ("欢迎加入，激活您的账户", "激活账户并设置密码", "距离开始协作只差一步。请设置并确认密码；激活完成后，您将自动登录并进入首页。"),
            "password-reset": ("找回密码，继续灵感旅程", "重置我的密码", "请打开安全页面，设置并确认新密码。完成后所有旧登录会话失效，请重新登录。"),
            "email-change-old": ("先确认是您，再换个收件箱", "验证当前邮箱", "请在发起申请的同一浏览器登录会话中确认当前邮箱，然后填写新邮箱。"),
            "email-change-new": ("新收件箱，准备就绪", "确认新邮箱", "请在发起申请的同一浏览器登录会话中确认。验证完成后，新邮箱才会绑定到账户。"),
            "email-binding": ("为您的账户连接一个收件箱", "确认绑定邮箱", "请在发起申请的同一浏览器登录会话中确认。验证完成后，可使用此邮箱找回密码。"),
            "notice": ("账户申请已收到", "前往登录", "该账号或邮箱已有关联账户，请直接登录。若非本人申请，请忽略本邮件。"),
            "test": ("一封测试，确认连接", "打开 babaShare", "这是一封邮件投递测试，您的协作通知已准备就绪。"),
        }
        title, button, introduction = titles[purpose]
        plain = (f"{nickname}，您好！\n\n{title}\n{introduction}\n\n"
                 f"登录账户：{email}\n链接有效期：{hours} 小时（自邮件发送成功起）\n\n{link}\n\n"
                 "若按钮无法打开，请将完整链接复制到浏览器。验证链接仅可使用一次，请勿转发。"
                 "若非本人申请，请忽略本邮件，不会自动更改账户。babaShare 不会通过邮件索取您的密码。")
        account, name, url, validity = (escape(str(value), quote=True) for value in (email, nickname, link, hours))
        title, button, introduction = (escape(value, quote=True) for value in (title, button, introduction))
        # 邮件是独立客户端模板：内联主题取值以兼容不支持CSS变量的邮箱，不依赖站点资源。
        html = f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{title}</title></head>
<body style="margin:0;padding:0;background-color:#f4f5f7;color:#091e42;font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.6;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f4f5f7;"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;border:1px solid #dfe1e6;background-color:#ffffff;">
<tr><td style="padding:24px 32px;border-bottom:1px solid #dfe1e6;font-size:20px;font-weight:bold;letter-spacing:1px;">babaShare</td></tr>
<tr><td style="padding:32px;">
<p style="margin:0 0 8px;font-size:12px;color:#5e6c84;">账户安全 · 邮箱验证</p>
<h1 style="margin:0 0 24px;font-size:28px;line-height:1.4;color:#091e42;">{title}</h1>
<p style="margin:0 0 16px;font-size:16px;">{name}，您好！</p>
<p style="margin:0 0 24px;font-size:14px;">{introduction}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:#f4f5f7;">
<tr><td style="padding:16px;font-size:14px;color:#5e6c84;">登录账户<br><strong style="color:#091e42;word-break:break-all;">{account}</strong><br>链接有效期：<strong style="color:#091e42;">{validity} 小时</strong>（自邮件发送成功起）</td></tr></table>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;"><tr><td bgcolor="#1868db" style="background-color:#1868db;text-align:center;border-radius:0;">
<a href="{url}" style="display:inline-block;padding:12px 32px;border:1px solid #1868db;border-radius:0;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;">{button}</a></td></tr></table>
<p style="margin:0 0 8px;font-size:12px;color:#5e6c84;">如果按钮无法打开，请复制以下完整链接到浏览器：</p>
<p style="margin:0;font-size:12px;word-break:break-all;overflow-wrap:anywhere;"><a href="{url}" style="color:#1868db;text-decoration:underline;">{url}</a></p>
</td></tr>
<tr><td style="padding:24px 32px;border-top:1px solid #dfe1e6;background-color:#f4f5f7;font-size:12px;color:#5e6c84;">
<strong style="color:#091e42;">安全提醒</strong><br>此链接仅可使用一次，请勿转发或分享。若非本人申请，请忽略本邮件，不会自动更改账户。babaShare 不会通过邮件索取您的密码。</td></tr>
</table><p style="margin:16px 0 0;color:#5e6c84;font-size:12px;">babaShare · 让原型分享与协作更简单</p>
</td></tr></table></body></html>"""
        return plain, html

    @staticmethod
    def registration_available(connection, name, email):
        existing = connection.execute("SELECT id FROM sys_user WHERE user_name=?", (name,)).fetchone()
        require(existing is None, 409, "USER_EXISTS", "账号已存在")
        existing = connection.execute("SELECT id FROM sys_user WHERE email=?", (email,)).fetchone()
        require(existing is None, 409, "EMAIL_EXISTS", "账号已存在")

    def email_registration(self, body, client_ip, request_origin=None):
        name = body.get("userName")
        require(isinstance(name, str) and re.fullmatch(r"[A-Za-z0-9_.@-]{3,64}", name), msg="账号为3至64位字母数字或_.@-")
        email = body.get("email")
        require(self.valid_email(email), msg="邮箱格式不合法，最多254字符")
        email = email.lower()
        nickname = body.get("nickname", email.split("@", 1)[0][:64])
        require(isinstance(nickname, str) and 1 <= len(nickname) <= 64)
        require(self.mail_slots.acquire(blocking=False), 429, "REGISTRATION_THROTTLED", "邮件队列繁忙")
        try:
            stamp, request_id = now_ms(), new_id()
            with self.lock, self.repo.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                row = connection.execute("SELECT is_registration_enabled,is_email_registration_enabled,registration_revision FROM app_setting LIMIT 1").fetchone()
                require(row["is_registration_enabled"] and row["is_email_registration_enabled"], 403,
                        "REGISTRATION_DISABLED", "邮箱注册未开放")
                revision = row["registration_revision"]
                self.registration_available(connection, name, email)
                settings = self.mail_config(connection)
                self.mail_ready(settings)
                origin = self.mail_origin(settings, request_origin)
                settings["_password"] = self.smtp_password()
                connection.execute("DELETE FROM registration_attempt WHERE create_time<=?", (stamp - 3600000,))
                connection.execute("DELETE FROM email_activation WHERE expire_time<=?", (stamp,))
                pending_count = connection.execute("SELECT count(*) AS activation_count FROM email_activation").fetchone()["activation_count"]
                require(pending_count < 996, 429, "REGISTRATION_THROTTLED", "待激活注册数量已达上限")
                email_hash, client_hash = digest(email), digest(str(client_ip))
                attempts = connection.execute("SELECT count(*) AS attempt_count FROM registration_attempt WHERE email_hash=? AND create_time>?",
                                              (email_hash, stamp - 60000)).fetchone()["attempt_count"]
                email_count = connection.execute("SELECT count(*) AS attempt_count FROM registration_attempt WHERE email_hash=?",
                                                 (email_hash,)).fetchone()["attempt_count"]
                ip_count = connection.execute("SELECT count(*) AS attempt_count FROM registration_attempt WHERE client_hash=?",
                                              (client_hash,)).fetchone()["attempt_count"]
                total = connection.execute("SELECT count(*) AS attempt_count FROM registration_attempt").fetchone()["attempt_count"]
                require(attempts < 1 and email_count < 5 and ip_count < 20 and total < 1000, 429, "REGISTRATION_THROTTLED", "发送过于频繁，请稍后重试")
                connection.execute("INSERT INTO registration_attempt (id,email_hash,client_hash,create_time,update_time) VALUES (?,?,?,?,?)",
                                   (db_id(request_id), email_hash, client_hash, stamp, stamp))
            # 网络发送不持全局锁或SQLite事务；模式/配置变更由revision阻止迟到令牌落库。
            token = secrets.token_urlsafe(32)
            link = origin + "/baba-share/activate.html#activation=" + token
            plain, html = self.activation_mail(name, nickname, link, settings["activationHours"])
            self.send_mail(settings, email, "babaShare — 激活您的账户", plain, html)
            with self.lock, self.repo.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                current = connection.execute("SELECT is_registration_enabled,is_email_registration_enabled,registration_revision FROM app_setting LIMIT 1").fetchone()
                require(current["is_registration_enabled"] and current["is_email_registration_enabled"] and
                        current["registration_revision"] == revision, 403, "REGISTRATION_DISABLED", "注册设置已变更，请重新申请")
                self.registration_available(connection, name, email)
                latest = connection.execute("SELECT id FROM registration_attempt WHERE email_hash=? ORDER BY create_time DESC,id DESC LIMIT 1", (email_hash,)).fetchone()
                if not latest or latest["id"] != db_id(request_id):
                    return {}
                stamp = now_ms()
                connection.execute("INSERT INTO email_activation (id,email_address,user_name,nickname,activation_hash,expire_time,create_time,update_time) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(email_address) DO UPDATE SET user_name=excluded.user_name,nickname=excluded.nickname,activation_hash=excluded.activation_hash,expire_time=excluded.expire_time,update_time=excluded.update_time",
                                   (db_id(new_id()), email, name, nickname, digest(token), stamp + settings["activationHours"] * 3600000, stamp, stamp))
            return {}
        finally:
            self.mail_slots.release()

    def email_activation(self, body, client_ip="local", current_session=""):
        stamp = now_ms()
        with self.lock:
            self.activation_attempts = {key: attempts for key, attempts in self.activation_attempts.items() if attempts[-1] > stamp - 60000}
            attempts = [at for at in self.activation_attempts.get(client_ip, []) if at > stamp - 60000]
            require(len(attempts) < 30 and (client_ip in self.activation_attempts or len(self.activation_attempts) < 1000),
                    429, "REGISTRATION_THROTTLED", "激活尝试过于频繁")
            self.activation_attempts[client_ip] = attempts + [stamp]
        token = body.get("token")
        require(isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", token),
                400, "ACTIVATION_INVALID", "激活链接无效或已过期")
        require(body.get("password") == body.get("passwordConfirm"), 400,
                "PASSWORD_MISMATCH", "两次输入的密码不一致")
        state = self.install_detail()
        require(state["registrationEnabled"] and state["emailRegistrationEnabled"], 403,
                "REGISTRATION_DISABLED", "邮箱注册未开放")
        candidate = self.repo.one("SELECT id FROM email_activation WHERE activation_hash=? AND expire_time>?", (digest(token), stamp))
        require(candidate, 400, "ACTIVATION_INVALID", "激活链接无效或已过期")
        hashed = password_hash(body.get("password"))
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            setting = connection.execute("SELECT is_registration_enabled,is_email_registration_enabled FROM app_setting LIMIT 1").fetchone()
            require(setting["is_registration_enabled"] and setting["is_email_registration_enabled"], 403,
                    "REGISTRATION_DISABLED", "邮箱注册未开放")
            row = connection.execute("SELECT id,email_address,user_name,nickname FROM email_activation WHERE activation_hash=? AND expire_time>?",
                                     (digest(token), now_ms())).fetchone()
            require(row, 400, "ACTIVATION_INVALID", "激活链接无效或已过期")
            self.registration_available(connection, row["user_name"], row["email_address"])
            user_id, stamp = new_id(), now_ms()
            connection.execute("INSERT INTO sys_user (id,user_name,nickname,password_hash,user_role,is_disabled,email,is_email_verified,create_time,update_time) VALUES (?,?,?,?,'editor',0,?,1,?,?)",
                               (db_id(user_id), row["user_name"], row["nickname"], hashed, row["email_address"], stamp, stamp))
            connection.execute("DELETE FROM email_activation WHERE id=?", (row["id"],))
            session = self.new_session(user_id, connection)
            # 仅在用户主动提交激活后切换本浏览器身份，不影响旧账号的其它设备。
            if current_session:
                connection.execute("DELETE FROM auth_session WHERE session_hash=?", (digest(current_session),))
        return {}, session

    def mail_attempt(self, connection, email, client_ip, purpose):
        stamp = now_ms()
        email_hash, client_hash = digest(purpose + ":" + email), digest(str(client_ip))
        connection.execute("DELETE FROM registration_attempt WHERE create_time<=?", (stamp - 3600000,))
        counts = connection.execute("SELECT count(*) AS total_count,sum(CASE WHEN email_hash=? THEN 1 ELSE 0 END) AS email_count,sum(CASE WHEN client_hash=? THEN 1 ELSE 0 END) AS client_count,sum(CASE WHEN email_hash=? AND create_time>? THEN 1 ELSE 0 END) AS recent_count FROM registration_attempt",
                                    (email_hash, client_hash, email_hash, stamp - 60000)).fetchone()
        require(counts["total_count"] < 1000 and (counts["email_count"] or 0) < 5 and
                (counts["client_count"] or 0) < 20 and not counts["recent_count"], 429,
                "REGISTRATION_THROTTLED", "发送过于频繁，请稍后重试")
        connection.execute("INSERT INTO registration_attempt (id,email_hash,client_hash,create_time,update_time) VALUES (?,?,?,?,?)",
                           (db_id(new_id()), email_hash, client_hash, stamp, stamp))

    @staticmethod
    def account_session(connection, user, session):
        current = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?", (db_id(user["id"]),)).fetchone())
        valid = connection.execute("SELECT id FROM auth_session WHERE session_hash=? AND user_id=? AND expire_time>?",
                                   (digest(session), db_id(user["id"]), now_ms())).fetchone()
        require(current and not current["is_disabled"] and valid, 401, "AUTH_REQUIRED", "请使用发起申请的有效登录会话")
        return current

    def email_detail(self, user, session):
        with self.repo.connection() as connection:
            current = self.account_session(connection, user, session)
            row = connection.execute("SELECT flow_stage FROM account_email_token WHERE user_id=? AND token_purpose='email-change' AND session_hash=? AND expire_time>? AND password_snapshot=? AND previous_email IS ?",
                                     (db_id(user["id"]), digest(session), now_ms(), digest(current["password_hash"]), current["email"] if current["is_email_verified"] else None)).fetchone()
        return {"email": current["email"], "emailVerified": bool(current["is_email_verified"]),
                "stage": row["flow_stage"] if row else "none"}

    def password_reset_request(self, body, client_ip, request_origin=None):
        email = body.get("email")
        require(self.valid_email(email), msg="邮箱格式不合法")
        return self.account_mail_request("password-reset", email.lower(), client_ip, request_origin)

    def email_request(self, user, session, client_ip, request_origin=None):
        with self.repo.connection() as connection:
            current = self.account_session(connection, user, session)
        require(current["is_email_verified"] and current["email"], 409, "EMAIL_NOT_VERIFIED", "请直接填写邮箱以首次绑定")
        return self.account_mail_request("email-change-old", current["email"], client_ip, request_origin, user, session)

    def email_proposal(self, user, session, body, client_ip, request_origin=None, binding=None):
        email = body.get("email")
        require(self.valid_email(email), msg="邮箱格式不合法")
        with self.repo.connection() as connection:
            current = self.account_session(connection, user, session)
        if binding is not None:
            require(bool(current["is_email_verified"]) != binding, 409, "EMAIL_CHANGE_STATE_INVALID", "请按当前邮箱状态选择绑定或换绑流程")
        purpose = "email-change-new" if current["is_email_verified"] else "email-binding"
        return self.account_mail_request(purpose, email.lower(), client_ip, request_origin, user, session)

    def account_mail_request(self, purpose, email, client_ip, request_origin=None, user=None, session=""):
        require(self.mail_slots.acquire(blocking=False), 429, "REGISTRATION_THROTTLED", "邮件队列繁忙")
        request_id, token = db_id(new_id()), secrets.token_urlsafe(32)
        token_purpose = "password-reset" if purpose == "password-reset" else "email-change"
        previous_stage = None
        try:
            with self.lock, self.repo.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                settings = self.mail_config(connection)
                self.mail_ready(settings)
                origin = self.mail_origin(settings, request_origin)
                settings["_password"] = self.smtp_password()
                self.mail_attempt(connection, email, client_ip, purpose)
                if purpose == "password-reset":
                    current = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE email=? AND is_email_verified=1 AND is_disabled=0", (email,)).fetchone())
                    if not current:
                        return {}
                else:
                    current = self.account_session(connection, user, session)
                    previous = connection.execute("SELECT id,flow_stage,session_hash,previous_email,password_snapshot,expire_time FROM account_email_token WHERE user_id=? AND token_purpose='email-change'", (db_id(user["id"]),)).fetchone()
                    if purpose == "email-change-old":
                        require(current["is_email_verified"] and current["email"] == email, 409, "EMAIL_CHANGED", "邮箱状态已变化")
                    elif purpose == "email-change-new":
                        require(previous and previous["flow_stage"] in ("new-email", "new-pending") and
                                previous["session_hash"] == digest(session) and previous["expire_time"] > now_ms() and
                                previous["previous_email"] == current["email"] and current["is_email_verified"] and
                                previous["password_snapshot"] == digest(current["password_hash"]),
                                409, "EMAIL_VERIFICATION_REQUIRED", "请先验证当前邮箱")
                        previous_stage = "new-email"
                    else:
                        require(not current["is_email_verified"], 409, "EMAIL_VERIFICATION_REQUIRED", "请先验证当前邮箱")
                    if purpose != "email-change-old":
                        require(email != current["email"] or not current["is_email_verified"], 409, "EMAIL_UNCHANGED", "新邮箱不能与当前邮箱相同")
                        occupied = connection.execute("SELECT id FROM sys_user WHERE email=? AND is_email_verified=1 AND id<>?", (email, db_id(current["id"]))).fetchone()
                        require(not occupied, 409, "EMAIL_EXISTS", "邮箱已绑定其他账户")
                stamp = now_ms()
                stage = "old-pending" if purpose == "email-change-old" else "new-pending"
                previous_email = current["email"] if current["is_email_verified"] else None
                connection.execute("DELETE FROM account_email_token WHERE expire_time<=?", (stamp,))
                connection.execute("DELETE FROM account_email_token WHERE user_id=? AND token_purpose=?", (db_id(current["id"]), token_purpose))
                connection.execute("INSERT INTO account_email_token (id,user_id,token_purpose,token_hash,session_hash,email_address,previous_email,password_snapshot,flow_stage,expire_time,create_time,update_time) VALUES (?,?,?,NULL,?,?,?,?,?,?,?,?)",
                                   (request_id, db_id(current["id"]), token_purpose, digest(session) if session else None, email, previous_email,
                                    digest(current["password_hash"]), stage, stamp + 3600000, stamp, stamp))
            if purpose == "password-reset":
                link = origin + "/baba-share/reset-password.html#reset=" + token
            else:
                link = origin + "/baba-share/email-verification.html#purpose=" + purpose + "&token=" + token
            plain, html = self.activation_mail(current["user_name"], current["nickname"], link, 1, purpose)
            self.send_mail(settings, email, "babaShare — 账户安全验证", plain, html)
            # 发送成功后才使令牌有效；重发、禁用或密码修改令迟到邮件无法覆盖新申请。
            with self.lock, self.repo.connection() as connection:
                connection.execute("BEGIN IMMEDIATE")
                latest = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?", (db_id(current["id"]),)).fetchone())
                session_valid = not session or connection.execute("SELECT id FROM auth_session WHERE session_hash=? AND user_id=? AND expire_time>?",
                                                                  (digest(session), db_id(current["id"]), now_ms())).fetchone()
                if session_valid and latest and not latest["is_disabled"] and latest["password_hash"] == current["password_hash"] and latest["email"] == current["email"] and latest["is_email_verified"] == current["is_email_verified"]:
                    stamp = now_ms()
                    connection.execute("UPDATE account_email_token SET token_hash=?,expire_time=?,update_time=? WHERE id=? AND token_hash IS NULL",
                                       (digest(token), stamp + 3600000, stamp, request_id))
            return {} if purpose == "password-reset" else {"stage": stage}
        except Exception as exc:
            if previous_stage:
                self.repo.execute("UPDATE account_email_token SET flow_stage=?,token_hash=NULL WHERE id=?", (previous_stage, request_id))
            else:
                self.repo.execute("DELETE FROM account_email_token WHERE id=?", (request_id,))
            if purpose == "password-reset" and isinstance(exc, BizError) and exc.status == "MAIL_SEND_FAILED":
                # SMTP失败不泄露邮箱是否绑定；只记录无邮箱、无令牌的诊断事件。
                LOGGER.warning(json.dumps({"event": "password-reset-mail-failed"}))
                return {}
            raise
        finally:
            self.mail_slots.release()

    def account_token(self, connection, body, token_purpose, user=None, session=""):
        token = body.get("token")
        require(isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", token), 400, "EMAIL_TOKEN_INVALID", "验证链接无效或已过期")
        row = connection.execute("SELECT id,user_id,session_hash,email_address,previous_email,password_snapshot,flow_stage FROM account_email_token WHERE token_hash=? AND token_purpose=? AND expire_time>?",
                                 (digest(token), token_purpose, now_ms())).fetchone()
        require(row, 400, "EMAIL_TOKEN_INVALID", "验证链接无效或已过期")
        current = public_row(connection.execute("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?", (row["user_id"],)).fetchone())
        require(current and not current["is_disabled"] and digest(current["password_hash"]) == row["password_snapshot"] and
                (current["email"] if current["is_email_verified"] else None) == row["previous_email"],
                400, "EMAIL_TOKEN_INVALID", "验证链接无效或已过期")
        if user:
            self.account_session(connection, user, session)
            require(row["user_id"] == db_id(user["id"]) and row["session_hash"] == digest(session),
                    403, "EMAIL_SESSION_MISMATCH", "请使用发起申请的同一登录会话")
        return row, current

    def password_reset_confirmation(self, body):
        require(body.get("password") == body.get("passwordConfirm"), 400, "PASSWORD_MISMATCH", "两次输入的密码不一致")
        # 先校验令牌，避免无效请求触发昂贵密码派生。
        with self.repo.connection() as connection:
            self.account_token(connection, body, "password-reset")
        hashed = password_hash(body.get("password"))
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row, current = self.account_token(connection, body, "password-reset")
            require(current["is_email_verified"] and current["email"] == row["email_address"], 400, "EMAIL_TOKEN_INVALID", "验证链接无效或已过期")
            connection.execute("UPDATE sys_user SET password_hash=?,update_time=? WHERE id=?", (hashed, now_ms(), row["user_id"]))
            connection.execute("DELETE FROM auth_session WHERE user_id=?", (row["user_id"],))
            connection.execute("DELETE FROM account_email_token WHERE user_id=?", (row["user_id"],))
        return {}

    def email_verification(self, user, session, body):
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row, current = self.account_token(connection, body, "email-change", user, session)
            require(row["flow_stage"] == "old-pending" and current["is_email_verified"] and current["email"] == row["email_address"], 400, "EMAIL_TOKEN_INVALID", "验证用途不符")
            connection.execute("UPDATE account_email_token SET flow_stage='new-email',token_hash=NULL,update_time=? WHERE id=?", (now_ms(), row["id"]))
        return {"stage": "new-email"}

    def email_confirmation(self, user, session, body, binding=None):
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row, current = self.account_token(connection, body, "email-change", user, session)
            require(row["flow_stage"] == "new-pending", 400, "EMAIL_TOKEN_INVALID", "验证用途不符")
            if binding is not None:
                require(bool(current["is_email_verified"]) != binding, 400, "EMAIL_TOKEN_INVALID", "验证用途不符")
            occupied = connection.execute("SELECT id FROM sys_user WHERE email=? AND is_email_verified=1 AND id<>?", (row["email_address"], row["user_id"])).fetchone()
            require(not occupied, 409, "EMAIL_EXISTS", "邮箱已绑定其他账户")
            connection.execute("UPDATE sys_user SET email=?,is_email_verified=1,update_time=? WHERE id=?", (row["email_address"], now_ms(), row["user_id"]))
            connection.execute("DELETE FROM account_email_token WHERE user_id=?", (row["user_id"],))
        return {"stage": "none", "email": row["email_address"], "emailVerified": True}

    def access(self, user, workspace_id, manage=False, write=False):
        current = self.repo.user(user["id"]) if user else None
        require(current and not current["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
        user = current
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
                "ownerId": row["owner_id"], "creatorId": row["creator_id"],
                "creatorNickname": row["creator_nickname"], "canManage": manager,
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
        user = self.repo.user(user["id"]) if user else None
        require(user and not user["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
        require(user["user_role"] in ("admin", "editor"), 403, "READ_ONLY", "查看者不能创建工作空间")
        name, description = body.get("workspaceName"), body.get("description", "")
        require(isinstance(name, str) and 1 <= len(name.strip()) <= 100)
        require(isinstance(description, str) and len(description) <= 500)
        with self.lock:
            user = self.repo.user(user["id"])
            require(user and not user["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
            require(user["user_role"] in ("admin", "editor"), 403, "READ_ONLY", "查看者不能创建工作空间")
            existing = self.repo.one("SELECT " + WORKSPACE_COLUMNS + " FROM project_workspace WHERE owner_id=? AND workspace_name=?", (db_id(user["id"]), name.strip()))
            if existing:
                return self.workspace_view(user, existing)
            workspace_id, stamp = new_id(), now_ms()
            self.repo.execute("INSERT INTO project_workspace (id,workspace_name,description,owner_id,creator_id,creator_nickname,create_time,update_time) VALUES (?,?,?,?,?,?,?,?)",
                              (db_id(workspace_id), name.strip(), description, db_id(user["id"]), db_id(user["id"]), user["nickname"], stamp, stamp))
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
                connection.execute("DELETE FROM workspace_invitation WHERE workspace_id=?", args)
                connection.execute("DELETE FROM folder_share WHERE workspace_id=?", args)
                connection.execute("DELETE FROM preview_ticket WHERE workspace_id=?", args)
                connection.execute("DELETE FROM project_workspace WHERE id=?", args)
            return {}

    @staticmethod
    def invitation_view(row):
        return {"id": row["id"], "workspaceId": row["workspace_id"],
                "collaborate": bool(row["is_collaborate"]), "expireTime": row["expire_time"],
                "createTime": row["create_time"], "isActive": row["expire_time"] > now_ms()}

    @staticmethod
    def invitation_manager(connection, user_id, workspace_id):
        actor = connection.execute("SELECT id,user_role,is_disabled FROM sys_user WHERE id=?", (db_id(user_id),)).fetchone()
        require(actor and not actor["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
        workspace = connection.execute("SELECT id,owner_id FROM project_workspace WHERE id=?", (db_id(workspace_id),)).fetchone()
        require(workspace, 404, "WORKSPACE_NOT_EXIST", "工作区不存在")
        require(actor["user_role"] in ("admin", "editor") and
                (actor["user_role"] == "admin" or workspace["owner_id"] == actor["id"]),
                403, "PERMISSION_DENIED", "仅有效所有者和管理员可管理邀请")

    def invitations(self, user, workspace_id):
        with self.repo.connection() as connection:
            self.invitation_manager(connection, user["id"], workspace_id)
            rows = connection.execute("SELECT id,workspace_id,is_collaborate,expire_time,create_time FROM workspace_invitation WHERE workspace_id=? ORDER BY create_time DESC",
                                      (db_id(workspace_id),)).fetchall()
            return [self.invitation_view(public_row(row)) for row in rows]

    def invitation_create(self, user, body):
        workspace_id, request_id = body.get("workspaceId"), body.get("requestId")
        collaborate, hours = body.get("collaborate", False), body.get("expireHours", 168)
        require(type(collaborate) is bool and type(hours) is int and 1 <= hours <= 720)
        require(isinstance(request_id, str) and re.fullmatch(r"[A-Za-z0-9_-]{16,100}", request_id),
                msg="requestId必须为16至100位随机请求标识")
        fingerprint = digest(str(workspace_id) + "\n" + str(collaborate) + "\n" + str(hours))
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            self.invitation_manager(connection, user["id"], workspace_id)
            previous = connection.execute("SELECT request_hash FROM workspace_invitation WHERE creator_id=? AND request_id=?",
                                          (db_id(user["id"]), request_id)).fetchone()
            if previous:
                require(previous["request_hash"] == fingerprint, 409, "REQUEST_CONFLICT", "同一请求不能使用不同参数")
                raise BizError(409, "INVITATION_ALREADY_CREATED", "邀请已生成，链接仅首次显示；需要时请另行生成")
            token, invitation_id, stamp = secrets.token_urlsafe(32), new_id(), now_ms()
            expiry = stamp + hours * 3600000
            connection.execute("INSERT INTO workspace_invitation (id,workspace_id,creator_id,invitation_hash,request_id,request_hash,is_collaborate,expire_time,create_time,update_time) VALUES (?,?,?,?,?,?,?,?,?,?)",
                               (db_id(invitation_id), db_id(workspace_id), db_id(user["id"]), digest(token), request_id,
                                fingerprint, int(collaborate), expiry, stamp, stamp))
            return {"id": invitation_id, "workspaceId": workspace_id, "collaborate": collaborate,
                    "expireTime": expiry, "createTime": stamp, "isActive": True,
                    "inviteUrl": self.config.public_origin + "/baba-share/invite.html#invite=" + token}

    def invitation_delete(self, user, invitation_id):
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute("SELECT workspace_id FROM workspace_invitation WHERE id=?", (db_id(invitation_id),)).fetchone()
            if row:
                self.invitation_manager(connection, user["id"], str(uuid.UUID(bytes=row["workspace_id"])))
                connection.execute("DELETE FROM workspace_invitation WHERE id=?", (db_id(invitation_id),))
        return {}

    def invitation_membership(self, user, body):
        token = body.get("token")
        require(isinstance(token, str) and re.fullmatch(r"[A-Za-z0-9_-]{43}", token),
                404, "INVITATION_INVALID", "邀请不存在或已失效")
        with self.lock, self.repo.connection() as connection:
            connection.execute("BEGIN IMMEDIATE")
            actor = connection.execute("SELECT id,is_disabled FROM sys_user WHERE id=?", (db_id(user["id"]),)).fetchone()
            require(actor and not actor["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
            row = connection.execute("SELECT workspace_id,creator_id,is_collaborate FROM workspace_invitation WHERE invitation_hash=? AND expire_time>?",
                                     (digest(token), now_ms())).fetchone()
            require(row, 404, "INVITATION_INVALID", "邀请不存在或已失效")
            workspace_id = str(uuid.UUID(bytes=row["workspace_id"]))
            try:
                self.invitation_manager(connection, str(uuid.UUID(bytes=row["creator_id"])), workspace_id)
            except BizError:
                raise BizError(404, "INVITATION_INVALID", "邀请不存在或已失效") from None
            workspace = connection.execute("SELECT owner_id FROM project_workspace WHERE id=?", (row["workspace_id"],)).fetchone()
            if workspace["owner_id"] != actor["id"]:
                stamp = now_ms()
                connection.execute("INSERT INTO workspace_member (id,workspace_id,user_id,is_collaborate,create_time,update_time) VALUES (?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id) DO NOTHING",
                                   (db_id(new_id()), row["workspace_id"], actor["id"], row["is_collaborate"], stamp, stamp))
            return {"workspaceId": workspace_id}

    def members(self, user, workspace_id):
        workspace, _, _ = self.access(user, workspace_id)
        rows = self.repo.all("SELECT t1." + USER_COLUMNS.replace(",", ",t1.") + ",t2.is_collaborate FROM sys_user AS t1 JOIN workspace_member AS t2 ON t2.user_id=t1.id WHERE t2.workspace_id=? AND (? IS NULL OR t1.id<>?) ORDER BY t1.create_time",
                             (db_id(workspace_id), db_id(workspace["owner_id"]) if workspace["owner_id"] else None,
                              db_id(workspace["owner_id"]) if workspace["owner_id"] else None))
        owner = self.repo.user(workspace["owner_id"]) if workspace["owner_id"] else None
        result = []
        if owner:
            result.append({**self.user_view(owner), "userId": owner["id"], "collaborate": True, "isOwner": True})
        result.extend({**self.user_view(row), "userId": row["id"], "collaborate": bool(row["is_collaborate"]), "isOwner": row["id"] == workspace["owner_id"]} for row in rows)
        return result

    def member_change(self, user, body):
        workspace_id = body.get("workspaceId")
        with self.lock:
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
        user = self.repo.user(user["id"])
        return bool(user and not user["is_disabled"]) and user["user_role"] in ("admin", "editor") and (manager or collaborate or not node or node["owner_id"] == user["id"])

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
        create_new = body.get("createNew", False)
        require(type(create_new) is bool, msg="createNew必须为布尔值")
        with self.lock:
            self.access(user, workspace_id, write=True)
            existing = self.repo.one("SELECT " + SHARE_COLUMNS + " FROM folder_share WHERE owner_id=? AND workspace_id=? AND root_path=? AND (expire_time IS NULL OR expire_time>?) ORDER BY create_time DESC LIMIT 1",
                                     (db_id(user["id"]), db_id(workspace_id), path, now_ms()))
            if not create_new and existing and ((existing["expire_time"] is None and hours == 0) or
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
            require(share["owner_id"] == user["id"] or user["user_role"] == "admin", 403, "PERMISSION_DENIED", "无权删除分享")
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
        with self.lock:
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
