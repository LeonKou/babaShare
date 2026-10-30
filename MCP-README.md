# babaShare MCP 安装与使用说明

本文可交给 Codex 协助配置。只合并必要的 MCP 配置，保留已有其他 server；不要自动创建密钥、修改账户或调整安全设置。本文不含真实密钥，也不会修改你本机的 Codex 配置。

## 1. 服务地址与个人密钥

1. 打开 babaShare 的 `/baba-share/` 页面，登录后进入「个人中心」。
2. 创建 MCP Key：名称 1–100 字符，有效期可选预设、自定义 1–87600 整数小时或永久。每个账户最多有 10 个未撤销且未过期的有效密钥。
3. 新创建的密钥使用受保护主密钥派生，服务端只保存摘要与派生标记；列表不会返回明文。本人登录后可点击每条有效密钥的「复制使用」恢复并复制一次性配置说明。旧密钥只有摘要，返回 MCP_KEY_NOT_RECOVERABLE，请重新创建；旧密钥不会自动撤销。
4. 个人中心不再提供独立安装说明区；点击「复制使用」会使用当前浏览器 `window.location.origin`（包含实际协议、域名及非默认端口）动态生成 MCP 地址。

本文使用 `<SERVICE_ORIGIN>` 占位符，表示你实际打开服务时的 origin，不包含 `/baba-share/` 等路径，也不含结尾 `/`。MCP 地址为：

```text
<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp
```

不要把个人中心页面 URL 当成 MCP 地址，不要把密钥放入 URL 或 query。

### 密钥安全

- MCP Key 是 Bearer 凭据：持有者可以以你的身份调用你已有权限内的 MCP 工具。不要存进源码、配置明文、URL、日志、提交记录或公开聊天。
- 「复制使用」说明包含完整密钥，仅在你明确授权的前提下交给可信 AI 客户端；客户端应将密钥安全持久化到自己的私密环境文件或用户环境变量（Codex 支持 `bearer_token_env_var`），不得写入源码、项目 `.env`、URL、日志、shell 历史、提交或公开文件。页面不会修改本机 Codex 配置。
- 环境变量仍可被拥有相同用户权限的进程读取；在可信机器及可信客户端上使用。完成复制后清理剪贴板，怀疑泄露时立即在个人中心删除。
- 删除立即影响后续请求，物理移除记录及恢复信息且无法恢复；永久密钥也应定期检查与轮换。历史已撤销记录仅在用户主动删除时移除。

## 2. Windows PowerShell

在即将启动 Codex 的 PowerShell 中安全输入密钥。隐藏输入不会把真实密钥写入命令历史，切勿把真实值替换进会被记录或提交的脚本：

```powershell
$mcpSecret = Read-Host 'BABA_SHARE_MCP_KEY' -AsSecureString
$mcpPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($mcpSecret)
try {
    $env:BABA_SHARE_MCP_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($mcpPtr)
    [Environment]::SetEnvironmentVariable('BABA_SHARE_MCP_KEY', $env:BABA_SHARE_MCP_KEY, 'User')
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($mcpPtr)
    $mcpSecret.Dispose()
    Remove-Variable mcpSecret, mcpPtr
}
```

环境变量占位示例（**不要把真实值写入终端历史**）：

```powershell
$env:BABA_SHARE_MCP_KEY = '<YOUR_PERSONAL_MCP_KEY>'
```

将下面地址占位符替换成实际服务地址，在同一 PowerShell 执行：

```powershell
codex mcp add baba-share --url '<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp' --bearer-token-env-var BABA_SHARE_MCP_KEY
```

上面的设置同时更新当前进程和当前 Windows 用户的持久环境（不是系统级变量）。从该终端启动客户端可继承当前值；以后新客户端必须从已刷新用户环境的父进程启动。已经运行的终端、桌面客户端和启动器不会自动刷新，必要时重新登录用户会话；不能只关闭客户端窗口而保留旧后台进程。变量仍可被同用户进程读取，不应作为加密凭据存储；若客户端有私密凭据存储可优先使用。

## 3. Linux bash

在将要启动客户端的 bash 中隐藏输入：

