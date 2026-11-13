// ElevenLabs Scribe v3 Live realtime STT socket (v2).
// - Fresh single-use token for every (re)connect, exponential backoff, ~2 s audio buffer while (re)connecting (v1).
// - Language detection: exactly ONE commit per segment, carrying the detected language.
// - Optional query params are dropped one by one when the server rejects a session before it starts.
// - Silence keepalive (the server closes a session after 15 s without client messages).
// - previous_text context on the first audio chunk of every connection.
import { bytesToBase64, normalizeLang } from './util.js';

const WS_BASE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';

/** Optional query params, in the order they are dropped when the server rejects a session. */
export const OPTIONAL_PARAMS = Object.freeze([
  'keyterms', 'filter_background_audio', 'secondary_languages', 'include_language_detection', 'no_verbatim',
]);
export const MAX_KEYTERMS = 50;
export const MAX_KEYTERM_CHARS = 20;
export const PREVIOUS_TEXT_MAX_CHARS = 50;
/** 100 ms of 16 kHz PCM16 silence (3200 zero bytes), computed once. */
export const SILENCE_CHUNK_B64 = bytesToBase64(new Uint8Array(3200));

/** Digital silence as long as the PCM16 chunk `b64` (so a gated chunk keeps the audio timeline intact). */
export function silenceLike(b64) {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  let n = Math.floor(b64.length / 4) * 3 - pad;
  n -= n % 2;
  if (n <= 0 || n === 3200) return SILENCE_CHUNK_B64;
  return bytesToBase64(new Uint8Array(n));
}

const FATAL_MESSAGES = {
  auth_error: "ElevenLabs API anahtarı geçersiz. Ayarlar'dan düzeltin.",
  quota_exceeded: 'ElevenLabs kotanız doldu.',
  unaccepted_terms: 'ElevenLabs şartları kabul edilmemiş; elevenlabs.io hesabınızdan kabul edin.',
};
const PERMISSION_MESSAGE = 'ElevenLabs API anahtarında "Speech to Text" izni yok.';
const IGNORED_TYPES = new Set(['warning', 'commit_throttled', 'insufficient_audio_activity']);
const REJECT_TYPES = new Set(['invalid_request', 'input_error']); // before session_started: params refused
const TRANSIENT_TYPES = new Set(['rate_limited', 'queue_overflow', 'resource_exhausted']); // never about params
const ERROR_TYPES = new Set(['error', 'chunk_size_exceeded', 'transcriber_error', ...REJECT_TYPES, ...TRANSIENT_TYPES]);
const SEND_BACKLOG_BYTES = 512 * 1024; // network can't keep up: drop audio rather than lag
const STALL_BYTES = 96 * 1024; // ~2-3 s of queued audio messages
const SIBLING_MEMORY_MS = 2000; // how long an emitted commit waits for its other variant before it is forgotten
/** A partial that ends a sentence: terminal punctuation, optionally followed by closing quotes/brackets. */
const SENTENCE_END_RE = /[.?!…。？！]["'”’»)\]]*$/;

/** Loudness of a base64 PCM16 LE chunk in dBFS (-100 for digital silence), or null if it cannot be read. */
export function chunkLevelDb(b64) {
  let bin;
  try {
    bin = atob(b64);
  } catch (_) {
    return null;
  }
  const n = bin.length >> 1;
  if (!n) return null;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
    if (v >= 0x8000) v -= 0x10000;
    sum += v * v;
  }
  const rms = Math.sqrt(sum / n) / 32768;
  return rms > 0.00001 ? Math.max(-100, 20 * Math.log10(rms)) : -100;
}

export class HttpError extends Error {
  constructor(status, message, body = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.body = body;
  }
}

/** Glossary -> keyterms: trimmed strings of at most 20 characters (longer ones skipped), de-duplicated, max 50. */
export function filterKeyterms(glossary) {
  const list = typeof glossary === 'string' ? glossary.split(/[\n,;]+/) : glossary;
  const out = [];
  if (!Array.isArray(list)) return out;
  const seen = new Set();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const term = raw.replace(/\s+/g, ' ').trim();
    if (!term || Array.from(term).length > MAX_KEYTERM_CHARS || seen.has(term)) continue;
    seen.add(term);
    out.push(term);
    if (out.length >= MAX_KEYTERMS) break;
  }
  return out;
}

