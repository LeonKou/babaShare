# babaShare 部署指南

适用于 Windows、Linux 和 Docker Compose。运行时仅依赖 Python 标准库和 SQLite；需要 Python 3.12+，不需要编译前端或安装 Python 第三方包。应用只有一个数据根目录，不按开发/生产环境分目录。

## 先确认现有数据

部署前先确定唯一数据根目录 `DATA_DIR`，并在停止服务后备份整个目录。必须整体保留：

- `data/baba-share.sqlite3`，或已有旧库 `data/product-share.sqlite3`；两者同时存在时启动会失败，程序不会自动合并、移动或删除。
- `filedb/` 工作区文件。
- `data/mcp-key-master`（若存在），必须和其数据库一起备份恢复。
- SQLite 运行时可能出现的 `-wal`、`-shm` 文件；不要趁运行写入时只复制单个数据库文件。

默认数据根目录是项目根目录。设置 `BABA_SHARE_DATA_DIR` 后数据库、文件和主密钥都转移到指定目录。容器只挂载一个完整数据根目录。不要只挂 `filedb/`，也不要在迁移或升级时清空、覆盖已有目录。

## 本项目历史目录说明

- 项目根目录的 `data/` 与 `filedb/` 是成套数据；`.validation/data/` 与 `.validation/filedb/` 是历史手工指定另一处 `DATA_DIR` 后形成的独立一套，不会与根目录同步，也不是可以随意删除的缓存。`.validation/` 已被指定为待停用、待移除的历史目录，不推荐继续使用，也不再作为新验收目录；此约定不代表旧实例已经停止或目录已删除。实际移除须先核对运行实例、成套备份并取得明确删除确认，本文不执行删除。
- `Config` 启动配置时会创建所选数据根目录下的 `data/`、`filedb/`。根 `filedb/` 内与数据库已登记工作区对应的空子目录仍有业务归属，不能仅因为空就当作垃圾。
- 整理前先人工决定要保留哪套并停止对应服务，完整备份其数据库、整个 `filedb/` 和 `data/mcp-key-master`（若存在）后再执行经确认的迁移。不要合并两个数据库，也不要只复制文件；本说明不执行任何移动、覆盖或删除操作。

## 原生部署

### Windows PowerShell

```powershell
py -3.12 --version
$env:BABA_SHARE_DATA_DIR = 'D:/baba-share-data'
$env:BABA_SHARE_HOST = '127.0.0.1'
$env:BABA_SHARE_PORT = '8080'
$env:BABA_SHARE_PREVIEW_PORT = '8081'
py -3.12 server.py --check
py -3.12 server.py
```

`--check` 会创建数据目录和持锁文件、检查 SQLite，并初始化新库或执行现有兼容迁移；它不是只读检查。正常启动也会自动执行相同初始化/迁移，无需先手动建库。检查首先获取操作系统实例锁，同一目录已有实例运行时会在检查/迁移数据库之前拒绝，不会并发修改现有库；持锁文件会保留但进程退出/崩溃会释放操作系统锁。默认主页面为 `http://127.0.0.1:8080/baba-share/`。

### Linux

```bash
python3.12 --version
export BABA_SHARE_DATA_DIR=/srv/baba-share-data
export BABA_SHARE_HOST=127.0.0.1
export BABA_SHARE_PORT=8080
export BABA_SHARE_PREVIEW_PORT=8081
python3.12 server.py --check
python3.12 server.py
```

在 systemd 等进程管理器中，使用专用运行账号并显式设置相同环境变量。先人工为该账号准备并授权数据目录；程序不会自动 `chown`、放宽权限或清理目录。收到 SIGTERM 或 Ctrl+C 时停止两个 HTTP 监听入口，给已接收的请求最多10秒共享宽限时间完成（包括正在上传的请求），超过期限才关闭剩余连接并输出警告，然后释放实例锁。Compose停止宽限期为15秒；不要将进程管理器的停止期限设得短于应用排空时间。相同数据根目录只允许一个运行实例。

## 配置确认

配置可通过进程环境变量或项目根目录 `.env` 提供；同一变量的进程环境值优先。`BABA_SHARE_*` 优先于迁移期别名 `PRODUCT_SHARE_*`。`.env.example` 是模板，不要将含凭据的 `.env` 放进镜像或提交到代码库。

常用变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `BABA_SHARE_DATA_DIR` | 项目根目录 | 数据库、`filedb` 与 `data/mcp-key-master` 的共同根目录 |
| `BABA_SHARE_HOST` | `127.0.0.1` | 原生运行默认仅本机访问；容器内部须为 `0.0.0.0` |
| `BABA_SHARE_PORT` | `8080` | 主站服务端口 |
| `BABA_SHARE_PREVIEW_PORT` | `8081` | 隔离预览服务端口，必须不同于主站 |
| `BABA_SHARE_PUBLIC_ORIGIN` | 按监听地址构造 | 浏览器实际使用的主站协议、域名/IP和端口，不含路径 |
| `BABA_SHARE_PREVIEW_ORIGIN` | 按监听地址构造 | 浏览器实际使用的预览协议、域名/IP和端口，不含路径，必须与主站不同 |
| `BABA_SHARE_SECURE_COOKIE` | `0` | HTTPS 主站必须设为 `1` |
| `BABA_SHARE_SESSION_HOURS` | `24` | 1..87600 |
| `BABA_SHARE_TICKET_SECONDS` | `900` | 1..86400 |
| `BABA_SHARE_MAX_BODY_BYTES` | `67108864` | 1024..1073741824 |

