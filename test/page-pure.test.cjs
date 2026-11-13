const ROOT = require('path').resolve(__dirname, '..').split('\\').join('/') + '/';
// Unit tests for the pure helpers of src/inject.js and src/content.js, extracted
// from their `// <pure-helpers>` blocks and evaluated in a fresh vm context.
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');

const SRC = ROOT + 'src/';
let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('ok   ', name);
  } catch (e) {
    failed++;
    console.error('FAIL ', name, '\n', e);
  }
}

function extract(file, names) {
  const src = fs.readFileSync(SRC + file, 'utf8');
  const m = src.match(/\/\/ <pure-helpers>([\s\S]*?)\/\/ <\/pure-helpers>/);
  if (!m) throw new Error('no pure-helpers block in ' + file);
  return vm.runInNewContext(m[1] + '\n;({' + names.join(', ') + '})', { btoa, atob }, { filename: file + '#pure' });
}

const I = extract('inject.js', ['PcmEncoder', 'bytesToBase64', 'pcm16ToBase64', 'base64ToFloat32', 'clamp16', 'TARGET_RATE']);
const C = extract('content.js', ['pad2', 'hhmmss', 'formatSec', 'RollingAvg', 'clampPos', 'langCode', 'speakerLabel', 'formatTranscript']);

// ---- PCM encoder -----------------------------------------------------------------

function runEncoder(rate, frames, callbacks, gen) {
  const chunks = [];
  const enc = new I.PcmEncoder(rate, (c) => chunks.push(Array.from(c)), 1600);
  let t = 0;
  for (let k = 0; k < callbacks; k++) {
    const buf = new Float32Array(frames);
    for (let i = 0; i < frames; i++) buf[i] = gen(t++, rate);
    enc.push(buf);
  }
  return { chunks, enc };
}

test('encoder: 48 kHz in 2048-frame callbacks -> exact 100 ms chunks (count, size, DC value)', () => {
  const { chunks } = runEncoder(48000, 2048, 100, () => 0.5);
  // 100 * 2048 / 3 = 68266.67 output samples -> 42 full chunks
  assert.equal(chunks.length, Math.floor((100 * 2048) / 3 / 1600));
  assert.equal(chunks.length, 42);
  for (const c of chunks) {
    assert.equal(c.length, 1600);
    for (const v of c) assert.equal(v, 16384); // round(0.5 * 32767)
  }
});

test('encoder: chunk cadence at 2048 frames / 48 kHz is ~100 ms (0 or 1 chunk per callback)', () => {
  const perCb = [];
  let n = 0;
  const enc = new I.PcmEncoder(48000, () => n++, 1600);
  for (let k = 0; k < 60; k++) {
    const before = n;
    enc.push(new Float32Array(2048));
    perCb.push(n - before);
  }
  assert.ok(perCb.every((x) => x === 0 || x === 1));
  // 2048 frames = 42.67 ms; 100 ms chunk every 2.34 callbacks on average
  assert.equal(n, Math.floor((60 * 2048) / 3 / 1600));
});

test('encoder: state carries across 2048-frame callbacks (same output as one big push)', () => {
  const gen = (t, r) => 0.6 * Math.sin((2 * Math.PI * 440 * t) / r) + 0.2 * Math.sin((2 * Math.PI * 1234 * t) / r);
  for (const rate of [48000, 44100, 32000, 16000]) {
    const a = runEncoder(rate, 2048, 40, gen).chunks.flat();
    const big = new Float32Array(2048 * 40);
    for (let i = 0; i < big.length; i++) big[i] = gen(i, rate);
    const b = [];
    new I.PcmEncoder(rate, (c) => b.push(...c), 1600).push(big);
    assert.equal(a.length, b.length, 'rate ' + rate);
    assert.deepEqual(a, b, 'rate ' + rate);
  }
});

test('encoder: 44.1 kHz fractional ratio keeps the sample count and DC level', () => {
  const frames = 2048 * 200;
  const { chunks } = runEncoder(44100, 2048, 200, () => -0.25);
  const outSamples = (frames * 16000) / 44100; // 148608.6
  assert.equal(chunks.length, Math.floor(outSamples / 1600));
  for (const c of chunks) for (const v of c) assert.ok(Math.abs(v - Math.round(-0.25 * 32768)) <= 1, String(v));
});

