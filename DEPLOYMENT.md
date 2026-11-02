# babaShare 部署指南

适用于 Windows 宿主机、Linux 和 Docker Compose。运行时只依赖 Python 3.12+ 标准库和 SQLite，不需要编译前端或安装 Python 第三方包。**仅启动一个 HTTP 服务**：管理页、API、MCP、分享和原始预览复用 `BABA_SHARE_PORT`（默认 `8080`）。只配置一个数据根目录，不按开发/生产拆分数据。

## 1. 部署前保护现有数据

先确定唯一数据根目录 `DATA_DIR`、正在运行的实例和服务账号；停止对应写入实例后，成套备份整个目录。必须同时保留：

- 唯一运行数据库 `data/baba-share.sqlite3`。若发现历史 `data/product-share.sqlite3`，启动安全阻断，不读取旧库、不静默另建空库、不自动搬迁或删除原文件；先保留并完整备份历史数据库及配套filedb/master，由管理员明确迁移方案。即使已有新库，也不能忽略旁边的历史库。
- 整个 `filedb/`（包含业务所属空目录）。
- `data/mcp-key-master`（若存在），必须和对应数据库一起保护、备份、恢复。
- `data/smtp-password`（若存在）是管理员保存的 SMTP 明文认证密码；与邮件设置一起恢复并保留私有权限，不公开、不提交源码。环境注入密码则由受保护的配置管理器另行恢复。
- SQLite 可能存在的 `-wal`、`-shm` 文件；运行中不要只复制单个数据库文件。优先停服务备份，或使用经过验证的一致性快照方案。
- 数据根中的服务日志，以及项目根 `.env` 和服务管理器配置。配置与代码虽不一定在数据根内，恢复时仍须配套保存。

原生运行默认数据根是项目根；Windows 服务脚本默认使用 `%ProgramData%\babaShare\data`；容器使用 `/var/lib/baba-share`。三者都是同一个 `BABA_SHARE_DATA_DIR` 概念，不是三份应当同步的运行目录。指定已有数据根前，先确认这就是要使用的数据，不能因权限或锁冲突改用空目录绕过问题。不要只挂载或迁移 `filedb/`。

### 历史目录约束

项目根 `data/` 与 `filedb/` 是成套数据；`.validation/data/` 和 `.validation/filedb/` 是历史手工指定另一数据根形成的独立一套，不会自动同步，也不是可随意删除的缓存。`.validation/` 待停用、待移除，不应继续用于新验收；这不代表旧实例已停止或目录已删除。移除前必须核对实际实例、完整备份并取得明确删除授权。本文和服务脚本均不移动、覆盖或删除这些目录，也不合并数据库。

## 2. 配置规则与单端口隔离

应用只从**项目根目录**读取 `.env`，不从当前工作目录、数据目录或任意其他路径搜索。同名进程环境变量优先；只读取 `BABA_SHARE_*` 应用配置，不再兼容旧变量别名。`.env` 是简单 `KEY=value` 文件，不是 shell 脚本，不展开 `$VAR`、`%VAR%` 或命令。不要把含密钥的 `.env` 提交或复制进镜像。

| 变量 | 原生默认值 | 说明 |
| --- | --- | --- |
| `BABA_SHARE_DATA_DIR` | 项目根目录 | SQLite、`filedb`、master 的唯一共同根；相对路径始终相对项目根 |
| `BABA_SHARE_HOST` | `0.0.0.0` | 默认所有 IPv4 网卡；可显式设 `127.0.0.1` 仅供本机访问 |
| `BABA_SHARE_PORT` | `8080` | 唯一 HTTP 监听端口 |
| `BABA_SHARE_PUBLIC_ORIGIN` | 通配监听时为 `http://127.0.0.1:8080` | 其他监听按地址和端口构造；外部访问须填真实 IP/域名，不使用 `0.0.0.0`；仅构造外部分享/预览 URL，不含路径，不是 Host/Origin 准入白名单 |
| `BABA_SHARE_SECURE_COOKIE` | `0` | 公开来源使用 HTTPS 时必须设 `1` |
| `BABA_SHARE_SESSION_HOURS` | `24` | 整数，1..87600 |
| `BABA_SHARE_TICKET_SECONDS` | `900` | 整数，1..86400 |
| `BABA_SHARE_MAX_BODY_BYTES` | `67108864` | 整数，1024..1073741824 |
| `BABA_SHARE_SMTP_PASSWORD` | 空 | 可选 SMTP 认证密码，优先于数据根下 `data/smtp-password`；页面不能覆盖/清除非空环境密码 |

默认原生服务、Windows 服务及 Compose 宿主端口均监听 `0.0.0.0`，即所有 IPv4 网卡。监听地址不是浏览器访问地址或外部链接地址：本机访问 `127.0.0.1`，其他设备使用服务器真实 IP 或域名。未指定公开来源时，通配监听只回退到本机 `http://127.0.0.1:端口`，不会生成 `http://0.0.0.0`；局域网/公网分享应显式配置真实公开来源。程序和安装脚本不会自动放行防火墙；管理员须按预定访问范围配置防火墙与网络入口。需要仅本机访问时，可显式设置 `BABA_SHARE_HOST=127.0.0.1`，Compose 则设置 `BABA_SHARE_PUBLISH_IP=127.0.0.1`。