远程开放访问时，不能只改监听地址。必须设置两个精确公开 Origin，并为主站和预览来源配置 HTTPS；主来源 HTTPS 时启用 Secure Cookie。`Host` 请求头必须与浏览器实际访问的来源一致，反向代理应转发原始 Host。Origin 仅允许 HTTP(S) 协议、IPv4 地址或域名及可选端口，不含路径、凭据、查询和片段。不要把预览来源与主来源代理到同一端口。

端口预检只能发现检查瞬间的冲突；端口释放与服务绑定间存在竞态，不能保证绝对无冲突。最终绑定失败时服务会退出，请更换端口后重试。

## Docker Compose

要求 Docker Engine 与 Docker Compose 插件已由管理员安装。此处不自动安装系统软件。默认发布端口只绑定宿主机 `127.0.0.1`，只能本机访问；浏览器来源默认是 `http://127.0.0.1:8080` 和 `http://127.0.0.1:8081`。容器内监听 `0.0.0.0` 是容器网络要求，不代表应将宿主端口公开到所有网卡。

在项目目录执行：

```sh
docker compose config
docker compose build
docker compose run --rm baba-share python server.py --check
docker compose up -d
docker compose ps
docker compose logs --tail=100 baba-share
```

`docker compose run --rm ... --check` 使用相同命名卷和配置，会初始化/迁移数据库，然后退出；不是只读检查。不要在现有实例运行时执行第二个 `--check`，它会尝试获取单实例锁。如果检查需要初始化，先确认已对整卷备份，并接受该数据库初始化/迁移。

Compose 默认使用明确命名的 `baba-share-data` 命名卷。升级镜像或普通 `docker compose down` 不会删除命名卷。**禁止使用 `docker compose down -v`、`docker volume rm` 或 `docker volume prune`，除非已确认卷内容并完成可验证备份。** 不要改用未声明名称的自动匿名卷：容器重建可能挂到另一个空卷。确保项目/compose 配置中的卷名保持稳定。`docker compose up` 之前运行 `docker compose config` 确认解析后的挂载、公开来源、宿主绑定地址和端口。

也可指定 bind mount，例如将服务卷项改为绝对宿主路径：

```yaml
volumes:
  - /srv/baba-share-data:/var/lib/baba-share
```

Windows Docker Desktop 示例使用已共享、可写的绝对路径：`D:/baba-share-data:/var/lib/baba-share`。Docker Desktop 必须允许该盘/路径文件共享；还要确认宿主目录 ACL 允许容器的非 root UID `10001` 读写。Linux bind mount 需要管理员预先为 UID `10001` 设置适当所有者/ACL。请人工处理权限，不要自动 chown 用户文件，也不要 `chmod 777`。命名卷同样使用镜像内非 root UID 运行，首次挂载前核实卷目录权限。

如果要从其他机器访问，应明确绑定适当的宿主网卡地址并配置防火墙/反向代理，设置浏览器实际可达的两个公开 Origin（含端口），配置 TLS 与 `BABA_SHARE_SECURE_COOKIE=1`。可在 `.env` 中定义：

```dotenv
BABA_SHARE_PUBLISH_IP=127.0.0.1
BABA_SHARE_PUBLISH_PORT=8080
BABA_SHARE_PREVIEW_PUBLISH_PORT=8081
# 本机HTTP可省略以下两个Origin，默认随上面的宿主发布端口联动。
# BABA_SHARE_PUBLIC_ORIGIN=http://127.0.0.1:8080
# BABA_SHARE_PREVIEW_ORIGIN=http://127.0.0.1:8081
BABA_SHARE_SECURE_COOKIE=0
BABA_SHARE_VOLUME_NAME=baba-share-data
```

只改 `BABA_SHARE_PUBLISH_PORT=18080` 和 `BABA_SHARE_PREVIEW_PUBLISH_PORT=18081` 且不显式设置 Origin 时，默认来源联动为 `http://127.0.0.1:18080` 与 `http://127.0.0.1:18081`。显式设置的 Origin 优先，不会自动覆盖；若 `.env` 已写死旧值，必须一并更新。修改 `BABA_SHARE_PUBLISH_IP` 不推导浏览器域名/IP（绑定地址不等于访问地址），非本机访问仍须显式配置两个 Origin。

远程 HTTPS 部署时，按实际浏览器来源改为例如 `https://share.example.com` 与 `https://preview.example.com`，将 `BABA_SHARE_SECURE_COOKIE=1`；发布端口默认仍为 loopback，由反向代理访问本机上游，或显式设置 `BABA_SHARE_PUBLISH_IP` 为有意公开的宿主 IPv4 地址。示例域名不是可直接使用的服务地址。

### 数据与卷的风险

