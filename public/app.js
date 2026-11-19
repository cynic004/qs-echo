const $ = (id) => document.getElementById(id);
const panels = ['import', 'learn', 'reply'];
const statuses = { scheduled: '等待提醒', ready: '可以发送', sent: '已标为发送', cancelled: '已取消' };
const enableVoiceMessage = '在 Q’s echo 文件夹里双击「安装本机语音识别」，或在右上角设置 OpenAI。';
const dateFormat = new Intl.DateTimeFormat('zh-HK', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

let state;
let activeProfileId;
let panel = 'import';
let workInProgress = false;
let importedRendered;
let profileRendered;
let choicesRendered;
let bindingRendered;
let queueRendered;
let editingDraftId;
let editText = '';
let phoneToConfirm = '';
let readyDraftIds = new Set();
let toastTimer;

const activeProfile = () => state?.profiles.find((item) => item.id === activeProfileId);

function node(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

function button(text, className, onClick) {
  const element = node('button', text, className);
  element.type = 'button';
  element.addEventListener('click', onClick);
  return element;
}

function notice(id, text = '', error = false) {
  const element = $(id);
  element.textContent = text;
  element.hidden = !text;
  element.classList.toggle('is-error', error);
}

function toast(text) {
  window.clearTimeout(toastTimer);
  notice('toast', text);
  toastTimer = window.setTimeout(() => notice('toast'), 4500);
}

async function request(path, method = 'GET', data) {
  const headers = { 'X-Qs-Echo': '1' };
  let body;
  if (data instanceof File) {
    headers['Content-Type'] = 'application/octet-stream';
    headers['X-File-Name'] = encodeURIComponent(data.name);
    body = data;
  } else if (data !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(data);
  }
  const response = await fetch(path, { method, headers, body, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '这一步没有完成，请再试一次。');
  return result;
}

async function run(noticeId, busyMessage, action, controls = []) {
  if (workInProgress) {
    toast('正在处理上一步，请稍等。');
    return;
  }
  workInProgress = true;
  const disabled = controls.map((control) => control.disabled);
  controls.forEach((control) => { control.disabled = true; });
  notice(noticeId, busyMessage);
  try {
    await action();
  } catch (error) {
    notice(noticeId, error.message === 'Failed to fetch' ? '无法连接 Q’s echo，请确认程序还开着。' : error.message, true);
  } finally {
    controls.forEach((control, index) => { control.disabled = disabled[index]; });
    workInProgress = false;
  }
}

function showPanel(next, focus = true) {
  if (next === 'learn' && !state?.imported && !activeProfile()) return;
  if (next === 'reply' && !activeProfile()) return;
  panel = next;
  render();
  if (focus) {
    window.scrollTo(0, 0);
    $(`${panel}-title`).focus({ preventScroll: true });
  }
}

function selectProfile(id) {
  if (activeProfileId !== id) {
    activeProfileId = id;
    editingDraftId = undefined;
    editText = '';
    $('incoming').value = '';
    $('schedule-mode').value = 'now';
    syncScheduleFields();
    notice('reply-notice');
    notice('queue-notice');
    notice('bind-notice');
  }
}

function applyState(next, announce = false) {
  const previouslySeen = readyDraftIds;
  readyDraftIds = new Set(next.drafts.filter((draft) => draft.status === 'ready').map((draft) => draft.id));
  state = next;
  if (activeProfileId && !activeProfile()) selectProfile(undefined);
  if (announce && [...readyDraftIds].some((id) => !previouslySeen.has(id))) {
    toast('有一条回复到时间了。');
    if ('Notification' in window && Notification.permission === 'granted') {
      try { new Notification('Q’s echo', { body: '有一条回复到时间了。打开 Q’s echo 查看。' }); } catch { /* The page reminder is still visible. */ }
    }
  }
  render();
}

function render() {
  if (!state) return;
  const profile = activeProfile();
  const imported = state.imported;
  if (panel === 'learn' && !imported && !profile) panel = 'import';
  if (panel === 'reply' && !profile) panel = 'import';

  for (const name of panels) {
    const current = name === panel;
    $(`panel-${name}`).hidden = !current;
    const step = $(`nav-${name}`);
    step.classList.toggle('current', current);
    if (current) step.setAttribute('aria-current', 'step');
    else step.removeAttribute('aria-current');
  }
  $('nav-learn').disabled = !(imported || profile);
  $('nav-reply').disabled = !profile;
  $('open-ai').classList.toggle('is-connected', state.connected);
  $('ai-status').textContent = state.connected ? 'AI 已连接' : '设置 AI';
  $('forget-ai').hidden = !state.connected;
  const demo = panel === 'learn' ? (profile?.demo ?? imported?.demo) : profile?.demo;
  $('demo-banner').hidden = panel === 'import' || !demo;
  $('resume-card').hidden = !state.profiles.length;
  $('reset-data').hidden = !(state.profiles.length || state.imported || state.connected);

  renderChoices();
  renderLearn(profile, imported);
  renderReply(profile);
  renderQueue(profile);
}

function renderChoices() {
  const dueCounts = new Map();
  for (const draft of state.drafts) {
    if (draft.status === 'ready') dueCounts.set(draft.profileId, (dueCounts.get(draft.profileId) ?? 0) + 1);
  }
  const signature = JSON.stringify([state.profiles.map(({ id, name, other, demo }) => [id, name, other, demo]), [...dueCounts]]);
  if (choicesRendered === signature) return;
  choicesRendered = signature;
  const select = $('resume-profile');
  const selected = select.value;
  const choices = [...state.profiles].reverse();
  select.replaceChildren(...choices.map((profile) => {
    const due = dueCounts.get(profile.id);
    const label = profile.demo ? '示例聊天' : (profile.other || profile.name);
    const option = node('option', due ? `${label}（${due} 条回复到时间）` : label);
    option.value = profile.id;
    return option;
  }));
  if (choices.some((profile) => profile.id === selected)) select.value = selected;
}

function renderLearn(profile, imported) {
  const learnedVoice = profile?.voiceTranscribed ? ` · 已识别 ${profile.voiceTranscribed} 段语音` : '';
  $('learn-context').textContent = imported && !profile
    ? `已导入 ${imported.messageCount} 条消息`
    : profile ? `已学习 ${profile.count} 条属于你的消息${learnedVoice}` : '已导入聊天';
  $('learn-title').textContent = profile ? '学到的说话方式' : '学习你的说话方式';
  $('learn-instructions').textContent = profile
    ? '看看 Q’s echo 学到了哪些表达，再准备一条回复。'
    : '选出哪一个是你，Q’s echo 就会找出你常用的表达。';
  $('learn-form').hidden = !imported || Boolean(profile);
  $('learn-ai-row').hidden = !imported || imported.demo || !state.connected;
  $('learn-audio-row').hidden = !imported?.voiceCount || imported.demo || !(state.connected || state.offlineVoice);
  $('learn-audio-count').textContent = imported?.voiceCount ? `（找到 ${imported.voiceCount} 段）` : '';
  const explainLocal = imported?.demo ? '试用时会在本机分析这段示例聊天。' : '默认在本机整理语气。';
  const needVoiceKey = imported?.voiceCount && !state.connected && !state.offlineVoice ? ` 找到了语音文件。${enableVoiceMessage}` : '';
  const missingVoice = imported?.missingVoiceCount ? ` ${imported.missingVoiceCount} 条语音没有对应文件，可以重新导出并选择「包含媒体」。` : '';
  $('learn-method').textContent = explainLocal + needVoiceKey + missingVoice;
  $('learn-audio-note').textContent = state.offlineVoice ? '在本机识别最近六段有附件的语音。' : '将最近六段有附件的语音发送给 OpenAI 转成文字。';

  if (importedRendered !== imported?.id) {
    importedRendered = imported?.id;
    const fieldset = $('participants');
    const choices = (imported?.participants ?? []).map(({ name, count }, index) => {
      const label = node('label', undefined, 'participant');
      const radio = node('input');
      radio.type = 'radio';
      radio.name = 'self';
      radio.value = name;
      radio.required = true;
      radio.checked = imported.demo && name === '小晴';
      radio.id = `participant-${index}`;
      const caption = node('span', name);
      caption.append(node('small', `${count} 条消息`));
      label.append(radio, caption);
      return label;
    });
    fieldset.replaceChildren(node('legend', '选择自己', 'sr-only'), ...choices);
    $('learn-ai').checked = false;
    $('learn-audio').checked = false;
    notice('learn-notice');
  }

  $('profile-card').hidden = !profile;
  if (profileRendered === profile?.id) return;
  profileRendered = profile?.id;
  if (!profile) return;
  $('profile-summary').textContent = profile.summary;
  $('voice-learning-result').hidden = !profile.voiceSkipped;
  $('voice-learning-result').textContent = profile.voiceSkipped ? `${profile.voiceSkipped} 段语音未能识别，其余消息仍已用来学习语气。` : '';
  $('profile-tags').replaceChildren(...profile.traits.map((trait) => node('span', trait, 'tag')));
  $('download-skill').hidden = Boolean(profile.demo);
  const examples = profile.examples ?? [];
  $('examples-details').hidden = !examples.length;
  $('examples-details').open = false;
  $('examples-label').textContent = `查看 ${examples.length} 个聊天例子`;
  $('examples-list').replaceChildren(...examples.map(({ incoming, reply, tag }) => {
    const box = node('div', undefined, 'example');
    if (tag) box.append(node('span', tag, 'tag'));
    const situation = node('p');
    situation.append(node('strong', '对方 '), incoming || '（没有上一条消息）');
    const answer = node('p');
    answer.append(node('strong', '你 '), reply);
    box.append(situation, answer);
    return box;
  }));
}

function renderReply(profile) {
  if (!profile) return;
  $('reply-context').textContent = profile.demo ? '示例聊天' : `当前聊天 · ${profile.other || profile.name}`;
  $('reply-instructions').textContent = profile.demo
    ? '用示例消息练习生成回复，并设一个提醒时间。'
    : '粘贴对方发来的消息，或者上传一段语音。到时间后由你在 WhatsApp 确认发送。';
  $('choose-audio').hidden = Boolean(profile.demo);
  $('audio-drop-hint').hidden = Boolean(profile.demo);
  $('audio-drop-hint').textContent = state.offlineVoice ? '可以拖入语音文件，在本机转成文字。' : '也可以把语音文件拖到这里。';
  $('example-message').hidden = !profile.demo;
  $('example-audio').hidden = !profile.demo || !state.demoAudio;
  $('reply-method').textContent = profile.demo ? '你可以试用模拟转写，也可以直接用文字。' : state.connected
    ? '生成回复时，会把这条新消息和当前语气摘要发送给 OpenAI。'
    : '目前使用本机学到的语气生成简短草稿。连接 OpenAI 后，可以结合新消息生成回复。';
  $('bind-form').hidden = !profile.canBind;
  const bindingSignature = `${profile.id}:${profile.phone ?? ''}`;
  if (bindingRendered !== bindingSignature) {
    bindingRendered = bindingSignature;
    $('chat-phone').value = profile.phone ? `+${profile.phone.replace(/^\+/, '')}` : '';
    $('bind-label').textContent = profile.phone
      ? `已关联 ${profile.other || profile.name} 的号码。打开 WhatsApp 后，请核对对方再发送。`
      : `输入 ${profile.other || profile.name} 的手机号。到时间后就能打开这一个聊天。`;
    $('unbind-button').hidden = !profile.phone;
  }
}

function renderQueue(profile) {
  const drafts = state.drafts.filter((draft) => draft.profileId === profile?.id).slice().reverse();
  const signature = JSON.stringify([drafts, profile?.phone, editingDraftId]);
  const due = drafts.filter((draft) => draft.status === 'ready').length;
  $('reply-badge').textContent = due ? String(due) : '';
  $('reply-badge').hidden = !due;
  $('queue-card').hidden = !drafts.length;
  $('allow-notifications').hidden = !('Notification' in window) || Notification.permission !== 'default';
  if (queueRendered === signature) return;
  queueRendered = signature;
  const ready = drafts.filter((draft) => draft.status === 'ready');
  const scheduled = drafts.filter((draft) => draft.status === 'scheduled');
  const finished = drafts.filter((draft) => draft.status === 'sent' || draft.status === 'cancelled');
  const result = [...ready, ...scheduled].map((draft) => renderDraft(draft, profile));
  if (finished.length) {
    const details = node('details', undefined, 'draft-section');
    details.append(node('summary', `查看已处理的回复（${finished.length}）`), ...finished.map((draft) => renderDraft(draft, profile)));
    result.push(details);
  }
  $('queue-list').replaceChildren(...result);
}

function renderDraft(draft, profile) {
  const item = node('article', undefined, 'draft-item');
  const meta = node('div', undefined, 'draft-meta');
  const date = node('time', dateFormat.format(new Date(draft.dueAt)));
  date.dateTime = draft.dueAt;
  meta.append(node('strong', statuses[draft.status] ?? '已保存'), date);
  if (draft.engine === 'local') meta.append(node('span', '本机草稿'));
  item.append(meta);
  if (editingDraftId === draft.id) {
    const form = node('form', undefined, 'draft-edit');
    const label = node('label', '修改回复', 'field-label small-label');
    const textarea = node('textarea');
    textarea.id = 'edit-draft';
    textarea.required = true;
    textarea.maxLength = 4000;
    textarea.rows = 3;
    textarea.value = editText;
    label.htmlFor = textarea.id;
    textarea.addEventListener('input', () => { editText = textarea.value; });
    const submit = node('button', '保存修改', 'primary');
    submit.type = 'submit';
    const actions = node('div', undefined, 'actions');
    actions.append(submit, button('放弃修改', 'text-button', stopEditing));
    form.append(label, textarea, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!editText.trim()) return notice('queue-notice', '请输入要保存的回复。', true);
      updateDraft(draft.id, { body: editText.trim() }, submit);
    });
    item.append(form);
    return item;
  }

  item.append(node('p', draft.body, 'draft-body'));
  if (draft.status !== 'scheduled' && draft.status !== 'ready') return item;
  const actions = node('div', undefined, 'actions');
  if (draft.status === 'ready') {
    const phone = profile.phone?.replace(/^\+/, '');
    const draftPhone = draft.phone?.replace(/^\+/, '');
    if (profile.canBind && /^\d{7,15}$/.test(phone || '') && (!draftPhone || draftPhone === phone)) {
      const link = node('a', '打开 WhatsApp', 'wa-link');
      link.href = `/api/drafts/${encodeURIComponent(draft.id)}/whatsapp`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      actions.append(link);
    } else if (profile.canBind) {
      const detail = draftPhone && phone ? '联系人号码已更改，请重新生成回复后再打开 WhatsApp。' : '先在下方保存对方的手机号，就可以打开 WhatsApp。';
      item.append(node('p', detail, 'muted'));
    }
    actions.append(button('复制回复', 'secondary', () => copyDraft(draft.body)));
  }
  actions.append(button('修改', 'text-button', () => {
    editingDraftId = draft.id;
    editText = draft.body;
    notice('queue-notice');
    renderQueue(profile);
    $('edit-draft').focus();
  }));
  if (draft.status === 'ready') {
    actions.append(button('我已发送', 'text-button', (event) => updateDraft(draft.id, { status: 'sent' }, event.currentTarget)));
  }
  actions.append(button('取消回复', 'text-button', (event) => updateDraft(draft.id, { status: 'cancelled' }, event.currentTarget)));
  item.append(actions);
  return item;
}

function stopEditing() {
  editingDraftId = undefined;
  editText = '';
  renderQueue(activeProfile());
}

async function copyDraft(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('回复已复制。');
  } catch {
    notice('queue-notice', '无法自动复制。你可以选中回复文字，再按 Ctrl+C 复制。', true);
  }
}