不存在第二预览端口或预览 Origin 配置；升级时移除旧 `.env`、服务环境及代理中的相关配置。原始预览位于 `/baba-share/preview/{s|p}/token/...`（`s`/`p` 表示不同票据类型，`token` 为实际票据）。URL 与主站同端口，但响应 CSP `sandbox` **不允许 `allow-same-origin`**，浏览器按不透明来源（opaque origin）隔离上传的 HTML/JS；iframe 也保留对应沙箱限制。不能只因 URL 同源就移除这些响应头或沙箱。预览脚本访问主站 DOM、Cookie、存储和接口受到浏览器及服务端来源校验限制；依赖同源存储或接口的原型可能无法直接运行，这是隔离边界而非应绕过的错误。

`BABA_SHARE_PUBLIC_ORIGIN` 只支持 HTTP(S)、IPv4/域名和可选端口，不含凭据、路径、query、片段；当前不支持 IPv6 监听。它仅构造外部分享/预览 URL，不与请求 `Host` 或浏览器 `Origin` 强绑定；配错可能生成不可访问的链接，但不会因此使正常代理登录/退出返回 403。域名准入、TLS 和入口限流由网关负责；应用保留身份认证、实时角色/工作区权限、未登录 401 及前端登录导航、预览沙箱，以及对 `Origin: null` 和明确跨站浏览器请求的阻断，不以放宽这些边界适配代理。具体来源防护拒绝 `Origin: null` 或空串；`Sec-Fetch-Site` 只允许缺失、`same-origin` 或 `none`，`same-site` 也会拒绝，以阻断不可信兄弟子域。无 Fetch Metadata 的客户端由网关控制准入。应用不盲目信任 `X-Forwarded-*` 作为准入依据。

生产可由 Nginx 终止 HTTPS，再使用 HTTP 访问后端；后端无需 TLS，也不要求透传公开 `Host` 才能认证。外部 HTTPS 仍需 `BABA_SHARE_SECURE_COOKIE=1`：它只是浏览器 Cookie 的 Secure 属性，与代理到后端使用 HTTP 不冲突。端口预检只能检查当时占用，绑定仍可能竞态失败；应查明占用原因，不得随意终止陌生进程。

`--check` **不是只读检查**：会创建数据目录/持锁文件、检查 SQLite、初始化新库或执行兼容迁移。它先取得操作系统实例锁，同一数据根已有实例运行时会在数据库迁移前拒绝。锁文件保留是正常行为，锁随进程退出释放，不要删除锁文件来绕过互斥。

### 邮箱注册与 SMTP 凭据

管理员使用独立「设置 / 注册设置」页面；「用户管理」仅管理账户。勾选邮箱验证只展开 SMTP 与发件/激活配置，填写并点击「提交」成功后才与注册开关一起生效。取消恢复已保存配置，提交失败不改变实际开关与配置，未保存离开有提醒。提交不发送邮件，只支持 SSL 或 STARTTLS，使用系统证书验证和连接超时，不提供明文 SMTP。激活有效期默认24小时，可设1—720小时。

邮件站点无需手填：正常浏览器申请注册、密码重置、邮箱绑定或换绑邮件时，后端优先使用并严格规范化该请求的 HTTP `Origin`，保留 HTTP(S) 协议、域名与非默认端口，不含路径；有 `Sec-Fetch-Site` 时必须为 `same-origin`。**公网部署必须按第 6 节由网关精确校验公开 scheme/host/port，并禁止绕过网关直连后端，防止任意 Origin 将带令牌的邮件链接导向攻击者域名。** 仅缺失 Origin 的 API 客户端回退到管理员已保存的可信 `siteOrigin`，未配置则拒绝；空值、`null` 或非法 Origin 不能触发回退。该来源独立于 `BABA_SHARE_PUBLIC_ORIGIN`，不使用匿名请求 Host、转发头或请求体提供的来源作为回退。

管理员提交邮件配置（包括启用邮箱验证注册）时，页面自动取当前浏览器 `location.origin`，后端校验并保存为上述无 Origin 客户端的回退来源。请通过用户实际可访问的地址进入设置页；地址变更后，修改并提交邮件配置或重新启用邮箱验证注册才更新已保存来源，来源差异本身不触发邮件配置保存，仅关闭总注册或邮箱验证不携带邮件配置。局域网 HTTP 可用，但存在邮件令牌和密码被窃听的风险；公网必须使用可信 HTTPS。修改 SMTP/发件/站点设置会使在途申请不能保存新令牌；切换注册方式或关闭总开关会废弃未完成激活。总开关关闭时注册申请与激活都被拒绝；管理员手动创建账号不受影响。

普通公开注册与邮箱激活均固定创建协作者（editor），客户端传入 admin/viewer 等角色不能覆盖；协作者可创建工作区，但无权管理账号或管理员设置。首次 setup 仍创建管理员，管理员手动建号的显式角色和原有默认行为保持不变；已有用户不迁移、不修改角色，只读成员（viewer）仍始终只读。

激活邮件使用不依赖外部资源的中文 HTML 与纯文本备选，按钮和完整备用链接均可点击。仅 GET 打开激活页不创建账户、不切换会话；用户提交密码及确认后，一次性令牌消费、editor 创建和正常登录会话写入在同一 SQLite 事务中完成，然后自动登录并固定进入首页。会话通过既有 HttpOnly、SameSite=Strict、API Path、有效期及可选 Secure Cookie 下发，不写 URL 或浏览器存储；HTTPS 部署务必启用 Secure。当前已有登录时仅在主动提交成功后切换到新账户，并撤销当前旧会话，不影响其它设备；失败不发新 Cookie，数据库事务回滚以保留重试资格。