- 必须把整个 `/var/lib/baba-share` 挂载出来，其中同时包含 SQLite、`filedb/` 和 `data/mcp-key-master`。若只挂工作区文件，容器重建仍会丢失数据库和密钥。
- 未挂载数据目录时，数据落在容器可写层；容器移除或重建后不应假定还能恢复。
- Docker Desktop bind mount 受文件共享设置、Windows ACL、驱动语义影响；容器显示可启动不等于宿主数据持久化已验证。
- Compose 相对 bind 路径以 Compose 文件所在目录为基础，容易挂错到代码目录；生产建议明确命名卷或使用绝对宿主路径，并在启动前复核 `docker compose config`。
- 不要仅依赖容器内文件权限位来证明 Windows ACL 安全。Windows 上 MCP master 的保护依赖宿主 ACL；Linux POSIX 文件权限 `0600` 检查不会验证 Windows ACL。
- 备份整个数据根目录；数据库运行时请先停服务或使用一致性快照。部署前验证恢复流程。

## 恢复与故障排查

1. **目录权限或不是目录**：核对 `BABA_SHARE_DATA_DIR` 的绝对路径、宿主 ACL/所有权、Docker Desktop 文件共享和 UID `10001` 权限。不要覆盖或清空该目录。
2. **端口占用**：找出占用进程，或分别修改 `BABA_SHARE_PORT`、`BABA_SHARE_PREVIEW_PORT`；容器内部端口固定为 8080/8081，compose 只调整宿主发布端口。
3. **新旧数据库同时存在**：停止服务，备份完整数据根目录；人工确认正确数据库及其配套 `filedb` 后再决定迁移。程序不会自动择一或合并。
4. **数据库损坏或锁等待**：停止所有写入实例，备份整个数据根目录，再用 SQLite 工具对备份进行人工检查或从一致性备份恢复。不要删除数据库、WAL/SHM 或锁文件来试探。
5. **MCP 主密钥异常或丢失**：从与数据库对应的受保护备份恢复原始32字节主密钥。不要删除主密钥让程序生成另一个，也不要只恢复数据库。Windows 必须用 ACL 限制服务账号，POSIX 的 `0600` 位不能证明 Windows ACL 有效。
6. **实例锁**：`data/.baba-share.lock` 是持锁文件，不是判断进程状态的标记。正常退出会释放操作系统锁，文件保留是预期行为；不要删除它，否则并发进程可能锁定不同文件对象。
7. **空间不足**：检查数据卷剩余空间并按备份策略扩容或归档；程序不会清理用户文件。
8. **容器无法构建/启动**：本项目不自动安装 Docker、Python、系统包或权限。先由管理员按其系统流程安装/授权，再重跑 `docker compose config`、build 和启动检查。

所有故障修复前都先备份，禁止用清库、自动改权限或删除不明文件绕过检查。

## 交给 Codex 或其他部署助手的执行约束

1. 先询问并确认目标机器是 Windows/Linux 原生还是 Docker、现有服务是否运行、代码绝对路径、唯一数据根目录（或已存在命名卷）、两个宿主端口、两个浏览器实际 Origin、HTTPS/代理方案、服务账号/UID；任何信息不确定时停止并询问，不能用新空目录替代现有目录。
2. 只检查 Python/SQLite/Docker 命令可用性，不自动安装系统依赖、创建系统账号、改防火墙或权限。缺少依赖时列出检查命令和需要管理员授权的动作。
3. 部署已有数据前先确认可验证的一致性备份；未获授权不得停止已有服务、覆盖现有 `.env`、迁移数据、改ACL/所有权、清理文件或删除卷。检查模式会初始化/迁移数据库，运行前明确说明并确认。
4. 对全新空数据目录可按上文执行预检和启动；对已有服务遵循管理员批准的停止/备份/升级/启动顺序。不要启动第二个实例来验证同一数据库。
5. 验证两个端口、主页面、登录、文件持久化、隔离预览和重启后的数据保留，报告真实命令、退出码、数据绝对路径以及未执行项。没有Docker时明确写“镜像构建与容器运行未执行”，不能把静态材料检查称为容器实测。

## 验证清单

- [ ] `python server.py --check` 或 Compose 检查成功；留意该命令会初始化新库或迁移现有数据库。
- [ ] 核对日志中的绝对 `DATA_DIR` 和 SQLite 数据库路径是预期目录，且只选中了预期数据库。
- [ ] 新部署后访问主页面并完成首次管理员初始化；确认登录、工作区文件保存/读取正常。
- [ ] 创建预览并确认隔离预览来源可读；若远程部署，确认浏览器实际两个来源、HTTPS、Host 和 Cookie 安全属性匹配配置。
- [ ] 重启服务/容器后核对数据库记录、`filedb` 文件和 MCP master 仍在同一持久化数据根目录。
- [ ] 在备份副本上完成恢复验证后，再把该备份作为生产恢复方案。
- [ ] 确认发布端口只绑定预定网卡，防火墙和代理规则符合访问策略。

开发测试只应使用临时目录和随机端口；不得把项目内 `data/`、`filedb/` 或 `.validation/` 指定为测试数据目录。