test('encoder: 1 kHz tone amplitude preserved through the box filter (48k -> 16k)', () => {
  const { chunks } = runEncoder(48000, 2048, 30, (t, r) => 0.5 * Math.sin((2 * Math.PI * 1000 * t) / r));
  const all = chunks.flat();
  let sq = 0;
  for (const v of all) sq += (v / 32768) ** 2;
  const rms = Math.sqrt(sq / all.length);
  const ideal = 0.5 / Math.SQRT2;
  assert.ok(rms / ideal > 0.97 && rms / ideal < 1.01, 'ratio ' + rms / ideal);
});

test('encoder: clipping and reset()', () => {
  const out = [];
  const enc = new I.PcmEncoder(16000, (c) => out.push(...c), 4);
  enc.push(Float32Array.from([2, -2, 1, -1]));
  assert.deepEqual(out, [32767, -32768, 32767, -32768]);
  const out2 = [];
  const e2 = new I.PcmEncoder(48000, (c) => out2.push(...c), 2);
  e2.push(Float32Array.from([1, 1])); // 2/3 of an output sample pending
  e2.reset();
  e2.push(Float32Array.from([0, 0, 0, 0, 0, 0]));
  assert.deepEqual(out2, [0, 0]);
  assert.equal(I.clamp16(NaN) | 0, 0);
});

// ---- base64 ------------------------------------------------------------------------

test('pcm16ToBase64 is little-endian and matches Buffer', () => {
  const pcm = Int16Array.from([1, -2, 32767, -32768, 0]);
  const b64 = I.pcm16ToBase64(pcm);
  assert.deepEqual(Array.from(Buffer.from(b64, 'base64')), [1, 0, 254, 255, 255, 127, 0, 128, 0, 0]);
  const big = new Int16Array(1600);
  for (let i = 0; i < big.length; i++) big[i] = (i * 977) % 65536 - 32768;
  const ref = Buffer.alloc(3200);
  for (let i = 0; i < big.length; i++) ref.writeInt16LE(big[i], i * 2);
  assert.equal(I.pcm16ToBase64(big), ref.toString('base64'));
  assert.equal(Buffer.from(I.pcm16ToBase64(big), 'base64').length, 3200); // one 100 ms chunk
});

