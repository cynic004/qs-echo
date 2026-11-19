import { basename, extname } from 'node:path/posix';
import { crc32, inflateRawSync } from 'node:zlib';

const MB = 1024 * 1024;
const MAX_ARCHIVE = 120 * MB;
const MAX_TRANSCRIPT = 12 * MB;
const MAX_AUDIO = 25 * MB;
const MAX_AUDIO_TOTAL = 80 * MB;
const MAX_ENTRIES = 20_000;
const MAX_MESSAGES = 150_000;
const INVISIBLE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
const AUDIO = /\.(?:aac|amr|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/iu;

const DATE = String.raw`(?:\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}|\d{2,4}年\s*\d{1,2}月\s*\d{1,2}日)`;
const PERIOD = String.raw`(?:[ap]\.?\s?m\.?|上午|下午|早上|晚上|中午|凌晨)`;
const TIME = String.raw`(?:${PERIOD}\s*)?\d{1,2}:\d{2}(?::\d{2})?(?:\s*${PERIOD})?`;
const STAMP = String.raw`${DATE}\s*[,，]?\s+${TIME}`;
const HEADER = new RegExp(String.raw`^(?:\[\s*(${STAMP})\s*\]\s*|(${STAMP})\s+[-–]\s+)(.*)$`, 'iu');
const SPEAKER = /^([^:：\r\n]{1,140})(?::\s+|：\s*)(.*)$/u;
const OMITTED = /^(?:<?(?:media omitted|audio omitted|voice message omitted|image omitted|video omitted|sticker omitted|媒体已省略|已省略媒体|语音已省略|已省略语音|媒體已省略|已省略媒體|語音已省略|已省略語音|已略過媒體|已略過語音)>?|<[^>]*(?:省略|略過)[^>]*>)\.?$/iu;
const VOICE_OMITTED = /^(?:<?(?:audio omitted|voice message omitted|语音已省略|已省略语音|語音已省略|已省略語音|已略過語音)>?|<[^>]*(?:语音|語音)[^>]*>)\.?$/iu;
const SYSTEM = /^(?:messages and calls are end-to-end encrypted|your security code with |you (?:blocked|unblocked) this contact|(?:you deleted this message|this message was deleted)\.?$|(?:missed |silenced )?(?:voice|video) call(?:[,，.]|$)|tap to call back|消息和通话已进行端到端加密|訊息和通話已經過端對端加密|訊息和通話已受到端對端加密|你已撤回此消息|这条消息已被删除|此訊息已刪除|你已刪除這則訊息|未接(?:语音|語音|视频|視訊)通[话話])/iu;
const EDITED = /\s*<\s*(?:this message was edited|此消息已编辑|此訊息已編輯)\s*>$/iu;
const DECODER = new TextDecoder('utf-8', { fatal: true });

function decode(bytes, errorMessage) {
  try {
    return DECODER.decode(bytes);
  } catch {
    throw new Error(errorMessage);
  }
}

function invalidZip() {
  return new Error('这个 ZIP 文件不完整或格式不受支持。请从 WhatsApp 重新导出一次。');
}

function archiveEntries(archive) {
  let end = archive.length - 22;
  const earliest = Math.max(0, end - 65_535);
  while (end >= earliest) {
    if (archive.readUInt32LE(end) === 0x06054b50 && end + 22 + archive.readUInt16LE(end + 20) === archive.length) break;
    end--;
  }
  if (end < earliest) throw invalidZip();

  const count = archive.readUInt16LE(end + 10);
  const length = archive.readUInt32LE(end + 12);
  const start = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) || archive.readUInt16LE(end + 6) || archive.readUInt16LE(end + 8) !== count) {
    throw invalidZip();
  }
  if (count > MAX_ENTRIES || start + length > end) throw invalidZip();

  let offset = start;
  const entries = [];
  for (let index = 0; index < count; index++) {
    if (offset + 46 > start + length || archive.readUInt32LE(offset) !== 0x02014b50) throw invalidZip();
    const header = archive.subarray(offset, offset + 46);
    const pathEnd = offset + 46 + header.readUInt16LE(28);
    const next = pathEnd + header.readUInt16LE(30) + header.readUInt16LE(32);
    if (next > start + length || header.readUInt16LE(34)) throw invalidZip();
    const pathBytes = archive.subarray(offset + 46, pathEnd);
    const rawPath = pathBytes.toString('utf8').replaceAll('\\', '/');
    const parts = rawPath.split('/');
    const safe = !rawPath.startsWith('/') && !rawPath.includes(':') && !rawPath.includes('\0') && !parts.includes('..');
    const metadata = parts.includes('__MACOSX') || basename(rawPath).startsWith('._');
    if (safe && !metadata && !rawPath.endsWith('/') && /^[^\ufffd]+$/u.test(rawPath)) {
      entries.push({
        name: basename(rawPath).normalize('NFC'), pathBytes, centralStart: start,
        flags: header.readUInt16LE(8), method: header.readUInt16LE(10), crc: header.readUInt32LE(16),
        packed: header.readUInt32LE(20), size: header.readUInt32LE(24), offset: header.readUInt32LE(42),
      });
    }
    offset = next;
  }
  if (offset !== start + length) throw invalidZip();
  return entries;
}

