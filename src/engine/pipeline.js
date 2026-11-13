// Per-direction pipelines (created by core.js).
//   in : partial captions, Haiku drafts, routing (English passthrough), streaming translation,
//        final captions, metrics.
//   out: partial captions, speculation on stable partials, echo guard, routing (passthrough when
//        already in the target language), streaming translation whose sentences feed one strictly
//        ordered speech chain (TTS per sentence), staleness, metrics on the first audio chunk.
import { bytesToBase64, childAbort, isAbortError, normalizeLang } from './util.js';
import { SentenceSplitter, cleanTranscript, isEchoOf, isNonSpeech, normText, splitSentences, stripSoundTags, wordCount } from './text.js';
import { StreamFilter, buildSystemPrompt, buildUserMessage, postProcess } from './translate.js';
import { ChunkCoalescer, PlaybackClock, speedForBacklog } from './tts.js';

export const PARTIAL_INTERVAL_MS = 200;
export const SPECULATION_STABLE_MS = 300;
export const SPECULATION_SENTENCE_MS = 80; // partial ends with . ? ! …: likely the end of the sentence
const SENTENCE_END_RE = /[.?!…。？！]["'”’»)\]]*$/;
export const SPECULATION_MIN_WORDS = 2;
// A long unpunctuated stretch changes its partial every few hundred ms: speculate again only once it grew by
// this many words since the last speculation (or ends a sentence), not on every revision.
export const SPECULATION_REGROW_WORDS = 4;
// Live drafts: start on the first two words and refresh every 450 ms (Haiku answers in ~0.6 s).
export const DRAFT_MIN_WORDS = 2;
export const DRAFT_INTERVAL_MS = 450;
export const DRAFT_PAUSE_MS = 10000;
export const ECHO_WINDOW_MS = 10000;
export const STALE_MS = 20000;
export const PREVIOUS_TEXT_WINDOW_MS = 10000;
export const JOB_TIMEOUT_MS = 30000;

const ms = (x) => Math.max(0, Math.round(x));

// ---- sentence queue ---------------------------------------------------------------------------

/** Single-consumer async queue of sentences. next() resolves null once closed and drained. */
export class SentenceQueue {
  constructor(items = [], closed = false) {
    this.items = items.filter(Boolean);
    this.closed = closed;
    this.waiter = null;
    this.count = this.items.length;
  }

  push(s) {
    if (this.closed || !s) return;
    this.count++;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(s);
    } else {
      this.items.push(s);
    }
  }

  /** No more sentences; the ones already queued are still delivered. */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(null);
    }
  }

  /** Stop now: drop what is queued. */
  cancel() {
    this.items = [];
    this.close();
  }

  next() {
    if (this.items.length) return Promise.resolve(this.items.shift());
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => { this.waiter = resolve; });
  }
}

// ---- translation job --------------------------------------------------------------------------

/**
 * One streaming translation. `result` resolves (never rejects) to the job itself once
 * `status` is 'ok' | 'skip' | 'refused' | 'failed' | 'aborted'. With `sentences: true` the
 * cleaned output is split into `sentences` (a SentenceQueue) while it streams.
 */
export class TranslationJob {
  constructor({ translator, system, user, signal, now, setTimeout: st, clearTimeout: ct, timeoutMs = JOB_TIMEOUT_MS, sentences = true }) {
    this.translator = translator;
    this.system = system;
    this.user = user;
    this.parent = signal;
    this.now = now;
    this.st = st;
    this.ct = ct;
    this.timeoutMs = timeoutMs;
    this.splitSentences = sentences;
    this.sentences = new SentenceQueue();
    this.status = 'pending';
    this.text = '';
    this.error = null;
    this.startedAt = null;
    this.firstSentenceAt = null;
    this.doneAt = null;
    this.cancelled = false;
    this.timedOut = false;
    this.adopted = false; // speculative job taken over by its commit
    this.link = null;
    this.timer = null;
    this.result = null;
  }

  start() {
    this.startedAt = this.now();
    this.link = childAbort(this.parent);
    this.timer = this.st(() => {
      this.timer = null;
      this.timedOut = true;
      this.link.controller.abort();
    }, this.timeoutMs);
    this.result = this._run();
    return this;
  }

  abort() {
    if (this.status !== 'pending') return;
    this.cancelled = true;
    this.sentences.cancel();
    if (this.link) this.link.controller.abort();
  }