test('bytesToBase64 handles > 32 KB in slices', () => {
  const bytes = new Uint8Array(200001);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255;
  assert.equal(I.bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
});

test('base64ToFloat32 decodes 24 kHz TTS PCM16 and drops an odd trailing byte', () => {
  const buf = Buffer.alloc(9);
  [0, 16384, -16384, 32767].forEach((v, i) => buf.writeInt16LE(v, i * 2));
  buf[8] = 0x7f;
  const f = I.base64ToFloat32(buf.toString('base64'));
  assert.equal(f.length, 4);
  assert.deepEqual(Array.from(f), [0, 0.5, -0.5, 32767 / 32768]);
  // round trip through the encoder's PCM16 at the identity rate
  const out = [];
  new I.PcmEncoder(16000, (c) => out.push(...c), 4).push(f);
  // decode is v/32768 and encode x*32767 for positives (as in v1 / engine util): the max drifts by 1
  assert.deepEqual(out.slice(0, 3), [0, 16384, -16384]);
  assert.ok(Math.abs(out[3] - 32767) <= 1);
});

// ---- content helpers -------------------------------------------------------------------

test('formatSec uses a Turkish decimal comma and one decimal', () => {
  assert.equal(C.formatSec(1234), '1,2 sn');
  assert.equal(C.formatSec(1250), '1,3 sn');
  assert.equal(C.formatSec(0), '0,0 sn');
  assert.equal(C.formatSec(12345), '12,3 sn');
  assert.equal(C.formatSec(-50), '0,0 sn');
  assert.equal(C.formatSec(NaN), '0,0 sn');
  assert.equal(C.formatSec(980), '1,0 sn');
  assert.equal(C.formatSec(950), '1,0 sn'); // (0.95).toFixed(1) would give "0.9"
  assert.equal(C.formatSec(1049), '1,0 sn');
  assert.equal(C.formatSec(1050), '1,1 sn');
  assert.equal(C.formatSec(59960), '60,0 sn');
  assert.equal(C.formatSec(Infinity), '0,0 sn');
});

test('RollingAvg keeps the mean of the last 5 values', () => {
  const r = new C.RollingAvg(5);
  assert.equal(r.value, null);
  r.push(1000);
  assert.equal(r.value, 1000);
  for (const v of [2000, 3000, 4000, 5000, 6000]) r.push(v);
  assert.equal(r.value, 4000); // 2000..6000
  r.push(NaN);
  r.push('7000');
  r.push(Infinity);
  assert.equal(r.value, 4000);
  r.push(-100); // clamped to 0
  assert.equal(r.value, (3000 + 4000 + 5000 + 6000 + 0) / 5);
  r.clear();
  assert.equal(r.value, null);
});

test('clampPos keeps the panel inside the viewport', () => {
  const cp = (...a) => ({ ...C.clampPos(...a) }); // plain object from this realm
  assert.deepEqual(cp(100, 200, 300, 100, 1280, 800, 8), { x: 100, y: 200 });
  assert.deepEqual(cp(1200, 750, 300, 100, 1280, 800, 8), { x: 972, y: 692 });
  assert.deepEqual(cp(-50, -10, 300, 100, 1280, 800, 8), { x: 8, y: 8 });
  assert.deepEqual(cp(10, 10, 2000, 1000, 1280, 800, 8), { x: 8, y: 8 }); // bigger than viewport
  assert.deepEqual(cp(NaN, 30.6, 300, 100, 1280, 800, 8), { x: 8, y: 31 });
  assert.deepEqual(cp(500.4, 300, 300, 100, 1280, 800), { x: 500, y: 300 }); // default margin
  // window shrinks: a stored position at the old right edge is pulled back in
  assert.deepEqual(cp(1600, 900, 600, 120, 1024, 700, 8), { x: 416, y: 572 });
});

test('speaker labels and language codes', () => {
  assert.equal(C.speakerLabel('in', 'tr'), 'Karşı taraf (TR)');
  assert.equal(C.speakerLabel('in', 'en'), 'Karşı taraf');
  assert.equal(C.speakerLabel('in', null), 'Karşı taraf');
  assert.equal(C.speakerLabel('in', '<b>'), 'Karşı taraf');
  assert.equal(C.speakerLabel('out', 'de'), 'Sen');
  assert.equal(C.langCode('pt'), 'PT');
  assert.equal(C.langCode(''), '');
});

test('hhmmss pads local time', () => {
  assert.equal(C.hhmmss(new Date(2026, 10, 13, 9, 5, 7).getTime()), '09:05:07');
  assert.equal(C.hhmmss(new Date(2026, 10, 13, 23, 59, 59).getTime()), '23:59:59');
});

test('formatTranscript renders every caption kind', () => {
  const at = (h, m, s) => new Date(2026, 10, 13, h, m, s).getTime();
  const text = C.formatTranscript([
    { at: at(14, 5, 12), dir: 'in', original: 'Merhaba, nasılsınız?', translated: 'Hello, how are you?', lang: 'tr' },
    { at: at(14, 5, 20), dir: 'out', original: "I'm fine, thanks.", translated: 'İyiyim, teşekkürler.', lang: 'en' },
    { at: at(14, 5, 31), dir: 'in', original: 'Great, let us start.', translated: 'Great, let us start.', lang: 'en', passthrough: true },
    { at: at(14, 5, 40), dir: 'in', original: 'Anlaşılmayan cümle', translated: '', lang: 'tr', failed: true },
    { at: at(14, 5, 50), dir: 'out', original: 'Okay.', translated: 'Tamam.', stale: true },
  ]);
  assert.equal(
    text,
    [
      'Meet Canlı Çeviri — konuşma metni',
      'Tarih: 13.11.2026',
      '',
      '[14:05:12] Karşı taraf (TR): Merhaba, nasılsınız?',
      '           → Hello, how are you?',
      "[14:05:20] Sen: I'm fine, thanks.",
      '           → İyiyim, teşekkürler.',
      '[14:05:31] Karşı taraf: Great, let us start.',
      '[14:05:40] Karşı taraf (TR): Anlaşılmayan cümle',
      '           ⚠ çevrilemedi',
      '[14:05:50] Sen: Okay.',
      '           → Tamam. (seslendirilmedi)',
      '',
    ].join('\n'),
  );
  assert.equal(C.formatTranscript([]), 'Meet Canlı Çeviri — konuşma metni\n\n');
});

// ---- shell: settings layers (defaults.js) ------------------------------------------------------

function loadDefaults() {
  const sb = {};
  sb.self = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(SRC + 'defaults.js', 'utf8'), sb, { filename: 'defaults.js' });
  return sb.MT;
}
const MT = loadDefaults();
const plain = (o) => JSON.parse(JSON.stringify(o)); // objects from this realm (deepEqual checks prototypes)

