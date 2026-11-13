// ElevenLabs streaming TTS (PCM16 LE mono 24 kHz): HTTP client with retries/timeouts, chunk
// coalescing for the relay, playback-backlog estimate for adaptive speed, voice check for warmup.
import { EvenChunker, FatalError, abortError } from './util.js';

export const TTS_FALLBACK_MODEL = 'eleven_flash_v2_5';
export const FIRST_BYTE_TIMEOUT_MS = 8000;
export const STALL_TIMEOUT_MS = 8000;
export const RETRY_DELAY_MS = 300;
export const BYTES_PER_SECOND = 48000; // 24 kHz * 2 bytes
export const COALESCE_BYTES = 9600; // 200 ms
export const VOICE_NOT_FOUND = "Ses kimliği (Voice ID) bulunamadı. Ayarlar'dan düzeltin.";

const API = 'https://api.elevenlabs.io/v1';

export class TtsError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'TtsError';
    this.status = status;
  }
}

/** Fatal reason for an ElevenLabs 401 (invalid key, quota, missing permission). */
export function elevenAuthMessage(body, what = '') {
  const suffix = what ? ` (${what})` : '';
  if (/quota/i.test(body)) return `ElevenLabs kotanız doldu${suffix}.`;
  if (/missing_permissions/i.test(body)) return `ElevenLabs API anahtarının gerekli izni yok${suffix}.`;
  return `ElevenLabs API anahtarı geçersiz${suffix}. Ayarlar'dan düzeltin.`;
}

/** Playback backlog -> voice speed: < 3 s 1.0, 3–6 s 1.08, > 6 s 1.15. */
export function speedForBacklog(ms) {
  if (ms > 6000) return 1.15;
  if (ms >= 3000) return 1.08;
  return 1;
}

/**
 * Estimates how much relayed audio is still waiting to be played: every relayed chunk starts
 * playing at max(relay time, end of the previous audio) and lasts bytes / 48000 s.
 */
export class PlaybackClock {
  constructor(now = Date.now) {
    this.now = now;
    this.endAt = 0;
  }

  add(byteLength) {
    const t = this.now();
    this.endAt = Math.max(this.endAt, t) + (byteLength / BYTES_PER_SECOND) * 1000;
  }

  backlogMs() {
    return Math.max(0, this.endAt - this.now());
  }
}

/**
 * Coalesces one audio stream for the relay: the first even-length bytes go out at once, then
 * pieces of >= minBytes; end() flushes the rest. Every piece has an even length (an odd trailing
 * byte is carried to the next push and dropped at the end).
 */
export class ChunkCoalescer {
  constructor(onChunk, minBytes = COALESCE_BYTES) {
    this.onChunk = onChunk;
    this.min = minBytes;
    this.even = new EvenChunker();
    this.parts = [];
    this.n = 0;
    this.sentFirst = false;
  }

  push(bytes) {
    const data = this.even.push(bytes);
    if (!data) return;
    if (!this.sentFirst) {
      this.sentFirst = true;
      this.onChunk(data);
      return;
    }
    this.parts.push(data);
    this.n += data.length;
    if (this.n >= this.min) this.flush();
  }

  flush() {
    if (!this.n) return;
    const all = new Uint8Array(this.n);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.n = 0;
    this.onChunk(all);
  }

  end() {
    this.flush();
    this.even = new EvenChunker();
  }
}

async function readText(res) {
  try {
    return String(await res.text());
  } catch (_) {
    return '';
  }
}

/**
 * The parts of an ElevenLabs error body worth matching: detail.status/message, or the loc/msg of
 * validation errors (never their `input` echo, which repeats the whole request incl. model_id).
 */
export function errorSummary(text) {
  try {
    const j = JSON.parse(text);
    const d = j && typeof j === 'object' && 'detail' in j ? j.detail : j;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) {
      return d
        .map((x) => [x && Array.isArray(x.loc) ? x.loc.join('.') : '', x && x.msg, x && x.type].filter((v) => typeof v === 'string' && v).join(' '))
        .join(' | ');
    }
    if (d && typeof d === 'object') {
      return [d.status, d.code, d.type, d.message, d.param].filter((v) => typeof v === 'string').join(' ');
    }
  } catch (_) { /* not JSON */ }
  return String(text || '');
}