  async _run() {
    const filter = new StreamFilter();
    const splitter = new SentenceSplitter();
    const feed = (clean) => {
      if (!clean || this.cancelled || !this.splitSentences) return;
      for (const s of splitter.push(clean)) this._sentence(s);
    };
    try {
      const r = await this.translator.translate({
        system: this.system,
        user: this.user,
        signal: this.link.signal,
        onText: (delta) => feed(filter.push(delta)),
      });
      if (this.cancelled) return this._finish('aborted');
      if (r.refused) return this._finish('refused');
      const pp = postProcess(r.text);
      if (pp.skip) return this._finish('skip');
      feed(filter.end());
      if (this.splitSentences) {
        for (const s of splitter.end()) this._sentence(s);
        if (!this.sentences.count) this._sentence(pp.text);
      }
      this.text = pp.text;
      return this._finish('ok');
    } catch (e) {
      if (this.cancelled || (this.parent && this.parent.aborted)) return this._finish('aborted');
      if (this.timedOut) {
        this.error = new Error('Çeviri zaman aşımına uğradı.');
        return this._finish('failed');
      }
      if (isAbortError(e)) return this._finish('aborted');
      this.error = e;
      return this._finish('failed');
    }
  }

  _sentence(s) {
    if (this.cancelled) return;
    if (this.firstSentenceAt === null) this.firstSentenceAt = this.now();
    this.sentences.push(s);
  }

  _finish(status) {
    this.status = status;
    this.doneAt = this.now();
    if (this.timer !== null) {
      this.ct(this.timer);
      this.timer = null;
    }
    if (this.link) this.link.release();
    if (status === 'ok') this.sentences.close();
    else this.sentences.cancel();
    return this;
  }
}

// ---- shared pipeline base ---------------------------------------------------------------------

/**
 * o: { dir, lang (the other side's language), settings, translator, conversation, emit, signal,
 *      onFatal(reason), onSoftError(err), now, setTimeout, clearTimeout }
 */
class BasePipeline {
  constructor(o) {
    this.o = o;
    this.dir = o.dir;
    this.dst = o.dir === 'in' ? 'en' : o.lang;
    this.nextId = 1;
    this.disposed = false;
    this.pendingPartial = null;
    this.lastPartialAt = -Infinity;
    this.partialTimer = null;
    this.systems = new Map();
  }

  get alive() {
    return !this.disposed && !(this.o.signal && this.o.signal.aborted);
  }

  emit(msg) {
    if (this.alive) this.o.emit(msg);
  }

  partial(text, meta) {
    if (!this.alive) return;
    const t = cleanTranscript(text);
    if (!t) return;
    this._queuePartialCaption(t);
    this.onPartial(t, normalizeLang(meta && meta.lang));
  }

  // Partial captions: leading + trailing throttle (one message per PARTIAL_INTERVAL_MS).
  _queuePartialCaption(text) {
    this.pendingPartial = text;
    const wait = this.lastPartialAt + PARTIAL_INTERVAL_MS - this.o.now();
    if (wait <= 0) {
      this._flushPartialCaption();
    } else if (this.partialTimer === null) {
      this.partialTimer = this.o.setTimeout(() => {
        this.partialTimer = null;
        this._flushPartialCaption();
      }, wait);
    }
  }

  _flushPartialCaption() {
    if (!this.alive || this.pendingPartial === null) return;
    const original = this.pendingPartial;
    this.pendingPartial = null;
    this.lastPartialAt = this.o.now();
    this.emit({ type: 'caption', dir: this.dir, id: this.nextId, partial: true, original });
  }

  /** Ends the current segment: drops the pending partial and emits the commit caption. */
  _beginSegment(original, detected) {
    if (this.partialTimer !== null) {
      this.o.clearTimeout(this.partialTimer);
      this.partialTimer = null;
    }
    this.pendingPartial = null;
    const id = this.nextId++;
    this.emit({ type: 'caption', dir: this.dir, id, partial: false, original, lang: detected });
    return id;
  }

  _final(id, original, detected, fields) {
    this.emit({ type: 'caption', dir: this.dir, id, partial: false, original, ...fields, lang: detected });
  }

  _commitTime(meta) {
    const now = this.o.now();
    const at = meta && meta.at;
    return Number.isFinite(at) && at >= now - 60000 && at <= now + 1000 ? Math.min(at, now) : now;
  }