function updateDraft(id, data, control) {
  return run('queue-notice', '正在保存…', async () => {
    const next = await request(`/api/drafts/${encodeURIComponent(id)}`, 'PATCH', data);
    editingDraftId = undefined;
    editText = '';
    applyState(next);
    notice('queue-notice');
    toast(data.status === 'cancelled' ? '已取消这条回复。' : '已保存。');
  }, [control]);
}

function syncScheduleFields() {
  const mode = $('schedule-mode').value;
  const groups = [
    ['fixed', $('fixed-fields'), [$('fixed-delay'), $('fixed-unit')]],
    ['random', $('random-fields'), [$('min-delay'), $('max-delay'), $('random-unit')]],
    ['at', $('at-fields'), [$('scheduled-at')]],
  ];
  for (const [value, group, controls] of groups) {
    group.hidden = mode !== value;
    for (const control of controls) {
      control.required = !group.hidden;
      control.disabled = group.hidden;
    }
  }
  if (mode === 'at') {
    const local = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    $('scheduled-at').min = local.toISOString().slice(0, 16);
  }
  $('fixed-delay').max = 43200 / Number($('fixed-unit').value);
  const randomMax = 43200 / Number($('random-unit').value);
  $('min-delay').max = randomMax;
  $('max-delay').max = randomMax;
}