/** Rejects as soon as `signal` aborts (guards awaits that might ignore the signal). */
function abortPromise(signal) {
  const p = new Promise((_, reject) => {
    if (signal.aborted) reject(abortError());
    else signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
  p.catch(() => {});
  return p;
}

export class TtsClient {
  constructor({ apiKey, voiceId, model, fetch: fetchImpl, setTimeout: st, clearTimeout: ct }) {
    this.apiKey = apiKey;
    this.voiceId = voiceId;
    this.model = model || 'eleven_v4_turbo';
    this.modelFellBack = false;
    this.noLang = false; // language_code rejected for this session
    this.noSpeed = false; // voice_settings.speed rejected for this session
    this.noPrevious = false; // previous_text (request stitching) rejected for this session
    this.storedSettings = null; // the voice's own settings (from warmup), merged under a speed override
    this.fetch = fetchImpl || ((...a) => fetch(...a));
    this.setTimeout = st || ((f, ms) => setTimeout(f, ms));
    this.clearTimeout = ct || ((t) => clearTimeout(t));
  }

  get url() {
    return `${API}/text-to-speech/${encodeURIComponent(this.voiceId)}/stream?output_format=pcm_24000`;
  }

  /**
   * Streams the speech for `text`, calling onBytes(Uint8Array) for every network read.
   * Retries before any audio flowed: no first byte within 8 s (once), 400/422 (speed / language /
   * model fallback), 429 and 5xx (once, after 300 ms). 401 and 404 are fatal. A stream that stalls
   * for 8 s after audio started is aborted (soft error).
   */
  async speak({ text, lang, previousText, speed = 1, signal, onBytes }) {
    let withLang = !this.noLang;
    let timeoutRetried = false;
    let statusRetried = false;
    for (let attempt = 1; attempt <= 6; attempt++) {
      if (signal && signal.aborted) throw abortError();
      const body = { text, model_id: this.model };
      if (withLang && lang) body.language_code = lang;
      if (previousText && !this.noPrevious) body.previous_text = previousText;
      const useSpeed = speed !== 1 && !this.noSpeed;
      // voice_settings replaces the stored settings for this request: keep the voice's own values.
      if (useSpeed) body.voice_settings = this.storedSettings ? { ...this.storedSettings, speed } : { speed };

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      if (signal) signal.addEventListener('abort', onAbort);
      const aborted = abortPromise(ac.signal);
      let timer = null;
      let timedOut = false;
      let gotBytes = false;
      const arm = (ms) => {
        if (timer !== null) this.clearTimeout(timer);
        timer = this.setTimeout(() => {
          timer = null;
          timedOut = true;
          ac.abort();
        }, ms);
      };
      arm(FIRST_BYTE_TIMEOUT_MS);
      let retryAfterDelay = false;
      try {
        const res = await Promise.race([
          this.fetch(this.url, {
            method: 'POST',
            headers: { 'xi-api-key': this.apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ac.signal,
          }),
          aborted,
        ]);
        if (!res.ok) {
          const status = res.status;
          const errText = errorSummary(await Promise.race([readText(res), aborted]));
          if (status === 401) throw new FatalError(elevenAuthMessage(errText, 'ses üretimi'));
          if (status === 404 || /voice_not_found/i.test(errText)) throw new FatalError(VOICE_NOT_FOUND);
          if (status === 400 || status === 422) {
            if (useSpeed && /speed|voice_settings/i.test(errText)) {
              this.noSpeed = true;
              continue;
            }
            if (body.previous_text && /previous_text|stitching/i.test(errText)) {
              this.noPrevious = true;
              continue;
            }
            if (body.language_code && /language/i.test(errText)) {
              withLang = false;
              this.noLang = true;
              continue;
            }
            if (/model/i.test(errText) && !this.modelFellBack && this.model !== TTS_FALLBACK_MODEL) {
              this.model = TTS_FALLBACK_MODEL; // keep for the rest of the session
              this.modelFellBack = true;
              continue;
            }
            if (body.language_code) {
              withLang = false;
              continue;
            }
          }
          if ((status === 429 || status >= 500) && !statusRetried) {
            statusRetried = true;
            retryAfterDelay = true;
            continue;
          }
          throw new TtsError(status, `TTS http ${status}`);
        }
        if (!res.body || typeof res.body.getReader !== 'function') throw new TtsError(0, 'TTS empty body');
        const reader = res.body.getReader();
        let finished = false;
        try {
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done) {
              finished = true;
              break;
            }
            if (!value || !value.length) continue;
            gotBytes = true;
            arm(STALL_TIMEOUT_MS);
            onBytes(value);
          }
        } finally {
          try {
            if (finished) reader.releaseLock();
            else {
              const p = reader.cancel();
              if (p && typeof p.catch === 'function') p.catch(() => {});
            }
          } catch (_) { /* ignore */ }
        }
        return;
      } catch (e) {
        if (signal && signal.aborted) throw abortError();
        if (e && e.fatal) throw e;
        if (timedOut) {
          if (!gotBytes && !timeoutRetried) {
            timeoutRetried = true;
            continue;
          }
          throw new TtsError(0, gotBytes ? 'TTS akışı durdu.' : 'TTS yanıt vermedi.');
        }
        throw e;
      } finally {
        if (timer !== null) this.clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        ac.abort(); // release the request if it is still open
        if (retryAfterDelay) await this._sleep(RETRY_DELAY_MS, signal);
      }
    }
    throw new TtsError(0, 'TTS retries exhausted');
  }

  _sleep(ms, signal) {
    return new Promise((resolve) => {
      const t = this.setTimeout(done, ms);
      function done() {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }
      const onAbort = () => {
        this.clearTimeout(t);
        done();
      };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

const VOICE_SETTING_KEYS = ['stability', 'similarity_boost', 'style', 'use_speaker_boost'];

/** The voice's stored settings from a GET /v1/voices/{id} body (without speed), or null. */
export function voiceSettingsFrom(raw) {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const st = j && j.settings;
    if (!st || typeof st !== 'object') return null;
    const out = {};
    for (const k of VOICE_SETTING_KEYS) {
      if (typeof st[k] === 'number' || typeof st[k] === 'boolean') out[k] = st[k];
    }
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

/**
 * Warmup check of the voice (also opens the TLS connection): 404 -> fatal voice; 401 whose body
 * mentions missing_permissions -> ignored (restricted key); other 401 -> fatal key; anything else
 * (network, timeout, 5xx) is ignored. Resolves with the voice's stored settings when available
 * (used so a sped-up sentence keeps the voice's own stability / similarity settings).
 */
export async function checkVoice({ apiKey, voiceId, fetch: fetchImpl, signal, timeoutMs = 8000, setTimeout: st, clearTimeout: ct }) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const setT = st || ((fn, ms) => setTimeout(fn, ms));
  const clearT = ct || ((t) => clearTimeout(t));
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  const timer = setT(() => ac.abort(), timeoutMs);
  const aborted = abortPromise(ac.signal);
  try {
    let res;
    try {
      res = await Promise.race([
        f(`${API}/voices/${encodeURIComponent(voiceId)}`, { method: 'GET', headers: { 'xi-api-key': apiKey }, signal: ac.signal }),
        aborted,
      ]);
    } catch (_) {
      return; // network error, timeout or stop: not fatal
    }
    if (!res) return;
    const raw = await Promise.race([readText(res), aborted]).catch(() => '');
    const body = errorSummary(raw);
    if (res.ok) return voiceSettingsFrom(raw);
    if (res.status === 404 || (res.status === 400 && /voice_not_found/i.test(body))) throw new FatalError(VOICE_NOT_FOUND);
    if (res.status === 401) {
      if (/missing_permissions/i.test(body)) return;
      throw new FatalError(elevenAuthMessage(body));
    }
  } finally {
    clearT(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}