  _system(src, draft = false) {
    const key = `${src}|${draft ? 1 : 0}`;
    let s = this.systems.get(key);
    if (!s) {
      const st = this.o.settings || {};
      s = buildSystemPrompt({
        src,
        dst: this.dst,
        dir: this.dir,
        formality: st.formality,
        gender: st.speakerGender,
        glossary: st.glossary,
        draft,
      });
      this.systems.set(key, s);
    }
    return s;
  }

  _startJob(text, src, context, sentences) {
    return new TranslationJob({
      translator: this.o.translator,
      system: this._system(src),
      user: buildUserMessage({ text, dir: this.dir, src, context }),
      signal: this.o.signal,
      now: this.o.now,
      setTimeout: this.o.setTimeout,
      clearTimeout: this.o.clearTimeout,
      sentences,
    }).start();
  }

  /** A failed job: fatal stops the engine, anything else is a soft per-sentence problem. */
  _reportFailure(job) {
    const e = job.error;
    if (e && e.fatal) this.o.onFatal(e.message);
    else this.o.onSoftError(e || new Error('Çeviri başarısız.'));
  }

  onPartial() {}

  dispose() {
    this.disposed = true;
    if (this.partialTimer !== null) this.o.clearTimeout(this.partialTimer);
    this.partialTimer = null;
    this.pendingPartial = null;
  }
}

// ---- incoming ---------------------------------------------------------------------------------

/** o additionally: drafts { enabled, pausedUntil } (shared with core/warmup). */
export class InPipeline extends BasePipeline {
  constructor(o) {
    super({ ...o, dir: 'in' });
    this.drafts = o.drafts || { enabled: false, pausedUntil: 0 };
    this.lastDraftStartAt = -Infinity;
    this.partialInfo = null; // latest partial of the current segment, for the echo guard
    this.draft = this._newDraft();
  }

  /** { text, at } of the segment being spoken right now, or null. */
  currentPartial() {
    return this.partialInfo;
  }

  _newDraft() {
    return { id: this.nextId, seq: 0, applied: 0, pending: null, inflight: null, timer: null, lastNorm: '', closed: false };
  }

  onPartial(text, detected) {
    this.partialInfo = { text, at: this.o.now() };
    const src = detected || this.o.lang;
    if (src === 'en' || wordCount(text) < DRAFT_MIN_WORDS) return;
    if (!this.drafts.enabled) return;
    this.draft.pending = { text, src, detected };
    this._pumpDraft(this.draft);
  }

  _pumpDraft(d) {
    if (d !== this.draft || d.closed || d.inflight || !d.pending || !this.alive) return;
    if (!this.drafts.enabled || this.o.now() < (this.drafts.pausedUntil || 0)) return;
    const wait = this.lastDraftStartAt + DRAFT_INTERVAL_MS - this.o.now();
    if (wait > 0) {
      if (d.timer === null) {
        d.timer = this.o.setTimeout(() => {
          d.timer = null;
          this._pumpDraft(d);
        }, wait);
      }
      return;
    }
    const { text, src, detected } = d.pending;
    d.pending = null;
    const n = normText(text);
    if (n === d.lastNorm) return; // nothing new since the last draft
    d.lastNorm = n;
    const seq = ++d.seq;
    this.lastDraftStartAt = this.o.now();
    const link = childAbort(this.o.signal);
    d.inflight = link;
    const user = buildUserMessage({ text, dir: 'in', src, context: this.o.conversation.render() });
    this.o.translator
      .draft({ system: this._system(src, true), user, signal: link.signal })
      .then((r) => this._applyDraft(d, seq, r, detected))
      .catch((e) => this._draftError(e))
      .finally(() => {
        link.release();
        if (d.inflight === link) d.inflight = null;
        this._pumpDraft(d);
      });
  }

  _applyDraft(d, seq, r, detected) {
    if (d !== this.draft || d.closed || !this.alive || !r || r.refused) return;
    if (seq <= d.applied) return; // an older draft must never replace a newer one
    const pp = postProcess(r.text);
    if (pp.skip) return;
    d.applied = seq;
    const original = (this.partialInfo && this.partialInfo.text) || '';
    this.emit({ type: 'caption', dir: 'in', id: d.id, partial: true, original, translated: pp.text, draft: true, lang: detected || null });
  }

