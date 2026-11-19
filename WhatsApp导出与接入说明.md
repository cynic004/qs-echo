# Q’s echo · WhatsApp 导出与接入说明

资料核对日期为 2026 年 11 月 19 日。

## 导出一段聊天

- **Android**：打开要学习的聊天，点右上角三个点，再选「更多」和「导出聊天」。需要旧语音时，选「包含媒体」并把文件传到电脑。WhatsApp 说明只会随导出附上最近的媒体。 [WhatsApp Android 帮助](https://faq.whatsapp.com/1180414079177245/?cms_platform=android&locale=en_US)
- **iPhone**：打开聊天，点顶部联系人名称，选「导出聊天」。需要语音时选包含媒体，再点「存储到文件」。收到的 ZIP 可以直接导入 Q’s echo。 [WhatsApp iPhone 帮助](https://faq.whatsapp.com/1180414079177245/?cms_platform=iphone&locale=en_US)
- **WhatsApp Web**：如果聊天菜单里有「导出聊天」，点右上角三个点，选择「所有消息」或「自定义日期范围」，再点「导出」。浏览器下载的是仅含文字记录的 ZIP。要导出语音，请用手机。 [WhatsApp Web 帮助](https://faq.whatsapp.com/1180414079177245/?cms_platform=web)

### 可以处理导出文件的开源项目

| 项目 | 用途 |
| --- | --- |
| [whatsapp-chat-parser](https://github.com/Pustur/whatsapp-chat-parser) | 将 WhatsApp 原生导出的聊天文本解析为消息记录。 |
| [mtln/chat-export](https://github.com/mtln/chat-export) | 将 WhatsApp 导出的 ZIP 转成可离线浏览和打印的 HTML。 |

用 Q’s echo 时，把 WhatsApp 原生导出的 TXT 或 ZIP 直接选进应用即可。

## 个人 WhatsApp 能接入到哪一步

### GitHub 上能连接个人账号的项目

| 项目 | 连接方式和能力 |
| --- | --- |
| [whatsapp-web.js](https://github.com/wwebjs/whatsapp-web.js) | 通过受控浏览器连接 WhatsApp Web。提供按 ID 查单段聊天的 `getChatById`、列出当前聊天的 `getChats`，以及向指定聊天发消息的 `sendMessage`。 [接口文档](https://docs.wwebjs.dev/Client.html) |
| [Baileys](https://github.com/WhiskeySockets/Baileys) | 通过 WebSocket 对接 WhatsApp Web。项目提供 TypeScript 接口。 |
| [WPPConnect](https://github.com/wppconnect-team/wppconnect) | 通过受控浏览器连接 WhatsApp Web，提供关联设备登录、会话管理、消息收发和媒体处理。 |

这些是第三方项目。WhatsApp 的关联设备按账号连接，并可能同步近期消息。用 `getChatById` 或在程序内按联系人筛选，可以限制程序主动处理的对象。关联设备本身仍有账号级的会话权限。WhatsApp 条款限制未经许可的自动访问和自动发信。Meta 的官方发信接口面向 WhatsApp Business，官方 Cloud API 要求企业资产、企业 WhatsApp 账号和企业号码。 [关联设备说明](https://faq.whatsapp.com/653480766448040/) [WhatsApp 条款](https://www.whatsapp.com/legal/terms-of-service/) [Meta 官方 API](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api)

### Q’s echo 的使用方式

在 Q’s echo 里为指定的一对一聊天填写对方的国际格式号码。草稿到时间后，点「打开 WhatsApp」会打开该号码的聊天并预填回复。请核对联系人和文字，再在 WhatsApp 里点发送。群聊可以复制草稿，再自己找群聊粘贴。Q’s echo 的聊天来源是你手动选择的导出文件和粘贴的新消息。 [WhatsApp 点击聊天帮助](https://faq.whatsapp.com/5913398998672934)

## OpenAI 模型和使用条件

文字风格分析和回复默认用 GPT-6 Luna，语音转文字用 GPT-Transcribe。转录支持 OGG、MP3、M4A、WAV 等，每个文件上限 25 MB。云端功能需要有这些模型权限的 OpenAI API 密钥，按 API 用量计费。OpenAI 公布的 API 支持地区列表目前没有列出香港。未配置密钥时，可以使用本地学习和示例流程。 [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna) [语音转文字帮助](https://developers.openai.com/api/docs/guides/speech-to-text) [API 支持地区](https://developers.openai.com/api/docs/supported-countries)
