"""启动：python server.py；配置优先通过BABA_SHARE_*环境变量注入。"""
import argparse
import logging
import sys

if sys.version_info < (3, 12):
    raise SystemExit("需要Python 3.12+。请人工安装后运行：Windows py -3.12 server.py；Linux python3.12 server.py")
try:
    import sqlite3
except ImportError:
    raise SystemExit("Python缺少sqlite3标准库。请由管理员安装含SQLite支持的Python 3.12+；先用 python -c \"import sqlite3; print(sqlite3.sqlite_version)\" 验证，不会自动安装系统依赖。") from None

from backend.config import Config
from backend.controller import run


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="启动 babaShare 服务")
    parser.add_argument("--check", action="store_true", help="执行启动预检；会创建数据目录并初始化/迁移SQLite数据库")
    args = parser.parse_args()
    try:
        run(Config.from_env(), check_only=args.check)
    except (RuntimeError, ValueError, OSError) as exc:
        logging.basicConfig(level=logging.ERROR, format="%(message)s")
        logging.error("启动失败：%s", exc)
        raise SystemExit(1) from None
