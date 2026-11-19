# 参与维护

在 [GitHub Issues](https://github.com/cynic004/qs-echo/issues) 提交问题时，请附版本号、Windows 与浏览器版本、最短复现步骤，以及预期和实际结果。导入问题优先用合成的 `.txt` 或 `.zip` 复现。问题报告里请移除真实聊天记录、语音、电话号码和 API 密钥。安全相关问题请按 [安全报告说明](SECURITY.md) 私下反馈。

## 提交变更

1. 按 [README](README.md#从源码运行) 准备本机环境。运行 `node --test` 验证导入、语音与 HTTP 工作流。
2. 用示例数据从启动界面走完受影响的步骤。改动 Windows 启动或打包时，解压生成的 ZIP 再验证一次。
3. 在 Pull Request 中列出行为变化、测试结果与已知限制。涉及数据出站时，注明数据类型和目的地。

## 发布步骤

1. 确认 CI 通过。在 `CHANGELOG.md` 记录用户可见变化和本次验证范围。
2. 根据 [README](README.md#构建-windows-发布包) 构建安装包。在干净目录解包，检查启动、示例、提醒和受影响的功能。
3. 从验证过的提交创建 `v<版本号>` 标签。将便携 ZIP 和对应的 SHA-256 校验值上传到 GitHub Release。如需计算校验值，在 PowerShell 使用 `Get-FileHash`。
4. 以未登录访客的视角检查 Release 页、下载链接和版本记录。处理回归时发布新版本并记录修复。
