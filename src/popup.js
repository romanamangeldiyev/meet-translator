const LANGS = self.MT.LANGS;
const MEET_PREFIX = 'https://meet.google.com/';
const MODEL_LABELS = {
  'claude-opus-5-5': 'Claude Opus 5.5',
  'claude-fable-5-2': 'Claude Fable 5.2',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5',
  'claude-haiku-5-5': 'Claude Haiku 5.5',
};
const TTS_LABELS = {
  eleven_v4_turbo: 'ElevenLabs v4 Turbo',
  eleven_flash_v2_5: 'ElevenLabs Flash v2.5',
  eleven_v3: 'ElevenLabs v3',
};

const $ = (id) => document.getElementById(id);
const grid = $('langs');
const hint = $('hint');
const toggle = $('toggle');
const statusEl = $('status');
const metaEl = $('meta');

let lang = 'tr';
let tabId = null;
let isMeet = false;
let hasKeys = false;
let session = { active: false, lang: null, tabId: null, state: null, message: null };
let busy = false;
let startError = null; // last failed start, kept across polls
let pollTimer = null;
let enHint = false; // English picked during a running session: show the hint, keep the session's language

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      void chrome.runtime.lastError;
      resolve(res);
    });
  });
}

function setStatus(text, kind) {
  statusEl.textContent = text || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function openSettings() { chrome.runtime.openOptionsPage(); }

async function start(code) {
  startError = null;
  busy = true;
  render();
  setStatus(session.active ? 'Dil değiştiriliyor…' : 'Başlatılıyor…');
  const res = await send({ type: 'mt-start', lang: code, tabId });
  busy = false;
  if (!res || !res.ok) startError = (res && res.error) || 'Çeviri başlatılamadı.';
  await refreshSession();
}

function onPick(code) {
  if (busy) return;
  enHint = false;
  if (sessionHere()) {
    // A running session keeps its language selected: English needs no translation (hint only, the
    // session goes on in its language); another language restarts it in that language.
    if (code === 'en') {
      enHint = true;
      render();
      return;
    }
    if (code !== session.lang) {
      lang = code;
      chrome.storage.local.set({ lang });
      start(code);
      return;
    }
  }
  lang = code;
  startError = null;
  chrome.storage.local.set({ lang });
  render();
}

function renderLangs() {
  grid.textContent = '';
  for (const [code, label] of LANGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill' + (code === lang ? ' selected' : '');
    b.textContent = label;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(code === lang));
    b.disabled = busy || (session.active && !sessionHere());
    b.addEventListener('click', () => onPick(code));
    grid.appendChild(b);
  }
}

// Whether this session is the one running in the tab the popup was opened on.
const sessionHere = () => session.active && session.tabId === tabId;

function render() {
  renderLangs();
  if (!sessionHere()) enHint = false;
  hint.hidden = lang !== 'en' && !enHint;
  statusEl.onclick = null;

  const running = session.active;
  toggle.textContent = running ? 'Çeviriyi durdur' : 'Çeviriyi başlat';
  toggle.classList.toggle('stop', running);

  if (busy) {
    toggle.disabled = true;
    return;
  }

  if (running) {
    toggle.disabled = false;
    const where = sessionHere() ? '' : ' (başka bir Meet sekmesinde)';
    if (session.state === 'live') setStatus('Çeviri aktif' + where + '.', 'ok');
    else if (session.state === 'error') setStatus(session.message || 'Bir hata oluştu.', 'error');
    else setStatus('Bağlanıyor' + where + '…');
    return;
  }

  if (!isMeet) {
    toggle.disabled = true;
    setStatus('Bir Google Meet sekmesi açın.');
    return;
  }
  if (!hasKeys) {
    toggle.disabled = false;
    setStatus('Önce API anahtarlarını girin (.env veya Ayarlar).', 'error link');
    statusEl.onclick = openSettings;
    return;
  }
  toggle.disabled = lang === 'en';
  if (startError) setStatus(startError, 'error');
  else if (session.state === 'error' && session.message) setStatus(session.message, 'error');
  else if (session.state === 'stopped' && session.message) setStatus(session.message); // e.g. the call was left
  else setStatus(lang === 'en' ? '' : 'Hazır.');
}

async function refreshSession() {
  const res = await send({ type: 'mt-status' });
  if (res) session = res;
  render();
}

toggle.addEventListener('click', async () => {
  if (busy) return;
  if (session.active) {
    busy = true; render();
    await send({ type: 'mt-stop' });
    busy = false;
    await refreshSession();
    return;
  }
  if (!hasKeys) { openSettings(); return; }
  if (!isMeet || lang === 'en') return;
  start(lang);
});

$('settings').addEventListener('click', (e) => { e.preventDefault(); openSettings(); });

async function init() {
  const [settings, store, tabs] = await Promise.all([
    self.MT.loadSettings(),
    chrome.storage.local.get('lang'),
    chrome.tabs.query({ active: true, currentWindow: true }),
  ]);
  hasKeys = Boolean(settings.elevenKey && settings.anthropicKey);
  const fast = settings.fastMode && /opus|fable/.test(settings.claudeModel) ? ' (hızlı)' : '';
  metaEl.textContent = `${MODEL_LABELS[settings.claudeModel] || settings.claudeModel}${fast} · ${TTS_LABELS[settings.ttsModel] || settings.ttsModel}`;
  if (LANGS.some(([c]) => c === store.lang)) lang = store.lang;
  const tab = tabs[0];
  tabId = tab ? tab.id : null;
  isMeet = Boolean(tab && tab.url && tab.url.startsWith(MEET_PREFIX));
  await refreshSession();
  if (session.active && session.lang && LANGS.some(([c]) => c === session.lang)) {
    lang = session.lang;
    render();
  }
  pollTimer = setInterval(refreshSession, 1000);
}

window.addEventListener('unload', () => clearInterval(pollTimer));
init();