/** Last <= max characters of a committed text, cut at a word boundary ('' when the tail has no boundary). */
export function tailForContext(text, max = PREVIOUS_TEXT_MAX_CHARS) {
  const chars = Array.from(String(text == null ? '' : text).replace(/\s+/g, ' ').trim());
  if (chars.length <= max) return chars.join('');
  const cut = chars.length - max;
  let tail = chars.slice(cut);
  if (chars[cut - 1] !== ' ' && tail[0] !== ' ') {
    const space = tail.indexOf(' '); // the cut splits a word: drop its remainder
    if (space < 0) return '';
    tail = tail.slice(space + 1);
  }
  return tail.join('').trim();
}

function secondaryOf(cfg) {
  const list = Array.isArray(cfg.secondaryLanguages) ? cfg.secondaryLanguages : [];
  const out = [];
  for (const l of list) {
    if (typeof l === 'string' && l && l !== cfg.lang && !out.includes(l)) out.push(l);
  }
  return out;
}

/** Optional params the URL for `cfg` would carry once `dropped` are removed, in degradation order. */
export function optionalParamsInUse(cfg, dropped) {
  const d = new Set(dropped || []);
  return OPTIONAL_PARAMS.filter((p) => {
    if (d.has(p)) return false;
    if (p === 'keyterms') return filterKeyterms(cfg.keyterms).length > 0;
    if (p === 'filter_background_audio') return !!cfg.filterBackgroundAudio;
    if (p === 'secondary_languages') return secondaryOf(cfg).length > 0;
    return true;
  });
}

/**
 * cfg: { lang, secondaryLanguages?, silenceSecs, keyterms?, filterBackgroundAudio?, dropped?: Iterable, token }
 * List params repeat their key (`&secondary_languages=en&keyterms=a&keyterms=b`); values are percent-encoded.
 * Never sends include_timestamps (incompatible with filter_background_audio).
 */
export function buildSttUrl(cfg) {
  const dropped = new Set(cfg.dropped || []);
  const parts = [];
  const add = (k, v) => parts.push(`${k}=${encodeURIComponent(String(v))}`);
  add('model_id', 'scribe_v3_live');
  add('audio_format', 'pcm_16000');
  add('commit_strategy', 'vad');
  if (Number.isFinite(cfg.silenceSecs)) add('vad_silence_threshold_secs', cfg.silenceSecs);
  if (cfg.lang) add('language_code', cfg.lang);
  if (!dropped.has('secondary_languages')) for (const l of secondaryOf(cfg)) add('secondary_languages', l);
  if (!dropped.has('include_language_detection')) add('include_language_detection', 'true');
  if (!dropped.has('no_verbatim')) add('no_verbatim', 'true');
  if (!dropped.has('keyterms')) for (const t of filterKeyterms(cfg.keyterms)) add('keyterms', t);
  if (cfg.filterBackgroundAudio && !dropped.has('filter_background_audio')) add('filter_background_audio', 'true');
  add('token', cfg.token);
  return `${WS_BASE}?${parts.join('&')}`;
}

export async function fetchRealtimeToken(apiKey, signal, fetchImpl = fetch) {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
    signal,
  });
  if (!res.ok) {
    let body = '';
    try { body = String(await res.text()).slice(0, 500); } catch (_) { /* no body */ }
    throw new HttpError(res.status, `token http ${res.status}`, body);
  }
  const json = await res.json();
  if (!json || !json.token) throw new HttpError(500, 'token missing');
  return json.token;
}

/** Turkish fatal reason for a token failure, or null when it is worth retrying. */
function tokenFatalReason(e) {
  const status = e && e.status;
  if (status !== 401 && status !== 403) return null;
  const body = String((e && e.body) || '');
  if (/missing_permissions/i.test(body)) return PERMISSION_MESSAGE;
  if (/quota_exceeded/i.test(body)) return FATAL_MESSAGES.quota_exceeded;
  return FATAL_MESSAGES.auth_error;
}

const cleanText = (t) => (typeof t === 'string' ? t.trim() : '');

/** Per-segment state: latest partial, the voice heard in it (ms, first/last voiced chunk), gated audio. */
function newSegment(now) {
  return { text: '', changedAt: now, voicedMs: 0, startAt: 0, endAt: 0, gatedMs: 0, committedText: '', openedAt: now };
}
const commitKey = (t) => t.replace(/\s+/g, ' ');

