import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { parseExport, buildLocalProfile } from './lib/import.mjs';
import { AUDIO_LIMIT, createOpenAI, DEFAULT_MODEL } from './lib/openai.mjs';
import { calculateDueAt, localDraft, styleSkill } from './lib/echo.mjs';

const ROOT = import.meta.dirname;
const EXPORT_LIMIT = 120 * 1024 * 1024;
const API_HEADER = 'x-qs-echo';
const MAX_VOICES = 6;
const AUDIO = /\.(?:aac|amr|flac|m4a|mp3|oga|ogg|opus|wav|webm)$/iu;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
};
const DEMO = Buffer.from([
  '[18/11/26, 09:04:11] 阿言: 早呀，今天忙吗？',
  '[18/11/26, 09:05:02] 小晴: 早早～上午有点忙，下午应该松一点',
  '[18/11/26, 12:08:13] 阿言: 要不要改约周末吃饭？',
  '[18/11/26, 12:09:40] 小晴: 好呀，我先看下时间，晚点跟你说 ☺️',
  '[18/11/26, 16:21:18] 阿言: 谢谢你刚才发的地址！',
  '[18/11/26, 16:24:08] 小晴: 不客气啦！到时候见',
  '[18/11/26, 18:01:03] 阿言: 我今天累死了',
  '[18/11/26, 18:01:26] 小晴: 辛苦啦，回去先吃点东西，别饿着',
  '[18/11/26, 19:05:11] 阿言: 对不起我没及时看手机',
  '[18/11/26, 19:06:04] 小晴: 没事呀，我也才看到',
  '[18/11/26, 21:08:03] 阿言: 我到了',
  '[18/11/26, 21:08:28] 小晴: 收到啦 ☺️',
].join('\n'));

class RequestError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function renderJSON(res, value, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function readBytes(req, limit) {
  if (Number(req.headers['content-length']) > limit) throw new RequestError('文件太大，请缩短导出的日期范围或减少附件。', 413);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new RequestError('文件太大，请缩短导出的日期范围或减少附件。', 413);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function readJSON(req) {
  const bytes = await readBytes(req, 64 * 1024);
  try {
    const parsed = JSON.parse(bytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new RequestError('这次操作的信息不完整，请刷新页面后重试。');
  }
}

function fileName(req) {
  try {
    const file = decodeURIComponent(req.headers['x-file-name'] ?? '');
    if (!file || file.length > 400 || /[\x00-\x1F\\/]/u.test(file)) throw new Error();
    return basename(file);
  } catch {
    throw new RequestError('没有读到文件名，请重新选择文件。');
  }
}

function trimmed(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max).toWellFormed() : '';
}

function openWorkspace(path) {
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    if (data.version !== 1 || !Array.isArray(data.profiles) || !Array.isArray(data.drafts)) throw new Error();
    return data;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('本机的 Q’s echo 数据无法读取。请先保留工作区文件，再检查文件是否损坏。');
    return { version: 1, profiles: [], drafts: [] };
  }
}

function saveWorkspace(path, workspace) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, JSON.stringify(workspace), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    renameSync(temp, path);
  } catch {
    throw new RequestError('保存失败，请确认磁盘有空间并重试。', 500);
  } finally {
    rmSync(temp, { force: true });
  }
}

function describeImport(imported) {
  if (!imported) return null;
  const { id, name, demo, participants, messages, media, skipped } = imported;
  const names = new Set(media.map(file => file.name));
  const missingVoiceCount = messages.filter(message =>
    (message.attachment && AUDIO.test(message.attachment) && !names.has(message.attachment)) || message.voiceOmitted,
  ).length;
  return { id, name, demo, participants, messageCount: messages.length, skipped, voiceCount: media.length, missingVoiceCount };
}

function dueStatus(draft, now) {
  if (draft.status === 'sent' || draft.status === 'cancelled') return draft.status;
  return Date.parse(draft.dueAt) > now ? 'scheduled' : 'ready';
}

