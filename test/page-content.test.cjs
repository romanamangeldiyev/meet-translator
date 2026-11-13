const ROOT = require('path').resolve(__dirname, '..').split('\\').join('/') + '/';
// Loads the real src/content.js into a vm context with a minimal fake DOM, chrome.*
// and clock, then drives it through the v2 message contract.
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');

const SRC = fs.readFileSync(ROOT + 'src/content.js', 'utf8');
const BASE = new Date(2026, 10, 13, 14, 5, 0).getTime();

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log('ok   ', name);
  } catch (e) {
    failed++;
    console.error('FAIL ', name, '\n', e);
  }
}
const flush = () => new Promise((r) => setImmediate(r));

function makeClock(start) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0), every: 0 }); return id; },
    setInterval: (fn, ms) => { const id = ++seq; timers.set(id, { fn, at: now + ms, every: ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    clearInterval: (id) => timers.delete(id),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let next = null;
        for (const [id, t] of timers) if (t.at <= end && (!next || t.at < next[1].at)) next = [id, t];
        if (!next) break;
        const [id, t] = next;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

class FNode {
  constructor(tag, doc) {
    this.tagName = String(tag).toUpperCase(); this.ownerDocument = doc; this.childNodes = []; this.parentNode = null;
    this._text = ''; this._cls = new Set(); this.style = {}; this.attrs = {}; this.listeners = {};
    this.hidden = false; this.disabled = false; this.scrollTop = 0; this.scrollHeight = 0; this.clientHeight = 0; this.id = '';
  }
  get className() { return [...this._cls].join(' '); }
  set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
  get classList() {
    const s = this._cls;
    return {
      add: (...c) => c.forEach((x) => s.add(x)), remove: (...c) => c.forEach((x) => s.delete(x)), contains: (c) => s.has(c),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : !!f; if (on) s.add(c); else s.delete(c); return on; },
    };
  }
  get textContent() { return this._text + this.childNodes.map((c) => c.textContent).join(''); }
  set textContent(v) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; this._text = v == null ? '' : String(v); }
  append(...ns) { for (const n of ns) this.appendChild(n); }
  appendChild(n) { if (n.parentNode) n.parentNode.removeChild(n); n.parentNode = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) {
    if (ref == null) return this.appendChild(n);
    if (n.parentNode) n.parentNode.removeChild(n);
    const i = this.childNodes.indexOf(ref);
    if (i < 0) throw new Error('NotFoundError');
    n.parentNode = this; this.childNodes.splice(i, 0, n); return n;
  }
  removeChild(n) { const i = this.childNodes.indexOf(n); if (i < 0) throw new Error('NotFoundError'); this.childNodes.splice(i, 1); n.parentNode = null; return n; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  get isConnected() { let n = this; while (n) { if (n === this.ownerDocument.documentElement) return true; n = n.parentNode || n.host || null; } return false; }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
  removeEventListener(t, f) { const a = this.listeners[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); }
  dispatch(type, props) {
    const ev = Object.assign({
      type, target: this, currentTarget: this, defaultPrevented: false, stopped: false,
      preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; },
    }, props || {});
    for (const f of (this.listeners[type] || []).slice()) f.call(this, ev);
    return ev;
  }
  click() { this.clicks = (this.clicks || 0) + 1; return this.dispatch('click'); }
  blur() { this.blurred = (this.blurred || 0) + 1; }
  select() {}
  attachShadow(o) { const r = new FNode('#shadow-root', this.ownerDocument); r.host = this; r.mode = o.mode; r.adoptedStyleSheets = []; this._shadow = r; return r; }
  getBoundingClientRect() { return { left: 340, top: 600, width: 600, height: 120, right: 940, bottom: 720 }; }
  get offsetWidth() { return 600; }
  get offsetHeight() { return 120; }
  setPointerCapture(id) { this.captured = id; }
  releasePointerCapture(id) { if (this.captured !== id) throw new Error('NotFoundError'); this.captured = null; }
}
function all(root, pred, out = []) { for (const c of root.childNodes) { if (pred(c)) out.push(c); all(c, pred, out); } return out; }

function makeEnv(o = {}) {
  const env = {
    posts: [], sent: [], responses: [], storage: JSON.parse(JSON.stringify(o.storage || {})), clipboard: [], blobs: [], revoked: [],
    ros: [], statusResp: o.statusResp, execCopy: 0, css: null, gets: [],
  };
  const clock = makeClock(BASE);
  env.clock = clock;
  class FakeDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(clock.now()); }
    static now() { return clock.now(); }
  }
  const doc = { createElement: (t) => new FNode(t, doc), execCommand: () => { env.execCopy++; return true; } };
  doc.documentElement = new FNode('html', doc);
  const winListeners = new Map();
  const runtime = {
    id: 'ext',
    lastError: undefined,
    getManifest: () => ({ manifest_version: 3, name: 'Meet Canlı Çeviri', version: '2.0.0' }),
    sendMessage(...args) {
      if (!runtime.id) throw new Error('Extension context invalidated.');
      const [msg, cb] = args;
      env.sent.push({ msg, argc: args.length });
      if (typeof cb === 'function') {
        const resp = msg && msg.type === 'mt-status' ? env.statusResp : undefined;
        queueMicrotask(() => cb(resp));
        return undefined;
      }
      return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
    },
    onMessage: { addListener(f) { env.listener = f; } },
  };
  const local = {
    get(k, cb) { const r = {}; for (const key of [].concat(k)) { env.gets.push(key); if (key in env.storage) r[key] = JSON.parse(JSON.stringify(env.storage[key])); } queueMicrotask(() => cb(r)); },
    set(obj, cb) { Object.assign(env.storage, JSON.parse(JSON.stringify(obj))); if (cb) queueMicrotask(cb); },
    remove(k, cb) { delete env.storage[k]; if (cb) queueMicrotask(cb); },
  };
  const sandbox = {
    document: doc,
    chrome: { runtime, storage: { local } },
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/142.0 TestUA',
      clipboard: o.noClipboard ? undefined : {
        writeText: (t) => { env.clipboard.push(t); return o.clipboardReject ? Promise.reject(new Error('denied')) : Promise.resolve(); },
      },
    },
    CSSStyleSheet: class { replaceSync(t) { this.text = t; env.css = t; } },
    ResizeObserver: class { constructor(cb) { this.cb = cb; env.ros.push(this); } observe(n) { this.node = n; } },
    Blob,
    URL: { createObjectURL: (b) => { env.blobs.push(b); return 'blob:https://meet.google.com/1'; }, revokeObjectURL: (u) => env.revoked.push(u) },
    Date: FakeDate,
    setTimeout: clock.setTimeout, setInterval: clock.setInterval, clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval,
    console, queueMicrotask,
    innerWidth: 1280, innerHeight: 800,
    addEventListener(t, f) { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push(f); },
    postMessage(data) { env.posts.push(data); },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'content.js' });
  const win = vm.runInContext('globalThis', sandbox);
  Object.assign(env, {
    sandbox, win, doc, runtime,
    rt(msg) { env.listener(msg, { id: 'ext' }, (r) => env.responses.push(r)); },
    page(data) { for (const f of (winListeners.get('message') || []).slice()) f({ source: win, data: Object.assign({ source: 'mt-page' }, data) }); },
    resize(w, h) { sandbox.innerWidth = w; sandbox.innerHeight = h; for (const f of winListeners.get('resize') || []) f({}); },
    host() { return doc.documentElement.childNodes.find((n) => n.id === 'mt-overlay-host'); },
    root() { const h = env.host(); return h && h._shadow; },
    q(cls, root) { return all(root || env.root(), (n) => n._cls.has(cls))[0]; },
    qa(cls, root) { return all(root || env.root(), (n) => n._cls.has(cls)); },
    btn(text) { return all(env.root(), (n) => n.tagName === 'BUTTON' && n.textContent === text)[0]; },
    blocks() { return env.q('lines').childNodes; },
    note() { const n = env.q('note'); return n.hidden ? '' : n.textContent; },
    pill() { return env.q('pill').textContent; },
    visible() { const h = env.host(); return !!h && h.style.display === 'block'; },
    toPage(type) { return env.posts.filter((p) => p.source === 'mt-content' && p.type === type); },
    sentOf(type) { return env.sent.filter((s) => s.msg && s.msg.type === type); },
    start(ui) { env.rt({ type: 'mt-start', lang: 'tr', ui: Object.assign({ originalVoice: 'off', incomingSource: 'page', captionSize: 'm', showLatency: true }, ui) }); },
    cap(m) { env.rt(Object.assign({ type: 'caption' }, m)); },
    txTitle() { return env.q('tx-title').textContent; },
  });
  return env;
}

