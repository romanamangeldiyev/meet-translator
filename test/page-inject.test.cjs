const ROOT = require('path').resolve(__dirname, '..').split('\\').join('/') + '/';
// Loads the real src/inject.js into a vm context with a minimal fake DOM /
// WebAudio / MediaDevices / RTCPeerConnection and checks the v2 behaviour.
'use strict';
const fs = require('fs');
const vm = require('vm');
const assert = require('assert/strict');

const SRC = fs.readFileSync(ROOT + 'src/inject.js', 'utf8');

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

function makeClock() {
  let now = 0;
  let seq = 0;
  const timers = new Map();
  return {
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
    get size() { return timers.size; },
  };
}

class ET {
  constructor() { this._l = new Map(); }
  addEventListener(t, f) { if (!this._l.has(t)) this._l.set(t, []); const a = this._l.get(t); if (!a.includes(f)) a.push(f); }
  removeEventListener(t, f) { const a = this._l.get(t); if (a) { const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); } }
  dispatchEvent(ev) { for (const f of (this._l.get(ev.type) || []).slice()) f.call(this, ev); return true; }
  count(t) { return (this._l.get(t) || []).length; }
}

function makeEnv(o = {}) {
  const env = {
    posts: [], ctxs: [], procs: [], gains: [], sources: [], dests: [], audios: [], bufSources: [], gum: [],
    resumeCalls: 0, allowResume: o.allowResume !== false, ctxInitial: o.ctxInitial || 'running',
  };
  const clock = makeClock();
  env.clock = clock;

  class MediaStreamTrack extends ET {
    constructor(kind, label) { super(); this.kind = kind; this.label = label || ''; this.readyState = 'live'; this.enabled = true; this.stopCalls = 0; }
    stop() { this.stopCalls++; this.readyState = 'ended'; }
    getSettings() { return { deviceId: 'dev-' + this.label, groupId: 'g1' }; }
    getCapabilities() { return { deviceId: 'dev-' + this.label }; }
    getConstraints() { return { echoCancellation: true }; }
    applyConstraints(c) { this.applied = c; return Promise.reject(new Error('Overconstrained')); }
    clone() { const c = new MediaStreamTrack(this.kind, this.label); c.enabled = this.enabled; c.readyState = this.readyState; return c; }
  }
  class MediaStream {
    constructor(tracks) { this._t = Array.from(tracks || []); }
    clone() { return new MediaStream(this._t.map((t) => MediaStreamTrack.prototype.clone.call(t))); }
    getTracks() { return this._t.slice(); }
    getAudioTracks() { return this._t.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this._t.filter((t) => t.kind === 'video'); }
    addTrack(t) { this._t.push(t); }
  }
  class AudioParam {
    constructor(v) { this.value = v; this.events = []; this.target = undefined; }
    setTargetAtTime(v, t, c) { this.events.push(['target', v, t, c]); this.target = v; }
    cancelScheduledValues(t) { this.events.push(['cancel', t]); }
  }
  class AudioNode {
    constructor(ctx, kind) { this.context = ctx; this.kind = kind; this.outs = new Set(); this.fullDisconnects = 0; }
    connect(n) { this.outs.add(n); return n; }
    disconnect(n) {
      if (n === undefined) { this.outs.clear(); this.fullDisconnects++; return; }
      if (!this.outs.has(n)) throw new Error('InvalidAccessError');
      this.outs.delete(n);
    }
  }
  class AudioContext extends ET {
    constructor(opts) {
      super();
      if (o.ctxThrows) throw new Error('NotSupportedError');
      this.state = env.ctxInitial; this.sampleRate = o.sampleRate || 48000; this.currentTime = 1.5;
      this.destination = new AudioNode(this, 'destination'); this.opts = opts; env.ctxs.push(this);
    }
    resume() {
      env.resumeCalls++;
      if (!env.allowResume) return new Promise(() => {}); // Chrome without user activation: stays pending
      if (this.state !== 'running') {
        this.state = 'running';
        Promise.resolve().then(() => this.dispatchEvent({ type: 'statechange' }));
      }
      return Promise.resolve();
    }
    createGain() { const g = new AudioNode(this, 'gain'); g.gain = new AudioParam(1); env.gains.push(g); return g; }
    createScriptProcessor(size, ins, outs) {
      const p = new AudioNode(this, 'proc'); p.bufferSize = size; p.numIn = ins; p.numOut = outs; p.onaudioprocess = null;
      env.procs.push(p); return p;
    }
    createMediaStreamSource(stream) {
      if (o.sourceThrows && o.sourceThrows(stream)) throw new Error('InvalidStateError');
      const s = new AudioNode(this, 'source'); s.mediaStream = stream; env.sources.push(s); return s;
    }
    createMediaStreamDestination() {
      if (o.destThrows) throw new Error('dest fails');
      const d = new AudioNode(this, 'dest'); d.stream = new MediaStream([new MediaStreamTrack('audio', 'MediaStreamAudioDestinationNode')]);
      env.dests.push(d); return d;
    }
    createBuffer(ch, len, rate) { return { numberOfChannels: ch, length: len, sampleRate: rate, duration: len / rate, data: null, copyToChannel(f) { this.data = f; } }; }
    createBufferSource() {
      const s = new AudioNode(this, 'bufsrc'); s.buffer = null; s.startAt = null; s.stopped = false;
      s.start = (t) => { s.startAt = t; }; s.stop = () => { s.stopped = true; };
      env.bufSources.push(s); return s;
    }
  }
  class Audio {
    constructor() { this.muted = false; this.srcObject = null; this.playCalls = 0; this.paused = true; env.audios.push(this); }
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); }
    pause() { this.paused = true; }
  }
  class RTCPeerConnection extends ET {
    constructor() { super(); this.signalingState = 'stable'; this._recv = []; this.throwGetReceivers = false; }
    setRemoteDescription(d) { if (d && d.throwSync) throw new Error('sync-throw'); return Promise.resolve('srd:' + (d && d.sdp)); }
    addTransceiver(kind) { return { kind, mid: '0' }; }
    addTrack(track) { if (this.signalingState === 'closed') throw new Error('InvalidStateError'); return { track }; }
    getReceivers() { if (this.throwGetReceivers) throw new Error('getReceivers boom'); return this._recv; }
    close() { this.signalingState = 'closed'; for (const r of this._recv) { try { if (r.track) r.track.readyState = 'ended'; } catch (e) { /* bad receiver */ } } }
  }
  class MediaDevices {
    getUserMedia(c) {
      if (!(this instanceof MediaDevices)) return Promise.reject(new TypeError('Illegal invocation'));
      env.gum.push(c);
      if (o.gumReject) return Promise.reject(Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' }));
      const tracks = [];
      if (c && c.audio) tracks.push(new MediaStreamTrack('audio', 'Real Mic'));
      if (c && c.video) tracks.push(new MediaStreamTrack('video', 'Cam'));
      const s = new MediaStream(tracks);
      env.lastReal = s;
      return Promise.resolve(s);
    }
  }
  class Event { constructor(type) { this.type = type; } }

  const winListeners = new Map();
  const sandbox = {
    navigator: { mediaDevices: new MediaDevices() },
    MediaDevices, MediaStream, MediaStreamTrack, AudioContext, Audio, RTCPeerConnection, Event,
    setTimeout: clock.setTimeout, setInterval: clock.setInterval, clearTimeout: clock.clearTimeout, clearInterval: clock.clearInterval,
    btoa, atob, console,
    addEventListener(t, f, opts) { if (!winListeners.has(t)) winListeners.set(t, []); winListeners.get(t).push({ f, opts }); },
    removeEventListener() {},
    postMessage(data, origin) { env.posts.push({ data, origin }); },
  };
  if (o.noAudioContext) delete sandbox.AudioContext;
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'inject.js' });
  const win = vm.runInContext('globalThis', sandbox); // what `window` is inside the context

  Object.assign(env, {
    sandbox, win, MediaStreamTrack, MediaStream, RTCPeerConnection, winListeners,
    send(data) { for (const { f } of (winListeners.get('message') || []).slice()) f({ source: win, data: Object.assign({ source: 'mt-content' }, data) }); },
    sendForeign(data) { for (const { f } of (winListeners.get('message') || []).slice()) f({ source: {}, data }); },
    fire(type) { for (const { f } of (winListeners.get(type) || []).slice()) f({ type }); },
    gUM(c) { return sandbox.navigator.mediaDevices.getUserMedia(c); },
    of(type) { return env.posts.map((p) => p.data).filter((d) => d && d.type === type); },
    last(type) { const a = env.of(type); return a[a.length - 1]; },
    ctx() { return env.ctxs[env.ctxs.length - 1]; },
    audio(n) { const f = new Float32Array(n || 2048); for (let i = 0; i < f.length; i++) f[i] = 0.3 * Math.sin(i / 7); return { inputBuffer: { getChannelData: () => f } }; },
  });
  return env;
}

