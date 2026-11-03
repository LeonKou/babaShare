<div align="center">

<img src="docs/assets/favicon.svg" width="80" height="80" alt="babaShare 标识">

# babaShare

### 让原型从「我的电脑」走到「团队面前」

自托管的 HTML 原型协作与分享平台。<br>
上传文件、邀请伙伴、分享链接，也可以让 AI 编程工具直接交付原型。

<p>
  <img src="https://img.shields.io/badge/Python-3.12%2B-3776AB?style=flat-square&amp;logo=python&amp;logoColor=white" alt="Python 3.12 或更高版本">
  <img src="https://img.shields.io/badge/Backend-Standard%20Library-0F766E?style=flat-square" alt="后端仅使用 Python 标准库">
  <img src="https://img.shields.io/badge/Database-SQLite-003B57?style=flat-square&amp;logo=sqlite&amp;logoColor=white" alt="SQLite 数据库">
  <img src="https://img.shields.io/badge/MCP-Streamable%20HTTP-111827?style=flat-square" alt="MCP Streamable HTTP">
  <img src="https://img.shields.io/badge/Deploy-Windows%20%7C%20Linux-475569?style=flat-square" alt="支持 Windows 与 Linux">
</p>

**[项目主页](https://leonkou.github.io/babaShare/) · [快速开始](#quick-start) · [部署指南](DEPLOYMENT.md) · [MCP 接入](MCP-README.md) · [反馈问题](https://github.com/LeonKou/babaShare/issues)**

</div>

---

## 原型完成了，分享不该成为下一项工程

一个 HTML 原型，往往不止一个 HTML 文件：还有样式、脚本、图片，以及需要一起看、一起改的伙伴。babaShare 把文件管理、在线预览、团队协作和对外分享放进同一个工作区。

**不必另起前端服务，不必为每个原型单独部署，也不必为了分享安装一整套应用开发环境。**

```text
你或 AI 编程工具          babaShare 工作区              团队与访客

HTML / CSS / JS   ──→    上传 · 组织 · 预览    ──→    邀请成员协作
图片 / 文档 / 代码        文件夹 · 成员 · 权限          通过链接查看
网页上传 / MCP           一个服务，一个端口            到期或撤销即失效
```

| 为谁准备 | 可以怎样用 |
| :--- | :--- |
| 产品经理与设计师 | 把可交互原型交给团队评审，不再反复打包发送文件 |
| 开发者与 AI 编程用户 | 从浏览器上传，或通过 MCP 将生成的原型直接推送到工作区 |
| 小团队与内部项目组 | 在自己的服务器上管理文件、成员权限和分享链接 |

<a id="highlights"></a>
## 为什么选择 babaShare

| 能力 | 你能获得什么 |
| :--- | :--- |
| **单服务，自托管** | Python 标准库 + SQLite + 原生 HTML/CSS/JavaScript；页面、API、MCP 和预览共用一个 HTTP 端口 |
| **原型即传即看** | 保留目录结构上传 HTML、CSS、JavaScript 和图片，自动识别 `index.html` / `home.html` 入口 |
| **团队协作有边界** | 账户 admin/editor 与空间 viewer/editor/manager 两层角色；支持邀请、个人配额、全局空间管理和资产转交 |
| **分享链接可控** | 按目录分享，设置有效期或永久有效；撤销后立即失效，分享页自带可收起目录树 |
| **AI 工具直接接入** | 远端 MCP + 个人密钥，让 Codex、OpenCode 等支持该协议的客户端管理和上传原型 |
| **不只预览 HTML** | 图片、音视频、PDF、Markdown、文本、代码与 Office；本地 Monaco 高亮、浏览器内 Office 转换 |
| **完整账号流程** | 可配置公开注册、邮箱激活、忘记密码、首次绑定邮箱与原／新邮箱双验证换绑 |
| **照顾日常使用** | 中文 / English / العربية、RTL、明暗主题、六种强调色，以及键盘操作和提交反馈 |
| **让第一次创作值得纪念** | 六项新手任务记录真实操作，完成后解锁「作品启航」拟人纸飞机动画与昵称纪念画面 |

> **轻的是运行架构，不是所有静态资源的体积。** 应用后端无需安装第三方 Python 包，也无需前端编译；仓库内置 Monaco 和 Office SDK、字体及转换器运行产物；Office 已移出源码归档、排除调试映射，并裁掉三个桌面编辑器的六个 IE bundle；installer 的新安装规则另排除禁用帮助界面的图文资源，但存量 669 个 help 文件（9,038,861 字节）因删除保护仍保留，未绕过。具体安装体积以当前文件统计为准。克隆与部署请预留空间，浏览器按对应预览功能加载资源。

### 先选你要做的事

**[运行项目](#quick-start)** · **[了解预览](#file-preview)** · **[接入 AI 工具](#mcp)** · **[了解权限](#permissions)** · **[配置与部署](#deployment)** · **[备份升级](#data)** · **[参与贡献](#contributing)**

<a id="quick-start"></a>
## 快速开始

### 1. 获取项目

需要 **Python 3.12+**（包含标准库 `sqlite3`）、Windows 或 Linux，以及现代浏览器。

```bash
git clone https://github.com/LeonKou/babaShare.git
cd babaShare
```

### 2. 启动服务

**Windows · PowerShell**

```powershell
python --version
python server.py
```

**Linux**

```bash
python3 --version
python3 server.py
```

没有 `pip install`，没有 `npm install`，也没有构建步骤。Windows 使用 Python Launcher 时，也可运行 `py -3.12 server.py`。

### 3. 创建管理员，分享第一个原型

打开 **[http://127.0.0.1:8080/baba-share/](http://127.0.0.1:8080/baba-share/)**，按页面提示完成首次初始化。

1. **创建工作区**，为项目建立文件目录。
2. **上传原型及依赖资源**，尽量使用相对路径。
3. **点击预览**，确认交互与资源加载正常。
4. **生成分享链接**，或邀请已有账号加入协作。

> [!IMPORTANT]
> 默认监听 `0.0.0.0:8080`，即所有 IPv4 网卡；`0.0.0.0` 不是浏览器访问地址或外部链接地址。应用不会自动放行防火墙。首次初始化只应向可信管理员开放；对外部署前，请在受控网络完成初始化并配置 HTTPS 和访问策略。

默认关闭公开注册。管理员可以创建账号或开启注册；普通公开注册和邮箱激活创建的账号均为**普通用户（editor）**，不能访问管理员设置。前台运行按 `Ctrl+C` 停止，正在处理的请求共享最长 10 秒退出等待；长期运行请使用服务或容器部署。

### 第一次使用：完成六件小事，让作品启航

普通用户可从侧栏或个人中心进入「新手任务」：**进入工作区 → 创建文件夹 → 上传文件 → 成功预览 → 创建 MCP Key → 通过 MCP 成功交互一次**。任务不要求按顺序完成，也不要求邀请伙伴或公开作品；没有可写权限时，引导创建自己的工作区，不改变已有空间权限。网页不提供单独新建 HTML 的入口，各种格式统一通过上传进入系统，已有文本文件仍可在线编辑。

MCP 任务先在个人中心创建密钥并复制接入说明，再由客户端成功调用一次工具，例如获取目录树。仅连接、初始化或列出工具不计完成；业务失败、待确认且未执行的操作也不计完成。

- 进度按账户保存在服务器，网页与 MCP 的相应成功操作共同累计；刷新或换设备不丢失，删除作品不倒退。失败、取消、冲突待确认和回滚不计完成。
- 预览任务以受支持格式的真实加载及回执确认；仅下载、匿名分享访问、打开错误页不计。浏览器内置 PDF 查看器没有可靠的渲染完成回执，建议用 HTML、图片或文本完成这项任务。
- 六项完成后由用户主动开启「作品启航」：拟人角色把文件折成纸飞机，留下带昵称的纪念画面。可跳过、关闭、重看；系统开启减少动态效果时直接显示终态，无声音、不自动分享作品。
- 任务可收起，系统管理员不显示新手入口。任务不会代替配额校验或提高用户权限。

<a id="file-preview"></a>
## 从原型到文档，都在同一个预览区

点击文件后，预览页从侧边滑入并铺满当前内容区，保留主导航。常驻界面只留下**标题、关闭入口和内容**；关闭或按 Esc 返回文件列表。

| 类型 | 预览方式 | 使用边界 |
| :--- | :--- | :--- |
| HTML 原型 | 隔离沙箱，支持相对路径资源与目录入口 | 不执行服务端脚本，不是 PHP / Python / Node.js 应用托管环境 |
| Markdown | 安全阅读模式 | 不执行内嵌 HTML，不自动加载外部资源 |
| 文本与代码 | 本地 Monaco 语法高亮 | UTF-8，文本及代码预览保留 2 MiB 保护 |
| Word / Excel / PowerPoint | 本地 Office 引擎，只读预览 | 浏览器内 WebAssembly 转换，不向第三方转换服务发送文件 |
| 图片 / 音视频 / PDF | 浏览器展示 | 具体格式支持取决于浏览器能力 |
| 其他或无法解码的文件 | 下载原文件 | 保留下载兜底，不承诺所有文件都能转换 |

Office 基于 [`baotlake/office-website`](https://github.com/baotlake/office-website) 的固定版本 `v9.3.0.24`。`web/vendor/office/` 只分发 SDK、字体、转换器运行产物、许可证和构建记录；不携带上游开发工程或源码 ZIP。对应源码获取入口与运行产物分离，仍须遵守 AGPL-3.0 的提供义务；**无需另起 Office 服务或端口**。

受支持且已上传成功的 Office 文件不另设原文件预览大小门槛，但仍受浏览器内存、文档复杂度、字体和加密格式等因素限制。上传准入与网关限制仍然生效。

<details>
<summary><strong>上传冲突、批次与文件操作</strong></summary>

- 同名文件上传前，选择**覆盖、保留两份或取消**；默认不写入。
- 保留两份在扩展名前追加 `_UTC毫秒`，必要时再加序号，例如 `demo_1790000000000.html`。
- “本页后续始终覆盖”仅对当前页面有效，切换工作区或刷新即重置。
- **保留两份不会重写 HTML 中的 CSS / JS / 图片引用**。整套原型建议上传到新目录，或确认覆盖。
- 单批最多 500 个文件，整批受请求体上限约束。默认 64 MiB 是 JSON 请求体上限，包含 Base64 开销，**不是单个原始文件上限**。
- MCP / HTTP 上传使用 `conflictPolicy: ask | overwrite | rename`；`rename` 要求随机 `requestId`，支持幂等重试。`requiresConfirmation: true` 表示尚未上传成功，即使 HTTP 返回 200。
- 支持新建文件夹、批量上传、已有文件在线 UTF-8 编辑、移动、重命名、删除、搜索、排序和分页；文件行仅外显预览，其余操作收入三个点菜单。
- 批次预检、事务和运行时补偿不等于断电或进程强杀时数据库与文件系统完全原子。

</details>

<a id="mcp"></a>
## 让 AI 编程工具完成最后一步交付

不必在「生成代码」和「上传分享」之间反复切换。将 babaShare 接入支持远端 MCP 的客户端，就可以从工具侧管理工作区、上传文件并创建分享。

1. 在**个人中心**创建 MCP Key，选择有效期。
2. 点击该密钥的**「复制使用」**，获取当前站点地址、密钥与配置说明。
3. 将说明交给 Codex、OpenCode 等客户端完成配置。
4. 先调用 `directory_tree {}` 获取可访问的完整目录树，让用户点选目标；客户端无树控件时用编号和完整路径确认。创建时使用树返回的 `treeToken` 和 `targetId`，无需手输目标路径。

```text
<SERVICE_ORIGIN>/api/baba-share/core/v1/mcp
```

- **协议：** Streamable HTTP + Bearer Key，不是 stdio 或旧版 SSE。
- **工具：** 目录树、工作区、文件、成员和分享工具，以 `tools/list` 为准；不开放用户管理、密钥管理或安全设置。目录过期需刷新并重新确认，服务端不保证所有客户端具备统一树 UI。
- **权限：** 实时继承所属账号权限，只读成员通过 MCP 仍然只读。
- **密钥：** 每人最多 10 个有效密钥，支持有效期和撤销。

**[查看 MCP 配置、工具说明与上传示例 →](MCP-README.md)**

> [!CAUTION]
> 复制内容包含私密密钥。不要粘贴到公开聊天、源码仓库、日志或工单，不要放在 URL 或项目 `.env` 中。

<a id="permissions"></a>
## 协作灵活，权限明确

**账户角色与空间角色分开。** 全局账户只有系统管理员 `admin` 和普通用户 `editor`；注册及管理员建号默认 `editor`，只能由系统管理员提升为 `admin`。普通用户可以创建自己的空间，但不能管理系统账户或注册设置。

| 空间能力 | 只读成员 `viewer` | 编辑成员 `editor` | 空间管理员 `manager` / 所有者 |
| :--- | :---: | :---: | :---: |
| 查看获授权空间 | 支持 | 支持 | 支持 |
| 新增文件 | 不支持 | 支持 | 支持 |
| 编辑、删除文件 | 不支持 | 仅本人创建的文件 | 空间内所有文件 |
| 编辑、删除空间 | 不支持 | 不支持 | 支持 |
| 邀请、调整或移除成员 | 不支持 | 不支持 | 支持 |
| 系统账户与设置管理 | 不支持 | 不支持 | 不支持，除非同时为全局 `admin` |

所有者是空间最高身份；`manager` 在空间管理操作上与所有者同级，但不是系统管理员。全局 `admin` 可管理全部空间。每个空间通过 `memberRole` 单独授予三档权限，不再使用协作布尔开关；全局 `editor` 在某空间为 `viewer` 时仍然只读。递归目录操作同样检查子节点权限，网页和 MCP 均按当前权限校验。

### 个人文件与存储配额

- 默认文件数量与存储容量均为 **0（不限）**。系统管理员在设置中的独立配额区保存，不会被未完成的 SMTP 草稿阻断。
- 用户两项个人配额可分别选择继承、指定或不限；`NULL` 表示继承对应默认值，`0` 表示显式不限，两个维度互不影响。
- 文件数量和 bytes 按文件创建者（当前文件归属账户）跨工作区汇总，目录不计为文件。覆盖已有文件仍计入原文件所有者，不转嫁给上传者；转交改变归属时，相应统计随归属更新。
- 容量使用二进制单位：`1 MiB = 1,048,576 bytes`，`1 GiB = 1,073,741,824 bytes`；接口使用不超过 `9,007,199,254,740,991` 的非负整数，前端换算必须精确到整数 bytes。
- 调低额度不会自动删除现有文件。超额写入返回 `FILE_COUNT_QUOTA_EXCEEDED` 或 `STORAGE_QUOTA_EXCEEDED`；无效额度返回 `QUOTA_INVALID`。用户卡片、个人中心和上传区域显示已用及有效额度。

<details>
<summary><strong>成员邀请与访问撤销</strong></summary>

- 所有者、空间管理员或系统管理员可生成多人使用的邀请链接，默认有效 7 天，可选 1 / 7 / 30 天；默认空间角色为 viewer，可显式选择 editor 或 manager。
- 已有账号打开邀请页后通过 POST 加入，未登录则先登录；邀请不自动创建账号，GET 请求不修改成员。
- 随机 256 位邀请凭据只存摘要，原始链接仅生成时展示。token 通过 URL fragment 传入，读取后立即清除，不写浏览器持久存储。
- 重复加入幂等，不改变已有空间角色；每次加入均复核邀请创建者的当前权限。
- 删除、过期或创建者失权后不能再加入，已加入成员不会自动移除；删除空间时清除相关邀请。
- 邀请地址使用当前浏览器来源。不要公开不应公开的邀请链接、分享链接或预览票据。

</details>

<details>
<summary><strong>账户管理、系统托管与空间转交</strong></summary>

管理员可编辑账号、显示名称、角色、启用状态和可选新密码。账号不区分大小写、全局唯一；普通新账号为 3–64 位字母、数字及 `_ . @ -`。显示名称为 1–64 个字符，可重复，不作为登录或权限标识。创建、更新时间由服务端维护。

密码留空保持原值；修改密码或禁用账户会撤销其浏览器登录会话。禁用同时阻止登录和 MCP 访问。不能禁用或删除当前本人，并始终保留至少一个可用管理员。

全局「工作空间管理」支持按账户关联、所有者 / 成员关系、托管状态、名称和创建人筛选；全局管理权限不代表管理员自动成为空间成员。

**物理删除账户不会删除空间或磁盘文件。** 账户的会话、MCP 密钥、成员关系和本人创建的分享 / 邀请等个人访问记录被清理；原属空间与文件转为系统托管，不创建可登录的系统账号。

系统管理员可将空间转交给有效的 admin 或 editor 账户。原所有者及系统托管文件归属随之调整，其他成员文件和空间角色保持不变；接收人已有同名空间时拒绝转交，不覆盖或静默改名。

</details>

<details>
<summary><strong>邮箱注册、密码找回与安全换绑</strong></summary>

**登录账号与邮箱相互独立，且各自全局唯一。** 注册时账号或邮箱任意一个已存在，注册页提示「账号已存在」，不再发送邮件。普通用户的账号只读，仅管理员可改；管理员不能直接绑定或替换用户邮箱。

- **邮箱注册：** 管理员在独立「设置」中配置注册与 SMTP，点击提交并保存成功才生效；勾选仅改草稿，失败保留草稿。激活有效期为 1–720 小时，默认 24 小时。
- **激活登录：** 打开邮件不会创建用户；主动输入密码并确认后，账号创建、令牌消费和会话建立在同一事务内完成，自动登录首页。普通注册固定为普通用户 editor，客户端不能指定管理员角色。
- **首次绑定：** 已登录、尚未绑定邮箱的用户，从个人中心验证邮箱后才具备邮箱找回能力；不凭历史用户名的邮箱格式推定所有权。
- **忘记密码：** 仅已验证邮箱可用于重置。不存在或未绑定的邮箱统一返回申请提示；重置成功撤销旧会话，再使用新密码登录。
- **更换邮箱：** 同一有效登录会话中，先验证原邮箱，再提交并验证新邮箱；完成前旧邮箱保持有效，退出或会话失效后需重新发起。
- **安全邮件：** 统一 HTML 模板与纯文本备选，不加载外部图片或追踪资源；令牌只存摘要、一次有效、用途隔离，GET 不消费。

关闭公开注册会拒绝申请及未完成的激活；切换注册方式会废弃已发激活令牌。开启邮箱验证后不能通过普通账密注册绕过，管理员建号不受影响。

邮件申请限制为每邮箱每分钟 1 次、每小时 5 次，每连接 IP 每小时 20 次，全站每小时 1000 次；另有待激活数量、发送并发与激活尝试限制。代理后的客户端 IP 不盲信转发头，仍需网关限流。

正常浏览器请求优先使用当前 `Origin` 生成邮件链接；没有 Origin 时回退管理员保存的 `siteOrigin`。保存邮件设置自动记录当前浏览器来源，不从匿名 Host、转发头或请求体拼接链接。**公网网关必须校验 Origin 与公开站点，并封闭后端直连**，详见 [部署指南](DEPLOYMENT.md)。

SMTP 仅支持校验证书的 SSL / STARTTLS。密码优先取 `BABA_SHARE_SMTP_PASSWORD`，否则保存于独立 `data/smtp-password` 明文秘密文件，不进 SQLite、不回传页面。POSIX 权限为 0600，Windows 依赖私有目录 ACL；环境密码不能通过页面覆盖或清除。

</details>

<a id="architecture"></a>
## 一个进程，一条部署链路

```text
浏览器 / MCP 客户端
        │
        ▼
Nginx / HTTPS 网关（对外部署时）
        │ HTTP
        ▼
babaShare · 单 Python 进程 · 单监听端口
        ├─ /baba-share/                         页面与静态资源
        ├─ /api/baba-share/core/v1/             HTTP API
        ├─ /api/baba-share/core/v1/mcp          远端 MCP
        ├─ /baba-share/s/{token}                分享页面
        └─ /baba-share/preview/{s|p}/{token}/   受控原型资源
        │
        ├─ SQLite                              账号、权限、节点与凭据记录
        └─ filedb/                             按工作区组织的上传文件
```

**不需要第二个前端服务、预览端口或预览域名。** 前端为原生 HTML / CSS / JavaScript，采用母版页与独立子 iframe；Office 转换在浏览器内运行。

<details>
<summary><strong>预览安全边界与兼容性</strong></summary>

上传内容与站点 URL 使用同一 Origin，但执行上下文不被视为可信站点：原始预览响应使用 CSP `sandbox allow-scripts`，iframe 同时启用沙箱，**不授予 `allow-same-origin`**。直接打开原始预览链接也受响应级沙箱约束。

预览限制外部连接、表单、嵌套 frame、object 等能力。主站 API 拒绝沙箱 `Origin: null` 和明确跨站浏览器请求；登录 Cookie 的 Path 限于 API，原始预览不下发 Cookie，不开放带凭据 CORS。

这意味着依赖联网 API、登录态、持久存储、弹窗等能力的原型可能无法完整运行，根绝对资源路径也不会自动重写。**不要为了兼容某个原型而取消沙箱、添加同源权限或放宽 CORS。**

</details>

<a id="deployment"></a>
## 按你的方式部署

| 方式 | 适合场景 | 入口 |
| :--- | :--- | :--- |
| 直接运行 Python | 本机体验、受控网络运行 | [快速开始](#quick-start) |
| Windows 服务 | Windows 主机上的长期运行 | [安装与卸载指南](DEPLOYMENT.md) |
| Linux 服务 / Nginx | Linux 主机与 HTTPS 入口 | [部署与代理配置](DEPLOYMENT.md) |
| Docker Compose | 容器运行与完整数据卷管理 | 下方命令及 [部署指南](DEPLOYMENT.md) |

```bash
docker compose config
docker compose build
docker compose up -d
docker compose ps
```

默认宿主发布 `0.0.0.0:8080`；仅供本机反向代理时设置 `BABA_SHARE_PUBLISH_IP=127.0.0.1`。容器采用非 root 用户、只读根文件系统和持久数据卷。**持久化整个数据根，不只挂载 `filedb` 或单个 SQLite 文件。** 不要用 `docker compose down -v` 或删除卷作为普通卸载方式。

Windows 安装 / 卸载入口为 `scripts/install-windows-service.bat` 与 `scripts/uninstall-windows-service.bat`。服务使用 `LocalService`，包装依赖 NSSM；安装前阅读指南，卸载保留程序、配置、日志及业务数据。

### 常用配置

复制 `.env.example` 为项目根 `.env`，或注入进程环境变量；**进程环境优先，修改后重启生效**。

| 变量 | 默认值 | 用途 |
| :--- | :--- | :--- |
| `BABA_SHARE_DATA_DIR` | 项目根目录 | 唯一数据根；相对路径按项目根解析 |
| `BABA_SHARE_HOST` | `0.0.0.0` | 监听地址；仅本机访问可设 `127.0.0.1` |
| `BABA_SHARE_PORT` | `8080` | 唯一 HTTP 端口 |
| `BABA_SHARE_PUBLIC_ORIGIN` | 通配监听时为 `http://127.0.0.1:8080` | 对外分享 / 预览地址，如 `https://share.example.com`，不含路径 |
| `BABA_SHARE_SECURE_COOKIE` | `0` | 对外 HTTPS 时设为 `1` |
| `BABA_SHARE_SESSION_HOURS` | `24` | 登录会话有效小时数 |
| `BABA_SHARE_TICKET_SECONDS` | `900` | 私有预览票据有效秒数 |
| `BABA_SHARE_MAX_BODY_BYTES` | `67108864` | 完整请求体上限，包含 JSON / Base64 开销 |
| `BABA_SHARE_SMTP_PASSWORD` | 空 | 可选 SMTP 密码，优先于本地秘密文件 |

> [!NOTE]
> `BABA_SHARE_PUBLIC_ORIGIN` 用于生成链接，**不是 Host / Origin 准入白名单**。外部 HTTPS、后端 HTTP 是正常部署方式；域名准入、TLS 和入口限流交给网关。完整配置见 [.env.example](.env.example) 与 [DEPLOYMENT.md](DEPLOYMENT.md)。

<a id="data"></a>
## 数据留在你的服务器上

```text
BABA_SHARE_DATA_DIR/
├─ data/
│  ├─ baba-share.sqlite3     业务数据库
│  ├─ mcp-key-master         可恢复 MCP Key 所需主密钥（创建后存在）
│  ├─ smtp-password          管理员保存的 SMTP 秘密文件（可选）
│  └─ .baba-share.lock       运行实例锁
└─ filedb/
   └─ <workspace UUID>/     按相对目录存放上传文件
```

- **一套数据，一个实例。** 不要让多个进程共用同一数据根。
- **备份要成套。** 停止服务或使用一致性快照，保留数据库、上传文件和 MCP master；运行中只复制 SQLite 主文件可能遗漏 WAL / SHM。
- **升级先备份。** 停止服务、验证备份，再更新代码与配置；回退需考虑数据库结构兼容性。
- **保护秘密文件。** 数据默认不做静态加密，按需使用磁盘加密、私有 ACL 和私密备份存储；master 丢失不能简单重建。
- **直接初始化当前模型。** 首次建库即包含两层角色、配额、邮箱、系统托管、MCP 派生密钥与六项新手任务的完整结构；启动不执行补列、旧表重建、旧字段映射或任务进度转换。现有数据库须满足当前结构，检查失败不会自动删除、修补或换用空目录。

> `python server.py --check` **不是只读检查**：它可能创建目录、写入探针并初始化数据库；不要对正在运行的同一数据根执行。

<a id="contributing"></a>
## 开发与贡献

欢迎提交可复现的问题、改进建议和 Pull Request。一个清晰的复现步骤，和一段代码贡献同样有价值。

### 运行测试

```bash
python -m unittest discover -s tests -v
node --test tests/*.test.js
```

Node.js **仅用于开发期前端测试**，不是部署依赖。PowerShell 可使用 `node --test (Get-Item tests/*.test.js).FullName` 展开测试路径。测试使用独立临时数据目录和随机端口，不要指向真实业务数据或历史 `.validation` 目录。

### 项目结构

```text
server.py          启动入口
backend/           HTTP、业务逻辑、SQLite、MCP 与运行预检
web/               母版页、子页面、公共样式与原生 JavaScript
web/vendor/        本地 Monaco / Office 依赖及许可证
scripts/           Windows 服务脚本与 Office 资源安装工具
tests/             后端与前端回归测试
docs/              项目介绍网站
Dockerfile         容器镜像定义
compose.yaml       单服务部署与数据卷配置
DEPLOYMENT.md      完整部署、备份与故障排查指南
MCP-README.md      MCP 客户端配置与工具说明
```

### 提交之前

1. 在 [Issues](https://github.com/LeonKou/babaShare/issues) 描述问题或较大改动的目标。
2. 保持单服务、免编译的部署方式，为行为变更补充测试。
3. 界面改动照顾三语、RTL、明暗主题与键盘操作。
4. 不提交 `.env`、密钥、数据库、上传文件或含个人信息的日志；截图和示例同样需要脱敏。

**第三方许可：** Monaco 与 Office 资源保留各自许可证；Office 组件涉及 AGPL-3.0，运行目录保留许可证及构建记录，对应源码通过页面独立入口提供，不强制随运行包下载。再分发或修改前请核对相关义务，不将项目本身与所有依赖视为同一种许可证。

<a id="faq"></a>
## 常见问题

<details>
<summary><strong>网页能打开，为什么 API 返回 403？</strong></summary>

先区分网关拒绝、角色权限不足与来源防护。检查是否为沙箱 `Origin: null`、明确跨站请求或无权限操作。`PUBLIC_ORIGIN` 与上游地址不同本身不应阻断正常登录；HTTPS 会话问题还需检查 Secure Cookie。不要放宽沙箱或 CORS。

</details>

<details>
<summary><strong>工作区不见了，或数据库看起来是空的？</strong></summary>

先核对启动日志中的数据根，确认服务使用的是原来的那一套数据。停止操作、核对备份，不要先删库或创建更多数据目录。

</details>

<details>
<summary><strong>为什么上传失败，或大文件预览不了？</strong></summary>

默认 64 MiB 限制的是整个 JSON 请求，Base64 会增加体积；还需检查代理限制。Office 没有额外原文件大小门槛，但浏览器内存和文件复杂度仍会影响转换。可拆分上传批次，预览失败时下载原文件。

</details>

<details>
<summary><strong>原型为什么与直接打开 HTML 的效果不同？</strong></summary>

检查相对资源路径、大小写和外部依赖。沙箱会限制网络、存储、表单和窗口等能力，这是隔离上传内容的安全边界，不应通过取消隔离来规避。

</details>

<details>
<summary><strong>服务启动失败、权限不安全或端口被占用？</strong></summary>

检查 Python 版本、数据根写权限、实例锁和监听端口。Windows 服务还需检查 NSSM、运行账号及目录 ACL。不要使用 777、删除 master 或重建数据库绕过检查。详细诊断见 [部署指南](DEPLOYMENT.md)。

</details>

---

<div align="center">

**让每一次原型交付，都少一点来回，多一点协作。**

如果 babaShare 对你有帮助，欢迎 Star、分享使用经验，或一起把它做得更好。

[项目主页](https://leonkou.github.io/babaShare/) · [报告问题](https://github.com/LeonKou/babaShare/issues) · [参与贡献](https://github.com/LeonKou/babaShare/pulls)

</div>