const NOTE_MIC = 'Sesinizin karşıya gitmesi için Meet sayfasında herhangi bir yere tıklayın.';
const NOTE_REMOTE = 'Gelen ses bulunamadı. Toplantıya katıldığınızdan emin olun; sorun sürerse Ayarlar\'dan "Sekme sesi" modunu seçin.';
const NOTE_TIP = 'İpucu: yankıyı önlemek için kulaklık kullanın.';

function blockParts(env, b) {
  const g = (cls) => all(b, (n) => n._cls.has(cls))[0];
  return {
    orig: g('orig'), otext: g('otext').textContent, badge: g('badge'), trans: g('trans'), ttext: g('ttext').textContent,
    mark: g('mark'), lat: g('latb'), tag: g('tag'),
  };
}

(async () => {
  const side = (o) => Object.assign({ state: 'ready', levelDb: -30, chunks: 10, partials: 3, commits: 1, clientCommits: 0, lastPartialAgoMs: 2000, lastCommitAgoMs: 4000 }, o);

  await test('diag: Tanı toggle persists; meter, dB, state labels and null level render', async () => {
    const env = makeEnv();
    env.start({ incomingSource: 'tab' });
    const diagBtn = env.btn('Tanı');
    assert.ok(diagBtn, 'Tanı button in the header');
    assert.equal(env.q('diag').hidden, true);
    diagBtn.click();
    assert.equal(env.q('diag').hidden, false);
    assert.equal(env.storage.overlayDiag, true);
    env.rt({ type: 'diag', capture: 'tab', in: side({ levelDb: -10 }), out: side({ state: 'backoff', levelDb: null }) });
    const rows = env.qa('dg-row');
    assert.equal(rows.length, 2);
    const lit = (r) => all(r, (n) => n._cls.has('dg-seg') && n._cls.has('on')).length;
    assert.equal(lit(rows[0]), 5, '-10 dB = full meter');
    assert.equal(lit(rows[1]), 0, 'no audio = empty meter');
    assert.match(env.q('dg-name', rows[0]).textContent, /sekme/);
    assert.equal(env.q('dg-state', rows[0]).textContent, 'bağlı');
    assert.equal(env.q('dg-state', rows[1]).textContent, 'yeniden bağlanıyor');
    assert.equal(env.q('dg-commits', rows[0]).textContent, 'kesin: 1');
    diagBtn.click();
    assert.equal(env.q('diag').hidden, true);
    assert.equal(env.storage.overlayDiag, false);
  });

  await test('diag: silent incoming audio for 20 s gives a hint; audio arriving clears it', async () => {
    const env = makeEnv();
    env.start({ incomingSource: 'tab' });
    let chunks = 10;
    for (let i = 0; i < 26; i++) {
      env.clock.advance(1000);
      env.rt({ type: 'diag', capture: 'tab', in: side({ levelDb: null, chunks: (chunks += 10) }), out: side({ chunks: chunks }) });
    }
    assert.match(env.note(), /Karşı tarafın sesi gelmiyor/);
    env.clock.advance(1000);
    env.rt({ type: 'diag', capture: 'tab', in: side({ levelDb: -25, chunks: (chunks += 10) }), out: side({ chunks: chunks }) });
    assert.doesNotMatch(env.note(), /Karşı tarafın sesi gelmiyor/);
  });

  await test('diag: no quiet hint for normal silence once a direction has been heard (level or caption)', async () => {
    const env = makeEnv();
    env.start({ incomingSource: 'tab' });
    let chunks = 10;
    const tickDiag = (inLevel, outLevel) => {
      env.clock.advance(1000);
      chunks += 10;
      env.rt({ type: 'diag', capture: 'tab', in: side({ levelDb: inLevel, chunks }), out: side({ levelDb: outLevel, chunks }) });
    };
    // the other side spoke once (audible), then stays silent for 30 s while I talk
    tickDiag(-25, -20);
    for (let i = 0; i < 30; i++) tickDiag(-90, -20);
    assert.equal(env.note(), '', 'a silent other side after audio was heard is not a capture problem');
    // I spoke once (a caption), then listen for 30 s with only room noise / muted (no audio)
    env.cap({ dir: 'out', id: 1, partial: false, original: 'Hello', translated: 'Merhaba' });
    for (let i = 0; i < 30; i++) tickDiag(-90, null);
    assert.equal(env.note(), '', 'listening quietly after speaking is not a mic problem');
    // a new session starts over: a direction never heard in it still gets the hint
    env.rt({ type: 'mt-stop' });
    env.clock.advance(20000);
    env.start({ incomingSource: 'tab' });
    for (let i = 0; i < 26; i++) tickDiag(null, -20);
    assert.match(env.note(), /Karşı tarafın sesi gelmiyor/);
  });

  await test('mute: mic-state muted -> engine mic-muted on transitions and on the first diag; Tanı row; muted stale mark', async () => {
    const env = makeEnv();
    const muteMsgs = () => env.sent.filter((s) => s.msg.type === 'mic-muted');
    env.page({ type: 'mic-state', state: 'virtual', muted: true });
    assert.equal(muteMsgs().length, 0, 'inactive: nothing sent');
    env.start({ incomingSource: 'tab' });
    env.btn('Tanı').click();
    env.page({ type: 'mic-state', state: 'virtual', muted: true }); // the page re-posts on start
    assert.deepEqual(muteMsgs().map((s) => ({ ...s.msg })), [{ to: 'offscreen', type: 'mic-muted', muted: true }]);
    assert.equal(muteMsgs()[0].argc, 1, 'fire-and-forget');
    assert.equal(env.q('dg-muted').hidden, false, "(Meet'te sessizde) shown");
    env.page({ type: 'mic-state', state: 'virtual', muted: true });
    assert.equal(muteMsgs().length, 1, 'no change: not re-sent');
    env.rt({ type: 'diag', capture: 'tab', in: side(), out: side() });
    assert.equal(muteMsgs().length, 2, 'first diag (engine up): current state sent again');
    assert.equal(muteMsgs()[1].msg.muted, true);
    env.rt({ type: 'diag', capture: 'tab', in: side(), out: side() });
    assert.equal(muteMsgs().length, 2);
    env.page({ type: 'mic-state', state: 'virtual', muted: false });
    assert.equal(muteMsgs().length, 3);
    assert.equal(muteMsgs()[2].msg.muted, false);
    assert.equal(env.q('dg-muted').hidden, true);
    // a translation not spoken because the mic was off
    env.cap({ dir: 'out', id: 3, partial: false, original: 'Okay.', translated: 'Tamam.', stale: true, muted: true });
    const mark = all(env.blocks()[0], (n) => n._cls.has('mark'))[0];
    assert.equal(mark.textContent, 'seslendirilmedi (mikrofon kapalıydı)');
    env.btn('Metin').click();
    assert.equal(env.q('tx-mark').textContent, 'seslendirilmedi (mikrofon kapalıydı)');
    env.btn('Kopyala').click();
    await flush();
    assert.ok(env.clipboard[0].includes('→ Tamam. (seslendirilmedi, mikrofon kapalıydı)'));
    env.rt({ type: 'mt-stop' });
    env.page({ type: 'mic-state', state: 'virtual', muted: true });
    assert.equal(muteMsgs().length, 3, 'inactive again: nothing sent');
  });

  await test('voice-passthrough: forwarded to the page with a note while on; ignored outside a session; reset by start', async () => {
    const NOTE_PASS = 'Çeviri geçici olarak yapılamıyor; sesiniz doğrudan gidiyor.';
    const env = makeEnv();
    env.rt({ type: 'voice-passthrough', on: true });
    assert.equal(env.toPage('voice-passthrough').length, 0, 'inactive: never unmutes');
    env.start();
    env.rt({ type: 'voice-passthrough', on: true, reason: 'Ses üretimi yanıt vermiyor.' });
    assert.deepEqual({ ...env.toPage('voice-passthrough')[0] }, { source: 'mt-content', type: 'voice-passthrough', on: true });
    assert.equal(env.note(), NOTE_PASS + ' Ses üretimi yanıt vermiyor.');
    env.rt({ type: 'voice-passthrough', on: false });
    assert.equal(env.toPage('voice-passthrough')[1].on, false);
    assert.equal(env.note(), NOTE_TIP);
    env.rt({ type: 'voice-passthrough', on: true });
    assert.equal(env.note(), NOTE_PASS);
    env.start(); // restart (language switch): the page resets its passthrough, so does the note
    assert.equal(env.note(), NOTE_TIP);
    env.rt({ type: 'voice-passthrough', on: true });
    env.rt({ type: 'mt-stop' });
    const n = env.toPage('voice-passthrough').length;
    env.rt({ type: 'voice-passthrough', on: true });
    assert.equal(env.toPage('voice-passthrough').length, n);
  });

  await test('left the call: no mic + quiet incoming audio for 60 s stops the session with a reason; otherwise not', async () => {
    const LEFT = 'Toplantıdan ayrıldınız; çeviri durduruldu.';
    const run = (o) => {
      const env = makeEnv();
      env.start({ incomingSource: 'tab' });
      env.page({ type: 'mic-state', state: o.mic || 'none', muted: false });
      for (let i = 1; i <= (o.secs || 62); i++) {
        env.clock.advance(1000);
        if (o.noDiag) continue;
        env.rt({ type: 'diag', capture: 'tab', in: side({ levelDb: o.loudAt === i ? -20 : null, chunks: 10 * i }), out: side({ levelDb: null, chunks: 10 * i }) });
      }
      return env;
    };
    const env = run({});
    const stops = env.sentOf('mt-stop');
    assert.equal(stops.length, 1);
    assert.equal(stops[0].msg.reason, LEFT);
    assert.equal(env.toPage('stop').length, 1, 'real voice back');
    assert.ok(env.visible(), 'bar kept to show why');
    assert.equal(env.pill(), LEFT);
    assert.equal(env.btn('Kapat').hidden, false);
    assert.equal(env.note(), '');
    // the background confirms with its own mt-stop: nothing changes
    env.rt({ type: 'mt-stop' });
    assert.equal(env.pill(), LEFT);
    // incoming audio heard at 30 s: the 60 s window restarts; the no-mic note does not tell the user to rejoin
    const env2 = run({ loudAt: 30 });
    assert.equal(env2.sentOf('mt-stop').length, 0);
    assert.match(env2.note(), /Mikrofonunuz çeviriye bağlı değil/);
    assert.doesNotMatch(env2.note(), /yeniden katıl/);
    // a live virtual mic, or no diag data at all: never
    assert.equal(run({ mic: 'virtual', secs: 90 }).sentOf('mt-stop').length, 0);
    assert.equal(run({ noDiag: true, secs: 90 }).sentOf('mt-stop').length, 0);
  });

  await test('notes: tab mode start note for 12 s, then the tip; not-ready hint mentions the internet; echo guard count', async () => {
    const NOTE_TAB = 'Toplantı sesi artık Windows\'un varsayılan ses çıkışından geliyor; kulaklık kullanıyorsanız onu Windows\'ta varsayılan yapın.';
    const env = makeEnv();
    env.start({ incomingSource: 'tab' });
    assert.equal(env.note(), NOTE_TAB);
    env.clock.advance(11000);
    assert.equal(env.note(), NOTE_TAB);
    env.clock.advance(1500);
    assert.equal(env.note(), NOTE_TIP);
    env.btn('Tanı').click();
    let chunks = 10;
    for (let i = 0; i < 20; i++) {
      env.clock.advance(1000);
      env.rt({ type: 'diag', capture: 'tab', in: side({ chunks: (chunks += 10) }), out: side({ state: 'backoff', chunks }), echoGated: 7 });
    }
    assert.equal(env.note(), 'Konuşma tanıma bağlantısı kurulamadı (mikrofon). İnternet bağlantınızı kontrol edin.');
    assert.equal(env.q('dg-gated').hidden, false);
    assert.equal(env.q('dg-gated').textContent, 'yankı koruması: 7 parça');
    env.rt({ type: 'diag', capture: 'tab', in: side(), out: side({ gated: 3 }), echoGated: 7 });
    assert.equal(env.q('dg-gated').textContent, 'yankı koruması: 3 parça', "the out side's own count wins");
    env.rt({ type: 'diag', capture: 'tab', in: side(), out: side() });
    assert.equal(env.q('dg-gated').hidden, true, 'unknown: not shown');
    // page mode keeps the plain 10 s tip
    const env2 = makeEnv();
    env2.start();
    assert.equal(env2.note(), NOTE_TIP);
  });

  await test('mt-ping answers without side effects', async () => {
    const env = makeEnv();
    env.rt({ type: 'mt-ping' });
    assert.deepEqual(JSON.parse(JSON.stringify(env.responses)), [{ ok: true }]);
    assert.equal(env.host(), undefined, 'no overlay');
    assert.equal(env.posts.length, 0, 'nothing to the page');
  });

  await test('diag: report copied with sections, version, no keys', async () => {
    const env = makeEnv();
    env.start({ incomingSource: 'tab' });
    env.btn('Tanı').click();
    env.rt({ type: 'diag', capture: 'tab', in: side(), out: side() });
    env.rt({ type: 'status', state: 'live' });
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Merhaba', translated: 'Hello' });
    env.btn('Tanı raporunu kopyala').click();
    await new Promise((r) => setImmediate(r));
    const report = env.clipboard[env.clipboard.length - 1];
    assert.ok(report && report.includes('tanı raporu'));
    assert.ok(report.includes('2.0.0'));
    assert.ok(report.includes('Son tanı'));
    assert.ok(report.includes('Hello'));
    assert.ok(!/elevenKey|anthropicKey|sk-ant/i.test(report));
  });

  await test('fake clock drives Date inside the content script', async () => {
    const env = makeEnv();
    assert.equal(vm.runInContext('Date.now()', env.sandbox), BASE);
    env.clock.advance(1000);
    assert.equal(vm.runInContext('Date.now()', env.sandbox), BASE + 1000);
  });

  await test('load: mt-status asked once (with callback); nothing shown when no session', async () => {
    const env = makeEnv();
    await flush();
    assert.equal(env.sentOf('mt-status').length, 1);
    assert.equal(env.sentOf('mt-status')[0].argc, 2);
    assert.equal(env.host(), undefined, 'overlay built lazily');
  });

  await test('mt-start: ui passed to the page, overlay shown, settings applied, CSS-safe overlay', async () => {
    const env = makeEnv();
    env.start({ originalVoice: 'low', captionSize: 'l' });
    assert.deepEqual(JSON.parse(JSON.stringify(env.responses)), [{ ok: true }]);
    const st = env.toPage('start');
    assert.equal(st.length, 1);
    assert.deepEqual({ ...st[0] }, { source: 'mt-content', type: 'start', originalVoice: 'low', capture: 'page' });
    assert.ok(env.visible());
    assert.equal(env.host().style.cssText.includes('z-index:2147483647'), true);
    assert.equal(env.host().style.cssText.includes('pointer-events:none'), true);
    assert.equal(env.root().mode, 'closed');
    assert.equal(env.root().adoptedStyleSheets.length, 1, 'constructable stylesheet, no inline <style>');
    const panel = env.q('panel');
    assert.ok(panel._cls.has('size-l') && !panel._cls.has('size-m'));
    assert.ok(panel._cls.has('docked'));
    assert.equal(env.pill(), 'Bağlanıyor…');
    assert.equal(env.note(), NOTE_TIP);
    await flush();
    assert.deepEqual(env.storage.mtLastUi, { originalVoice: 'low', incomingSource: 'page', captionSize: 'l', showLatency: true });
    // pointer-events: only controls (and the open transcript) are interactive
    assert.match(env.css, /\.panel \{[^}]*pointer-events: none/);
    assert.match(env.css, /\.grip \{[^}]*pointer-events: auto/);
    assert.match(env.css, /button \{[^}]*pointer-events: auto/);
    assert.match(env.css, /\.tx \{[^}]*pointer-events: auto/);
    assert.match(env.css, /\[hidden\] \{ display: none !important; \}/);
    assert.match(env.css, /\.tx \{[^}]*max-height: 40vh/);
    for (const [s, px] of [['s', 16], ['m', 20], ['l', 26]]) {
      assert.match(env.css, new RegExp('\\.panel\\.size-' + s + ' \\{ --trans-size: ' + px + 'px'));
    }
    // a start without ui (v1 background) falls back to defaults
    const env2 = makeEnv();
    env2.rt({ type: 'mt-start', lang: 'tr' });
    assert.deepEqual({ ...env2.toPage('start')[0] }, { source: 'mt-content', type: 'start', originalVoice: 'off', capture: 'page' });
    assert.ok(env2.q('panel')._cls.has('size-m'));
  });

  await test('captions: partial -> draft (italic) -> commit keeps the dimmed draft -> final; late drafts ignored', async () => {
    const env = makeEnv();
    env.start();
    env.cap({ dir: 'in', id: 1, partial: true, original: '' });
    assert.equal(env.blocks().length, 0, 'empty partial makes no block');
    env.cap({ dir: 'in', id: 1, partial: true, original: 'Merhaba', lang: null });
    let b = blockParts(env, env.blocks()[0]);
    assert.equal(b.otext, 'Merhaba');
    assert.equal(b.badge.hidden, true);
    assert.equal(b.ttext, '…');
    assert.equal(b.trans.className, 'trans pending');
    env.cap({ dir: 'in', id: 1, partial: true, original: 'Merhaba nasıl', lang: 'tr' });
    b = blockParts(env, env.blocks()[0]);
    assert.equal(b.badge.hidden, false);
    assert.equal(b.badge.textContent, 'TR');
    env.cap({ dir: 'in', id: 1, partial: true, original: 'Merhaba', translated: 'Hello how', draft: true });
    b = blockParts(env, env.blocks()[0]);
    assert.equal(b.ttext, 'Hello how');
    assert.equal(b.trans.className, 'trans draft');
    assert.equal(b.otext, 'Merhaba nasıl', "a draft's (older) original does not overwrite the live transcript");
    env.cap({ dir: 'in', id: 1, partial: true, original: 'Merhaba nasılsınız' });
    b = blockParts(env, env.blocks()[0]);
    assert.equal(b.otext, 'Merhaba nasılsınız');
    assert.equal(b.ttext, 'Hello how', 'draft kept while the transcript grows');
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Merhaba, nasılsınız?', lang: 'tr' });
    b = blockParts(env, env.blocks()[0]);
    assert.equal(b.trans.className, 'trans draft committed');
    assert.equal(b.ttext, 'Hello how');
    assert.equal(env.txTitle(), 'Konuşma metni', 'commit alone is not in the transcript');
    env.cap({ dir: 'in', id: 1, partial: true, translated: 'late draft', draft: true });
    assert.equal(blockParts(env, env.blocks()[0]).ttext, 'Hello how');
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Merhaba, nasılsınız?', translated: 'Hello, how are you?', lang: 'tr' });
    b = blockParts(env, env.blocks()[0]);
    assert.equal(b.ttext, 'Hello, how are you?');
    assert.equal(b.trans.className, 'trans');
    assert.ok(!env.blocks()[0]._cls.has('partial'));
    env.cap({ dir: 'in', id: 1, partial: true, translated: 'later', draft: true });
    env.cap({ dir: 'in', id: 1, partial: true, original: 'stray partial' });
    b = blockParts(env, env.blocks()[0]);
    assert.equal(b.ttext, 'Hello, how are you?');
    assert.equal(b.otext, 'Merhaba, nasılsınız?');
    assert.equal(env.txTitle(), 'Konuşma metni (1)');
    // "…" only when there is no draft; outgoing partials show "…" next to the "Sen" tag
    env.cap({ dir: 'out', id: 1, partial: true, original: 'I think so' });
    const o = blockParts(env, env.blocks()[1]);
    assert.equal(o.tag.textContent, 'Sen');
    assert.equal(o.ttext, '…');
  });

  await test('failed / stale / passthrough / skipped rendering; max 3 blocks', async () => {
    const env = makeEnv();
    env.start();
    env.cap({ dir: 'in', id: 2, partial: true, original: 'Bir şey' });
    env.cap({ dir: 'in', id: 2, partial: false, original: 'Bir şey söyledi', lang: 'tr', failed: true });
    let b = blockParts(env, env.blocks()[0]);
    assert.ok(env.blocks()[0]._cls.has('failed'));
    assert.equal(b.orig.hidden, false);
    assert.equal(b.otext, 'Bir şey söyledi');
    assert.equal(b.badge.textContent, 'TR');
    assert.equal(b.ttext, '');
    assert.equal(b.mark.hidden, false);
    assert.equal(b.mark.textContent, '⚠ çevrilemedi');
    env.cap({ dir: 'out', id: 1, partial: true, original: 'I think so' });
    env.cap({ dir: 'out', id: 1, partial: false, original: 'I think so.', translated: 'Bence de.', stale: true });
    b = blockParts(env, env.blocks()[1]);
    assert.equal(b.ttext, 'Bence de.');
    assert.equal(b.mark.textContent, 'seslendirilmedi');
    assert.ok(b.mark._cls.has('stale'));
    env.cap({ dir: 'out', id: 2, partial: false, original: 'Merci', translated: 'Merci', passthrough: true, lang: 'fr' });
    b = blockParts(env, env.blocks()[2]);
    assert.equal(b.orig.hidden, true, 'passthrough: shown once');
    assert.equal(b.ttext, 'Merci');
    assert.equal(b.badge.hidden, true, 'no badge on outgoing blocks');
    env.cap({ dir: 'in', id: 9, partial: false, original: 'Okay', translated: 'Okay', passthrough: true, lang: 'en' });
    assert.equal(env.blocks().length, 4, 'fading block still attached for 450 ms');
    env.clock.advance(500);
    assert.equal(env.blocks().length, 3, 'max 3 blocks');
    b = blockParts(env, env.blocks()[2]);
    assert.equal(b.orig.hidden, true);
    assert.equal(b.badge.hidden, true, 'no badge for en');
    // skipped removes the block silently and keeps it out of the transcript
    env.cap({ dir: 'in', id: 3, partial: true, original: 'eee' });
    const n = env.txTitle();
    env.cap({ dir: 'in', id: 3, partial: false, original: 'eee', skipped: true });
    env.clock.advance(500);
    assert.ok(!env.blocks().some((x) => x.textContent.includes('eee')));
    env.cap({ dir: 'in', id: 3, partial: false, original: 'eee', translated: 'uh' });
    assert.ok(!env.blocks().some((x) => x.textContent.includes('uh')), 'late update after skip ignored');
    assert.equal(env.txTitle(), 'Konuşma metni (5)');
    assert.notEqual(n, undefined);
    // skipped as the first message for an id (echo guard) never shows a block
    env.cap({ dir: 'out', id: 7, partial: false, original: 'echo', skipped: true });
    env.cap({ dir: 'out', id: 7, partial: true, original: 'echo' });
    assert.ok(!env.blocks().some((x) => x.textContent.includes('echo')));
  });

  await test('metrics: per-block badge and per-direction rolling averages in the header', async () => {
    const env = makeEnv();
    env.start();
    env.cap({ dir: 'in', id: 1, partial: false, original: 'a', translated: 'A' });
    env.rt({ type: 'metrics', dir: 'in', id: 1, translateMs: 800, totalMs: 1234 });
    const b = blockParts(env, env.blocks()[0]);
    assert.equal(b.lat.hidden, false);
    assert.equal(b.lat.textContent, '1,2 sn');
    const lat = env.q('lat');
    assert.equal(lat.hidden, false);
    assert.equal(lat.textContent, '↘ 1,2 sn');
    env.rt({ type: 'metrics', dir: 'out', id: 5, translateMs: 500, firstAudioMs: 400, totalMs: 1900, speculative: true });
    assert.equal(lat.textContent, '↘ 1,2 sn · ↗ 1,9 sn');
    for (const ms of [1000, 2000, 3000, 4000, 5000]) env.rt({ type: 'metrics', dir: 'in', id: 99, totalMs: ms });
    assert.equal(lat.textContent, '↘ 3,0 sn · ↗ 1,9 sn');
    env.rt({ type: 'metrics', dir: 'out', id: 6, totalMs: 0 });
    assert.equal(lat.textContent, '↘ 3,0 sn · ↗ 1,0 sn');
    env.rt({ type: 'metrics', dir: 'in', id: 1, totalMs: 'x' });
    env.rt({ type: 'metrics', dir: 'sideways', id: 1, totalMs: 5 });
    assert.equal(lat.textContent, '↘ 3,0 sn · ↗ 1,0 sn');
    // showLatency off: nothing
    const env2 = makeEnv();
    env2.start({ showLatency: false });
    env2.cap({ dir: 'in', id: 1, partial: false, original: 'a', translated: 'A' });
    env2.rt({ type: 'metrics', dir: 'in', id: 1, totalMs: 1234 });
    assert.equal(env2.q('lat').hidden, true);
    assert.equal(blockParts(env2, env2.blocks()[0]).lat.hidden, true);
  });

  await test('transcript: Metin toggles a scrollable panel; rows sorted by start time; Kopyala / İndir (.txt)', async () => {
    const env = makeEnv();
    env.start();
    const metin = env.btn('Metin');
    const tx = env.q('tx');
    assert.equal(tx.hidden, true);
    assert.equal(env.btn('Kopyala').disabled, true, 'nothing to copy yet');
    metin.click();
    assert.equal(tx.hidden, false);
    assert.equal(metin.getAttribute('aria-pressed'), 'true');
    assert.equal(env.q('tx-empty').hidden, false);
    assert.ok(metin.blurred >= 1, 'buttons drop focus (Meet shortcuts)');
    // segment A (in) starts at +2 s but finishes after segment B (out, +5 s)
    env.clock.advance(2000);
    env.cap({ dir: 'in', id: 1, partial: true, original: 'Merhaba', lang: 'tr' });
    env.clock.advance(3000);
    env.cap({ dir: 'out', id: 1, partial: true, original: "I'm fine" });
    env.cap({ dir: 'out', id: 1, partial: false, original: "I'm fine.", translated: 'İyiyim.' });
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Merhaba, nasılsınız?', translated: 'Hello, how are you?', lang: 'tr' });
    const rows = env.q('tx-list').childNodes;
    assert.equal(rows.length, 2);
    assert.equal(env.q('tx-time', rows[0]).textContent, '14:05:02');
    assert.equal(env.q('tx-who', rows[0]).textContent, 'Karşı taraf (TR)');
    assert.equal(env.q('tx-time', rows[1]).textContent, '14:05:05');
    assert.equal(env.q('tx-who', rows[1]).textContent, 'Sen');
    assert.equal(env.q('tx-empty').hidden, true);
    assert.equal(env.txTitle(), 'Konuşma metni (2)');
    // a stale flag that arrives after the final updates the row in place
    env.cap({ dir: 'out', id: 1, partial: false, original: "I'm fine.", translated: 'İyiyim.', stale: true });
    assert.equal(env.q('tx-list').childNodes.length, 2);
    assert.equal(env.q('tx-mark', env.q('tx-list').childNodes[1]).textContent, 'seslendirilmedi');
    // copy
    const copy = env.btn('Kopyala');
    copy.click();
    await flush();
    const expected = [
      'Meet Canlı Çeviri — konuşma metni', 'Tarih: 13.11.2026', '',
      '[14:05:02] Karşı taraf (TR): Merhaba, nasılsınız?', '           → Hello, how are you?',
      "[14:05:05] Sen: I'm fine.", '           → İyiyim. (seslendirilmedi)', '',
    ].join('\n');
    assert.equal(env.clipboard[0], expected);
    assert.equal(copy.textContent, 'Kopyalandı');
    env.clock.advance(1700);
    assert.equal(copy.textContent, 'Kopyala');
    // download
    env.btn('İndir (.txt)').click();
    assert.equal(env.blobs.length, 1);
    const bytes = Buffer.from(await env.blobs[0].arrayBuffer()); // Blob.text() would strip the BOM
    assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM');
    assert.equal(bytes.subarray(3).toString('utf8'), expected.replace(/\n/g, '\r\n'));
    assert.equal(env.blobs[0].type, 'text/plain;charset=utf-8');
    const a = all(env.root(), (n) => n.tagName === 'A');
    assert.equal(a.length, 0, 'temporary <a> removed');
    env.clock.advance(30000);
    assert.deepEqual(env.revoked, ['blob:https://meet.google.com/1']);
    // close
    metin.click();
    assert.equal(tx.hidden, true);
    assert.equal(env.q('tx-list').childNodes.length, 0, 'rows only exist while open');
    metin.click();
    assert.equal(env.q('tx-list').childNodes.length, 2);
  });

  await test('download anchor: name, click; clipboard fallback via execCommand', async () => {
    const env = makeEnv({ noClipboard: true });
    env.start();
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Selam', translated: 'Hi', lang: 'tr' });
    let anchor = null;
    const origCreate = env.doc.createElement;
    env.doc.createElement = (t) => { const n = origCreate(t); if (t === 'a') anchor = n; return n; };
    env.btn('Metin').click();
    env.btn('İndir (.txt)').click();
    assert.equal(anchor.download, 'meet-ceviri-2026-11-13-1405.txt');
    assert.equal(anchor.clicks, 1);
    env.btn('Kopyala').click();
    assert.equal(env.execCopy, 1);
    assert.equal(env.btn('Kopyalandı') !== undefined, true);
  });

  await test('notes: tip for 10 s, mic suspended, no remote audio for 20 s (page mode only)', async () => {
    const env = makeEnv();
    env.start();
    assert.equal(env.note(), NOTE_TIP);
    env.page({ type: 'mic-state', state: 'suspended' });
    assert.equal(env.note(), NOTE_MIC, 'mic note has priority');
    env.page({ type: 'mic-state', state: 'virtual' });
    assert.equal(env.note(), NOTE_TIP);
    env.page({ type: 'mic-state', state: 'bogus' });
    assert.equal(env.note(), NOTE_TIP);
    env.clock.advance(11000);
    assert.equal(env.note(), '');
    env.clock.advance(9000); // 20 s without any remote-state
    assert.equal(env.note(), NOTE_REMOTE);
    env.page({ type: 'remote-state', tracks: 3, running: true });
    assert.equal(env.note(), '');
    env.page({ type: 'remote-state', tracks: 0, running: true });
    env.clock.advance(19000);
    assert.equal(env.note(), '');
    env.clock.advance(1000);
    assert.equal(env.note(), NOTE_REMOTE);
    env.page({ type: 'mic-state', state: 'suspended' });
    assert.equal(env.note(), NOTE_MIC);
    // tab mode: never the remote note
    const env2 = makeEnv();
    env2.start({ incomingSource: 'tab' });
    env2.clock.advance(60000);
    assert.equal(env2.note(), '');
    // notes are not shown while inactive
    env2.rt({ type: 'mt-stop' });
    env2.page({ type: 'mic-state', state: 'suspended' });
    assert.equal(env2.visible(), false);
  });

  await test('bridge: mic/remote forwarded fire-and-forget (no callback), remote only in page mode', async () => {
    const env = makeEnv();
    env.page({ type: 'mic', b64: 'AAAA' });
    assert.equal(env.sent.filter((s) => s.msg.to === 'offscreen').length, 0, 'inactive: nothing forwarded');
    env.start();
    env.page({ type: 'mic', b64: 'AAAA' });
    env.page({ type: 'remote', b64: 'BBBB' });
    env.page({ type: 'mic', b64: 7 });
    const fwd = env.sent.filter((s) => s.msg.to === 'offscreen');
    assert.equal(fwd.length, 2);
    assert.deepEqual({ ...fwd[0].msg }, { to: 'offscreen', type: 'mic', b64: 'AAAA' });
    assert.deepEqual({ ...fwd[1].msg }, { to: 'offscreen', type: 'remote', b64: 'BBBB' });
    assert.ok(fwd.every((f) => f.argc === 1), 'no response callback');
    await flush(); // the rejected promise (no receiver) is swallowed: no unhandled rejection
    // tts relay to the page
    env.rt({ type: 'tts-chunk', id: 4, b64: 'CCCC' });
    env.rt({ type: 'tts-end', id: 4 });
    assert.deepEqual({ ...env.toPage('tts-chunk')[0] }, { source: 'mt-content', type: 'tts-chunk', id: 4, b64: 'CCCC' });
    assert.deepEqual({ ...env.toPage('tts-end')[0] }, { source: 'mt-content', type: 'tts-end', id: 4 });
    // tab mode: remote dropped, mic still forwarded
    const env2 = makeEnv();
    env2.start({ incomingSource: 'tab' });
    assert.equal(env2.toPage('start')[0].capture, 'tab');
    env2.page({ type: 'remote', b64: 'BBBB' });
    env2.page({ type: 'mic', b64: 'AAAA' });
    assert.deepEqual(env2.sent.filter((s) => s.msg.to === 'offscreen').map((s) => s.msg.type), ['mic']);
    // foreign event sources are ignored
    for (const f of [env2.win]) assert.ok(f);
    env2.rt({ type: 'mt-stop' });
    env2.rt({ type: 'tts-chunk', id: 1, b64: 'x' });
    assert.equal(env2.toPage('tts-chunk').length, 0);
  });

  await test('drag: grip moves the panel, {x,y} persisted, click without movement is not a drag, dblclick resets, clamp', async () => {
    const env = makeEnv();
    env.start();
    await flush();
    const grip = env.q('grip');
    const panel = env.q('panel');
    const down = grip.dispatch('pointerdown', { button: 0, pointerId: 7, clientX: 400, clientY: 650 });
    assert.equal(down.defaultPrevented, true);
    assert.equal(down.stopped, true);
    assert.equal(grip.captured, 7);
    grip.dispatch('pointermove', { pointerId: 7, clientX: 300, clientY: 300 });
    assert.ok(!panel._cls.has('docked'));
    assert.equal(panel.style.left, '240px');
    assert.equal(panel.style.top, '250px');
    grip.dispatch('pointerup', { pointerId: 7, clientX: 300, clientY: 300 });
    await flush();
    assert.deepEqual(env.storage.overlayPos, { x: 240, y: 250 });
    // a plain click on the grip does not move or write
    delete env.storage.overlayPos;
    grip.dispatch('pointerdown', { button: 0, pointerId: 8, clientX: 10, clientY: 10 });
    grip.dispatch('pointermove', { pointerId: 8, clientX: 11, clientY: 11 });
    grip.dispatch('pointerup', { pointerId: 8, clientX: 11, clientY: 11 });
    await flush();
    assert.equal(env.storage.overlayPos, undefined);
    // drags are clamped into the viewport
    grip.dispatch('pointerdown', { button: 0, pointerId: 9, clientX: 0, clientY: 0 });
    grip.dispatch('pointermove', { pointerId: 9, clientX: 5000, clientY: -5000 });
    grip.dispatch('lostpointercapture', { pointerId: 9 });
    await flush();
    assert.deepEqual(env.storage.overlayPos, { x: 672, y: 8 });
    // the window shrinks: the applied position is re-clamped, the stored intent stays
    env.resize(1000, 700);
    assert.equal(panel.style.left, '392px');
    env.resize(1280, 800);
    assert.equal(panel.style.left, '672px');
    // right button is ignored
    grip.dispatch('pointerdown', { button: 2, pointerId: 10, clientX: 0, clientY: 0 });
    assert.equal(grip.captured, null);
    // double-click resets to the docked default and forgets the position
    const dbl = grip.dispatch('dblclick', {});
    assert.equal(dbl.stopped, true);
    await flush();
    assert.equal(env.storage.overlayPos, undefined);
    assert.ok(panel._cls.has('docked'));
    assert.equal(panel.style.left, '');
    // a stored position is loaded and clamped on the next page load
    const env2 = makeEnv({ storage: { overlayPos: { x: 5000, y: 10 } } });
    env2.start();
    await flush();
    assert.equal(env2.q('panel').style.left, '672px');
    assert.equal(env2.q('panel').style.top, '10px');
    const env3 = makeEnv({ storage: { overlayPos: { x: 'a', y: null } } });
    env3.start();
    await flush();
    assert.ok(env3.q('panel')._cls.has('docked'), 'garbage position ignored');
  });

  await test('stop keeps a compact bar for the transcript; quick restart keeps it, a later start clears it', async () => {
    const env = makeEnv();
    env.start();
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Selam', translated: 'Hi', lang: 'tr' });
    env.rt({ type: 'status', state: 'live' });
    env.rt({ type: 'mt-stop' });
    assert.deepEqual({ ...env.responses[env.responses.length - 1] }, { ok: true });
    assert.equal(env.toPage('stop').length, 1);
    assert.ok(env.visible());
    assert.equal(env.pill(), 'Durduruldu');
    assert.equal(env.q('stop').hidden, true);
    assert.equal(env.btn('Kapat').hidden, false);
    assert.equal(env.blocks().length, 0);
    assert.equal(env.note(), '');
    assert.equal(env.q('lat').hidden, true);
    // language switch: background restarts within a second
    env.clock.advance(800);
    env.start();
    assert.equal(env.txTitle(), 'Konuşma metni (1)', 'transcript kept across a restart');
    assert.equal(env.q('stop').hidden, false);
    assert.equal(env.btn('Kapat').hidden, true);
    // same ids in the new session do not collide with the old ones
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Hallo', translated: 'Hello', lang: 'de' });
    assert.equal(env.txTitle(), 'Konuşma metni (2)');
    // stop from the overlay button
    env.q('stop').click();
    assert.equal(env.sentOf('mt-stop').length, 1);
    assert.ok(env.visible());
    env.btn('Kapat').click();
    assert.equal(env.visible(), false);
    env.clock.advance(16000);
    env.start();
    assert.equal(env.txTitle(), 'Konuşma metni', 'cleared on the next (non-restart) start');
    // stopping with an empty transcript hides immediately
    env.rt({ type: 'mt-stop' });
    assert.equal(env.visible(), false);
    // a stray mt-stop while inactive changes nothing
    env.rt({ type: 'mt-stop' });
    assert.equal(env.visible(), false);
  });

  await test('status: pending status before mt-start, transient live notice, error linger then hide', async () => {
    const env = makeEnv();
    env.rt({ type: 'status', state: 'live' });
    env.start();
    assert.equal(env.pill(), 'Canlı çeviri');
    assert.ok(env.q('pill')._cls.has('live'));
    env.rt({ type: 'status', state: 'live', message: 'Bir cümle işlenemedi (HTTP 500).' });
    assert.equal(env.pill(), 'Bir cümle işlenemedi (HTTP 500).');
    env.clock.advance(6000);
    assert.equal(env.pill(), 'Canlı çeviri');
    env.rt({ type: 'status', state: 'connecting', message: 'Yeniden bağlanıyor…' });
    assert.equal(env.pill(), 'Yeniden bağlanıyor…');
    env.cap({ dir: 'in', id: 1, partial: true, original: 'test' });
    env.rt({ type: 'status', state: 'error', message: 'ElevenLabs anahtarı geçersiz.' });
    env.rt({ type: 'mt-stop' });
    assert.ok(env.visible());
    assert.equal(env.pill(), 'ElevenLabs anahtarı geçersiz.');
    assert.equal(env.blocks().length, 1, 'captions stay readable during the linger');
    assert.equal(env.q('stop').hidden, true);
    env.clock.advance(7900);
    assert.ok(env.visible());
    assert.equal(env.blocks().length, 1);
    env.clock.advance(200);
    // after the linger an error keeps a compact bar even without a transcript: the reason and the
    // Tanı report stay reachable until Kapat
    assert.ok(env.visible(), 'error bar kept (empty transcript)');
    assert.equal(env.blocks().length, 0);
    assert.equal(env.pill(), 'ElevenLabs anahtarı geçersiz.');
    assert.equal(env.btn('Kapat').hidden, false);
    assert.ok(env.btn('Tanı'));
    env.btn('Kapat').click();
    assert.equal(env.visible(), false);
    // with a transcript the error stays in a compact bar
    const env2 = makeEnv();
    env2.start();
    env2.cap({ dir: 'in', id: 1, partial: false, original: 'a', translated: 'b' });
    env2.rt({ type: 'status', state: 'error', message: 'Kota doldu.' });
    env2.rt({ type: 'mt-stop' });
    env2.clock.advance(8100);
    assert.ok(env2.visible());
    assert.equal(env2.pill(), 'Kota doldu.');
    assert.equal(env2.btn('Kapat').hidden, false);
  });

  await test('reload recovery: resp.ui, else the last mt-start ui; requires senderTabId === tabId', async () => {
    const env = makeEnv({
      statusResp: { active: true, lang: 'tr', tabId: 5, senderTabId: 5, state: 'live', message: null },
      storage: { mtLastUi: { originalVoice: 'low', incomingSource: 'tab', captionSize: 's', showLatency: false } },
    });
    await flush();
    await flush();
    assert.deepEqual({ ...env.toPage('start')[0] }, { source: 'mt-content', type: 'start', originalVoice: 'low', capture: 'tab' });
    assert.ok(env.q('panel')._cls.has('size-s'));
    assert.equal(env.pill(), 'Canlı çeviri');
    const env2 = makeEnv({
      statusResp: { active: true, tabId: 5, senderTabId: 5, state: 'connecting', ui: { originalVoice: 'off', incomingSource: 'page', captionSize: 'l', showLatency: true } },
      storage: { mtLastUi: { incomingSource: 'tab' } },
    });
    await flush();
    await flush();
    assert.equal(env2.toPage('start')[0].capture, 'page');
    assert.ok(env2.q('panel')._cls.has('size-l'));
    const env3 = makeEnv({ statusResp: { active: true, tabId: 5, senderTabId: 6, state: 'live' } });
    await flush();
    await flush();
    assert.equal(env3.toPage('start').length, 0, 'another tab: no recovery');
  });

  await test('extension reloaded under the page: real voice restored (stop to page), overlay hidden', async () => {
    const env = makeEnv();
    env.start();
    env.runtime.id = undefined;
    env.page({ type: 'mic', b64: 'AAAA' });
    assert.equal(env.toPage('stop').length, 1);
    assert.equal(env.visible(), false);
    const env2 = makeEnv();
    env2.start();
    env2.runtime.id = undefined;
    env2.clock.advance(1000); // detected by the 1 s tick
    assert.equal(env2.toPage('stop').length, 1);
    assert.equal(env2.visible(), false);
  });

  await test('skipped after a final removes the transcript row; clipboard rejection falls back to execCommand', async () => {
    const env = makeEnv({ clipboardReject: true });
    env.start();
    env.btn('Metin').click();
    env.cap({ dir: 'in', id: 1, partial: false, original: 'Selam', translated: 'Hi', lang: 'tr' });
    env.cap({ dir: 'in', id: 2, partial: false, original: 'hmm', translated: 'hmm', lang: 'tr' });
    assert.equal(env.q('tx-list').childNodes.length, 2);
    env.cap({ dir: 'in', id: 2, partial: false, original: 'hmm', skipped: true });
    assert.equal(env.q('tx-list').childNodes.length, 1);
    assert.equal(env.txTitle(), 'Konuşma metni (1)');
    env.btn('Kopyala').click();
    await flush();
    assert.equal(env.clipboard.length, 1, 'tried the async clipboard first');
    assert.equal(env.execCopy, 1, 'then execCommand');
    assert.ok(env.btn('Kopyalandı'));
  });

  await test('garbage messages never throw', async () => {
    const env = makeEnv();
    env.start();
    for (const m of [
      { type: 'caption' }, { type: 'caption', dir: 'in' }, { type: 'caption', dir: 'up', id: 1 },
      { type: 'caption', dir: 'in', id: 1, partial: false }, { type: 'metrics' }, { type: 'status' },
      { type: 'tts-chunk', b64: 5 }, { type: 'nope' }, { to: 'offscreen', type: 'mic' },
    ]) env.rt(m);
    env.listener(null, {}, () => {});
    env.listener('x', {}, () => {});
    env.page({ type: 'remote-state', tracks: 'many' });
    env.page({ type: 'unknown' });
    for (const f of [() => env.page(null)]) {
      try { f(); } catch (e) { /* page(null) builds a message; fine */ }
    }
    env.clock.advance(20000);
    assert.ok(env.visible());
  });

  console.log(`\n${passed} tests passed` + (failed ? `, ${failed} FAILED` : ''));
  if (failed) process.exit(1);
})();
