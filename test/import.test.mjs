import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32, deflateRawSync } from 'node:zlib';
import { buildLocalProfile, parseExport } from '../lib/import.mjs';

function makeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [filename, content] of files) {
    const name = Buffer.from(filename, 'utf8');
    const bytes = Buffer.from(content);
    const packed = deflateRawSync(bytes);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt32LE(crc32(bytes), 14);
    localHeader.writeUInt32LE(packed.length, 18);
    localHeader.writeUInt32LE(bytes.length, 22);
    localHeader.writeUInt16LE(name.length, 26);
    locals.push(localHeader, name, packed);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    localHeader.copy(centralHeader, 6, 4, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, name);
    offset += localHeader.length + name.length + packed.length;
  }

  const footer = Buffer.alloc(22);
  footer.writeUInt32LE(0x06054b50, 0);
  footer.writeUInt16LE(files.length, 8);
  footer.writeUInt16LE(files.length, 10);
  footer.writeUInt32LE(Buffer.concat(central).length, 12);
  footer.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, footer]);
}

const android = [
  '\ufeff10/25/26, 8:13\u202fAM - Messages and calls are end-to-end encrypted. No one outside of this chat can read them.',
  '10/25/26, 8:14 AM - Alex: Tomorrow lunch?',
  'At noon maybe.',
  '10/25/26, 8:15 AM - Q: 可以啊 👍',
  '10/25/26, 8:15 AM - Q: 那就十二点',
  '10/25/26, 8:18 AM - Alex: Thanks!',
  '10/25/26, 8:19 AM - Q: np <This message was edited>',
  '10/25/26, 8:20 AM - Q: You deleted this message',
  '10/25/26, 8:21 AM - Alex: <Media omitted>',
].join('\r\n');

test('reads Android TXT, multiline messages, narrow AM space and edited markers', () => {
  const result = parseExport(Buffer.from(android), 'WhatsApp Chat with Alex.TXT');
  assert.deepEqual(result.participants, [{ name: 'Alex', count: 3 }, { name: 'Q', count: 3 }]);
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.messages[0], {
    sender: 'Alex', text: 'Tomorrow lunch?\nAt noon maybe.', at: '10/25/26, 8:14 AM', attachment: null,
  });
  assert.equal(result.messages[4].text, 'np');
  assert.equal(result.messages[5].text, '');
});

test('reads Chinese iPhone ZIP and pairs only a uniquely named, referenced audio file', () => {
  const ios = [
    '\u200e[2026/11/19 下午3:21:00] Mei：晚上幾點吃飯？',
    '\u200e[2026/11/19 下午3:21:01] Q: \u200e<附件：000001-AUDIO-中文.opus>',
    '[2026年11月19日 下午3:21:02] Mei: <attached: clip.mp4>',
    '[2026年11月19日 下午3:21:03] Mei: dup.opus (file attached)',
    '[2026年11月19日 下午3:21:04] Mei: bad.opus（附件）',
  ].join('\n');
  const zip = makeZip([
    ['outer/_chat.txt', ios],
    ['attached-notes.txt', 'this attached document is not the transcript'],
    ['outer/000001-AUDIO-中文.opus', 'selected audio'],
    ['outer/clip.mp4', 'video'],
    ['outer/orphan.opus', 'unreferenced audio'],
    ['outer/dup.opus', 'first candidate'],
    ['another/dup.opus', 'second candidate'],
    ['../bad.opus', 'unsafe relative entry'],
    ['__MACOSX/._chat.txt', 'macOS metadata'],
  ]);
  const result = parseExport(zip, 'WhatsApp.zip');
  assert.deepEqual(result.messages.map(({ attachment }) => attachment), [null, '000001-AUDIO-中文.opus', 'clip.mp4', 'dup.opus', 'bad.opus']);
  assert.deepEqual(result.media, [{ name: '000001-AUDIO-中文.opus', bytes: Buffer.from('selected audio') }]);
});

test('rejects corrupt or ambiguous archives and unsupported text', () => {
  assert.throws(() => parseExport(Buffer.from('not a zip'), 'Chat.zip'), /ZIP 文件不完整/u);
  const badCrc = makeZip([['_chat.txt', android]]);
  const centralStart = badCrc.readUInt32LE(badCrc.length - 6);
  badCrc.writeUInt32LE(0, centralStart + 16);
  assert.throws(() => parseExport(badCrc, 'Bad.zip'), /ZIP 文件不完整/u);
  assert.throws(() => parseExport(makeZip([['a.txt', android], ['b.txt', android]]), 'Both.zip'), /多份聊天/u);
  assert.throws(() => parseExport(Buffer.from('no dates in this file'), 'Wrong.txt'), /没有读到聊天消息/u);
  assert.throws(() => parseExport(Buffer.from([0xff, 0xfe]), 'Broken.txt'), /无法读取聊天文字/u);
});

test('labels exchanges and derives style from the person selected as the user', () => {
  const { messages } = parseExport(Buffer.from(android), 'Chat.txt');
  const profile = buildLocalProfile(messages, 'Q');
  assert.equal(profile.count, 3);
  assert.match(profile.summary, /你发出的 3 条/u);
  assert.ok(profile.traits.includes('33% 的消息用了表情符号'));
  assert.equal(profile.examples.length, 2);
  assert.ok(profile.examples.some(({ tag, incoming, reply }) =>
    tag === '安排' && incoming === 'Tomorrow lunch?\nAt noon maybe.' && reply === '可以啊 👍\n那就十二点'));
  assert.ok(profile.examples.some(({ tag, incoming, reply }) => tag === '感谢' && incoming === 'Thanks!' && reply === 'np'));
  assert.throws(() => buildLocalProfile(messages, 'Other'), /没有找到你发出的文字/u);
});