function schedule() {
  const mode = $('schedule-mode').value;
  if (mode === 'fixed') return { mode, minutes: Number($('fixed-delay').value) * Number($('fixed-unit').value) };
  if (mode === 'random') {
    const unit = Number($('random-unit').value);
    const minMinutes = Number($('min-delay').value) * unit;
    const maxMinutes = Number($('max-delay').value) * unit;
    if (minMinutes > maxMinutes) throw new Error('最少等待时间不能超过最多等待时间。');
    return { mode, minMinutes, maxMinutes };
  }
  if (mode === 'at') {
    const at = new Date($('scheduled-at').value);
    if (Number.isNaN(at.valueOf()) || at <= new Date()) throw new Error('请选择一个还没到的时间。');
    return { mode, at: at.toISOString() };
  }
  return { mode };
}

function importFile(file) {
  if (!file) return;
  if (!/\.(txt|zip)$/i.test(file.name)) return notice('import-notice', '请选择 WhatsApp 导出的 .txt 或 .zip 文件。', true);
  return run('import-notice', `正在打开 ${file.name}…`, async () => {
    const next = await request('/api/import', 'POST', file);
    selectProfile(undefined);
    applyState(next);
    notice('import-notice');
    showPanel('learn');
  }, [$('choose-file'), $('start-demo')]);
}