密码优先读取非空 `BABA_SHARE_SMTP_PASSWORD`；否则管理员输入保存到独立 `data/smtp-password`，不写SQLite、不回传，仅返回是否已有密码。输入留空保持，清除须显式确认；启用邮箱认证时应先关闭邮箱验证或去除用户名才可清除文件密码。秘密文件为明文，不是加密存储：POSIX采用0600、原子替换和链接检查；Windows的0600不能证明安全，必须按下文私有数据目录ACL仅授予必要管理员及服务身份访问，已有目录必须人工核验。数据根的上级目录同样不得允许不可信身份修改或替换，链接检查不替代操作系统访问控制。

不要将数据目录映射为静态资源，不把密码写日志、Git、Docker镜像或命令历史；按组织策略保护进程环境、`.env`、备份与恢复副本。数据库与秘密文件更新具备运行时失败补偿，但不承诺断电/强杀时跨文件和数据库完全原子，异常后管理员应核对配置并显式试发。Windows服务不会自动持久化安装终端中的SMTP临时变量，须使用受保护的服务环境或项目`.env`；Compose须显式配置受保护的环境注入，或使用完整持久数据卷中的秘密文件。

### 账户删除、系统托管与升级迁移

管理员「账户列表」支持永久删除，并可从账户进入其关联的工作空间；独立「工作空间管理」按账户、所有者/成员关系、系统托管、名称前缀和创建人筛选，展示当前归属、原创建人及成员。

永久删除会撤销目标账户的会话、MCP 密钥、成员关系以及本人创建的分享/邀请等个人访问记录，但**不删除工作空间和磁盘文件**。原归目标账户所有的空间及文件改为系统托管，保留原创建人昵称快照，不创建可登录的系统账户；注册频控记录仍保留。不能删除本人，必须保留可用管理员。此操作不能通过重新创建同名账户撤销，操作前应核对账户和影响范围。

管理员可把空间转交给有效的管理员或协作者，不能转给只读成员。转交同时调整该空间中原所有者及系统托管文件的归属，不改变其他成员的文件归属或协作配置；接收人已有同名空间时拒绝转交。旧所有者不会自动成为成员，转交前应核对后续访问安排。

归属判断使用转交时的当前所有者，不追溯每个文件的历史创建身份：如果接收人原本就是有自有文件的成员，接管空间后再转给下一人，其原自有文件此时也属于当前所有者，会一并转交。需要保留这些文件归属时，应在确认前单独安排，不应把“其他成员文件不变”理解为永久保留历任所有者的个人文件。

启动升级会对旧数据库执行幂等的托管结构迁移，使空间与文件可以没有账户所有者，补充创建人信息；迁移保留已有记录、约束和索引，不移动或删除 `filedb/`。先按第 7 节停服并完成一致性备份，再在同一数据根运行新版本；不要把已迁移数据库直接交给旧版本运行。迁移和托管不是删除磁盘文件的授权。

### 键盘与预览验收

搜索和单行表单使用原生 Enter 提交；输入法组合确认不提交，多行文本与代码编辑器不使用全局 Enter 快捷键。危险确认默认聚焦取消，弹窗关闭恢复焦点，分页更新不抢走用户已移开的焦点。部署验收应覆盖实际使用的输入法、浏览器及键盘导航，而不只检查鼠标操作。

代码高亮使用随项目分发的本地 Monaco 静态资源，不需要 npm 或额外服务；不要漏掉 `web/vendor/`、对应 worker 和固定预览页面。Docker 构建上下文通过 `.dockerignore` 显式包含整个 `web/vendor/`，镜像复用现有 `COPY web/`，不增加监听端口；更新第三方资源后必须重建镜像，仅刷新浏览器不会更新镜像内容。普通图片、音视频和 PDF 受浏览器解码能力限制，Markdown 使用不执行 HTML 的安全阅读模式。原始上传 HTML 继续使用不透明来源沙箱；固定可信组件页的局部 CSP 权限不适用于上传内容。

Office 使用 `office-website v9.3.0.24` 的本地静态依赖，资源目录为 `web/vendor/office/`。运行时仍只启动现有 Python 服务，不启动 Next.js、npm、Office 文档服务或额外端口。浏览器在专用 worker 中使用 x2t WebAssembly 转换，再交给本地 SDK 只读展示；文件不发送给第三方转换服务。部署应保留完整资源、许可证、对应源码与 `build-manifest.json`，不能只复制 `x2t.wasm`，也不能只复制前端适配脚本。

Office 发行 ZIP 大小为 `606149075` 字节，固定 SHA256 为 `0b91dcd9772d46effc7512681e4b5d1a41322dd06c6063c5bd21f509f1daf69b`；安装后的 SDK、字体及源码约占 1.06 GB（约 0.98 GiB，以实际分发内容为准）。**发行包大小、部署磁盘增量和首次打开文档的网络传输量是不同指标**：普通列表不下载整套引擎，打开相应格式后才按需请求组件与字体。不要把完整发行包大小当成每次预览流量。

x2t 的固定 JS/WASM 文件沿用上游 Brotli 编码，由应用对精确路径返回 `Content-Encoding: br` 和相应 MIME，Python 无需 Brotli 第三方库。反向代理不得剥离该编码头或重复压缩这些文件；若由代理单独托管静态资源，必须同步对应编码与内容类型，但不应把 `filedb/` 映射为公开目录。

