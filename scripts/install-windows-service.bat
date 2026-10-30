@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "SERVICE_NAME=babaShare"
set "SERVICE_DISPLAY=babaShare Prototype Sharing"
for %%I in ("%~dp0..") do set "PROJECT_DIR=%%~fI"
set "NSSM_EXE=%~dp0tools\nssm.exe"
if not defined BABA_SHARE_DATA_DIR set "BABA_SHARE_DATA_DIR=%ProgramData%\babaShare\data"
if not defined BABA_SHARE_HOST set "BABA_SHARE_HOST=0.0.0.0"
if not defined BABA_SHARE_PORT set "BABA_SHARE_PORT=8080"
if not defined BABA_SHARE_PUBLIC_ORIGIN set "BABA_SHARE_PUBLIC_ORIGIN="
if not defined BABA_SHARE_SECURE_COOKIE set "BABA_SHARE_SECURE_COOKIE=0"
set "PYTHON_EXE=%BABA_SHARE_PYTHON%"

powershell.exe -NoProfile -NonInteractive -Command "$p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent(); if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }"
if errorlevel 1 (
  echo ERROR: Run this file from an elevated administrator terminal.
  exit /b 1
)
if not exist "%PROJECT_DIR%\server.py" (
  echo ERROR: server.py was not found beside the scripts directory.
  exit /b 1
)
if not exist "%NSSM_EXE%" (
  echo ERROR: NSSM was not found at "%NSSM_EXE%".
  echo Manually obtain and verify the 64-bit binary from https://nssm.cc/download.
  echo Place it in scripts\tools\nssm.exe. Nothing will be downloaded automatically.
  exit /b 1
)
sc.exe query "%SERVICE_NAME%" >nul 2>&1
if not errorlevel 1 (
  echo ERROR: Service "%SERVICE_NAME%" already exists. No settings were changed.
  exit /b 1
)

