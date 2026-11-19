import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createOfflineVoice } from '../lib/offline-voice.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const voice = createOfflineVoice(project);

function speak(line, culture) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    Add-Type -AssemblyName System.Speech
    $speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $stream = New-Object System.IO.MemoryStream
    $selected = $speaker.GetInstalledVoices() | Where-Object {$_.Enabled -and $_.VoiceInfo.Culture.Name -eq '${culture}'} | Select-Object -First 1
    if ($selected) {
      $speaker.SelectVoice($selected.VoiceInfo.Name)
      $speaker.SetOutputToWaveStream($stream)
      $speaker.Speak('${line}')
      [Console]::Write([Convert]::ToBase64String($stream.ToArray()))
    }
    $speaker.Dispose()
    $stream.Dispose()
  `;
  const command = Buffer.from(script, 'utf16le').toString('base64');
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', command], {
    encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  return Buffer.from(output.trim(), 'base64');
}

test('reports an optional runtime missing without changing application data', async () => {
  const missing = createOfflineVoice(join(project, 'test', 'nonexistent-offline-runtime'));
  assert.equal(missing.available(), false);
  await assert.rejects(missing.transcribe(Buffer.from('test'), 'sample.wav'), /请先安装离线语音组件/u);
});

test('decodes English WAV and recovers after an invalid clip', { skip: !voice.available() }, async (t) => {
  const wav = speak('I will see you tomorrow at the coffee shop.', 'en-US');
  if (!wav.length) return t.skip('A Windows English system voice is unavailable.');
  await assert.rejects(voice.transcribe(Buffer.from('bad audio'), 'bad.opus'), /无法打开这条语音/u);
  const result = await voice.transcribe(wav, 'sample.wav');
  assert.match(result, /tomorrow.*coffee shop/iu);
});

test('recognizes Mandarin from synthetic Ogg Opus voice data', { skip: !voice.available() }, async (t) => {
  const wav = speak('我们明天下午三点在咖啡店见面。', 'zh-CN');
  if (!wav.length) return t.skip('A Windows Mandarin system voice is unavailable.');

  const ffmpeg = join(project, 'voice-runtime', 'ffmpeg', 'ffmpeg.exe');
  const opus = execFileSync(ffmpeg, [
    '-loglevel', 'error', '-i', 'pipe:0', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1',
  ], { input: wav, timeout: 15_000, windowsHide: true });

  assert.equal(opus.subarray(0, 4).toString('ascii'), 'OggS');
  const result = await voice.transcribe(opus, 'PTT-20261119-WA0001.opus');
  assert.match(result, /明天.*咖啡/u);
});
