# babaShare 部署指南

适用于 Windows 宿主机、Linux 和 Docker Compose。运行时只依赖 Python 3.12+ 标准库和 SQLite，不需要编译前端或安装 Python 第三方包。**仅启动一个 HTTP 服务**：管理页、API、MCP、分享和原始预览复用 `BABA_SHARE_PORT`（默认 `8080`）。只配置一个数据根目录，不按开发/生产拆分数据。

## 1. 部署前保护现有数据

先确定唯一数据根目录 `DATA_DIR`、正在运行的实例和服务账号；停止对应写入实例后，成套备份整个目录。必须同时保留：

- `data/baba-share.sqlite3`，或已有旧库 `data/product-share.sqlite3`。两者同时存在时拒绝启动，不会自动合并、移动或删除。
- 整个 `filedb/`（包含业务所属空目录）。
- `data/mcp-key-master`（若存在），必须和对应数据库一起保护、备份、恢复。
- SQLite 可能存在的 `-wal`、`-shm` 文件；运行中不要只复制单个数据库文件。优先停服务备份，或使用经过验证的一致性快照方案。
- 数据根中的服务日志，以及项目根 `.env` 和服务管理器配置。配置与代码虽不一定在数据根内，恢复时仍须配套保存。

原生运行默认数据根是项目根；Windows 服务脚本默认使用 `%ProgramData%\babaShare\data`；容器使用 `/var/lib/baba-share`。三者都是同一个 `BABA_SHARE_DATA_DIR` 概念，不是三份应当同步的运行目录。指定已有数据根前，先确认这就是要使用的数据，不能因权限或锁冲突改用空目录绕过问题。不要只挂载或迁移 `filedb/`。

### 历史目录约束

项目根 `data/` 与 `filedb/` 是成套数据；`.validation/data/` 和 `.validation/filedb/` 是历史手工指定另一数据根形成的独立一套，不会自动同步，也不是可随意删除的缓存。`.validation/` 待停用、待移除，不应继续用于新验收；这不代表旧实例已停止或目录已删除。移除前必须核对实际实例、完整备份并取得明确删除授权。本文和服务脚本均不移动、覆盖或删除这些目录，也不合并数据库。

## 2. 配置规则与单端口隔离

应用只从**项目根目录**读取 `.env`，不从当前工作目录、数据目录或任意其他路径搜索。同名进程环境变量优先；`BABA_SHARE_*` 优先于迁移别名 `PRODUCT_SHARE_*`。`.env` 是简单 `KEY=value` 文件，不是 shell 脚本，不展开 `$VAR`、`%VAR%` 或命令。不要把含密钥的 `.env` 提交或复制进镜像。

| 变量 | 原生默认值 | 说明 |
| --- | --- | --- |
| `BABA_SHARE_DATA_DIR` | 项目根目录 | SQLite、`filedb`、master 的唯一共同根；相对路径始终相对项目根 |
| `BABA_SHARE_HOST` | `127.0.0.1` | 默认本机；容器内 `0.0.0.0` |
| `BABA_SHARE_PORT` | `8080` | 唯一 HTTP 监听端口 |
| `BABA_SHARE_PUBLIC_ORIGIN` | 按监听地址构造 | 浏览器实际使用的 HTTP(S) 协议、域名/IPv4 和端口，不含路径 |
| `BABA_SHARE_SECURE_COOKIE` | `0` | 公开来源使用 HTTPS 时必须设 `1` |
| `BABA_SHARE_SESSION_HOURS` | `24` | 整数，1..87600 |
| `BABA_SHARE_TICKET_SECONDS` | `900` | 整数，1..86400 |
| `BABA_SHARE_MAX_BODY_BYTES` | `67108864` | 整数，1024..1073741824 |