function dropFiles(target, onDrop) {
  target.addEventListener('dragover', (event) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    target.classList.add('is-dragging');
  });
  target.addEventListener('dragleave', (event) => {
    if (!target.contains(event.relatedTarget)) target.classList.remove('is-dragging');
  });
  target.addEventListener('drop', (event) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    target.classList.remove('is-dragging');
    onDrop([...event.dataTransfer.files]);
  });
}

function openSettings(message = '') {
  $('api-key').value = '';
  $('api-key').required = !state?.connected;
  $('api-model').value = state?.model || '';
  notice('ai-notice', message);
  $('ai-dialog').showModal();
  $('api-key').focus();
}

function handleAudio(file, demo = false) {
  if (!file && !demo) return;
  if (activeProfile()?.demo && !demo) return notice('reply-notice', '示例只会转写内置的模拟语音。', true);
  if (!demo && !state.connected && !state.offlineVoice) {
    return notice('reply-notice', enableVoiceMessage);
  }
  return run('reply-notice', '正在识别语音…', async () => {
    const result = demo ? await request('/api/transcribe-demo', 'POST', {}) : await request('/api/transcribe', 'POST', file);
    const previousText = $('incoming').value.trim();
    const combined = `${previousText ? `${previousText}\n` : ''}${result.text}`;
    if (combined.length > $('incoming').maxLength) throw new Error('转写后字数太多，请缩短消息或选一段较短的语音。');
    $('incoming').value = combined;
    notice('reply-notice', demo ? '已填入模拟转写。你可以修改后再生成回复。' : '语音已转成文字。你可以修改后再生成回复。');
    $('incoming').focus();
  }, [$('choose-audio'), $('example-audio'), $('draft-button')]);
}