const DEFAULTS = {
  label: 'ses',
  maxRetries: 5,
  giveUpMs: 90000, // a short Wi-Fi drop must not end the meeting: fatal only after BOTH maxRetries and this long
  stallMs: 4000, // an open socket whose send backlog has not drained for this long is reconnected
  // Sentence commits (measured live: with VAD alone a sentence followed by a short pause waited for the next
  // long pause, up to 4 s; a client commit at the sentence end was committed in ~0.7-0.9 s). The server VAD
  // stays on as the fallback. A commit is only sent when the latest partial ends a sentence, has not changed
  // for sentenceStableMs, real voice energy was heard in this segment and the audio has been quiet for
  // sentenceQuietMs (the energy guard keeps hallucinated partials such as "Yeah." in pauses from committing).
  sentenceCommit: true,
  sentenceStableMs: 120,
  sentenceQuietMs: 300,
  sentenceMinVoicedMs: 300,
  sentenceMinWords: 2,
  // A long stretch without sentence punctuation (one 40 s "sentence"): commit at a clause pause once the
  // partial is this long (same energy guard as sentences).
  clauseMinWords: 14,
  clauseQuietMs: 250,
  clientCommitGapMs: 700,
  // Voice energy followed by this much quiet is forgotten: by then a real utterance has been committed (client
  // or VAD), so what is left was a cough / keyboard / leaked echo and must not vouch for a later partial.
  voiceForgetMs: 1500,
  // No audio at all from the consumer for this long while the segment holds voiced, uncommitted text (Meet
  // mute or push-to-talk release: the page stops sending the mic): commit it. Without audio the server VAD
  // never sees the silence it waits for, so the utterance would wait for the next unmute.
  idleCommitMs: 800,
  bufferBytes: 64000, // ~2 s of 16 kHz PCM16
  siblingWaitMs: 250,
  keepaliveMs: 4000,
  connectTimeoutMs: 10000, // token + socket + session_started
  createWebSocket: (url) => new WebSocket(url),
  setTimeout: (f, ms) => setTimeout(f, ms),
  clearTimeout: (t) => clearTimeout(t),
  random: Math.random,
  now: Date.now,
  normalizeLang, // server code (ISO 639-1/-3, BCP47) -> one of the 8 codes or null; injectable for tests
};

/**
 * opts: {
 *   label                       Turkish name for error messages ('gelen ses' / 'mikrofon')
 *   lang                        language_code (the expected language)
 *   secondaryLanguages?         secondary_languages, e.g. ['en']
 *   silenceSecs                 vad_silence_threshold_secs
 *   keyterms?                   raw glossary (filtered: <= 20 chars each, max 50)
 *   filterBackgroundAudio?      filter_background_audio=true (out socket only)
 *   getToken(signal)            -> Promise<string>, a fresh single-use token per (re)connect
 *   onPartial(text, {lang}), onCommitted(text, {lang, at}), onReady(), onReconnecting(n), onFatal(reason)
 *   injectable: createWebSocket(url), setTimeout, clearTimeout, now, random, normalizeLang(code)
 *   tunable: maxRetries, bufferBytes, siblingWaitMs, keepaliveMs, connectTimeoutMs
 * }
 * Callbacks never receive raw server language codes: `lang` is one of the 8 codes or null.
 */
export class SttSocket {
  constructor(opts = {}) {
    const o = { ...DEFAULTS };
    for (const [k, v] of Object.entries(opts)) if (v !== undefined) o[k] = v;
    this.o = o;
    this.cfg = {
      lang: o.lang,
      secondaryLanguages: o.secondaryLanguages,
      silenceSecs: o.silenceSecs,
      keyterms: filterKeyterms(o.keyterms),
      filterBackgroundAudio: !!o.filterBackgroundAudio,
    };
    this.state = 'idle'; // idle | connecting | ready | backoff | closed
    this.cur = null; // current connection attempt
    this.seq = 0;
    this.failures = 0; // consecutive counted failures (reset by a session that lived > 10 s)
    this.failingSince = 0; // when the current failure streak began
    this.preStartCloses = 0; // consecutive attempts that closed before session_started
    this.dropped = new Set(); // optional params the server refused (kept for the whole session)
    this.degradations = 0;
    this.timer = null; // backoff timer
    this.buf = [];
    this.bufBytes = 0;
    this.lastCommitted = ''; // source of previous_text
    this.segLang = null; // language seen in the current segment's partials
    this.pending = []; // plain commits waiting for their _with_timestamps sibling
    this.recent = []; // emitted commits whose other variant may still arrive
    // Sentence-commit state for the segment being spoken + voice energy tracking.
    this.seg = newSegment(0);
    this.lastVoiceAt = 0;
    this.voiceStartAt = 0; // start of the current stretch of voice (echo gate in offscreen.js)
    this.levelHist = []; // dB of the last ~80 chunks (noise floor)
    this.lastClientCommitAt = -Infinity;
    this.lastAudioAt = 0; // last sendAudio / sendSilenceFor call (the consumer's audio, not keepalives)
    // Diagnostics (stats()).
    this.levels = []; // [time, dB] of the last second
    this.counters = { chunks: 0, partials: 0, commits: 0, clientCommits: 0, gated: 0, lastPartialAt: 0, lastCommitAt: 0 };
    this.voiceSpans = []; // [start, end] of the stretches of voice in the last minute (echo-overlap checks)
  }

