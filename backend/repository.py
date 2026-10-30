"""SQLite数据访问；UUID在边界统一转换为16字节。"""
import secrets
import sqlite3
import time
import uuid
from contextlib import contextmanager


def now_ms():
    return time.time_ns() // 1_000_000


def new_id():
    bits = (now_ms() << 80) | (7 << 76) | (secrets.randbits(12) << 64) | (2 << 62) | secrets.randbits(62)
    return str(uuid.UUID(int=bits))


def db_id(value):
    return uuid.UUID(str(value)).bytes


def public_row(row):
    if row is None:
        return None
    return {key: str(uuid.UUID(bytes=value)) if isinstance(value, bytes) and len(value) == 16 else value
            for key, value in dict(row).items()}


SCHEMA = """
CREATE TABLE IF NOT EXISTS sys_user (
 id BLOB PRIMARY KEY, user_name TEXT NOT NULL COLLATE NOCASE UNIQUE,
 nickname TEXT NOT NULL, password_hash TEXT NOT NULL,
 user_role TEXT NOT NULL, is_disabled INTEGER NOT NULL DEFAULT 0,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS app_setting (
 id BLOB PRIMARY KEY, is_registration_enabled INTEGER NOT NULL DEFAULT 0,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS auth_session (
 id BLOB PRIMARY KEY, session_hash TEXT NOT NULL UNIQUE, user_id BLOB NOT NULL,
 expire_time BIGINT NOT NULL, create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_session_user_id ON auth_session(user_id);
CREATE TABLE IF NOT EXISTS auth_mcp_key (
 id BLOB PRIMARY KEY, user_id BLOB NOT NULL, key_name TEXT NOT NULL,
 key_prefix TEXT NOT NULL, key_hash TEXT NOT NULL, request_id TEXT NOT NULL,
 request_hash TEXT NOT NULL, expire_time BIGINT, revoked_time BIGINT,
 mcp_derivation_version TEXT, mcp_derivation_nonce TEXT,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_auth_mcp_key_hash ON auth_mcp_key(key_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uk_auth_mcp_key_request ON auth_mcp_key(user_id,request_id);
CREATE INDEX IF NOT EXISTS idx_auth_mcp_key_user_time ON auth_mcp_key(user_id,create_time);
CREATE TABLE IF NOT EXISTS project_workspace (
 id BLOB PRIMARY KEY, workspace_name TEXT NOT NULL, description TEXT NOT NULL,
 owner_id BLOB NOT NULL, create_time BIGINT NOT NULL, update_time BIGINT NOT NULL,
 UNIQUE(owner_id, workspace_name)
);
CREATE TABLE IF NOT EXISTS workspace_member (
 id BLOB PRIMARY KEY, workspace_id BLOB NOT NULL, user_id BLOB NOT NULL,
 is_collaborate INTEGER NOT NULL, create_time BIGINT NOT NULL, update_time BIGINT NOT NULL,
 UNIQUE(workspace_id,user_id)
);
CREATE INDEX IF NOT EXISTS idx_workspace_member_user_id ON workspace_member(user_id);
CREATE TABLE IF NOT EXISTS workspace_invitation (
 id BLOB PRIMARY KEY, workspace_id BLOB NOT NULL, creator_id BLOB NOT NULL,
 invitation_hash TEXT NOT NULL, request_id TEXT NOT NULL, request_hash TEXT NOT NULL,
 is_collaborate INTEGER NOT NULL DEFAULT 0, expire_time BIGINT NOT NULL,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_workspace_invitation_hash ON workspace_invitation(invitation_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uk_workspace_invitation_request ON workspace_invitation(creator_id,request_id);
CREATE INDEX IF NOT EXISTS idx_workspace_invitation_workspace_time ON workspace_invitation(workspace_id,create_time);
CREATE TABLE IF NOT EXISTS workspace_node (
 id BLOB PRIMARY KEY, workspace_id BLOB NOT NULL, node_path TEXT NOT NULL,
 node_kind TEXT NOT NULL, owner_id BLOB NOT NULL,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL,
 UNIQUE(workspace_id,node_path)
);
CREATE TABLE IF NOT EXISTS upload_request (
 id BLOB PRIMARY KEY, user_id BLOB NOT NULL, workspace_id BLOB NOT NULL,
 request_id TEXT NOT NULL, request_hash TEXT NOT NULL, response_json TEXT NOT NULL,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uk_upload_request_user_id ON upload_request(user_id,request_id);
CREATE TABLE IF NOT EXISTS folder_share (
 id BLOB PRIMARY KEY, share_token TEXT NOT NULL UNIQUE, workspace_id BLOB NOT NULL,
 owner_id BLOB NOT NULL, root_path TEXT NOT NULL, expire_time BIGINT,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_folder_share_owner_id ON folder_share(owner_id);
CREATE TABLE IF NOT EXISTS preview_ticket (
 id BLOB PRIMARY KEY, ticket_hash TEXT NOT NULL UNIQUE, workspace_id BLOB NOT NULL,
 user_id BLOB NOT NULL, root_path TEXT NOT NULL, expire_time BIGINT NOT NULL,
 create_time BIGINT NOT NULL, update_time BIGINT NOT NULL
);
"""

