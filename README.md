# babaShare

轻量、自托管的 HTML 原型协作与分享平台。把原型及其 CSS、JavaScript、图片上传到工作区，即可管理目录、邀请成员、在线预览并生成分享链接；也可以通过 MCP 让 Codex、OpenCode 等工具直接推送原型。

**Python 标准库 + SQLite + 原生 HTML/CSS/JavaScript，无需 pip/npm 安装、无需编译。一个 Python 进程、一个 HTTP 监听端口，同时承载页面、API、MCP 和受控原型预览。**

## 核心功能

- **工作区协作**：左侧工作区、中间多级文件目录、右侧成员名单；所有者/管理员生成邀请链接，已有账号打开后自动加入，可明确选择协作权限。
- **文件管理**：文件夹、批量上传、在线 UTF-8 编辑、移动、重命名、删除、搜索、排序和分页。
- **上传冲突处理**：覆盖、保留两份或取消；保留两份在扩展名前追加上传时间。
- **原型预览**：目录入口优先匹配 `index.html`，其次 `home.html`，忽略大小写；支持全屏。
- **限时分享**：分享目录，设置有效期或永久有效，可随时删除并立即使链接失效；分享页提供目录树和预览。
- **账号权限**：管理员、编辑者、查看者；管理员管理账号及开放注册开关，查看者始终只读。
- **MCP 接入**：个人中心创建、删除密钥，最多 10 个有效密钥；“复制使用”一次复制当前站点地址、本人密钥及配置指南。
- **多语言与主题**：简体中文、英语、阿拉伯语，支持 RTL 和明暗主题；前端采用母版页 + 独立子 iframe。

## 快速开始

### 运行要求

- Python **3.12 或更高版本**，包含标准库 `sqlite3`。
- Windows 或 Linux；监听使用 IPv4。
- 可写、空间充足的本地数据目录；代码目录不需要写权限。
- 现代浏览器。上传的服务端脚本不会执行，平台不是 PHP/Python/Node.js 应用托管运行环境。

### Windows

在项目根目录打开 PowerShell，确认 Python 版本后运行：

```powershell
python --version
python server.py
```

如使用 Python Launcher，也可用 `py -3.12 server.py`（需要已安装对应版本）。

### Linux

```bash
python3 --version
python3 server.py
```

默认监听 **`0.0.0.0:8080`**（所有 IPv4 网卡）。本机打开 **http://127.0.0.1:8080/baba-share/**，其他设备使用服务器真实 IP 或域名，按页面提示创建第一个管理员。`0.0.0.0` 是监听地址，不是浏览器访问地址或外部链接地址；应用不会自动放行防火墙，管理员需按预定访问范围配置网络策略。默认关闭开放注册；管理员可创建账号或开启注册，公开注册账号默认为查看者。

前台运行时按 `Ctrl+C` 停止。应用会尝试排空正在处理的请求，默认共享最长 10 秒。不要把前台命令当作系统服务使用。

> 首次初始化入口应只向可信管理员开放。部署公网前，先在受控网络完成管理员初始化，再配置 HTTPS 和访问策略。

## 单服务架构

```text
浏览器 / MCP 客户端
        |
        v
一个 HTTP 服务（默认监听 0.0.0.0:8080）
  ├─ /baba-share/                         管理界面与静态资源
  ├─ /api/baba-share/core/v1/             HTTP API
  ├─ /api/baba-share/core/v1/mcp          MCP
  ├─ /baba-share/s/{token}                可信分享页面
  └─ /baba-share/preview/{s|p}/{token}/   受控原始预览资源
        |
        ├─ SQLite：账号、权限、节点、分享、密钥摘要
        └─ filedb：上传文件
```

不需要单独启动前端服务，也不需要第二个预览端口或第二个预览域名。反向代理只需代理这一个服务。

### 预览隔离与兼容性

预览资源 URL 与站点使用同一 Origin，但**执行上下文不是受信任的站点上下文**：原始预览响应使用 CSP `sandbox allow-scripts`，iframe 同时启用沙箱，不授予 `allow-same-origin`。响应级沙箱也用于直接打开原始预览链接的场景，而不只依赖 iframe 属性。

预览限制外部连接、表单、嵌套 frame、object 等能力；主站 API 拒绝预览的 `Origin: null` 和明确的跨站浏览器请求，不以公开域名配置绑定请求 Host/Origin。登录 Cookie 的 Path 限于 `/api/baba-share/core/v1`；原始预览响应移除 `Set-Cookie`，不开放带凭据 CORS。不要为“修复兼容性”添加 `allow-same-origin`、取消 CSP 或放宽 API 的 CORS。