已上传成功的受支持 Office 文件没有额外的原文件预览大小门槛；上传准入仍受服务端请求体和网关限制，不能通过取消预览限制绕过上传限制。压缩文件大小不等于解压后内存占用，大型表格、复杂版式、嵌入对象和字体替换可能造成等待或效果差异，内存不足、加密或转换失败时使用下载原文件兜底。只读预览不是完整 Office 编辑环境；宏、插件和协作写入不启用。升级资源必须按固定版本核验并重新运行三类样例与隔离测试，不要自行换成最新 CDN 脚本。

## 3. Windows 宿主机部署

### 3.1 前台运行

在项目根打开 PowerShell，确认 `py -3` 指向 Python 3.12 或更新版本且含 sqlite3。如不符，改用已安装的合适解释器绝对路径，不要求一定装 3.12 小版本。

```powershell
py -3 -c "import sys,sqlite3; assert sys.version_info >= (3,12); print(sys.executable); print(sqlite3.sqlite_version)"
$env:BABA_SHARE_DATA_DIR = 'D:/baba-share-data'
$env:BABA_SHARE_HOST = '0.0.0.0'
$env:BABA_SHARE_PORT = '8080'
# 下两行会初始化或迁移所选数据库，已有数据须先完成一致性备份。
py -3 server.py --check
py -3 server.py
```

浏览器打开 `http://127.0.0.1:8080/baba-share/`。该前台方式不代替持久运行服务；关闭终端会停止应用。

### 3.2 一键安装 Windows 服务的准备

脚本为 `scripts/install-windows-service.bat`，卸载为 `scripts/uninstall-windows-service.bat`。均为 ASCII 输出，避免 CMD 系统代码页导致乱码。**脚本会请求确认，安装后自动启动；不自动安装 Python/NSSM，不改防火墙，不注册额外端口。**

管理员先完成以下准备：

1. 将项目放在稳定、本地、机器级路径，例如 `C:\Apps\babaShare`，不要放用户桌面、下载目录、`AppData`、网络盘或临时目录。路径可包含空格；不要包含双引号或控制字符。脚本关闭 delayed expansion，避免 `!` 被吞掉。
2. 安装带 SQLite 的 **all-users Python 3.12+**，例如解释器在 `C:\Program Files\Python313\python.exe`。不使用 Microsoft Store 别名或仅当前用户可见的解释器。自动发现依次使用 `py -3`、`python`；需要固定版本时，在安装终端设置 `BABA_SHARE_PYTHON` 为绝对 `python.exe` 路径。脚本从不使用共享固定 `%TEMP%` 文件。
3. 从 NSSM 官方 `https://nssm.cc/download` **人工获取并核验来源与二进制**，将适配宿主架构的 `nssm.exe` 放在 `scripts\tools\nssm.exe`。脚本不会下载或执行远程安装器。使用支持在线日志轮转的 NSSM 版本；`AppRotateOnline` 等设置不被支持时安装会失败并回滚服务注册。NSSM 路径注册进 SCM 后不可移动或删除。
4. 服务固定名 `babaShare`，固定使用低权限内置账号 `NT AUTHORITY\LocalService`，不是管理员/LocalSystem。确保该账号对项目目录、`backend/`、`web/`、项目 `.env`、NSSM、Python 可执行文件及其标准库/DLL 有**读取和执行**及父目录遍历权限；普通用户不能修改这些可执行内容。脚本不会递归放宽代码/Python权限；用户目录/Store解释器会被拒绝，其他ACL问题由启动失败和日志暴露。安装前请人工检查 `icacls`，启动成功也不等于所有安全ACL已核验。
5. 默认数据根为 `%ProgramData%\babaShare\data`，其中另有 `data/`、`filedb/`、`logs/`。全新目录由脚本创建为禁用继承的私有ACL：SYSTEM、Administrators 完全控制，LocalService 修改；使用 SID 不依赖系统显示语言。已有目录及所有子项只审计不改ACL：拒绝链接/重解析点、根目录继承未关闭、额外身份获准访问或缺少LocalService根修改权限。已有数据ACL不符合时先备份，再由管理员按访问策略人工调整；脚本不会自动接管或递归重写用户数据权限。不要给 `Everyone`/`Users` 全控，也不要用POSIX `0600`位证明Windows ACL安全。LocalService由其他服务共享；需要每服务独立身份的环境应由管理员另行设计服务账号/ACL，不应照搬本脚本。
6. 已有服务名会直接拒绝安装，不覆盖别的服务。现有数据必须先成套备份，安装会执行 `server.py --check` 初始化/迁移。安装不搬迁项目历史数据到ProgramData；要沿用已有数据必须明确设置其绝对数据根并满足私有ACL。

### 3.3 安装和运行验证

以管理员权限启动 PowerShell，在项目根执行（无需自定义时可直接右键以管理员身份运行 BAT）：

```powershell
# 可选覆盖，按实际机器调整；不要把密钥写入命令。
$env:BABA_SHARE_PYTHON = 'C:/Program Files/Python313/python.exe'
$env:BABA_SHARE_DATA_DIR = 'D:/baba-share-data'
$env:BABA_SHARE_HOST = '0.0.0.0'
$env:BABA_SHARE_PORT = '8080'
$env:BABA_SHARE_PUBLIC_ORIGIN = 'http://127.0.0.1:8080'
$env:BABA_SHARE_SECURE_COOKIE = '0'
& './scripts/install-windows-service.bat'
Get-Service babaShare
```