test('defaults: Haiku 5.5 is the default model; merge order defaults <- .env <- options', () => {
  assert.equal(MT.DEFAULTS.claudeModel, 'claude-haiku-5-5');
  assert.equal(MT.merge({}, {}).claudeModel, 'claude-haiku-5-5');
  assert.equal(MT.merge({ claudeModel: 'claude-opus-5-5' }, {}).claudeModel, 'claude-opus-5-5');
  assert.equal(MT.merge({ claudeModel: 'claude-opus-5-5' }, { claudeModel: 'claude-haiku-5-5' }).claudeModel, 'claude-haiku-5-5');
});

test('options save stores only deviations from defaults <- .env (a save does not pin .env values)', () => {
  const env = { claudeModel: 'claude-opus-5-5', voiceId: 'envVoice', glossary: ['Kerem'], fastMode: false, speakerGender: 'male' };
  // the form exactly as the options page shows it (keys not typed) -> nothing is stored
  const shown = { ...plain(MT.merge(env, {})), elevenKey: '', anthropicKey: '' };
  assert.deepEqual(plain(MT.overrides(env, shown)), {});
  // ...so a later .env edit (or a new default) still takes effect after that save
  const later = { ...env, claudeModel: 'claude-haiku-5-5', fastMode: true };
  const eff = MT.merge(later, MT.overrides(env, shown));
  assert.equal(eff.claudeModel, 'claude-haiku-5-5');
  assert.equal(eff.fastMode, true);
  // real changes are stored (trimmed); '' is a real choice for speakerGender
  const changed = {
    ...shown, elevenKey: ' xi-1 ', claudeModel: 'claude-sonnet-5-5', fastMode: true, speakerGender: '',
    glossary: ['Kerem', ' Car Studio AI '],
  };
  assert.deepEqual(plain(MT.overrides(env, changed)), {
    elevenKey: 'xi-1', claudeModel: 'claude-sonnet-5-5', fastMode: true, speakerGender: '', glossary: ['Kerem', 'Car Studio AI'],
  });
  assert.equal(MT.merge(env, MT.overrides(env, changed)).speakerGender, '');
  // the stock default voice can be chosen even though .env sets another one (was silently dropped)
  const o = MT.overrides(env, { ...shown, voiceId: MT.DEFAULTS.voiceId });
  assert.equal(o.voiceId, MT.DEFAULTS.voiceId);
  assert.equal(MT.merge(env, o).voiceId, MT.DEFAULTS.voiceId);
  // invalid / empty values are never stored
  assert.deepEqual(plain(MT.overrides(env, { claudeModel: 'gpt-x', ttsModel: '', fastMode: 'yes', glossary: [], anthropicKey: '  ' })), {});
});

async function atest(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ', name);
  } catch (e) {
    failed++;
    console.error('FAIL ', name, '\n', e);
  }
}

// ---- shell: service worker (background.js) in a vm with async fake chrome.* ----------------------

function loadBackground(stored) {
  const store = { mtSession: plain(stored) };
  const tabMsgs = [];
  let listener = null;
  const later = (fn) => new Promise((resolve) => setImmediate(() => resolve(fn()))); // every chrome call is async
  const chrome = {
    storage: {
      session: {
        get: () => later(() => ({ mtSession: plain(store.mtSession) })),
        set: (o) => later(() => { Object.assign(store, plain(o)); }),
      },
      local: { get: () => later(() => ({})) },
    },
    runtime: { onMessage: { addListener: (f) => { listener = f; } }, sendMessage: () => later(() => undefined), getURL: (p) => p },
    tabs: {
      sendMessage: (tabId, msg) => later(() => { tabMsgs.push({ tabId, msg: plain(msg) }); }),
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
  };
  const sb = { chrome, console, setTimeout, clearTimeout, URL, fetch: () => Promise.reject(new Error('offline')) };
  sb.self = sb;
  vm.createContext(sb);
  sb.importScripts = (f) => vm.runInContext(fs.readFileSync(SRC + f, 'utf8'), sb, { filename: f });
  vm.runInContext(fs.readFileSync(SRC + 'background.js', 'utf8'), sb, { filename: 'background.js' });
  return { store, tabMsgs, call: (msg, cb) => listener(msg, {}, cb || (() => {})) };
}
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r));
};

