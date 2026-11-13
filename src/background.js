// Service worker: owns the translation session (start/stop, offscreen document, relay to the Meet tab).
// Session state lives in chrome.storage.session because the worker can be restarted at any time.
importScripts('defaults.js');

const MEET_PREFIX = 'https://meet.google.com/';
const EMPTY = { active: false, sid: null, lang: null, tabId: null, path: null, ui: null, state: null, message: null };

const newSid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

let session = null; // in-memory cache of the stored session
let chain = Promise.resolve(); // serialises start/stop so they never interleave

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function loadSession() {
  if (session) return session;
  let stored = null;
  try {
    ({ mtSession: stored } = await chrome.storage.session.get('mtSession'));
  } catch (_) { /* storage.session unavailable */ }
  // After a worker restart several events can load at once: the first read wins, and a later one must not
  // overwrite a session that was saved meanwhile (e.g. a relayed status) with its older snapshot.
  if (!session) session = { ...EMPTY, ...(stored || {}) };
  return session;
}

async function saveSession(patch) {
  const cur = await loadSession();
  session = { ...cur, ...patch };
  try {
    await chrome.storage.session.set({ mtSession: session });
  } catch (_) { /* storage.session unavailable: memory copy is enough */ }
  return session;
}

function enqueue(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

function meetPath(url) {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch (_) {
    return null;
  }
}

async function hasOffscreen() {
  if (chrome.runtime.getContexts) {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    return ctx.length > 0;
  }
  return false;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    // USER_MEDIA only: an AUDIO_PLAYBACK document is closed by Chrome after 30 s without sound.
    reasons: ['USER_MEDIA'],
    justification: 'Process live meeting audio: speech recognition, translation and speech synthesis.',
  });
}

async function closeOffscreen() {
  try {
    if (await hasOffscreen()) await chrome.offscreen.closeDocument();
  } catch (_) { /* already closed */ }
}

// The offscreen script may not have registered its listener right after createDocument resolves.
async function sendToOffscreen(msg) {
  let lastErr;
  for (let i = 0; i < 10; i++) {
    try {
      await chrome.runtime.sendMessage(msg);
      return;
    } catch (err) {
      lastErr = err;
      await sleep(150);
    }
  }
  throw lastErr || new Error('offscreen unreachable');
}

function turkishError(err) {
  const text = String((err && err.message) || err || '');
  if (/active stream/i.test(text)) return 'Bu sekmenin sesi zaten yakalanıyor. Sekmeyi yenileyip tekrar deneyin.';
  if (/Extension has not been invoked|activeTab/i.test(text)) return 'Sekme erişimi verilmedi. Uzantı simgesine tıklayarak açıp tekrar deneyin.';
  if (/Cannot access|No tab/i.test(text)) return 'Sekmeye erişilemedi. Meet sekmesini yenileyip tekrar deneyin.';
  return 'Çeviri başlatılamadı: ' + text;
}

const UNREACHABLE = 'Meet sekmesine ulaşılamadı. Uzantıyı yükledikten sonra Meet sekmesini yenileyin.';

/** Stops the page side of a tab; an error is shown there first (the overlay keeps it in its bar). */
async function stopTab(tabId, finalState) {
  if (finalState && finalState.state === 'error' && finalState.message) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'status', state: 'error', message: finalState.message });
    } catch (_) { /* tab gone or no content script */ }
  }
  try { await chrome.tabs.sendMessage(tabId, { type: 'mt-stop' }); } catch (_) { /* tab gone or no content script */ }
}

/**
 * Stops the engine and (unless it is `keepTabId`, about to be restarted) the page side.
 * Restarting on the same tab skips mt-stop there: stopping would un-mute the user's real voice
 * for the moment between stop and start (a language switch must not leak the original voice).
 * `finalState` ({state, message}) is kept for the popup; an error is also shown in the overlay.
 */
async function stopSessionNow(finalState, { keepTabId = null } = {}) {
  const cur = await loadSession();
  const tabId = cur.tabId;
  const wasActive = cur.active || (await hasOffscreen());
  if (wasActive) {
    try { await chrome.runtime.sendMessage({ to: 'offscreen', type: 'stop' }); } catch (_) { /* offscreen may be gone */ }
    if (tabId != null && tabId !== keepTabId) await stopTab(tabId, finalState);
    await closeOffscreen();
  }
  await saveSession({ ...EMPTY, ...(finalState || {}) });
}

/** Whether the tab's content script answers (a tab opened before the extension was installed does not). */
async function pingTab(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'mt-ping' });
    return !!(res && res.ok);
  } catch (_) {
    return false;
  }
}

// Right after a previous capture of the same tab ends, Chrome can briefly still report an active stream.
async function tabStreamId(tabId) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    } catch (err) {
      if (attempt >= 3 || !/active stream/i.test(String((err && err.message) || err))) throw err;
      await sleep(300);
    }
  }
}

function uiSettings(s) {
  return {
    originalVoice: s.originalVoice,
    incomingSource: s.incomingSource,
    captionSize: s.captionSize,
    showLatency: s.showLatency,
  };
}