async function refresh(initial = false) {
  if (!initial && workInProgress) return;
  try {
    const currentState = state;
    const next = await request('/api/state');
    if (workInProgress || state !== currentState) return;
    applyState(next, !initial);
    notice('global-notice');
  } catch {
    notice('global-notice', '无法连接 Q’s echo。请确认程序还开着，然后刷新此页面。', true);
  }
}

function navigate(next) {
  if (workInProgress) return toast('正在处理上一步，请稍等。');
  showPanel(next);
}

for (const step of document.querySelectorAll('[data-panel]')) {
  step.addEventListener('click', () => navigate(step.dataset.panel));
}
document.querySelector('.brand').addEventListener('click', (event) => {
  event.preventDefault();
  navigate('import');
});
for (const close of document.querySelectorAll('[data-close]')) {
  close.addEventListener('click', () => $(close.dataset.close).close());
}

$('open-help').addEventListener('click', () => $('help-dialog').showModal());
$('open-ai').addEventListener('click', () => openSettings());
$('ai-dialog').addEventListener('close', () => { $('api-key').value = ''; });
$('ai-form').addEventListener('submit', (event) => {
  event.preventDefault();
  run('ai-notice', '正在检查密钥能否连接…', async () => {
    const apiKey = $('api-key').value.trim();
    const model = $('api-model').value.trim() || 'gpt-6-luna';
    if (!apiKey && !state?.connected) throw new Error('请粘贴 OpenAI API 密钥。');
    applyState(await request('/api/settings', 'POST', apiKey ? { apiKey, model } : { model }));
    $('ai-dialog').close();
    toast('AI 已连接。');
  }, [$('save-ai'), $('forget-ai')]);
});
$('forget-ai').addEventListener('click', () => run('ai-notice', '正在清除密钥…', async () => {
  applyState(await request('/api/settings', 'POST', { apiKey: '' }));
  $('ai-dialog').close();
  toast('已清除 API 密钥。');
}, [$('save-ai'), $('forget-ai')]));