```bash
read -r -s -p 'BABA_SHARE_MCP_KEY: ' BABA_SHARE_MCP_KEY; printf '\n'
export BABA_SHARE_MCP_KEY
```

环境变量占位示例（**不要把真实值写入终端历史**）：

```bash
export BABA_SHARE_MCP_KEY='<YOUR_PERSONAL_MCP_KEY>'
```

替换服务地址后，在同一终端执行并从该环境启动或重启客户端：

```bash
codex mcp add baba-share --url '<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp' --bearer-token-env-var BABA_SHARE_MCP_KEY
```

以上隐藏输入仅对当前会话及其子进程生效，不自动持久化。Linux/macOS 请另用客户端自己的私密环境文件（目录仅当前用户可访问、文件权限 `0600`），或当前用户的环境管理器，并让启动器显式加载后再启动客户端。不要将密钥写入共享 profile、项目 `.env`、团队配置或可提交脚本。私密文件应由可信 AI 的安全文件通道直接写入已提供的 key，不要把真实值拼进 shell 命令、日志或终端历史；无法安全传递时停止并说明限制，不能改成打印密钥。Windows 如选择私密文件也须使用仅当前用户 ACL。

## 4. Codex TOML 配置方式

也可以将以下段落**合并**至 `~/.codex/config.toml`（Windows 为 `$HOME/.codex/config.toml`）。保留已有其他 MCP server；若已有 `[mcp_servers.baba-share]`，更新原段而非重复追加。真实密钥不写入 TOML：

```toml
[mcp_servers.baba-share]
url = "<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp"
bearer_token_env_var = "BABA_SHARE_MCP_KEY"
```

客户端启动前仍须按上文设置环境变量，然后重启客户端。`codex mcp add --help` 已核实 `--bearer-token-env-var` 仅适用于 Streamable HTTP；若 CLI 或配置项不被本机客户端识别，应先核对已安装版本的帮助信息，不要改用 URL 传密钥。

## 5. OpenCode 配置

OpenCode 官方远程 MCP 配置使用 `type: "remote"`、`url`、`enabled: true`、`headers.Authorization`，并可用 `oauth: false` 禁用 OAuth 自动流程。将以下段落合并到用户级 `~/.config/opencode/opencode.json`（也支持 `opencode.jsonc`）；Windows 路径和 `OPENCODE_CONFIG` 覆盖请先按本机版本核对。保留已有其他 server，不创建项目配置，不写入真实 key：

```json
{
  "mcp": {
    "baba-share": {
      "type": "remote",
      "url": "<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp",
      "enabled": true,
      "oauth": false,
      "headers": {
        "Authorization": "Bearer {env:BABA_SHARE_MCP_KEY}"
      }
    }
  }
}
```

`{env:BABA_SHARE_MCP_KEY}` 是 OpenCode 的环境变量引用，不是字面 Bearer 值。请从设置了该变量的同一用户环境启动或重启 OpenCode；已经运行的客户端不会自动继承后续变量变化。

## 6. 其他 MCP 客户端

- 先核对本机客户端版本是否支持远程 **Streamable HTTP** 和安全 Bearer 凭据。Claude Desktop、Cline 等客户端的 JSON 配置并不通用；不支持时说明限制，不自动安装桥接器或执行未知命令。
- 传输选择 **Streamable HTTP**，不是 stdio，也不是旧版 SSE。
- URL 使用 `<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp`。
- 通过客户端安全的环境变量或凭据存储机制提供 `Authorization: Bearer <BABA_SHARE_MCP_KEY>`。尖括号表示环境变量的实际值，不是要发送的字面量；不同客户端的变量插值写法不通用，请按其配置约定设置。
- 客户端必须支持远程 HTTP Bearer 鉴权。该端点只使用 MCP Bearer 身份；网页登录 Cookie 或 OAuth 不能代替 MCP Key。
- 当前服务使用无会话 Streamable HTTP JSON-RPC，响应为 `application/json`；支持协议版本 `2025-03-26`、`2025-06-18`、`2025-11-25`，不要求长期 SSE 连接。

只读验证顺序：客户端执行 `initialize` → `notifications/initialized` → `tools/list`（确认 19 个工具）→ `workspace_list {}`。不要通过新建、修改或删除工作区来测试。成功结果包含 `content` 文本及 `structuredContent.items` 数组，空数组也表示验证成功。业务错误在 `result.isError=true` 中返回；协议错误使用 JSON-RPC `error`。

