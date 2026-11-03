"""MCP纯目录快照与用户绑定选择凭证；不读取文件内容或遍历文件系统。"""
from collections import OrderedDict
import hashlib
import hmac
import json
import secrets

from .repository import db_id, now_ms
from .service import BizError, clean_path, require


TREE_META_KEY = "babashare/directoryTree"
TREE_INSTRUCTIONS = (
    "操作继承密钥所有者的实时账号和工作区权限。创建文件夹、写文件或上传前，必须调用directory_tree取得完整目录树；"
    "initialize的_meta可能被客户端忽略，不能替代此标准工具。只展示工作区和文件夹，不展示文件。"
    "客户端若有原生树选择UI，应展开树让用户点选目标；否则展示树形编号和完整displayPath标签，让用户确认选项，"
    "不要要求用户手输目标路径，也不要自行默认根目录。选择后提交treeToken和targetId，relativePath或files[].path仅表示所选目录内的相对名称。"
    "complete=false时禁止创建；凭证过期、目录移动删除或权限变化时重新调用directory_tree并重新确认。"
    "workspace_create之后必须刷新目录树。此无会话单POST服务不提供elicitation或MCP Apps交互界面；"
    "凭证只证明目标来自该用户的完整树快照，不能证明用户实际点击。上传原型用file_upload保留相对目录结构。"
)


def compact(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True).encode()