脚本确认后预检、注册 NSSM、设置自动启动和 LocalService、写入服务级数据根/监听/公开来源/Cookie环境、配置日志轮转和退出重启。启动后最多15秒等待SCM Running状态，再做一次有5秒请求超时的HTTP主页检查；NSSM wrapper Running不代表Python已完成初始化，这不是应用就绪轮询。**HTTP未就绪时返回失败，但保留已注册服务与日志，不停止/移除可能仍在正常初始化的服务**，并显示“服务已注册但HTTP未就绪”的诊断信息；请检查日志、初始化耗时、账号权限、端口与实际主页后判断，不能重复安装覆盖。项目和解释器参数独立设置，路径含空格不需手工拼嵌套引号。仅注册成功后的配置/SCM启动阶段失败时尝试移除本次创建的服务注册，**保留数据库、master、配置、文件、ACL和日志**；回滚也失败时打印警告，须人工核查。

脚本的 `DATA_DIR/HOST/PORT/PUBLIC_ORIGIN/SECURE_COOKIE` 使用安装终端传入值或脚本默认值，并固定写入 NSSM `AppEnvironmentExtra`，因此覆盖项目 `.env` 的同名配置；默认监听 `0.0.0.0`，空公开来源由应用回退为 `http://127.0.0.1:端口`；外部访问时须显式配置真实 IP/域名。其他应用配置放项目根 `.env`，不要只依赖安装终端中的临时变量（这些未自动持久化到服务）。由SCM启动的NSSM不继承你当前登录终端的进程环境；它使用服务启动环境与显式 `AppEnvironmentExtra`。修改已安装服务的持久环境前先备份并确认，管理员可使用 NSSM 参数编辑后重启；不要通过再次运行安装脚本覆盖既有服务。

日志位于 `<DATA_DIR>\logs\stdout.log` 和 `stderr.log`。NSSM 启用启动及在线轮转，阈值10MiB/86400秒；轮转时机遵循安装的NSSM版本语义，不保证精确时间触发。历史轮转文件**不自动删除**，需监控磁盘、按经批准的保留策略归档。日志和预览票据有敏感性，不向普通用户开放；发布访问日志时必须脱敏。

管理员检查服务属性中的登录账号、可执行路径和环境；访问主页完成初始化，验证登录、文件上传/读取、预览隔离、MCP与重启后的持久化。若启动失败，查看上述日志和 Windows Event Viewer；重点检查服务账号读取代码/Python、数据ACL、端口冲突及公开Origin。安装脚本的监听检查不代替这些业务、安全或开机自启验收。

### 3.4 一键卸载（绝不删除数据）

```powershell
& './scripts/uninstall-windows-service.bat'
```

管理员确认后，只停止 `babaShare` 并移除 SCM 注册。服务已停止时直接移除，未安装时成功返回；停止等待最多30秒，失败则不强制删除注册。不会删除代码、Python、NSSM、`.env`、数据根、SQLite/WAL/SHM、`filedb/`、master、日志或ACL。需要保留原NSSM二进制以执行卸载。卸载不等于数据清理或凭据撤销；删除任何数据都需要单独授权。

**验证边界**：仓库的自动化验证只做脚本静态检查、受控模拟与临时数据测试，不实际注册/卸载当前机器服务。未做目标机器SCM、开机自启、服务账号ACL和NSSM在线轮转实测时，不能将其报告为已实测通过；以上步骤仍须管理员在目标Windows机器验收。

## 4. Linux 原生部署

使用机器上已安装的 Python 3.12+；命令名称可能为 `python3` 或具体版本，不自动安装系统包。

```bash
python3 -c 'import sys,sqlite3; assert sys.version_info >= (3,12); print(sys.executable)'
export BABA_SHARE_DATA_DIR=/srv/baba-share-data
export BABA_SHARE_HOST=0.0.0.0
export BABA_SHARE_PORT=8080
python3 server.py --check
python3 server.py
```

生产通过 systemd 等进程管理器使用专用低权限账号；显式配置绝对解释器/脚本、同一数据根和环境。管理员预先授予代码读执行及数据目录读写权限，不自动 `chown` 或 `chmod 777`。收到SIGTERM/Ctrl+C时停止唯一HTTP监听，已接收请求共享最多10秒排空宽限，然后关闭剩余连接并释放实例锁。管理器停止期限应大于10秒（建议15秒以上）。同一数据根只允许运行一个实例。

## 5. Docker Compose

要求管理员已安装 Docker Engine 与 Compose 插件。默认发布宿主 `0.0.0.0:8080` 到容器 `8080`，容器内同样监听 `0.0.0.0`；公开来源仍默认 `http://127.0.0.1:8080`，不是 `http://0.0.0.0`。本机可直接访问，其他设备需使用宿主真实 IP/域名并显式设置公开来源。通配发布不会自动放行防火墙，应由管理员限制预定访问范围；仅本机反向代理可显式设 `BABA_SHARE_PUBLISH_IP=127.0.0.1`。Dockerfile只EXPOSE一个端口，健康检查只请求唯一服务的 `/baba-share/`。

在项目目录执行：

```sh
docker compose config
docker compose build
# 会初始化/迁移数据库，必须先备份；不要与已有实例同时运行。
docker compose run --rm baba-share python server.py --check
docker compose up -d
docker compose ps
docker compose logs --tail=100 baba-share
```

固定命名卷默认 `baba-share-data`，完整挂载 `/var/lib/baba-share`。重建镜像或普通 `docker compose down` 不删除命名卷。**禁止 `docker compose down -v`、`docker volume rm`、`docker volume prune`，除非已核对内容、取得删除授权并验证备份。** 保持卷名稳定，不能通过换卷名制造空库。容器非root UID/GID `10001:10001`，根文件系统只读、无额外capability、禁止提权，停止宽限15秒。

