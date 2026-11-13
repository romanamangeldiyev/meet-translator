// Engine seam (A1 <-> A2): translation core for one session. No sockets, no audio, no chrome.*.
//
//   const core = createEngineCore({ settings, lang, emit, signal, onFatal, onSoftError });
//   core.warmup()                     -> Promise<void>, rejects only with FatalError
//   core.inPipe.partial(text, meta)   meta = { lang: string|null }
//   core.inPipe.commit(text, meta)    meta = { lang: string|null, at: Date.now() }
//   core.outPipe.partial / commit     same (commit meta may carry overlap:false = no incoming voice during it)
//   core.setMuted(bool)               Meet's mic muted: utterances not yet spoken are skipped (stale + muted)
//   core.setOutReady(bool)            outgoing recognizer ready / down (voice passthrough after 3 s down)
//   core.dispose()
import { FatalError, childAbort, normalizeLang } from './util.js';
import { Conversation } from './conversation.js';
import { ANTHROPIC_KEY_INVALID, DEFAULT_MODEL, DRAFT_MODEL, MODELS, Translator, createAnthropicClient, modelNotFound } from './translate.js';
import { TtsClient, checkVoice } from './tts.js';
import { InPipeline, OutPipeline } from './pipeline.js';

export const WARMUP_TIMEOUT_MS = 8000;
export const KEEP_WARM_MS = 90000; // prime again after this long without any Claude request
export const PRIMER_SYSTEM = 'This is a connection check. Reply with exactly: ok';
// Voice passthrough: while the user's speech cannot be translated, the page lets their real voice through.
export const PASSTHROUGH_DOWN_MS = 3000; // the outgoing recognizer has not been ready for this long
export const PASSTHROUGH_FAILURES = 2; // consecutive outgoing sentences that failed (translation or TTS)
export const PASSTHROUGH_DOWN_REASON = 'Konuşma tanıma bağlantısı yok; sesiniz doğrudan iletiliyor.';
export const PASSTHROUGH_FAIL_REASON = 'Çeviri art arda başarısız oldu; sesiniz doğrudan iletiliyor.';

export const DEFAULT_SETTINGS = Object.freeze({
  elevenKey: '',
  anthropicKey: '',
  claudeModel: DEFAULT_MODEL,
  fastMode: true,
  liveDrafts: true,
  ttsModel: 'eleven_v4_turbo',
  voiceId: '21m00Tcm4TlvDq8ikWAM',
  formality: 'formal',
  speakerGender: '',
  glossary: [],
  originalVoice: 'off',
  incomingSource: 'tab', // Chrome tab capture: the reliable default (the in-page Meet capture is experimental)
  captionSize: 'm',
  showLatency: true,
});

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function bool(v, dflt) {
  if (typeof v === 'boolean') return v;
  if (v === 'false' || v === '0' || v === 0) return false;
  if (v === 'true' || v === '1' || v === 1) return true;
  return dflt;
}

/** Defensive defaults for every settings field (missing, wrong type or unknown value). */
export function normalizeSettings(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const d = DEFAULT_SETTINGS;
  const terms = Array.isArray(r.glossary) ? r.glossary : typeof r.glossary === 'string' ? r.glossary.split(/[\n,]/) : [];
  const glossary = [];
  for (const t of terms) {
    const s = str(t).slice(0, 100);
    if (s && !glossary.includes(s) && glossary.length < 100) glossary.push(s);
  }
  const pick = (v, allowed, dflt) => (allowed.includes(v) ? v : dflt);
  return {
    elevenKey: str(r.elevenKey),
    anthropicKey: str(r.anthropicKey),
    claudeModel: pick(r.claudeModel, MODELS, d.claudeModel),
    fastMode: bool(r.fastMode, d.fastMode),
    liveDrafts: bool(r.liveDrafts, d.liveDrafts),
    ttsModel: str(r.ttsModel) || d.ttsModel,
    voiceId: str(r.voiceId) || d.voiceId,
    formality: pick(r.formality, ['formal', 'informal'], d.formality),
    speakerGender: pick(r.speakerGender, ['', 'male', 'female'], d.speakerGender),
    glossary,
    originalVoice: pick(r.originalVoice, ['off', 'low'], d.originalVoice),
    incomingSource: pick(r.incomingSource, ['page', 'tab'], d.incomingSource),
    captionSize: pick(r.captionSize, ['s', 'm', 'l'], d.captionSize),
    showLatency: bool(r.showLatency, d.showLatency),
  };
}

