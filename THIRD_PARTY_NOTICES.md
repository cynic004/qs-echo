# Third-party software

The Windows x64 ZIP includes the official Node.js 24.22.3 executable. Its complete license and dependency notices are included at `runtime/LICENSE.txt`. [Node.js release](https://nodejs.org/en/blog/release/v24.22.3) · [License at v24.22.3](https://github.com/nodejs/node/blob/v24.22.3/LICENSE)

The optional local voice installer downloads the following separately and verifies their SHA-256 digests before installation.

| Component | Source |
| --- | --- |
| whisper.cpp 1.9.2 Windows x64 | [Binary and source](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.9.2) · [MIT license](https://github.com/ggml-org/whisper.cpp/blob/v1.9.2/LICENSE) |
| Whisper multilingual `ggml-base-q5_1` model | [Pinned model distribution](https://huggingface.co/ggerganov/whisper.cpp/tree/5359861c739e955e79d9a303bcbc70fb988958b1) |
| Gyan FFmpeg essentials build 9.0.2 for Windows | [Binary and source information](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2) · [FFmpeg licensing](https://ffmpeg.org/legal.html). The installer copies the build's license to `voice-runtime/ffmpeg/LICENSE`. |

The notices above apply to their respective components. WhatsApp and OpenAI are separate services linked or called at the user's request.