Compose宿主端口单独配置（不是容器内 `BABA_SHARE_PORT`）：

```dotenv
BABA_SHARE_PUBLISH_IP=0.0.0.0
BABA_SHARE_PUBLISH_PORT=18080
# 未显式设置时，默认公开来源随发布端口变为http://127.0.0.1:18080。
# 非本机访问或HTTPS应显式填写真实公开来源，以生成可访问的分享/预览URL。
# BABA_SHARE_PUBLIC_ORIGIN=https://share.example.com
BABA_SHARE_SECURE_COOKIE=0
BABA_SHARE_VOLUME_NAME=baba-share-data
```

显式 `BABA_SHARE_PUBLIC_ORIGIN` 优先；`.env` 中已有写死旧来源时，改发布端口须一并更新。`BABA_SHARE_PUBLISH_IP` 是绑定地址，不用它推导浏览器域名。容器内端口固定8080，`BABA_SHARE_PUBLISH_PORT` 改的是宿主映射；不要设置第二预览映射。启动前 `docker compose config` 核对最终端口、Origin和挂载。

需要 bind mount 时，将服务卷项人工改为已确认的绝对宿主路径：

```yaml
volumes:
  - /srv/baba-share-data:/var/lib/baba-share
```

Windows Docker Desktop 可用 `D:/baba-share-data:/var/lib/baba-share`，先确认磁盘共享、宿主ACL和容器UID读写行为。Linux管理员预先为UID10001准备权限，不能自动递归改用户文件所有者。命名卷首次挂载同样核实目录权限。不要只凭容器启动成功或Linux权限位判断Windows宿主数据已安全持久化。不要把 `.env`、项目数据或 `.validation/` COPY进镜像。

## 6. 单上游 HTTPS 反向代理

只需一个公开域名、一个 HTTP 上游：**浏览器 HTTPS → Nginx 终止 TLS → HTTP 后端**。**使用当前请求 Origin 生成密码重置等安全邮件链接时，网关来源准入是部署必须执行的安全措施，不是可选增强。** 后端 `8080` 不得从公网绕过网关直接访问；同机代理将后端从默认 `0.0.0.0` 限制为 `127.0.0.1`，跨机代理则使用受控私网和仅允许代理连接的防火墙规则。例如浏览器 `https://share.example.com`，上游 `http://127.0.0.1:8080`（示例需替换为实际地址）。后端无需证书或 HTTPS 监听，配置：

```dotenv
BABA_SHARE_HOST=127.0.0.1
BABA_SHARE_PORT=8080
BABA_SHARE_PUBLIC_ORIGIN=https://share.example.com
BABA_SHARE_SECURE_COOKIE=1
```

Compose 使用同机代理时，保留容器内 `0.0.0.0:8080`，并显式设置 `BABA_SHARE_PUBLISH_IP=127.0.0.1` 使宿主仅发布 `127.0.0.1:8080`；未设置时仍为默认通配发布，必须防止成为绕过网关的入口，不要把上面原生监听设置误用于容器。公开来源用于生成可访问的分享/预览链接，不是域名访问白名单，配错不会因 Host/Origin 不匹配阻断正常代理登录/退出。Secure Cookie 由浏览器按外部 HTTPS 处理，不要求 Nginx 到上游也使用 HTTPS。

下面是可放入 Nginx `http {}` 内（或被该上下文 include 的配置文件）的单上游示例。替换域名、证书路径；先检查是否已有同端口 `default_server`，合并而非重复声明。`ssl_reject_handshake` 需要 Nginx 1.19.4+，请使用支持该指令的版本。限流参数只是入口基线，按并发、共享出口和上传批次调整：