  /** Snapshot for the overlay's diagnostics panel. */
  stats() {
    const now = this.o.now();
    while (this.levels.length && now - this.levels[0][0] > 1000) this.levels.shift();
    let max = null;
    for (const [, db] of this.levels) if (max === null || db > max) max = db;
    const c = this.counters;
    return {
      state: this.state,
      levelDb: max === null ? null : Math.round(max),
      chunks: c.chunks,
      partials: c.partials,
      commits: c.commits,
      clientCommits: c.clientCommits,
      gated: c.gated,
      lastPartialAgoMs: c.lastPartialAt ? now - c.lastPartialAt : null,
      lastCommitAgoMs: c.lastCommitAt ? now - c.lastCommitAt : null,
    };
  }

  /**
   * Voice energy of an outgoing chunk. Noise floor = the quietest chunk of the last ~8 s, capped at -40 dBFS
   * (so audio that starts mid-speech still has a sane floor); voiced = 12 dB above the floor and above -50 dBFS.
   */
  _trackLevel(b64) {
    const db = chunkLevelDb(b64);
    if (db === null) return;
    const now = this.o.now();
    const ms = Math.max(1, Math.round((b64.length * 3) / 4 / 32)); // 16 kHz mono PCM16: 32 bytes per ms
    this._diagLevel(now, db);
    this.levelHist.push(db);
    if (this.levelHist.length > 80) this.levelHist.shift();
    let floor = -40;
    for (const v of this.levelHist) if (v < floor) floor = v;
    const seg = this.seg;
    if (db > Math.max(floor + 12, -50)) {
      if (!this.lastVoiceAt || now - this.lastVoiceAt > 300) { // a new stretch of voice
        this.voiceStartAt = now;
        this.voiceSpans.push([now, now]);
        while (this.voiceSpans.length > 64 || (this.voiceSpans.length && now - this.voiceSpans[0][1] > 60000)) this.voiceSpans.shift();
      } else if (this.voiceSpans.length) {
        this.voiceSpans[this.voiceSpans.length - 1][1] = now;
      }
      this.lastVoiceAt = now;
      if (!seg.voicedMs) seg.startAt = now;
      seg.voicedMs += ms;
      seg.endAt = now;
    } else if (seg.voicedMs && now - this.lastVoiceAt >= this.o.voiceForgetMs) {
      seg.voicedMs = 0;
      seg.startAt = 0;
      seg.endAt = 0;
      seg.gatedMs = 0;
    }
  }

  /** True when voice energy was heard at any time between `from` and `to` (ms timestamps). */
  voiceDuring(from, to) {
    for (const [a, b] of this.voiceSpans) if (a <= to && b >= from) return true;
    return false;
  }

  /** Level for the diagnostics panel only (max of the last second). */
  _diagLevel(now, db) {
    this.levels.push([now, db]);
    while (this.levels.length && now - this.levels[0][0] > 1000) this.levels.shift();
  }

  _wantsSentenceCommit(now) {
    if (!this.o.sentenceCommit) return false;
    const s = this.seg;
    if (!s.text || s.text === s.committedText) return false;
    if (now - this.lastClientCommitAt < this.o.clientCommitGapMs) return false;
    const words = s.text.split(/\s+/).filter(Boolean).length;
    let quietMs;
    if (SENTENCE_END_RE.test(s.text)) {
      if (words < this.o.sentenceMinWords) return false;
      quietMs = this.o.sentenceQuietMs;
    } else {
      if (!(this.o.clauseMinWords > 0) || words < this.o.clauseMinWords) return false;
      quietMs = this.o.clauseQuietMs;
    }
    if (now - s.changedAt < this.o.sentenceStableMs) return false;
    if (s.voicedMs < this.o.sentenceMinVoicedMs) return false;
    if (!this.lastVoiceAt || now - this.lastVoiceAt < quietMs) return false;
    return true;
  }

  /**
   * The server committed a segment (either variant): the next partials belong to a new one. Returns what the
   * consumer learns about the ended segment: { startAt, endAt, gatedMs } (span of its voice, gated audio).
   */
  _segmentCommitted() {
    const old = this.seg;
    const now = this.o.now();
    this.seg = newSegment(now);
    return { startAt: old.startAt || old.openedAt || now, endAt: old.endAt || now, gatedMs: old.gatedMs };
  }

  connect() {
    if (this.state === 'idle') this._open();
  }

