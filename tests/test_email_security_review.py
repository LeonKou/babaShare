"""邮箱安全复审：仅临时SQLite与模拟邮件，不访问真实SMTP。"""
import concurrent.futures
import re
import sqlite3
import tempfile
import threading
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest import mock

from backend.config import Config
from backend.repository import db_id, now_ms
from backend.service import BizError, Service, digest, password_valid


class EmailSecurityReviewTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.service = Service(Config(Path(self.temp.name)))
        self.admin = self.service.account({"userName": "review-admin", "password": "123456"}, "setup")
        self.actor = self.service.repo.user(self.admin["id"])
        self.service.mail_settings(self.actor, {"host": "smtp.example.com", "port": 465,
            "security": "ssl", "username": "", "fromAddress": "sender@example.com",
            "siteOrigin": "https://share.example.com", "activationHours": 24})
        self.service.settings(self.actor, {"registrationEnabled": True, "emailRegistrationEnabled": True})
        self.mail_patch = mock.patch.object(self.service, "send_mail")
        self.mail = self.mail_patch.start()
        self.addCleanup(self.mail_patch.stop)
        for name in ("SMTP", "SMTP_SSL"):
            patcher = mock.patch("backend.service.smtplib." + name, side_effect=AssertionError("禁止真实SMTP"))
            patcher.start()
            self.addCleanup(patcher.stop)
        self.user, self.session = self.make_user("review-user", "owner@example.com")

    def make_user(self, name, email=None):
        created = self.service.account({"userName": name, "password": "123456"}, actor=self.actor)
        if email:
            self.service.repo.execute("UPDATE sys_user SET email=?,is_email_verified=1 WHERE id=?",
                                      (email, db_id(created["id"])))
        return self.service.repo.user(created["id"]), self.service.new_session(created["id"])

    def token(self):
        plain = self.mail.call_args.args[3]
        match = re.search(r"(?:#reset=|&token=|#activation=)([A-Za-z0-9_-]{43})", plain)
        self.assertIsNotNone(match)
        return match.group(1)

    def request_token(self, purpose, email=None, user=None, session=None):
        self.service.account_mail_request(purpose, email or self.user["email"], "review-ip", None,
                                         user or self.user, self.session if session is None else session)
        return self.token()

    def reset(self, token):
        return self.service.password_reset_confirmation({"token": token, "password": "new-password", "passwordConfirm": "new-password"})

    def assert_invalid(self, action):
        with self.assertRaises(BizError) as raised:
            action()
        self.assertIn(raised.exception.status, ("EMAIL_TOKEN_INVALID", "EMAIL_SESSION_MISMATCH", "AUTH_REQUIRED"))

    def advance_old_email(self):
        token = self.request_token("email-change-old")
        self.service.email_verification(self.user, self.session, {"token": token})
        return token

    def test_same_user_other_session_cannot_consume_old_email_token(self):
        token = self.request_token("email-change-old")
        other = self.service.new_session(self.user["id"])
        self.assert_invalid(lambda: self.service.email_verification(self.user, other, {"token": token}))
        self.assertEqual(self.service.email_verification(self.user, self.session, {"token": token})["stage"], "new-email")
        self.assert_invalid(lambda: self.service.email_verification(self.user, self.session, {"token": token}))

    def test_old_email_token_cannot_confirm_or_reset(self):
        token = self.request_token("email-change-old")
        self.assert_invalid(lambda: self.service.email_confirmation(self.user, self.session, {"token": token}))
        self.assert_invalid(lambda: self.reset(token))
        self.assertEqual(self.service.repo.user(self.user["id"])["email"], "owner@example.com")
        self.service.email_verification(self.user, self.session, {"token": token})

    def test_disable_then_reenable_never_resurrects_reset_token(self):
        token = self.request_token("password-reset")
        self.service.change_user(self.actor, {"id": self.user["id"], "isDisabled": True})
        self.service.change_user(self.actor, {"id": self.user["id"], "isDisabled": False})
        self.assert_invalid(lambda: self.reset(token))

    def test_admin_password_change_invalidates_email_token(self):
        token = self.request_token("email-change-old")
        self.service.change_user(self.actor, {"id": self.user["id"], "password": "replacement"})
        self.assert_invalid(lambda: self.service.email_verification(self.user, self.session, {"token": token}))

    def test_reset_confirmation_concurrency_consumes_once_and_revokes_sessions(self):
        token = self.request_token("password-reset")
        self.service.new_session(self.user["id"])
        def confirm():
            try:
                self.reset(token)
                return "ok"
            except BizError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(lambda _: confirm(), range(2)))
        self.assertEqual(sorted(outcomes), ["EMAIL_TOKEN_INVALID", "ok"])
        self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session WHERE user_id=?", (db_id(self.user["id"]),))["session_count"], 0)

    def test_confirm_email_invalidates_previous_reset_without_renaming_user(self):
        reset = self.request_token("password-reset")
        self.advance_old_email()
        replacement = self.request_token("email-change-new", "replacement@example.com")
        self.service.email_confirmation(self.user, self.session, {"token": replacement})
        current = self.service.repo.user(self.user["id"])
        self.assertEqual((current["email"], current["user_name"]), ("replacement@example.com", "review-user"))
        self.assert_invalid(lambda: self.reset(reset))
        self.assert_invalid(lambda: self.service.email_confirmation(self.user, self.session, {"token": replacement}))

    def test_binding_race_has_one_unique_verified_owner(self):
        first, first_session = self.make_user("binding-first")
        second, second_session = self.make_user("binding-second")
        one = self.request_token("email-binding", "shared@example.com", first, first_session)
        self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
        two = self.request_token("email-binding", "shared@example.com", second, second_session)
        def confirm(args):
            user, session, token = args
            try:
                self.service.email_confirmation(user, session, {"token": token})
                return "ok"
            except BizError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(confirm, [(first, first_session, one), (second, second_session, two)]))
        self.assertEqual(sorted(outcomes), ["EMAIL_EXISTS", "ok"])
        self.assertEqual(self.service.repo.one("SELECT count(*) AS user_count FROM sys_user WHERE email=? AND is_email_verified=1", ("shared@example.com",))["user_count"], 1)

    def test_reset_commit_failure_preserves_password_token_and_sessions(self):
        token = self.request_token("password-reset")
        before = self.service.repo.user(self.user["id"])["password_hash"]
        original = self.service.repo.connection
        @contextmanager
        def failing_commit():
            with original() as connection:
                yield connection
                if connection.in_transaction:
                    raise sqlite3.OperationalError("模拟提交失败")
        with mock.patch.object(self.service.repo, "connection", failing_commit):
            with self.assertRaises(sqlite3.OperationalError):
                self.reset(token)
        self.assertEqual(self.service.repo.user(self.user["id"])["password_hash"], before)
        self.assertEqual(self.service.authenticated(self.session)["id"], self.user["id"])
        self.reset(token)

    def test_reset_smtp_failure_does_not_reveal_email_existence(self):
        self.mail.side_effect = BizError(503, "MAIL_SEND_FAILED", "模拟邮件失败")
        for email in ("owner@example.com", "absent@example.com"):
            with self.subTest(email=email):
                self.assertEqual(self.service.password_reset_request({"email": email}, "review-ip"), {})
        self.assertTrue(password_valid("123456", self.service.repo.user(self.user["id"])["password_hash"]))

    def test_logout_during_smtp_does_not_activate_late_token(self):
        entered, release = threading.Event(), threading.Event()
        def waiting_send(*args):
            entered.set()
            if not release.wait(5):
                raise AssertionError("模拟发送等待超时")
        self.mail.side_effect = waiting_send
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.service.account_mail_request, "email-change-old", self.user["email"], "review-ip", None, self.user, self.session)
            self.assertTrue(entered.wait(2))
            try:
                self.service.repo.execute("DELETE FROM auth_session WHERE session_hash=?", (digest(self.session),))
            finally:
                release.set()
            try:
                future.result(timeout=5)
            except BizError as error:
                self.assertIn(error.status, ("AUTH_REQUIRED", "EMAIL_SESSION_MISMATCH", "EMAIL_TOKEN_INVALID"))
        row = self.service.repo.one("SELECT token_hash FROM account_email_token WHERE user_id=?", (db_id(self.user["id"]),))
        self.assertTrue(row is None or row["token_hash"] is None)

    def test_disable_reenable_during_smtp_cannot_restore_pending_token(self):
        entered, release = threading.Event(), threading.Event()
        def waiting_send(*args):
            entered.set()
            if not release.wait(5):
                raise AssertionError("模拟发送等待超时")
        self.mail.side_effect = waiting_send
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.service.password_reset_request, {"email": self.user["email"]}, "review-ip")
            self.assertTrue(entered.wait(2))
            try:
                self.service.change_user(self.actor, {"id": self.user["id"], "isDisabled": True})
                self.service.change_user(self.actor, {"id": self.user["id"], "isDisabled": False})
            finally:
                release.set()
            future.result(timeout=5)
        self.assert_invalid(lambda: self.reset(self.token()))

    def test_distinct_pending_emails_cannot_activate_same_username_twice(self):
        tokens = []
        for email in ("pending-one@example.com", "pending-two@example.com"):
            self.service.email_registration({"userName": "same-pending-name", "email": email}, "registration-ip")
            tokens.append(self.token())
        def activate(token):
            try:
                self.service.email_activation({"token": token, "password": "123456", "passwordConfirm": "123456"})
                return "ok"
            except BizError as error:
                return error.status
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(activate, tokens))
        self.assertEqual(outcomes.count("ok"), 1)
        self.assertEqual(self.service.repo.one("SELECT count(*) AS user_count FROM sys_user WHERE user_name=?", ("same-pending-name",))["user_count"], 1)

    def test_registration_and_binding_cannot_claim_same_email_twice(self):
        user, session = self.make_user("binding-versus-registration")
        binding = self.request_token("email-binding", "contested@example.com", user, session)
        self.service.email_registration({"userName": "register-contested", "email": "contested@example.com"}, "registration-ip")
        activation = self.token()
        self.service.email_activation({"token": activation, "password": "123456", "passwordConfirm": "123456"})
        with self.assertRaises(BizError) as raised:
            self.service.email_confirmation(user, session, {"token": binding})
        self.assertEqual(raised.exception.status, "EMAIL_EXISTS")
        self.assertIsNone(self.service.repo.user(user["id"])["email"])

    def test_late_smtp_cannot_overwrite_newer_reset_request(self):
        entered, release = threading.Event(), threading.Event()
        old_tokens = []
        def waiting_send(*args):
            if not entered.is_set():
                old_tokens.append(re.search(r"#reset=([A-Za-z0-9_-]{43})", args[3]).group(1))
                entered.set()
                if not release.wait(5):
                    raise AssertionError("模拟发送等待超时")
        self.mail.side_effect = waiting_send
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(self.service.password_reset_request, {"email": self.user["email"]}, "review-ip")
            self.assertTrue(entered.wait(2))
            try:
                self.service.repo.execute("UPDATE registration_attempt SET create_time=? WHERE id IS NOT NULL", (now_ms() - 61000,))
                self.service.password_reset_request({"email": self.user["email"]}, "review-ip")
                latest = self.token()
            finally:
                release.set()
            future.result(timeout=5)
        self.assert_invalid(lambda: self.reset(old_tokens[0]))
        self.reset(latest)

    def test_legacy_email_username_is_not_a_password_reset_identity(self):
        self.make_user("legacy@example.com")
        sent = self.mail.call_count
        self.assertEqual(self.service.password_reset_request({"email": "legacy@example.com"}, "legacy-ip"), {})
        self.assertEqual(self.mail.call_count, sent)
        self.assertIsNone(self.service.repo.user_by_name("legacy@example.com")["email"])

    def test_failed_new_email_send_preserves_verified_owner_and_retry_stage(self):
        self.advance_old_email()
        self.mail.side_effect = BizError(503, "MAIL_SEND_FAILED", "模拟邮件失败")
        with self.assertRaises(BizError) as raised:
            self.request_token("email-change-new", "failed-new@example.com")
        self.assertEqual(raised.exception.status, "MAIL_SEND_FAILED")
        current = self.service.repo.user(self.user["id"])
        self.assertEqual((current["email"], current["is_email_verified"]), ("owner@example.com", 1))
        state = self.service.email_detail(self.user, self.session)
        self.assertEqual(state["stage"], "new-email")
        self.assert_invalid(lambda: self.service.email_confirmation(self.user, self.session, {"token": self.token()}))

    def test_expired_reset_and_random_token_do_not_hash_password(self):
        token = self.request_token("password-reset")
        self.service.repo.execute("UPDATE account_email_token SET expire_time=? WHERE user_id=?", (now_ms() - 1, db_id(self.user["id"])))
        with mock.patch("backend.service.password_hash") as hashing:
            self.assert_invalid(lambda: self.reset(token))
            self.assert_invalid(lambda: self.reset("z" * 43))
            hashing.assert_not_called()

    def test_stale_password_login_cannot_create_session_after_reset(self):
        token = self.request_token("password-reset")
        entered, release = threading.Event(), threading.Event()
        original = password_valid
        def waiting_verify(password, hashed):
            valid = original(password, hashed)
            if password == "123456":
                entered.set()
                if not release.wait(5):
                    raise AssertionError("模拟验密等待超时")
            return valid
        with mock.patch("backend.service.password_valid", side_effect=waiting_verify):
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.service.login, {"userName": self.user["user_name"], "password": "123456"}, "login-ip")
                self.assertTrue(entered.wait(2))
                try:
                    self.reset(token)
                finally:
                    release.set()
                with self.assertRaises(BizError):
                    future.result(timeout=5)
        self.assertEqual(self.service.repo.one("SELECT count(*) AS session_count FROM auth_session WHERE user_id=?", (db_id(self.user["id"]),))["session_count"], 0)


if __name__ == "__main__":
    unittest.main()