## 7. 远程 HTTPS 部署

`localhost`、`127.0.0.1` 和 `::1` 只表示客户端所在机器；不能让另一台机器连接你的服务。远程或跨设备访问必须使用客户端可达且证书可信的 HTTPS 地址。当前服务配置支持 IPv4/域名，不支持 IPv6 监听。

参考 `.env.example`，生产推荐由 Nginx 终止 HTTPS，再转发至一个 HTTP 上游；后端无需 TLS。公开来源只用于构造外部分享/预览 URL：

```dotenv
BABA_SHARE_PUBLIC_ORIGIN=https://share.example.com
BABA_SHARE_SECURE_COOKIE=1
```

以上域名为示例，请替换；origin 不应包含路径、凭据、query 或片段。`BABA_SHARE_PUBLIC_ORIGIN` 不是 Host/Origin 准入白名单；配错会影响生成链接的可达性，但不会因不匹配阻断正常代理登录/退出。外部 HTTPS 下 `BABA_SHARE_SECURE_COOKIE=1` 只是浏览器 Cookie 的 Secure 属性，不要求上游 HTTPS。域名准入、TLS 和入口限流由网关负责；应用保留认证、角色/工作区权限、未登录 401 导航、对 `Origin: null` 与明确跨站浏览器请求的阻断，也不会盲目信任 `X-Forwarded-*`。

监听地址/唯一端口由 `BABA_SHARE_HOST`、`BABA_SHARE_PORT` 配置。主页面、API、MCP 与 `/baba-share/preview/{s|p}/token/...` 原始预览复用同一端口。预览响应通过 CSP `sandbox`（不含 `allow-same-origin`）使用不透明来源隔离，而不是第二监听端口。代理不得移除或放宽 CSP、`Cache-Control`、`Set-Cookie` 等上游安全响应头、缓存带票据页面，或把原始上传目录作为普通静态站点另行发布。反向代理应原样保留 `/baba-share/`（含预览）和 `/api/baba-share/core/v1/` 路径并转发 `Authorization`；建议规范转发实际公开 `Host` 等头供运维使用，但透传公开 Host 不是认证的必要条件。不要记录 Authorization、Cookie、密钥或带预览票据的完整路径。

从实际公开 HTTPS 页面进入个人中心复制说明，页面将自动生成与当前浏览器 origin 一致的 MCP 地址，而不是依赖 `PUBLIC_ORIGIN` 选择 MCP 入口。可复制的 Nginx 单上游配置和更多部署说明见项目 `DEPLOYMENT.md`。

## 8. MCP 权限与工具

MCP 使用密钥所属用户的实时角色、禁用状态及工作区/内容权限；密钥本身不增加权限。管理员沿用现有可管理全部工作区的权限，所有者/成员沿用现有访问和内容归属规则，只读用户不能写入或创建分享。MCP 不暴露密钥、会话、用户账户或安全设置管理。

下列签名中 `?` 表示可选；`string` 为字符串，`integer` 为整数，`boolean` 为布尔值。仅接受已声明参数，不接受额外字段。

```text
workspace_list({})
workspace_create({workspaceName: string, description?: string})
workspace_change({id: string, workspaceName?: string, description?: string})
workspace_delete({id: string})
node_list({workspaceId: string, path?: string, pageIndex?: integer, pageSize?: integer, search?: string, sort?: "name"|"size"|"updateTime", order?: "asc"|"desc"})
folder_create({workspaceId: string, path: string})
file_read({workspaceId: string, path: string})
file_write({workspaceId: string, path: string, content: string})
file_upload({workspaceId: string, path?: string, conflictPolicy?: "ask"|"overwrite"|"rename", requestId?: string, files: [{path: string, contentBase64: string}]})
file_move({workspaceId: string, path: string, newPath: string})
folder_move({workspaceId: string, path: string, newPath: string})
file_delete({workspaceId: string, path: string})
folder_delete({workspaceId: string, path: string})
share_list({})
share_create({workspaceId: string, path?: string, expireHours?: integer})
share_revoke({id: string})
member_list({workspaceId: string})
member_change({workspaceId: string, userId?: string, userName?: string, collaborate?: boolean})
member_delete({workspaceId: string, userId: string})
```