export function createEchoServer({
  dataPath = join(process.env.LOCALAPPDATA || homedir(), 'QsEcho', 'workspace.json'),
  openai = createOpenAI(), now = Date.now, offlineVoice,
} = {}) {
  let workspace = openWorkspace(dataPath);
  let imported = null;
  let settings = { key: '', model: DEFAULT_MODEL };
  let generation = 0;
  let working = false;

  function commit(next) {
    saveWorkspace(dataPath, next);
    workspace = next;
  }

  function state() {
    const time = now();
    return {
      connected: Boolean(settings.key), model: settings.model, profiles: workspace.profiles,
      drafts: workspace.drafts.map(draft => ({ ...draft, status: dueStatus(draft, time) })),
      imported: describeImport(imported), demoAudio: true, offlineVoice: Boolean(offlineVoice?.available()),
    };
  }

  function profileFor(id) {
    const profile = workspace.profiles.find(profile => profile.id === id);
    if (!profile) throw new RequestError('没有找到所选风格，请重新选择。', 404);
    return profile;
  }

  function checkGeneration(previous) {
    if (generation !== previous) throw new RequestError('工作区已更改，请重新开始这次操作。', 409);
  }

  async function aiAction(callback) {
    if (working) throw new RequestError('正在处理另一项学习、回复或转写，请等它完成。', 409);
    working = true;
    try {
      return await callback();
    } finally {
      working = false;
    }
  }

  async function transcribe(key, bytes, name) {
    if (offlineVoice?.available()) return offlineVoice.transcribe(bytes, name);
    if (key) return openai.transcribe(key, bytes, name);
    throw new RequestError('请先在「连接 OpenAI」中填写 API 密钥，或启用本机语音识别。');
  }

  async function route(req, res, url) {
    const { pathname: path } = url;
    const method = req.method;
    if (method === 'GET' && path === '/api/health') return renderJSON(res, { app: 'qs-echo' });
    if (method === 'GET' && Object.hasOwn(STATIC, path)) {
      const [file, type] = STATIC[path];
      const bytes = readFileSync(join(ROOT, 'public', file));
      res.writeHead(200, { 'Content-Type': type });
      return res.end(bytes);
    }
    if (method === 'GET' && path === '/favicon.ico') {
      res.writeHead(204);
      return res.end();
    }
    const skill = /^\/api\/profiles\/([a-f0-9-]+)\/skill$/u.exec(path);
    if (method === 'GET' && skill) {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError('请从 Q’s echo 页面下载风格 Skill。', 403);
      const contents = styleSkill(profileFor(skill[1]));
      res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Content-Disposition': 'attachment; filename="SKILL.md"' });
      return res.end(contents);
    }
    const handoff = /^\/api\/drafts\/([a-f0-9-]+)\/whatsapp$/u.exec(path);
    if (method === 'GET' && handoff) {
      if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError('请从 Q’s echo 页面打开 WhatsApp。', 403);
      const draft = workspace.drafts.find(item => item.id === handoff[1]);
      if (!draft || dueStatus(draft, now()) !== 'ready') throw new RequestError('没有可发送的草稿，请回到 Q’s echo。', 409);
      const profile = profileFor(draft.profileId);
      if (!profile.canBind || !profile.phone || profile.phone !== draft.phone) {
        throw new RequestError('联系人已变更，请回到 Q’s echo 核对号码并重新生成草稿。', 409);
      }
      res.writeHead(303, { Location: `https://wa.me/${profile.phone}?text=${encodeURIComponent(draft.body.toWellFormed())}` });
      return res.end();
    }
    if (req.headers[API_HEADER] !== '1') throw new RequestError('请从 Q’s echo 页面执行这项操作。', 403);

    if (method === 'GET' && path === '/api/state') return renderJSON(res, state());
    if (method === 'POST' && path === '/api/import') {
      const name = fileName(req);
      const limit = extname(name).toLowerCase() === '.txt' ? 12 * 1024 * 1024 : EXPORT_LIMIT;
      const parsed = parseExport(await readBytes(req, limit), name);
      imported = { ...parsed, id: randomUUID(), name, demo: false };
    } else if (method === 'POST' && path === '/api/demo') {
      await readJSON(req);
      imported = { ...parseExport(DEMO, '示例聊天.txt'), id: randomUUID(), name: '小晴和阿言的示例聊天', demo: true };
    } else if (method === 'POST' && path === '/api/settings') {
      const body = await readJSON(req);
      const model = body.model === undefined ? settings.model : trimmed(body.model, 160) || DEFAULT_MODEL;
      if (!/^[a-z0-9][a-z0-9._:-]{0,159}$/iu.test(model)) throw new RequestError('请填写正确的 OpenAI 模型名称。');
      if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 512)) {
        throw new RequestError('请检查 API 密钥格式。');
      }
      await aiAction(async () => {
        const key = body.apiKey === undefined ? settings.key : body.apiKey.trim();
        if (/\s/u.test(key)) throw new RequestError('API 密钥里不能有空格。请重新粘贴。');
        const previous = generation;
        if (key && (key !== settings.key || model !== settings.model)) await openai.verify(key, model);
        checkGeneration(previous);
        settings = { key, model };
      });
    } else if (method === 'POST' && path === '/api/learn') {
      const { importId, self, name, withAi, transcribeVoices } = await readJSON(req);
      const source = imported;
      if (!source || source.id !== importId) throw new RequestError('请先选择要学习的聊天。');
      if (!source.participants.some(person => person.name === self)) throw new RequestError('请选择你在这段聊天里的名字。');
      const selected = settings;
      const previous = generation;
      await aiAction(async () => {
        const others = source.participants.filter(person => person.name !== self);
        const voice = new Map();
        let voiceSkipped = 0;
        if (!source.demo && transcribeVoices === true) {
          for (const { bytes, name } of source.media.slice(-MAX_VOICES)) {
            checkGeneration(previous);
            try {
              voice.set(name, await transcribe(selected.key, bytes, name));
            } catch {
              voiceSkipped += 1;
            }
          }
        }
        const messages = voice.size
          ? source.messages.map(message => voice.has(message.attachment) ? { ...message, text: voice.get(message.attachment) } : message)
          : source.messages;
        const local = buildLocalProfile(messages, self);
        const useAI = !source.demo && withAi === true;
        const style = useAI ? await openai.learn(selected, {
          traits: local.traits,
          examples: local.examples,
          samples: messages.filter(message => message.sender === self && message.text).slice(-24).map(message => message.text.slice(0, 320)),
        }) : {};
        checkGeneration(previous);
        if (imported !== source) throw new RequestError('导入的聊天已更换。请选择对应聊天后重新学习。', 409);
        const profile = {
          ...local, ...style, id: randomUUID(), importId, self, demo: source.demo,
          name: trimmed(name, 70) || (others.length === 1 ? `与 ${others[0].name} 的聊天` : '我的聊天风格'),
          other: others.length === 1 ? others[0].name : '', phone: '',
          canBind: !source.demo && others.length === 1, learnedWith: useAI ? 'openai' : 'local',
          voiceTranscribed: voice.size, voiceSkipped,
        };
        commit({ ...workspace, profiles: [...workspace.profiles, profile] });
      });
    } else if (method === 'POST' && path === '/api/transcribe-demo') {
      await readJSON(req);
      return renderJSON(res, { text: '我刚忙完。周六下午有空吗？要不要一起去喝咖啡？' });
    } else if (method === 'POST' && path === '/api/transcribe') {
      const name = fileName(req);
      const bytes = await readBytes(req, AUDIO_LIMIT);
      const previous = generation;
      const text = await aiAction(() => transcribe(settings.key, bytes, name));
      checkGeneration(previous);
      return renderJSON(res, { text });
    } else if (method === 'POST' && path === '/api/drafts') {
      const { profileId, incoming, schedule } = await readJSON(req);
      const text = trimmed(incoming, 8000);
      if (!text) throw new RequestError('请先填写收到的消息，或上传语音识别成文字。');
      const profile = profileFor(profileId);
      const created = now();
      const due = calculateDueAt(schedule, created);
      const selected = settings;
      const previous = generation;
      const engine = profile.demo ? 'demo' : selected.key ? 'openai' : 'local';
      const body = engine === 'openai'
        ? await aiAction(() => openai.reply(selected, { summary: profile.summary, traits: profile.traits }, text))
        : localDraft(profile, text);
      checkGeneration(previous);
      const current = profileFor(profileId);
      if (current.phone !== profile.phone) throw new RequestError('这个联系人的号码有变化，请重新生成草稿。', 409);
      const draft = {
        id: randomUUID(), profileId, contact: profile.other || profile.name, phone: profile.phone, body, engine,
        createdAt: new Date(created).toISOString(), dueAt: new Date(due).toISOString(), status: 'pending',
      };
      commit({ ...workspace, drafts: [...workspace.drafts, draft] });
    } else if (method === 'POST' && path === '/api/reset') {
      await readJSON(req);
      commit({ version: 1, profiles: [], drafts: [] });
      generation += 1;
      imported = null;
      settings = { key: '', model: DEFAULT_MODEL };
    } else if (method === 'PATCH' && /^\/api\/profiles\/[a-f0-9-]+$/u.test(path)) {
      const { phone, confirmDirect } = await readJSON(req);
      const profile = profileFor(path.split('/').at(-1));
      if (!profile.canBind) throw new RequestError('此风格无法绑定个人联系人。');
      const digits = typeof phone === 'string' ? phone.trim().replace(/^[+]|[\s()-]/gu, '') : null;
      if (digits === null || (digits && !/^[1-9]\d{6,14}$/u.test(digits))) {
        throw new RequestError('请输入包含区号的国际号码，例如 +1 202 555 0142。');
      }
      if (digits && confirmDirect !== true) throw new RequestError('请先确认这是一对一聊天，并核对对方的号码。');
      const drafts = digits ? workspace.drafts.map(draft =>
        !draft.phone && draft.profileId === profile.id ? { ...draft, phone: digits } : draft,
      ) : workspace.drafts;
      commit({ ...workspace, drafts, profiles: workspace.profiles.map(item => item.id === profile.id ? { ...item, phone: digits } : item) });
    } else if (method === 'PATCH' && /^\/api\/drafts\/[a-f0-9-]+$/u.test(path)) {
      const patch = await readJSON(req);
      const draft = workspace.drafts.find(item => item.id === path.split('/').at(-1));
      if (!draft) throw new RequestError('没有找到这条草稿，可能已被清空。', 404);
      const status = dueStatus(draft, now());
      if (status === 'sent' || status === 'cancelled') throw new RequestError('这条草稿已经归档。');
      const updated = { ...draft };
      if (patch.status !== undefined) {
        if (patch.status !== 'cancelled' && !(patch.status === 'sent' && status === 'ready')) throw new RequestError('草稿到提醒时间后才能标记为已发送。');
        updated.status = patch.status;
      } else {
        updated.body = trimmed(patch.body, 4000);
        if (!updated.body) throw new RequestError('回复草稿不能为空。');
      }
      commit({ ...workspace, drafts: workspace.drafts.map(item => item.id === draft.id ? updated : item) });
    } else {
      throw new RequestError('没有找到这个页面或操作。', 404);
    }
    return renderJSON(res, state());
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const address = res.socket.localPort;
    const host = `127.0.0.1:${address}`;
    const origin = `http://${host}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin)) {
      return renderJSON(res, { error: '请用 Q’s echo 的本机地址打开页面。' }, 403);
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) return renderJSON(res, { error: '无法打开这个页面。' }, 400);
    try {
      await route(req, res, new URL(req.url, origin));
    } catch (error) {
      if (!res.headersSent && !res.destroyed) renderJSON(res, { error: error.message || '操作没有完成，请重试。' }, error.status || 400);
    }
  });
}

function openBrowser(url) {
  if (process.platform !== 'win32') return;
  const child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore', windowsHide: true });
  child.on('error', () => console.log(`请在浏览器打开 ${url}`));
  child.unref();
}

async function main() {
  const port = Number(process.env.QS_ECHO_PORT || 43127);
  const url = `http://127.0.0.1:${port}`;
  const shouldOpen = process.argv.includes('--open');
  let offlineVoice;
  try {
    const { createOfflineVoice } = await import('./lib/offline-voice.mjs');
    offlineVoice = createOfflineVoice(ROOT);
  } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
  const server = createEchoServer({ dataPath: process.env.QS_ECHO_DATA, offlineVoice });
  server.on('error', async error => {
    if (error.code === 'EADDRINUSE' && shouldOpen) {
      const status = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) }).then(response => response.json()).catch(() => null);
      if (status?.app === 'qs-echo') return openBrowser(url);
    }
    console.error(`Q’s echo 无法启动。${error.code === 'EADDRINUSE' ? '本机端口已被其他程序占用。' : error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Q’s echo · ${url}`);
    if (shouldOpen) openBrowser(url);
  });
}

if (import.meta.main) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