function readEntry(archive, entry, limit, tooLargeMessage) {
  const { offset, centralStart, flags, method, packed, size, crc, pathBytes } = entry;
  if (size > limit) throw new Error(tooLargeMessage);
  if (flags & 1) throw new Error('这个 ZIP 已加密。请从 WhatsApp 重新导出无需密码的文件。');
  if (offset + 30 > centralStart || archive.readUInt32LE(offset) !== 0x04034b50) throw invalidZip();
  const pathEnd = offset + 30 + archive.readUInt16LE(offset + 26);
  const start = pathEnd + archive.readUInt16LE(offset + 28);
  if (start + packed > centralStart || archive.readUInt16LE(offset + 6) !== flags || archive.readUInt16LE(offset + 8) !== method
    || !archive.subarray(offset + 30, pathEnd).equals(pathBytes)) throw invalidZip();

  const compressed = archive.subarray(start, start + packed);
  let bytes;
  if (method === 0) {
    if (packed !== size) throw invalidZip();
    // Keep selected media without retaining the rest of the upload via a shared view.
    bytes = Buffer.from(compressed);
  } else if (method === 8) {
    try {
      bytes = inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
    } catch {
      throw invalidZip();
    }
  } else {
    throw invalidZip();
  }
  if (bytes.length !== size || crc32(bytes) !== crc) throw invalidZip();
  return bytes;
}

function attachmentName(text, audioNames) {
  const ios = text.match(/^<\s*(?:attached|附件|已附加|附加文件|附加檔案)\s*[:：]\s*([^\r\n>]+)>$/iu);
  const android = text.match(/^([^\r\n]+?)\s*[（(]\s*(?:file attached|attached file|文件已附加|已附加文件|已附加檔案|已附上檔案|附件)\s*[)）]$/iu);
  const explicit = ios?.[1] ?? android?.[1];
  const candidate = (explicit ?? text).trim().normalize('NFC');
  if (!candidate || /[/\\:\r\n\0]/u.test(candidate)) return null;
  if (explicit || audioNames.has(candidate)) return candidate;
  return null;
}