- 文件/目录路径均为工作区内相对路径，空目录路径表示根目录；不得传绝对路径或 `..` 越界路径。
- `node_list` 默认 `path=""`、`sort="name"`、`order="asc"`，分页从 1 开始。
- `file_read` 读取 UTF-8 文本；`file_write` 写入 UTF-8 文本并按现有权限处理覆盖。
- `file_upload` 每次接受 1–500 个文件，使用标准 Base64，保留相对资源路径。大项目应按实际请求体限制分批；Base64 会使体积增大。
- `share_create.expireHours` 默认 `0` 表示永久；注意它与**密钥管理**中永久为 `null` 的约定不同。
- `member_change` 必须提供 `userId` 或 `userName`，`collaborate` 默认 `false`。
- 调用 `workspace_delete`、文件/文件夹移动或删除、`share_revoke`、`member_delete` 等破坏性操作前先向用户确认，不把安装说明视为执行授权。

### 同名冲突策略（HTTP 与 MCP 一致）

`POST /api/baba-share/core/v1/file/upload` 的 JSON body 与 `file_upload` 参数相同。

- `conflictPolicy` 默认为 `ask`：任何同名文件使整批暂停，返回 HTTP 200 业务预检结果 `requiresConfirmation=true`、`conflicts:[{path}]`、`count=0`、`files=[]`；目录、文件和元数据均不写入。MCP 的 `isError=false` 不代表已上传，客户端必须检查 `requiresConfirmation`。
- `overwrite`：明确授权本次调用的全部同名文件始终覆盖；未冲突文件正常新增。网页也可勾选“此页面后续上传始终覆盖”，切换工作区或刷新重置，仍检查权限，不影响服务端默认值。上传开始时冻结目标和策略，中途切换不会改变本批。取消或待确认保留文件选择，不提示上传成功。
- `rename`：只给冲突文件的扩展名前追加服务端 UTC 毫秒，例如 `site/index_1793376000123.html`；同毫秒目标已占用再生成 `index_1793376000123_1.html`。同批共用 `uploadTime`，不冲突文件不重命名，目录层级保留。
- `requestId` 为 16–100 位随机字母、数字、`_` 或 `-`（可使用 UUID）。`rename` 必填，其他策略可选。成功请求重试时必须复用相同参数及 requestId，返回原结果，不创建第三份；同 requestId 不同参数返回 `409 REQUEST_CONFLICT`。`ask` 的未执行预检不占用 requestId，因此确认后可沿用它选择策略。
- 成功返回 `requiresConfirmation=false`、`count`、`conflictPolicy`、`conflicts`、`uploadTime`（UTC 毫秒整数）及 `files:[{sourcePath,targetPath,overwritten}]`；所有映射路径相对工作区，包含目标目录前缀。
- 所有策略先验证角色、原路径内容归属、递归权限、大小写与安全路径，再决定是否重命名；重命名不是绕过他人内容权限的方式。文件/目录同名、父路径非目录、大小写别名及危险路径仍拒绝，不会粗暴覆盖。
- 保留两份可能重命名 `index.html` 或 CSS/JS/图片，导致入口和相对引用需要手工调整；系统不会擅自重写 HTML。若要原样运行完整原型，建议选择新的目标文件夹，或经确认覆盖原批资源。
- 全批原子预检保证冲突、非法参数或无权限时零写入；先暂存全批新内容与被覆盖文件备份，再替换目标，节点元数据与 `upload_request` 使用同一个数据库事务。运行时替换/SQL/提交失败回滚元数据并补偿恢复已替换文件、删除本批新目录；成功才留下幂等记录。进程被强杀、系统断电或恢复本身再次遭遇磁盘故障不属于跨文件系统原子事务保障，应停止写入并人工核验。幂等记录不含文件原文或凭据，随数据库一起备份。
- 同根目录的 Service 实例共享进程锁，数据库 BEGIN IMMEDIATE 串行处理同ID；生产现有 RuntimeLock 防多进程共同运行。重放不写文件，仍重检当前用户、角色、工作区及内容权限。
- 每批1–500个文件，整体请求（含Base64和JSON开销）必须在服务端max_body_bytes内，超限整批拒绝，不自动拆批。