// Graph lookups (creation order inside inject.js): ctx -> ttsBus gain; per mic session:
// source, micGain, dest, proc, silent gain; remote tap: bus gain, proc, silent gain.
function micSession(env, k) {
  const proc = env.procs.filter((p) => p.bufferSize === 2048)[k];
  const src = env.sources.find((s) => s.outs.has(proc));
  const micGain = [...src.outs].find((n) => n.kind === 'gain');
  return { proc, src, micGain };
}
function remoteTap(env) {
  const bus = env.gains.find((g) => [...g.outs].some((n) => n.kind === 'proc'));
  const proc = bus && [...bus.outs].find((n) => n.kind === 'proc');
  return { bus, proc };
}
const b64len = (b) => Buffer.from(b, 'base64').length;

(async () => {
  await test('getUserMedia returns the VIRTUAL stream even when the context starts suspended', async () => {
    const env = makeEnv({ ctxInitial: 'suspended', allowResume: false });
    const out = await env.gUM({ audio: { echoCancellation: true }, video: false });
    const real = env.lastReal.getAudioTracks()[0];
    const vt = out.getAudioTracks()[0];
    assert.ok(vt, 'has an audio track');
    assert.notEqual(vt, real, 'not the real mic track');
    assert.equal(vt, env.dests[0].stream.getAudioTracks()[0], 'the destination track');
    assert.equal(env.ctx().state, 'suspended');
    assert.equal(env.last('mic-state').state, 'suspended');
    assert.ok(env.resumeCalls >= 1, 'tried to resume at creation');
    const gestureTypes = [...env.winListeners.keys()];
    for (const t of ['pointerdown', 'keydown']) {
      assert.ok(gestureTypes.includes(t), t + ' hooked');
      const { opts } = env.winListeners.get(t)[0];
      assert.equal(opts.capture, true);
      assert.equal(opts.passive, true);
    }
    // first gesture -> resume -> statechange -> mic-state virtual
    env.allowResume = true;
    env.fire('pointerdown');
    await flush();
    assert.equal(env.ctx().state, 'running');
    assert.equal(env.last('mic-state').state, 'virtual');
    const states = env.of('mic-state').map((m) => m.state);
    assert.deepEqual(states, ['suspended', 'virtual']);
  });

  await test('keydown also resumes; start resumes when activation already exists', async () => {
    const env = makeEnv({ ctxInitial: 'suspended', allowResume: false });
    await env.gUM({ audio: true });
    const before = env.resumeCalls;
    env.fire('keydown'); // no activation yet: resume stays pending
    assert.ok(env.resumeCalls > before);
    assert.equal(env.last('mic-state').state, 'suspended');
    env.allowResume = true;
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    await flush();
    assert.equal(env.ctx().state, 'running');
    assert.equal(env.last('mic-state').state, 'virtual');
  });

  await test('device identity spoofing and constraint forwarding', async () => {
    const env = makeEnv();
    const out = await env.gUM({ audio: true, video: true });
    const real = env.lastReal.getAudioTracks()[0];
    const vt = out.getAudioTracks()[0];
    assert.equal(vt.label, 'Real Mic');
    assert.deepEqual({ ...vt.getSettings() }, { deviceId: 'dev-Real Mic', groupId: 'g1' });
    assert.deepEqual({ ...vt.getCapabilities() }, { deviceId: 'dev-Real Mic' });
    assert.deepEqual({ ...vt.getConstraints() }, { echoCancellation: true });
    // forwarded to the real mic and its real outcome reported (the fake real track rejects)
    await assert.rejects(vt.applyConstraints({ autoGainControl: false }), /Overconstrained/);
    assert.deepEqual(real.applied, { autoGainControl: false });
    assert.equal(out.getVideoTracks()[0], env.lastReal.getVideoTracks()[0], 'video passed through');
    assert.equal(env.last('mic-state').state, 'virtual');
  });

  await test('no audio requested -> real stream untouched; errors propagate untouched', async () => {
    const env = makeEnv();
    const out = await env.gUM({ video: true });
    assert.equal(out, env.lastReal);
    assert.equal(env.ctxs.length, 0, 'no AudioContext created');
    const env2 = makeEnv({ gumReject: true });
    await assert.rejects(env2.gUM({ audio: true }), (e) => e.name === 'NotAllowedError');
  });

  await test('getUserMedia is patched on the prototype, length preserved, detached call still works', async () => {
    const env = makeEnv();
    const md = env.sandbox.navigator.mediaDevices;
    assert.equal(Object.prototype.hasOwnProperty.call(md, 'getUserMedia'), false);
    assert.notEqual(env.sandbox.MediaDevices.prototype.getUserMedia.toString().indexOf('wantsAudio'), -1);
    assert.equal(md.getUserMedia.length, 1);
    const detached = md.getUserMedia;
    const out = await detached({ audio: true });
    assert.notEqual(out.getAudioTracks()[0], env.lastReal.getAudioTracks()[0]);
  });

  await test('graph cannot be built (no AudioContext / node failure) -> real stream, real track NOT stopped', async () => {
    const env = makeEnv({ noAudioContext: true });
    const out = await env.gUM({ audio: true });
    assert.equal(out, env.lastReal);
    assert.equal(env.last('mic-state').state, 'none');
    const env2 = makeEnv({ destThrows: true });
    const out2 = await env2.gUM({ audio: true });
    assert.equal(out2, env2.lastReal);
    assert.equal(out2.getAudioTracks()[0].readyState, 'live');
    assert.equal(out2.getAudioTracks()[0].stopCalls, 0);
  });

  await test('virtual track stop() releases the graph + real mic; device loss ends the virtual track', async () => {
    const env = makeEnv();
    const out = await env.gUM({ audio: true });
    const real = env.lastReal.getAudioTracks()[0];
    const vt = out.getAudioTracks()[0];
    const { proc, src } = micSession(env, 0);
    vt.stop();
    assert.equal(vt.readyState, 'ended');
    assert.equal(real.stopCalls, 1);
    assert.equal(proc.onaudioprocess, null);
    assert.ok(src.fullDisconnects >= 1);
    assert.equal(env.last('mic-state').state, 'none');
    // device unplugged
    const out2 = await env.gUM({ audio: true });
    const real2 = env.lastReal.getAudioTracks()[0];
    const vt2 = out2.getAudioTracks()[0];
    let ended = 0;
    vt2.addEventListener('ended', () => ended++);
    real2.readyState = 'ended';
    real2.dispatchEvent({ type: 'ended' });
    assert.equal(ended, 1);
    assert.equal(vt2.readyState, 'ended');
    // sweep: a session whose track ended without stop() is released within 4 s
    const out3 = await env.gUM({ audio: true });
    const vt3 = out3.getAudioTracks()[0];
    const real3 = env.lastReal.getAudioTracks()[0];
    vt3.readyState = 'ended';
    env.clock.advance(4000);
    assert.equal(real3.stopCalls, 1);
  });

  await test('mic gain: active+off -> 0, active+low -> 0.18, inactive -> 1 (short ramps)', async () => {
    const env = makeEnv();
    await env.gUM({ audio: true });
    const { micGain } = micSession(env, 0);
    assert.equal(micGain.gain.value, 1);
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    assert.equal(micGain.gain.target, 0);
    const ev = micGain.gain.events[micGain.gain.events.length - 1];
    assert.ok(ev[0] === 'target' && ev[3] > 0 && ev[3] <= 0.05, 'short time constant');
    env.send({ type: 'stop' });
    assert.equal(micGain.gain.target, 1);
    env.send({ type: 'start', originalVoice: 'low', capture: 'tab' });
    assert.equal(micGain.gain.target, 0.18);
    // a mic acquired during an active session starts at the session gain
    await env.gUM({ audio: true });
    assert.equal(micSession(env, 1).micGain.gain.value, 0.18);
  });

  await test('mic tap: ScriptProcessor 2048, 100 ms chunks only while active, unmuted, newest session', async () => {
    const env = makeEnv();
    await env.gUM({ audio: true });
    const a = micSession(env, 0);
    assert.equal(a.proc.bufferSize, 2048);
    for (let i = 0; i < 10; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.of('mic').length, 0, 'inactive: nothing posted');
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    for (let i = 0; i < 30; i++) a.proc.onaudioprocess(env.audio());
    const mics = env.of('mic');
    assert.equal(mics.length, Math.floor((30 * 2048) / 3 / 1600)); // 12
    for (const m of mics) assert.equal(b64len(m.b64), 3200);
    // a second live mic: only the newest one feeds the STT
    const out2 = await env.gUM({ audio: true });
    const b = micSession(env, 1);
    const n0 = env.of('mic').length;
    for (let i = 0; i < 30; i++) { a.proc.onaudioprocess(env.audio()); b.proc.onaudioprocess(env.audio()); }
    assert.equal(env.of('mic').length - n0, 12, 'no interleaving');
    // Meet mutes the newest -> nothing is sent (an older enabled stream must not transcribe a muted user)
    out2.getAudioTracks()[0].enabled = false;
    const n1 = env.of('mic').length;
    for (let i = 0; i < 30; i++) { a.proc.onaudioprocess(env.audio()); b.proc.onaudioprocess(env.audio()); }
    assert.equal(env.of('mic').length - n1, 0, 'muted newest stream: privacy first');
    // the newest is stopped -> the older live one feeds again
    out2.getAudioTracks()[0].stop();
    const n1b = env.of('mic').length;
    for (let i = 0; i < 30; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.of('mic').length - n1b, 12);
    env.send({ type: 'stop' });
    const n2 = env.of('mic').length;
    for (let i = 0; i < 30; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.of('mic').length, n2, 'stopped: nothing posted');
  });

  await test('clones: graph lives while any clone is live; mute on any live clone stops the tap', async () => {
    const env = makeEnv();
    const out = await env.gUM({ audio: true });
    const real = env.lastReal.getAudioTracks()[0];
    const vt = out.getAudioTracks()[0];
    const a = micSession(env, 0);
    const c = vt.clone();
    assert.equal(c.label, 'Real Mic', 'clone keeps the device identity');
    vt.stop(); // Meet keeps the clone and stops the original
    assert.equal(real.stopCalls, 0, 'real mic still running for the clone');
    assert.notEqual(a.proc.onaudioprocess, null, 'graph kept');
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    for (let i = 0; i < 30; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.of('mic').length, 12, 'clone feeds the STT');
    c.enabled = false; // Meet mutes the clone
    const n = env.of('mic').length;
    for (let i = 0; i < 30; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.of('mic').length, n, 'muted clone: nothing sent');
    // a stream clone (native track clones) is adopted as well
    const out2 = await env.gUM({ audio: true });
    const real2 = env.lastReal.getAudioTracks()[0];
    const copy = out2.clone();
    out2.getAudioTracks()[0].stop();
    assert.equal(real2.stopCalls, 0, 'stream clone keeps the graph alive');
    copy.getAudioTracks()[0].stop();
    assert.equal(real2.stopCalls, 1, 'released when the last clone stops');
    c.stop();
    assert.equal(real.stopCalls, 1, 'released when the last outgoing track stops');
    assert.equal(a.proc.onaudioprocess, null);
  });

  await test('mic-state carries muted; a Meet (un)mute of the feeding mic is posted once per transition', async () => {
    const env = makeEnv();
    const out = await env.gUM({ audio: true });
    const a = micSession(env, 0);
    assert.deepEqual({ ...env.last('mic-state') }, { source: 'mt-page', type: 'mic-state', state: 'virtual', muted: false });
    const n0 = env.of('mic-state').length;
    for (let i = 0; i < 5; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.of('mic-state').length, n0, 'no change: nothing posted');
    out.getAudioTracks()[0].enabled = false; // Meet mutes
    for (let i = 0; i < 5; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.of('mic-state').length, n0 + 1, 'one post per transition (also while inactive)');
    assert.deepEqual([env.last('mic-state').state, env.last('mic-state').muted], ['virtual', true]);
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    assert.equal(env.last('mic-state').muted, true, 'start re-posts the current mute');
    out.getAudioTracks()[0].enabled = true;
    for (let i = 0; i < 5; i++) a.proc.onaudioprocess(env.audio());
    assert.equal(env.last('mic-state').muted, false);
    assert.ok(env.of('mic').length > 0, 'unmuted: chunks flow again');
    // a muted clone counts as muted; stopping everything gives none / not muted
    const c = out.getAudioTracks()[0].clone();
    c.enabled = false;
    a.proc.onaudioprocess(env.audio());
    assert.equal(env.last('mic-state').muted, true);
    c.stop();
    out.getAudioTracks()[0].stop();
    assert.deepEqual([env.last('mic-state').state, env.last('mic-state').muted], ['none', false]);
  });

  await test('voice-passthrough: real voice at full level while on (session only), back to off/low, reset by start/stop', async () => {
    const env = makeEnv();
    await env.gUM({ audio: true });
    const { micGain } = micSession(env, 0);
    env.send({ type: 'voice-passthrough', on: true });
    assert.equal(micGain.gain.target, undefined, 'inactive: ignored (no gain change)');
    env.send({ type: 'start', originalVoice: 'low', capture: 'tab' });
    assert.equal(micGain.gain.target, 0.18);
    env.send({ type: 'voice-passthrough', on: true });
    assert.equal(micGain.gain.target, 1);
    await env.gUM({ audio: true });
    assert.equal(micSession(env, 1).micGain.gain.value, 1, 'a mic acquired during passthrough starts open');
    env.send({ type: 'voice-passthrough', on: false });
    assert.equal(micGain.gain.target, 0.18);
    env.send({ type: 'voice-passthrough', on: true });
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' }); // restart (language switch)
    assert.equal(micGain.gain.target, 0, 'a new session starts muted again');
    env.send({ type: 'voice-passthrough', on: true });
    env.send({ type: 'stop' });
    assert.equal(micGain.gain.target, 1);
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    assert.equal(micGain.gain.target, 0, 'passthrough does not survive a stop');
  });

  await test('RTCPeerConnection: constructor untouched, hooks call originals and register PCs', async () => {
    const env = makeEnv();
    const PC = env.sandbox.RTCPeerConnection;
    assert.equal(PC, env.RTCPeerConnection, 'constructor not replaced');
    for (const n of ['setRemoteDescription', 'addTransceiver', 'addTrack']) {
      assert.equal(PC.prototype[n].name, n);
      assert.equal(PC.prototype[n].length, 1);
    }
    const pc = new PC();
    assert.equal(await pc.setRemoteDescription({ sdp: 'x' }), 'srd:x');
    assert.deepEqual({ ...pc.addTransceiver('audio') }, { kind: 'audio', mid: '0' });
    assert.equal(pc.count('track'), 1, 'one track listener per PC');
    const t = new env.MediaStreamTrack('video', 'v');
    assert.equal(pc.addTrack(t).track, t);
    assert.throws(() => pc.setRemoteDescription({ throwSync: true }), /sync-throw/);
    pc.close();
    assert.throws(() => pc.addTrack(t), /InvalidStateError/);
    const pc2 = new PC();
    assert.throws(() => pc2.setRemoteDescription({ throwSync: true }), /sync-throw/);
    assert.equal(pc2.count('track'), 1, 'registered even when the original threw');
  });

  await test('remote capture: track events + receiver scan, muted detached Audio, never audible', async () => {
    const env = makeEnv();
    const PC = env.sandbox.RTCPeerConnection;
    const pc = new PC();
    pc.addTransceiver('audio');
    const t1 = new env.MediaStreamTrack('audio', 'remote1');
    pc.dispatchEvent({ type: 'track', track: t1 });
    pc.dispatchEvent({ type: 'track', track: new env.MediaStreamTrack('video', 'rv') });
    assert.equal(env.audios.length, 0, 'nothing attached while inactive');
    assert.equal(env.ctxs.length, 0, 'no AudioContext while inactive');
    env.send({ type: 'start', originalVoice: 'off', capture: 'page' });
    assert.equal(env.audios.length, 1);
    const a1 = env.audios[0];
    assert.equal(a1.muted, true);
    assert.equal(a1.playCalls, 1);
    assert.equal(a1.srcObject.getAudioTracks()[0], t1);
    const src1 = env.sources.find((s) => s.mediaStream.getAudioTracks()[0] === t1);
    assert.ok(src1, 'createMediaStreamSource(new MediaStream([track]))');
    const { bus, proc } = remoteTap(env);
    assert.ok(src1.outs.has(bus), 'source -> remoteBus');
    assert.equal(proc.bufferSize, 2048);
    const silent = [...proc.outs][0];
    assert.equal(silent.kind, 'gain');
    assert.equal(silent.gain.value, 0, 'tap output only through a zero gain');
    assert.ok(silent.outs.has(env.ctx().destination));
    assert.ok(!src1.outs.has(env.ctx().destination) && !bus.outs.has(env.ctx().destination), 'no audible path');
    assert.deepEqual({ ...env.last('remote-state') }, { source: 'mt-page', type: 'remote-state', tracks: 1, running: true });
    // receiver scan every 2 s: picks up tracks without a track event and survives bad receivers / PCs
    const pc2 = new PC();
    pc2.setRemoteDescription({ sdp: 'y' });
    const t2 = new env.MediaStreamTrack('audio', 'remote2');
    pc2._recv = [
      { get track() { throw new Error('bad receiver'); } },
      null,
      { track: new env.MediaStreamTrack('video', 'vid') },
      { track: t2 },
    ];
    const pc3 = new PC();
    pc3.addTrack(new env.MediaStreamTrack('audio', 'local'));
    pc3.throwGetReceivers = true;
    env.clock.advance(2000);
    assert.equal(env.audios.length, 2);
    assert.equal(env.audios[1].srcObject.getAudioTracks()[0], t2);
    assert.equal(env.last('remote-state').tracks, 2);
    env.clock.advance(2000); // rescan: no duplicates
    assert.equal(env.audios.length, 2);
  });

  await test('remote tap posts 100 ms PCM chunks only while active + page + tracks', async () => {
    const env = makeEnv();
    const PC = env.sandbox.RTCPeerConnection;
    const pc = new PC();
    pc.setRemoteDescription({});
    env.send({ type: 'start', originalVoice: 'off', capture: 'page' });
    const { proc } = remoteTap(env);
    for (let i = 0; i < 30; i++) proc.onaudioprocess(env.audio());
    assert.equal(env.of('remote').length, 0, 'no tracks: no silence spam');
    const t = new env.MediaStreamTrack('audio', 'r');
    pc.dispatchEvent({ type: 'track', track: t });
    for (let i = 0; i < 30; i++) proc.onaudioprocess(env.audio());
    const rs = env.of('remote');
    assert.equal(rs.length, 12);
    for (const r of rs) assert.equal(b64len(r.b64), 3200);
    const handler = proc.onaudioprocess;
    env.send({ type: 'stop' });
    assert.equal(proc.onaudioprocess, null);
    assert.ok(proc.fullDisconnects >= 1);
    for (let i = 0; i < 30; i++) handler(env.audio()); // a late callback after stop
    assert.equal(env.of('remote').length, 12);
    assert.equal(env.audios[0].paused, true);
    assert.equal(env.audios[0].srcObject, null);
    assert.equal(env.clock.size, 0, 'no timers left (scan stopped, no mic sessions)');
    // tab mode: no remote tap at all
    const procsBefore = env.procs.length;
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    assert.equal(env.procs.length, procsBefore);
    assert.equal(env.audios.filter((a) => !a.paused).length, 0);
    assert.equal(env.last('remote-state').running, false);
    // switching to page on a restart re-attaches the known track
    env.send({ type: 'start', originalVoice: 'off', capture: 'page' });
    assert.equal(env.audios.filter((a) => !a.paused).length, 1);
  });

  await test('remote track ending: event or silent end (pc.close) detaches and updates remote-state', async () => {
    const env = makeEnv();
    const PC = env.sandbox.RTCPeerConnection;
    const pc = new PC();
    pc.addTransceiver('audio');
    const t1 = new env.MediaStreamTrack('audio', 'r1');
    const t2 = new env.MediaStreamTrack('audio', 'r2');
    pc._recv = [{ track: t1 }, { track: t2 }];
    env.send({ type: 'start', originalVoice: 'off', capture: 'page' });
    assert.equal(env.last('remote-state').tracks, 2);
    t1.readyState = 'ended';
    t1.dispatchEvent({ type: 'ended' });
    assert.equal(env.last('remote-state').tracks, 1);
    const s1 = env.sources.find((s) => s.mediaStream.getAudioTracks()[0] === t1);
    assert.equal(s1.outs.size, 0, 'source disconnected');
    assert.equal(t1.count('ended'), 0, 'listener removed');
    pc.close(); // t2 ends without an event
    env.clock.advance(2000);
    assert.equal(env.last('remote-state').tracks, 0);
    // a source creation failure is contained
    const env2 = makeEnv({ sourceThrows: (s) => s.getAudioTracks()[0].label === 'bad' });
    const pcb = new env2.sandbox.RTCPeerConnection();
    pcb.addTransceiver('audio');
    env2.send({ type: 'start', originalVoice: 'off', capture: 'page' });
    pcb.dispatchEvent({ type: 'track', track: new env2.MediaStreamTrack('audio', 'bad') });
    pcb.dispatchEvent({ type: 'track', track: new env2.MediaStreamTrack('audio', 'good') });
    assert.equal(env2.last('remote-state').tracks, 1);
    assert.equal(env2.audios[0].paused, true, 'the failed one released its media element');
  });

  await test('remote-state reports running=false while suspended and true after the gesture', async () => {
    const env = makeEnv({ ctxInitial: 'suspended', allowResume: false });
    const pc = new env.sandbox.RTCPeerConnection();
    pc.addTransceiver('audio');
    pc.dispatchEvent({ type: 'track', track: new env.MediaStreamTrack('audio', 'r') });
    env.send({ type: 'start', originalVoice: 'off', capture: 'page' });
    assert.deepEqual([env.last('remote-state').tracks, env.last('remote-state').running], [1, false]);
    assert.equal(env.last('mic-state').state, 'none', 'no mic yet');
    env.allowResume = true;
    env.fire('pointerdown');
    await flush();
    assert.equal(env.last('remote-state').running, true);
  });

  await test('TTS: gapless 24 kHz scheduling into the virtual mic, cleared on stop, ignored when inactive', async () => {
    const env = makeEnv();
    const out = await env.gUM({ audio: true });
    const pcm = Buffer.alloc(9600); // 200 ms at 24 kHz
    env.send({ type: 'tts-chunk', id: 1, b64: pcm.toString('base64') });
    assert.equal(env.bufSources.length, 0, 'inactive: ignored');
    env.send({ type: 'start', originalVoice: 'off', capture: 'tab' });
    env.send({ type: 'tts-chunk', id: 1, b64: pcm.toString('base64') });
    env.send({ type: 'tts-chunk', id: 1, b64: pcm.toString('base64') });
    env.send({ type: 'tts-end', id: 1 });
    const [s1, s2] = env.bufSources;
    assert.equal(s1.buffer.sampleRate, 24000);
    assert.equal(s1.buffer.length, 4800);
    assert.ok(Math.abs(s1.startAt - (1.5 + 0.08)) < 1e-9);
    assert.ok(Math.abs(s2.startAt - (s1.startAt + 0.2)) < 1e-9, 'back-to-back');
    const ttsBus = env.gains[0];
    assert.ok(s1.outs.has(ttsBus));
    assert.ok(ttsBus.outs.has(env.dests[0]), 'ttsBus feeds the virtual mic');
    assert.ok(!ttsBus.outs.has(env.ctx().destination), 'not audible locally');
    env.send({ type: 'stop' });
    assert.ok(s1.stopped && s2.stopped);
    assert.ok(out);
  });

  await test('foreign / malformed window messages are ignored and never throw', async () => {
    const env = makeEnv();
    env.sendForeign({ source: 'mt-content', type: 'start', capture: 'page' }); // wrong event.source
    assert.equal(env.ctxs.length, 0);
    for (const { f } of env.winListeners.get('message')) {
      f({ source: env.win, data: null });
      f({ source: env.win, data: 'x' });
      f({ source: env.win, data: { source: 'mt-content', type: 'tts-chunk', b64: 42 } });
      f({ source: env.win, data: { source: 'mt-content', type: 'tts-chunk', b64: '@@@' } });
      f(null);
    }
    assert.equal(env.ctxs.length, 0);
  });

  console.log(`\n${passed} tests passed` + (failed ? `, ${failed} FAILED` : ''));
  if (failed) process.exit(1);
})();