if defined PYTHON_EXE goto :python_found
for /f "usebackq delims=" %%I in (`py -3 -c "import sys,sqlite3; sys.exit(1) if sys.version_info < (3,12) else print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
if defined PYTHON_EXE goto :python_found
for /f "usebackq delims=" %%I in (`python -c "import sys,sqlite3; sys.exit(1) if sys.version_info < (3,12) else print(sys.executable)" 2^>nul`) do set "PYTHON_EXE=%%I"
:python_found
if not defined PYTHON_EXE (
  echo ERROR: Python 3.12+ with sqlite3 was not found.
  echo Install an all-users Python or set BABA_SHARE_PYTHON to its absolute python.exe path.
  exit /b 1
)
"%PYTHON_EXE%" -c "import sys,sqlite3; assert sys.version_info >= (3,12); print('Python and SQLite check passed.')"
if errorlevel 1 exit /b 1

set "BABA_SHARE_INSTALL_PROJECT=%PROJECT_DIR%"
set "BABA_SHARE_INSTALL_PYTHON=%PYTHON_EXE%"
set "BABA_SHARE_INSTALL_NSSM=%NSSM_EXE%"
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { foreach ($p in @($env:BABA_SHARE_INSTALL_PROJECT,$env:BABA_SHARE_INSTALL_PYTHON,$env:BABA_SHARE_INSTALL_NSSM,$env:BABA_SHARE_DATA_DIR)) { if (-not [IO.Path]::IsPathRooted($p) -or $p.StartsWith('\\') -or $p -notmatch '^[A-Za-z]:[\\/]') { throw 'Use absolute local drive paths, not relative or network paths.' }; if ($p -match '[\x00-\x1f\x22]') { throw 'Paths must not contain quotes or control characters.' } }; if ($env:BABA_SHARE_INSTALL_PYTHON -match '[\\/]WindowsApps[\\/]|[\\/]Users[\\/]' -or $env:BABA_SHARE_INSTALL_PROJECT -match '[\\/]Users[\\/]') { throw 'Use an all-users Python and machine-level project directory, not a user profile or Store alias.' }; $port=0; if (-not [int]::TryParse($env:BABA_SHARE_PORT,[ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'Invalid BABA_SHARE_PORT.' }; if ($env:BABA_SHARE_HOST -notmatch '^[A-Za-z0-9.-]+$') { throw 'Invalid BABA_SHARE_HOST.' }; if ($env:BABA_SHARE_PUBLIC_ORIGIN -and $env:BABA_SHARE_PUBLIC_ORIGIN -notmatch '^https?://[A-Za-z0-9.-]+(:[0-9]+)?$') { throw 'Invalid BABA_SHARE_PUBLIC_ORIGIN.' }; if ($env:BABA_SHARE_SECURE_COOKIE -notmatch '^[01]$') { throw 'Invalid BABA_SHARE_SECURE_COOKIE.' } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
if errorlevel 1 exit /b 1

echo This installs a LocalService service and initializes or migrates the database.
echo Data directory: "%BABA_SHARE_DATA_DIR%"
echo Code, Python, and NSSM must be readable and executable by LocalService.
echo Existing data requires a verified full backup and private ACLs. See DEPLOYMENT.md.
echo Installation authorizes creation of a private data directory if it does not exist.
choice /C YN /N /M "Continue with service installation and database check? [Y/N] "
if errorlevel 2 exit /b 1

powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { $root=$env:BABA_SHARE_DATA_DIR; $allowed=@('S-1-5-18','S-1-5-32-544','S-1-5-19'); if (-not (Test-Path -LiteralPath $root)) { $acl=New-Object Security.AccessControl.DirectorySecurity; $acl.SetAccessRuleProtection($true,$false); foreach ($sid in $allowed) { $rights=if ($sid -eq 'S-1-5-19') {'Modify'} else {'FullControl'}; $identity=New-Object Security.Principal.SecurityIdentifier($sid); $rule=New-Object Security.AccessControl.FileSystemAccessRule($identity,$rights,'ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule) }; [IO.Directory]::CreateDirectory($root,$acl) | Out-Null }; $item=Get-Item -LiteralPath $root -Force; if (-not $item.PSIsContainer) { throw 'Data root must be a directory.' }; $pending=New-Object 'Collections.Generic.Stack[string]'; $pending.Push($item.FullName); while ($pending.Count) { $path=$pending.Pop(); $entry=Get-Item -LiteralPath $path -Force; if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse points in data are not supported by this installer.' }; $current=Get-Acl -LiteralPath $path; foreach ($ace in $current.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) { if ($ace.AccessControlType -eq 'Allow' -and $allowed -notcontains $ace.IdentityReference.Value) { throw 'Existing data ACL permits another identity. Review privately; the installer will not rewrite it.' } }; if ($path -eq $item.FullName) { if (-not $current.AreAccessRulesProtected) { throw 'Existing data root must have inheritance disabled.' }; $service=@($current.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]) | Where-Object { $_.IdentityReference.Value -eq 'S-1-5-19' -and $_.AccessControlType -eq 'Allow' -and ($_.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Modify) -eq [Security.AccessControl.FileSystemRights]::Modify }); if (-not $service.Count) { throw 'LocalService requires Modify permission on the private data root.' } }; if ($entry.PSIsContainer) { foreach ($child in Get-ChildItem -LiteralPath $path -Force) { $pending.Push($child.FullName) } } }; New-Item -ItemType Directory -Path (Join-Path $root 'logs') -Force | Out-Null } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
if errorlevel 1 (
  echo ERROR: Private data directory creation or ACL audit failed. No service was installed.
  exit /b 1
)
set "LOG_DIR=%BABA_SHARE_DATA_DIR%\logs"
"%PYTHON_EXE%" -B "%PROJECT_DIR%\server.py" --check
if errorlevel 1 (
  echo ERROR: Startup check failed. Data was preserved. No service was installed.
  exit /b 1
)

"%NSSM_EXE%" install "%SERVICE_NAME%" "%PYTHON_EXE%"
if errorlevel 1 (
  echo ERROR: NSSM registration failed. Inspect SCM before retrying; no existing service will be removed.
  exit /b 1
)
"%NSSM_EXE%" set "%SERVICE_NAME%" AppDirectory "%PROJECT_DIR%"
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppParameters "-B -u server.py"
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" DisplayName "%SERVICE_DISPLAY%"
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" Start SERVICE_AUTO_START
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" ObjectName "NT AUTHORITY\LocalService"
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppEnvironmentExtra "BABA_SHARE_DATA_DIR=%BABA_SHARE_DATA_DIR%" "BABA_SHARE_HOST=%BABA_SHARE_HOST%" "BABA_SHARE_PORT=%BABA_SHARE_PORT%" "BABA_SHARE_PUBLIC_ORIGIN=%BABA_SHARE_PUBLIC_ORIGIN%" "BABA_SHARE_SECURE_COOKIE=%BABA_SHARE_SECURE_COOKIE%" "PYTHONDONTWRITEBYTECODE=1" "PYTHONUNBUFFERED=1"
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStdout "%LOG_DIR%\stdout.log"
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStderr "%LOG_DIR%\stderr.log"
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateFiles 1
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateOnline 1
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateBytes 10485760
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRotateSeconds 86400
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppExit Default Restart
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppRestartDelay 5000
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppStopMethodConsole 15000
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" set "%SERVICE_NAME%" AppKillProcessTree 1
if errorlevel 1 goto :configure_failed
"%NSSM_EXE%" start "%SERVICE_NAME%"
if errorlevel 1 goto :configure_failed
powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.ServiceProcess; $service=Get-Service -Name 'babaShare'; $service.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Running,[TimeSpan]::FromSeconds(15)) } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
if errorlevel 1 goto :configure_failed
"%PYTHON_EXE%" -B -c "import http.client,os; from urllib.parse import urlsplit; host=os.environ['BABA_SHARE_HOST']; host='127.0.0.1' if host=='0.0.0.0' else host; port=int(os.environ['BABA_SHARE_PORT']); origin=os.environ.get('BABA_SHARE_PUBLIC_ORIGIN') or 'http://'+host+':'+str(port); c=http.client.HTTPConnection(host,port,timeout=5); c.request('GET','/baba-share/',headers={'Host':urlsplit(origin).netloc}); r=c.getresponse(); assert r.status==200 and r.getheader('Server','').startswith('babaShare'), 'Service HTTP check failed'; r.read(); c.close()"
if errorlevel 1 (
  echo ERROR: Service is registered, but HTTP readiness was not confirmed.
  echo The service registration was preserved because NSSM Running does not mean Python is ready.
  echo Inspect "%LOG_DIR%" and Event Viewer; verify the page after initialization completes.
  echo Do not rerun installation over this service. Diagnose it or explicitly uninstall it first.
  exit /b 1
)

echo.
echo babaShare service was installed and started as LocalService.
echo Project directory: "%PROJECT_DIR%"
echo Data and logs: "%BABA_SHARE_DATA_DIR%"
echo Listening address: %BABA_SHARE_HOST%:%BABA_SHARE_PORT%
echo 0.0.0.0 is a bind address, not a browser or public link address.
echo Use localhost or the actual server IP/domain. Firewall rules are not changed.
echo Open the configured public origin with /baba-share/ appended.
echo Verify login, preview sandbox, and persistence in your browser before production use.
echo Uninstall with scripts\uninstall-windows-service.bat to preserve all data.
exit /b 0

:configure_failed
echo ERROR: Service registration, configuration, or startup failed.
echo Rolling back only this new service registration. Data and logs will remain.
"%NSSM_EXE%" stop "%SERVICE_NAME%" >nul 2>&1
"%NSSM_EXE%" remove "%SERVICE_NAME%" confirm >nul 2>&1
if errorlevel 1 echo WARNING: Rollback failed. Inspect the babaShare service manually before retrying.
echo Review Windows Event Viewer and "%LOG_DIR%". No data was deleted.
exit /b 1