// Background with tabs / tabCapture / offscreen fakes; `log` records the calls in order.
function loadBg(o = {}) {
  const log = [];
  const store = {};
  let listener = null;
  let offscreenOpen = false;
  const later = (fn) => new Promise((resolve, reject) => setImmediate(() => {
    try { resolve(fn()); } catch (e) { reject(e); }
  }));
  const tabs = o.tabs || { 5: 'https://meet.google.com/abc-defg-hij', 9: 'https://meet.google.com/xyz-abcd-efg' };
  const chrome = {
    storage: {
      session: {
        get: () => later(() => ({ mtSession: store.mtSession ? plain(store.mtSession) : undefined })),
        set: (x) => later(() => { Object.assign(store, plain(x)); }),
      },
      local: { get: () => later(() => ({ settings: { elevenKey: 'xi-test', anthropicKey: 'sk-ant-test', incomingSource: 'tab' } })) },
    },
    runtime: {
      onMessage: { addListener: (f) => { listener = f; } },
      getURL: (p) => p,
      getContexts: () => later(() => (offscreenOpen ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [])),
      sendMessage: (msg) => later(() => {
        log.push('runtime:' + msg.type);
        if (!offscreenOpen) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true };
      }),
    },
    offscreen: {
      createDocument: () => later(() => {
        log.push('offscreen:create');
        if (o.createFails) throw new Error(o.createFails);
        offscreenOpen = true;
      }),
      closeDocument: () => later(() => { log.push('offscreen:close'); offscreenOpen = false; }),
    },
    tabs: {
      get: (id) => later(() => {
        if (!tabs[id]) throw new Error('No tab with id: ' + id);
        return { id, url: tabs[id] };
      }),
      sendMessage: (tabId, msg) => later(() => {
        log.push('tab' + tabId + ':' + msg.type + (msg.type === 'status' ? ':' + msg.state : ''));
        if ((o.unreachable || []).includes(tabId)) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true };
      }),
      onRemoved: { addListener() {} },
      onUpdated: { addListener() {} },
    },
    tabCapture: {
      getMediaStreamId: ({ targetTabId }) => later(() => {
        log.push('capture:' + targetTabId);
        if (o.captureFails) throw new Error(o.captureFails);
        return 'stream-' + targetTabId;
      }),
    },
  };
  const sb = { chrome, console, setTimeout, clearTimeout, URL, fetch: () => Promise.reject(new Error('offline')) };
  sb.self = sb;
  vm.createContext(sb);
  sb.importScripts = (f) => vm.runInContext(fs.readFileSync(SRC + f, 'utf8'), sb, { filename: f });
  vm.runInContext(fs.readFileSync(SRC + 'background.js', 'utf8'), sb, { filename: 'background.js' });
  const call = (msg, sender) => new Promise((resolve) => {
    if (listener(msg, sender || {}, (r) => resolve(plain(r))) !== true) resolve(undefined);
  });
  return { o, log, store, call, at: (e) => log.indexOf(e) };
}
const UNREACHABLE = 'Meet sekmesine ulaşılamadı. Uzantıyı yükledikten sonra Meet sekmesini yenileyin.';

// ---- shell: popup (popup.js + defaults.js) in a vm with a tiny fake DOM ---------------------------