function parseTranscript(bytes, audioNames) {
  const transcript = decode(bytes, '无法读取聊天文字。请选择 WhatsApp 原样导出的 TXT 或 ZIP 文件。');
  const messages = [];
  const participants = new Map();
  let skipped = 0;
  let current;

  function finish() {
    if (!current) return;
    const text = current.lines.join('\n').trim().replace(EDITED, '');
    const attachment = attachmentName(text, audioNames);
    const visibleText = attachment || OMITTED.test(text) ? '' : text;
    if (!text || SYSTEM.test(text)) {
      skipped++;
    } else {
      const voiceOmitted = !visibleText && !attachment && VOICE_OMITTED.test(text);
      messages.push({ sender: current.sender, text: visibleText, at: current.at, attachment, ...(voiceOmitted ? { voiceOmitted } : {}) });
      participants.set(current.sender, (participants.get(current.sender) ?? 0) + 1);
      if (messages.length > MAX_MESSAGES) throw new Error('这段聊天太长，请选择较短的 WhatsApp 导出文件。');
    }
    current = undefined;
  }

  for (const line of transcript.split(/\r\n|\n|\r/u)) {
    const clean = line.replace(INVISIBLE, '');
    const header = clean.match(HEADER);
    if (!header) {
      if (current) current.lines.push(clean);
      continue;
    }

    finish();
    const content = header[3].trimStart();
    const sender = content.match(SPEAKER);
    if (!sender?.[1].trim() || SYSTEM.test(content)) {
      skipped++;
      continue;
    }
    current = { sender: sender[1].trim().normalize('NFC'), at: header[1] ?? header[2], lines: [sender[2]] };
  }
  finish();

  if (messages.length === 0) {
    throw new Error('没有读到聊天消息。请在 WhatsApp 打开一段聊天，用「导出聊天」取得 TXT 或 ZIP 文件。');
  }
  return { messages, participants: Array.from(participants, ([name, count]) => ({ name, count })), skipped };
}

function transcriptEntry(entries) {
  const textEntries = entries.filter(({ name }) => extname(name).toLowerCase() === '.txt');
  const ios = textEntries.filter(({ name }) => name.toLowerCase() === '_chat.txt');
  if (ios.length === 1) return ios[0];
  const named = textEntries.filter(({ name }) => /^WhatsApp\b/iu.test(name));
  if (ios.length === 0 && named.length === 1) return named[0];
  if (textEntries.length === 1) return textEntries[0];
  if (textEntries.length > 1) throw new Error('这份 ZIP 有多份聊天文字。请单独选择其中一段聊天的 TXT，或从 WhatsApp 重新导出。');
  throw new Error('ZIP 里没有找到聊天文字。请在 WhatsApp 里用「导出聊天」生成文件。');
}

export function parseExport(bytes, filename) {
  const archive = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const ext = extname(filename).toLowerCase();
  const transcriptTooLarge = '聊天文字超过 12 MB。请导出一份较短的聊天再试。';
  if (ext === '.txt') {
    if (archive.length > MAX_TRANSCRIPT) throw new Error(transcriptTooLarge);
    return { ...parseTranscript(archive, new Set()), media: [] };
  }
  if (ext !== '.zip') throw new Error('请选择 WhatsApp 导出的 TXT 或 ZIP 文件。');
  if (archive.length > MAX_ARCHIVE) throw new Error('ZIP 超过 120 MB。请另存聊天文字和需要识别的语音。');

  const entries = archiveEntries(archive);
  const file = transcriptEntry(entries);
  const audio = new Map();
  for (const entry of entries) {
    if (!AUDIO.test(entry.name)) continue;
    audio.set(entry.name, audio.has(entry.name) ? null : entry);
  }
  const uniqueAudio = new Set(Array.from(audio).filter(([, entry]) => entry).map(([name]) => name));
  const result = parseTranscript(readEntry(archive, file, MAX_TRANSCRIPT, transcriptTooLarge), uniqueAudio);
  const mentioned = new Set(result.messages.map(({ attachment }) => attachment).filter(Boolean));
  const media = [];
  let total = 0;
  for (const name of mentioned) {
    const entry = audio.get(name);
    if (!entry || entry.size > MAX_AUDIO || total + entry.size > MAX_AUDIO_TOTAL) continue;
    media.push({ name, bytes: readEntry(archive, entry, MAX_AUDIO, '这条语音超过 25 MB。') });
    total += entry.size;
  }
  return { ...result, media };
}

