"""无会话标准MCP JSON-RPC工具协议；仅显式开放经过业务权限检查的操作。"""
import json
import sqlite3

from .repository import now_ms
from .service import BizError


PROTOCOL_VERSIONS = ("2025-03-26", "2025-06-18", "2025-11-25")


def rpc_error(request_id, code, message, data=None):
    error = {"code": code, "message": message}
    if data is not None:
        error["data"] = data
    return {"jsonrpc": "2.0", "id": request_id, "error": error}


def obj(properties, required=()):
    return {"type": "object", "properties": properties, "required": list(required), "additionalProperties": False}


STRING = {"type": "string"}
INTEGER = {"type": "integer"}
BOOLEAN = {"type": "boolean"}
WORKSPACE = {"workspaceId": STRING}
PATH = {**WORKSPACE, "path": STRING}


def validate(value, schema):
    kind = schema.get("type")
    matches = {"object": isinstance(value, dict), "array": isinstance(value, list),
               "string": isinstance(value, str), "integer": type(value) is int,
               "boolean": type(value) is bool}
    if kind in matches and not matches[kind]:
        raise ValueError("参数类型不正确")
    if kind == "object":
        properties = schema.get("properties", {})
        if any(name not in value for name in schema.get("required", ())):
            raise ValueError("缺少必填参数")
        if schema.get("additionalProperties") is False and any(name not in properties for name in value):
            raise ValueError("包含未声明参数")
        for name, item in value.items():
            if name in properties:
                validate(item, properties[name])
    elif kind == "array":
        if not schema.get("minItems", 0) <= len(value) <= schema.get("maxItems", 500):
            raise ValueError("数组长度不正确")
        for item in value:
            validate(item, schema["items"])
    if "enum" in schema and value not in schema["enum"]:
        raise ValueError("参数取值不正确")