function loadPopup({ session, tab, storage }) {
  const store = plain(storage || {});
  const sent = [];
  class El {
    constructor(tag) {
      this.tagName = String(tag).toUpperCase(); this.children = []; this.attrs = {}; this.listeners = {};
      this.textContent = ''; this.className = ''; this.hidden = false; this.disabled = false; this.onclick = null; this.type = '';
    }
    get classList() { return { toggle: (c, on) => { const s = new Set(this.className.split(/\s+/).filter(Boolean)); if (on) s.add(c); else s.delete(c); this.className = [...s].join(' '); } }; }
    appendChild(n) { this.children.push(n); return n; }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    click() { for (const f of this.listeners.click || []) f({ preventDefault() {} }); }
  }
  const ids = {};
  for (const id of ['langs', 'hint', 'toggle', 'status', 'meta', 'settings']) ids[id] = new El('div');
  ids.hint.hidden = true;
  // grid.textContent = '' clears the pills
  Object.defineProperty(ids.langs, 'textContent', { get: () => '', set: () => { ids.langs.children = []; } });
  const chrome = {
    runtime: {
      lastError: undefined,
      getURL: (p) => p,
      openOptionsPage() {},
      sendMessage(msg, cb) {
        sent.push(plain(msg));
        const res = msg.type === 'mt-status' ? plain(session) : { ok: true };
        setImmediate(() => cb(res));
      },
    },
    storage: { local: {
      get: (k) => Promise.resolve(k === 'settings' ? { settings: { elevenKey: 'x', anthropicKey: 'y' } } : { [k]: store[k] }),
      set: (o) => { Object.assign(store, plain(o)); return Promise.resolve(); },
    } },
    tabs: { query: () => Promise.resolve([tab]) },
  };
  const sb = {
    chrome, console, setImmediate, setTimeout, clearTimeout,
    setInterval: () => 1, clearInterval() {},
    fetch: () => Promise.reject(new Error('no env.json')),
    document: { getElementById: (id) => ids[id], createElement: (t) => new El(t) },
    addEventListener() {},
  };
  sb.self = sb;
  sb.window = sb;
  vm.createContext(sb);
  vm.runInContext(fs.readFileSync(SRC + 'defaults.js', 'utf8'), sb, { filename: 'defaults.js' });
  vm.runInContext(fs.readFileSync(SRC + 'popup.js', 'utf8'), sb, { filename: 'popup.js' });
  const pill = (label) => ids.langs.children.find((b) => b.textContent === label);
  const selected = () => ids.langs.children.filter((b) => b.className.split(' ').includes('selected')).map((b) => b.textContent);
  return { ids, sent, store, pill, selected, starts: () => sent.filter((m) => m.type === 'mt-start') };
}

