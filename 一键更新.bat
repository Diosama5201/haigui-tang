@echo off
setlocal
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem  Tools are called by ABSOLUTE PATH on purpose.
rem  A broken/misconfigured PATH must not be able to break deployment.
rem ------------------------------------------------------------------
set "SYS=%SystemRoot%\System32"
set "SCPEXE=%SYS%\OpenSSH\scp.exe"
set "SSHEXE=%SYS%\OpenSSH\ssh.exe"

if not exist "%SCPEXE%" (
  echo [ERROR] scp.exe not found at %SCPEXE%
  echo         Windows "OpenSSH Client" feature may be missing.
  echo         Fix: Settings ^> Apps ^> Optional features ^> Add ^> OpenSSH Client
  echo.
  pause
  exit /b 1
)

rem ------------------------------------------------------------------
rem  Server address and SSH key path live in deploy.local.bat
rem  (gitignored, never uploaded to the repository).
rem  First time: copy deploy.local.bat.example to deploy.local.bat and fill it in.
rem ------------------------------------------------------------------
if not exist "deploy.local.bat" (
  echo [ERROR] deploy.local.bat not found.
  echo         Copy deploy.local.bat.example to deploy.local.bat,
  echo         fill in KEY and HOST, then run this script again.
  echo.
  pause
  exit /b 1
)
call "deploy.local.bat"

if "%KEY%"=="" (
  echo [ERROR] KEY is not set in deploy.local.bat
  echo.
  pause
  exit /b 1
)
if "%HOST%"=="" (
  echo [ERROR] HOST is not set in deploy.local.bat
  echo.
  pause
  exit /b 1
)

set SSHOPT=-i "%KEY%" -o StrictHostKeyChecking=no

echo ============================================
echo   Haigui-Tang Website  -  One-Click Deploy
echo ============================================
echo.

echo [1/4] Uploading backend (server.js, vector-store.js, progress-utils.js, offline-engine.js, package.json) ...
"%SCPEXE%" %SSHOPT% "server.js" "vector-store.js" "progress-utils.js" "offline-engine.js" "package.json" "package-lock.json" "%HOST%:C:/haigui/"
if errorlevel 1 goto fail

echo.
echo [2/4] Uploading frontend (public/) ...
"%SSHEXE%" %SSHOPT% "%HOST%" "rmdir /s /q C:\haigui\public" >nul 2>&1
"%SCPEXE%" %SSHOPT% -r "public" "%HOST%:C:/haigui/"
if errorlevel 1 goto fail

echo.
echo [3/4] Installing dependencies on server ...
"%SSHEXE%" %SSHOPT% "%HOST%" "cd /d C:\haigui && npm install --omit=dev --no-audit --no-fund"
if errorlevel 1 goto fail

echo.
echo [4/4] Restarting website ...
"%SSHEXE%" %SSHOPT% "%HOST%" "pm2 restart haigui"

echo.
echo ============================================
echo   DONE!  Deployed to %HOST%
echo ============================================
echo.
pause
exit /b 0

:fail
echo.
echo *** DEPLOY FAILED - send the error above to your assistant ***
echo.
pause
exit /b 1
