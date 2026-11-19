# Q’s echo

Q’s echo 是一个运行在本机的 WhatsApp 回复助手。导入一段聊天记录，从自己发出的消息中提取语气和表达习惯，再用这些信息生成一条可以修改、定时提醒并手动发送的回复草稿。

[下载 Windows x64 版](https://github.com/cynic004/qs-echo/releases/latest) · [WhatsApp 导出与接入说明](WhatsApp导出与接入说明.md) · [版本记录](CHANGELOG.md) · [Windows CI](https://github.com/cynic004/qs-echo/actions/workflows/ci.yml)

## 快速开始

1. 在 GitHub Releases 下载 `Qs-echo-Windows-x64.zip` 并解压。双击 **启动 Qs echo.cmd**，在浏览器打开本机页面。
2. 点 **试用示例**，选择 **小晴**，点 **开始学习**。确认语气摘要后，点 **去准备回复**。示例流程无需密钥。
3. 使用自己的记录时，在 WhatsApp 对应聊天中选择 **导出聊天**，再把 `.txt` 或 `.zip` 拖到页面。要保留语音，请在手机导出时选 **包含媒体**。
4. 粘贴新来信或上传语音，选立即、固定等待、随机等待范围或指定时间，然后生成草稿。创建后还可以编辑草稿。
5. 一对一聊天可绑定带国际区号的号码。提醒到点后，**打开 WhatsApp** 会向该号码的聊天预填草稿，请检查号码和内容后手动发送。群聊可复制草稿到原聊天。

需要实时提醒时，请保持应用和浏览器页面打开。浏览器系统通知需要授权。重新打开后仍能看到已经到点的草稿。

## 模式与数据流

| 操作 | 处理方式 |
| --- | --- |
| 导入与学习 | 本机解析 WhatsApp 导出记录。从选中的身份及其回复上下文计算语气特征，为示例标上「安排」「提问」等场景标签。勾选 OpenAI 学习时，会向 API 发送少量相关样本。 |
| 生成文字草稿 | 无密钥时使用本机规则。配置密钥后，API 接收新来信、语气摘要及特征。默认文字模型为 `gpt-6-luna`，可在设置中修改。 |
| 语音转写 | 双击 **安装本机语音识别.cmd** 安装本机语音组件，首次下载约 103 MB。应用优先使用本机组件。已配置密钥且本机组件不可用时，语音会发往 `gpt-transcribe`，上传时使用通用文件名。 |
| 导出风格 | 每种语气可导出独立的 `SKILL.md`，包含风格摘要和起草指引。仓库另附通用的 [Q’s echo Skill](skill/qs-echo/SKILL.md)。 |

完整导入记录和 API 密钥保留在应用进程内存中。少量带标签的示例、语气摘要、联系人号码和草稿以明文 JSON 保存在本机，可从页面清空。打开 WhatsApp 时，所选号码和预填草稿随 `wa.me` 链接交给 WhatsApp。云端功能需要相应模型权限、可用地区和 API 额度。 [OpenAI API 支持地区](https://developers.openai.com/api/docs/supported-countries)

当前支持 UTF-8 聊天文本，单个 TXT 上限 12 MiB，ZIP 上限 120 MiB。单条上传语音上限 25 MB，本机转写单次最多 10 分钟。学习时可选择转写最近六条可读取的语音附件。

## 从源码运行

使用 Node.js 24 LTS。应用使用 Node.js 内置模块和静态前端，无需安装 npm 依赖。

```powershell
node --test
node server.mjs
```

访问 `http://127.0.0.1:43127`。服务只监听回环地址，同一台电脑上的其他程序仍可访问正在运行的服务。请在受信任的个人电脑上运行。

| 环境变量 | 用途 | 默认值 |
| --- | --- | --- |
| `QS_ECHO_PORT` | 本机 HTTP 服务端口 | `43127` |
| `QS_ECHO_DATA` | 工作区 JSON 路径，可用于隔离测试 | Windows 下为 `%LOCALAPPDATA%\QsEcho\workspace.json` |

| 路径 | 职责 |
| --- | --- |
| `server.mjs` | 本地路由、工作区保存、队列状态和 WhatsApp 跳转 |
| `public/` | 浏览器界面、草稿编辑和到点提醒 |
| `lib/import.mjs` | 聊天与附件解析、语气特征与场景标签 |
| `lib/echo.mjs` | 到期时间计算、本机规则草稿和风格导出 |
| `lib/openai.mjs`、`lib/offline-voice.mjs` | OpenAI API、FFmpeg 与 whisper.cpp 转写 |
| `test/` | 导入、语音、HTTP 工作流与时间计算测试 |

常规测试使用合成聊天、模拟 API 和本机 HTTP 服务。真实语音测试需要本机语音组件及相应的 Windows 语音包，缺失时会跳过。首版已验证普通话 Opus 本机转写与草稿到点提醒。OpenAI 路径使用模拟响应测试，WhatsApp 跳转验证了收件人和预填文本，真实账号发送和付费 API 调用尚未联测。

## 构建 Windows 发布包

在 Windows 上准备 PowerShell 和 Python 3，然后在仓库根目录运行以下命令。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/prepare-windows-runtime.ps1
& .\runtime\node.exe --test
python tools/package-windows.py
```

产物为 `dist/Qs-echo-Windows-x64.zip`。包内附带通过 SHA-256 校验的 Windows x64 Node.js 24.22.3 及其许可证。语音安装脚本按需另行下载并校验 FFmpeg、whisper.cpp 和模型文件。 [第三方组件说明](THIRD_PARTY_NOTICES.md)

[维护与发布流程](CONTRIBUTING.md) · [安全报告](SECURITY.md)
