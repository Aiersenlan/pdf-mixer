@echo off
chcp 65001 >nul
cd /d "%~dp0"

where python >nul 2>nul
if %errorlevel%==0 (
  python serve.py %*
) else (
  echo 未偵測到 Python，改用內建的 PowerShell 伺服器啟動…
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" %*
)

if errorlevel 1 (
  echo.
  echo 啟動失敗。
  pause
)