本产品面向静态原型：请保留相对资源路径，根绝对路径不会自动重写。依赖联网 API、登录态、浏览器持久化、弹窗或其他受限能力的原型可能无法完整运行。分享链接及预览 ticket 本身是访问凭据，请勿公开不应公开的链接。

## 配置

可复制 `.env.example` 为项目根目录的 `.env`，也可直接注入进程环境变量；**同名进程环境变量优先**。只读取项目根 `.env`，不会扫描其他目录。修改后需重启服务。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BABA_SHARE_DATA_DIR` | 项目根目录 | 唯一数据根；相对路径按项目根解析 |
| `BABA_SHARE_HOST` | `0.0.0.0` | 监听所有 IPv4 网卡；可显式设 `127.0.0.1` 限制本机访问 |
| `BABA_SHARE_PORT` | `8080` | 唯一 HTTP 监听端口 |
| `BABA_SHARE_PUBLIC_ORIGIN` | 通配监听时为 `http://127.0.0.1:8080` | 其他监听按地址和端口生成；外部访问须填真实 IP/域名，例如 `https://share.example.com`，不包含路径，不使用 `0.0.0.0`；仅构造外部分享/预览 URL，不用于 Host/Origin 准入 |
| `BABA_SHARE_SESSION_HOURS` | `24` | 登录会话有效小时数 |
| `BABA_SHARE_TICKET_SECONDS` | `900` | 私有预览 ticket 有效秒数 |
| `BABA_SHARE_MAX_BODY_BYTES` | `67108864` | 请求体上限，含 JSON/Base64 开销，不等于原始文件大小 |
| `BABA_SHARE_SECURE_COOKIE` | `0` | HTTPS 部署必须设为 `1`，使登录 Cookie 带 Secure |

示例：向局域网提供访问时，监听 `0.0.0.0`，将公开 Origin 设置为实际访问地址 `http://192.168.1.20:8080`，以生成可访问的分享/预览链接。该值配错不会因 Host/Origin 不匹配使正常代理登录或退出返回 403，但生成的链接可能不可访问。

生产推荐 **Nginx 终止 HTTPS → HTTP 上游**：域名准入、TLS 和入口限流由网关负责，后端无需配置 TLS，也不要求透传公开 Host 才能认证。仍建议规范转发头便于运维；应用不会盲目信任 `X-Forwarded-*` 来决定准入。外部为 HTTPS 时设 `BABA_SHARE_SECURE_COOKIE=1`，它只是浏览器 Cookie 的 Secure 属性，不要求上游使用 HTTPS。可复制的 Nginx 单上游示例见部署手册。

不再支持 `PRODUCT_SHARE_*` 旧环境变量及 `BABA_SHARE_PREVIEW_PORT` / `BABA_SHARE_PREVIEW_ORIGIN`。不要把 MCP 密钥写入项目 `.env`。

## 部署方式

详细步骤、账号权限、反向代理、故障恢复和自动部署约束请阅读 **[DEPLOYMENT.md](DEPLOYMENT.md)**。

### Windows 服务

服务固定使用 `LocalService`，默认数据根为 `%ProgramData%\babaShare\data`，不会自动搬迁项目历史数据。HTTP 就绪检查失败时可能保留已注册服务，请先诊断，不要重复安装；完整行为见部署手册。

项目提供：

- `scripts/install-windows-service.bat`：安装并启动服务。
- `scripts/uninstall-windows-service.bat`：停止并移除服务注册，**保留程序、配置、日志和业务数据**。

服务包装依赖 NSSM，二进制不内置，需要管理员按部署手册从官方获取。安装涉及目录和权限设置、数据库初始化、服务注册及自启动；先阅读部署手册，不要在未知数据目录上盲目运行。