  _draftError(e) {
    if (!e || isAbortError(e) || !this.alive) return;
    if (e.status === 404 || e.status === 403) this.drafts.enabled = false; // no Haiku access: drafts off
    else if (e.status === 429 || e.status >= 500) this.drafts.pausedUntil = this.o.now() + DRAFT_PAUSE_MS; // rate limit / overloaded
    // other draft failures are harmless: the final translation follows anyway
  }

  _closeDraft() {
    const d = this.draft;
    d.closed = true;
    d.pending = null;
    if (d.timer !== null) {
      this.o.clearTimeout(d.timer);
      d.timer = null;
    }
    if (d.inflight) d.inflight.controller.abort();
    this.draft = this._newDraft();
  }

  commit(text, meta) {
    if (!this.alive) return;
    const original = cleanTranscript(text);
    if (!original) return;
    const detected = normalizeLang(meta && meta.lang);
    const commitAt = this._commitTime(meta);
    const id = this._beginSegment(original, detected);
    this._closeDraft();
    this.partialInfo = null;

    if (isNonSpeech(original)) {
      this._final(id, original, detected, { skipped: true });
      return;
    }
    const src = detected || this.o.lang;
    const context = this.o.conversation.render();
    const entry = this.o.conversation.add({ dir: 'in', original, lang: src, at: commitAt });

    if (src === 'en') {
      entry.translated = original;
      this._final(id, original, detected, { translated: original, passthrough: true });
      this.emit({ type: 'metrics', dir: 'in', id, translateMs: 0, totalMs: ms(this.o.now() - commitAt) });
      return;
    }

    const job = this._startJob(original, src, context, false);
    job.result.then(() => this._finishIn({ id, original, detected, entry, job, commitAt }));
  }

  _finishIn({ id, original, detected, entry, job, commitAt }) {
    if (!this.alive) return;
    switch (job.status) {
      case 'ok':
        entry.translated = job.text;
        this._final(id, original, detected, { translated: job.text });
        this.emit({
          type: 'metrics',
          dir: 'in',
          id,
          translateMs: ms(job.doneAt - job.startedAt),
          totalMs: ms(this.o.now() - commitAt),
        });
        return;
      case 'skip':
        this.o.conversation.drop(entry);
        this._final(id, original, detected, { skipped: true });
        return;
      case 'refused':
        this._final(id, original, detected, { failed: true });
        return;
      case 'failed':
        this._reportFailure(job);
        this._final(id, original, detected, { failed: true });
        return;
      default: // aborted: the session is ending
    }
  }

  dispose() {
    super.dispose();
    this.draft.closed = true;
    if (this.draft.timer !== null) this.o.clearTimeout(this.draft.timer);
    this.draft.timer = null;
    if (this.draft.inflight) this.draft.inflight.controller.abort();
  }
}

// ---- outgoing ---------------------------------------------------------------------------------

/** One committed outgoing utterance on its way to speech. */
class OutUtterance {
  constructor(pipe, { id, original, detected, src, commitAt, entry, echoRisk = true }) {
    this.pipe = pipe;
    this.echoRisk = echoRisk; // the segment overlapped incoming voice: the text echo guard applies
    this.id = id;
    this.original = original;
    this.detected = detected;
    this.src = src;
    this.commitAt = commitAt;
    this.entry = entry;
    this.job = null;
    this.sentences = null;
    this.passthrough = false;
    this.speculative = false;
    this.cancelled = false;
    this.speechStarted = false;
    this.expired = false; // nothing speakable by commit + STALE_MS: the speech chain moved on without it
    this.mutedSkip = false; // Meet's mic was muted when its speech would have started: never spoken
    this.finalSent = false;
    this.metricsSent = false;
    this.translateMs = 0;
    this.firstTtsAt = null;
    this.firstAudioAt = null;
  }

  /** Translated too late to be spoken: its first speakable text came > STALE_MS after commit. */
  isStale() {
    if (this.passthrough || !this.job) return false;
    if (this.expired) return true;
    const ready = this.job.firstSentenceAt !== null ? this.job.firstSentenceAt : this.job.doneAt;
    return ready !== null && ready - this.commitAt > STALE_MS;
  }