  sendAudio(b64) {
    if (this.state === 'closed' || typeof b64 !== 'string' || !b64) return;
    this._trackLevel(b64);
    this._send(b64);
  }

  /**
   * Echo gate (offscreen.js): the mic chunk `b64` is recognized as digital silence of the same length. That
   * silence is not what the mic heard, so it never feeds the noise floor or the voice tracking (a floor of
   * -100 dB made ordinary room noise count as voice for ~8 s after every gated stretch, which blocked the
   * sentence commits of exactly the replies that follow the other side's speech). The real level still
   * shows in the diagnostics.
   */
  sendSilenceFor(b64) {
    if (this.state === 'closed' || typeof b64 !== 'string' || !b64) return;
    const db = chunkLevelDb(b64);
    if (db !== null) this._diagLevel(this.o.now(), db);
    this.counters.gated++;
    if (this.seg.voicedMs) this.seg.gatedMs += Math.max(1, Math.round((b64.length * 3) / 4 / 32));
    this._send(silenceLike(b64));
  }

  /**
   * Commits the open segment now (the user muted the mic: what they said must not merge with what they say
   * after unmuting). Needs text with some real voice behind it. Returns true when the commit was sent.
   */
  commitNow() {
    const a = this.cur;
    const s = this.seg;
    if (this.state !== 'ready' || !a || !a.ws || a.ws.readyState !== 1) return false;
    if (!s.text || s.text === s.committedText || !s.voicedMs) return false;
    const now = this.o.now();
    if (!this._sendChunk(a, SILENCE_CHUNK_B64, true)) return false;
    this._clientCommitted(now);
    return true;
  }

  _send(b64) {
    this.lastAudioAt = this.o.now();
    const a = this.cur;
    if (this.state === 'ready' && a && a.ws && a.ws.readyState === 1) {
      // A socket that stays open but stops draining (dead route, sleeping NIC) would otherwise eat
      // audio silently until the OS gives up: reconnect once its backlog has not drained for a while.
      if (a.ws.bufferedAmount > STALL_BYTES) {
        const now = this.o.now();
        if (!a.stallSince) {
          a.stallSince = now;
        } else if (now - a.stallSince > this.o.stallMs) {
          this._buffer(b64);
          this._end(a, 'fail');
          return;
        }
      } else {
        a.stallSince = 0;
      }
      if (a.ws.bufferedAmount > SEND_BACKLOG_BYTES) return;
      const now = this.o.now();
      const commit = this._wantsSentenceCommit(now);
      if (this._sendChunk(a, b64, commit) && commit) this._clientCommitted(now);
      this._armIdleCommit(a);
      return;
    }
    this._buffer(b64);
    if (this.state === 'idle') this._open();
  }

  _clientCommitted(now) {
    this.seg.committedText = this.seg.text;
    this.lastClientCommitAt = now;
    this.counters.clientCommits++;
  }

  /** The segment holds text backed by real voice that was not committed yet. */
  _segmentPending() {
    const s = this.seg;
    return !!s.text && s.text !== s.committedText && s.voicedMs >= this.o.sentenceMinVoicedMs;
  }

  /** While ready and the segment is pending: commit it once the consumer sent no audio for idleCommitMs. */
  _armIdleCommit(attempt) {
    if (!attempt || attempt.idleTimer || this.state !== 'ready' || this.cur !== attempt) return;
    if (!this.o.sentenceCommit || !(this.o.idleCommitMs > 0) || !this.lastAudioAt || !this._segmentPending()) return;
    const delay = Math.max(0, this.lastAudioAt + this.o.idleCommitMs - this.o.now());
    attempt.idleTimer = this.o.setTimeout(() => {
      attempt.idleTimer = null;
      if (this.cur !== attempt || this.state !== 'ready') return;
      const now = this.o.now();
      if (now - this.lastAudioAt < this.o.idleCommitMs) {
        this._armIdleCommit(attempt); // audio came in meanwhile
        return;
      }
      if (!this._segmentPending() || !attempt.ws || attempt.ws.readyState !== 1) return;
      if (this._sendChunk(attempt, SILENCE_CHUNK_B64, true)) this._clientCommitted(now);
    }, delay);
  }