const TAGS = [
  ['问候', /^(?:早[安呀啊]?|晚安|你好|嗨|hello|hi|hey|good (?:morning|night))(?=$|[\s,.!~。！～👋])/iu],
  ['安排', /见面|碰面|到哪|几点|時間|时间|今晚|明晚|周末|週末|几时|幾時|约|約|dinner|lunch|meet(?:ing)?\b|tomorrow|tonight|weekend|what time|\b(?:[1-9]|1[0-2])\s*(?:am|pm)\b/iu],
  ['感谢', /谢谢|謝謝|多谢|多謝|thank|thx|感謝|感谢/iu],
  ['道歉', /不好意思|对不起|對不起|抱歉|sorry|apolog/iu],
  ['关心', /怎[么麼]了|辛苦|[难難][受過]|不舒服|加油|累[了嗎吗]|担心|擔心|take care|you okay|feeling better/iu],
  ['提问', /[?？]|吗[。呀嘛]?$|嗎[。呀嘛]?$|[怎什][么麼]|what|when|where|who|could you|can you/iu],
  ['确认', /^(?:好[啊呀的]?|嗯+|行|可以|没问题|沒問題|收到|ok(?:ay)?|yes|sure|got it)(?=$|[\s,，.!。！👍])/iu],
];

function tagFor(text) {
  return TAGS.find(([, test]) => test.test(text))?.[0] ?? '闲聊';
}

function clip(text, length) {
  const characters = Array.from(text.trim());
  return characters.slice(0, length).join('') + (characters.length > length ? '…' : '');
}

export function buildLocalProfile(messages, self) {
  const own = messages.filter(({ sender, text }) => sender === self && text?.trim());
  if (!own.length) throw new Error('没有找到你发出的文字。请确认选了自己的名字，或先识别语音。');

  const lengths = own.map(({ text }) => Array.from(text).length).sort((a, b) => a - b);
  const typicalLength = lengths[Math.floor(lengths.length / 2)];
  const withEmoji = own.filter(({ text }) => /\p{Extended_Pictographic}/u.test(text)).length;
  const withQuestion = own.filter(({ text }) => /[?？]/u.test(text)).length;
  const withEnding = own.filter(({ text }) => /[。！？.!?]$/u.test(text.trim())).length;
  const withChinese = own.filter(({ text }) => /\p{Script=Han}/u.test(text)).length;
  const withEnglish = own.filter(({ text }) => /[a-z]{2,}/iu.test(text)).length;
  const traits = [
    `常见回复长度约 ${typicalLength} 个字或字符`,
    `${Math.round(withEmoji / own.length * 100)}% 的消息用了表情符号`,
    `${Math.round(withQuestion / own.length * 100)}% 的消息用了问号`,
    `${Math.round(withEnding / own.length * 100)}% 的消息以句号、问号或感叹号结尾`,
  ];
  if (withChinese && withEnglish) traits.push('聊天记录中同时出现中文和英文');
  else if (withChinese) traits.push('聊天记录以中文为主');
  else if (withEnglish) traits.push('聊天记录包含英文');

  const exchanges = [];
  let incoming = [];
  let replies = [];
  function finishExchange() {
    if (incoming.length && replies.length) {
      const prompt = clip(incoming.slice(-3).join('\n'), 360);
      exchanges.push({ incoming: prompt, reply: clip(replies.slice(0, 3).join('\n'), 360), tag: tagFor(prompt) });
    }
    incoming = [];
    replies = [];
  }

  for (const { sender, text } of messages) {
    if (!text?.trim()) {
      if (sender !== self) finishExchange();
      continue;
    }
    if (sender === self) {
      if (incoming.length && replies.length < 3) replies.push(text.trim());
    } else {
      if (replies.length) finishExchange();
      if (incoming.length === 3) incoming.shift();
      incoming.push(text.trim());
    }
  }
  finishExchange();

  const recent = exchanges.slice(-100).reverse();
  const tags = new Set();
  const examples = [];
  for (const example of recent) {
    if (tags.has(example.tag)) continue;
    tags.add(example.tag);
    examples.push(example);
  }
  for (const example of recent) {
    if (examples.length >= 12) break;
    if (!examples.includes(example)) examples.push(example);
  }
  const summary = `根据你发出的 ${own.length} 条文字整理。${traits[0]}。${own.length < 10 ? '目前样本较少，语气特点可继续补充。' : ''}`;
  return { summary, traits, examples, count: own.length };
}