  /** Called by the speech stage before the first sentence; false = do not speak. */
  beforeSpeech() {
    if (this.cancelled) return false;
    if (this.pipe.muted) {
      this.pipe._skipMuted(this); // nobody would hear it: the final caption carries stale + muted
      return false;
    }
    if (this.isStale()) return false; // the final caption carries stale:true
    // Re-check the echo guard: the matching incoming commit may have arrived after ours.
    if (this.echoRisk && this.pipe._isEcho(this.original, this.commitAt)) {
      this.pipe._cancelAsEcho(this);
      return false;
    }
    this.speechStarted = true;
    return true;
  }

  audioRelayed() {
    if (this.firstAudioAt !== null) return;
    this.firstAudioAt = this.pipe.o.now();
    this.pipe._maybeMetrics(this);
  }
}

/** The strictly ordered speech chain: one utterance after the other, one TTS call per sentence. */
export class SpeechStage {
  constructor({ tts, lang, emit, signal, now, onFatal, onSoftError, onOutcome, playback, setTimeout: st, clearTimeout: ct }) {
    this.tts = tts;
    this.onOutcome = onOutcome || (() => {});
    this.lang = lang;
    this.emit = emit;
    this.signal = signal;
    this.now = now;
    this.onFatal = onFatal;
    this.onSoftError = onSoftError;
    this.playback = playback || new PlaybackClock(now);
    this.setTimeout = st || ((f, t) => setTimeout(f, t));
    this.clearTimeout = ct || ((t) => clearTimeout(t));
    this.chain = Promise.resolve();
    this.lastSpoken = null; // { text, at }
  }

  get alive() {
    return !(this.signal && this.signal.aborted);
  }

  enqueue(u) {
    this.chain = this.chain.then(() => this._speakUtterance(u)).catch(() => {});
    return this.chain;
  }

  async _speakUtterance(u) {
    let attempted = false;
    try {
      for (;;) {
        if (!this.alive || u.cancelled) break;
        const sentence = attempted ? await u.sentences.next() : await this._firstSentence(u);
        if (sentence === null || !this.alive || u.cancelled) break;
        if (!attempted && !u.beforeSpeech()) break;
        attempted = true;
        try {
          await this._speakSentence(u, sentence);
          this.onOutcome(true);
        } catch (e) {
          if (!this.alive || isAbortError(e)) break;
          if (e && e.fatal) {
            this.onFatal(e.message);
            break;
          }
          this.onSoftError(e);
          this.onOutcome(false);
        }
      }
    } finally {
      if (attempted && this.alive) this.emit({ type: 'tts-end', id: u.id });
    }
  }

  /**
   * First sentence of `u`. A translation with nothing speakable by commit + STALE_MS is stale and is
   * never spoken, so the chain stops waiting for it at that deadline (u.expired) instead of holding
   * every later utterance until the job itself gives up (JOB_TIMEOUT_MS).
   */
  _firstSentence(u) {
    const q = u.sentences;
    if (!u.job || q.items.length || q.closed) return q.next();
    return new Promise((resolve) => {
      let timer = null;
      q.next().then((s) => {
        if (timer !== null) this.clearTimeout(timer);
        timer = null;
        resolve(s);
      });
      timer = this.setTimeout(() => {
        timer = null;
        if (u.job.firstSentenceAt !== null) return; // a sentence is already on its way
        u.expired = true;
        resolve(null);
      }, Math.max(0, u.commitAt + STALE_MS - this.now()));
    });
  }

  async _speakSentence(u, text) {
    const t = this.now();
    const speed = speedForBacklog(this.playback.backlogMs());
    const previousText = this.lastSpoken && t - this.lastSpoken.at <= PREVIOUS_TEXT_WINDOW_MS ? this.lastSpoken.text : undefined;
    if (u.firstTtsAt === null) u.firstTtsAt = t;
    const coalescer = new ChunkCoalescer((bytes) => {
      if (!this.alive) return;
      this.playback.add(bytes.length);
      this.emit({ type: 'tts-chunk', id: u.id, b64: bytesToBase64(bytes) });
      u.audioRelayed();
    });
    try {
      await this.tts.speak({ text, lang: this.lang, previousText, speed, signal: this.signal, onBytes: (b) => coalescer.push(b) });
      this.lastSpoken = { text, at: this.now() };
    } finally {
      if (this.alive) coalescer.end(); // relay whatever arrived, even after a stall
    }
  }
}

/**
 * o additionally: tts (TtsClient), incomingPartial() -> { text, at } | null, playback?
 */