  close() {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.timer) this.o.clearTimeout(this.timer);
    this.timer = null;
    const a = this.cur;
    this.cur = null;
    if (a) this._cleanup(a);
    this.buf = [];
    this.bufBytes = 0;
    for (const p of this.pending) if (p.timer) this.o.clearTimeout(p.timer);
    this.pending = [];
    this.recent = [];
  }

  // ---- connection ------------------------------------------------------------------------------

  _open() {
    if (this.state === 'closed') return;
    const attempt = {
      id: ++this.seq,
      ws: null,
      started: false,
      startedAt: 0,
      abort: new AbortController(),
      detect: !this.dropped.has('include_language_detection'),
      sentFirst: false,
      lastSentAt: 0,
      kaTimer: null,
      idleTimer: null,
      connectTimer: null,
    };
    this.cur = attempt;
    this.state = 'connecting';
    attempt.connectTimer = this.o.setTimeout(() => {
      attempt.connectTimer = null;
      this._end(attempt, 'fail');
    }, this.o.connectTimeoutMs);
    this._connect(attempt).catch(() => this._end(attempt, 'fail'));
  }

  async _connect(attempt) {
    let token;
    try {
      token = await this.o.getToken(attempt.abort.signal);
    } catch (e) {
      if (this.cur !== attempt || this.state === 'closed') return; // aborted on purpose
      const reason = tokenFatalReason(e);
      if (reason) this._fatal(reason);
      else this._end(attempt, 'fail');
      return;
    }
    if (this.cur !== attempt || this.state === 'closed') return;
    if (typeof token !== 'string' || !token) {
      this._end(attempt, 'fail');
      return;
    }
    const ws = this.o.createWebSocket(buildSttUrl({ ...this.cfg, dropped: this.dropped, token }));
    attempt.ws = ws;
    ws.onmessage = (ev) => this._onMessage(attempt, ev);
    ws.onerror = () => { /* a close event always follows */ };
    ws.onclose = () => {
      if (this.cur !== attempt) return;
      if (!attempt.started) {
        this._end(attempt, 'prestart');
        return;
      }
      // A healthy session ending is not a failure; dying within 3 s of start is.
      this._end(attempt, this.o.now() - attempt.startedAt < 3000 ? 'fail' : 'quiet');
    };
  }

  _onMessage(attempt, ev) {
    if (this.cur !== attempt || this.state === 'closed') return;
    let msg;
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    } catch (_) {
      return;
    }
    if (!msg || typeof msg.message_type !== 'string') return;
    const t = msg.message_type;

    if (t === 'session_started') this._onStarted(attempt);
    else if (t === 'partial_transcript') this._onPartial(msg);
    else if (t === 'committed_transcript') {
      this._onPlainCommit(attempt, msg, this._segmentCommitted());
    } else if (t === 'committed_transcript_with_timestamps') {
      this._onSiblingCommit(msg, this._segmentCommitted());
    }
    else if (FATAL_MESSAGES[t]) this._fatal(FATAL_MESSAGES[t]);
    else if (t === 'session_time_limit_exceeded') this._end(attempt, 'quiet');
    else if (IGNORED_TYPES.has(t)) { /* informational */ }
    else if (!attempt.started && REJECT_TYPES.has(t)) this._end(attempt, 'reject');
    else if (TRANSIENT_TYPES.has(t)) this._end(attempt, 'fail');
    else if (ERROR_TYPES.has(t) || msg.error != null || /error/i.test(t)) {
      this._end(attempt, attempt.started ? 'fail' : 'prestart');
    }
    // any other message type is informational
  }

  _onStarted(attempt) {
    if (attempt.started) return;
    attempt.started = true;
    this._segmentCommitted(); // a new session starts a new segment (never commit a previous socket's text)
    attempt.startedAt = this.o.now();
    attempt.lastSentAt = attempt.startedAt;
    this.state = 'ready';
    this.preStartCloses = 0;
    if (attempt.connectTimer) this.o.clearTimeout(attempt.connectTimer);
    attempt.connectTimer = null;
    this._flush(attempt);
    this._armKeepalive(attempt, this.o.keepaliveMs);
    this._call(this.o.onReady);
  }

  /**
   * Single place where a connection attempt ends and the next step is decided.
   * how: 'quiet' (healthy end: reconnect at once) | 'fail' (counted failure: backoff)
   *    | 'reject' (params refused before session_started) | 'prestart' (closed before session_started)
   */
  _end(attempt, how) {
    if (this.cur !== attempt || this.state === 'closed') return;
    this.cur = null;
    const alive = attempt.startedAt ? this.o.now() - attempt.startedAt : 0;
    this._cleanup(attempt);
    this._releaseAllPending(); // siblings never arrive from a dead connection
    if (attempt.started) this._flushSegment(); // nor does the commit of what it heard so far
    this.recent = [];
    this.segLang = null;
    if (this.state === 'closed') return; // a consumer stopped us while the commits went out
    if (alive > 10000) this.failures = 0;

    if (how === 'reject' || how === 'prestart') {
      if (how === 'prestart') this.preStartCloses++;
      if ((how === 'reject' || this.preStartCloses >= 2) && this._degrade()) {
        this.preStartCloses = 0;
        this._open(); // retry at once without the dropped param; not a connection failure
        return;
      }
      how = 'fail';
    }

    if (how === 'fail') {
      if (this.failures === 0) this.failingSince = this.o.now();
      this.failures++;
      if (this.failures > this.o.maxRetries && this.o.now() - this.failingSince >= this.o.giveUpMs) {
        this._fatal(`Transkripsiyon bağlantısı kurulamadı (${this.o.label}).`);
        return;
      }
      const base = Math.min(500 * 2 ** (this.failures - 1), 8000);
      const delay = Math.round(base * (0.8 + this.o.random() * 0.4));
      this.state = 'backoff';
      this.timer = this.o.setTimeout(() => {
        this.timer = null;
        if (this.state === 'backoff') this._open();
      }, delay);
      this._call(this.o.onReconnecting, this.failures);
      return;
    }

    this._open();
  }

  /** Drops the next optional param still in use; false when nothing is left (or the cap is reached). */
  _degrade() {
    if (this.degradations >= OPTIONAL_PARAMS.length) return false;
    const next = optionalParamsInUse(this.cfg, this.dropped)[0];
    if (!next) return false;
    this.dropped.add(next);
    this.degradations++;
    return true;
  }

  _cleanup(attempt) {
    if (attempt.connectTimer) this.o.clearTimeout(attempt.connectTimer);
    if (attempt.kaTimer) this.o.clearTimeout(attempt.kaTimer);
    if (attempt.idleTimer) this.o.clearTimeout(attempt.idleTimer);
    attempt.connectTimer = null;
    attempt.kaTimer = null;
    attempt.idleTimer = null;
    try { attempt.abort.abort(); } catch (_) { /* ignore */ }
    const ws = attempt.ws;
    if (!ws) return;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close(1000);
    } catch (_) { /* ignore */ }
  }

  _fatal(reason) {
    if (this.state === 'closed') return;
    this.close();
    this._call(this.o.onFatal, reason);
  }

  // ---- audio -----------------------------------------------------------------------------------

  _sendChunk(attempt, b64, commit = false) {
    const msg = { message_type: 'input_audio_chunk', audio_base_64: b64, commit: !!commit, sample_rate: 16000 };
    if (!attempt.sentFirst) {
      const previous = tailForContext(this.lastCommitted);
      if (previous) msg.previous_text = previous; // only allowed on the first chunk of a connection
    }
    try {
      attempt.ws.send(JSON.stringify(msg));
    } catch (_) {
      return false; // a close event will follow
    }
    attempt.sentFirst = true;
    attempt.lastSentAt = this.o.now();
    this.counters.chunks++;
    return true;
  }

  _buffer(b64) {
    const bytes = Math.floor((b64.length * 3) / 4);
    this.buf.push({ b64, bytes });
    this.bufBytes += bytes;
    while (this.bufBytes > this.o.bufferBytes && this.buf.length > 1) {
      this.bufBytes -= this.buf.shift().bytes;
    }
  }

  _flush(attempt) {
    const items = this.buf;
    this.buf = [];
    this.bufBytes = 0;
    for (const it of items) {
      if (this.cur !== attempt || !attempt.ws || attempt.ws.readyState !== 1) return;
      if (!this._sendChunk(attempt, it.b64)) return;
    }
  }

  /** While ready: after keepaliveMs without any chunk sent, send 100 ms of silence (and again every keepaliveMs). */
  _armKeepalive(attempt, delay) {
    attempt.kaTimer = this.o.setTimeout(() => {
      attempt.kaTimer = null;
      if (this.cur !== attempt || this.state !== 'ready') return;
      let next = attempt.lastSentAt + this.o.keepaliveMs - this.o.now();
      if (next <= 0) {
        if (!attempt.ws || attempt.ws.readyState !== 1 || !this._sendChunk(attempt, SILENCE_CHUNK_B64)) return;
        next = this.o.keepaliveMs;
      }
      this._armKeepalive(attempt, next);
    }, delay);
  }

  // ---- transcripts -----------------------------------------------------------------------------

  _norm(code) {
    if (typeof code !== 'string' || !code) return null;
    try {
      return this.o.normalizeLang(code) || null;
    } catch (_) {
      return null;
    }
  }

  _onPartial(msg) {
    const lang = this._norm(msg.language_code);
    if (lang) this.segLang = lang; // null until enough speech; keep the last one seen in this segment
    const text = cleanText(msg.text);
    if (!text) return;
    const now = this.o.now();
    this.counters.partials++;
    this.counters.lastPartialAt = now;
    if (text !== this.seg.text) {
      this.seg.text = text;
      this.seg.changedAt = now;
    }
    this._armIdleCommit(this.cur); // the last partial may arrive after the mic already stopped
    this._call(this.o.onPartial, text, { lang: this.segLang });
  }

  // A segment arrives as `committed_transcript {text}` and, with language detection on, also as
  // `committed_transcript_with_timestamps {text, language_code}` (either order). Exactly one commit goes out.
  _onPlainCommit(attempt, msg, info) {
    const text = cleanText(msg.text);
    if (!text) {
      this.segLang = null;
      return;
    }
    const key = commitKey(text);
    if (this._consumeRecent(key, 'sibling')) return; // its sibling already went out
    const own = this._norm(msg.language_code);
    const lang = own || this.segLang;
    this.segLang = null;
    const at = this.o.now();
    if (own || !attempt.detect) {
      this._releaseAllPending();
      this._emitCommit(text, lang, at, info);
      this._remember(key, 'plain');
      return;
    }
    const item = { key, text, lang, at, info, timer: null };
    this.pending.push(item);
    item.timer = this.o.setTimeout(() => {
      item.timer = null;
      if (this.pending.includes(item)) this._releaseThrough(item, null, false);
    }, this.o.siblingWaitMs);
  }

  _onSiblingCommit(msg, info) {
    const text = cleanText(msg.text);
    if (!text) return;
    const key = commitKey(text);
    const lang = this._norm(msg.language_code);
    const match = this.pending.find((p) => p.key === key);
    if (match) {
      this._releaseThrough(match, lang, true);
      return;
    }
    if (this._consumeRecent(key, 'plain')) return; // late sibling of a commit that already went out
    const useLang = lang || this.segLang;
    this.segLang = null;
    this._releaseAllPending(); // older segments first
    this._emitCommit(text, useLang, this.o.now(), info);
    this._remember(key, 'sibling');
  }

  /** Emits pending commits in order up to and including `item` (older ones with their fallback language). */
  _releaseThrough(item, lang, matched) {
    while (this.pending.length) {
      const p = this.pending.shift();
      if (p.timer) this.o.clearTimeout(p.timer);
      p.timer = null;
      const hit = p === item;
      this._emitCommit(p.text, (hit && lang) || p.lang, p.at, p.info);
      if (!(hit && matched)) this._remember(p.key, 'plain');
      if (hit) return;
    }
  }

  /**
   * A connection ended mid-utterance (network drop, stall, session time limit): the server will never commit
   * the text it recognized so far, and the replayed buffer only holds the audio after the drop. Emit that text
   * (when real voice backs it) instead of losing the start of the utterance.
   */
  _flushSegment() {
    const s = this.seg;
    const text = cleanText(s.text);
    const lang = this.segLang;
    const info = this._segmentCommitted();
    if (text && s.voicedMs >= this.o.sentenceMinVoicedMs) this._emitCommit(text, lang, this.o.now(), info);
  }

  _releaseAllPending() {
    while (this.pending.length) {
      const p = this.pending.shift();
      if (p.timer) this.o.clearTimeout(p.timer);
      p.timer = null;
      this._emitCommit(p.text, p.lang, p.at, p.info);
      this._remember(p.key, 'plain');
    }
  }

  _emitCommit(text, lang, at, info) {
    this.lastCommitted = text;
    this.counters.commits++;
    this.counters.lastCommitAt = this.o.now();
    const meta = { lang: lang || null, at };
    if (info) {
      meta.startAt = info.startAt; // span of the segment's voice (consumers check it against incoming voice)
      meta.endAt = info.endAt;
      meta.gatedMs = info.gatedMs; // echo-gated audio inside it
    }
    this._call(this.o.onCommitted, text, meta);
  }

  _remember(key, kind) {
    this._pruneRecent();
    this.recent.push({ key, kind, at: this.o.now() });
  }

  _consumeRecent(key, kind) {
    this._pruneRecent();
    const i = this.recent.findIndex((r) => r.key === key && r.kind === kind);
    if (i < 0) return false;
    this.recent.splice(i, 1);
    return true;
  }

  _pruneRecent() {
    const cutoff = this.o.now() - SIBLING_MEMORY_MS;
    if (this.recent.length) this.recent = this.recent.filter((r) => r.at >= cutoff);
  }

  /** Consumer callbacks must never break the socket (or leak a rejection). */
  _call(fn, ...args) {
    if (typeof fn !== 'function') return;
    try {
      const r = fn(...args);
      if (r && typeof r.then === 'function') r.then(undefined, () => {});
    } catch (e) {
      try { console.error('[stt] callback failed', e); } catch (_) { /* ignore */ }
    }
  }
}
