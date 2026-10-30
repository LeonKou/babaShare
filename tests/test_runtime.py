"""启动预检与单实例锁使用隔离临时目录。"""
import logging
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

from backend.config import Config
from backend.runtime import Preflight, RuntimeLock


class RuntimeTests(unittest.TestCase):
    def test_config_defaults_to_wildcard_with_loopback_public_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Config(Path(directory))
            self.assertEqual(config.host, "0.0.0.0")
            self.assertEqual(config.public_origin, "http://127.0.0.1:8080")
            self.assertFalse(config.database_path.exists())

    def test_config_from_env_without_host_defaults_to_wildcard(self):
        with tempfile.TemporaryDirectory() as directory:
            with mock.patch.dict(os.environ, {"BABA_SHARE_DATA_DIR": directory}, clear=True):
                with mock.patch.object(Path, "is_file", return_value=False):
                    config = Config.from_env()
            self.assertEqual(config.root, Path(directory).resolve())
            self.assertEqual(config.host, "0.0.0.0")
            self.assertEqual(config.public_origin, "http://127.0.0.1:8080")
            self.assertFalse(config.database_path.exists())

    def test_config_from_env_preserves_explicit_loopback_host(self):
        with tempfile.TemporaryDirectory() as directory:
            environment = {"BABA_SHARE_DATA_DIR": directory, "BABA_SHARE_HOST": "127.0.0.1"}
            with mock.patch.dict(os.environ, environment, clear=True):
                with mock.patch.object(Path, "is_file", return_value=False):
                    config = Config.from_env()
            self.assertEqual(config.host, "127.0.0.1")
            self.assertEqual(config.public_origin, "http://127.0.0.1:8080")
            self.assertFalse(config.database_path.exists())

    def test_wildcard_host_preserves_explicit_public_origin(self):
        with tempfile.TemporaryDirectory() as directory:
            config = Config(Path(directory), public_origin="https://share.example.com")
            self.assertEqual(config.host, "0.0.0.0")
            self.assertEqual(config.public_origin, "https://share.example.com")

    def config(self, root, web=None):
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            return Config(Path(root), host="127.0.0.1", port=sock.getsockname()[1], web_dir=web)

    def test_preflight_initializes_database_in_temp_directory(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            report = Preflight(config).run()
            self.assertEqual(report["database"], str(Path(directory) / "data" / "baba-share.sqlite3"))
            self.assertTrue(config.database_path.is_file())
            self.assertTrue((config.root / "filedb").is_dir())

    def test_preflight_fails_closed_on_corrupt_database(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            config.database_path.write_bytes(b"not sqlite")
            with self.assertRaisesRegex(RuntimeError, "损坏"):
                Preflight(config).run()
            self.assertEqual(config.database_path.read_bytes(), b"not sqlite")

    def test_preflight_rejects_data_path_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "data"
            root.mkdir()
            (root / "filedb").write_text("preserve", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "不是目录"):
                self.config(root)
            self.assertEqual((root / "filedb").read_text(encoding="utf-8"), "preserve")

    def test_missing_master_with_derived_keys_fails_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            Preflight(config).run()
            from backend.repository import db_id, new_id, now_ms
            import sqlite3
            stamp, user_id, key_id = now_ms(), db_id(new_id()), db_id(new_id())
            connection = sqlite3.connect(config.database_path)
            try:
                connection.execute("INSERT INTO auth_mcp_key (id,user_id,key_name,key_prefix,key_hash,request_id,request_hash,mcp_derivation_version,mcp_derivation_nonce,create_time,update_time) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                                   (key_id, user_id, "test", "bsk-test", "0" * 64, "req", "hash", "hmac-sha256-v1", "a" * 64, stamp, stamp))
                connection.commit()
            finally:
                connection.close()
            with self.assertRaisesRegex(RuntimeError, "主密钥"):
                Preflight(config).run()
            self.assertFalse((config.root / "data" / "mcp-key-master").exists())

    def test_existing_master_is_never_recreated(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            config.root.joinpath("data", "mcp-key-master").write_bytes(b"bad")
            with self.assertRaisesRegex(RuntimeError, "长度错误"):
                Preflight(config).run()
            self.assertEqual(config.root.joinpath("data", "mcp-key-master").read_bytes(), b"bad")

    def test_runtime_lock_rejects_second_instance_and_releases(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "data" / ".baba-share.lock"
            first = RuntimeLock(path).acquire()
            try:
                with self.assertRaisesRegex(RuntimeError, "占用"):
                    RuntimeLock(path).acquire()
            finally:
                first.release()
            second = RuntimeLock(path).acquire()
            second.release()
            self.assertTrue(path.exists())

    def test_database_lock_fails_preflight_without_destroying_db(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            Preflight(config).run()
            import sqlite3
            connection = sqlite3.connect(config.database_path)
            connection.execute("BEGIN EXCLUSIVE")
            try:
                with self.assertRaisesRegex(RuntimeError, "不代表损坏"):
                    Preflight(config).run()
            finally:
                connection.rollback()
                connection.close()

    def test_web_resource_missing_is_reported(self):
        with tempfile.TemporaryDirectory() as directory:
            web = Path(directory) / "web"
            web.mkdir()
            with self.assertRaisesRegex(RuntimeError, "网页运行资源缺失"):
                Preflight(self.config(Path(directory) / "data", web)).run()

    def test_port_conflict_preflight_does_not_initialize_database(self):
        with tempfile.TemporaryDirectory() as directory:
            import socket
            with socket.socket() as occupied:
                occupied.bind(("127.0.0.1", 0))
                port = occupied.getsockname()[1]
                config = Config(Path(directory), host="127.0.0.1", port=port)
                with self.assertRaisesRegex(RuntimeError, "不可用"):
                    Preflight(config).run()
                self.assertFalse(config.database_path.exists())

    def test_cli_check_initializes_without_listening(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            environment = os.environ.copy()
            environment.update(BABA_SHARE_DATA_DIR=directory, BABA_SHARE_HOST="127.0.0.1", BABA_SHARE_PORT=str(config.port))
            result = subprocess.run([sys.executable, "server.py", "--check"], cwd=Path(__file__).resolve().parent.parent,
                                    env=environment, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("initializesDatabase", result.stderr)
            self.assertTrue(config.database_path.is_file())
            self.assertFalse((config.root / "data" / "mcp-key-master").exists())
            lock = RuntimeLock(config.root / "data" / ".baba-share.lock").acquire()
            lock.release()

    def test_permission_denial_is_reported_without_replacing_database(self):
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            original = Path.open

            def deny_probe(path, *args, **kwargs):
                if path.name.startswith(".baba-share-write-"):
                    raise PermissionError("test permission denied")
                return original(path, *args, **kwargs)

            with mock.patch.object(Path, "open", deny_probe), self.assertRaisesRegex(RuntimeError, "不可写"):
                Preflight(config).run()
            self.assertFalse(config.database_path.exists())

    def test_server_termination_stops_single_listener_and_releases_lock(self):
        from backend.controller import LOGGER, run
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            ready, stopped = threading.Event(), threading.Event()
            failures = []

            class Ready(logging.Handler):
                def emit(self, record):
                    if '"event": "started"' in record.getMessage():
                        ready.set()

            handler = Ready()
            LOGGER.addHandler(handler)
            previous = LOGGER.level
            LOGGER.setLevel(logging.INFO)

            def execute():
                try:
                    run(config)
                except BaseException as exc:
                    failures.append(exc)
                finally:
                    stopped.set()

            # 以线程执行时不安装信号处理器；将wait转换为受控关闭事件。
            event_type = threading.Event
            control = event_type()
            worker = threading.Thread(target=execute, daemon=True)
            events = iter((control,))
            with mock.patch("backend.controller.threading.Event", side_effect=lambda: next(events, None) or event_type()):
                worker.start()
                try:
                    self.assertTrue(ready.wait(10))
                    with socket.create_connection(("127.0.0.1", config.port), 3):
                        pass
                    control.set()
                    self.assertTrue(stopped.wait(10))
                    self.assertFalse(failures, failures)
                finally:
                    control.set()
                    worker.join(10)
                    LOGGER.removeHandler(handler)
                    LOGGER.setLevel(previous)
            lock = RuntimeLock(config.root / "data" / ".baba-share.lock").acquire()
            lock.release()

    def test_shutdown_drains_active_upload_before_returning(self):
        from http.server import BaseHTTPRequestHandler
        from backend.runtime import ManagedHTTPServer, close_servers
        with tempfile.TemporaryDirectory() as directory:
            started, finish_upload, closed = threading.Event(), threading.Event(), threading.Event()
            result = Path(directory) / "upload.bin"

            class Upload(BaseHTTPRequestHandler):
                def do_POST(self):
                    started.set()
                    finish_upload.wait(5)
                    result.write_bytes(self.rfile.read(int(self.headers["Content-Length"])))
                    self.send_response(204)
                    self.end_headers()

                def log_message(self, *args):
                    pass

            server = ManagedHTTPServer(("127.0.0.1", 0), Upload)
            serving = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
            serving.start()
            client = socket.create_connection(server.server_address, 3)
            client.sendall(b"POST / HTTP/1.0\r\nContent-Length: 7\r\n\r\npayload")
            self.assertTrue(started.wait(3))

            def shutdown():
                close_servers([server], [serving], grace_seconds=3)
                closed.set()

            closing = threading.Thread(target=shutdown, daemon=True)
            closing.start()
            try:
                self.assertFalse(closed.wait(0.15), "活动上传尚未完成，不应提前退出")
                finish_upload.set()
                self.assertTrue(closed.wait(4))
                self.assertEqual(result.read_bytes(), b"payload")
                self.assertIn(b"204", client.recv(4096))
            finally:
                finish_upload.set()
                client.close()
                closing.join(5)

    def test_shutdown_aborts_slow_connection_only_after_grace_period(self):
        import time
        from http.server import BaseHTTPRequestHandler
        from backend.runtime import ManagedHTTPServer, close_servers
        accepted = threading.Event()

        class Slow(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                accepted.set()

            def log_message(self, *args):
                pass

        server = ManagedHTTPServer(("127.0.0.1", 0), Slow)
        serving = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        serving.start()
        with socket.create_connection(server.server_address, 3) as client:
            self.assertTrue(accepted.wait(3))
            before = time.monotonic()
            close_servers([server], [serving], grace_seconds=0.3)
            elapsed = time.monotonic() - before
            self.assertGreaterEqual(elapsed, 0.25)
            self.assertLess(elapsed, 2)
            client.settimeout(2)
            self.assertEqual(client.recv(10), b"")

    def test_check_cannot_initialize_when_instance_lock_is_held(self):
        from backend.controller import run
        with tempfile.TemporaryDirectory() as directory:
            config = self.config(directory)
            lock = RuntimeLock(config.root / "data" / ".baba-share.lock").acquire()
            try:
                with mock.patch("backend.controller.Preflight.run") as check:
                    with self.assertRaisesRegex(RuntimeError, "占用"):
                        run(config, check_only=True)
                    check.assert_not_called()
                self.assertFalse(config.database_path.exists())
            finally:
                lock.release()

    def test_compose_bind_defaults_and_overrides_do_not_change_public_origin(self):
        import re
        compose = (Path(__file__).resolve().parent.parent / "compose.yaml").read_text(encoding="utf-8")
        mapping = next(line.strip()[3:-1] for line in compose.splitlines()
                       if line.strip().startswith('- "${BABA_SHARE_PUBLISH_IP'))
        environment = {}

        def expand(value):
            return re.sub(r"\$\{([A-Z_]+):-([^{}]*)\}",
                          lambda match: environment.get(match[1]) or match[2], value)

        self.assertEqual(expand(mapping), "0.0.0.0:8080:8080")
        environment.update(BABA_SHARE_PUBLISH_IP="127.0.0.1", BABA_SHARE_PUBLISH_PORT="18080")
        self.assertEqual(expand(mapping), "127.0.0.1:18080:8080")
        self.assertNotIn("http://0.0.0.0", compose)

    def test_compose_default_origins_track_published_ports(self):
        import re
        compose = (Path(__file__).resolve().parent.parent / "compose.yaml").read_text(encoding="utf-8")
        values = {line.strip().split(": ", 1)[0]: line.strip().split(": ", 1)[1]
                  for line in compose.splitlines() if line.strip().startswith("BABA_SHARE_PUBLIC_ORIGIN:")}
        environment = {"BABA_SHARE_PUBLISH_PORT": "18080"}

        def expand(value):
            while "${" in value:
                value = re.sub(r"\$\{([A-Z_]+):-([^{}]*)\}",
                               lambda match: environment.get(match[1]) or match[2], value)
            return value

        self.assertEqual(expand(values["BABA_SHARE_PUBLIC_ORIGIN"]), "http://127.0.0.1:18080")
        self.assertNotIn("PREVIEW_", compose)
        self.assertNotIn("8081", compose)
        environment["BABA_SHARE_PUBLIC_ORIGIN"] = "https://share.example.com"
        self.assertEqual(expand(values["BABA_SHARE_PUBLIC_ORIGIN"]), "https://share.example.com")

    def test_docker_material_is_explicit_nonroot_and_data_is_not_copied(self):
        import json
        project = Path(__file__).resolve().parent.parent
        docker = (project / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("FROM python:3.12-slim", docker)
        self.assertIn("USER 10001:10001", docker)
        self.assertNotIn("VOLUME", docker)
        self.assertNotIn("COPY .", docker)
        health = next(line for line in docker.splitlines() if line.startswith("HEALTHCHECK"))
        command = json.loads(health.split(" CMD ", 1)[1])
        compile(command[2], "healthcheck", "exec")
        self.assertIn("8080", command[2])
        self.assertNotIn("8081", docker)
        compose = (project / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("baba-share-data:/var/lib/baba-share", compose)
        self.assertIn("BABA_SHARE_PUBLISH_IP:-0.0.0.0", compose)
        self.assertIn("read_only: true", compose)
        ignore = (project / ".dockerignore").read_text(encoding="utf-8")
        self.assertEqual(ignore.splitlines()[0], "**")
        self.assertNotIn("!data", ignore)
        self.assertNotIn("!.env", ignore)

    def test_config_rejects_out_of_range_numeric_settings(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError, "SESSION_HOURS"):
                Config(Path(directory), session_hours=0)


if __name__ == "__main__":
    unittest.main()