不存在第二预览端口或预览 Origin 配置；升级时移除旧 `.env`、服务环境及代理中的相关配置。原始预览位于 `/baba-share/preview/{s|p}/token/...`（`s`/`p` 表示不同票据类型，`token` 为实际票据）。URL 与主站同端口，但响应 CSP `sandbox` **不允许 `allow-same-origin`**，浏览器按不透明来源（opaque origin）隔离上传的 HTML/JS；iframe 也保留对应沙箱限制。不能只因 URL 同源就移除这些响应头或沙箱。预览脚本访问主站 DOM、Cookie、存储和接口受到浏览器及服务端来源校验限制；依赖同源存储或接口的原型可能无法直接运行，这是隔离边界而非应绕过的错误。

`Host` 必须匹配实际公开来源。Origin 只支持 HTTP(S)、IPv4/域名和可选端口，不含凭据、路径、query、片段；当前不支持 IPv6 监听。远程部署不能只改监听地址，还要设置正确公开来源、TLS、Secure Cookie 和访问控制。端口预检只能检查当时占用，绑定仍可能竞态失败；应查明占用原因，不得随意终止陌生进程。

`--check` **不是只读检查**：会创建数据目录/持锁文件、检查 SQLite、初始化新库或执行兼容迁移。它先取得操作系统实例锁，同一数据根已有实例运行时会在数据库迁移前拒绝。锁文件保留是正常行为，锁随进程退出释放，不要删除锁文件来绕过互斥。

## 3. Windows 宿主机部署

### 3.1 前台运行

在项目根打开 PowerShell，确认 `py -3` 指向 Python 3.12 或更新版本且含 sqlite3。如不符，改用已安装的合适解释器绝对路径，不要求一定装 3.12 小版本。

```powershell
py -3 -c "import sys,sqlite3; assert sys.version_info >= (3,12); print(sys.executable); print(sqlite3.sqlite_version)"
$env:BABA_SHARE_DATA_DIR = 'D:/baba-share-data'
$env:BABA_SHARE_HOST = '127.0.0.1'
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
$env:BABA_SHARE_HOST = '127.0.0.1'
$env:BABA_SHARE_PORT = '8080'
$env:BABA_SHARE_PUBLIC_ORIGIN = 'http://127.0.0.1:8080'
$env:BABA_SHARE_SECURE_COOKIE = '0'
& './scripts/install-windows-service.bat'
Get-Service babaShare
```

脚本确认后预检、注册 NSSM、设置自动启动和 LocalService、写入服务级数据根/监听/公开来源/Cookie环境、配置日志轮转和退出重启、启动并检查服务状态及监听连接。项目和解释器参数独立设置，路径含空格不需手工拼嵌套引号。失败时尝试只移除本次创建的服务注册，**保留数据库、master、配置、文件、ACL和日志**；回滚也失败时打印警告，须人工核查，不能直接重复覆盖服务。

脚本的 `DATA_DIR/HOST/PORT/PUBLIC_ORIGIN/SECURE_COOKIE` 使用安装终端传入值或脚本默认值，并固定写入 NSSM `AppEnvironmentExtra`，因此覆盖项目 `.env` 的同名配置；默认空公开来源由应用根据监听推导。其他应用配置放项目根 `.env`，不要只依赖安装终端中的临时变量（这些未自动持久化到服务）。NSSM不读取你登录用户的环境。修改已安装服务的持久环境前先备份并确认，管理员可使用 NSSM 参数编辑后重启；不要通过再次运行安装脚本覆盖既有服务。

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
export BABA_SHARE_HOST=127.0.0.1
export BABA_SHARE_PORT=8080
python3 server.py --check
python3 server.py
```

生产通过 systemd 等进程管理器使用专用低权限账号；显式配置绝对解释器/脚本、同一数据根和环境。管理员预先授予代码读执行及数据目录读写权限，不自动 `chown` 或 `chmod 777`。收到SIGTERM/Ctrl+C时停止唯一HTTP监听，已接收请求共享最多10秒排空宽限，然后关闭剩余连接并释放实例锁。管理器停止期限应大于10秒（建议15秒以上）。同一数据根只允许运行一个实例。

## 5. Docker Compose

要求管理员已安装 Docker Engine 与 Compose 插件。默认只发布宿主 `127.0.0.1:8080` 到容器 `8080`，公开来源默认 `http://127.0.0.1:8080`。容器内 `0.0.0.0` 不等于宿主端口应向所有网卡公开。Dockerfile只EXPOSE一个端口，健康检查只请求唯一服务的 `/baba-share/`。

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
BABA_SHARE_PUBLISH_IP=127.0.0.1
BABA_SHARE_PUBLISH_PORT=18080
# 未显式设置时，默认公开来源随发布端口变为http://127.0.0.1:18080。
# 非本机访问或HTTPS必须显式填写真实公开来源。
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