### Docker Compose

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
docker compose logs --tail=100
```

默认宿主发布 `0.0.0.0:8080`；本机访问 http://127.0.0.1:8080/baba-share/，其他设备使用宿主真实 IP 或域名，并显式配置 `BABA_SHARE_PUBLIC_ORIGIN` 以生成可访问链接。仅供本机代理时可设置 `BABA_SHARE_PUBLISH_IP=127.0.0.1`。容器使用非 root 用户、只读根文件系统和完整数据根持久卷。**必须持久化整个数据根，而不是只挂载 `filedb` 或单个 SQLite 文件。**

Compose 的宿主发布端口和 Origin 可通过变量调整；公网、HTTPS、自定义域名和 bind mount 的所有者/ACL 设置见部署手册。不要使用 `docker compose down -v`、卷删除或卷清理命令作为普通卸载方式。

## 权限模型

| 能力 | 管理员 | 编辑者 | 查看者 |
| --- | --- | --- | --- |
| 查看工作区 | 全部 | 自己拥有或被邀请的工作区 | 自己有权访问的工作区 |
| 创建工作区 | 可以 | 可以 | 不可以 |
| 修改文件 | 可以 | 在工作区及文件归属权限范围内 | 不可以 |
| 管理工作区及成员 | 可以 | 自己拥有的工作区 | 不可以 |
| 管理账号及注册设置 | 可以 | 不可以 | 不可以 |
| 使用 MCP | 继承实时权限 | 继承实时权限 | 只读 |

非协作编辑成员只能修改自己有权修改的内容；协作编辑成员可修改工作区其他成员内容。递归操作也检查子节点权限。**协作设置不会把查看者变成编辑者。**

## 工作区邀请链接

工作区成员区的「邀请成员」生成可多人使用的邀请链接，默认有效期 7 天，可选 1/7/30 天。仅当前有效的所有者或管理员可生成和管理，查看者不能生成；默认非协作，生成时可明确选择协作，查看者即使被授予协作仍只读。

- 链接为固定 `/baba-share/invite.html#invite=<token>`，token 使用随机 256 位凭据。数据库只存 SHA-256 摘要；链接仅生成成功时显示一次，列表不能恢复原链接。
- 已有账号在浏览器打开可信邀请页后，脚本自动发送 POST 加入；GET 页面或接口本身不会修改成员。未登录先进入固定登录页，登录成功仅回到固定邀请页继续 POST，不接收 returnUrl，不自动注册账户。
- 生成后展示/复制的邀请 URL 使用当前浏览器 origin 和固定 invite 页面，不受旧 `BABA_SHARE_PUBLIC_ORIGIN` 地址影响。
- token 仅通过 URL fragment 传递，页面读取后立即清除地址栏片段；不写 localStorage/sessionStorage，不发送到桥接上下文。原邀请页面刷新后需要重新打开邀请链接。服务响应统一使用 `Referrer-Policy: no-referrer`。
- 加入使用数据库写事务与唯一成员约束，已有成员重复打开幂等，不修改既有协作设置。每次消费实时检查创建者仍未禁用、非查看者且具有该工作区管理权限。
- 「管理邀请」可删除有效或过期邀请。删除/过期/创建者失权后不能再加入；已加入成员不自动移除。删除工作区时同事务清除邀请记录（应用层级联，无数据库外键）。
- HTTP 会话接口：`GET /api/baba-share/core/v1/invitation/list?workspaceId=...`、`POST /api/baba-share/core/v1/invitation`（`workspaceId`、16–100 位随机 `requestId`、可选 `collaborate=false`、`expireHours=168`）、`DELETE /api/baba-share/core/v1/invitation?id=...`、`POST /api/baba-share/core/v1/invitation/membership`（`token`）。全部要求 Cookie 登录，未登录不暴露工作区成员信息。同 requestId 重试返回 `409 INVITATION_ALREADY_CREATED` 而非重复生成；不同参数返回 `409 REQUEST_CONFLICT`。

## 上传策略

网页遇到同名文件时，整批先确认，默认不发生写入：

- **覆盖**：覆盖本批所有同名文件。
- **保留两份**：只对冲突文件追加 `_UTC毫秒`，仍冲突则追加序号，例如 `demo_1790000000000.html`。
- **取消**：不写入，保留当前文件选择。

网页的“本页后续始终覆盖”仅当前页面有效，切换工作区或刷新后重置。MCP/HTTP 上传使用 `conflictPolicy: ask | overwrite | rename`；`rename` 必须提供随机 `requestId`，以便成功后重试返回原结果而不重复新增。

`ask` 返回 `requiresConfirmation: true` 时并未上传成功，即使 HTTP 为 200 或 MCP `isError` 为 false。单批最多 500 个文件，整体受请求体上限约束。

**保留两份不会重写 HTML 中的 CSS/JS/图片引用**，上传整套原型通常应选择新目录或确认覆盖。上传具有批次预检、事务及运行时故障补偿，但不承诺断电/强杀时跨数据库与文件系统完全原子。

## MCP：从 AI 编程工具推送原型