export class OutPipeline extends BasePipeline {
  constructor(o) {
    super({ ...o, dir: 'out' });
    this.spec = null; // { norm, src, text, job } — running speculative translation
    this.candidate = null; // { text, norm, lang } — latest partial, waiting to be stable
    this.specTimer = null;
    this.specWords = 0; // word count of the last speculation started in this segment
    this.muted = false; // Meet's mic is muted (core.setMuted)
    this.speech = new SpeechStage({
      tts: o.tts,
      lang: o.lang,
      emit: (m) => this.emit(m),
      signal: o.signal,
      now: o.now,
      onFatal: (r) => this.o.onFatal(r),
      onSoftError: (e) => this.o.onSoftError(e),
      onOutcome: (ok) => this._outcome(ok),
      playback: o.playback,
      setTimeout: o.setTimeout,
      clearTimeout: o.clearTimeout,
    });
  }

  _isEcho(text, refAt) {
    const since = refAt - ECHO_WINDOW_MS;
    const candidates = this.o.conversation.incomingSince(since);
    const p = this.o.incomingPartial ? this.o.incomingPartial() : null;
    if (p && p.at >= since) candidates.push(p.text);
    return isEchoOf(text, candidates);
  }

  // -- speculation

  onPartial(text, detected) {
    const n = normText(text);
    if (this.spec && this.spec.norm !== n) {
      this.spec.job.abort(); // the partial changed: the speculative translation is outdated
      this.spec = null;
    }
    if (this.candidate && this.candidate.norm === n) {
      if (detected) this.candidate.lang = detected;
      return; // unchanged: keep waiting / keep the running speculation
    }
    this._clearSpecTimer();
    this.candidate = null;
    const wc = wordCount(text);
    if (wc < SPECULATION_MIN_WORDS) return;
    const endsSentence = SENTENCE_END_RE.test(text.trim());
    if (this.specWords && !endsSentence && wc - this.specWords < SPECULATION_REGROW_WORDS) return;
    this.candidate = { text, norm: n, lang: detected };
    // A partial that already ends a sentence is very likely final: start almost at once (the STT socket
    // commits such sentences ~0.3 s after the voice stops, so waiting the full 300 ms would add latency).
    const delay = endsSentence ? SPECULATION_SENTENCE_MS : SPECULATION_STABLE_MS;
    this.specTimer = this.o.setTimeout(() => {
      this.specTimer = null;
      this._startSpeculation();
    }, delay);
  }

  _clearSpecTimer() {
    if (this.specTimer !== null) {
      this.o.clearTimeout(this.specTimer);
      this.specTimer = null;
    }
  }

  _startSpeculation() {
    const c = this.candidate;
    if (!c || this.spec || !this.alive) return;
    const src = 'en'; // SELF speaks English (see commit)
    if (isNonSpeech(c.text) || this._isEcho(c.text, this.o.now())) return;
    const job = this._startJob(c.text, src, this.o.conversation.render(), true);
    this.spec = { norm: c.norm, src, text: c.text, job };
    this.specWords = wordCount(c.text);
    job.result.then(() => {
      // A job that failed before its commit is never adopted, so a fatal error is reported here.
      if (!job.adopted && job.status === 'failed' && job.error && job.error.fatal) this.o.onFatal(job.error.message);
    });
  }

  _takeSpeculation() {
    this._clearSpecTimer();
    this.candidate = null;
    this.specWords = 0;
    const s = this.spec;
    this.spec = null;
    return s;
  }

  // -- commit