只需一个域名、一个HTTP上游，例如浏览器 `https://share.example.com`，上游 `http://127.0.0.1:8080`（示例需替换为实际地址）。设置：

```dotenv
BABA_SHARE_PUBLIC_ORIGIN=https://share.example.com
BABA_SHARE_SECURE_COOKIE=1
```

代理将 `/baba-share/`（包括preview所有子路径）和 `/api/baba-share/core/v1/` 原样转发至同一个上游。保持浏览器实际 `Host`，传递 `Authorization`，不要记录该头、Cookie、密钥或带预览票据的完整路径；禁用预览/API的共享缓存。不要剥离/覆盖 CSP、`Cache-Control`、`Set-Cookie` 等安全响应头，不添加 `allow-same-origin`、宽松CORS，不单独将 `filedb/` 发布为静态站。让应用设置响应安全策略，浏览器端必须实测raw预览直接打开、iframe、相对资源和恶意预览无法读取主站状态。

上游优先绑定loopback，只向代理开放；跨机代理时通过受控私网与防火墙限制，TLS证书必须被客户端信任。MCP同域同端口，无需第二监听或第二域名；详见 `MCP-README.md`。

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
- **两库同时存在、损坏、锁等待**：停止写入，完整备份，人工在副本检查；不自动合并，不删除SQLite/WAL/SHM或锁文件试探。
- **MCP master缺失/异常**：恢复数据库对应的原始32字节主密钥，不生成替代密钥，不仅恢复数据库。保护Windows ACL；POSIX `0600`不能验证它。
- **预览/Origin拒绝**：核对浏览器实际Origin、代理Host、安全响应头和票据有效期，不能通过移除sandbox、放宽CORS或改双端口绕过。
- **空间或日志增长**：监控完整数据根与卷容量，按授权策略归档。应用/卸载脚本不会删除用户文件或历史日志。
- **依赖缺失**：明确列出管理员需安装的Python/SQLite/Docker/NSSM，不能静默下载或安装系统软件。

验收清单：

- [ ] `--check` 使用预期绝对数据根并成功，已理解其数据库初始化/迁移副作用。
- [ ] 日志中的库路径、旧库选择与稳定卷名正确；仅一个HTTP监听端口。
- [ ] 初始化/登录、工作区保存读取、相对资源预览和MCP只读调用可用。
- [ ] raw预览响应CSP和iframe沙箱均保留，主站Cookie/DOM/存储不能被预览读取。
- [ ] 重启服务/容器后数据库、filedb、master仍在同一数据根。
- [ ] Windows已在目标机器核对LocalService账号、SCM自动启动、服务路径/ACL、日志轮转与已停止服务卸载。
- [ ] 备份副本完成一致性恢复验证，主密钥与数据库配套。
- [ ] 宿主端口仅绑定预定网卡，公开Origin、TLS、Cookie和代理转发一致。

交给Codex等部署助手时，先确认目标系统、代码绝对路径、现有实例/数据根或卷名、唯一端口、一个公开Origin、TLS方案和账号；不明确就询问。未经授权不停止既有服务、改配置/ACL、迁移数据、删卷或注册服务。报告实际命令、退出码、测试数据路径及未执行项；没有Docker必须写“镜像构建与容器运行未执行”，没有SCM实测必须写明。测试仅使用临时目录和随机端口，**不得指定真实 `data/`、`filedb/` 或 `.validation/` 为测试目录**。
