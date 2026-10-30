@echo off
setlocal EnableExtensions DisableDelayedExpansion

set "SERVICE_NAME=babaShare"
set "NSSM_EXE=%~dp0tools\nssm.exe"

powershell.exe -NoProfile -NonInteractive -Command "$p = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent(); if (-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }"
if errorlevel 1 (
  echo ERROR: Run this file from an elevated administrator terminal.
  exit /b 1
)
sc.exe query "%SERVICE_NAME%" >nul 2>&1
if errorlevel 1 (
  echo Service "%SERVICE_NAME%" is not installed. Nothing was removed.
  exit /b 0
)
if not exist "%NSSM_EXE%" (
  echo ERROR: NSSM was not found at "%NSSM_EXE%".
  echo Restore the verified NSSM binary used during installation. No service was changed.
  exit /b 1
)
choice /C YN /N /M "Stop and remove the babaShare service registration only? [Y/N] "
if errorlevel 2 exit /b 1

powershell.exe -NoProfile -NonInteractive -Command "$ErrorActionPreference='Stop'; try { Add-Type -AssemblyName System.ServiceProcess; $s=Get-Service -Name 'babaShare'; if ($s.Status -ne 'Stopped') { if ($s.Status -ne 'StopPending') { Stop-Service -InputObject $s -ErrorAction Stop }; $s.WaitForStatus([ServiceProcess.ServiceControllerStatus]::Stopped,[TimeSpan]::FromSeconds(30)) } } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
if errorlevel 1 (
  echo ERROR: The service did not stop cleanly. It was not removed.
  echo Inspect Event Viewer and service state. No data was changed.
  exit /b 1
)
"%NSSM_EXE%" remove "%SERVICE_NAME%" confirm
if errorlevel 1 (
  echo ERROR: Service removal failed. Data was not changed.
  exit /b 1
)

echo.
echo babaShare Windows service registration was removed.
echo Application files, configuration, logs, database, uploaded files, and MCP master were preserved.
echo The default data directory remains: "%ProgramData%\babaShare\data"
echo Any custom data directory and all existing ACLs were also preserved.
echo Back up or remove files manually only after reviewing them and obtaining authorization.
exit /b 0
