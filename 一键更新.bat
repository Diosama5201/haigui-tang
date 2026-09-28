@echo off
setlocal
cd /d "%~dp0"

rem ------------------------------------------------------------------
rem  KEEP THIS FILE PURE ASCII. No Chinese, no emoji, not even in comments.
rem  cmd.exe reads .bat files using the system ANSI codepage (GBK on a
rem  Chinese Windows). UTF-8 text gets mis-decoded, and the garbage bytes
rem  can spawn bogus commands (observed: "'t' is not recognized as an
rem  internal or external command" from a Chinese rem line).
rem  Verified 2026-09-28: this file contains zero non-ASCII bytes.
rem ------------------------------------------------------------------

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

rem ------------------------------------------------------------------
rem  [1/5] Best-effort backup of the current server.js on the server.
rem  If the new code crash-loops, roll back by copying the backup back
rem  and restarting:
rem    ssh -i "KEY" HOST "copy /Y C:\haigui\_bak\server.js.bak C:\haigui\server.js"
rem    ssh -i "KEY" HOST "pm2 restart haigui"
rem  (Two separate commands on purpose: an ampersand inside a rem line is
rem   NOT commented out - cmd splits the line and runs the tail.)
rem ------------------------------------------------------------------
echo [1/5] Backing up the live server.js (best effort) ...
"%SSHEXE%" %SSHOPT% "%HOST%" "if not exist C:\haigui\_bak (mkdir C:\haigui\_bak) & copy /Y C:\haigui\server.js C:\haigui\_bak\server.js.bak >nul 2>&1"

rem ------------------------------------------------------------------
rem  [2/5] Upload EVERY root-level .js / .json file.
rem
rem  DO NOT go back to a hand-written file list. That is exactly how the
rem  2026-09-28 outage happened: server.js began requiring ./knowledge-base,
rem  but the list still only contained the OLD modules, so the process died
rem  with MODULE_NOT_FOUND on boot and pm2 crash-looped (36 restarts).
rem  A glob cannot forget a new module.
rem
rem  Note: keep throwaway debug scripts OUT of the project root, or they
rem  will be uploaded too (harmless, but messy). Put them in tools\.
rem ------------------------------------------------------------------
echo.
echo [2/5] Uploading backend (all root-level *.js + *.json) ...
set "BACKEND="
for %%F in (*.js *.json) do call set "BACKEND=%%BACKEND%% %%F"
if "%BACKEND%"=="" (
  echo [ERROR] No root-level .js / .json found.
  echo         Run this script from the project root directory.
  echo.
  pause
  exit /b 1
)
echo       files: %BACKEND%
"%SCPEXE%" %SSHOPT% %BACKEND% "%HOST%:C:/haigui/"
if errorlevel 1 goto fail
"%SCPEXE%" %SSHOPT% -r "annotations" "seed" "tools" "%HOST%:C:/haigui/"
if errorlevel 1 goto fail

echo.
echo [3/5] Uploading frontend (public/) ...
"%SSHEXE%" %SSHOPT% "%HOST%" "rmdir /s /q C:\haigui\public" >nul 2>&1
"%SCPEXE%" %SSHOPT% -r "public" "%HOST%:C:/haigui/"
if errorlevel 1 goto fail

echo.
echo [4/5] Installing dependencies on server ...
"%SSHEXE%" %SSHOPT% "%HOST%" "cd /d C:\haigui && npm install --omit=dev --no-audit --no-fund"
if errorlevel 1 goto fail

echo.
echo [5/5] Restarting website and checking health ...
"%SSHEXE%" %SSHOPT% "%HOST%" "pm2 restart haigui"
if errorlevel 1 goto fail

timeout /t 4 /nobreak >nul
"%SSHEXE%" %SSHOPT% "%HOST%" "curl -s http://127.0.0.1:3000/healthz & echo. & pm2 list"

echo.
echo ============================================
echo   DONE!  Deployed to %HOST%
echo ============================================
echo.
echo   MANUAL CHECK - both of these must hold:
echo     1. healthz line above contains  "status":"ok"
echo     2. pm2 status is  online  (not  errored ), and the  restart  count
echo        did NOT keep climbing between two runs of "pm2 list"
echo.
echo   If pm2 shows errored / a climbing restart count, read the logs:
echo     ssh -i "%KEY%" %HOST% "pm2 logs haigui --lines 50 --nostream"
echo   Most likely cause: server.js requires a file that is not in the
echo   project root, or a new npm dependency is missing from package.json.
echo.
pause
exit /b 0

:fail
echo.
echo *** DEPLOY FAILED - send the error above to your assistant ***
echo.
pause
exit /b 1