$('choose-file').addEventListener('click', () => $('chat-file').click());
$('chat-file').addEventListener('change', () => {
  importFile($('chat-file').files[0]);
  $('chat-file').value = '';
});
dropFiles($('drop-zone'), (files) => {
  if (files.length === 1) importFile(files[0]);
  else notice('import-notice', '请一次拖入一段聊天的文件。', true);
});
$('start-demo').addEventListener('click', () => run('import-notice', '正在打开示例…', async () => {
  const next = await request('/api/demo', 'POST', {});
  selectProfile(undefined);
  applyState(next);
  notice('import-notice');
  showPanel('learn');
}, [$('choose-file'), $('start-demo')]));
$('exit-demo').addEventListener('click', () => navigate('import'));
$('resume-chat').addEventListener('click', () => {
  if (workInProgress) return toast('正在处理上一步，请稍等。');
  selectProfile($('resume-profile').value);
  showPanel('reply');
});
$('reset-data').addEventListener('click', () => {
  if (!window.confirm('清空本机的聊天语气、已保存回复和 API 密钥？这一步无法撤销。')) return;
  run('import-notice', '正在清空…', async () => {
    const next = await request('/api/reset', 'POST', {});
    selectProfile(undefined);
    applyState(next);
    notice('import-notice');
    toast('本机数据已清空。');
  }, [$('reset-data')]);
});

$('learn-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const self = new FormData(event.currentTarget).get('self');
  if (!state?.imported || !self) return;
  run('learn-notice', '正在分析聊天并整理你的语气…', async () => {
    const imported = state.imported;
    const other = imported.participants.find((person) => person.name !== self)?.name;
    const name = imported.participants.length === 2 ? other : imported.name;
    const next = await request('/api/learn', 'POST', {
      importId: imported.id,
      self,
      name,
      withAi: !$('learn-ai-row').hidden && $('learn-ai').checked,
      transcribeVoices: !$('learn-audio-row').hidden && $('learn-audio').checked,
    });
    selectProfile(next.profiles.at(-1)?.id);
    applyState(next);
    notice('learn-notice');
    $('continue-reply').focus();
  }, [$('learn-button')]);
});
$('continue-reply').addEventListener('click', () => showPanel('reply'));
$('download-skill').addEventListener('click', () => {
  if (!activeProfile() || activeProfile().demo) return;
  const link = node('a');
  link.href = `/api/profiles/${encodeURIComponent(activeProfileId)}/skill`;
  link.download = 'SKILL.md';
  link.click();
});

