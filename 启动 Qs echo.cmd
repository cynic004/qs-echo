@echo off
setlocal
chcp 65001 >nul
title Q's echo
cd /d "%~dp0"
if exist "%~dp0runtime\node.exe" goto bundled
where node.exe >nul 2>nul
if errorlevel 1 (
  echo 请先解压 Qs-echo-Windows-x64.zip，再打开解压后文件夹里的启动文件。
  pause
  exit /b 1
)
node.exe "%~dp0server.mjs" --open
goto status
:bundled
"%~dp0runtime\node.exe" "%~dp0server.mjs" --open
:status
if errorlevel 1 pause
