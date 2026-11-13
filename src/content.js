/*
 * Meet Canlı Çeviri - content script (isolated world, document_start). Contract v2.
 * - Bridge between the extension and inject.js (page MAIN world). Mic and remote
 *   audio chunks go to the offscreen engine fire-and-forget (no callbacks).
 * - Overlay v2 in a closed Shadow DOM (Meet's CSS cannot touch it): live drafts and
 *   final captions, language and latency badges, a draggable panel with a persisted
 *   position, the full-session transcript (copy / .txt download) and one-line notes.
 * - Diagnostics ("Tanı"): live level meters / recognition state per direction from the
 *   engine's `diag` messages, automatic hints in the note line, and a plain-text report
 *   (copied to the clipboard) built from small ring buffers kept since the page loaded.
 *   Content never receives API keys and never reads the `settings` storage key.
 * - Meet's mute (mic-state `muted`) goes to the engine as `mic-muted`; the engine's
 *   `voice-passthrough` goes to the page (my real voice while translation is impossible);
 *   leaving the call (no mic + quiet incoming audio for 60 s) stops the session.
 *   Pointer events stay off everywhere except the controls (and the open transcript /
 *   diagnostics block).
 */
(() => {
  'use strict';
  if (window.__mtContent) return;
  window.__mtContent = true;

  // <pure-helpers>
  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function hhmmss(ts) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  // 1234 -> "1,2 sn" (tenths rounded half-up on integers; toFixed would turn 950 into "0,9")
  function formatSec(ms) {
    const v = Number(ms);
    const tenths = Number.isFinite(v) && v > 0 ? Math.round(v / 100) : 0;
    return Math.floor(tenths / 10) + ',' + (tenths % 10) + ' sn';
  }

  // Mean of the last `size` values.
  class RollingAvg {
    constructor(size) {
      this.size = size || 5;
      this.vals = [];
    }
    push(v) {
      if (typeof v !== 'number' || !Number.isFinite(v)) return;
      this.vals.push(Math.max(0, v));
      if (this.vals.length > this.size) this.vals.shift();
    }
    get value() {
      if (!this.vals.length) return null;
      let sum = 0;
      for (const v of this.vals) sum += v;
      return sum / this.vals.length;
    }
    clear() {
      this.vals.length = 0;
    }
  }

  // Keeps a w x h box at (x, y) fully inside a vw x vh viewport with a margin;
  // a box larger than the viewport sticks to the top-left margin.
  function clampPos(x, y, w, h, vw, vh, margin) {
    const m = margin == null ? 8 : margin;
    const maxX = Math.max(m, vw - w - m);
    const maxY = Math.max(m, vh - h - m);
    const cx = Math.min(Math.max(Number.isFinite(x) ? x : m, m), maxX);
    const cy = Math.min(Math.max(Number.isFinite(y) ? y : m, m), maxY);
    return { x: Math.round(cx), y: Math.round(cy) };
  }

  function langCode(lang) {
    return typeof lang === 'string' && /^[a-z]{2,3}$/i.test(lang) ? lang.toUpperCase() : '';
  }

  function speakerLabel(dir, lang) {
    if (dir === 'out') return 'Sen';
    const code = langCode(lang);
    return code && code !== 'EN' ? 'Karşı taraf (' + code + ')' : 'Karşı taraf';
  }

  // Mark of a translation that was not spoken: `muted` = Meet's mic was off when it was ready.
  function staleMark(muted) {
    return muted ? 'seslendirilmedi (mikrofon kapalıydı)' : 'seslendirilmedi';
  }

  // The same inside the .txt transcript, which already wraps it in parentheses.
  function staleText(muted) {
    return muted ? 'seslendirilmedi, mikrofon kapalıydı' : 'seslendirilmedi';
  }

  // Session transcript as plain text. Entries (oldest first):
  // { at, dir, original, translated, lang, failed, stale, muted, passthrough }.
  function formatTranscript(entries) {
    const out = ['Meet Canlı Çeviri — konuşma metni'];
    if (entries.length) {
      const d = new Date(entries[0].at);
      out.push('Tarih: ' + pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear());
    }
    out.push('');
    const pad = '           '; // width of "[HH:MM:SS] "
    for (const e of entries) {
      out.push('[' + hhmmss(e.at) + '] ' + speakerLabel(e.dir, e.lang) + ': ' + (e.original || e.translated || ''));
      if (e.failed) {
        out.push(pad + '⚠ çevrilemedi');
      } else if (e.passthrough) {
        if (e.stale) out.push(pad + '(' + staleText(e.muted) + ')');
      } else if (e.translated) {
        out.push(pad + '→ ' + e.translated + (e.stale ? ' (' + staleText(e.muted) + ')' : ''));
      }
    }
    return out.join('\n') + '\n';
  }

  // ---- diagnostics helpers ----

  const REPORT_LIMITS = { status: 20, metrics: 10, captions: 8 }; // ring buffer sizes
  const STT_STATE_TEXT = {
    ready: 'bağlı',
    connecting: 'bağlanıyor',
    backoff: 'yeniden bağlanıyor',
    idle: 'beklemede',
    closed: 'kapalı',
  };
  const SECRET_FIELD = /key|token|secret|passw|auth/i;

  // "14:05:12.345"
  function stamp(ts) {
    const ms = new Date(ts).getMilliseconds();
    return hhmmss(ts) + '.' + (ms < 10 ? '00' : ms < 100 ? '0' : '') + ms;
  }

  function dateText(ts) {
    const d = new Date(ts);
    return pad2(d.getDate()) + '.' + pad2(d.getMonth() + 1) + '.' + d.getFullYear();
  }

  // The first n characters (code points) of s, with "…" when cut.
  function clip(s, n) {
    const cps = Array.from(String(s));
    return cps.length > n ? cps.slice(0, n).join('') + '…' : cps.join('');
  }

  // Lit segments (0..5) of the level meter: -60 dBFS = empty, -10 dBFS = full. Segment k lights
  // from 10k - 65 dB, so an empty meter is exactly the hints' "quiet" (< -55 dB); null = no audio.
  function meterLevel(db) {
    if (typeof db !== 'number' || !Number.isFinite(db)) return 0;
    return Math.max(0, Math.min(5, Math.round((db + 60) / 10)));
  }

  // -32.4 -> "−32 dB"; null (no audio in the last second) -> "ses yok"
  function formatDb(db) {
    if (typeof db !== 'number' || !Number.isFinite(db)) return 'ses yok';
    const v = Math.round(db);
    return (v < 0 ? '−' + -v : String(v)) + ' dB';
  }

  // 1234 -> "1,2 sn önce", 125000 -> "2 dk önce", null -> "—"
  function formatAgo(ms) {
    if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
    if (ms < 59950) return formatSec(ms) + ' önce';
    return Math.max(1, Math.floor(ms / 60000)) + ' dk önce';
  }

  // Recognition socket state in Turkish (an unknown state is shown as it came).
  function sttStateLabel(state) {
    if (typeof state !== 'string' || !state) return '—';
    return Object.prototype.hasOwnProperty.call(STT_STATE_TEXT, state) ? STT_STATE_TEXT[state] : clip(state, 20);
  }

  // JSON for the report: fields named like credentials are dropped, long strings cut.
  function safeJson(v) {
    try {
      const s = JSON.stringify(v, (k, x) => {
        if (k && SECRET_FIELD.test(k)) return undefined;
        return typeof x === 'string' && x.length > 300 ? clip(x, 300) : x;
      });
      return s === undefined ? 'null' : s;
    } catch (e) {
      return '"(okunamadı)"';
    }
  }

  // Last line of defence: anything shaped like an API key or a credential in a URL is masked.
  function redact(text) {
    return String(text)
      .replace(/\bsk[-_][A-Za-z0-9_-]{8,}/g, '[gizlendi]')
      .replace(/\b(token|key|api[_-]?key|xi-api-key|secret)=[^\s&"']+/gi, '$1=[gizlendi]')
      .replace(/\b[0-9a-f]{32,}\b/gi, '[gizlendi]');
  }

  // Plain-text diagnostics report. r = { now, version, ua, active, lang, sessionAt, state, ui, note,
  // fwd: {mic, remote, micAt, remoteAt}, diag, mic, remote: {at, msg}|null, status: [{at, text}],
  // metrics / captions: [{at, msg}] }.
  function formatReport(r) {
    const tz = -new Date(r.now).getTimezoneOffset();
    const tza = Math.abs(tz);
    const ui = r.ui || {};
    const sent = r.fwd || {};
    const ago = (at) => (at ? ' (son ' + formatAgo(r.now - at) + ')' : '');
    const out = [
      'Meet Canlı Çeviri — tanı raporu',
      'Zaman: ' + dateText(r.now) + ' ' + hhmmss(r.now) +
        ' (UTC' + (tz < 0 ? '-' : '+') + pad2(Math.floor(tza / 60)) + ':' + pad2(tza % 60) + ')',
      'Sürüm: ' + (r.version || '?'),
      'Tarayıcı: ' + (r.ua || '?'),
      'Oturum: ' + (r.active ? 'etkin' : 'kapalı') + (r.lang ? ' · dil: ' + r.lang : '') +
        (r.sessionAt ? ' · başlangıç: ' + hhmmss(r.sessionAt) : '') + ' · durum: ' + (r.state || '—'),
      'Ayarlar (ui): captionSize=' + ui.captionSize + ', incomingSource=' + ui.incomingSource +
        ', originalVoice=' + ui.originalVoice + ', showLatency=' + ui.showLatency,
      'Not: ' + (r.note || '—'),
      'Sayfadan motora iletilen ses: mikrofon ' + (sent.mic || 0) + ' parça' + ago(sent.micAt) +
        ', gelen ses ' + (sent.remote || 0) + ' parça' + ago(sent.remoteAt),
    ];
    const section = (title, items, line) => {
      out.push('', '== ' + title + ' ==');
      if (!items.length) out.push('(yok)');
      for (const it of items) out.push(stamp(it.at) + ' ' + line(it));
    };
    const json = (it) => safeJson(it.msg);
    section('Son tanı (diag)', r.diag ? [r.diag] : [], json);
    section('Durum (status, son ' + REPORT_LIMITS.status + ')', r.status || [], (it) => it.text);
    section('Ölçümler (metrics, son ' + REPORT_LIMITS.metrics + ')', r.metrics || [], json);
    section('Mikrofon durumu (mic-state, en son)', r.mic ? [r.mic] : [], json);
    section('Gelen ses durumu (remote-state, en son)', r.remote ? [r.remote] : [], json);
    section('Altyazılar (caption, son ' + REPORT_LIMITS.captions + ')', r.captions || [], json);
    return out.join('\n') + '\n';
  }
  // </pure-helpers>

  const MAX_BLOCKS = 3;
  const IDLE_FADE_MS = 12000; // dim a line that has not changed for this long
  const IDLE_REMOVE_MS = 17000; // ...and drop it
  const ERROR_LINGER_MS = 8000; // keep an error visible after the session ended
  const POS_OPACITY = [1, 0.72, 0.48]; // newest, older, oldest
  const TIP_MS = 10000; // headphone tip at the start of a session
  const NO_REMOTE_MS = 20000; // no remote track for this long -> note
  const RESTART_KEEP_MS = 15000; // a start this soon after a stop (language switch) keeps the transcript
  const LIVE_NOTICE_MS = 6000; // a 'live' status message shows this long
  const MAX_TRANSCRIPT = 10000;
  const EDGE = 8; // px between a dragged panel and the viewport edge
  const DRAG_SLOP = 3;
  const SIZES = { s: 'size-s', m: 'size-m', l: 'size-l' };

  const STATUS_TEXT = {
    connecting: 'Bağlanıyor…',
    live: 'Canlı çeviri',
    stopped: 'Durduruldu',
    error: 'Hata oluştu',
  };
  const NOTE_MIC = 'Sesinizin karşıya gitmesi için Meet sayfasında herhangi bir yere tıklayın.';
  const NOTE_REMOTE =
    'Gelen ses bulunamadı. Toplantıya katıldığınızdan emin olun; sorun sürerse Ayarlar\'dan "Sekme sesi" modunu seçin.';
  const NOTE_TIP = 'İpucu: yankıyı önlemek için kulaklık kullanın.';
  const NOTE_TAB =
    'Toplantı sesi artık Windows\'un varsayılan ses çıkışından geliyor; kulaklık kullanıyorsanız onu Windows\'ta varsayılan yapın.';
  const TAB_NOTE_MS = 12000; // capture 'tab': NOTE_TAB first, then the headphone tip
  const NOTE_NO_MIC =
    'Mikrofonunuz çeviriye bağlı değil. Toplantıdaysanız Meet\'te mikrofonunuzu açın (sorun sürerse sayfayı yenileyin); toplantıdan ayrıldıysanız çeviri kendiliğinden durur.';
  const NO_MIC_MS = 15000; // a session without any virtual mic for this long gets NOTE_NO_MIC
  const NOTE_PASSTHROUGH = 'Çeviri geçici olarak yapılamıyor; sesiniz doğrudan gidiyor.';
  const NOTE_LEFT = 'Toplantıdan ayrıldınız; çeviri durduruldu.';
  const LEFT_MS = 60000; // no virtual mic AND quiet incoming audio this long = the call was left: auto-stop
  const COPY_TEXT = 'Kopyala';

  // Diagnostics: automatic hints from the engine's ~1/s `diag` messages (lowest-priority notes).
  const DIAG_QUIET_DB = -55; // a side whose loudest chunk stays below this (or has no audio) is quiet
  const DIAG_QUIET_MS = 20000; // quiet while chunks flow and no caption of that direction -> hint
  const DIAG_NOT_READY_MS = 15000; // recognition socket not 'ready' for this long -> hint
  const DIAG_STALE_MS = 5000; // older diag data drives no hint and is labelled in the panel
  const DIAG_STALL_MS = 6000; // chunks that have not moved for this long are not "flowing" (keepalive: 4 s)
  const DIAG_COPY_TEXT = 'Tanı raporunu kopyala';
  const HINTS = {
    in: {
      quiet: 'Karşı tarafın sesi gelmiyor gibi. Toplantı sesini duyuyor musunuz? Ayarlar\'dan ses kaynağını değiştirip yeniden başlatın.',
      state: 'Konuşma tanıma bağlantısı kurulamadı (gelen ses). İnternet bağlantınızı kontrol edin.',
    },
    out: {
      quiet: 'Mikrofon sesi gelmiyor gibi. Meet\'te mikrofonunuz açık mı?',
      state: 'Konuşma tanıma bağlantısı kurulamadı (mikrofon). İnternet bağlantınızı kontrol edin.',
    },
  };

  let active = false;
  let cfg = normalizeUi(null);
  let seq = 0; // session number; namespaces caption ids across restarts
  let lastState = null;
  let pendingStatus = null; // status that raced ahead of mt-start
  let micState = null;
  let micNoneSince = null; // since when the page reports no virtual mic at all
  let zeroSince = null; // since when no remote track is known (capture 'page')
  let sessionAt = 0;
  let stoppedAt = 0;
  let hideTimer = 0;
  let tickTimer = 0;
  let noticeTimer = 0;
  const flashTimers = new Map(); // button -> timer restoring its label

  const blocks = new Map(); // key -> block
  const dropped = new Set(); // keys already removed (ignore their late updates)
  const order = []; // blocks, oldest first
  const segs = new Map(); // key -> { at, lang } (segment start time / detected language)
  const avg = { in: new RollingAvg(5), out: new RollingAvg(5) };
  const transcript = []; // final captions of the session, sorted by start time
  const txIndex = new Map(); // key -> transcript entry
  let txOpen = false;

  let host = null;
  let view = null; // overlay DOM refs
  let pos = null; // persisted {x, y} of a dragged panel; null = docked (bottom centre)
  let drag = null;

  // Diagnostics state. The ring buffers record from the moment this script loads (not only
  // during a session) so a report is useful right after a failure.
  let diagOpen = false;
  let diagTouched = false; // toggled before the stored choice loaded: the click wins
  let lastDiag = null; // { at, msg } (sanitized copy of the last `diag` message)
  const watch = { in: newWatch(), out: newWatch() }; // streaks behind the automatic hints
  const log = { status: [], metrics: [], captions: [] };
  let micRec = null; // latest mic-state { at, msg }
  let remoteRec = null; // latest remote-state { at, msg }
  let micMuted = false; // the page says Meet's mic is muted (`muted` in mic-state)
  let mutedSynced = false; // the engine got the mute state since this session's engine came up (first diag)
  let voicePass = null; // { reason } while the engine lets my real voice through
  let inSilentSince = null; // first diag of the current run whose incoming level is null / quiet
  let stopReason = null; // why the session stopped (shown in the kept bar), e.g. NOTE_LEFT
  let sessionLang = null;
  const fwd = { mic: 0, remote: 0, micAt: 0, remoteAt: 0 }; // chunks this script forwarded this session

  function normalizeUi(u) {
    const o = u && typeof u === 'object' ? u : {};
    return {
      originalVoice: o.originalVoice === 'low' ? 'low' : 'off',
      incomingSource: o.incomingSource === 'tab' ? 'tab' : 'page',
      captionSize: Object.prototype.hasOwnProperty.call(SIZES, o.captionSize) ? o.captionSize : 'm',
      showLatency: o.showLatency !== false,
    };
  }

  // ---- overlay ----------------------------------------------------------------

  const CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .panel {
      position: absolute; left: 0; top: 0;
      width: min(820px, calc(100% - 32px)); box-sizing: border-box;
      background: rgba(16, 17, 21, 0.78);
      -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 14px; padding: 8px 12px 10px;
      color: #fff; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35);
      pointer-events: none;
      font-family: "Segoe UI", system-ui, -apple-system, Roboto, sans-serif;
      --trans-size: 20px; --orig-size: 13px;
    }
    .panel.docked { left: 50%; top: auto; bottom: 108px; transform: translateX(-50%); }
    .panel.size-s { --trans-size: 16px; --orig-size: 12px; }
    .panel.size-m { --trans-size: 20px; --orig-size: 13px; }
    .panel.size-l { --trans-size: 26px; --orig-size: 15px; }
    .head { display: flex; align-items: center; gap: 8px; min-width: 0; }
    .grip {
      pointer-events: auto; flex: none; box-sizing: content-box;
      width: 10px; height: 15px; padding: 4px 3px; margin-left: -5px;
      cursor: grab; touch-action: none; user-select: none; border-radius: 6px;
      background-image: radial-gradient(circle, rgba(255, 255, 255, 0.55) 1.2px, transparent 1.7px);
      background-size: 5px 5px; background-position: center;
      background-origin: content-box; background-clip: content-box;
    }
    .grip:active { cursor: grabbing; }
    .pill {
      display: inline-flex; align-items: center; gap: 7px; min-width: 0;
      font-size: 12px; line-height: 1; font-weight: 600; letter-spacing: .02em;
      color: #e5e7eb; background: rgba(255, 255, 255, 0.1);
      padding: 5px 10px 5px 8px; border-radius: 999px;
    }
    .pill .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: #9ca3af; flex: none; }
    .pill.connecting .dot { background: #f59e0b; animation: pulse 1.1s ease-in-out infinite; }
    .pill.live .dot { background: #22c55e; }
    .pill.error .dot { background: #ef4444; }
    .pill.stopped .dot { background: #9ca3af; }
    @keyframes pulse { 50% { opacity: .3; } }
    .lat {
      flex: none; font-size: 12px; line-height: 1; color: #cbd5e1;
      white-space: nowrap; font-variant-numeric: tabular-nums;
    }
    .spacer { flex: 1 1 auto; min-width: 0; }
    button {
      pointer-events: auto; cursor: pointer; flex: none; margin: 0;
      font: 600 12px/1 "Segoe UI", system-ui, sans-serif;
      border: 0; border-radius: 999px; padding: 6px 12px;
    }
    button:disabled { opacity: .45; cursor: default; }
    button.ghost { color: #e5e7eb; background: rgba(255, 255, 255, 0.12); }
    button.ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.2); }
    button.ghost[aria-pressed="true"] { color: #fff; background: rgba(255, 255, 255, 0.28); }
    button.stop { color: #fff; background: rgba(239, 68, 68, 0.9); }
    button.stop:hover { background: #ef4444; }
    .note { margin-top: 6px; font-size: 12px; line-height: 1.35; color: #fbbf24; }
    .diag {
      pointer-events: auto; margin-top: 8px; padding: 8px 10px;
      border-radius: 10px; background: rgba(255, 255, 255, 0.06);
      font-size: 12px; line-height: 1.35; color: #e5e7eb;
      font-variant-numeric: tabular-nums; user-select: text;
    }
    .dg-rows {
      display: grid; grid-template-columns: max-content max-content max-content minmax(0, 1fr);
      align-items: center; column-gap: 10px; row-gap: 6px;
    }
    .dg-row { display: contents; }
    .dg-name { font-weight: 600; color: #cbd5e1; white-space: nowrap; }
    .dg-meter { display: inline-flex; gap: 2px; }
    .dg-seg { width: 6px; height: 11px; border-radius: 2px; background: rgba(255, 255, 255, 0.16); }
    .dg-seg.on { background: #22c55e; }
    .dg-db { min-width: 4.2em; white-space: nowrap; }
    .dg-db.none { color: #9ca3af; }
    .dg-info { min-width: 0; color: #9ca3af; }
    .dg-info > span + span::before { content: "·"; margin: 0 6px; color: #6b7280; }
    .dg-info > .dg-muted::before { content: none; }
    .dg-state.ok { color: #86efac; }
    .dg-state.warn { color: #fbbf24; }
    .dg-muted { margin-left: 6px; font-weight: 600; color: #fbbf24; }
    .dg-foot { display: flex; align-items: center; gap: 10px; margin-top: 8px; }
    .dg-age { flex: 1 1 auto; min-width: 0; font-size: 11px; color: #9ca3af; }
    .tx {
      pointer-events: auto; margin-top: 8px; padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.1);
      display: flex; flex-direction: column; max-height: 40vh; min-height: 0;
    }
    .tx-head { display: flex; align-items: center; gap: 8px; flex: none; }
    .tx-title { flex: 1 1 auto; min-width: 0; font-size: 12px; font-weight: 600; color: #e5e7eb; }
    .tx-empty { margin-top: 6px; font-size: 12px; color: #9ca3af; }
    .tx-list {
      margin-top: 6px; min-height: 0; flex: 1 1 auto;
      overflow-y: auto; overscroll-behavior: contain; user-select: text;
    }
    .tx-row {
      display: grid; grid-template-columns: auto 1fr; column-gap: 10px;
      padding: 5px 2px; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }
    .tx-time { font-size: 12px; line-height: 1.5; color: #6b7280; font-variant-numeric: tabular-nums; }
    .tx-who { font-size: 11px; font-weight: 700; letter-spacing: .03em; color: #9ca3af; }
    .tx-row.out .tx-who { color: #fdba74; }
    .tx-orig { font-size: 13px; line-height: 1.4; color: #cbd5e1; word-break: break-word; }
    .tx-trans { font-size: 14px; line-height: 1.4; font-weight: 600; color: #fff; word-break: break-word; }
    .tx-mark { font-size: 12px; font-weight: 600; color: #fbbf24; }
    .tx-mark.stale { color: #fca5a5; }
    .lines { margin-top: 6px; display: flex; flex-direction: column; gap: 8px; }
    .lines:empty { display: none; }
    .blk { opacity: 0; transition: opacity .4s ease; }
    .blk .orig { font-size: var(--orig-size); line-height: 1.3; color: #9ca3af; word-break: break-word; }
    .blk .trans { font-size: var(--trans-size); line-height: 1.3; font-weight: 600; color: #fff; word-break: break-word; }
    .blk .trans.pending { color: rgba(255, 255, 255, 0.4); font-weight: 500; }
    .blk .trans.draft { font-style: italic; font-weight: 500; color: rgba(255, 255, 255, 0.62); }
    .blk .trans.draft.committed { color: rgba(255, 255, 255, 0.45); }
    .blk.partial .orig { font-style: italic; }
    .blk.failed .orig { font-size: var(--trans-size); font-weight: 500; color: #f3f4f6; }
    .badge {
      display: inline-block; margin-right: 6px; padding: 2px 6px; border-radius: 999px;
      font-size: 10px; line-height: 1.2; font-weight: 700; letter-spacing: .05em; font-style: normal;
      vertical-align: 2px; color: #93c5fd; background: rgba(59, 130, 246, 0.22);
    }
    .mark {
      margin-left: 8px; font-size: 12px; font-weight: 600; font-style: normal;
      white-space: nowrap; color: #fbbf24;
    }
    .mark.stale { color: #fca5a5; }
    .blk.failed .mark { margin-left: 0; }
    .latb {
      margin-left: 8px; font-size: 11px; font-weight: 600; font-style: normal; white-space: nowrap;
      color: #94a3b8; font-variant-numeric: tabular-nums; vertical-align: 1px;
    }
    .blk.out .row { display: flex; align-items: baseline; gap: 8px; }
    .blk.out .tag {
      flex: none; font-size: 11px; font-weight: 700; letter-spacing: .04em;
      color: #fdba74; background: rgba(249, 115, 22, 0.2);
      padding: 2px 7px; border-radius: 999px;
    }
    .blk.out .orig { color: rgba(156, 163, 175, 0.75); margin-top: 1px; }
    .blk.out.failed .orig { color: #f3f4f6; }
  `;

  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function stopEvent(e) {
    try {
      e.stopPropagation();
    } catch (err) {
      /* ignore */
    }
  }

  function button(cls, text, title, onClick) {
    const b = el('button', cls, text);
    b.type = 'button';
    if (title) b.title = title;
    b.addEventListener('pointerdown', stopEvent);
    b.addEventListener('click', (e) => {
      stopEvent(e);
      try {
        onClick(e);
      } catch (err) {
        /* ignore */
      }
      try {
        b.blur(); // a focused button would catch Meet's keyboard shortcuts (space)
      } catch (err) {
        /* ignore */
      }
    });
    return b;
  }

  function buildUi() {
    host = document.createElement('div');
    host.id = 'mt-overlay-host';
    host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:none;';
    const root = host.attachShadow({ mode: 'closed' });

    try {
      const sheet = new CSSStyleSheet(); // constructable sheets are exempt from page style-src CSP
      sheet.replaceSync(CSS);
      root.adoptedStyleSheets = [sheet];
    } catch (e) {
      const st = document.createElement('style');
      st.textContent = CSS;
      root.appendChild(st);
    }

    const panel = el('div', 'panel docked ' + SIZES.m);
    const head = el('div', 'head');
    const grip = el('span', 'grip');
    grip.title = 'Sürükleyerek taşıyın · çift tıklayınca yerine döner';
    const pill = el('div', 'pill connecting');
    pill.appendChild(el('span', 'dot'));
    const pillText = el('span', 't', STATUS_TEXT.connecting);
    pill.appendChild(pillText);
    const lat = el('span', 'lat');
    lat.hidden = true;
    const spacer = el('span', 'spacer');
    const diagBtn = button('ghost', 'Tanı', 'Tanı panelini göster / gizle', () => setDiagOpen(!diagOpen, true));
    diagBtn.setAttribute('aria-pressed', 'false');
    const txBtn = button('ghost', 'Metin', 'Konuşma metnini göster / gizle', () => setTxOpen(!txOpen));
    txBtn.setAttribute('aria-pressed', 'false');
    const stop = button('stop', '■ Durdur', '', () => {
      logEvent('panelden durduruldu');
      sendRuntime({ type: 'mt-stop' });
      stopSession(false);
    });
    stop.setAttribute('aria-label', 'Çeviriyi durdur');
    const close = button('ghost', 'Kapat', '', () => hideOverlay());
    close.hidden = true;
    head.append(grip, pill, lat, spacer, diagBtn, txBtn, stop, close);

    const diag = el('div', 'diag');
    diag.hidden = true;
    const dgRows = el('div', 'dg-rows');
    const dgIn = diagRow('Gelen ses (Meet)', false);
    const dgOut = diagRow('Mikrofon', true);
    dgRows.append(dgIn.root, dgOut.root);
    const dgFoot = el('div', 'dg-foot');
    const dgCopy = button('ghost dg-copy', DIAG_COPY_TEXT,
      'Sorunu bildirmek için tanı bilgilerini panoya kopyalar (API anahtarları dahil edilmez)', onCopyReport);
    const dgAge = el('span', 'dg-age');
    dgFoot.append(dgCopy, dgAge);
    diag.append(dgRows, dgFoot);

    const note = el('div', 'note');
    note.hidden = true;

    const tx = el('div', 'tx');
    tx.hidden = true;
    const txHead = el('div', 'tx-head');
    const txTitle = el('span', 'tx-title', 'Konuşma metni');
    const copyBtn = button('ghost', COPY_TEXT, '', onCopy);
    const dlBtn = button('ghost', 'İndir (.txt)', '', onDownload);
    txHead.append(txTitle, copyBtn, dlBtn);
    const txEmpty = el('div', 'tx-empty', 'Henüz metin yok.');
    const txList = el('div', 'tx-list');
    tx.append(txHead, txEmpty, txList);

    const lines = el('div', 'lines');
    panel.append(head, diag, note, tx, lines);
    root.appendChild(panel);
    view = {
      root, panel, grip, pill, pillText, lat, diagBtn, txBtn, stop, close, diag, dgIn, dgOut, dgCopy, dgAge,
      note, tx, txTitle, copyBtn, dlBtn, txEmpty, txList, lines,
    };

    wireDrag(grip, panel);
    try {
      new ResizeObserver(() => applyPos()).observe(panel); // re-clamp when the content grows
    } catch (e) {
      /* ignore */
    }
    window.addEventListener('resize', () => applyPos());
    updateTxMeta();
    renderDiag();
    loadPos();
    loadDiag();
  }

  // One diagnostics row: name, 5-segment level meter, dB, then state · last text · commits.
  function diagRow(name, withMuted) {
    const root = el('div', 'dg-row');
    const nameEl = el('span', 'dg-name', name);
    const meter = el('span', 'dg-meter');
    const segs = [];
    for (let i = 0; i < 5; i++) {
      const s = el('span', 'dg-seg');
      segs.push(s);
      meter.appendChild(s);
    }
    const db = el('span', 'dg-db');
    const info = el('span', 'dg-info');
    const state = el('span', 'dg-state');
    const last = el('span', 'dg-last');
    const commits = el('span', 'dg-commits');
    info.append(state, last, commits);
    let muted = null;
    let gated = null;
    if (withMuted) {
      gated = el('span', 'dg-gated'); // echo guard: mic chunks replaced by silence
      gated.hidden = true;
      muted = el('span', 'dg-muted', '(Meet\'te sessizde)');
      muted.hidden = true;
      info.append(gated, muted);
    }
    root.append(nameEl, meter, db, info);
    return { root, name: nameEl, segs, db, state, last, commits, muted, gated };
  }

  function mountHost() {
    if (!host) buildUi();
    if (host.isConnected) return;
    const parent = document.documentElement;
    if (!parent) return; // retried by showOverlay / tick
    try {
      parent.appendChild(host);
    } catch (e) {
      /* ignore */
    }
  }

  function showOverlay() {
    clearTimeout(hideTimer);
    hideTimer = 0;
    mountHost();
    host.style.display = 'block';
    applyPos();
    if (!tickTimer) tickTimer = setInterval(tick, 1000);
  }

  function hideOverlay() {
    clearTimeout(hideTimer);
    hideTimer = 0;
    setTxOpen(false);
    if (host) host.style.display = 'none';
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = 0;
    }
  }

  function setPill(state, text) {
    if (!view) return;
    view.pill.className = 'pill ' + state;
    view.pillText.textContent = text;
    view.pill.title = text;
  }

  function setStatus(state, message) {
    lastState = state;
    clearTimeout(noticeTimer);
    noticeTimer = 0;
    let text = STATUS_TEXT[state] || '';
    const msg = typeof message === 'string' ? message.trim() : '';
    if (msg && (state === 'error' || state === 'connecting' || state === 'stopped')) text = msg;
    if (msg && state === 'live') {
      text = msg; // a transient notice (e.g. one sentence failed), then back to the plain label
      noticeTimer = setTimeout(() => {
        noticeTimer = 0;
        if (lastState === 'live') setPill('live', STATUS_TEXT.live);
      }, LIVE_NOTICE_MS);
    }
    setPill(state, text);
  }

  function currentNote(now) {
    if (!active) return '';
    if (micState === 'suspended') return NOTE_MIC;
    if (voicePass) return NOTE_PASSTHROUGH + (voicePass.reason ? ' ' + voicePass.reason : '');
    if (micState === 'none' && micNoneSince != null && now - micNoneSince >= NO_MIC_MS) return NOTE_NO_MIC;
    if (cfg.incomingSource === 'page' && zeroSince != null && now - zeroSince >= NO_REMOTE_MS) return NOTE_REMOTE;
    const age = now - sessionAt;
    if (cfg.incomingSource === 'tab') {
      if (age < TAB_NOTE_MS) return NOTE_TAB;
      if (age < TAB_NOTE_MS + TIP_MS) return NOTE_TIP;
    } else if (age < TIP_MS) {
      return NOTE_TIP;
    }
    return diagHint(now); // lowest priority
  }

  function updateNote(now) {
    if (!view) return;
    const text = currentNote(now == null ? Date.now() : now);
    if (view.note.textContent !== text) view.note.textContent = text;
    view.note.hidden = !text;
  }

  function renderLatency() {
    if (!view) return;
    const parts = [];
    if (active && cfg.showLatency) {
      const a = avg.in.value;
      const b = avg.out.value;
      if (a != null) parts.push('↘ ' + formatSec(a));
      if (b != null) parts.push('↗ ' + formatSec(b));
    }
    view.lat.textContent = parts.join(' · ');
    view.lat.hidden = !parts.length;
  }

  function applySize() {
    if (!view) return;
    for (const k of Object.keys(SIZES)) view.panel.classList.toggle(SIZES[k], k === cfg.captionSize);
  }

  // ---- position / drag ----------------------------------------------------------

  function lastErr() {
    try {
      void chrome.runtime.lastError;
    } catch (e) {
      /* extension context gone */
    }
  }

  function sanitizePos(p) {
    return p && typeof p === 'object' && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  }

  // The stored position is the user's intent; the applied one is clamped into the
  // current viewport for the current panel size (resize, content growth).
  function applyPos() {
    if (!view) return;
    const p = view.panel;
    if (!pos) {
      p.classList.add('docked');
      p.style.left = '';
      p.style.top = '';
      return;
    }
    p.classList.remove('docked');
    const c = clampPos(pos.x, pos.y, p.offsetWidth, p.offsetHeight, window.innerWidth || 0, window.innerHeight || 0, EDGE);
    p.style.left = c.x + 'px';
    p.style.top = c.y + 'px';
  }

  function savePos(p) {
    try {
      chrome.storage.local.set({ overlayPos: { x: Math.round(p.x), y: Math.round(p.y) } }, lastErr);
    } catch (e) {
      /* ignore */
    }
  }

  function resetPos() {
    pos = null;
    applyPos();
    try {
      chrome.storage.local.remove('overlayPos', lastErr);
    } catch (e) {
      /* ignore */
    }
  }

  function loadPos() {
    try {
      chrome.storage.local.get('overlayPos', (r) => {
        lastErr();
        if (drag) return;
        pos = sanitizePos(r && r.overlayPos);
        applyPos();
      });
    } catch (e) {
      /* ignore */
    }
  }

  function wireDrag(grip, panel) {
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      stopEvent(e);
      const r = panel.getBoundingClientRect();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, ox: r.left, oy: r.top, moved: false };
      try {
        grip.setPointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
    });
    grip.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      stopEvent(e);
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) return;
      drag.moved = true;
      pos = clampPos(drag.ox + dx, drag.oy + dy, panel.offsetWidth, panel.offsetHeight,
        window.innerWidth || 0, window.innerHeight || 0, EDGE);
      applyPos();
    });
    const end = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      drag = null;
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch (err) {
        /* ignore */
      }
      if (moved && pos) savePos(pos);
    };
    grip.addEventListener('pointerup', (e) => {
      stopEvent(e);
      end(e);
    });
    grip.addEventListener('pointercancel', end);
    grip.addEventListener('lostpointercapture', end);
    grip.addEventListener('click', stopEvent);
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault();
      stopEvent(e);
      resetPos();
    });
  }

  // ---- caption blocks -------------------------------------------------------------

  function makeBlock(dir, key) {
    const root = el('div', 'blk ' + dir);
    const origEl = el('div', 'orig');
    const badge = el('span', 'badge');
    badge.hidden = true;
    const otext = el('span', 'otext');
    origEl.append(badge, otext);
    const trans = el('div', 'trans pending');
    const ttext = el('span', 'ttext');
    const mark = el('span', 'mark');
    mark.hidden = true;
    const lat = el('span', 'latb');
    lat.hidden = true;
    trans.append(ttext, mark, lat);
    if (dir === 'out') {
      const row = el('div', 'row');
      row.append(el('span', 'tag', 'Sen'), trans);
      root.append(row, origEl);
    } else {
      root.append(origEl, trans);
    }
    return {
      key, dir, root, origEl, badge, otext, trans, ttext, mark, lat,
      original: '', draft: '', translated: '', lang: null, totalMs: null,
      partial: true, committed: false, failed: false, stale: false, muted: false, passthrough: false,
      updated: Date.now(),
    };
  }

  // Applies one caption message to a block; false = a late message to ignore.
  function applyCaption(b, msg) {
    if (langCode(msg.lang)) b.lang = msg.lang;
    if (msg.partial) {
      if (b.committed) return false; // a partial / draft that raced past the commit
      if (msg.draft) {
        if (typeof msg.translated !== 'string') return false;
        b.draft = msg.translated;
      } else if (typeof msg.original === 'string') {
        b.original = msg.original;
      }
      b.partial = true;
      return true;
    }
    b.partial = false;
    b.committed = true;
    if (typeof msg.original === 'string' && msg.original) b.original = msg.original;
    if (msg.failed) b.failed = true;
    else if (typeof msg.translated === 'string' && !msg.draft) b.translated = msg.translated;
    if (msg.stale) b.stale = true;
    if (msg.muted) b.muted = true;
    if (msg.passthrough) b.passthrough = true;
    return true;
  }

  function renderBlock(b) {
    const code = b.dir === 'in' ? langCode(b.lang) : '';
    const badge = code && code !== 'EN' ? code : '';
    b.badge.textContent = badge;
    b.badge.hidden = !badge;
    b.otext.textContent = b.original;
    b.origEl.hidden = b.passthrough || !b.original; // passthrough: the text is shown once

    let text = '';
    let cls = 'trans';
    if (b.failed) {
      text = ''; // the original (above / below) is the text; only the mark here
    } else if (b.translated) {
      text = b.translated;
    } else if (b.draft) {
      text = b.draft;
      cls += b.committed ? ' draft committed' : ' draft';
    } else if (b.original || b.dir === 'out') {
      text = '…';
      cls += ' pending';
    }
    b.ttext.textContent = text;
    b.trans.className = cls;

    const mark = b.failed ? '⚠ çevrilemedi' : b.stale ? staleMark(b.muted) : '';
    b.mark.textContent = mark;
    b.mark.className = b.failed ? 'mark' : 'mark stale';
    b.mark.hidden = !mark;

    const lat = cfg.showLatency && b.totalMs != null ? formatSec(b.totalMs) : '';
    b.lat.textContent = lat;
    b.lat.hidden = !lat;

    b.root.classList.toggle('partial', b.partial);
    b.root.classList.toggle('failed', b.failed);
  }

  function markDropped(key) {
    dropped.add(key);
    if (dropped.size > 500) dropped.delete(dropped.values().next().value);
  }

  function removeBlock(b, immediate) {
    const i = order.indexOf(b);
    if (i >= 0) order.splice(i, 1);
    blocks.delete(b.key);
    markDropped(b.key);
    if (immediate) {
      b.root.remove();
    } else {
      b.root.style.opacity = '0';
      setTimeout(() => b.root.remove(), 450);
    }
  }

  function layout(now) {
    const t = now == null ? Date.now() : now;
    for (let i = order.length - 1; i >= 0; i--) {
      const b = order[i];
      const p = POS_OPACITY[Math.min(order.length - 1 - i, POS_OPACITY.length - 1)];
      b.root.style.opacity = String(t - b.updated > IDLE_FADE_MS ? Math.min(p, 0.25) : p);
    }
  }

  function tick() {
    try {
      if (!extAlive()) {
        onOrphaned();
        return;
      }
      if (host && !host.isConnected) mountHost();
      const now = Date.now();
      if (checkLeft(now)) return;
      for (const b of order.slice()) {
        if (now - b.updated > IDLE_REMOVE_MS) removeBlock(b, false);
      }
      layout(now);
      updateNote(now);
      renderDiag(now);
    } catch (e) {
      /* ignore */
    }
  }

  function clearBlocks() {
    for (const b of order) b.root.remove();
    order.length = 0;
    blocks.clear();
    dropped.clear();
  }

  function segOf(key) {
    let s = segs.get(key);
    if (!s) {
      s = { at: Date.now(), lang: null };
      segs.set(key, s);
      if (segs.size > 400) segs.delete(segs.keys().next().value);
    }
    return s;
  }

  function onCaption(msg) {
    noteCaption(msg);
    if (!active || !view) return;
    const dir = msg.dir;
    if ((dir !== 'in' && dir !== 'out') || msg.id == null) return;
    const key = seq + ':' + dir + ':' + msg.id;
    const seg = segOf(key);
    if (langCode(msg.lang)) seg.lang = msg.lang;
    recordTranscript(key, dir, msg, seg);

    if (msg.skipped) {
      const b = blocks.get(key);
      if (b) removeBlock(b, false);
      else markDropped(key);
      layout();
      return;
    }
    if (dropped.has(key)) return;
    let b = blocks.get(key);
    if (!b) {
      const empty = msg.partial && !msg.original && !(msg.draft && msg.translated);
      if (empty) return;
      b = makeBlock(dir, key);
      blocks.set(key, b);
      order.push(b);
      view.lines.appendChild(b.root);
      while (order.length > MAX_BLOCKS) removeBlock(order[0], false);
    }
    if (!applyCaption(b, msg)) return;
    b.updated = Date.now();
    renderBlock(b);
    layout();
  }

  function onMetrics(msg) {
    pushLog('metrics', { at: Date.now(), msg: brief(msg) });
    if (!active || !view) return;
    const dir = msg.dir;
    if (dir !== 'in' && dir !== 'out') return;
    const ms = Number(msg.totalMs);
    if (!Number.isFinite(ms)) return;
    avg[dir].push(ms);
    const b = blocks.get(seq + ':' + dir + ':' + msg.id);
    if (b) {
      b.totalMs = Math.max(0, ms);
      renderBlock(b);
    }
    renderLatency();
  }

  // ---- transcript -------------------------------------------------------------------

  function recordTranscript(key, dir, msg, seg) {
    if (msg.partial) return;
    const existing = txIndex.get(key);
    if (msg.skipped) {
      if (existing) txRemove(existing);
      return;
    }
    const translated = typeof msg.translated === 'string' && !msg.draft ? msg.translated : null;
    if (!existing && !msg.failed && translated == null) return; // committed, final still pending
    const e = existing || {
      key, dir, at: seg.at, original: '', translated: '', lang: null,
      failed: false, stale: false, muted: false, passthrough: false, row: null,
    };
    if (typeof msg.original === 'string' && msg.original) e.original = msg.original;
    if (translated != null) e.translated = translated;
    if (seg.lang) e.lang = seg.lang;
    if (msg.failed) e.failed = true;
    if (msg.stale) e.stale = true;
    if (msg.muted) e.muted = true;
    if (msg.passthrough) e.passthrough = true;
    if (existing) txRefresh(e);
    else txInsert(e);
  }

  function txRow(e) {
    const row = el('div', 'tx-row ' + e.dir);
    row.appendChild(el('div', 'tx-time', hhmmss(e.at)));
    const body = el('div', 'tx-body');
    body.appendChild(el('div', 'tx-who', speakerLabel(e.dir, e.lang)));
    if (e.failed) {
      body.appendChild(el('div', 'tx-trans', e.original));
      body.appendChild(el('div', 'tx-mark', '⚠ çevrilemedi'));
    } else if (e.passthrough) {
      body.appendChild(el('div', 'tx-trans', e.translated || e.original));
      if (e.stale) body.appendChild(el('div', 'tx-mark stale', staleMark(e.muted)));
    } else {
      if (e.original) body.appendChild(el('div', 'tx-orig', e.original));
      body.appendChild(el('div', 'tx-trans', e.translated));
      if (e.stale) body.appendChild(el('div', 'tx-mark stale', staleMark(e.muted)));
    }
    row.appendChild(body);
    return row;
  }

  function nearBottom(list) {
    return list.scrollHeight - list.scrollTop - list.clientHeight < 40;
  }

  function txInsert(e) {
    let i = transcript.length;
    while (i > 0 && transcript[i - 1].at > e.at) i--;
    transcript.splice(i, 0, e);
    txIndex.set(e.key, e);
    if (transcript.length > MAX_TRANSCRIPT) {
      const old = transcript.shift();
      txIndex.delete(old.key);
      if (old.row) old.row.remove();
    }
    const idx = transcript.indexOf(e);
    if (txOpen && view && idx >= 0) {
      const list = view.txList;
      const stick = nearBottom(list);
      e.row = txRow(e);
      const next = transcript[idx + 1];
      if (next && next.row) list.insertBefore(e.row, next.row);
      else list.appendChild(e.row);
      if (stick) list.scrollTop = list.scrollHeight;
    }
    updateTxMeta();
  }

  function txRefresh(e) {
    if (!e.row || !e.row.parentNode) return;
    const row = txRow(e);
    e.row.parentNode.insertBefore(row, e.row);
    e.row.remove();
    e.row = row;
  }

  function txRemove(e) {
    const i = transcript.indexOf(e);
    if (i >= 0) transcript.splice(i, 1);
    txIndex.delete(e.key);
    if (e.row) {
      e.row.remove();
      e.row = null;
    }
    updateTxMeta();
  }

  function clearTranscript() {
    transcript.length = 0;
    txIndex.clear();
    if (view) view.txList.textContent = '';
    updateTxMeta();
  }

  function updateTxMeta() {
    if (!view) return;
    const n = transcript.length;
    view.txTitle.textContent = n ? 'Konuşma metni (' + n + ')' : 'Konuşma metni';
    view.txEmpty.hidden = n > 0;
    view.copyBtn.disabled = !n;
    view.dlBtn.disabled = !n;
  }

  // Rows exist only while the panel is open.
  function setTxOpen(open) {
    txOpen = !!open;
    if (!view) return;
    view.tx.hidden = !txOpen;
    view.txBtn.setAttribute('aria-pressed', txOpen ? 'true' : 'false');
    view.txList.textContent = '';
    for (const e of transcript) e.row = null;
    if (txOpen) {
      for (const e of transcript) {
        e.row = txRow(e);
        view.txList.appendChild(e.row);
      }
      view.txList.scrollTop = view.txList.scrollHeight;
    }
    updateTxMeta();
  }

  // A short confirmation on a button, then its normal label again.
  function flashButton(btn, text, normal) {
    if (!btn) return;
    btn.textContent = text;
    clearTimeout(flashTimers.get(btn));
    flashTimers.set(btn, setTimeout(() => {
      flashTimers.delete(btn);
      btn.textContent = normal;
    }, 1600));
  }

  function flashCopy(text) {
    if (view) flashButton(view.copyBtn, text, COPY_TEXT);
  }

  function copyText(text, done) {
    const fallback = () => {
      let ok = false;
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
        view.root.appendChild(ta);
        ta.select();
        ok = !!document.execCommand('copy');
        ta.remove();
      } catch (e) {
        ok = false;
      }
      done(ok);
    };
    try {
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(text).then(() => done(true), fallback);
        return;
      }
    } catch (e) {
      /* fall back */
    }
    fallback();
  }

  function onCopy() {
    if (!transcript.length) return;
    copyText(formatTranscript(transcript), (ok) => flashCopy(ok ? 'Kopyalandı' : 'Kopyalanamadı'));
  }

  function fileStamp(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }

  function onDownload() {
    if (!transcript.length || !view) return;
    const text = formatTranscript(transcript).replace(/\n/g, '\r\n');
    try {
      const blob = new Blob(['﻿' + text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'meet-ceviri-' + fileStamp(transcript[0].at) + '.txt';
      a.style.display = 'none';
      a.addEventListener('click', stopEvent);
      view.root.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        try {
          URL.revokeObjectURL(url);
        } catch (e) {
          /* ignore */
        }
      }, 30000);
    } catch (e) {
      /* ignore */
    }
  }

  // ---- diagnostics ------------------------------------------------------------------

  function newWatch() {
    // quietSince/quietChunks: first diag of the current quiet run (and its chunk count);
    // chunks/movedAt: last chunk count and when it last changed;
    // notReadySince: first diag of the current run whose socket state is not 'ready';
    // heard: this direction delivered audible audio or a caption with text this session. Once it has,
    // a quiet stretch is just nobody talking (the other side listening, me listening), not a broken
    // capture, so the "quiet" hint is only for a direction that has never been heard.
    return { quietSince: null, quietChunks: 0, chunks: null, movedAt: 0, notReadySince: null, heard: false };
  }

  function finite(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  // Shallow copy of a message's primitive fields (strings cut) for display and the report.
  function brief(msg, skip) {
    const o = {};
    if (!msg || typeof msg !== 'object') return o;
    for (const k of Object.keys(msg)) {
      if (skip && skip.indexOf(k) >= 0) continue;
      const v = msg[k];
      if (typeof v === 'string') o[k] = clip(v, 300);
      else if (typeof v === 'number' || typeof v === 'boolean' || v === null) o[k] = v;
    }
    return o;
  }

  function pushLog(kind, item) {
    const list = log[kind];
    list.push(item);
    if (list.length > REPORT_LIMITS[kind]) list.shift();
  }

  function logEvent(text) {
    pushLog('status', { at: Date.now(), text: clip(text, 300) });
  }

  function captionRec(msg) {
    const c = { dir: msg.dir, id: typeof msg.id === 'number' || typeof msg.id === 'string' ? msg.id : null, partial: !!msg.partial };
    for (const f of ['draft', 'skipped', 'failed', 'stale', 'muted', 'passthrough']) if (msg[f]) c[f] = true;
    if (typeof msg.lang === 'string' && msg.lang) c.lang = clip(msg.lang, 12);
    if (typeof msg.original === 'string') c.original = clip(msg.original, 80);
    if (typeof msg.translated === 'string') c.translated = clip(msg.translated, 80);
    return c;
  }

  // Every caption is logged; one with text proves recognition works for its direction, which
  // restarts that direction's quiet window.
  function noteCaption(msg) {
    pushLog('captions', { at: Date.now(), msg: captionRec(msg) });
    const dir = msg.dir;
    if (dir !== 'in' && dir !== 'out') return;
    const text = (typeof msg.original === 'string' && msg.original.trim()) ||
      (typeof msg.translated === 'string' && msg.translated.trim());
    if (text && active) watch[dir].heard = true;
    if (text && watch[dir].quietSince != null) {
      watch[dir].quietSince = null;
      updateNote();
    }
  }

  function onDiag(msg) {
    const now = Date.now();
    const d = brief(msg);
    for (const dir of ['in', 'out']) if (msg[dir] && typeof msg[dir] === 'object') d[dir] = brief(msg[dir]);
    lastDiag = { at: now, msg: d };
    if (active) {
      watchSide(watch.in, d.in, now);
      watchSide(watch.out, d.out, now);
      // Incoming audio silent (no audio, or below the quiet level) since when: one input of the
      // leave-call auto-stop. Missing data breaks the run.
      const lv = d.in ? finite(d.in.levelDb) : null;
      if (!d.in || (lv != null && lv >= DIAG_QUIET_DB)) inSilentSince = null;
      else if (inSilentSince == null) inSilentSince = now;
      // The engine is up (its first diag): tell it the current mute state, which may have been
      // posted before the offscreen document existed.
      if (!mutedSynced) {
        mutedSynced = true;
        sendMuted();
      }
    }
    renderDiag(now);
    updateNote(now);
  }

  function sendMuted() {
    forwardMsg({ to: 'offscreen', type: 'mic-muted', muted: micMuted });
  }

  // Leaving the call keeps the URL, so the session would run on: stop it once the page has had no
  // virtual mic for LEFT_MS and every diag of that time had quiet incoming audio (observed data only).
  function checkLeft(now) {
    if (!active || micState !== 'none' || micNoneSince == null || now - micNoneSince < LEFT_MS) return false;
    if (!lastDiag || now - lastDiag.at > DIAG_STALE_MS || inSilentSince == null) return false;
    if (lastDiag.at - inSilentSince < LEFT_MS) return false;
    logEvent('toplantıdan ayrıldınız: çeviri otomatik durduruldu');
    sendRuntime({ type: 'mt-stop', reason: NOTE_LEFT });
    stopSession(false, NOTE_LEFT);
    return true;
  }

  // A quiet run lasts while every diag is quiet (no audio, or below -55 dB) AND chunks keep
  // flowing to recognition (no stall over DIAG_STALL_MS). A malformed side breaks its streaks:
  // no hint is ever derived from missing data.
  function watchSide(w, s, now) {
    if (!s) {
      w.quietSince = null;
      w.notReadySince = null;
      w.chunks = null;
      return;
    }
    if (typeof s.state !== 'string' || s.state === 'ready') w.notReadySince = null;
    else if (w.notReadySince == null) w.notReadySince = now;
    const db = finite(s.levelDb);
    const chunks = finite(s.chunks);
    if (chunks == null || w.chunks == null || chunks < w.chunks) {
      w.quietSince = null; // unknown or restarted counters: start over
      w.movedAt = now;
    } else if (chunks > w.chunks) {
      w.movedAt = now;
    }
    w.chunks = chunks;
    if (db != null && db >= DIAG_QUIET_DB) w.heard = true;
    const flowing = chunks != null && now - w.movedAt <= DIAG_STALL_MS;
    if (!flowing || (db != null && db >= DIAG_QUIET_DB)) {
      w.quietSince = null;
    } else if (w.quietSince == null) {
      w.quietSince = now;
      w.quietChunks = chunks;
    }
  }

  // Durations are measured between diag messages (observed data); stale data gives no hint.
  function diagHint(now) {
    if (!lastDiag || now - lastDiag.at > DIAG_STALE_MS) return '';
    const at = lastDiag.at;
    for (const dir of ['in', 'out']) {
      const w = watch[dir];
      if (w.notReadySince != null && at - w.notReadySince >= DIAG_NOT_READY_MS) return HINTS[dir].state;
      if (!w.heard && w.quietSince != null && at - w.quietSince >= DIAG_QUIET_MS && w.chunks != null && w.chunks > w.quietChunks) {
        return HINTS[dir].quiet;
      }
    }
    return '';
  }

  function setDiagOpen(open, persist) {
    diagOpen = !!open;
    if (persist) {
      diagTouched = true;
      try {
        chrome.storage.local.set({ overlayDiag: diagOpen }, lastErr);
      } catch (e) {
        /* ignore */
      }
    }
    if (!view) return;
    view.diag.hidden = !diagOpen;
    view.diagBtn.setAttribute('aria-pressed', diagOpen ? 'true' : 'false');
    renderDiag();
  }

  function loadDiag() {
    try {
      chrome.storage.local.get('overlayDiag', (r) => {
        lastErr();
        if (diagTouched) return;
        setDiagOpen(!!r && r.overlayDiag === true, false);
      });
    } catch (e) {
      /* ignore */
    }
  }

  function renderSide(row, s) {
    const db = s ? finite(s.levelDb) : null;
    const lit = meterLevel(db);
    for (let i = 0; i < row.segs.length; i++) row.segs[i].classList.toggle('on', i < lit);
    row.db.textContent = s ? formatDb(db) : '—';
    row.db.classList.toggle('none', db == null);
    const st = s && typeof s.state === 'string' ? s.state : '';
    row.state.textContent = sttStateLabel(st);
    row.state.className = 'dg-state' + (st === 'ready' ? ' ok' : st === 'connecting' || st === 'backoff' ? ' warn' : '');
    row.last.textContent = 'son metin ' + formatAgo(s ? finite(s.lastPartialAgoMs) : null);
    const commits = s ? finite(s.commits) : null;
    row.commits.textContent = 'kesin: ' + (commits == null ? '—' : commits);
  }

  function renderDiag(now) {
    if (!view || !diagOpen) return;
    const t = now == null ? Date.now() : now;
    const d = lastDiag ? lastDiag.msg : null;
    const capture = d && (d.capture === 'tab' || d.capture === 'page') ? d.capture : cfg.incomingSource;
    view.dgIn.name.textContent = 'Gelen ses (' + (capture === 'tab' ? 'sekme' : 'Meet') + ')';
    renderSide(view.dgIn, d && d.in);
    renderSide(view.dgOut, d && d.out);
    view.dgOut.muted.hidden = !micMuted;
    // Echo guard count: the out side's `gated` (or the diag's top-level `echoGated`).
    const og = d && d.out ? finite(d.out.gated) : null;
    const gated = og != null ? og : d ? finite(d.echoGated) : null;
    const gatedText = gated == null ? '' : 'yankı koruması: ' + gated + ' parça';
    if (view.dgOut.gated.textContent !== gatedText) view.dgOut.gated.textContent = gatedText;
    view.dgOut.gated.hidden = !gatedText;
    let age = '';
    if (!lastDiag) age = 'Tanı verisi henüz gelmedi.';
    else if (t - lastDiag.at > DIAG_STALE_MS) age = 'Son tanı verisi ' + formatAgo(t - lastDiag.at) + '.';
    if (view.dgAge.textContent !== age) view.dgAge.textContent = age;
  }

  function extVersion() {
    try {
      const m = chrome.runtime.getManifest();
      return m && m.version ? String(m.version) : '?';
    } catch (e) {
      return '?';
    }
  }

  // Only what this script saw: it never receives API keys and never reads the `settings` key.
  function buildReport(now) {
    let ua = '?';
    try {
      ua = String(navigator.userAgent || '?');
    } catch (e) {
      /* ignore */
    }
    return redact(formatReport({
      now, version: extVersion(), ua, active, lang: sessionLang, sessionAt, state: lastState,
      ui: cfg, note: currentNote(now), fwd, diag: lastDiag, mic: micRec, remote: remoteRec,
      status: log.status, metrics: log.metrics, captions: log.captions,
    }));
  }

  function onCopyReport() {
    if (!view) return;
    copyText(buildReport(Date.now()), (ok) => flashButton(view.dgCopy, ok ? 'Kopyalandı' : 'Kopyalanamadı', DIAG_COPY_TEXT));
  }

  // ---- bridge -----------------------------------------------------------------------

  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  function sendRuntime(msg, cb) {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        lastErr(); // swallow "receiving end does not exist"
        if (cb) {
          try {
            cb(resp);
          } catch (e) {
            /* ignore */
          }
        }
      });
    } catch (e) {
      onOrphaned();
    }
  }

  // Audio chunks: fire-and-forget, no response callback (the promise is only
  // caught so a missing receiver is not an unhandled rejection).
  function forwardMsg(msg) {
    try {
      const p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) {
      onOrphaned();
    }
  }

  function forward(type, b64) {
    forwardMsg({ to: 'offscreen', type, b64 });
  }

  function toPage(msg) {
    try {
      window.postMessage(Object.assign({ source: 'mt-content' }, msg), '*');
    } catch (e) {
      /* ignore */
    }
  }

  // The extension was reloaded or updated under this page: give Meet my real
  // voice back and get out of the way.
  function onOrphaned() {
    if (extAlive()) return;
    if (active) {
      active = false;
      toPage({ type: 'stop' });
    }
    if (host) hideOverlay();
  }

  function saveLastUi(c) {
    try {
      chrome.storage.local.set({ mtLastUi: c }, lastErr);
    } catch (e) {
      /* ignore */
    }
  }

  function loadLastUi(cb) {
    let done = false;
    const finish = (u) => {
      if (done) return;
      done = true;
      cb(u);
    };
    try {
      chrome.storage.local.get('mtLastUi', (r) => {
        lastErr();
        finish(r && r.mtLastUi);
      });
    } catch (e) {
      finish(null);
    }
  }

  function startSession(rawUi, persist, lang) {
    const now = Date.now();
    const restart = active || (stoppedAt > 0 && now - stoppedAt < RESTART_KEEP_MS);
    clearTimeout(hideTimer);
    hideTimer = 0;
    active = true;
    seq++;
    cfg = normalizeUi(rawUi);
    if (persist) saveLastUi(cfg);
    micState = null;
    micNoneSince = null;
    micMuted = false; // the page re-posts mic-state / remote-state on start
    mutedSynced = false;
    voicePass = null; // the page resets its passthrough on start too
    inSilentSince = null;
    stopReason = null;
    zeroSince = cfg.incomingSource === 'page' ? now : null;
    sessionAt = now;
    sessionLang = typeof lang === 'string' && lang ? clip(lang, 12) : null;
    watch.in = newWatch();
    watch.out = newWatch();
    fwd.mic = 0;
    fwd.remote = 0;
    fwd.micAt = 0;
    fwd.remoteAt = 0;
    mountHost();
    clearBlocks();
    segs.clear();
    avg.in.clear();
    avg.out.clear();
    if (!restart) clearTranscript();
    applySize();
    renderDiag(now);
    view.stop.hidden = false;
    view.close.hidden = true;
    const fresh = pendingStatus && now - pendingStatus.at < 3000 ? pendingStatus : null;
    pendingStatus = null;
    setStatus(fresh ? fresh.state : 'connecting', fresh ? fresh.message : null);
    renderLatency();
    updateNote(now);
    showOverlay();
    // A restart (e.g. language switch) keeps the page active; drop speech still queued from the old session.
    if (restart) toPage({ type: 'tts-clear' });
    toPage({ type: 'start', originalVoice: cfg.originalVoice, capture: cfg.incomingSource });
  }

  function finishStop() {
    clearBlocks();
    if (transcript.length || diagOpen || lastState === 'error' || stopReason) {
      // Keep a small bar so the transcript, the reason of an error / automatic stop and the
      // diagnostics report stay reachable (Kapat hides it).
      if (lastState !== 'error') setStatus('stopped', stopReason);
      view.stop.hidden = true;
      view.close.hidden = false;
      showOverlay();
    } else {
      hideOverlay();
    }
  }

  function stopSession(allowLinger, reason) {
    const wasActive = active;
    active = false;
    pendingStatus = null;
    voicePass = null;
    toPage({ type: 'stop' });
    if (!wasActive || !view) return;
    stopReason = typeof reason === 'string' && reason ? reason : null;
    stoppedAt = Date.now();
    view.stop.hidden = true;
    updateNote();
    renderLatency();
    clearTimeout(hideTimer);
    hideTimer = 0;
    if (allowLinger && lastState === 'error') {
      // Let the user read the error before the overlay changes.
      hideTimer = setTimeout(() => {
        hideTimer = 0;
        finishStop();
      }, ERROR_LINGER_MS);
    } else {
      finishStop();
    }
  }

  function onRemoteState(d) {
    const n = Number(d.tracks);
    if (!Number.isFinite(n)) return;
    if (n > 0) zeroSince = null;
    else if (zeroSince == null) zeroSince = Date.now();
    updateNote();
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg !== 'object' || msg.to) return;
    try {
      switch (msg.type) {
        case 'mt-start':
          logEvent('mt-start lang=' + msg.lang);
          startSession(msg.ui, !!msg.ui, msg.lang);
          sendResponse({ ok: true });
          break;
        case 'mt-stop':
          logEvent('mt-stop');
          stopSession(true);
          sendResponse({ ok: true });
          break;
        case 'mt-ping': // background checks that this tab can be reached before it starts a tab capture
          sendResponse({ ok: true });
          break;
        case 'voice-passthrough': {
          if (!active) break; // never touch the mic gain outside a session
          const on = msg.on === true;
          const reason = on && typeof msg.reason === 'string' ? clip(msg.reason.trim(), 200) : '';
          if (on !== !!voicePass) logEvent('ses doğrudan gidiyor: ' + (on ? 'açık' : 'kapalı') + (reason ? ' — ' + reason : ''));
          voicePass = on ? { reason } : null;
          toPage({ type: 'voice-passthrough', on });
          updateNote();
          break;
        }
        case 'status':
          logEvent('status ' + msg.state + (typeof msg.message === 'string' && msg.message ? ' — ' + msg.message : ''));
          if (active) {
            setStatus(msg.state, msg.message);
          } else if (msg.state === 'connecting' || msg.state === 'live') {
            pendingStatus = { state: msg.state, message: msg.message, at: Date.now() };
          }
          break;
        case 'caption':
          onCaption(msg);
          break;
        case 'metrics':
          onMetrics(msg);
          break;
        case 'diag':
          onDiag(msg);
          break;
        case 'tts-chunk':
          if (active && typeof msg.b64 === 'string') toPage({ type: 'tts-chunk', id: msg.id, b64: msg.b64 });
          break;
        case 'tts-end':
          if (active) toPage({ type: 'tts-end', id: msg.id });
          break;
        default:
          break;
      }
    } catch (e) {
      /* never let a bad message break the page */
    }
  });

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || typeof d !== 'object' || d.source !== 'mt-page') return;
    try {
      switch (d.type) {
        case 'mic':
          if (active && typeof d.b64 === 'string') {
            forward('mic', d.b64);
            fwd.mic++;
            fwd.micAt = Date.now();
          }
          break;
        case 'remote':
          if (active && cfg.incomingSource === 'page' && typeof d.b64 === 'string') {
            forward('remote', d.b64);
            fwd.remote++;
            fwd.remoteAt = Date.now();
          }
          break;
        case 'mic-state':
          micRec = { at: Date.now(), msg: brief(d, ['source']) };
          if (d.state === 'virtual' || d.state === 'suspended' || d.state === 'none') {
            if (d.state !== 'none') micNoneSince = null;
            else if (micState !== 'none' || micNoneSince == null) micNoneSince = Date.now();
            micState = d.state;
            const wasMuted = micMuted;
            micMuted = d.muted === true;
            // Meet's mute goes to the engine (fire-and-forget) on every transition during a session.
            if (active && typeof d.muted === 'boolean' && micMuted !== wasMuted) sendMuted();
            updateNote();
            renderDiag();
          }
          break;
        case 'remote-state':
          remoteRec = { at: Date.now(), msg: brief(d, ['source']) };
          onRemoteState(d);
          break;
        default:
          break;
      }
    } catch (e) {
      /* ignore */
    }
  });

  // Page-reload recovery: content scripts cannot learn their own tab id, so this
  // only restores when background also reports `senderTabId` (the id of the tab
  // that sent mt-status) and it equals the session tab. The overlay settings come
  // from `resp.ui` when background sends them, else from the last mt-start.
  sendRuntime({ type: 'mt-status' }, (resp) => {
    if (!resp || !resp.active || resp.tabId == null || resp.senderTabId !== resp.tabId || active) return;
    const go = (u) => {
      if (active) return;
      logEvent('sayfa yenilendi: oturum sürüyor');
      startSession(u, false, resp.lang);
      if (resp.state) setStatus(resp.state, resp.message);
    };
    if (resp.ui && typeof resp.ui === 'object') go(resp.ui);
    else loadLastUi(go);
  });
})();