$('choose-audio').addEventListener('click', () => {
  if (!state?.connected && !state?.offlineVoice) return notice('reply-notice', enableVoiceMessage);
  $('audio-file').click();
});
$('audio-file').addEventListener('change', () => {
  handleAudio($('audio-file').files[0]);
  $('audio-file').value = '';
});
dropFiles($('audio-drop'), (files) => {
  if (files.length === 1) handleAudio(files[0]);
  else notice('reply-notice', '请一次拖入一段语音。', true);
});
$('example-message').addEventListener('click', () => {
  if ($('incoming').value.trim()) $('incoming').value += '\n';
  $('incoming').value += '星期六下午有空吗？想不想去喝咖啡？';
  $('incoming').focus();
});
$('example-audio').addEventListener('click', () => handleAudio(undefined, true));
$('schedule-mode').addEventListener('change', syncScheduleFields);
$('fixed-unit').addEventListener('change', syncScheduleFields);
$('random-unit').addEventListener('change', syncScheduleFields);
$('reply-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const profile = activeProfile();
  const incoming = $('incoming').value.trim();
  if (!profile) return;
  if (!incoming) {
    notice('reply-notice', '请先输入对方的消息，或上传一段语音。', true);
    return $('incoming').focus();
  }
  run('reply-notice', '正在生成并保存回复…', async () => {
    const next = await request('/api/drafts', 'POST', { profileId: profile.id, incoming, schedule: schedule() });
    applyState(next);
    $('incoming').value = '';
    notice('reply-notice');
    toast('回复已保存。');
    if (panel === 'reply') {
      $('queue-card').scrollIntoView({ block: 'nearest' });
      $('queue-heading').focus({ preventScroll: true });
    }
  }, [$('draft-button'), $('choose-audio'), $('example-audio'), $('example-message')]);
});
$('allow-notifications').addEventListener('click', async () => {
  const permission = await Notification.requestPermission();
  renderQueue(activeProfile());
  toast(permission === 'granted' ? '浏览器提醒已开启。' : '到时间仍会在此页面提醒你。');
});

function bind(phone) {
  if (!activeProfile()?.canBind) return;
  return run('bind-notice', phone ? '正在关联此联系人…' : '正在取消关联…', async () => {
    applyState(await request(`/api/profiles/${encodeURIComponent(activeProfileId)}`, 'PATCH', { phone, confirmDirect: Boolean(phone) }));
    notice('bind-notice', phone ? '已保存这个联系人的号码。' : '已取消关联。');
  }, [$('bind-button'), $('unbind-button')]);
}

$('bind-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const phone = $('chat-phone').value.trim();
  if (!/^\+?[1-9][\d\s()-]*$/.test(phone) || !/^\d{7,15}$/.test(phone.replace(/\D/g, ''))) {
    return notice('bind-notice', '请输入完整的号码，包括开头的国家或地区区号。', true);
  }
  phoneToConfirm = `+${phone.replace(/\D/g, '')}`;
  const profile = activeProfile();
  $('confirm-bind-text').textContent = `请确认 ${profile.other || profile.name} 的号码是 ${phoneToConfirm}。之后打开 WhatsApp 就会使用这个号码。`;
  $('confirm-direct').checked = false;
  $('bind-dialog').showModal();
});
$('confirm-bind-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('bind-dialog').close();
  if ($('confirm-direct').checked && phoneToConfirm) bind(phoneToConfirm);
});
$('unbind-button').addEventListener('click', () => bind(''));

syncScheduleFields();
refresh(true);
window.setInterval(() => refresh(), 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