```nginx
# 位于 http 上下文；按客户端 IP 做入口限流。
limit_req_zone $binary_remote_addr zone=baba_share_per_ip:10m rate=20r/s;

# 精确限制公开协议与 HTTP authority，并规范化默认端口。
# $host 会丢失端口，不能单独用于此校验；不要使用客户端转发头拼接期望来源。
map "$scheme|$http_host" $baba_share_expected_origin {
    default "";
    "https|share.example.com" "https://share.example.com";
    "https|share.example.com:443" "https://share.example.com";
}

# 仅加强生成令牌邮件的 POST；$uri 是不含查询串的规范化路径。
map "$request_method:$uri" $baba_share_mail_link {
    default 0;
    "POST:/api/baba-share/core/v1/visitor/email/registration" 1;
    "POST:/api/baba-share/core/v1/visitor/password-reset/request" 1;
    "POST:/api/baba-share/core/v1/account/email-change/request" 1;
    "POST:/api/baba-share/core/v1/account/email-change/proposal" 1;
    "POST:/api/baba-share/core/v1/account/email-binding/request" 1;
}

# 其他接口不增加 Origin 限制；邮件请求有 Origin 时才与当前公开来源比较。
# 缺失 Origin 由后端仅回退管理员保存的可信 siteOrigin，绝不回退 Host。
map "$baba_share_mail_link|$http_origin" $baba_share_mail_candidate {
    default $baba_share_expected_origin;
    ~^1[|].+ $http_origin;
}

# 邮件请求的 Fetch Metadata 缺失可用；存在时只允许 same-origin。
map "$baba_share_mail_link|$http_sec_fetch_site" $baba_share_mail_metadata_denied {
    default 1;
    ~^0[|] 0;
    "1|" 0;
    "1|same-origin" 0;
}

# 未知域名不得进入业务上游。
server {
    listen 80 default_server;
    server_name _;
    return 444;
}

server {
    listen 443 ssl default_server;
    server_name _;
    ssl_reject_handshake on;
    return 444;
}

server {
    listen 80;
    server_name share.example.com;
    return 308 https://share.example.com$request_uri;
}

server {
    listen 443 ssl;
    server_name share.example.com;

    ssl_certificate /etc/nginx/tls/share.example.com/fullchain.pem;
    ssl_certificate_key /etc/nginx/tls/share.example.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    # 同时约束请求目标主机与 HTTP authority，避免合法 SNI 或任意端口绕过。
    # if 仅用于 server 级提前 return，不在其中使用 proxy_pass、rewrite 或嵌套 if。
    if ($host != share.example.com) {
        return 444;
    }
    if ($baba_share_expected_origin = "") {
        return 444;
    }
    if ($baba_share_mail_candidate != $baba_share_expected_origin) {
        return 403;
    }
    if ($baba_share_mail_metadata_denied = 1) {
        return 403;
    }

    client_max_body_size 64m;
    limit_req zone=baba_share_per_ip burst=40 nodelay;
    limit_req_status 429;

    # 默认访问日志可能包含分享/预览票据；需日志时先设计脱敏格式。
    access_log off;

    location / {
        # 不追加 URI，不改写业务路径，主站/API/MCP/预览均转至同一上游。
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Connection "";

        # 规范转发供运维使用；不是应用认证或来源准入的必要条件。
        proxy_set_header Host $http_host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $http_host;
        proxy_set_header Authorization $http_authorization;

        proxy_cache off;
        proxy_read_timeout 120s;
    }
}
```

网关负责公开域名准入、TLS 和入口限流，应用仍负责认证及角色/工作区权限。安全邮件来源策略必须同时满足：

- 邮件生成接口携带 HTTP `Origin` 时，只允许当前公开站点的完整来源，不接受 `null`、HTTP 降级、兄弟子域、后缀相似域、额外路径、多值或错误端口；即使缺少 Fetch Metadata，也必须进行此精确校验。不要使用包含匹配或把客户端提供的 `Host` / `X-Forwarded-Host` 原样当作允许来源。后续新增邮件生成接口或路径别名时，必须同步网关保护范围并验收路由归一化变体，不能只保护页面入口。
- 邮件生成接口缺失 `Origin` 时允许进入后端，但只能使用管理员已保存的可信 `siteOrigin` 回退，未配置则拒绝。Nginx 的 `$http_origin` 不能区分缺失与空值，显式空 Origin 仍须由后端拒绝，不能被当作回退。普通无 Origin API / MCP 客户端仍沿用原有认证流程。邮件接口只允许缺失 Fetch Metadata 或 `Sec-Fetch-Site: same-origin`；`none`、`same-site`、`cross-site` 及其他值均拒绝。
- 示例公开端口为 HTTPS 默认 `443`，HTTP authority 接受显式 `:443`，而浏览器 `location.origin` 会省略默认端口，Origin 白名单使用 `https://share.example.com`。若公开端口为 `8443`，须同时调整 TLS `listen`、默认拒绝 server、HTTP 重定向、authority 白名单和 Origin 白名单为实际公开端口；Origin 必须包含 `:8443`。不能仅比较 `$host`（已去除端口），也不能把代理内部端口当成公开端口。多公开域名应分别配置其 server 和对应来源，不要将所有域名拼成任意相互允许的通配列表。
- `Origin`、`Host`、转发头和 Fetch Metadata **都不是身份认证**；非浏览器客户端可以伪造这些头，包括 `Sec-Fetch-Site: same-origin`。此规则只是防止邮件中的令牌链接被导向攻击者域名，不能替代登录、权限、一次性令牌、频控或完整 CSRF 防护；其他 API 的来源规则不因本示例扩大或放宽。

**必须先由部署管理员在目标环境执行配置语法检查和来源边界验收，再启用安全邮件功能。** 本文示例不代表已修改、重载或验收任何线上 Nginx。应用不盲目信任 `X-Forwarded-*`；示例覆盖客户端自带转发头并保留原始 Origin，仅适用于直接面向客户端且自行终止 TLS 的这一层网关，前面还有负载均衡时应由管理员另行设计可信代理范围及公开 scheme/authority 校验，不能直接信任客户端转发头。即使上游 Host 为内部地址，也不需要靠伪造公开 Host 才能通过登录/退出；邮件来源准入在公开网关完成，不与代理内部 Host 强绑定。

代理必须原样保留 `/baba-share/`（含 preview 所有子路径）和 `/api/baba-share/core/v1/`。传递 `Authorization`，不要记录该头、Cookie、密钥或带票据的完整路径；禁用预览/API 的共享缓存。不要使用 `proxy_hide_header` 等剥离/覆盖 CSP、`Cache-Control`、`Set-Cookie` 等上游安全响应头，不添加 `allow-same-origin` 或宽松 CORS，不单独将 `filedb/` 发布为静态站。让应用设置响应安全策略，浏览器端必须实测 raw 预览直接打开、iframe、相对资源和恶意预览无法读取主站状态。

上游必须仅向代理开放：同机绑定 loopback，跨机通过受控私网与防火墙限制；对所有网络入口验证，不能仅凭监听参数推断容器映射或防火墙已经阻断绕过。TLS 证书必须被客户端信任。MCP 同域同端口，无需第二监听或第二域名；详见 `MCP-README.md`。

