import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createEchoServer } from '../server.mjs';
import { createOpenAI } from '../lib/openai.mjs';
import { calculateDueAt } from '../lib/echo.mjs';

const HISTORY = [
  '[19/11/26, 09:00:00] Alex: 周末有空吗？',
  '[19/11/26, 09:01:00] 小明: 我先看下日历呀',
  '[19/11/26, 09:02:00] Alex: <voice message omitted>',
  '[19/11/26, 09:03:00] 小明: 晚一点回复你',
].join('\n');

async function start(options) {
  const server = createEchoServer(options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    async request(path, method = 'GET', input) {
      const headers = { 'X-Qs-Echo': '1' };
      let body;
      if (input instanceof Buffer) {
        headers['X-File-Name'] = path === '/api/import' ? 'chat.txt' : 'voice.opus';
        body = input;
      } else if (input) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(input);
      }
      return fetch(base + path, { method, body, headers, redirect: 'manual' });
    },
  };
}

test('imports one chat, learns, binds, edits, waits, hands off and reopens without the source', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'qs-echo-'));
  const dataPath = join(folder, 'workspace.json');
  let time = Date.parse('2026-11-19T12:00:00+08:00');
  const options = { dataPath, now: () => time };
  const app = await start(options);
  t.after(async () => { await app.close(); await rm(folder, { recursive: true, force: true }); });

  const noHeader = await fetch(`${app.base}/api/state`);
  assert.equal(noHeader.status, 403);
  const foreign = await fetch(`${app.base}/api/state`, { headers: { 'X-Qs-Echo': '1', Origin: 'https://other.test' } });
  assert.equal(foreign.status, 403);

  const loaded = await (await app.request('/api/import', 'POST', Buffer.from(HISTORY))).json();
  assert.equal(loaded.imported.messageCount, 4);
  assert.equal(loaded.imported.missingVoiceCount, 1);
  const learned = await (await app.request('/api/learn', 'POST', { importId: loaded.imported.id, self: '小明' })).json();
  const profile = learned.profiles[0];
  assert.equal(profile.examples[0].tag, '安排');
  const skill = await (await app.request(`/api/profiles/${profile.id}/skill`)).text();
  assert.match(skill, /name: qs-echo-reply-style/);
  assert(!skill.includes('周末有空吗'));

  const bound = `/api/profiles/${profile.id}`;
  assert.equal((await app.request(bound, 'PATCH', { phone: '+1 202 555 0142' })).status, 400);
  const bind = await (await app.request(bound, 'PATCH', { phone: '+1 202 555 0142', confirmDirect: true })).json();
  assert.equal(bind.profiles[0].phone, '12025550142');
  const planned = await (await app.request('/api/drafts', 'POST', {
    profileId: profile.id, incoming: '明天一起吃饭？', schedule: { mode: 'random', minMinutes: 60, maxMinutes: 180 },
  })).json();
  const { id, dueAt, status } = planned.drafts[0];
  assert.equal(status, 'scheduled');
  const draft = `/api/drafts/${id}`;
  const handoff = `${draft}/whatsapp`;
  const wait = Date.parse(dueAt) - time;
  assert(wait >= 60 * 60_000 && wait <= 180 * 60_000);
  assert.equal((await app.request(handoff)).status, 409);
  assert.equal((await app.request(draft, 'PATCH', { status: 'sent' })).status, 400);
  const edited = '好呀，先等我确认 😄';
  assert.equal((await app.request(draft, 'PATCH', { body: edited })).status, 200);

  time = Date.parse(dueAt);
  const redirect = await app.request(handoff);
  assert.equal(redirect.status, 303);
  const target = new URL(redirect.headers.get('location'));
  assert.equal(target.origin, 'https://wa.me');
  assert.equal(target.pathname, '/12025550142');
  assert.equal(target.searchParams.get('text'), edited);

  await app.request(bound, 'PATCH', { phone: '+1 202 555 0143', confirmDirect: true });
  assert.equal((await app.request(handoff)).status, 409);
  await app.request(draft, 'PATCH', { status: 'sent' });
  const reopened = await start(options);
  try {
    const state = await (await reopened.request('/api/state')).json();
    assert.equal(state.imported, null);
    assert.equal(state.drafts[0].status, 'sent');
    assert.equal(state.profiles[0].phone, '12025550143');
  } finally {
    await reopened.close();
  }
});