(async () => {
  await atest('.env parsing: quotes, trailing comments, BOM, export, CRLF', async () => {
    const { parseDotEnv, envToSettings } = await import(require('url').pathToFileURL(ROOT + 'scripts/env.mjs').href);
    const vars = parseDotEnv([
      '﻿# comment',
      'ANTHROPIC_API_KEY="sk-ant-1"   # my key',
      "ELEVENLABS_API_KEY='xi-2' # other",
      'export VOICE_ID = abc123 # note',
      'GLOSSARY="Car Studio AI, Kerem"',
      'CLAUDE_MODEL=claude-haiku-5-5\r',
      'FAST_MODE=no',
      'SHOW_LATENCY=evet',
      'LIVE_DRAFTS=',
      'TTS_MODEL=a#b',
      'FORMALITY="formal',
    ].join('\n'));
    assert.equal(vars.ANTHROPIC_API_KEY, 'sk-ant-1', 'no quotes left in the key');
    assert.equal(vars.ELEVENLABS_API_KEY, 'xi-2');
    assert.equal(vars.VOICE_ID, 'abc123');
    assert.equal(vars.GLOSSARY, 'Car Studio AI, Kerem');
    assert.equal(vars.CLAUDE_MODEL, 'claude-haiku-5-5');
    assert.equal(vars.TTS_MODEL, 'a#b', 'a # inside a value is not a comment');
    assert.equal(vars.FORMALITY, '"formal', 'unbalanced quote kept as written');
    assert.deepEqual(plain(envToSettings(vars)), {
      elevenKey: 'xi-2', anthropicKey: 'sk-ant-1', claudeModel: 'claude-haiku-5-5', fastMode: false, ttsModel: 'a#b',
      voiceId: 'abc123', formality: '"formal', glossary: ['Car Studio AI', 'Kerem'], showLatency: true,
    });
  });

  await atest('service worker restart: concurrent cold loads keep a status saved meanwhile', async () => {
    const bg = loadBackground({ active: true, lang: 'tr', tabId: 5, path: 'https://meet.google.com/abc-defg-hij', ui: null, state: 'connecting', message: null });
    const answers = [];
    // the woken worker gets a relayed status and a status query back to back
    bg.call({ type: 'relay', msg: { type: 'status', state: 'live' } });
    bg.call({ type: 'mt-status' }, (r) => answers.push(r.state));
    await settle();
    bg.call({ type: 'mt-status' }, (r) => answers.push(r.state));
    await settle();
    assert.equal(bg.store.mtSession.state, 'live');
    assert.deepEqual(answers, ['live', 'live'], 'the in-memory session was not rolled back to the older snapshot');
    assert.deepEqual(bg.tabMsgs, [{ tabId: 5, msg: { type: 'status', state: 'live' } }]);
  });

  await atest('echoGuard: default on; .env ECHO_GUARD and the options checkbox ("Kulaklık kullanıyorum") turn it off', async () => {
    const { parseDotEnv, envToSettings } = await import(require('url').pathToFileURL(ROOT + 'scripts/env.mjs').href);
    assert.equal(MT.DEFAULTS.echoGuard, true);
    assert.equal(MT.merge({}, {}).echoGuard, true);
    const env = plain(envToSettings(parseDotEnv('ECHO_GUARD=false\n')));
    assert.deepEqual(env, { echoGuard: false });
    assert.equal(MT.merge(env, {}).echoGuard, false, '.env false is kept (a boolean, not dropped as empty)');
    assert.equal(MT.merge({}, { echoGuard: false }).echoGuard, false);
    assert.equal(MT.merge(env, { echoGuard: true }).echoGuard, true, 'options win over .env');
    assert.equal(MT.merge({}, { echoGuard: 'no' }).echoGuard, true, 'garbage ignored');
    // the options form: checkbox ticked -> echoGuard false is stored; unticked with the default -> nothing stored
    const shown = { ...plain(MT.merge({}, {})), elevenKey: '', anthropicKey: '' };
    assert.deepEqual(plain(MT.overrides({}, { ...shown, echoGuard: false })), { echoGuard: false });
    assert.deepEqual(plain(MT.overrides({}, shown)), {});
    assert.deepEqual(plain(MT.overrides(env, { ...shown, echoGuard: false })), {}, 'equal to .env: follows .env');
    // and the options page wires the checkbox
    const html = fs.readFileSync(SRC + 'options.html', 'utf8');
    assert.match(html, /id="headphones"[\s\S]*Kulaklık kullanıyorum \(yankı korumasını kapat\)/);
    const js = fs.readFileSync(SRC + 'options.js', 'utf8');
    assert.match(js, /form\.echoGuard = !\$\('headphones'\)\.checked/);
  });

  await atest('formatTranscript: a translation not spoken because the mic was muted', async () => {
    const at = new Date(2026, 10, 13, 14, 5, 50).getTime();
    const T = extract('content.js', ['formatTranscript', 'staleMark']);
    assert.equal(T.staleMark(true), 'seslendirilmedi (mikrofon kapalıydı)');
    assert.equal(T.staleMark(false), 'seslendirilmedi');
    const text = T.formatTranscript([{ at, dir: 'out', original: 'Okay.', translated: 'Tamam.', stale: true, muted: true }]);
    assert.ok(text.includes('           → Tamam. (seslendirilmedi, mikrofon kapalıydı)\n'), text);
  });

  await atest('background: a tab whose page side does not answer gets no tab capture and nothing is stopped', async () => {
    const bg = loadBg({ unreachable: [5] });
    const r = await bg.call({ type: 'mt-start', lang: 'tr', tabId: 5 });
    assert.deepEqual(r, { ok: false, error: UNREACHABLE });
    assert.deepEqual(bg.log, ['tab5:mt-ping'], 'no capture, no offscreen document, no stop');
  });

  await atest('background: a start failure after the page started keeps the error (popup state + overlay status before mt-stop)', async () => {
    const bg = loadBg({ createFails: 'boom' });
    const r = await bg.call({ type: 'mt-start', lang: 'tr', tabId: 5 });
    assert.deepEqual(r, { ok: false, error: 'Çeviri başlatılamadı: boom' });
    const tabEvents = bg.log.filter((e) => e.startsWith('tab5:') || e.startsWith('capture:'));
    assert.deepEqual(tabEvents, ['tab5:mt-ping', 'capture:5', 'tab5:mt-start', 'tab5:status:error', 'tab5:mt-stop']);
    const st = await bg.call({ type: 'mt-status' });
    assert.equal(st.active, false);
    assert.equal(st.state, 'error');
    assert.equal(st.message, 'Çeviri başlatılamadı: boom');
  });

  await atest('background: language switch on the same tab never stops the page; the old capture is released first', async () => {
    const bg = loadBg();
    assert.deepEqual(await bg.call({ type: 'mt-start', lang: 'tr', tabId: 5 }), { ok: true });
    const sid1 = bg.store.mtSession.sid;
    bg.log.length = 0;
    assert.deepEqual(await bg.call({ type: 'mt-start', lang: 'de', tabId: 5 }), { ok: true });
    assert.ok(!bg.log.includes('tab5:mt-stop'), 'no mt-stop: the real voice is not un-muted between the sessions');
    assert.ok(bg.at('runtime:stop') >= 0 && bg.at('offscreen:close') < bg.at('capture:5'), 'old engine closed before the new capture');
    assert.ok(bg.at('capture:5') < bg.at('tab5:mt-start'));
    assert.equal(bg.store.mtSession.lang, 'de');
    assert.notEqual(bg.store.mtSession.sid, sid1);
    // the capture fails on the next switch: the still-muted page is stopped with the reason shown
    bg.o.captureFails = 'Error starting tab capture';
    bg.log.length = 0;
    const r = await bg.call({ type: 'mt-start', lang: 'fr', tabId: 5 });
    assert.deepEqual(r, { ok: false, error: 'Çeviri başlatılamadı: Error starting tab capture' });
    assert.ok(bg.at('tab5:status:error') >= 0 && bg.at('tab5:status:error') < bg.at('tab5:mt-stop'));
    assert.equal(bg.store.mtSession.active, false);
    assert.equal(bg.store.mtSession.state, 'error');
  });

  await atest("background: mt-stop with a reason from the session's tab is kept as a stopped state; other tabs cannot stop it", async () => {
    const bg = loadBg();
    await bg.call({ type: 'mt-start', lang: 'tr', tabId: 5 });
    await bg.call({ type: 'mt-stop', reason: 'x' }, { tab: { id: 9 } });
    assert.equal(bg.store.mtSession.active, true, 'a stale page in another tab cannot stop this session');
    await bg.call({ type: 'mt-stop', reason: 'Toplantıdan ayrıldınız; çeviri durduruldu.' }, { tab: { id: 5 } });
    const st = await bg.call({ type: 'mt-status' });
    assert.deepEqual([st.active, st.state, st.message], [false, 'stopped', 'Toplantıdan ayrıldınız; çeviri durduruldu.']);
    assert.ok(bg.log.includes('offscreen:close'));
    // the popup's plain stop still works
    await bg.call({ type: 'mt-start', lang: 'tr', tabId: 5 });
    await bg.call({ type: 'mt-stop' });
    assert.deepEqual([bg.store.mtSession.active, bg.store.mtSession.state], [false, null]);
  });

  await atest('popup: picking English during a running session keeps its language (hint only); another language restarts', async () => {
    const p = loadPopup({
      session: { active: true, lang: 'tr', tabId: 5, state: 'live', message: null },
      tab: { id: 5, url: 'https://meet.google.com/abc-defg-hij' },
      storage: { lang: 'tr' },
    });
    await settle();
    assert.deepEqual(p.selected(), ['Türkçe']);
    assert.equal(p.ids.hint.hidden, true);
    p.pill('English').click();
    await settle();
    assert.deepEqual(p.selected(), ['Türkçe'], 'the running language stays selected');
    assert.equal(p.ids.hint.hidden, false, 'English needs no translation: hint shown');
    assert.equal(p.store.lang, 'tr', 'English is not remembered as the language to translate');
    assert.equal(p.starts().length, 0, 'no restart');
    assert.equal(p.ids.toggle.textContent, 'Çeviriyi durdur');
    p.pill('Deutsch').click();
    await settle();
    assert.deepEqual(p.starts(), [{ type: 'mt-start', lang: 'de', tabId: 5 }]);
    assert.equal(p.store.lang, 'de');
    assert.equal(p.ids.hint.hidden, true);
    // without a session, English is selectable (start disabled, hint shown) as before
    const q = loadPopup({ session: { active: false }, tab: { id: 5, url: 'https://meet.google.com/abc-defg-hij' }, storage: { lang: 'tr' } });
    await settle();
    q.pill('English').click();
    await settle();
    assert.deepEqual(q.selected(), ['English']);
    assert.equal(q.ids.hint.hidden, false);
    assert.equal(q.ids.toggle.disabled, true);
  });

  console.log(`\n${passed} tests passed` + (failed ? `, ${failed} FAILED` : ''));
  if (failed) process.exit(1);
})();