const NOOP_PIPE = Object.freeze({ partial() {}, commit() {} });

/**
 * @param {object} p
 * @param {object} p.settings    settings object (see CONTRACT); every field is defaulted
 * @param {string} p.lang        the other side's language (one of the 8 codes, never 'en')
 * @param {(msg:object)=>void} p.emit   page-bound messages (caption / metrics / tts-chunk / tts-end)
 * @param {AbortSignal} [p.signal]      session signal; aborting it stops everything
 * @param {(reason:string)=>void} p.onFatal      called at most once; the core stops itself first
 * @param {(err:Error)=>void} [p.onSoftError]    per-sentence problems
 * @param {object} [p.deps]  test injection: { client, fetch, now, setTimeout, clearTimeout }
 */
export function createEngineCore({ settings, lang, emit, signal, onFatal, onSoftError, deps = {} } = {}) {
  const s = normalizeSettings(settings);
  const target = normalizeLang(lang);
  const now = deps.now || Date.now;
  const st = deps.setTimeout || ((f, ms) => setTimeout(f, ms));
  const ct = deps.clearTimeout || ((t) => clearTimeout(t));
  const fetchImpl = deps.fetch || ((...a) => fetch(...a));
  const life = childAbort(signal);
  let disposed = false;
  let fatalSent = false;

  const alive = () => !disposed && !life.signal.aborted;
  const safeEmit = (m) => {
    if (!alive()) return;
    try { if (emit) emit(m); } catch (_) { /* the host must not break the engine */ }
  };
  const fatal = (reason) => {
    if (!alive() || fatalSent) return;
    fatalSent = true;
    life.controller.abort(); // stop all work before the host tears down
    try { if (onFatal) onFatal(String(reason || 'Beklenmeyen hata.')); } catch (_) { /* ignore */ }
  };
  const soft = (e) => {
    if (!alive()) return;
    try { if (onSoftError) onSoftError(e); } catch (_) { /* ignore */ }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    life.controller.abort();
    life.release();
  };

  const configError = !target || target === 'en'
    ? 'Geçersiz dil seçimi.'
    : !s.anthropicKey || !s.elevenKey
      ? "API anahtarları eksik. Ayarlar'dan girin."
      : null;
  if (configError) {
    return {
      warmup: () => Promise.reject(new FatalError(configError)),
      inPipe: NOOP_PIPE,
      outPipe: NOOP_PIPE,
      setMuted() {},
      setOutReady() {},
      dispose,
    };
  }

  const client = deps.client || createAnthropicClient(s.anthropicKey);
  const translator = new Translator({ client, model: s.claudeModel, fastMode: s.fastMode, now });
  const tts = new TtsClient({ apiKey: s.elevenKey, voiceId: s.voiceId, model: s.ttsModel, fetch: fetchImpl, setTimeout: st, clearTimeout: ct });
  const conversation = new Conversation({ now });
  const drafts = { enabled: s.liveDrafts, pausedUntil: 0 };

  // Voice passthrough (page-bound {type:'voice-passthrough', on, reason?}): on after PASSTHROUGH_DOWN_MS without
  // a ready outgoing recognizer or PASSTHROUGH_FAILURES failed sentences in a row; off once the recognizer is
  // ready and a sentence was spoken again.
  const vp = { on: false, failures: 0, outReady: true, downTimer: null };
  const setPassthrough = (on, reason) => {
    if (vp.on === on || !alive()) return;
    vp.on = on;
    safeEmit(on ? { type: 'voice-passthrough', on: true, reason } : { type: 'voice-passthrough', on: false });
  };
  const onOutcome = (ok) => {
    if (ok) {
      vp.failures = 0;
      if (vp.on && vp.outReady) setPassthrough(false);
      return;
    }
    vp.failures++;
    if (vp.failures >= PASSTHROUGH_FAILURES) setPassthrough(true, PASSTHROUGH_FAIL_REASON);
  };
  const setOutReady = (ready) => {
    if (!alive()) return;
    vp.outReady = !!ready;
    if (vp.outReady) {
      if (vp.downTimer) ct(vp.downTimer);
      vp.downTimer = null;
      return;
    }
    if (vp.downTimer) return;
    vp.downTimer = st(() => {
      vp.downTimer = null;
      if (alive() && !vp.outReady) setPassthrough(true, PASSTHROUGH_DOWN_REASON);
    }, PASSTHROUGH_DOWN_MS);
  };
  const common = {
    lang: target,
    settings: s,
    translator,
    conversation,
    emit: safeEmit,
    signal: life.signal,
    onFatal: fatal,
    onSoftError: soft,
    now,
    setTimeout: st,
    clearTimeout: ct,
  };
  const inPipe = new InPipeline({ ...common, drafts });
  const outPipe = new OutPipeline({ ...common, tts, onOutcome, incomingPartial: () => inPipe.currentPartial() });

  /** models.retrieve: 401 / 404 fatal for the main model; Haiku 404/403 only turns drafts off. */
  async function warmClaude(model, main) {
    try {
      await client.models.retrieve(model, {}, { signal: life.signal, timeout: WARMUP_TIMEOUT_MS, maxRetries: 0 });
    } catch (e) {
      const status = e && e.status;
      if (main) {
        if (status === 401) throw new FatalError(ANTHROPIC_KEY_INVALID);
        if (status === 404) throw new FatalError(modelNotFound(model));
      } else if (status === 404 || status === 403) {
        drafts.enabled = false;
      }
      // anything else (network, 5xx, 429, timeout) is not a reason to stop
    }
  }

  // Measured live: the first translation of a session took ~5 s although models.retrieve had already
  // opened the connection; later ones ~1 s. A tiny real request primes the whole path (and learns any
  // feature degradation) before the first sentence, and an idle session is primed again every 90 s.
  let warmTimer = null;
  function prime() {
    if (!alive()) return;
    translator.translate({ system: PRIMER_SYSTEM, user: 'ok', signal: life.signal }).catch((e) => {
      // e.g. "credit balance too low": every sentence would fail the same way, so stop now and say why.
      if (e && e.fatal) fatal(e.message);
    });
  }
  function keepWarm() {
    if (!alive() || warmTimer) return;
    warmTimer = st(() => {
      warmTimer = null;
      if (!alive()) return;
      if (now() - (translator.lastUsedAt || 0) >= KEEP_WARM_MS) prime();
      keepWarm();
    }, KEEP_WARM_MS / 3);
  }

  async function warmup() {
    if (!alive()) return;
    const tasks = [warmClaude(s.claudeModel, true).then(() => { prime(); keepWarm(); })];
    if (s.liveDrafts && s.claudeModel !== DRAFT_MODEL) tasks.push(warmClaude(DRAFT_MODEL, false));
    tasks.push(checkVoice({
      apiKey: s.elevenKey,
      voiceId: s.voiceId,
      fetch: fetchImpl,
      signal: life.signal,
      timeoutMs: WARMUP_TIMEOUT_MS,
      setTimeout: st,
      clearTimeout: ct,
    }).then((stored) => {
      if (stored && typeof stored === 'object') tts.storedSettings = stored;
    }));
    const results = await Promise.allSettled(tasks);
    if (!alive()) return;
    for (const r of results) {
      if (r.status === 'rejected' && r.reason && r.reason.fatal) throw r.reason;
    }
  }

  const guard = (fn) => (text, meta) => {
    if (!alive()) return;
    try {
      fn(text, meta);
    } catch (e) {
      soft(e);
    }
  };

  return {
    warmup: () => warmup().catch((e) => {
      if (e && e.fatal) throw e;
      // contract: warmup rejects only with FatalError
    }),
    inPipe: {
      partial: guard((t, m) => inPipe.partial(t, m)),
      commit: guard((t, m) => inPipe.commit(t, m)),
    },
    outPipe: {
      partial: guard((t, m) => outPipe.partial(t, m)),
      commit: guard((t, m) => outPipe.commit(t, m)),
    },
    setMuted(muted) {
      if (alive()) outPipe.setMuted(muted);
    },
    setOutReady,
    dispose() {
      dispose();
      if (warmTimer) ct(warmTimer);
      warmTimer = null;
      if (vp.downTimer) ct(vp.downTimer);
      vp.downTimer = null;
      inPipe.dispose();
      outPipe.dispose();
    },
    /** Test hooks; not part of the seam. */
    _internals: { inPipe, outPipe, translator, tts, conversation, drafts, passthrough: vp },
  };
}
