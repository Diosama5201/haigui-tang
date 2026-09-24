@echo off
chcp 65001 >nul
cd /d "%~dp0"

rem ============================================
rem  服务器地址与 SSH 密钥路径不写在本文件里，
rem  而是放在 deploy.local.bat 中（已被 .gitignore 忽略，不会上传仓库）。
rem  首次使用：复制 deploy.local.bat.example 为 deploy.local.bat 并填写。
rem ============================================
if not exist "deploy.local.bat" (
  echo [ERROR] 找不到 deploy.local.bat
  echo         请复制 deploy.local.bat.example 为 deploy.local.bat，
  echo         填入你的 KEY 与 HOST 后重新运行本脚本。
  echo.
  pause
  exit /b 1
)
call "deploy.local.bat"

if "%KEY%"=="" (
  echo [ERROR] deploy.local.bat 中未设置 KEY
  echo.
  pause
  exit /b 1
)
if "%HOST%"=="" (
  echo [ERROR] deploy.local.bat 中未设置 HOST
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
scp %SSHOPT% "server.js" "vector-store.js" "progress-utils.js" "offline-engine.js" "package.json" "package-lock.json" "%HOST%:C:/haigui/"
if errorlevel 1 goto fail

echo.
echo [2/4] Uploading frontend (public/) ...
ssh %SSHOPT% "%HOST%" "rmdir /s /q C:\haigui\public" >nul 2>&1
scp %SSHOPT% -r "public" "%HOST%:C:/haigui/"
if errorlevel 1 goto fail

echo.
echo [3/4] Installing dependencies on server ...
ssh %SSHOPT% "%HOST%" "cd /d C:\haigui && npm install --omit=dev --no-audit --no-fund"
if errorlevel 1 goto fail

echo.
echo [4/4] Restarting website ...
ssh %SSHOPT% "%HOST%" "pm2 restart haigui"

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