### 保留相对资源路径上传示例

假设原型目录为：

```text
prototype/
  index.html
  css/site.css
  js/app.js
  images/logo.png
```

`index.html` 中继续使用 `css/site.css`、`js/app.js`、`images/logo.png` 等相对引用，不要只上传入口 HTML，也不要把每个资源扁平化到根目录。

给 Codex 的操作要求可以是：

> 使用 baba-share 的 workspace_list 选择我指定的工作区；未经确认不要创建或删除工作区。读取本地 prototype 目录的文件，保留其相对路径，使用 file_upload 上传到 demos/my-prototype。对二进制文件按原始字节进行标准 Base64 编码。先列出将覆盖的目标文件并请求确认，再执行可能覆盖的上传。不要上传 .env、密钥、版本控制目录或其他未授权文件，不要执行上传内容。

工具调用参数结构（编码占位符必须替换为实际文件字节的 Base64，不可照字面发送）：

```json
{
  "workspaceId": "<WORKSPACE_ID>",
  "path": "demos/my-prototype",
  "files": [
    { "path": "index.html", "contentBase64": "<BASE64_OF_INDEX_HTML_BYTES>" },
    { "path": "css/site.css", "contentBase64": "<BASE64_OF_SITE_CSS_BYTES>" },
    { "path": "js/app.js", "contentBase64": "<BASE64_OF_APP_JS_BYTES>" },
    { "path": "images/logo.png", "contentBase64": "<BASE64_OF_LOGO_PNG_BYTES>" }
  ]
}
```

上传后用 `node_list` 检查 `demos/my-prototype` 及子目录，并通过页面预览验证资源引用；需要分享时再明确请求 `share_create`。

## 9. 密钥管理 HTTP API（只供网页登录会话）

以下接口仅接受已登录浏览器 Cookie 会话，不能用 MCP Bearer 密钥调用，也不暴露为 MCP tools。成功直接返回业务对象/数组，不含 `data` 外包装。

### 列表

```text
GET /api/baba-share/core/v1/mcp-key/list
```

返回元数据数组，包含 `id`、`keyName`、`keyPrefix`、`createTime`、`updateTime`、`expireTime`、`revokedTime`、`isActive`。时间为 UTC 毫秒，永久的 `expireTime=null`，未撤销时 `revokedTime=null`。不返回明文或摘要。列表包含有效、过期及已撤销记录。

### 创建

```text
POST /api/baba-share/core/v1/mcp-key
Content-Type: application/json
```

```json
{
  "keyName": "My Codex",
  "expireHours": 720,
  "requestId": "<RANDOM_16_TO_100_CHAR_ID>"
}
```

`keyName` 去除首尾空白后长 1–100；`expireHours` 为 `null` 表示永久，否则为 1–87600 整数小时。`requestId` 必填，是 16–100 位随机字母、数字、`_` 或 `-`，可使用 `crypto.randomUUID()`；同用户、相同参数重试复用该值。

首次成功返回列表元数据并附 `key` 明文，格式为 `bsk-` 前缀的 256 位凭据。新密钥由 HMAC-SHA256（受保护 master + 固定上下文 + 所有者 UUID + 密钥 UUID + 32 字节随机 nonce）派生。数据库只保存 SHA-256 鉴权摘要、非秘密版本及 nonce，不保存明文。重复创建请求仍返回 `409 KEY_ALREADY_CREATED`，不新增密钥；可在列表中复制使用。同 requestId 不同参数返回 `409 REQUEST_CONFLICT`。

### 恢复本人有效密钥

```text
POST /api/baba-share/core/v1/mcp-key/content
Content-Type: application/json

{"id":"<KEY_ID>"}
```

