"""邮箱注册隔离测试：临时SQLite、真实HTTP与模拟SMTP，绝不发送外部邮件。"""
import concurrent.futures
import http.client
import json
import os
import re
import sqlite3
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest import mock

from backend.config import Config
from backend.controller import Application, BASE
from backend.repository import now_ms
from backend.service import BizError, Service, digest


class EmailRegistrationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.config = Config(Path(self.temp.name), host="127.0.0.1", port=1)
        self.app = Application(self.config)
        self.service = self.app.service
        self.admin = self.service.account({"userName": "admin", "password": "123456"}, "setup")
        self.actor = self.service.repo.user(self.admin["id"])
        self.cookie = "baba_share_session=" + self.service.new_session(self.admin["id"])
        self.environment = mock.patch.dict(os.environ, {"BABA_SHARE_SMTP_PASSWORD": ""})
        self.environment.start()
        self.smtp = mock.patch("backend.service.smtplib.SMTP_SSL")
        self.smtp_class = self.smtp.start()
        self.client = self.smtp_class.return_value
        self.client.send_message.return_value = {}
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), self.app.handler())
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.settings = {"host": "smtp.example.com", "port": 465, "security": "ssl", "username": "sender",
                         "password": "private-test-password", "fromAddress": "sender@example.com", "fromName": "测试",
                         "siteOrigin": "https://share.example.com", "activationHours": 24}
        self.service.mail_settings(self.actor, self.settings)
        self.service.settings(self.actor, {"registrationEnabled": True, "emailRegistrationEnabled": True})

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.smtp.stop()
        self.environment.stop()
        self.temp.cleanup()

    def request(self, method, route, body=None, admin=False, cookie=None, extra_headers=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port, timeout=20)
        headers = {"Content-Type": "application/json", **(extra_headers or {})}
        if admin or cookie:
            headers["Cookie"] = self.cookie if admin else cookie
        connection.request(method, BASE + route, json.dumps(body) if body is not None else None, headers)
        response = connection.getresponse()
        raw = response.read()
        result = json.loads(raw) if raw else {}
        headers = dict(response.getheaders())
        status = response.status
        connection.close()
        return status, result, headers

    def send(self, email="user@example.com", ip="127.0.0.1"):
        self.service.email_registration({"userName": email if len(email) <= 64 else "long-email-user", "email": email, "nickname": "新成员", "role": "admin"}, ip)
        message = self.client.send_message.call_args.args[0]
        return re.search(r"#activation=([A-Za-z0-9_-]{43})", message.get_body(preferencelist=("plain",)).get_content()).group(1)

    def activate(self, token, password="123456", confirm="123456", cookie=None):
        return self.request("POST", "/visitor/email/activation", {"token": token, "password": password,
                                                                  "passwordConfirm": confirm, "role": "admin"}, cookie=cookie)

    def test_end_to_end_get_does_not_activate_then_auto_login(self):
        token = self.send()
        self.assertIsNone(self.service.repo.user_by_name("user@example.com"))
        row = self.service.repo.one("SELECT activation_hash,expire_time,create_time FROM email_activation")
        self.assertEqual(row["activation_hash"], digest(token))
        self.assertEqual(row["expire_time"] - row["create_time"], 24 * 3600000)
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request("GET", "/baba-share/activate.html")
        response = connection.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn(b"activate.js", response.read())
        connection.close()
        self.assertIsNone(self.service.repo.user_by_name("user@example.com"))
        failed_status, failed_result, failed_headers = self.activate(token, "123456", "different")
        self.assertEqual((failed_status, failed_result["status"]), (400, "PASSWORD_MISMATCH"))
        self.assertNotIn("Set-Cookie", failed_headers)
        self.assertIsNone(self.service.repo.user_by_name("user@example.com"))
        status, result, headers = self.activate(token)
        self.assertEqual((status, result), (200, {}))
        cookie = headers["Set-Cookie"]
        for attribute in ("Path=" + BASE, "HttpOnly", "SameSite=Strict", "Max-Age=" + str(self.config.session_hours * 3600)):
            self.assertIn(attribute, cookie)
        self.assertNotIn("Secure", cookie)
        status, session_user, _ = self.request("GET", "/session/detail", cookie=cookie.split(";", 1)[0])
        self.assertEqual(status, 200)
        self.assertEqual((session_user["userName"], session_user["role"]), ("user@example.com", "editor"))
        self.assertEqual(self.service.authenticated(self.cookie.split("=", 1)[1])["id"], self.admin["id"])
        user = self.service.repo.user_by_name("user@example.com")
        self.assertEqual(user["user_role"], "editor")
        self.assertNotEqual(user["password_hash"], "123456")
        before = self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"]
        replay_status, replay_result, replay_headers = self.activate(token)
        self.assertEqual((replay_status, replay_result["status"]), (400, "ACTIVATION_INVALID"))
        self.assertNotIn("Set-Cookie", replay_headers)
        self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"], before)
        self.assertEqual(self.service.repo.one("SELECT count(*) AS user_count FROM sys_user")["user_count"], 2)
        self.assertEqual(self.request("POST", "/visitor/session", {"userName": "USER@example.com", "password": "123456"})[0], 200)

    def test_email_registration_and_activation_always_editor_with_scoped_permissions(self):
        existing = self.service.account({"userName": "existing-editor", "password": "123456", "role": "editor"}, actor=self.actor)
        before = self.service.repo.user(existing["id"])
        for role in (None, "admin", "viewer"):
            with self.subTest(role=role):
                email = (role or "default") + "@example.com"
                body = {"userName": email if len(email) <= 64 else "long-email-user", "email": email}
                activation = {"password": "123456", "passwordConfirm": "123456"}
                if role is not None:
                    body["role"] = activation["role"] = role
                self.assertEqual(self.request("POST", "/visitor/email/registration", body)[0], 200)
                message = self.client.send_message.call_args.args[0]
                activation["token"] = re.search(r"#activation=([A-Za-z0-9_-]{43})", message.get_body(preferencelist=("plain",)).get_content()).group(1)
                status, result, headers = self.request("POST", "/visitor/email/activation", activation)
                self.assertEqual((status, result), (200, {}))
                user = self.service.repo.user_by_name(email)
                self.assertEqual(user["user_role"], "editor")
                cookie = headers["Set-Cookie"].split(";", 1)[0]
                self.assertEqual(self.request("GET", "/session/detail", cookie=cookie)[1]["role"], "editor")
                status, workspace, _ = self.request("POST", "/workspace", {"workspaceName": email}, cookie=cookie)
                self.assertEqual((status, workspace["ownerId"], workspace["canWrite"]), (200, user["id"], True))
                sent = self.client.send_message.call_count
                for method, route, settings in (("GET", "/setting/detail", None),
                                                 ("PATCH", "/setting", {"registrationEnabled": False}),
                                                 ("GET", "/mail-setting/detail", None),
                                                 ("PATCH", "/mail-setting", {"host": "smtp.example.com"}),
                                                 ("POST", "/mail-setting/test", {"email": "test@example.com"})):
                    status, error, _ = self.request(method, route, settings, cookie=cookie)
                    self.assertEqual((status, error["status"]), (403, "PERMISSION_DENIED"))
                self.assertEqual(self.client.send_message.call_count, sent)
        self.assertEqual(Service(self.config).repo.user(existing["id"]), before)
        self.assertEqual(self.service.settings(self.actor), {"registrationEnabled": True, "emailRegistrationEnabled": True, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})

    def test_activation_mail_multipart_links_validity_and_escaping(self):
        from html.parser import HTMLParser
        class Links(HTMLParser):
            def __init__(self):
                super().__init__()
                self.links = []
                self.tags = []
            def handle_starttag(self, tag, attributes):
                self.tags.append(tag)
                if tag == "a":
                    self.links.append(dict(attributes))
        self.service.mail_settings(self.actor, {"activationHours": 720})
        email, nickname = "a&'b@example.com", '<img src=x onerror="alert(1)"> & 朋友'
        self.service.email_registration({"userName": "escape-user", "email": email, "nickname": nickname}, "escape-ip")
        message = self.client.send_message.call_args.args[0]
        self.assertEqual(message.get_content_type(), "multipart/alternative")
        self.assertEqual([part.get_content_type() for part in message.iter_parts()], ["text/plain", "text/html"])
        for part in message.iter_parts():
            self.assertEqual(part.get_content_charset(), "utf-8")
        plain = message.get_body(preferencelist=("plain",)).get_content()
        html = message.get_body(preferencelist=("html",)).get_content()
        token = re.search(r"#activation=([A-Za-z0-9_-]{43})", plain).group(1)
        expected = "https://share.example.com/baba-share/activate.html#activation=" + token
        parser = Links()
        parser.feed(html)
        self.assertEqual([link["href"] for link in parser.links], [expected, expected])
        self.assertIn("border-radius:0", parser.links[0]["style"])
        self.assertIn("720 小时", plain)
        self.assertIn("720 小时", html)
        self.assertIn("escape-user", plain)
        self.assertIn("escape-user", html)
        self.assertIn("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; 朋友", html)
        self.assertFalse(set(parser.tags) & {"img", "script", "link", "iframe"})
        self.assertIn("table", parser.tags)
        self.assertNotIn("var(--", html)
        self.assertIn("请勿转发", html)
        unsafe = 'https://share.example.com/?x="&y=<unsafe>'
        _, escaped_html = self.service.activation_mail(email, nickname, unsafe, 24)
        parser = Links()
        parser.feed(escaped_html)
        self.assertEqual([link["href"] for link in parser.links], [unsafe, unsafe])
        self.assertNotIn('href="https://share.example.com/?x="', escaped_html)

    def test_existing_login_only_switches_after_post_and_keeps_other_devices(self):
        token = self.send()
        other_session = self.service.new_session(self.admin["id"])
        connection = http.client.HTTPConnection("127.0.0.1", self.server.server_port)
        connection.request("GET", "/baba-share/activate.html", headers={"Cookie": self.cookie})
        response = connection.getresponse()
        response.read()
        self.assertIsNone(response.getheader("Set-Cookie"))
        connection.close()
        self.assertEqual(self.service.authenticated(self.cookie.split("=", 1)[1])["id"], self.admin["id"])
        failed = self.activate(token, confirm="different", cookie=self.cookie)
        self.assertNotIn("Set-Cookie", failed[2])
        self.assertEqual(self.service.authenticated(self.cookie.split("=", 1)[1])["id"], self.admin["id"])
        self.config.secure_cookie = True
        status, _, headers = self.activate(token, cookie=self.cookie)
        self.assertEqual(status, 200)
        self.assertIn("; Secure", headers["Set-Cookie"])
        new_cookie = headers["Set-Cookie"].split(";", 1)[0]
        self.assertNotEqual(new_cookie, self.cookie)
        self.assertEqual(self.request("GET", "/session/detail", cookie=new_cookie)[1]["userName"], "user@example.com")
        self.assertEqual(self.request("GET", "/session/detail", admin=True)[0], 401)
        self.assertEqual(self.service.authenticated(other_session)["id"], self.admin["id"])

    def test_activation_session_write_failure_rolls_back_and_emits_no_cookie(self):
        token = self.send()
        before_sessions = self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"]
        with self.service.repo.connection() as connection:
            connection.execute("CREATE TRIGGER reject_activation_session BEFORE INSERT ON auth_session BEGIN SELECT RAISE(ABORT, 'mock failure'); END")
        status, _, headers = self.activate(token, cookie=self.cookie)
        self.assertEqual(status, 409)
        self.assertNotIn("Set-Cookie", headers)
        self.assertIsNone(self.service.repo.user_by_name("user@example.com"))
        self.assertEqual(self.service.repo.one("SELECT activation_hash FROM email_activation")["activation_hash"], digest(token))
        self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"], before_sessions)
        self.assertEqual(self.service.authenticated(self.cookie.split("=", 1)[1])["id"], self.admin["id"])
        with self.service.repo.connection() as connection:
            connection.execute("DROP TRIGGER reject_activation_session")
        self.assertEqual(self.activate(token, cookie=self.cookie)[0], 200)

    def test_activation_commit_failure_rolls_back_user_token_and_session(self):
        from contextlib import contextmanager
        token = self.send()
        original = self.service.repo.connection
        @contextmanager
        def failing_commit():
            with original() as connection:
                yield connection
                if connection.in_transaction:
                    raise sqlite3.OperationalError("mock commit failure")
        with mock.patch.object(self.service.repo, "connection", failing_commit):
            status, _, headers = self.activate(token, cookie=self.cookie)
        self.assertEqual(status, 500)
        self.assertNotIn("Set-Cookie", headers)
        self.assertIsNone(self.service.repo.user_by_name("user@example.com"))
        self.assertEqual(self.service.repo.one("SELECT activation_hash FROM email_activation")["activation_hash"], digest(token))
        self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"], 1)
        self.assertEqual(self.service.authenticated(self.cookie.split("=", 1)[1])["id"], self.admin["id"])
        self.assertEqual(self.activate(token)[0], 200)

    def test_direct_registration_blocked_but_admin_create_allowed(self):
        status, result, _ = self.request("POST", "/visitor/account/registration", {"userName": "bypass", "password": "123456"})
        self.assertEqual((status, result["status"]), (403, "EMAIL_VERIFICATION_REQUIRED"))
        self.assertEqual(self.request("POST", "/user", {"userName": "manual", "password": "123456"}, admin=True)[0], 200)

    def test_mode_changes_invalidate_old_tokens_and_total_off_rejects_all(self):
        token = self.send()
        self.service.settings(self.actor, {"emailRegistrationEnabled": False})
        self.assertEqual(self.activate(token)[0], 403)
        self.assertEqual(self.request("POST", "/visitor/account/registration", {"userName": "direct", "password": "123456"})[0], 200)
        self.service.settings(self.actor, {"emailRegistrationEnabled": True})
        self.assertEqual(self.activate(token)[1]["status"], "ACTIVATION_INVALID")
        self.service.settings(self.actor, {"registrationEnabled": False})
        self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": "other@example.com", "email": "other@example.com"})[0], 403)
        self.assertEqual(self.request("POST", "/visitor/account/registration", {"userName": "other", "password": "123456"})[0], 403)

    def test_expiration_resend_and_password_boundaries(self):
        token = self.send()
        for password in ("12345", "x" * 257):
            self.assertEqual(self.activate(token, password, password)[0], 400)
        self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
        replacement = self.send()
        self.assertNotEqual(token, replacement)
        self.assertEqual(self.activate(token)[1]["status"], "ACTIVATION_INVALID")
        self.service.repo.execute("UPDATE email_activation SET expire_time=? WHERE id IS NOT NULL", (now_ms() - 1,))
        self.assertEqual(self.activate(replacement)[1]["status"], "ACTIVATION_INVALID")

    def test_concurrent_consumption_is_atomic(self):
        token = self.send()
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(lambda _: self.activate(token)[0], range(2)))
        self.assertEqual(sorted(statuses), [200, 400])
        self.assertEqual(self.service.repo.one("SELECT count(*) AS user_count FROM sys_user WHERE user_name=?", ("user@example.com",))["user_count"], 1)
        self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"], 2)

    def test_send_failure_does_not_create_pending_or_formal_user(self):
        self.client.send_message.side_effect = OSError("敏感邮件配置不得泄漏")
        status, result, _ = self.request("POST", "/visitor/email/registration", {"userName": "fail@example.com", "email": "fail@example.com"})
        self.assertEqual((status, result["status"]), (503, "MAIL_SEND_FAILED"))
        self.assertNotIn("敏感", json.dumps(result))
        self.assertIsNone(self.service.repo.user_by_name("fail@example.com"))
        self.assertEqual(self.service.repo.one("SELECT count(*) AS activation_count FROM email_activation")["activation_count"], 0)

    def test_limits_duplicates_and_email_injection(self):
        self.send()
        self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": "user@example.com", "email": "user@example.com"})[1]["status"], "REGISTRATION_THROTTLED")
        for email in ("a@example.com\r\nBcc:evil@example.com", "a@@example.com", "a@-example.com", "a..b@example.com", "x" * 65 + "@example.com", " a@example.com"):
            self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": email if len(email) <= 64 else "long-email-user", "email": email})[0], 400)
        self.service.account({"userName": "exists@example.com", "password": "123456"}, actor=self.actor)
        count = self.client.send_message.call_count
        status, result, _ = self.request("POST", "/visitor/email/registration", {"userName": "exists@example.com", "email": "exists@example.com"})
        self.assertEqual((status, result), (409, {"code": 409, "status": "USER_EXISTS", "msg": "账号已存在"}))
        self.assertEqual(self.client.send_message.call_count, count)
        self.service.repo.execute("UPDATE registration_attempt SET client_hash=? WHERE id IS NOT NULL", (digest("other-ip"),))
        for i in range(20):
            self.service.email_registration({"userName": f"limit{i}", "email": f"limit{i}@example.com"}, "limit-ip")
        with self.assertRaises(BizError) as raised:
            self.service.email_registration({"userName": "overflow", "email": "overflow@example.com"}, "limit-ip")
        self.assertEqual(raised.exception.status, "REGISTRATION_THROTTLED")

    def test_registration_conflicts_precede_smtp_and_leave_no_side_effects(self):
        self.service.repo.execute("UPDATE sys_user SET email=? WHERE user_name=?", ("Taken@Example.COM", "admin"))
        before = self.service.repo.user(self.admin["id"])
        cases = (("ADMIN", "fresh@example.com", "USER_EXISTS"),
                 ("fresh-user", "TAKEN@example.com", "EMAIL_EXISTS"),
                 ("ADMIN", "TAKEN@example.com", "USER_EXISTS"),
                 ("admin", "fresh@example.com", "USER_EXISTS"),
                 ("fresh-user", "taken@example.com", "EMAIL_EXISTS"))
        for verified in (0, 1):
            self.service.repo.execute("UPDATE sys_user SET is_email_verified=? WHERE user_name=?", (verified, "admin"))
            for disabled in (0, 1):
                self.service.repo.execute("UPDATE sys_user SET is_disabled=? WHERE user_name=?", (disabled, "admin"))
                for failure in (None, BizError(503, "MAIL_NOT_CONFIGURED", "邮件未配置"),
                                BizError(503, "SMTP_SECRET_UNAVAILABLE", "邮件凭据不可用")):
                    with mock.patch.object(self.service, "mail_config", side_effect=failure) as config, \
                            mock.patch.object(self.service, "mail_ready") as ready, \
                            mock.patch.object(self.service, "smtp_password") as password, \
                            mock.patch.object(self.service, "send_mail") as sending, \
                            mock.patch("backend.service.smtplib.SMTP") as smtp:
                        for name, email, expected in cases:
                            with self.subTest(verified=verified, disabled=disabled, failure=failure, name=name, email=email):
                                status, result, headers = self.request("POST", "/visitor/email/registration",
                                    {"userName": name, "email": email, "nickname": "任意显示名称"})
                                self.assertEqual((status, result), (409, {"code": 409, "status": expected, "msg": "账号已存在"}))
                                self.assertNotIn("Set-Cookie", headers)
                        config.assert_not_called()
                        ready.assert_not_called()
                        password.assert_not_called()
                        sending.assert_not_called()
                        smtp.assert_not_called()
        self.smtp_class.assert_not_called()
        self.client.send_message.assert_not_called()
        self.assertIsNone(self.service.repo.one("SELECT id FROM email_activation"))
        self.assertIsNone(self.service.repo.one("SELECT id FROM registration_attempt"))
        current = self.service.repo.user(self.admin["id"])
        self.assertEqual(current["password_hash"], before["password_hash"])
        self.assertEqual(current["nickname"], before["nickname"])

    def test_plain_registration_duplicate_is_conflict_even_with_same_password(self):
        self.service.settings(self.actor, {"emailRegistrationEnabled": False})
        body = {"userName": "plain-user", "password": "123456", "nickname": "相同显示名称"}
        self.assertEqual(self.request("POST", "/visitor/account/registration", body)[0], 200)
        before = self.service.repo.user_by_name("plain-user")
        for password in ("123456", "changed-password"):
            status, error, headers = self.request("POST", "/visitor/account/registration",
                {**body, "userName": "PLAIN-USER", "password": password})
            self.assertEqual((status, error["code"], error["status"]), (409, 409, "USER_EXISTS"))
            self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.service.repo.user_by_name("plain-user"), before)
        self.client.send_message.assert_not_called()

    def test_plain_registration_concurrency_uses_database_transaction(self):
        self.service.settings(self.actor, {"emailRegistrationEnabled": False})
        other = Service(self.config)
        # 使用独立实例锁，确保唯一性依赖数据库事务而非单进程互斥。
        other.lock = threading.RLock()
        barrier = threading.Barrier(2)
        def register(service):
            barrier.wait(timeout=5)
            try:
                service.account({"userName": "concurrent-user", "password": "123456"}, "registration")
                return "ok"
            except BizError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(register, (self.service, other)))
        self.assertEqual(sorted(outcomes), ["USER_EXISTS", "ok"])
        self.assertEqual(self.service.repo.one("SELECT count(*) AS user_count FROM sys_user WHERE user_name=?", ("concurrent-user",))["user_count"], 1)
        self.client.send_message.assert_not_called()

    def test_distinct_activation_tokens_conflict_across_service_instances(self):
        tokens = []
        for email in ("race-first@example.com", "race-second@example.com"):
            self.service.email_registration({"userName": "activation-race", "email": email}, email)
            message = self.client.send_message.call_args.args[0]
            tokens.append(re.search(r"#activation=([A-Za-z0-9_-]{43})", message.get_body(preferencelist=("plain",)).get_content()).group(1))
        other = Service(self.config)
        other.lock = threading.RLock()
        barrier = threading.Barrier(2)
        def activate(args):
            service, token = args
            barrier.wait(timeout=5)
            try:
                service.email_activation({"token": token, "password": "123456", "passwordConfirm": "123456"})
                return "ok"
            except BizError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(activate, zip((self.service, other), tokens)))
        self.assertEqual(sorted(outcomes), ["USER_EXISTS", "ok"])
        self.assertEqual(self.service.repo.one("SELECT count(*) AS user_count FROM sys_user WHERE user_name=?", ("activation-race",))["user_count"], 1)
        self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"], 2)
        self.assertEqual(self.service.repo.one("SELECT count(*) AS activation_count FROM email_activation")["activation_count"], 1)

    def test_activation_conflicts_preserve_user_token_and_current_session(self):
        for conflict in ("name", "email"):
            with self.subTest(conflict=conflict):
                email = conflict + "@example.com"
                token = self.send(email)
                if conflict == "name":
                    self.service.account({"userName": email.upper(), "password": "existing-password"}, actor=self.actor)
                    expected = "USER_EXISTS"
                else:
                    self.service.repo.execute("UPDATE sys_user SET email=?,is_email_verified=0 WHERE user_name=?", (email, "admin"))
                    expected = "EMAIL_EXISTS"
                before = self.service.repo.user(self.admin["id"])
                sessions = self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"]
                sent = self.client.send_message.call_count
                status, result, headers = self.activate(token, cookie=self.cookie)
                self.assertEqual((status, result), (409, {"code": 409, "status": expected, "msg": "账号已存在"}))
                self.assertNotIn("Set-Cookie", headers)
                self.assertEqual(self.service.repo.user(self.admin["id"]), before)
                self.assertIsNotNone(self.service.repo.one("SELECT id FROM email_activation WHERE activation_hash=?", (digest(token),)))
                self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session")["session_count"], sessions)
                self.assertEqual(self.service.authenticated(self.cookie.split("=", 1)[1])["id"], self.admin["id"])
                self.assertEqual(self.client.send_message.call_count, sent)

    def test_registration_rechecks_conflict_after_smtp_before_pending_write(self):
        for conflict in ("name", "email"):
            name, email = "late-" + conflict, "late-" + conflict + "@example.com"
            def claim_during_send(*args):
                if conflict == "name":
                    self.service.account({"userName": name.upper(), "password": "existing-password"}, actor=self.actor)
                else:
                    self.service.repo.execute("UPDATE sys_user SET email=?,is_email_verified=1 WHERE user_name=?", (email, "admin"))
            with self.subTest(conflict=conflict), mock.patch.object(self.service, "send_mail", side_effect=claim_during_send) as sending:
                status, result, _ = self.request("POST", "/visitor/email/registration", {"userName": name, "email": email})
                self.assertEqual((status, result["status"]), (409, "USER_EXISTS" if conflict == "name" else "EMAIL_EXISTS"))
                sending.assert_called_once()
                self.assertIsNone(self.service.repo.one("SELECT id FROM email_activation WHERE email_address=?", (email,)))

    def test_duplicate_nicknames_do_not_identify_or_authorize_users(self):
        self.service.change_user(self.actor, {"id": self.admin["id"], "nickname": "shared-display"})
        self.service.email_registration({"userName": "nickname@example.com", "email": "nickname@example.com", "nickname": "shared-display"}, "nickname-ip")
        message = self.client.send_message.call_args.args[0]
        token = re.search(r"#activation=([A-Za-z0-9_-]{43})", message.get_body(preferencelist=("plain",)).get_content()).group(1)
        self.assertEqual(self.activate(token)[0], 200)
        first = self.service.repo.user_by_name("nickname@example.com")
        self.service.email_registration({"userName": "nickname-email-second", "email": "nickname-second@example.com",
                                         "nickname": "shared-display"}, "nickname-second-ip")
        message = self.client.send_message.call_args.args[0]
        token = re.search(r"#activation=([A-Za-z0-9_-]{43})", message.get_body(preferencelist=("plain",)).get_content()).group(1)
        self.assertEqual(self.activate(token, "email-second-password", "email-second-password")[0], 200)
        email_second = self.service.repo.user_by_name("nickname-email-second")
        self.assertNotEqual(first["id"], email_second["id"])
        self.assertEqual(email_second["nickname"], first["nickname"])
        self.assertEqual(self.service.login({"userName": "NICKNAME-EMAIL-SECOND", "password": "email-second-password"},
                                           "email-second-login")[0]["id"], email_second["id"])
        self.assertEqual(self.client.send_message.call_count, 2)
        self.service.settings(self.actor, {"emailRegistrationEnabled": False})
        second = self.service.account({"userName": "nickname-second", "password": "second-password", "nickname": "shared-display"}, "registration")
        self.assertNotEqual(first["id"], second["id"])
        self.assertEqual((first["nickname"], second["nickname"]), ("shared-display", "shared-display"))
        self.assertEqual(self.service.login({"userName": first["user_name"], "password": "123456"}, "first-login")[0]["id"], first["id"])
        self.assertEqual(self.service.login({"userName": second["userName"], "password": "second-password"}, "second-login")[0]["id"], second["id"])
        with self.assertRaises(BizError) as raised:
            self.service.login({"userName": "shared-display", "password": "123456"}, "nickname-login")
        self.assertEqual(raised.exception.status, "LOGIN_FAILED")
        workspace = self.service.workspace_create(first, {"workspaceName": "昵称权限隔离"})
        for action in (lambda: self.service.access(second, workspace["id"]),
                       lambda: self.service.access(email_second, workspace["id"]),
                       lambda: self.service.admin(first), lambda: self.service.admin(email_second)):
            with self.assertRaises(BizError) as raised:
                action()
            self.assertEqual(raised.exception.status, "PERMISSION_DENIED")

    def test_admin_mail_config_redaction_limits_and_no_automatic_send(self):
        self.assertEqual(self.client.send_message.call_count, 0)
        status, config, _ = self.request("GET", "/mail-setting/detail", admin=True)
        self.assertEqual(status, 200)
        self.assertNotIn("password", config)
        self.assertNotIn("private-test-password", json.dumps(config))
        self.assertTrue(config["hasPassword"])
        self.assertNotIn("private-test-password", self.service.repo.one("SELECT mail_settings FROM app_setting")["mail_settings"])
        self.assertEqual(self.request("GET", "/mail-setting/detail")[0], 401)
        for value in (0, 721, True, "24"):
            self.assertEqual(self.request("PATCH", "/mail-setting", {"activationHours": value}, admin=True)[0], 400)
        self.assertEqual(self.request("PATCH", "/mail-setting", {"activationHours": 720}, admin=True)[0], 200)
        for body in ({"security": "none"}, {"siteOrigin": "https://evil.example/path"}, {"fromName": "x\r\nBcc:y"}):
            self.assertEqual(self.request("PATCH", "/mail-setting", body, admin=True)[0], 400)
        self.assertEqual(self.client.send_message.call_count, 0)
        self.assertEqual(self.request("POST", "/mail-setting/test", {"email": "test@example.com"}, admin=True)[0], 200)
        self.assertEqual(self.client.send_message.call_count, 1)
        message = self.client.send_message.call_args.args[0]
        self.assertEqual(message.get_content_type(), "multipart/alternative")
        self.assertIn("邮件投递测试", message.get_body(preferencelist=("plain",)).get_content())

    def test_existing_account_conflict_precedes_pending_limit(self):
        from backend.repository import db_id, new_id
        self.service.account({"userName": "exists@example.com", "password": "123456"}, actor=self.actor)
        stamp = now_ms()
        with self.service.repo.connection() as connection:
            connection.executemany("INSERT INTO email_activation (id,email_address,user_name,nickname,activation_hash,expire_time,create_time,update_time) VALUES (?,?,?,?,?,?,?,?)",
                                   [(db_id(new_id()), f"pending{i}@example.com", f"pending{i}", "pending", digest(str(i)), stamp + 3600000, stamp, stamp) for i in range(1000)])
        for email, expected in (("new@example.com", "REGISTRATION_THROTTLED"), ("exists@example.com", "USER_EXISTS")):
            self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": email, "email": email})[1]["status"], expected)
        self.assertEqual(self.client.send_message.call_count, 0)

    def test_failed_resend_preserves_old_token_and_link_is_fixed(self):
        token = self.send()
        self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
        self.client.send_message.side_effect = OSError("mock failure")
        self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": "user@example.com", "email": "user@example.com"})[1]["status"], "MAIL_SEND_FAILED")
        self.assertEqual(self.service.repo.one("SELECT activation_hash FROM email_activation")["activation_hash"], digest(token))
        self.client.send_message.side_effect = None
        self.assertEqual(self.activate(token)[0], 200)
        with mock.patch("backend.service.secrets.token_urlsafe", return_value="b" * 43):
            self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": "fixed@example.com", "email": "fixed@example.com"})[0], 200)
        self.assertEqual(self.client.send_message.call_args.args[0]["To"], "fixed@example.com")
        content = self.client.send_message.call_args.args[0].get_body(preferencelist=("plain",)).get_content()
        self.assertIn("https://share.example.com/baba-share/activate.html#activation=", content)
        self.assertNotIn("returnUrl", content)

    def test_starttls_checks_certificate_before_login_and_send(self):
        self.service.mail_settings(self.actor, {"security": "starttls", "port": 587})
        with mock.patch("backend.service.smtplib.SMTP") as smtp:
            client = smtp.return_value
            client.send_message.return_value = {}
            self.service.mail_test(self.actor, {"email": "test@example.com"})
            smtp.assert_called_once_with("smtp.example.com", 587, timeout=10)
            self.assertEqual([call[0] for call in client.mock_calls], ["__enter__", "ehlo", "starttls", "ehlo", "login", "send_message", "__exit__"])
            context = client.starttls.call_args.kwargs["context"]
            self.assertTrue(context.check_hostname)
            self.assertEqual(context.verify_mode, 2)

    def test_current_schema_initializes_mail_settings_and_preserves_them_on_reopen(self):
        from backend.repository import Repository
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "current.sqlite3"
            repository = Repository(path)
            row = repository.one("SELECT is_registration_enabled,is_email_registration_enabled,registration_revision,mail_settings FROM app_setting")
            self.assertEqual(row, {"is_registration_enabled": 0, "is_email_registration_enabled": 0, "registration_revision": 0, "mail_settings": "{}"})
            repository.execute("UPDATE app_setting SET is_registration_enabled=1,is_email_registration_enabled=1,registration_revision=7,mail_settings=? WHERE id IS NOT NULL", ('{"host":"smtp.example.com"}',))
            before = repository.one("SELECT id,is_registration_enabled,is_email_registration_enabled,registration_revision,mail_settings,create_time,update_time FROM app_setting")
            reopened = Repository(path)
            self.assertEqual(reopened.one("SELECT id,is_registration_enabled,is_email_registration_enabled,registration_revision,mail_settings,create_time,update_time FROM app_setting"), before)
            self.assertEqual(reopened.one("SELECT count(*) AS setting_count FROM app_setting")["setting_count"], 1)

    def test_missing_configuration_cannot_enable(self):
        with tempfile.TemporaryDirectory() as directory:
            service = Service(Config(Path(directory)))
            admin = service.account({"userName": "admin", "password": "123456"}, "setup")
            with self.assertRaises(BizError) as raised:
                service.settings(service.repo.user(admin["id"]), {"emailRegistrationEnabled": True})
            self.assertEqual(raised.exception.status, "MAIL_NOT_CONFIGURED")
            self.assertFalse(service.install_detail()["emailRegistrationEnabled"])

    def test_total_switch_can_close_even_if_mail_secret_is_missing(self):
        (self.config.root / "data" / "smtp-password").unlink()
        result = self.service.settings(self.actor, {"registrationEnabled": False})
        self.assertFalse(result["registrationEnabled"])
        self.assertTrue(result["emailRegistrationEnabled"])
        with self.assertRaises(BizError) as raised:
            self.service.settings(self.actor, {"registrationEnabled": True})
        self.assertEqual(raised.exception.status, "MAIL_NOT_CONFIGURED")

    def test_secret_clear_atomic_replace_and_database_failure_compensation(self):
        path = self.config.root / "data" / "smtp-password"
        self.assertEqual(path.read_text(), "private-test-password")
        self.service.mail_settings(self.actor, {"password": ""})
        self.assertEqual(path.read_text(), "private-test-password")
        with mock.patch("backend.service.os.replace", side_effect=OSError("mock replace")):
            with self.assertRaises(BizError) as raised:
                self.service.mail_settings(self.actor, {"password": "replacement"})
            self.assertEqual(raised.exception.status, "SMTP_SECRET_UNAVAILABLE")
        self.assertEqual(path.read_text(), "private-test-password")
        with mock.patch.object(self.service.repo, "execute", side_effect=sqlite3.OperationalError("mock database")):
            with self.assertRaises(sqlite3.OperationalError):
                self.service.mail_settings(self.actor, {"password": "replacement", "host": "changed.example.com"})
        self.assertEqual(path.read_text(), "private-test-password")
        self.assertEqual(self.service.mail_config()["host"], "smtp.example.com")
        self.service.settings(self.actor, {"emailRegistrationEnabled": False})
        self.service.mail_settings(self.actor, {"clearPassword": True})
        self.assertFalse(path.exists())
        self.assertFalse(self.service.mail_settings(self.actor)["hasPassword"])
        self.assertEqual(list(path.parent.glob(".smtp-secret-*")), [])

    def test_slow_smtp_does_not_hold_global_lock_or_database_transaction(self):
        entered, release = threading.Event(), threading.Event()
        def waiting_send(*args):
            entered.set()
            self.assertTrue(release.wait(5))
        with mock.patch.object(self.service, "send_mail", side_effect=waiting_send):
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
                sending = executor.submit(self.service.email_registration, {"userName": "slow@example.com", "email": "slow@example.com"}, "slow-ip")
                self.assertTrue(entered.wait(2))
                try:
                    updating = executor.submit(self.service.settings, self.actor, {"registrationEnabled": False})
                    self.assertFalse(updating.result(timeout=2)["registrationEnabled"])
                    with self.service.repo.connection() as connection:
                        connection.execute("BEGIN IMMEDIATE")
                finally:
                    release.set()
                with self.assertRaises(BizError):
                    sending.result(timeout=3)
        self.assertIsNone(self.service.repo.one("SELECT id FROM email_activation WHERE email_address=?", ("slow@example.com",)))

    def test_invalid_activation_is_cheap_and_attempts_are_bounded(self):
        with mock.patch("backend.service.password_hash") as hashing:
            for i in range(30):
                self.assertEqual(self.activate("z" * 43)[1]["status"], "ACTIVATION_INVALID")
            self.assertEqual(self.activate("z" * 43)[0], 429)
            hashing.assert_not_called()
        self.service.settings(self.actor, {"registrationEnabled": False})
        with mock.patch("backend.service.password_hash") as hashing:
            with self.assertRaises(BizError) as raised:
                self.service.email_activation({"token": "z" * 43, "password": "123456", "passwordConfirm": "123456"}, "other-ip")
            self.assertEqual(raised.exception.status, "REGISTRATION_DISABLED")
            hashing.assert_not_called()

    def test_workspace_roles_cannot_read_save_or_test_mail(self):
        workspace = self.service.workspace_create(self.actor, {"workspaceName": "邮件权限"})["id"]
        for role in ("editor", "viewer", "manager"):
            user = self.service.account({"userName": role, "password": "123456", "role": "editor"}, actor=self.actor)
            actor = self.service.repo.user(user["id"])
            self.service.member_change(self.actor, {"workspaceId": workspace, "userId": user["id"], "memberRole": role})
            for action in (lambda: self.service.mail_settings(actor), lambda: self.service.mail_settings(actor, {"host": "evil.example.com"}),
                           lambda: self.service.mail_test(actor, {"email": "test@example.com"}), lambda: self.service.settings(actor)):
                with self.assertRaises(BizError) as raised:
                    action()
                self.assertEqual(raised.exception.code, 403)
        self.assertEqual(self.client.send_message.call_count, 0)

    def test_max_email_plus_address_and_inner_http_origin(self):
        self.service.mail_settings(self.actor, {"siteOrigin": "http://192.168.1.20:8080"})
        email = "a+" + "b" * 62 + "@" + "c" * 63 + "." + "d" * 63 + "." + "e" * 61
        self.assertEqual(len(email), 254)
        self.service.email_registration({"userName": email if len(email) <= 64 else "long-email-user", "email": email}, "long-ip")
        message = self.client.send_message.call_args.args[0]
        token = re.search(r"#activation=([A-Za-z0-9_-]{43})", message.get_body(preferencelist=("plain",)).get_content()).group(1)
        self.assertIn("http://192.168.1.20:8080/baba-share/activate.html#activation=", message.get_body(preferencelist=("plain",)).get_content())
        self.assertEqual(self.activate(token)[0], 200)
        self.assertEqual(self.request("POST", "/visitor/session", {"userName": email if len(email) <= 64 else "long-email-user", "password": "123456"})[0], 200)
        self.assertEqual(len(self.service.repo.user_by_name("long-email-user")["nickname"]), 64)
        self.assertEqual(self.request("POST", "/visitor/email/registration", {"email": email + "e"})[0], 400)

    def test_long_email_login_and_secret_environment_override(self):
        email = "a" * 64 + "@" + "b" * 60 + ".example.com"
        token = self.send(email)
        self.assertEqual(self.activate(token, "x" * 256, "x" * 256)[0], 200)
        self.assertEqual(self.request("POST", "/visitor/session", {"userName": "long-email-user", "password": "x" * 256})[0], 200)
        with mock.patch.dict(os.environ, {"BABA_SHARE_SMTP_PASSWORD": "environment-secret"}):
            self.assertEqual(self.service.smtp_password(), "environment-secret")
            self.assertTrue(self.service.mail_settings(self.actor)["hasPassword"])
            for update in ({"password": "replacement"}, {"clearPassword": True}):
                with self.assertRaises(BizError) as raised:
                    self.service.mail_settings(self.actor, update)
                self.assertEqual(raised.exception.status, "SMTP_PASSWORD_ENVIRONMENT")

    def test_secret_rejects_nonregular_file_and_insecure_posix_permissions(self):
        path = self.config.root / "data" / "smtp-password"
        path.unlink()
        path.mkdir()
        try:
            with self.assertRaises(BizError) as raised:
                self.service.smtp_password()
            self.assertEqual(raised.exception.status, "SMTP_SECRET_UNAVAILABLE")
        finally:
            path.rmdir()
        self.service.smtp_password("restored")
        if os.name != "nt":
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            path.chmod(0o644)
            try:
                with self.assertRaises(BizError) as raised:
                    self.service.smtp_password()
                self.assertEqual(raised.exception.status, "SMTP_SECRET_UNAVAILABLE")
            finally:
                path.chmod(0o600)

    def test_new_email_mode_requires_ready_configuration_even_when_total_is_off(self):
        self.service.settings(self.actor, {"registrationEnabled": False, "emailRegistrationEnabled": False})
        before = self.service.mail_config()
        with self.assertRaises(BizError) as raised:
            self.service.settings(self.actor, {"registrationEnabled": False, "emailRegistrationEnabled": True,
                                               "mailSettings": {"host": ""}})
        self.assertEqual(raised.exception.status, "MAIL_NOT_CONFIGURED")
        restarted = Service(self.config)
        self.assertFalse(restarted.settings(self.actor)["emailRegistrationEnabled"])
        self.assertEqual(restarted.mail_config(), before)
        self.assertEqual(restarted.smtp_password(), "private-test-password")

    def test_broken_secret_http503_still_allows_shutdown_and_restart_reads_switches(self):
        path = self.config.root / "data" / "smtp-password"
        path.unlink()
        path.mkdir()
        try:
            self.assertEqual(self.request("GET", "/mail-setting/detail", admin=True)[0], 503)
            self.assertEqual(self.request("PATCH", "/setting", {"registrationEnabled": False}, admin=True)[0], 200)
            self.assertEqual(Service(self.config).settings(self.actor), {"registrationEnabled": False, "emailRegistrationEnabled": True, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})
            self.assertEqual(self.request("PATCH", "/setting", {"emailRegistrationEnabled": False}, admin=True)[0], 200)
            self.assertEqual(Service(self.config).settings(self.actor), {"registrationEnabled": False, "emailRegistrationEnabled": False, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})
        finally:
            path.rmdir()
            self.service.smtp_password("private-test-password")

    def test_commit_failure_compensates_password_and_reconstructed_service_reads_old_state(self):
        from contextlib import contextmanager
        before = self.service.mail_config()
        original = self.service.repo.connection
        @contextmanager
        def failing_commit():
            with original() as connection:
                yield connection
                raise sqlite3.OperationalError("mock commit failure")
        with mock.patch.object(self.service.repo, "connection", failing_commit):
            with self.assertRaises(sqlite3.OperationalError):
                self.service.settings(self.actor, {"registrationEnabled": False, "emailRegistrationEnabled": False,
                                                   "mailSettings": {"host": "changed.example.com", "password": "replacement"}})
        restarted = Service(self.config)
        self.assertEqual(restarted.settings(self.actor), {"registrationEnabled": True, "emailRegistrationEnabled": True, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})
        self.assertEqual(restarted.mail_config(), before)
        self.assertEqual(restarted.smtp_password(), "private-test-password")

    def test_combined_setting_submit_enables_only_with_complete_valid_configuration(self):
        self.service.settings(self.actor, {"registrationEnabled": False, "emailRegistrationEnabled": False})
        before = self.service.mail_config()
        password = self.service.smtp_password()
        invalid = {**self.settings, "host": "changed.example.com", "password": "changed", "activationHours": 721}
        status, result, _ = self.request("PATCH", "/setting", {"registrationEnabled": True, "emailRegistrationEnabled": True, "mailSettings": invalid}, admin=True)
        self.assertEqual((status, result["status"]), (400, "PARAM_INVALID"))
        self.assertEqual(self.service.settings(self.actor), {"registrationEnabled": False, "emailRegistrationEnabled": False, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})
        self.assertEqual(self.service.mail_config(), before)
        self.assertEqual(self.service.smtp_password(), password)
        restarted = Service(self.config)
        self.assertEqual(restarted.settings(self.actor), {"registrationEnabled": False, "emailRegistrationEnabled": False, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})
        self.assertEqual(restarted.mail_config(), before)
        self.assertEqual(restarted.smtp_password(), password)
        valid = {**self.settings, "host": "changed.example.com", "password": "changed", "activationHours": 720}
        status, result, _ = self.request("PATCH", "/setting", {"registrationEnabled": True, "emailRegistrationEnabled": True, "mailSettings": valid}, admin=True)
        self.assertEqual((status, result), (200, {"registrationEnabled": True, "emailRegistrationEnabled": True, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0}))
        self.assertEqual(self.service.mail_config()["activationHours"], 720)
        self.assertEqual(self.service.smtp_password(), "changed")
        self.assertEqual(self.client.send_message.call_count, 0)

    def test_combined_submit_rolls_back_database_secret_and_tokens_on_sql_failure(self):
        token = self.send()
        before = self.service.repo.one("SELECT id,is_registration_enabled,is_email_registration_enabled,mail_settings,registration_revision,create_time,update_time FROM app_setting")
        with self.service.repo.connection() as connection:
            connection.execute("CREATE TRIGGER reject_settings BEFORE UPDATE ON app_setting BEGIN SELECT RAISE(ABORT, 'mock failure'); END")
        with self.assertRaises(sqlite3.IntegrityError):
            self.service.settings(self.actor, {"registrationEnabled": False, "emailRegistrationEnabled": False,
                                               "mailSettings": {**self.settings, "password": "replacement"}})
        self.assertEqual(self.service.repo.one("SELECT id,is_registration_enabled,is_email_registration_enabled,mail_settings,registration_revision,create_time,update_time FROM app_setting"), before)
        self.assertEqual(self.service.smtp_password(), "private-test-password")
        self.assertEqual(self.service.repo.one("SELECT activation_hash FROM email_activation")["activation_hash"], digest(token))

    def test_combined_submit_secret_failure_preserves_actual_configuration(self):
        before = self.service.repo.one("SELECT id,is_registration_enabled,is_email_registration_enabled,mail_settings,registration_revision,create_time,update_time FROM app_setting")
        with mock.patch("backend.service.os.replace", side_effect=OSError("mock secret failure")):
            with self.assertRaises(BizError) as raised:
                self.service.settings(self.actor, {"registrationEnabled": False, "mailSettings": {"password": "replacement"}})
        self.assertEqual(raised.exception.status, "SMTP_SECRET_UNAVAILABLE")
        self.assertEqual(self.service.repo.one("SELECT id,is_registration_enabled,is_email_registration_enabled,mail_settings,registration_revision,create_time,update_time FROM app_setting"), before)
        self.assertEqual(self.service.smtp_password(), "private-test-password")
        restarted = Service(self.config)
        self.assertEqual(restarted.settings(self.actor), {"registrationEnabled": True, "emailRegistrationEnabled": True, "defaultFileCountLimit": 0, "defaultStorageBytesLimit": 0})
        self.assertEqual(restarted.smtp_password(), "private-test-password")

    def test_combined_submit_empty_password_preserves_and_clear_is_explicit(self):
        self.service.settings(self.actor, {"mailSettings": {"password": ""}})
        self.assertEqual(self.service.smtp_password(), "private-test-password")
        with self.assertRaises(BizError) as raised:
            self.service.settings(self.actor, {"mailSettings": {"clearPassword": True}})
        self.assertEqual(raised.exception.status, "MAIL_NOT_CONFIGURED")
        self.assertEqual(self.service.smtp_password(), "private-test-password")
        self.service.settings(self.actor, {"registrationEnabled": False, "emailRegistrationEnabled": False,
                                           "mailSettings": {"clearPassword": True}})
        self.assertEqual(self.service.smtp_password(), "")

    def test_combined_setting_validation_permissions_and_shutdown_with_broken_secret(self):
        for body in ({"mailSettings": None}, {"mailSettings": []}, {"mailSettings": {"unknown": True}}, {"unknown": False}):
            self.assertEqual(self.request("PATCH", "/setting", body, admin=True)[0], 400)
        user = self.service.account({"userName": "viewer2", "password": "123456"}, actor=self.actor)
        with self.assertRaises(BizError) as raised:
            self.service.settings(self.service.repo.user(user["id"]), {"mailSettings": self.settings})
        self.assertEqual(raised.exception.code, 403)
        with mock.patch.object(self.service, "smtp_password", side_effect=BizError(503, "SMTP_SECRET_UNAVAILABLE", "mock")):
            self.assertFalse(self.service.settings(self.actor, {"registrationEnabled": False})["registrationEnabled"])
        self.assertEqual(self.client.send_message.call_count, 0)

    def test_ssl_certificate_context_and_rejected_recipient(self):
        self.send()
        context = self.smtp_class.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, 2)
        self.client.send_message.return_value = {"rejected@example.com": (550, b"mock rejection")}
        self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": "rejected@example.com", "email": "rejected@example.com"})[1]["status"], "MAIL_SEND_FAILED")
        self.assertIsNone(self.service.repo.one("SELECT id FROM email_activation WHERE email_address=?", ("rejected@example.com",)))

    def latest_token(self):
        message = self.client.send_message.call_args.args[0]
        plain = message.get_body(preferencelist=("plain",)).get_content()
        return re.search(r"(?:#reset=|&token=)([A-Za-z0-9_-]{43})", plain).group(1)

    def bind_admin(self, email="admin@example.com"):
        status, result, _ = self.request("POST", "/account/email-binding/request", {"email": email}, admin=True)
        self.assertEqual((status, result), (200, {"stage": "new-pending"}))
        token = self.latest_token()
        self.assertEqual(self.request("POST", "/account/email-binding/confirmation", {"token": token}, admin=True)[0], 200)
        return token

    def test_registration_requires_independent_account_and_verified_email(self):
        self.assertEqual(self.request("POST", "/visitor/email/registration", {"email": "first@example.com"})[0], 400)
        self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": "separate", "email": "first@example.com"})[0], 200)
        message = self.client.send_message.call_args.args[0]
        token = re.search(r"#activation=([A-Za-z0-9_-]{43})", message.get_body(preferencelist=("plain",)).get_content()).group(1)
        self.assertEqual(self.activate(token)[0], 200)
        user = self.service.repo.user_by_name("separate")
        self.assertEqual((user["email"], user["is_email_verified"]), ("first@example.com", 1))
        self.assertIsNone(self.service.repo.user_by_name("first@example.com"))
        self.assertEqual(self.request("POST", "/visitor/session", {"userName": "separate", "password": "123456"})[0], 200)

    def test_browser_origin_priority_gateway_boundary_and_no_localhost_guess(self):
        # 域名准入由受信网关负责；直接API客户端可伪造头，但响应绝不返回SMTP令牌。
        headers = {"Origin": "https://new.example.com:443", "Sec-Fetch-Site": "same-origin", "Forwarded": "host=evil.example"}
        status, result, _ = self.request("POST", "/visitor/email/registration", {"userName": "origin", "email": "origin@example.com", "siteOrigin": "https://body.example"}, extra_headers=headers)
        self.assertEqual((status, result), (200, {}))
        plain = self.client.send_message.call_args.args[0].get_body(preferencelist=("plain",)).get_content()
        self.assertIn("https://new.example.com/baba-share/activate.html", plain)
        self.assertNotIn("body.example", plain)
        for origin in ("null", "https://user:pass@example.com", "https://example.com/path", "https://example.com/", "https://example.com?x", "https://example.com#x", "javascript:alert(1)"):
            self.assertEqual(self.request("POST", "/visitor/email/registration", {"userName": "invalid", "email": "invalid@example.com"}, extra_headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"})[0], 403)
        for metadata in ("cross-site", "same-site", "none"):
            self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "unknown@example.com"}, extra_headers={"Origin": "https://new.example.com", "Sec-Fetch-Site": metadata})[0], 403)
        self.service.mail_settings(self.actor, {"siteOrigin": ""})
        self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "unknown@example.com"})[1]["status"], "MAIL_ORIGIN_REQUIRED")
        self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "unknown@example.com"}, extra_headers=headers)[0], 200)

    def test_password_reset_non_enumeration_get_safety_replay_and_session_revocation(self):
        self.bind_admin()
        before = self.client.send_message.call_count
        self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "missing@example.com"})[:2], (200, {}))
        self.assertEqual(self.client.send_message.call_count, before)
        self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "ADMIN@example.com"})[:2], (200, {}))
        token = self.latest_token()
        self.assertEqual(self.service.repo.one("SELECT token_hash FROM account_email_token WHERE token_purpose='password-reset'")["token_hash"], digest(token))
        self.request("GET", "/visitor/password-reset/confirmation?token=" + token)
        self.assertEqual(self.request("GET", "/session/detail", admin=True)[0], 200)
        other = self.service.new_session(self.admin["id"])
        self.assertEqual(self.request("POST", "/visitor/password-reset/confirmation", {"token": token, "password": "newpass", "passwordConfirm": "different"})[0], 400)
        status, result, headers = self.request("POST", "/visitor/password-reset/confirmation", {"token": token, "password": "newpass", "passwordConfirm": "newpass"})
        self.assertEqual((status, result), (200, {}))
        self.assertNotIn("Set-Cookie", headers)
        self.assertEqual(self.request("GET", "/session/detail", admin=True)[0], 401)
        with self.assertRaises(BizError):
            self.service.authenticated(other)
        self.assertEqual(self.request("POST", "/visitor/session", {"userName": "admin", "password": "newpass"})[0], 200)
        self.assertEqual(self.request("POST", "/visitor/password-reset/confirmation", {"token": token, "password": "newpass", "passwordConfirm": "newpass"})[0], 400)

    def test_email_change_two_phase_same_session_and_purpose_binding(self):
        self.bind_admin()
        self.assertEqual(self.request("GET", "/account/email/detail", admin=True)[1]["stage"], "none")
        self.assertEqual(self.request("POST", "/account/email-change/proposal", {"email": "new@example.com"}, admin=True)[1]["status"], "EMAIL_VERIFICATION_REQUIRED")
        self.assertEqual(self.request("POST", "/account/email-change/request", {}, admin=True)[1]["stage"], "old-pending")
        old = self.latest_token()
        self.assertEqual(self.request("POST", "/account/email-change/confirmation", {"token": old}, admin=True)[0], 400)
        other = "baba_share_session=" + self.service.new_session(self.admin["id"])
        self.assertEqual(self.request("POST", "/account/email-change/verification", {"token": old}, cookie=other)[0], 403)
        self.assertEqual(self.request("POST", "/account/email-change/verification", {"token": old}, admin=True)[1], {"stage": "new-email"})
        self.assertEqual(self.request("POST", "/account/email-change/verification", {"token": old}, admin=True)[0], 400)
        self.assertEqual(self.request("POST", "/account/email-change/proposal", {"email": "new@example.com"}, admin=True)[0], 200)
        token = self.latest_token()
        self.assertEqual(self.service.repo.user(self.admin["id"])["email"], "admin@example.com")
        self.assertEqual(self.request("POST", "/account/email-change/verification", {"token": token}, admin=True)[0], 400)
        self.assertEqual(self.request("POST", "/account/email-binding/confirmation", {"token": token}, admin=True)[0], 400)
        self.assertEqual(self.request("POST", "/account/email-change/confirmation", {"token": token}, cookie=other)[0], 403)
        self.assertEqual(self.request("POST", "/account/email-change/confirmation", {"token": token}, admin=True)[1], {"stage": "none", "email": "new@example.com", "emailVerified": True})
        self.assertEqual(self.service.repo.user(self.admin["id"])["user_name"], "admin")
        self.assertEqual(self.request("POST", "/account/email-change/confirmation", {"token": token}, admin=True)[0], 400)

    def test_admin_cannot_assign_email_and_binding_does_not_change_other_account(self):
        body = {"userName": "manual-email", "email": "admin@example.com", "password": "123456"}
        self.assertEqual(self.request("POST", "/user", body, admin=True)[0], 400)
        self.assertIsNone(self.service.repo.user_by_name("manual-email"))
        body.pop("email")
        status, user, _ = self.request("POST", "/user", body, admin=True)
        self.assertEqual(status, 200)
        before_user = self.service.repo.user(user["id"])
        self.assertIsNone(before_user["email"])
        self.assertFalse(before_user["is_email_verified"])
        before = self.client.send_message.call_count
        self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "admin@example.com"})[0], 200)
        self.assertEqual(self.client.send_message.call_count, before)
        self.assertEqual(self.request("PATCH", "/user", {"id": user["id"], "email": "changed@example.com"}, admin=True)[0], 400)
        self.bind_admin()
        self.assertEqual(self.service.repo.user(user["id"]), before_user)
        self.assertEqual(self.service.repo.user(self.admin["id"])["email"], "admin@example.com")

    def test_reset_resend_expiry_disable_and_concurrent_confirmation(self):
        self.bind_admin()
        self.request("POST", "/visitor/password-reset/request", {"email": "admin@example.com"})
        old = self.latest_token()
        self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
        self.request("POST", "/visitor/password-reset/request", {"email": "admin@example.com"})
        token = self.latest_token()
        body = {"token": old, "password": "newpass", "passwordConfirm": "newpass"}
        self.assertEqual(self.request("POST", "/visitor/password-reset/confirmation", body)[0], 400)
        body["token"] = token
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
            statuses = list(executor.map(lambda _: self.request("POST", "/visitor/password-reset/confirmation", body)[0], range(2)))
        self.assertEqual(sorted(statuses), [200, 400])

    def test_reset_expiration_disabled_account_and_smtp_failure_are_safe(self):
        self.bind_admin()
        self.client.send_message.side_effect = OSError("mock failure")
        self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "admin@example.com"})[:2], (200, {}))
        self.assertIsNone(self.service.repo.one("SELECT id FROM account_email_token WHERE token_purpose='password-reset'"))
        self.client.send_message.side_effect = None
        self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
        self.request("POST", "/visitor/password-reset/request", {"email": "admin@example.com"})
        token = self.latest_token()
        self.service.repo.execute("UPDATE account_email_token SET expire_time=? WHERE token_purpose='password-reset'", (now_ms() - 1,))
        body = {"token": token, "password": "newpass", "passwordConfirm": "newpass"}
        self.assertEqual(self.request("POST", "/visitor/password-reset/confirmation", body)[0], 400)
        self.service.repo.execute("UPDATE account_email_token SET expire_time=? WHERE token_purpose='password-reset'", (now_ms() + 60000,))
        self.service.repo.execute("UPDATE sys_user SET is_disabled=1 WHERE user_name='admin'")
        self.assertEqual(self.request("POST", "/visitor/password-reset/confirmation", body)[0], 400)
        self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
        before = self.client.send_message.call_count
        self.assertEqual(self.request("POST", "/visitor/password-reset/request", {"email": "admin@example.com"})[:2], (200, {}))
        self.assertEqual(self.client.send_message.call_count, before)

    def test_binding_email_uniqueness_race_and_atomic_rollback(self):
        self.request("POST", "/account/email-binding/request", {"email": "shared@example.com"}, admin=True)
        admin_token = self.latest_token()
        user = self.service.account({"userName": "second", "password": "123456"}, actor=self.actor)
        cookie = "baba_share_session=" + self.service.new_session(user["id"])
        self.request("POST", "/account/email-binding/request", {"email": "shared@example.com"}, cookie=cookie)
        # 同一收件邮箱的一分钟节流也应用于不同账户，故推进测试时钟后重试。
        self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
        self.assertEqual(self.request("POST", "/account/email-binding/request", {"email": "shared@example.com"}, cookie=cookie)[0], 200)
        second_token = self.latest_token()
        self.assertEqual(self.request("POST", "/account/email-binding/confirmation", {"token": admin_token}, admin=True)[0], 200)
        self.assertEqual(self.request("POST", "/account/email-binding/confirmation", {"token": second_token}, cookie=cookie)[1]["status"], "EMAIL_EXISTS")
        self.assertIsNone(self.service.repo.user(user["id"])["email"])

    def test_current_schema_keeps_email_like_account_name_separate_from_binding(self):
        from backend.repository import Repository, db_id, new_id
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "current.sqlite3"
            repo = Repository(path)
            repo.execute("INSERT INTO sys_user (id,user_name,nickname,password_hash,user_role,create_time,update_time) VALUES (?,?,?,?,?,1,1)",
                         (db_id(new_id()), "account@example.com", "成员", "unchanged", "editor"))
            row = repo.user_by_name("account@example.com")
            self.assertIsNone(row["email"])
            self.assertEqual((row["is_email_verified"], row["password_hash"]), (0, "unchanged"))
            reopened = Repository(path)
            self.assertEqual(reopened.user_by_name("account@example.com"), row)

    def test_binding_failure_and_logout_never_bind_email(self):
        self.client.send_message.side_effect = OSError("mock failure")
        self.assertEqual(self.request("POST", "/account/email-binding/request", {"email": "failed@example.com"}, admin=True)[0], 503)
        self.assertIsNone(self.service.repo.user(self.admin["id"])["email"])
        self.assertIsNone(self.service.repo.one("SELECT id FROM account_email_token"))
        self.client.send_message.side_effect = None
        self.assertEqual(self.request("POST", "/account/email-binding/request", {"email": "valid@example.com"}, admin=True)[0], 200)
        token = self.latest_token()
        self.request("DELETE", "/session", admin=True)
        self.assertEqual(self.request("POST", "/account/email-binding/confirmation", {"token": token}, admin=True)[0], 401)
        self.assertIsNone(self.service.repo.user(self.admin["id"])["email"])

    def test_binding_routes_reject_change_purpose_without_consuming_token(self):
        self.assertEqual(self.request("POST", "/account/email-change/proposal", {"email": "first@example.com"}, admin=True)[0], 409)
        self.assertEqual(self.request("POST", "/account/email-binding/request", {"email": "first@example.com"}, admin=True)[0], 200)
        token = self.latest_token()
        self.assertEqual(self.request("POST", "/account/email-change/confirmation", {"token": token}, admin=True)[0], 400)
        self.assertEqual(self.request("POST", "/account/email-change/verification", {"token": token}, admin=True)[0], 400)
        self.assertIsNone(self.service.repo.user(self.admin["id"])["email"])
        self.assertEqual(self.request("POST", "/account/email-binding/confirmation", {"token": token}, admin=True)[0], 200)
        self.assertEqual(self.request("POST", "/account/email-binding/request", {"email": "second@example.com"}, admin=True)[0], 409)

    def test_real_api_js_email_paths_match_http_routes(self):
        source = (Path(__file__).resolve().parents[1] / "web" / "assets" / "api.js").read_text(encoding="utf-8")
        paths = dict(re.findall(r'(\w+):\s*"(/[^"\n]+)"', source))
        expected = {
            "emailChangeRequest": "/account/email-change/request",
            "emailChangeVerification": "/account/email-change/verification",
            "emailChangeProposal": "/account/email-change/proposal",
            "emailChangeConfirmation": "/account/email-change/confirmation",
            "emailBindingRequest": "/account/email-binding/request",
            "emailBindingConfirmation": "/account/email-binding/confirmation",
        }
        for key, route in expected.items():
            with self.subTest(key=key):
                self.assertEqual(paths[key], route)
                status, body, _ = self.request("POST", paths[key], {}, admin=True)
                self.assertIn(status, (400, 409))
                self.assertNotEqual(body["status"], "ROUTE_NOT_EXIST")
        for action in ("request", "verification", "proposal", "confirmation"):
            self.assertEqual(self.request("POST", "/account/email/" + action, {}, admin=True)[0], 404)


if __name__ == "__main__":
    unittest.main()
