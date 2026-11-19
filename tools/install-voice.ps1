$ErrorActionPreference = 'Stop'

$project = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtime = Join-Path $project 'voice-runtime'
$stage = Join-Path $project ('.voice-runtime.install.' + [Guid]::NewGuid().ToString('N'))
$modelFile = 'ggml-base-q5_1.bin'

function Test-VoiceRuntime {
    return (Test-Path -LiteralPath (Join-Path $runtime 'whisper/whisper-cli.exe') -PathType Leaf) -and `
        (Test-Path -LiteralPath (Join-Path $runtime 'ffmpeg/ffmpeg.exe') -PathType Leaf) -and `
        (Test-Path -LiteralPath (Join-Path $runtime $modelFile) -PathType Leaf)
}

function Get-VerifiedFile([string] $Url, [string] $Destination, [string] $Sha256) {
    & curl.exe --fail --location --silent --show-error --retry 2 --connect-timeout 20 --max-time 600 --output $Destination $Url
    if ($LASTEXITCODE -ne 0) { throw '下载中断，请检查网络后重新双击安装。' }
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $Sha256) {
        throw '下载的文件没有通过校验，请重新双击安装。'
    }
}

try {
    if (Test-VoiceRuntime) {
        Write-Host "本机语音识别已安装。回到 Q's echo 即可使用。"
        exit 0
    }
    if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') {
        throw '本机语音识别支持配备 Intel 或 AMD 处理器的 64 位 Windows 电脑。'
    }
    if (Test-Path -LiteralPath $runtime) {
        throw "语音组件文件夹不完整。请把 voice-runtime 文件夹移出 Q's echo，再重新双击安装。"
    }

    $payload = Join-Path $stage 'payload'
    $whisper = Join-Path $payload 'whisper'
    $ffmpeg = Join-Path $payload 'ffmpeg'
    $whisperZip = Join-Path $stage 'whisper.zip'
    $ffmpegZip = Join-Path $stage 'ffmpeg.7z'
    New-Item -ItemType Directory -Path $whisper, $ffmpeg | Out-Null

    Write-Host '正在下载本机语音识别组件，共约 103 MB。请保持窗口打开。'
    Write-Host '[1/3] 下载 Whisper 语音引擎'
    Get-VerifiedFile 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.2/whisper-bin-x64.zip' `
        $whisperZip '49dcc16de826f20bd53d44f947a1ae49dfa81f86cad67a64d80820cb192d674a'
    Expand-Archive -LiteralPath $whisperZip -DestinationPath (Join-Path $stage 'whisper-extracted')
    $whisperSource = Join-Path $stage 'whisper-extracted/Release'
    Copy-Item -LiteralPath (Join-Path $whisperSource 'whisper-cli.exe') -Destination $whisper
    Get-ChildItem -LiteralPath $whisperSource -Filter '*.dll' -File | Copy-Item -Destination $whisper

    Write-Host '[2/3] 下载多语言模型'
    Get-VerifiedFile 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base-q5_1.bin' `
        (Join-Path $payload $modelFile) '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898'

    Write-Host '[3/3] 下载音频转换工具'
    Get-VerifiedFile 'https://github.com/GyanD/codexffmpeg/releases/download/9.0.2/ffmpeg-9.0.2-essentials_build.7z' `
        $ffmpegZip '4705843ccaaf54257c16ad90f3e952ece33c17df964ecf7bfdbb0f49c7171077'
    $ffmpegSource = 'ffmpeg-9.0.2-essentials_build'
    & tar.exe -xf $ffmpegZip -C $stage "$ffmpegSource/bin/ffmpeg.exe" "$ffmpegSource/LICENSE"
    if ($LASTEXITCODE -ne 0) { throw '音频转换工具解包失败，请重新双击安装。' }
    Copy-Item -LiteralPath (Join-Path $stage "$ffmpegSource/bin/ffmpeg.exe"), (Join-Path $stage "$ffmpegSource/LICENSE") -Destination $ffmpeg

    # Both paths are fixed descendants of the project, with a fresh staging folder for this run.
    try {
        [System.IO.Directory]::Move($payload, $runtime)
    } catch [System.IO.IOException] {
        if (-not (Test-VoiceRuntime)) { throw }
    }
    Write-Host "本机语音识别已安装。回到 Q's echo 即可使用。"
} finally {
    $stageFullPath = [System.IO.Path]::GetFullPath($stage)
    if ((Split-Path -Parent $stageFullPath) -eq $project -and (Split-Path -Leaf $stageFullPath) -match '^\.voice-runtime\.install\.[a-f0-9]{32}$' -and (Test-Path -LiteralPath $stageFullPath -PathType Container)) {
        Remove-Item -LiteralPath $stageFullPath -Recurse -Force
    }
}