USER_COLUMNS = "id,user_name,nickname,password_hash,user_role,is_disabled,create_time,update_time"
WORKSPACE_COLUMNS = "id,workspace_name,description,owner_id,create_time,update_time"
NODE_COLUMNS = "id,workspace_id,node_path,node_kind,owner_id,create_time,update_time"
SHARE_COLUMNS = "id,share_token,workspace_id,owner_id,root_path,expire_time,create_time,update_time"


class Repository:
    def __init__(self, path):
        self.path = str(path)
        with self.connection() as connection:
            connection.executescript(SCHEMA)
            connection.execute("BEGIN IMMEDIATE")
            columns = {row["name"] for row in connection.execute("PRAGMA table_info(auth_mcp_key)")}
            if "mcp_derivation_version" not in columns:
                connection.execute("ALTER TABLE auth_mcp_key ADD COLUMN mcp_derivation_version TEXT")
            if "mcp_derivation_nonce" not in columns:
                connection.execute("ALTER TABLE auth_mcp_key ADD COLUMN mcp_derivation_nonce TEXT")
            stamp = now_ms()
            connection.execute("INSERT INTO app_setting (id,is_registration_enabled,create_time,update_time) SELECT ?,0,?,? WHERE NOT EXISTS (SELECT id FROM app_setting)", (db_id(new_id()), stamp, stamp))

    @contextmanager
    def connection(self):
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA secure_delete=ON")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def one(self, statement, args=()):
        with self.connection() as connection:
            return public_row(connection.execute(statement, args).fetchone())

    def all(self, statement, args=()):
        with self.connection() as connection:
            return [public_row(row) for row in connection.execute(statement, args).fetchall()]

    def execute(self, statement, args=()):
        with self.connection() as connection:
            return connection.execute(statement, args).rowcount

    def user(self, user_id):
        return self.one("SELECT " + USER_COLUMNS + " FROM sys_user WHERE id=?", (db_id(user_id),))

    def user_by_name(self, user_name):
        return self.one("SELECT " + USER_COLUMNS + " FROM sys_user WHERE user_name=?", (user_name,))

    def workspace(self, workspace_id):
        return self.one("SELECT " + WORKSPACE_COLUMNS + " FROM project_workspace WHERE id=?", (db_id(workspace_id),))

    def nodes(self, workspace_id, root=""):
        if not root:
            return self.all("SELECT " + NODE_COLUMNS + " FROM workspace_node WHERE workspace_id=? ORDER BY node_path", (db_id(workspace_id),))
        prefix = root + "/"
        return self.all("SELECT " + NODE_COLUMNS + " FROM workspace_node WHERE workspace_id=? AND (node_path=? OR (node_path>=? AND node_path<?)) ORDER BY node_path",
                        (db_id(workspace_id), root, prefix, root + "0"))

    def directory_page(self, workspace_id, path, page_index, page_size, search="", sort="name", order="asc", sizes=None):
        prefix = path + "/" if path else ""
        upper = path + "0" if path else chr(0x10ffff)
        args = (db_id(workspace_id), prefix, upper, len(prefix) + 1, search.casefold(), len(prefix) + 1, len(search), search.casefold())
        with self.connection() as connection:
            connection.create_function("casefold", 1, str.casefold, deterministic=True)
            connection.create_function("node_size", 1, lambda node_path: (sizes or {}).get(node_path, 0), deterministic=True)
            total = connection.execute("SELECT count(*) AS node_count FROM workspace_node WHERE workspace_id=? AND node_path>=? AND node_path<? AND instr(substr(node_path,?),'/')=0 AND (?='' OR casefold(substr(node_path,?,?))=?)", args).fetchone()["node_count"]
            if not total:
                return 0, []
            rows = connection.execute("SELECT " + NODE_COLUMNS + " FROM workspace_node WHERE workspace_id=? AND node_path>=? AND node_path<? AND instr(substr(node_path,?),'/')=0 AND (?='' OR casefold(substr(node_path,?,?))=?) ORDER BY node_kind DESC,CASE WHEN ?='name' AND ?='asc' THEN casefold(node_path) END ASC,CASE WHEN ?='name' AND ?='desc' THEN casefold(node_path) END DESC,CASE WHEN ?='size' AND ?='asc' THEN node_size(node_path) END ASC,CASE WHEN ?='size' AND ?='desc' THEN node_size(node_path) END DESC,CASE WHEN ?='updateTime' AND ?='asc' THEN update_time END ASC,CASE WHEN ?='updateTime' AND ?='desc' THEN update_time END DESC,node_path COLLATE NOCASE LIMIT ? OFFSET ?",
                                      args + (sort, order) * 6 + (page_size, (page_index - 1) * page_size)).fetchall()
            return total, [public_row(row) for row in rows]

    def entry_node(self, workspace_id, path):
        prefix = path + "/" if path else ""
        for name in ("index.html", "home.html"):
            row = self.one("SELECT " + NODE_COLUMNS + " FROM workspace_node WHERE workspace_id=? AND node_kind='file' AND node_path=? COLLATE NOCASE LIMIT 1",
                           (db_id(workspace_id), prefix + name))
            if row:
                return row
        return None

    def node(self, workspace_id, path):
        return self.one("SELECT " + NODE_COLUMNS + " FROM workspace_node WHERE workspace_id=? AND node_path=?", (db_id(workspace_id), path))
