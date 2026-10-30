"""应用集中配置；无需第三方依赖。"""
import os
import warnings
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


def normalize_origin(value):
    try:
        parsed = urlsplit(value)
        port = parsed.port
        host = parsed.hostname
        if (parsed.scheme not in ("http", "https") or not host or ":" in host
                or parsed.username is not None or parsed.password is not None
                or parsed.path not in ("", "/") or parsed.query or parsed.fragment
                or "?" in value or "#" in value or "\\" in value or parsed.netloc.endswith(":")
                or any(character.isspace() for character in value)
                or any(not label or not all(character.isascii() and (character.isalnum() or character == "-") for character in label)
                       or label.startswith("-") or label.endswith("-") for label in host.split("."))
                or (port is not None and not 1 <= port <= 65535)):
            raise ValueError
    except ValueError:
        raise ValueError("公开来源必须是无路径、凭据、查询和片段的HTTP(S) IPv4地址或域名Origin") from None
    default_port = 443 if parsed.scheme == "https" else 80
    return f"{parsed.scheme}://{host}" + (f":{port}" if port is not None and port != default_port else "")


@dataclass
class Config:
    root: Path
    host: str = "127.0.0.1"
    port: int = 8080
    preview_port: int = 8081
    public_origin: str = ""
    preview_origin: str = ""
    session_hours: int = 24
    ticket_seconds: int = 900
    max_body_bytes: int = 64 * 1024 * 1024
    secure_cookie: bool = False
    web_dir: Path = None

    def __post_init__(self):
        project_root = Path(__file__).resolve().parent.parent
        root = Path(self.root).expanduser()
        self.root = (root if root.is_absolute() else project_root / root).resolve()
        self.web_dir = Path(self.web_dir or project_root / "web").resolve()
        for name, value, minimum, maximum in (
                ("PORT", self.port, 1, 65535), ("PREVIEW_PORT", self.preview_port, 1, 65535),
                ("SESSION_HOURS", self.session_hours, 1, 87600),
                ("TICKET_SECONDS", self.ticket_seconds, 1, 86400),
                ("MAX_BODY_BYTES", self.max_body_bytes, 1024, 1024 * 1024 * 1024)):
            if type(value) is not int or not minimum <= value <= maximum:
                raise ValueError(f"BABA_SHARE_{name}必须是{minimum}到{maximum}之间的整数")
        if not self.host or self.host != self.host.strip():
            raise ValueError("监听地址不能为空或带有前后空白")
        if ":" in self.host:
            raise ValueError("当前HTTP服务仅支持IPv4监听，请使用127.0.0.1、0.0.0.0或IPv4域名")
        if not 1 <= self.port <= 65535 or not 1 <= self.preview_port <= 65535:
            raise ValueError("监听端口必须在1到65535之间")
        advertised_host = "127.0.0.1" if self.host == "0.0.0.0" else self.host
        self.public_origin = normalize_origin(self.public_origin or f"http://{advertised_host}:{self.port}")
        self.preview_origin = normalize_origin(self.preview_origin or f"http://{advertised_host}:{self.preview_port}")
        if self.public_origin == self.preview_origin or self.port == self.preview_port:
            raise ValueError("主服务与预览服务必须使用独立端口和来源")
        for path in (self.root, self.root / "data", self.root / "filedb"):
            if path.exists() and not path.is_dir():
                raise ValueError(f"数据路径存在但不是目录：{path}")
        database = self.root / "data" / "baba-share.sqlite3"
        legacy_database = self.root / "data" / "product-share.sqlite3"
        if database.exists() and legacy_database.exists():
            raise ValueError(
                f"同时发现两个数据库：{database}和{legacy_database}。"
                "已拒绝启动；请先备份并人工确认唯一数据库及其配套filedb，程序不会自动合并、移动或删除数据。"
            )
        try:
            (self.root / "data").mkdir(parents=True, exist_ok=True)
            (self.root / "filedb").mkdir(parents=True, exist_ok=True)
        except OSError:
            raise ValueError(f"无法创建数据目录：{self.root}；请人工检查挂载、目录所有者和Windows ACL，不要清库或放宽为777权限") from None
        self.database_path = legacy_database if legacy_database.exists() else database
        if legacy_database.exists():
            warnings.warn(
                f"检测到已有数据库，babaShare继续使用{legacy_database}；"
                "未迁移或删除任何数据。新安装使用baba-share.sqlite3。",
                RuntimeWarning,
                stacklevel=2,
            )

    @classmethod
    def from_env(cls):
        project_root = Path(__file__).resolve().parent.parent
        env_file = project_root / ".env"
        if env_file.is_file():
            for line in env_file.read_text(encoding="utf-8-sig").splitlines():
                line = line.strip()
                if not line or line.startswith("#"):
                    continue
                key, separator, value = line.partition("=")
                key, value = key.strip(), value.strip()
                if separator and key.startswith(("BABA_SHARE_", "PRODUCT_SHARE_")):
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                        value = value[1:-1]
                    os.environ.setdefault(key, value)
        def env(key, default):
            return os.environ.get("BABA_SHARE_" + key, os.environ.get("PRODUCT_SHARE_" + key, default))
        def integer(key, default):
            try:
                return int(env(key, default))
            except ValueError:
                raise ValueError(f"BABA_SHARE_{key}必须为整数") from None
        secure_cookie = env("SECURE_COOKIE", "0")
        if secure_cookie not in ("0", "1"):
            raise ValueError("BABA_SHARE_SECURE_COOKIE必须为0或1")
        return cls(
            root=Path(env("DATA_DIR", str(project_root))),
            host=env("HOST", "127.0.0.1"), port=integer("PORT", "8080"),
            preview_port=integer("PREVIEW_PORT", "8081"),
            public_origin=env("PUBLIC_ORIGIN", ""), preview_origin=env("PREVIEW_ORIGIN", ""),
            session_hours=integer("SESSION_HOURS", "24"),
            ticket_seconds=integer("TICKET_SECONDS", "900"),
            max_body_bytes=integer("MAX_BODY_BYTES", str(64 * 1024 * 1024)),
            secure_cookie=secure_cookie == "1",
        )
