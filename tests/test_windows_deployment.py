"""部署材料静态回归与PowerShell解析，不注册或卸载真实服务。"""
import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WindowsDeploymentTests(unittest.TestCase):
    def setUp(self):
        self.install = (ROOT / "scripts/install-windows-service.bat").read_text(encoding="ascii")
        self.uninstall = (ROOT / "scripts/uninstall-windows-service.bat").read_text(encoding="ascii")

    def test_bat_is_ascii_and_avoids_temp_files_and_delayed_expansion(self):
        for text in (self.install, self.uninstall):
            self.assertIn("DisableDelayedExpansion", text)
            self.assertNotIn("%TEMP%", text)
            self.assertLess(max(map(len, text.splitlines())), 8191)
            self.assertNotRegex(text.lower(), r"\b(?:curl|wget|invoke-webrequest)\b")

    def test_default_bind_is_wildcard_and_explicit_host_override_is_preserved(self):
        self.assertIn('if not defined BABA_SHARE_HOST set "BABA_SHARE_HOST=0.0.0.0"', self.install)
        self.assertIn('"BABA_SHARE_HOST=%BABA_SHARE_HOST%"', self.install)
        self.assertIn("host='127.0.0.1' if host=='0.0.0.0' else host", self.install)
        env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertRegex(env_example, r"(?m)^BABA_SHARE_HOST=0\.0\.0\.0$")
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertIn("BABA_SHARE_HOST: 0.0.0.0", compose)
        self.assertIn("${BABA_SHARE_PUBLISH_IP:-0.0.0.0}", compose)
        self.assertIn("http://127.0.0.1:${BABA_SHARE_PUBLISH_PORT:-8080}", compose)
        for relative in ("README.md", "DEPLOYMENT.md"):
            with self.subTest(document=relative):
                doc = (ROOT / relative).read_text(encoding="utf-8")
                self.assertIn("| `BABA_SHARE_HOST` | `0.0.0.0` |", doc)
                self.assertIn("不是浏览器访问地址或外部链接地址", doc)
                self.assertIn("不会自动放行防火墙", doc)
                self.assertIn("BABA_SHARE_PUBLISH_IP=127.0.0.1", doc)

    def test_python_discovery_accepts_newer_versions_and_paths_with_spaces(self):
        self.assertIn('set "PYTHON_EXE=%BABA_SHARE_PYTHON%"', self.install)
        self.assertIn("py -3 -c", self.install)
        self.assertNotIn("py -3.12", self.install)
        self.assertIn("sys.version_info < (3,12)", self.install)
        self.assertIn('"%PYTHON_EXE%" -B "%PROJECT_DIR%\\server.py" --check', self.install)
        self.assertIn('AppParameters "-B -u server.py"', self.install)
        self.assertIn("all-users Python", self.install)

    def test_service_is_low_privilege_with_private_data_and_rotated_logs(self):
        self.assertIn("%ProgramData%\\babaShare\\data", self.install)
        self.assertIn('ObjectName "NT AUTHORITY\\LocalService"', self.install)
        for setting in ("AppStdout", "AppStderr", "AppRotateFiles 1", "AppRotateOnline 1",
                        "AppRotateBytes 10485760", "AppRotateSeconds 86400",
                        "AppRestartDelay 5000", "AppStopMethodConsole 15000"):
            self.assertIn(setting, self.install)
        for token in ("SetAccessRuleProtection($true,$false)", "S-1-5-18", "S-1-5-32-544",
                      "S-1-5-19", "ReparsePoint", "AreAccessRulesProtected"):
            self.assertIn(token, self.install)
        self.assertNotIn("/grant", self.install)
        self.assertNotIn("Set-Acl", self.install)
        self.assertIn("GetAccessRules($true,$true", self.install)

    def test_rollback_only_after_successful_registration_and_preserves_data(self):
        install_index = self.install.index('install "%SERVICE_NAME%" "%PYTHON_EXE%"')
        configure_index = self.install.index('set "%SERVICE_NAME%" AppDirectory')
        self.assertNotIn("goto :configure_failed", self.install[install_index:configure_index])
        self.assertIn(":configure_failed", self.install)
        self.assertIn('remove "%SERVICE_NAME%" confirm', self.install)
        for text in (self.install, self.uninstall):
            self.assertNotRegex(text.lower(), r"\b(?:del|erase|rmdir|rd|remove-item)\b")
        self.assertIn("Rollback failed", self.install)
        http_index = self.install.index("import http.client,os;")
        readiness_end = self.install.index("echo babaShare service was installed", http_index)
        readiness_branch = self.install[http_index:readiness_end]
        self.assertIn("Service is registered, but HTTP readiness was not confirmed", readiness_branch)
        self.assertIn("registration was preserved", readiness_branch)
        self.assertNotIn("goto :configure_failed", readiness_branch)
        self.assertNotIn('remove "%SERVICE_NAME%"', readiness_branch)

    def test_uninstall_handles_absent_and_already_stopped_service(self):
        self.assertLess(self.uninstall.index('sc.exe query'), self.uninstall.index('if not exist "%NSSM_EXE%"'))
        self.assertIn("Nothing was removed", self.uninstall)
        self.assertIn("if ($s.Status -ne 'Stopped')", self.uninstall)
        self.assertIn("StopPending", self.uninstall)
        self.assertIn("WaitForStatus", self.uninstall)
        self.assertIn("FromSeconds(30)", self.uninstall)
        self.assertLess(self.uninstall.index("The service did not stop cleanly"), self.uninstall.index('remove "%SERVICE_NAME%"'))

    def test_deployment_has_only_one_port_and_no_preview_environment(self):
        for relative in ("Dockerfile", "compose.yaml", ".env.example", "DEPLOYMENT.md", "MCP-README.md",
                         "scripts/install-windows-service.bat", "scripts/uninstall-windows-service.bat"):
            with self.subTest(file=relative):
                text = (ROOT / relative).read_text(encoding="utf-8")
                self.assertNotIn("8081", text)
                self.assertNotRegex(text, r"(?:BABA_SHARE|PRODUCT_SHARE)_PREVIEW_")
                self.assertNotIn("PRODUCT_SHARE_*", text)
        self.assertNotIn("::Sleep", self.install)
        self.assertIn("WaitForStatus", self.install)
        env_example = (ROOT / ".env.example").read_text(encoding="utf-8")
        self.assertIn("安全阻断", env_example)
        self.assertNotIn("继续使用旧库", env_example)
        docker = (ROOT / "Dockerfile").read_text(encoding="utf-8")
        compose = (ROOT / "compose.yaml").read_text(encoding="utf-8")
        self.assertEqual(re.findall(r"^EXPOSE (.+)$", docker, re.M), ["8080"])
        self.assertIn("r.status==200", docker)
        self.assertIn("http://127.0.0.1:${BABA_SHARE_PUBLISH_PORT:-8080}", compose)
        self.assertEqual(len(re.findall(r'^      - "\$\{BABA_SHARE_PUBLISH_IP', compose, re.M)), 1)
        self.assertIn("baba-share-data:/var/lib/baba-share", compose)

    def test_documents_explain_sandbox_backup_and_no_scm_claim(self):
        doc = (ROOT / "DEPLOYMENT.md").read_text(encoding="utf-8")
        for word in ("opaque origin", "allow-same-origin", "mcp-key-master", "--check", "不是只读",
                     "SCM", "未做", "进程环境变量优先", "项目根目录", "不自动删除", "绝不删除数据"):
            self.assertIn(word, doc)

    @unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "需要Windows PowerShell语法解析器")
    def test_embedded_powershell_parses_without_executing_service_commands(self):
        commands = []
        for text in (self.install, self.uninstall):
            commands.extend(re.findall(r'^powershell\.exe .*? -Command "(.*)"$', text, re.M))
        self.assertGreaterEqual(len(commands), 6)
        parser = "$tokens=$null; $errors=$null; [Management.Automation.Language.Parser]::ParseInput($env:BABA_TEST_PS,[ref]$tokens,[ref]$errors) | Out-Null; if ($errors.Count) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }"
        for index, command in enumerate(commands):
            with self.subTest(command=index):
                result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", parser],
                                        env={**os.environ, "BABA_TEST_PS": command}, capture_output=True, text=True, errors="replace", timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)

    @unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "需要Windows PowerShell模拟运行")
    def test_uninstall_stop_logic_with_mocked_service_only(self):
        command = re.search(r'^powershell\.exe .*? -Command "(.*Get-Service -Name.*)"$', self.uninstall, re.M).group(1)
        for state, stop_count, wait_count in (("Stopped", 0, 0), ("Running", 1, 1), ("StopPending", 0, 1)):
            with self.subTest(state=state):
                prelude = "$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.ServiceProcess; $script:stops=0; $script:waits=0; "
                prelude += "$script:fake=[pscustomobject]@{Status=$env:BABA_TEST_STATE}; "
                prelude += "$script:fake | Add-Member -MemberType ScriptMethod -Name WaitForStatus -Value { param($status,$timeout) $script:waits++ }; "
                prelude += "function Get-Service { param($Name) return $script:fake }; function Stop-Service { param($InputObject) $script:stops++ }; "
                result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command",
                                         prelude + command + "; @{stops=$script:stops; waits=$script:waits} | ConvertTo-Json -Compress"],
                                        env={**os.environ, "BABA_TEST_STATE": state}, capture_output=True, text=True, errors="replace", timeout=20)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout), {"stops": stop_count, "waits": wait_count})

    @unittest.skipUnless(os.name == "nt" and shutil.which("powershell.exe"), "需要Windows ACL类型")
    def test_private_acl_constructor_uses_only_expected_sids_in_memory(self):
        match = re.search(r"(\$acl=New-Object Security.AccessControl.DirectorySecurity;.*?); \[IO.Directory\]::CreateDirectory", self.install)
        self.assertIsNotNone(match)
        command = "$ErrorActionPreference='Stop'; $allowed=@('S-1-5-18','S-1-5-32-544','S-1-5-19'); " + match.group(1)
        command += "; @($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value }) | ConvertTo-Json -Compress"
        result = subprocess.run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                                capture_output=True, text=True, errors="replace", timeout=20)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(json.loads(result.stdout)), {"S-1-5-18", "S-1-5-32-544", "S-1-5-19"})


if __name__ == "__main__":
    unittest.main()