class MCP:
    def __init__(self, service):
        self.service = service
        self.tools = {}
        self.tool_windows = {}
        self.register("workspace_list", "列出当前用户有权访问的工作区。", obj({}),
                      lambda user, args: service.workspaces(user), read_only=True)
        self.register("workspace_create", "创建工作区；同一所有者同名重试返回已有工作区。",
                      obj({"workspaceName": STRING, "description": STRING}, ("workspaceName",)), service.workspace_create)
        self.register("workspace_change", "修改工作区名称或说明，仅所有者和管理员可用。",
                      obj({"id": STRING, "workspaceName": STRING, "description": STRING}, ("id",)), service.workspace_change)
        self.register("workspace_delete", "删除工作区及全部内容，不可恢复。", obj({"id": STRING}, ("id",)),
                      lambda user, args: service.workspace_delete(user, args["id"]), destructive=True)
        self.register("node_list", "分页列出目录；path是工作区内相对路径，空字符串表示根目录。",
                      obj({**PATH, "pageIndex": INTEGER, "pageSize": INTEGER, "search": STRING,
                           "sort": {"type": "string", "enum": ["name", "size", "updateTime"]},
                           "order": {"type": "string", "enum": ["asc", "desc"]}}, ("workspaceId",)),
                      lambda user, args: service.listing(args["workspaceId"], args.get("path", ""), user,
                          args.get("pageIndex", 1), args.get("pageSize", 20), args.get("search", ""),
                          args.get("sort", "name"), args.get("order", "asc")), read_only=True)
        self.register("folder_create", "创建相对路径文件夹，自动创建父目录。", obj(PATH, ("workspaceId", "path")), service.folder_create)
        self.register("file_read", "读取UTF-8文本，最大4MB。", obj(PATH, ("workspaceId", "path")),
                      lambda user, args: service.file_read(user, args["workspaceId"], args["path"]), read_only=True)
        self.register("file_write", "写入UTF-8文本，自动创建父目录；已有文件受协作权限约束。",
                      obj({**PATH, "content": STRING}, ("workspaceId", "path", "content")), service.file_write, destructive=True)
        self.register("file_upload", "批量上传并保留相对目录。conflictPolicy默认ask：同名返回requiresConfirmation及conflicts且整批不写入；overwrite本次全部覆盖；rename仅同名文件扩展名前追加服务端UTC毫秒，必须传requestId用于幂等重试。返回files的sourcePath/targetPath映射。保留两份可能需手工调整HTML相对引用，不会自动改写。权限与安全路径冲突不能绕过。",
                      obj({**PATH, "conflictPolicy": {"type": "string", "enum": ["ask", "overwrite", "rename"], "default": "ask"},
                           "requestId": STRING, "files": {"type": "array", "minItems": 1, "maxItems": 500,
                           "items": obj({"path": STRING, "contentBase64": STRING}, ("path", "contentBase64"))}},
                          ("workspaceId", "files")), service.upload, destructive=True)
        for kind in ("file", "folder"):
            self.register(kind + "_move", "移动或重命名" + ("文件。" if kind == "file" else "文件夹及子内容。"),
                          obj({**PATH, "newPath": STRING}, ("workspaceId", "path", "newPath")),
                          lambda user, args, kind=kind: service.node_move(user, args, kind), destructive=True)
            self.register(kind + "_delete", "删除" + ("文件，不可恢复。" if kind == "file" else "文件夹及子内容，不可恢复。"),
                          obj(PATH, ("workspaceId", "path")),
                          lambda user, args, kind=kind: service.node_delete(user, args["workspaceId"], args["path"], kind), destructive=True)
        self.register("share_list", "列出当前用户创建的分享。", obj({}),
                      lambda user, args: service.shares(user), read_only=True)
        self.register("share_create", "分享目录；expireHours为整数小时，0表示永久（默认）。",
                      obj({**PATH, "expireHours": INTEGER}, ("workspaceId",)), service.share_create)
        self.register("share_revoke", "撤销分享，仅分享者或管理员可用。", obj({"id": STRING}, ("id",)),
                      lambda user, args: service.share_delete(user, args["id"]), destructive=True)
        self.register("member_list", "列出有权访问的工作区成员。", obj(WORKSPACE, ("workspaceId",)),
                      lambda user, args: service.members(user, args["workspaceId"]), read_only=True)
        self.register("member_change", "邀请已有账号或调整协作权限；须传userId或userName，仅工作区管理者可用。",
                      obj({**WORKSPACE, "userId": STRING, "userName": STRING, "collaborate": BOOLEAN}, ("workspaceId",)), service.member_change, destructive=True)
        self.register("member_delete", "移除工作区成员，仅工作区管理者可用。",
                      obj({**WORKSPACE, "userId": STRING}, ("workspaceId", "userId")),
                      lambda user, args: service.member_delete(user, args["workspaceId"], args["userId"]), destructive=True)

    def register(self, name, description, schema, function, read_only=False, destructive=False):
        self.tools[name] = ({"name": name, "description": description, "inputSchema": schema,
                             "annotations": {"readOnlyHint": read_only, "destructiveHint": destructive,
                                             "idempotentHint": not read_only, "openWorldHint": False}}, function)

    def dispatch(self, user, request, version="2025-03-26"):
        if isinstance(request, list):
            if version != "2025-03-26" or not 1 <= len(request) <= 100:
                return 400, rpc_error(None, -32600, "此版本不支持批处理或批次数量无效")
            responses = []
            for item in request:
                _, response = self.dispatch(user, item, version)
                if response is not None:
                    responses.append(response)
            return (200, responses) if responses else (202, None)
        request_id = request.get("id") if isinstance(request, dict) else None
        if not isinstance(request, dict) or request.get("jsonrpc") != "2.0":
            return 400, rpc_error(None, -32600, "无效的JSON-RPC请求")
        if "id" in request and (type(request_id) not in (str, int)):
            return 400, rpc_error(None, -32600, "请求id必须是字符串或整数")
        method = request.get("method")
        if not isinstance(method, str):
            if "id" in request and ("result" in request or "error" in request):
                return 202, None
            return 400, rpc_error(request_id, -32600, "缺少method")
        params = request.get("params", {})
        if not isinstance(params, dict):
            return (202, None) if "id" not in request else (200, rpc_error(request_id, -32602, "params必须是对象"))
        if "id" not in request:
            return 202, None
        if method == "initialize":
            try:
                validate(params, obj({"protocolVersion": STRING, "capabilities": {"type": "object"},
                                     "clientInfo": {"type": "object"}, "_meta": {"type": "object"}},
                                    ("protocolVersion", "capabilities", "clientInfo")))
            except ValueError as exc:
                return 200, rpc_error(request_id, -32602, str(exc))
            version = params["protocolVersion"]
            result = {"protocolVersion": version if version in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[-1],
                      "capabilities": {"tools": {"listChanged": False}},
                      "serverInfo": {"name": "babaShare", "version": "1.0.0"},
                      "instructions": "操作继承密钥所有者的实时账号和工作区权限。文件路径均为相对路径；上传原型请使用file_upload保留目录结构。"}
        elif method == "ping":
            result = {}
        elif method == "tools/list":
            try:
                validate(params, obj({"_meta": {"type": "object"}}))
            except ValueError as exc:
                return 200, rpc_error(request_id, -32602, str(exc))
            result = {"tools": [definition for definition, _ in self.tools.values()]}
        elif method == "tools/call":
            return self.call(user, request_id, params)
        else:
            return 200, rpc_error(request_id, -32601, "方法不存在")
        return 200, {"jsonrpc": "2.0", "id": request_id, "result": result}

    def call(self, user, request_id, params):
        try:
            validate(params, obj({"name": STRING, "arguments": {"type": "object"}, "_meta": {"type": "object"}}, ("name",)))
            if params["name"] not in self.tools:
                return 200, rpc_error(request_id, -32602, "工具不存在")
            definition, function = self.tools[params["name"]]
            arguments = params.get("arguments", {})
            validate(arguments, definition["inputSchema"])
        except ValueError as exc:
            return 200, rpc_error(request_id, -32602, str(exc))
        failed = False
        try:
            with self.service.lock:
                stamp = now_ms()
                window = stamp // 60000
                self.tool_windows = {owner: usage for owner, usage in self.tool_windows.items() if usage[0] == window}
                _, count = self.tool_windows.get(user["id"], (window, 0))
                if count >= 120:
                    raise BizError(429, "MCP_THROTTLED", "每个账号每分钟最多调用120次工具")
                self.tool_windows[user["id"]] = (window, count + 1)
            value = function(user, arguments)
            value = {"items": value} if isinstance(value, list) else value
        except BizError as exc:
            failed, value = True, {"status": exc.status, "code": exc.code, "msg": exc.msg}
        except (ValueError, TypeError, KeyError, AttributeError):
            failed, value = True, {"status": "PARAM_INVALID", "code": 400, "msg": "业务参数不合法"}
        except sqlite3.IntegrityError:
            failed, value = True, {"status": "RESOURCE_CONFLICT", "code": 409, "msg": "资源已经存在或发生冲突"}
        except OSError:
            failed, value = True, {"status": "STORAGE_ERROR", "code": 400, "msg": "文件系统操作失败"}
        result = {"content": [{"type": "text", "text": json.dumps(value, ensure_ascii=False)}],
                  "structuredContent": value, "isError": failed}
        return 200, {"jsonrpc": "2.0", "id": request_id, "result": result}
