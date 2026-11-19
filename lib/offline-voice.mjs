import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, resolve } from 'node:path';

const SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
const MAX_SECONDS = 600;
const MAX_PCM = SAMPLE_RATE * BYTES_PER_SAMPLE * MAX_SECONDS;
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function run(executable, args, input, { timeout, maxBuffer, errorMessage }) {
  return new Promise((resolveOutput, reject) => {
    const child = execFile(executable, args, {
      cwd: dirname(executable),
      encoding: 'buffer',
      windowsHide: true,
      timeout,
      maxBuffer,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.code === 'ENOENT' ? '离线语音组件缺失，请重新安装。' : errorMessage));
      } else {
        resolveOutput(stdout);
      }
    });
    // Early tool exits can close the input pipe. The exit status above reports the failure.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function wavFromPcm(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(8 * BYTES_PER_SAMPLE, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function createOfflineVoice(projectRoot) {
  const whisper = resolve(projectRoot, 'voice-runtime/whisper/whisper-cli.exe');
  const model = resolve(projectRoot, 'voice-runtime/ggml-base-q5_1.bin');
  const ffmpeg = resolve(projectRoot, 'voice-runtime/ffmpeg/ffmpeg.exe');
  const threads = Math.min(availableParallelism(), 6).toString();
  let pending = Promise.resolve();

  function available() {
    return process.platform === 'win32' && process.arch === 'x64' &&
      [whisper, model, ffmpeg].every((file) => existsSync(file));
  }

  async function recognize(bytes) {
    if (!available()) throw new Error('请先安装离线语音组件。');
    if (!bytes?.length || bytes.length > MAX_AUDIO_BYTES) throw new Error('请选择一条小于 25 MB 的语音。');
    const pcm = await run(ffmpeg, [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-protocol_whitelist', 'pipe', '-i', 'pipe:0',
      '-map', '0:a:0', '-t', String(MAX_SECONDS + 1), '-ar', String(SAMPLE_RATE), '-ac', '1', '-f', 's16le', 'pipe:1',
    ], bytes, {
      timeout: 30_000, maxBuffer: MAX_PCM + SAMPLE_RATE * BYTES_PER_SAMPLE * 2,
      errorMessage: '无法打开这条语音。请选择 WhatsApp 下载的语音文件或试试 WAV、MP3。',
    });
    if (!pcm.length) throw new Error('这条语音没有可以识别的声音。');
    if (pcm.length > MAX_PCM) throw new Error('离线语音每次最多识别 10 分钟，请选择更短的语音。');

    const output = await run(whisper, [
      // A separate output base enables the stdout callback when reading stdin.
      // Whisper writes a file only when an explicit output format is requested.
      '-m', model, '-f', '-', '-of', 'transcript', '-l', 'auto', '-ng', '-np', '-nt', '-t', threads,
    ], wavFromPcm(pcm), {
      timeout: 360_000, maxBuffer: 512 * 1024,
      errorMessage: '离线识别没有完成。请检查离线组件，或换一条较短的语音重试。',
    });
    const transcript = output.toString('utf8').trim();
    if (!transcript) throw new Error('没有听清这条语音，请试试更清晰的录音。');
    return transcript;
  }

  // Only one decode/recognition runs at a time to limit memory and CPU in batch imports.
  function transcribe(bytes, _filename) {
    const result = pending.then(() => recognize(bytes));
    pending = result.then(() => undefined, () => undefined);
    return result;
  }

  return { available, transcribe };
}