class DirectoryTree:
    def __init__(self, service):
        self.service = service
        self.secret = secrets.token_bytes(32)
        self.ttl_ms = 5 * 60 * 1000
        self.max_response_bytes = min(2 * 1024 * 1024, service.config.max_body_bytes // 2)
        self.max_cache_entries = 128
        self.max_cache_bytes = 8 * 1024 * 1024
        self.snapshots = OrderedDict()
        self.cache_bytes = 0

    def prune(self):
        for snapshot_id, entry in list(self.snapshots.items()):
            if entry["expireTime"] <= now_ms():
                self.cache_bytes -= entry["size"]
                del self.snapshots[snapshot_id]

    def signature(self, snapshot_id, user_id):
        return hmac.new(self.secret, (snapshot_id + ":" + user_id).encode(), hashlib.sha256).hexdigest()

    @staticmethod
    def refresh_required():
        return BizError(409, "MCP_TREE_REFRESH_REQUIRED", "目录选择已失效，请调用directory_tree刷新完整树并重新确认目标")

    def snapshot(self, user, args=None):
        with self.service.lock:
            self.prune()
            current = self.service.repo.user(user["id"])
            require(current and not current["is_disabled"], 401, "AUTH_REQUIRED", "账号已失效")
            nodes, targets = [], {}
            for workspace in self.service.workspaces(current):
                workspace_id = workspace["id"]
                root_id = "workspace:" + workspace_id
                role = workspace["memberRole"]
                root = {"targetId": root_id, "nodeId": None, "nodeType": "workspaceRoot",
                        "workspaceId": workspace_id, "parentId": None, "name": workspace["workspaceName"],
                        "path": "", "displayPath": workspace["workspaceName"] + "/",
                        "memberRole": role, "canCreateChild": role in ("editor", "manager")}
                nodes.append(root)
                targets[root_id] = [workspace_id, "", role, workspace["workspaceName"], None]
                folders = self.service.repo.all(
                    "SELECT id,node_path,update_time FROM workspace_node WHERE workspace_id=? AND node_kind='folder' ORDER BY node_path",
                    (db_id(workspace_id),))
                parents = {folder["node_path"]: folder["id"] for folder in folders}
                for folder in folders:
                    path = folder["node_path"]
                    parent_path = path.rpartition("/")[0]
                    if parent_path and parent_path not in parents:
                        return self.incomplete("DIRECTORY_METADATA_INCONSISTENT")
                    node = {"targetId": folder["id"], "nodeId": folder["id"], "nodeType": "folder",
                            "workspaceId": workspace_id, "parentId": parents.get(parent_path, root_id),
                            "name": path.rsplit("/", 1)[-1], "path": path,
                            "displayPath": workspace["workspaceName"] + "/" + path,
                            "memberRole": role, "canCreateChild": root["canCreateChild"]}
                    nodes.append(node)
                    targets[folder["id"]] = [workspace_id, path, role, workspace["workspaceName"], folder["update_time"]]
            version = hashlib.sha256(compact(targets)).hexdigest()
            expires = now_ms() + self.ttl_ms
            snapshot_id = secrets.token_urlsafe(24)
            payload = {"userId": current["id"], "expireTime": expires, "treeVersion": version, "targets": targets}
            payload_bytes = compact(payload)
            result = {"complete": True, "treeVersion": version,
                      "treeToken": snapshot_id + "." + self.signature(snapshot_id, current["id"]),
                      "expireTime": expires, "nodes": nodes}
            # 标准工具同时返回text和structuredContent，计入转义开销并预留协议外壳。
            tool_result = {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}],
                           "structuredContent": result, "isError": False}
            if (len(json.dumps(tool_result, ensure_ascii=False).encode()) + 2048 > self.max_response_bytes
                    or len(payload_bytes) > self.max_cache_bytes):
                return self.incomplete("DIRECTORY_TREE_TOO_LARGE")
            while self.snapshots and (len(self.snapshots) >= self.max_cache_entries
                                      or self.cache_bytes + len(payload_bytes) > self.max_cache_bytes):
                _, evicted = self.snapshots.popitem(last=False)
                self.cache_bytes -= evicted["size"]
            self.snapshots[snapshot_id] = {"userId": current["id"], "expireTime": expires,
                                           "payload": payload_bytes, "size": len(payload_bytes)}
            self.cache_bytes += len(payload_bytes)
            return result

    @staticmethod
    def incomplete(reason):
        return {"complete": False, "reason": reason, "nodes": [], "treeToken": None,
                "treeVersion": None, "expireTime": None,
                "instruction": "未返回完整目录树，禁止创建；请修复目录元数据或调整响应预算后重新调用directory_tree。"}

    def resolve(self, user, token, target_id):
        self.prune()
        if not isinstance(token, str) or len(token) != 97 or not isinstance(target_id, str):
            raise self.refresh_required()
        try:
            snapshot_id, signature = token.split(".")
            entry = self.snapshots.get(snapshot_id)
            if not entry or not hmac.compare_digest(self.signature(snapshot_id, entry["userId"]), signature):
                raise self.refresh_required()
        except (ValueError, TypeError):
            raise self.refresh_required() from None
        require(entry["userId"] == user["id"], 403, "MCP_TREE_INVALID", "目录选择凭证不属于当前账号")
        payload = json.loads(entry["payload"])
        if target_id not in payload["targets"]:
            raise self.refresh_required()
        self.snapshots.move_to_end(snapshot_id)
        workspace_id, path, old_role, old_name, old_update = payload["targets"][target_id]
        try:
            workspace, _, role = self.service.access(user, workspace_id)
        except BizError as exc:
            if exc.code == 401:
                raise
            raise self.refresh_required() from None
        if workspace["workspace_name"] != old_name or role != old_role:
            raise self.refresh_required()
        require(role in ("editor", "manager"), 403, "READ_ONLY", "所选工作区只读，不能创建内容")
        if target_id != "workspace:" + workspace_id:
            folder = self.service.repo.one(
                "SELECT node_path,update_time FROM workspace_node WHERE id=? AND workspace_id=? AND node_kind='folder'",
                (db_id(target_id), db_id(workspace_id)))
            if not folder or folder["node_path"] != path or folder["update_time"] != old_update:
                raise self.refresh_required()
        if not self.service.disk_path(workspace_id, path).is_dir():
            raise self.refresh_required()
        return workspace_id, path

    def create(self, operation, user, args):
        # 与Service共用RLock，确保本进程内目录解析和实际写入之间不能移动目录或撤权。
        # 不宣称覆盖多个独立服务进程；Service内部数据库事务仍保持原样。
        with self.service.lock:
            workspace_id, path = self.resolve(user, args.get("treeToken"), args.get("targetId"))
            body = {key: value for key, value in args.items() if key not in ("treeToken", "targetId", "relativePath")}
            body["workspaceId"] = workspace_id
            if operation in ("folder_create", "file_write"):
                relative = clean_path(args.get("relativePath"), False)
                body["path"] = path + "/" + relative if path else relative
            else:
                body["path"] = path
            return getattr(self.service, operation)(user, body)