  commit(text, meta) {
    if (!this.alive) return;
    const original = cleanTranscript(text);
    if (!original) return;
    const detected = normalizeLang(meta && meta.lang);
    const commitAt = this._commitTime(meta);
    const id = this._beginSegment(original, detected);
    const spec = this._takeSpeculation();
    // Only a segment that overlapped incoming voice can be echo (meta.overlap from the host; unknown = maybe):
    // a user repeating a number or a time back to the other side must not be dropped.
    const echoRisk = !(meta && meta.overlap === false);

    if (isNonSpeech(original) || (echoRisk && this._isEcho(original, commitAt))) {
      if (spec) spec.job.abort();
      this._final(id, original, detected, { skipped: true });
      return;
    }

    // SELF speaks English: always translate. Trusting language detection here was harmful in real use:
    // Turkish-accented English was detected as Turkish (sent untranslated), and the other side's voice
    // leaking into the mic was detected as their language and spoken straight back to them.
    const src = 'en';
    const context = this.o.conversation.render();
    const entry = this.o.conversation.add({ dir: 'out', original, lang: src, at: commitAt });
    const u = new OutUtterance(this, { id, original, detected, src, commitAt, entry, echoRisk });

    if (src === this.o.lang) {
      if (spec) spec.job.abort();
      u.passthrough = true;
      // Spoken as said, but sound tags such as "(laughs)" are never read aloud.
      u.sentences = new SentenceQueue(splitSentences(stripSoundTags(original)), true);
      entry.translated = original;
      this._finalOut(u, { translated: original, passthrough: true });
    } else {
      const adopt = spec && spec.src === src && spec.norm === normText(original) && spec.job.status !== 'failed' && spec.job.status !== 'aborted';
      if (adopt) {
        u.job = spec.job;
        u.job.adopted = true;
        u.speculative = true;
      } else {
        if (spec) spec.job.abort();
        u.job = this._startJob(original, src, context, true);
      }
      u.sentences = u.job.sentences;
      u.job.result.then(() => this._finishOut(u));
    }
    this.speech.enqueue(u);
  }

  _finalOut(u, fields) {
    u.finalSent = true;
    this._final(u.id, u.original, u.detected, fields);
  }

  _finishOut(u) {
    if (!this.alive || u.cancelled) return;
    const job = u.job;
    u.translateMs = ms(job.doneAt - job.startedAt);
    switch (job.status) {
      case 'ok':
        if (!u.speechStarted && u.echoRisk && this._isEcho(u.original, u.commitAt)) {
          this._cancelAsEcho(u);
          return;
        }
        u.entry.translated = job.text;
        if (u.mutedSkip) this._finalOut(u, { translated: job.text, stale: true, muted: true });
        else this._finalOut(u, u.isStale() ? { translated: job.text, stale: true } : { translated: job.text });
        this._maybeMetrics(u);
        return;
      case 'skip':
        this.o.conversation.drop(u.entry);
        this._finalOut(u, { skipped: true });
        return;
      case 'refused':
        this._finalOut(u, { failed: true });
        return;
      case 'failed':
        this._reportFailure(job);
        this._finalOut(u, { failed: true });
        this._outcome(false);
        return;
      default: // aborted
    }
  }

  /** Meet's mic is muted (true) or open again (false). Utterances not yet spoken are skipped while muted. */
  setMuted(muted) {
    this.muted = !!muted;
  }

  _skipMuted(u) {
    if (u.mutedSkip) return;
    u.mutedSkip = true;
    // Already finalized as translated: correct that final caption.
    if (u.finalSent && u.job && u.job.status === 'ok') this._finalOut(u, { translated: u.job.text, stale: true, muted: true });
  }

  /** A sentence was spoken (true) or failed in translation / TTS (false): drives the voice passthrough. */
  _outcome(ok) {
    if (!this.alive || typeof this.o.onOutcome !== 'function') return;
    try { this.o.onOutcome(ok); } catch (_) { /* never break the pipeline */ }
  }

  /** Late echo detection (the incoming commit arrived after ours): drop it, never speak it. */
  _cancelAsEcho(u) {
    if (u.cancelled) return;
    u.cancelled = true;
    if (u.job) u.job.abort();
    if (u.sentences) u.sentences.cancel();
    this.o.conversation.drop(u.entry);
    this._finalOut(u, { skipped: true });
  }

  _maybeMetrics(u) {
    if (u.metricsSent || u.cancelled || u.mutedSkip || !u.finalSent || u.firstAudioAt === null) return;
    u.metricsSent = true;
    const m = {
      type: 'metrics',
      dir: 'out',
      id: u.id,
      translateMs: u.translateMs,
      firstAudioMs: ms(u.firstAudioAt - u.firstTtsAt),
      totalMs: ms(u.firstAudioAt - u.commitAt),
    };
    if (u.speculative) m.speculative = true;
    this.emit(m);
  }

  /** Resolves when everything queued for speech so far has been handled (tests). */
  idle() {
    return this.speech.chain;
  }

  dispose() {
    super.dispose();
    this._clearSpecTimer();
    this.candidate = null;
    if (this.spec) this.spec.job.abort();
    this.spec = null;
  }
}
