@echo off
setlocal
chcp 65001 >nul
title Q's echo - 安装本机语音识别
cd /d "%~dp0"
echo 正在安装本机语音识别。首次约需下载 103 MB，请保持网络连接。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\install-voice.ps1"
if errorlevel 1 (
  echo 安装未完成。请检查网络连接后重试。
) else (
  echo 安装完成。回到 Q's echo 页面，即可选择一段语音开始识别。
)
pause