async function startSession(lang, tabId) {
  const s = await self.MT.loadSettings();
  if (!s.elevenKey || !s.anthropicKey) {
    return { ok: false, error: 'Önce API anahtarlarını girin (.env dosyası veya Ayarlar).' };
  }
  if (!lang || lang === 'en' || !self.MT.LANGS.some(([c]) => c === lang)) {
    return { ok: false, error: 'Çeviri için İngilizce dışında bir dil seçin.' };
  }

  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch (_) {
    return { ok: false, error: 'Sekme bulunamadı.' };
  }
  if (!tab.url || !tab.url.startsWith(MEET_PREFIX)) {
    return { ok: false, error: 'Bir Google Meet sekmesi açın.' };
  }

  // The page side must answer before anything changes: otherwise a tab capture would be created
  // for a tab that can never use it (and a running session would be stopped for nothing).
  if (!(await pingTab(tabId))) return { ok: false, error: UNREACHABLE };

  // Also clears any previous error state. A restart on the same tab keeps that tab's page side running.
  await stopSessionNow(null, { keepTabId: tabId });

  // Tab capture (the default incoming source) needs the popup click (activeTab).
  let streamId;
  if (s.incomingSource === 'tab') {
    try {
      streamId = await tabStreamId(tabId);
    } catch (err) {
      const error = turkishError(err);
      // A language switch left this tab's page side running (muted): stop it, showing why.
      await stopTab(tabId, { state: 'error', message: error });
      await saveSession({ state: 'error', message: error });
      return { ok: false, error };
    }
  }

  // Record the session first so any failure below also sends mt-stop to the tab.
  const ui = uiSettings(s);
  const sid = newSid();
  await saveSession({ active: true, sid, lang, tabId, path: meetPath(tab.url), ui, state: 'connecting', message: null });

  // Activate the page side before the engine: it must forward mic/remote audio as soon as the engine is up.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'mt-start', lang, ui });
  } catch (_) {
    await stopSessionNow({ state: 'error', message: UNREACHABLE });
    return { ok: false, error: UNREACHABLE };
  }

  try {
    await ensureOffscreen();
    await sendToOffscreen({ to: 'offscreen', type: 'start', sid, lang, settings: s, streamId });
  } catch (err) {
    // Keep the error (popup) and show it in the overlay, whose bar stays with Kapat / Tanı.
    const error = turkishError(err);
    await stopSessionNow({ state: 'error', message: error });
    return { ok: false, error };
  }
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.to && msg.to !== 'background') return false; // mic/remote chunks are for the offscreen document

  switch (msg.type) {
    case 'mt-start':
      enqueue(() => startSession(msg.lang, msg.tabId)).then(sendResponse, (err) =>
        sendResponse({ ok: false, error: turkishError(err) }));
      return true;

    case 'mt-stop': {
      // The overlay may say why it stopped (e.g. the call was left): kept for the popup as a stopped state.
      const reason = typeof msg.reason === 'string' && msg.reason.trim() ? msg.reason.trim().slice(0, 300) : null;
      const fromTab = sender && sender.tab ? sender.tab.id : null;
      enqueue(async () => {
        const s = await loadSession();
        if (fromTab != null && s.active && s.tabId !== fromTab) return; // a page only stops its own session
        await stopSessionNow(reason ? { state: 'stopped', message: reason } : null);
      }).then(() => sendResponse({ ok: true }), () => sendResponse({ ok: true }));
      return true;
    }

    case 'mt-status':
      loadSession().then((s) => sendResponse({
        active: s.active, lang: s.lang, tabId: s.tabId, state: s.state, message: s.message, ui: s.ui,
        senderTabId: sender && sender.tab ? sender.tab.id : null,
      }));
      return true;

    case 'relay':
      loadSession().then(async (s) => {
        if (!s.active || !msg.msg) return;
        if (msg.sid != null && msg.sid !== s.sid) return; // late output of a previous engine
        if (msg.msg.type === 'status') {
          await saveSession({ state: msg.msg.state || s.state, message: msg.msg.message || null });
        }
        if (s.tabId != null) {
          try { await chrome.tabs.sendMessage(s.tabId, msg.msg); } catch (_) { /* ignore */ }
        }
      });
      return false;

    case 'engine-stopped': {
      const reason = msg.reason || 'Çeviri motoru durdu.';
      // The engine echoes its session id; older engines do not, so fall back to the session current on
      // receipt. Either way a report that arrives while a restart is queued cannot stop the new session.
      const sidAtReceipt = msg.sid != null ? msg.sid : (session ? session.sid : undefined);
      enqueue(async () => {
        const s = await loadSession();
        if (!s.active) return;
        if (sidAtReceipt !== undefined && sidAtReceipt !== s.sid) return;
        await stopSessionNow({ state: 'error', message: reason });
      });
      return false;
    }

    default:
      return false;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  loadSession().then((s) => {
    if (s.active && s.tabId === tabId) enqueue(() => stopSessionNow());
  });
});

// Leaving the call (or Meet) changes the URL path: end the session so nothing keeps streaming.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  loadSession().then((s) => {
    if (!s.active || s.tabId !== tabId) return;
    const left = !changeInfo.url.startsWith(MEET_PREFIX) || (s.path && meetPath(changeInfo.url) !== s.path);
    if (left) enqueue(() => stopSessionNow());
  });
});