test('validates Luna connection, scopes OpenAI samples, sends Opus as Ogg, and holds the key in memory', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'qs-echo-ai-'));
  const dataPath = join(folder, 'workspace.json');
  const calls = [];
  const key = 'synthetic-test-key';
  const openai = createOpenAI(async (url, options) => {
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    if (url.endsWith('/audio/transcriptions')) {
      assert.equal(options.body.get('model'), 'gpt-transcribe');
      assert.equal(options.body.get('file').name, 'voice.ogg');
      calls.push('audio');
      return Response.json({ text: '测试语音' });
    }
    assert(url.endsWith('/responses'));
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gpt-6-luna');
    assert.equal(body.store, false);
    const data = JSON.parse(body.input);
    let payload;
    if (data.connection_check) {
      calls.push('verify');
      payload = { reply: 'OK' };
    } else if (body.text.format.name === 'chat_style') {
      calls.push('learn');
      assert.deepEqual(data.samples, ['我先看下日历呀', '晚一点回复你']);
      payload = { summary: '短句，轻松客气。', traits: ['简短', '语气词', '答复留余地'] };
    } else {
      calls.push('draft');
      assert.deepEqual(Object.keys(data).sort(), ['incoming', 'style']);
      assert(!JSON.stringify(data).includes('日历'));
      payload = { reply: '我看看先呀' };
    }
    return Response.json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(payload) }] }] });
  });
  const app = await start({ dataPath, openai });
  t.after(async () => { await app.close(); await rm(folder, { recursive: true, force: true }); });
  const settings = await (await app.request('/api/settings', 'POST', { apiKey: key })).json();
  assert.equal(settings.connected, true);
  assert(!JSON.stringify(settings).includes(key));
  const loaded = await (await app.request('/api/import', 'POST', Buffer.from(HISTORY))).json();
  const learned = await (await app.request('/api/learn', 'POST', { importId: loaded.imported.id, self: '小明', withAi: true })).json();
  assert.equal(learned.profiles[0].learnedWith, 'openai');
  const spoken = await (await app.request('/api/transcribe', 'POST', Buffer.from('OggS test packet'))).json();
  assert.equal(spoken.text, '测试语音');
  const drafted = await (await app.request('/api/drafts', 'POST', {
    profileId: learned.profiles[0].id, incoming: '下午见面？', schedule: { mode: 'now' },
  })).json();
  assert.equal(drafted.drafts[0].body, '我看看先呀');
  assert.deepEqual(calls, ['verify', 'learn', 'audio', 'draft']);
  assert(!(await readFile(dataPath, 'utf8')).includes(key));
  const reset = await (await app.request('/api/reset', 'POST', {})).json();
  assert.equal(reset.connected, false);
  assert.deepEqual(reset.profiles, []);
  assert.deepEqual(reset.drafts, []);
});

test('accepts fixed and exact times and rejects invalid ranges', () => {
  const now = Date.parse('2026-11-19T15:30:00+08:00');
  assert.equal(calculateDueAt({ mode: 'fixed', minutes: 60 }, now), now + 3_600_000);
  assert.equal(calculateDueAt({ mode: 'at', at: '2026-11-19T15:32:00+08:00' }, now), now + 120_000);
  assert.throws(() => calculateDueAt({ mode: 'at', at: '2026-11-19T15:00:00+08:00' }, now));
  assert.throws(() => calculateDueAt({ mode: 'random', minMinutes: 180, maxMinutes: 60 }, now));
});