## 7. 升级、备份与恢复

1. 记录代码版本、Python/NSSM版本、服务账号、环境、项目根 `.env`、数据绝对根/卷名、端口和实际公开Origin。
2. 在获准后停止唯一实例（Windows `Stop-Service babaShare`；Compose `docker compose stop baba-share`；Linux按其管理器停止），确认没有另一实例持锁或写入。
3. 将整个数据根及配套配置备份到受保护位置，保留ACL/权限并校验备份可读。master备份必须与对应数据库一同管控。不要只导出工作区文件或单库。
4. 更新代码或重建镜像，保留稳定服务路径、数据目录/卷名和既有配置。不清库、不改数据库归属、不移动NSSM。升级Python路径时须在确认后更新服务应用路径，不盲目重装。
5. 在停服、完整备份状态下运行一次 `--check`，接受兼容迁移；失败立即停止排查，不能把旧代码直接指向已变化的数据库试运气。
6. 启动唯一实例，完成下方验证。若需回滚，停止后从**同一备份组**恢复数据库、filedb、master及相应旧版本配置和代码；不要混搭时间点或仅替换数据库。
7. 在隔离临时目录/独立测试卷验证恢复，使用不同监听端口且不触碰真实数据。确认恢复流程后才把备份视为可用。

## 8. 故障排查与验收

- **路径/权限**：核对绝对数据根、服务账号、Python/代码/NSSM访问、宿主ACL/UID和共享设置。不要清空数据、自动放宽权限或换空目录。
- **端口冲突**：原生只调整 `BABA_SHARE_PORT` 及对应公开Origin；Compose只调整宿主发布端口和公开Origin。先识别占用者，不擅自杀进程。
- **发现历史库、数据库损坏、锁等待**：停止写入，完整备份，人工在副本检查；历史库会安全阻断启动，绝不自动读取、合并、替换或删除。不要删除SQLite/WAL/SHM或锁文件试探，也不要换空目录绕过保护。
- **MCP master缺失/异常**：恢复数据库对应的原始32字节主密钥，不生成替代密钥，不仅恢复数据库。保护Windows ACL；POSIX `0600`不能验证它。
- **登录/退出 403 或预览拒绝**：先区分网关域名/限流拒绝、业务权限不足与应用来源防护；检查 `Origin: null`、明确跨站浏览器请求、安全响应头和票据有效期。`PUBLIC_ORIGIN` 不绑定请求 Host/Origin，配置不匹配不是正常代理登录/退出被拒绝的理由；不要用移除 sandbox、放宽 CORS 或双端口绕过。会话丢失时检查浏览器实际 HTTPS 与 Secure Cookie；生成链接错误时再校正公开来源。
- **空间或日志增长**：监控完整数据根与卷容量，按授权策略归档。应用/卸载脚本不会删除用户文件或历史日志。
- **依赖缺失**：明确列出管理员需安装的Python/SQLite/Docker/NSSM，不能静默下载或安装系统软件。

验收清单：

- [ ] `--check` 使用预期绝对数据根并成功，已理解其数据库初始化/迁移副作用。
- [ ] 日志中的唯一运行库 `data/baba-share.sqlite3`、绝对数据根与稳定卷名正确；历史库安全阻断；仅一个HTTP监听端口。
- [ ] 通过外部 HTTPS → HTTP 上游完成初始化/登录/退出、工作区保存读取、相对资源预览和 MCP 只读调用；未登录 401 导航正常。
- [ ] raw预览响应CSP和iframe沙箱均保留，主站Cookie/DOM/存储不能被预览读取。
- [ ] 重启服务/容器后数据库、filedb、master仍在同一数据根。
- [ ] Windows已在目标机器核对LocalService账号、SCM自动启动、服务路径/ACL、日志轮转与已停止服务卸载。
- [ ] 备份副本完成一致性恢复验证，主密钥与数据库配套。
- [ ] 宿主端口仅向预定网关开放，从公网不能直连后端 `8080`（包括容器发布端口）；网关拒绝未知域名及错误 authority 端口并执行 TLS/入口限流；公开来源生成的分享/预览 URL 可访问，外部 HTTPS 的 Cookie 带 Secure。
- [ ] 在隔离账户与测试邮箱上验证五个邮件生成接口：合法公开 Origin 通过来源准入且邮件链接使用该来源；null/其他域名/HTTP 降级/错误端口/多值/带路径 Origin 均被网关拒绝，伪造 `Sec-Fetch-Site: same-origin` 不可绕过错误 Origin；合法 Origin 搭配 `none` / `same-site` / `cross-site` 仍被拒绝；省略 Fetch Metadata 仍精确比对 Origin；缺失 Origin 仅使用管理员保存的可信站点（未配置拒绝），显式空值由后端拒绝；编码等效接口路径不可绕过；普通无 Origin API/MCP 仍按原认证规则运行。

交给Codex等部署助手时，先确认目标系统、代码绝对路径、现有实例/数据根或卷名、唯一端口、一个公开Origin、TLS方案和账号；不明确就询问。未经授权不停止既有服务、改配置/ACL、迁移数据、删卷或注册服务。报告实际命令、退出码、测试数据路径及未执行项；没有Docker必须写“镜像构建与容器运行未执行”，没有SCM实测必须写明。测试仅使用临时目录和随机端口，**不得指定真实 `data/`、`filedb/` 或 `.validation/` 为测试目录**。
