// Offscreen engine host (v2): remote meeting audio -> "in" STT socket, my mic -> "out" STT socket, both feeding
// the translation core (engine/core.js), which emits captions / metrics / TTS audio for the Meet tab.
// Everything arrives via chrome.runtime messages (no chrome.storage / chrome.tabs here).
import { SttSocket, fetchRealtimeToken } from './engine/stt.js';
import { forwardMic, overlapsIncoming } from './engine/echo.js';
import { createEngineCore } from './engine/core.js';
import { startTabCapture } from './engine/audio.js';
import { FatalError, LANG_NAMES, isAbortError } from './engine/util.js';

const IN_SILENCE_SECS = 0.8;
const OUT_SILENCE_SECS = 0.7;
const SOFT_STATUS_INTERVAL_MS = 10000;

let session = null;

function send(msg) {
  try {
    const p = chrome.runtime.sendMessage(msg);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (_) { /* extension context gone */ }
}
// Every message names the session it belongs to (`sid` from the start message), so the background can ignore
// a previous engine's late messages. `sid` may be undefined for older callers; it is passed through as is.
const relay = (s, msg) => send({ to: 'background', type: 'relay', sid: s.sid, msg });
const DIAG_INTERVAL_MS = 1000;
const relayStatus = (s, state, message) => relay(s, message ? { type: 'status', state, message } : { type: 'status', state });

const isFatal = (e) => !!e && (e instanceof FatalError || e.fatal === true);
const reasonOf = (e, fallback) => (e && typeof e.message === 'string' && e.message ? e.message : fallback);

// ---- session lifecycle ------------------------------------------------------------------------

function newSession(sid, lang, settings, tabMode) {
  const s = {
    sid,
    lang,
    settings,
    tabMode,
    stopped: false,
    abort: new AbortController(),
    cleanups: [],
    core: null,
    inSock: null,
    outSock: null,
    warm: false, // core.warmup() resolved
    inReady: false, // the in socket sent session_started at least once
    live: false, // 'live' was relayed and nothing went back to 'connecting' since
    reconnecting: new Set(), // sockets waiting in backoff
    lastSoftAt: 0,
  };
  // Register a disposer; if the session is already torn down, run it immediately.
  s.defer = (fn) => {
    if (s.stopped) {
      try { fn(); } catch (_) { /* ignore */ }
    } else {
      s.cleanups.push(fn);
    }
  };
  return s;
}

function teardown(s) {
  if (s.stopped) return;
  s.stopped = true;
  try { s.abort.abort(); } catch (_) { /* ignore */ }
  while (s.cleanups.length) {
    const fn = s.cleanups.pop();
    try { fn(); } catch (_) { /* ignore */ }
  }
}

function stopEngine({ silent }) {
  const s = session;
  if (!s) return;
  session = null;
  teardown(s);
  if (!silent) relayStatus(s, 'stopped');
}

function fatal(s, reason) {
  if (!s || s.stopped) return;
  const why = typeof reason === 'string' && reason ? reason : 'Çeviri motoru durdu.';
  relayStatus(s, 'error', why);
  send({ to: 'background', type: 'engine-stopped', sid: s.sid, reason: why });
  if (session === s) session = null;
  teardown(s);
}

function softNotice(s, e) {
  const now = Date.now();
  if (s.stopped || !s.live || now - s.lastSoftAt < SOFT_STATUS_INTERVAL_MS) return;
  s.lastSoftAt = now;
  const detail = e && e.status ? ` (HTTP ${e.status})` : '';
  relayStatus(s, 'live', `Bir cümle işlenemedi${detail}.`);
}

/** Runs a core/pipeline call; a throw or a rejection never escapes (fatal ones stop the engine). */
function guard(s, fn) {
  const fail = (e) => {
    if (s.stopped || isAbortError(e)) return;
    if (isFatal(e)) fatal(s, reasonOf(e, 'Çeviri motoru durdu.'));
    else softNotice(s, e);
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') r.then(undefined, fail);
  } catch (e) {
    fail(e);
  }
}

// ---- status gating ----------------------------------------------------------------------------

// Live once the in socket has a session AND warmup resolved, with no socket waiting in backoff.
function updateLive(s) {
  if (s.stopped || s.live || !s.warm || !s.inReady || s.reconnecting.size) return;
  s.live = true;
  relayStatus(s, 'live');
}

function socketReady(s, dir) {
  if (s.stopped) return;
  s.reconnecting.delete(dir);
  if (dir === 'in') s.inReady = true;
  if (dir === 'out') coreCall(s, 'setOutReady', true);
  updateLive(s);
}

function socketReconnecting(s, dir) {
  if (s.stopped) return;
  s.reconnecting.add(dir);
  s.live = false;
  if (dir === 'out') coreCall(s, 'setOutReady', false);
  relayStatus(s, 'connecting', 'Yeniden bağlanıyor…');
}

/** Optional core hooks (setOutReady / setMuted); never throws. */
function coreCall(s, method, arg) {
  const core = s.core;
  if (s.stopped || !core || typeof core[method] !== 'function') return;
  guard(s, () => core[method](arg));
}

// ---- engine start -----------------------------------------------------------------------------

function startEngine(msg) {
  stopEngine({ silent: true });
  const settings = msg.settings && typeof msg.settings === 'object' ? msg.settings : {};
  const lang = typeof msg.lang === 'string' ? msg.lang : '';
  const tabMode = settings.incomingSource === 'tab';
  const s = newSession(msg.sid, lang, settings, tabMode);
  session = s;

  if (!lang || lang === 'en' || !Object.prototype.hasOwnProperty.call(LANG_NAMES, lang)) {
    return fatal(s, 'Geçersiz dil seçimi.');
  }
  if (!settings.elevenKey || !settings.anthropicKey) return fatal(s, "API anahtarları eksik. Ayarlar'dan girin.");
  if (tabMode && !msg.streamId) return fatal(s, 'Sekme sesi için akış kimliği eksik.');

  relayStatus(s, 'connecting', 'Bağlanıyor…');

  let core;
  try {
    core = createEngineCore({
      settings,
      lang,
      emit: (m) => { if (!s.stopped && m) relay(s, m); },
      signal: s.abort.signal,
      onFatal: (reason) => fatal(s, reason),
      onSoftError: (e) => softNotice(s, e),
    });
  } catch (e) {
    return fatal(s, isFatal(e) ? reasonOf(e, '') : `Çeviri motoru başlatılamadı: ${reasonOf(e, String(e))}`);
  }
  s.core = core;
  s.defer(() => { if (core && typeof core.dispose === 'function') core.dispose(); });
  if (s.stopped) return; // the core reported a fatal error while being created

  const getToken = (signal) => fetchRealtimeToken(settings.elevenKey, signal);
  const onFatal = (reason) => fatal(s, reason);
  const toPipe = (pipe, method) => (text, meta) => {
    if (s.stopped || !core[pipe] || typeof core[pipe][method] !== 'function') return;
    guard(s, () => core[pipe][method](text, meta));
  };

  // Incoming: the other side (lang, sometimes English) -> English captions.
  s.inSock = new SttSocket({
    label: 'gelen ses',
    lang,
    secondaryLanguages: ['en'],
    silenceSecs: IN_SILENCE_SECS,
    keyterms: settings.glossary,
    filterBackgroundAudio: false,
    getToken,
    onPartial: toPipe('inPipe', 'partial'),
    onCommitted: toPipe('inPipe', 'commit'),
    onReady: () => socketReady(s, 'in'),
    onReconnecting: () => socketReconnecting(s, 'in'),
    onFatal,
  });
  s.defer(() => s.inSock.close());

  // Outgoing: my English (sometimes lang) -> lang captions + speech. Eager: connected now, not on first audio.
  const outCommit = toPipe('outPipe', 'commit');
  s.outSock = new SttSocket({
    label: 'mikrofon',
    lang: 'en',
    secondaryLanguages: [], // SELF speaks English: no language guessing (accented English was taken for Turkish)
    silenceSecs: OUT_SILENCE_SECS,
    keyterms: settings.glossary,
    filterBackgroundAudio: true, // ignores background speech / the meeting leaking from the speakers
    getToken,
    onPartial: toPipe('outPipe', 'partial'),
    // overlap:false = no incoming voice during this segment: the text echo guard does not apply to it.
    onCommitted: (text, meta) => outCommit(text, { ...meta, overlap: overlapsIncoming(s.inSock, meta) }),
    onReady: () => socketReady(s, 'out'),
    onReconnecting: () => socketReconnecting(s, 'out'),
    onFatal,
  });
  s.defer(() => s.outSock.close());
  coreCall(s, 'setOutReady', false); // connecting: the voice passthrough starts if this takes > 3 s

  // Warm up Claude / TTS (key + model + voice checks, TLS) while both sockets connect.
  let warm;
  try {
    warm = Promise.resolve(typeof core.warmup === 'function' ? core.warmup() : undefined);
  } catch (e) {
    warm = Promise.reject(e);
  }
  warm.then(
    () => {
      if (s.stopped) return;
      s.warm = true;
      updateLive(s);
    },
    (e) => {
      if (s.stopped) return;
      if (isFatal(e)) {
        fatal(s, reasonOf(e, 'Çeviri motoru başlatılamadı.'));
        return;
      }
      s.warm = true; // warmup is best effort; only FatalError stops the engine
      updateLive(s);
    },
  );

  s.inSock.connect();
  s.outSock.connect();

  // Diagnostics for the overlay's "Tanı" panel (~1/s): audio levels, connection states, counters.
  const diagTimer = setInterval(() => {
    if (s.stopped) return;
    try {
      relay(s, { type: 'diag', capture: tabMode ? 'tab' : 'page', in: s.inSock.stats(), out: s.outSock.stats() }); // out.gated: echo-gated chunks
    } catch (_) { /* diagnostics must never break the engine */ }
  }, DIAG_INTERVAL_MS);
  s.defer(() => clearInterval(diagTimer));

  if (tabMode) startTabAudio(s, msg.streamId);
}

function startTabAudio(s, streamId) {
  startTabCapture({
    streamId,
    signal: s.abort.signal,
    onChunk: (b64) => { if (!s.stopped) s.inSock.sendAudio(b64); },
    onEnded: () => fatal(s, 'Sekme sesi kesildi.'),
  }).then(
    (capture) => s.defer(() => capture.stop()),
    (e) => {
      if (s.stopped) return;
      const why = e && e.message ? `: ${e.message}` : '';
      fatal(s, `Sekme sesi alınamadı${why}`);
    },
  ).catch(() => {});
}

// ---- messages ---------------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object' || msg.to !== 'offscreen') return false;
  const s = session;
  try {
    if (msg.type === 'mic') {
      if (s && !s.stopped && s.outSock && typeof msg.b64 === 'string') forwardMic(s.inSock, s.outSock, s.settings, msg.b64, Date.now());
    } else if (msg.type === 'mic-muted') {
      // Meet mute: commit what was said so far (never merged with speech after unmuting); while muted,
      // utterances not spoken yet are skipped (nobody would hear them).
      if (s && !s.stopped && s.outSock) {
        const muted = msg.muted === true;
        if (muted) s.outSock.commitNow();
        coreCall(s, 'setMuted', muted);
      }
    } else if (msg.type === 'remote') {
      // Page capture only; in tab mode the incoming audio comes from engine/audio.js.
      if (s && !s.stopped && !s.tabMode && s.inSock && typeof msg.b64 === 'string') s.inSock.sendAudio(msg.b64);
    } else if (msg.type === 'start') {
      try {
        startEngine(msg);
      } catch (e) {
        if (session) fatal(session, `Motor başlatılamadı: ${reasonOf(e, String(e))}`);
      }
      sendResponse({ ok: true });
    } else if (msg.type === 'stop') {
      stopEngine({ silent: false });
      sendResponse({ ok: true });
    }
  } catch (_) { /* never throw out of the listener */ }
  return false;
});

// Safety net: a stray rejection must not take the engine down or spam the console with keys/payloads.
self.addEventListener('unhandledrejection', (ev) => ev.preventDefault());