1. 登录个人中心，创建 MCP Key，设置有效期。
2. 点击该 Key 的 **“复制使用”**。
3. 将复制的配置指南交给 Codex、OpenCode 等工具配置。
4. 先通过列出工作区验证认证与权限，再执行上传。

地址为：

```text
<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp
```

使用 Streamable HTTP + Bearer Key；不是 stdio，也不是旧版 SSE。共提供 19 个工作区、文件、成员和分享工具，不开放用户管理、密钥管理或安全设置工具。权限实时跟随账号，删除密钥、禁用账号或移除工作区权限后，不应继续依赖旧访问能力。

完整客户端配置、协议说明、上传幂等和安全注意事项见 **[MCP-README.md](MCP-README.md)**。复制内容包含私密密钥，请勿粘贴到公共聊天、源码仓库、日志或工单；不要把密钥放在 URL 中。

## 数据布局、备份与升级

```text
BABA_SHARE_DATA_DIR/
├─ data/
│  ├─ baba-share.sqlite3     数据库
│  ├─ mcp-key-master         创建可恢复 MCP Key 后存在的主密钥
│  └─ .baba-share.lock       运行实例锁
└─ filedb/
   └─ <workspace UUID>/     按相对目录保存上传文件
```

- 一个数据根只允许一个运行实例；不要用同一目录同时启动服务和 `--check`。
- `python server.py --check` **不是只读检查**：会创建目录、写探针、初始化数据库并检查运行条件。
- 备份前先停止服务，或使用能够保证一致性的快照；备份整个根目录，成套保留数据库、上传文件和 MCP master。不要运行中只拷贝数据库主文件而忽略 WAL/SHM。
- master 丢失不会自动重建；数据库和 master 一起泄漏可影响可恢复 MCP Key，因此备份同样需要严格权限。
- 数据没有默认静态加密；请按需使用磁盘加密及私密备份存储。
- 升级：先停止服务并验证备份，再替换代码、检查配置并启动；回退时要考虑数据库结构兼容性，不要只回退程序文件。
- 只使用规范库名 `data/baba-share.sqlite3`。检测到旧 `data/product-share.sqlite3` 时拒绝启动，不自动读取、迁移或删除，以免静默创建空库。历史数据目录不要自行合并或删除；代码清理不代表数据已迁移。

## 开发与测试

运行全部测试：

```bash
python -m unittest discover -s tests -v
```

测试应使用独立临时数据目录和随机端口；不要把真实业务数据根或历史 `.validation` 数据传给测试。无需启动前端构建服务。

```text
server.py          启动入口
backend/           配置、HTTP控制器、业务服务、SQLite仓储、MCP、运行预检
web/               母版页、子iframe页面、公共样式和原生JavaScript
scripts/           Windows服务安装和卸载脚本
tests/             自动化测试
Dockerfile         容器镜像定义
compose.yaml       单服务部署与完整数据卷
.env.example       配置示例
DEPLOYMENT.md      宿主机、Windows服务、Linux及Docker部署手册
MCP-README.md      MCP接入与工具使用指南
```

## 常见问题

**网页能打开，API 返回 403？** 先区分网关拒绝、角色权限不足和应用来源防护：检查是否为沙箱 `Origin: null`、明确跨站浏览器请求或无权操作。`BABA_SHARE_PUBLIC_ORIGIN` 不是准入白名单，其与上游 Host/浏览器 Origin 不同不应阻断正常代理登录/退出。HTTPS 下会话丢失还应检查 Secure Cookie 与浏览器实际访问协议；不要放宽沙箱或 CORS。

**数据库为空或工作区找不到？** 核对当前数据根和启动日志，不要创建多个散落的数据根。停止操作并核对备份，不要先删库重试。

**提示目录不可写、权限不安全或 master 异常？** 检查运行账号、挂载所有者及 Windows ACL。不要用 777、删除 master 或重建数据库绕过检查。

**上传超限？** 默认 64MiB 是整个 JSON 请求上限，Base64 会增加体积；拆分合理批次或按部署手册调整限制，同时检查代理请求体限制。

**预览与原网页不完全一致？** 确认相对资源路径及大小写，查看是否依赖被沙箱禁止的网络、存储、表单或窗口能力；不要通过放松安全边界解决。

**服务启动失败或端口冲突？** 查看日志、Python版本、数据根实例锁及唯一监听端口。Windows服务还要检查NSSM、Python和项目路径是否对服务账号可访问。更多诊断见部署手册。