仅接受当前用户有效 Cookie，并应用与其他浏览器 API 相同的来源防护：拒绝 `Origin: null` 和明确的跨站浏览器请求，不将 Origin/Host 与 `PUBLIC_ORIGIN` 绑定；MCP Bearer 不能调用。返回 `{ "key": "<FULL_KEY>" }`，带 `Cache-Control: no-store`，不在日志中记录。敏感内容不通过 GET、URL、列表或桥接通信返回；该 POST 只读取凭据，不生成新密钥。跨用户返回 `404 MCP_KEY_NOT_EXIST`；撤销或过期返回 `409 MCP_KEY_INACTIVE`；旧密钥无派生标记返回 `409 MCP_KEY_NOT_RECOVERABLE`。不会自动撤销或轮换。

主密钥 `<DATA_DIR>/data/mcp-key-master` 是随机 32 字节，以排他创建方式生成（POSIX 0600），仅首次真正创建新密钥时生成。拒绝符号链接、不安全权限、读取失败及错误长度。已有派生密钥时主密钥缺失不会重建；每次恢复还以 `key_hash` 验证结果，丢失或替换 master 返回 `503 MCP_KEY_RECOVERY_UNAVAILABLE`，绝不返回错误凭据。完整备份和迁移必须同时保护数据库、filedb 与该 master；master 泄露等价于可恢复数据库中全部新密钥。启动自动添加可空派生列，旧密钥仍可用于鉴权但不可恢复。

### 删除

```text
DELETE /api/baba-share/core/v1/mcp-key?id=<KEY_ID>
```

只能删除本人密钥，成功返回 `{}`，重复删除幂等。物理删除整条 `auth_mcp_key` 记录（含鉴权摘要、派生 nonce/版本及请求恢复上下文），后续认证立即 401、内容恢复返回 `404 MCP_KEY_NOT_EXIST`；个人中心立即移除卡片，不保留新「已撤销」记录。有效、过期、历史已撤销密钥均可主动删除；启动不会自动清理历史 revoked 数据。删除不会修改其他密钥或共享 master。SQLite 连接启用 secure_delete，清除本次删除记录在当前数据库释放页中的内容；这不等于擦除历史备份、快照或存储设备物理介质。其他错误包括 `409 MCP_KEY_LIMIT`、`400 PARAM_INVALID`、`404 MCP_KEY_NOT_EXIST`、`401 AUTH_REQUIRED`；客户端用 HTTP 状态及响应 `status` 判断，不展示服务端原始调试信息。

## 10. 排查与安全边界

- 仅检查环境变量是否存在，不回显其值；不要输出环境变量全集、Authorization、完整配置或密钥，也不要将其写入日志、shell 历史或项目文件。
- **401 / AUTH_REQUIRED**：检查客户端进程是否继承环境变量、密钥是否过期或已撤销、账户是否被禁用；不要把密钥贴入诊断日志。
- **403 / ORIGIN_DENIED**：检查是否为沙箱 `Origin: null` 或明确跨站浏览器请求，并区分网关拒绝与角色权限不足；不要绕过来源防护。`PUBLIC_ORIGIN` 与上游 Host/浏览器 Origin 不一致不应阻断正常代理登录/退出；链接指向错误时才需校正该 URL 配置。
- **HTTP 200 + `result.isError=true`**：这是工具业务错误。`PERMISSION_DENIED`、`READ_ONLY`、`FOREIGN_CONTENT` 表示角色、工作区或内容归属权限不足；`MCP_THROTTLED` 表示需要等待限流窗口。
- **JSON-RPC `error`**：检查协议版本、方法名和参数 schema。
- **连接失败**：检查实际域名/端口、反代 API 路由、Authorization 转发和可信证书；不要把另一台机器的 localhost 当作服务地址。
- **配置后没有变化**：重启客户端，并确认它从设置过变量的环境启动；CLI 配置操作成功不等于客户端进程已获得变量。
- 完成复制后清理剪贴板，密钥泄露时立即删除。

## 11. 密钥恢复常见问题

- **创建请求超时**：使用相同 requestId 重试并刷新列表；若服务器已经创建新密钥，点击该卡片「复制使用」即可。历史密钥返回 `MCP_KEY_NOT_RECOVERABLE` 时请主动另建；不会自动撤销历史密钥。
- **恢复不可用**：正确恢复对应 `data/mcp-key-master` 备份，不要删除或换成随机新文件；旧的摘要鉴权与现有密钥状态不受恢复失败影响。
