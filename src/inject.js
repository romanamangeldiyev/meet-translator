/*
 * Meet Canlı Çeviri - page side (MAIN world, document_start). Contract v2.
 *
 * - Virtual microphone: getUserMedia is wrapped so Meet receives the track of a
 *   MediaStreamAudioDestinationNode instead of the real mic. Outside a session it
 *   carries the real mic; during a session it carries the translated speech (plus
 *   my real voice at a low level when originalVoice is 'low'). The virtual stream
 *   is returned whenever audio was requested, even while the AudioContext is
 *   still suspended by the autoplay policy (never a silent fallback to the real
 *   mic, which would make outgoing translation impossible for the whole call):
 *   the context is resumed on the first user gesture and on start, and the state
 *   is reported as mic-state 'suspended' / 'virtual' / 'none', with `muted` (Meet's mute
 *   of the feeding mic, re-posted on every mute/unmute transition). 'voice-passthrough'
 *   from content.js lets my real voice through at full level while translation is
 *   temporarily impossible (session only; reset by start / stop).
 * - Mic tap: my real mic -> 16 kHz PCM16, 100 ms chunks -> content.js ('mic').
 * - Remote tap (capture 'page'): remote audio tracks learned through
 *   RTCPeerConnection prototype hooks (the constructor is never replaced) are
 *   mixed and tapped -> 16 kHz PCM16 -> content.js ('remote'). Never audible.
 * - TTS: gapless scheduling of 24 kHz PCM16 chunks into the virtual mic.
 *
 * Self-contained and CSP-safe (no workers, no blobs, no eval). Nothing here may
 * throw into Meet: hooks call the originals untouched and swallow their own errors.
 */
(() => {
  'use strict';
  if (window.__mtInject) return;
  window.__mtInject = true;

  // <pure-helpers>
  const TARGET_RATE = 16000;

  function clamp16(x) {
    x = x < -1 ? -1 : x > 1 ? 1 : x;
    return x < 0 ? Math.round(x * 32768) : Math.round(x * 32767);
  }

  // Streaming downsampler to 16 kHz mono PCM16 with fixed-size output chunks.
  // Each output sample is the exact area-average of the `ratio` input samples it
  // covers (box filter, a proper anti-aliasing low-pass for speech); fractional
  // ratios such as 44.1k/16k are handled by weighting and the state carries
  // across calls, so any callback size (2048 frames here) gives a seamless stream.
  class PcmEncoder {
    constructor(inRate, onChunk, chunkSamples) {
      this.ratio = inRate / TARGET_RATE;
      this.onChunk = onChunk;
      this.size = chunkSamples || 1600; // 100 ms at 16 kHz
      this.buf = new Int16Array(this.size);
      this.n = 0;
      this.acc = 0;
      this.filled = 0;
    }
    reset() {
      this.n = 0;
      this.acc = 0;
      this.filled = 0;
    }
    push(input) {
      const ratio = this.ratio;
      for (let i = 0; i < input.length; i++) {
        const x = input[i];
        let w = 1;
        while (w > 1e-9) {
          const room = ratio - this.filled;
          if (w < room) {
            this.acc += x * w;
            this.filled += w;
            w = 0;
          } else {
            this.acc += x * room;
            w -= room;
            this._emit(this.acc / ratio);
            this.acc = 0;
            this.filled = 0;
          }
        }
      }
    }
    _emit(v) {
      this.buf[this.n++] = clamp16(v);
      if (this.n === this.size) {
        this.onChunk(this.buf.slice());
        this.n = 0;
      }
    }
  }

  function bytesToBase64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }

  // Int16Array -> base64 of little-endian bytes
  function pcm16ToBase64(int16) {
    const bytes = new Uint8Array(int16.length * 2);
    const dv = new DataView(bytes.buffer);
    for (let i = 0; i < int16.length; i++) dv.setInt16(i * 2, int16[i], true);
    return bytesToBase64(bytes);
  }

  // base64 of little-endian PCM16 -> Float32Array in [-1, 1) (odd trailing byte dropped)
  function base64ToFloat32(b64) {
    const bin = atob(b64);
    const n = bin.length >> 1;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
      if (v >= 0x8000) v -= 0x10000;
      out[i] = v / 32768;
    }
    return out;
  }
  // </pure-helpers>

  const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz
  const PROC_FRAMES = 2048; // ScriptProcessor buffer (lower latency than 4096)
  const TTS_RATE = 24000;
  const TTS_LEAD = 0.08; // seconds of head start for the first chunk / after an underrun
  const LOW_VOICE_GAIN = 0.18; // originalVoice 'low'
  const RAMP_TC = 0.015; // gain ramp time constant (s)
  const SCAN_MS = 2000; // remote receiver scan
  const SWEEP_MS = 4000; // virtual mic safety sweep
  const GESTURES = ['pointerdown', 'keydown', 'pointerup', 'touchend'];

  // Captured at document_start so later page patches cannot interfere.
  const winPost = window.postMessage;
  const MS = window.MediaStream;
  const AudioEl = window.Audio;
  const WR = typeof WeakRef === 'function' ? WeakRef : null;

  let active = false; // translation session on/off (set by content.js)
  let passthrough = false; // engine says translation is temporarily impossible: my real voice goes out (active only)
  let opts = { originalVoice: 'off', capture: 'page' };
  let ctx = null;
  let ttsBus = null;
  let nextTime = 0;
  const playing = new Set(); // scheduled TTS sources
  const sessions = new Set(); // one per wrapped getUserMedia call (oldest first)
  let sweepTimer = 0;
  let gestureHooked = false;
  let lastMicKey = null; // state + muted of the last mic-state post
  let lastMuted = false; // muted flag of the last mic-state post

  // Remote meeting audio
  const pcRefs = new Set(); // WeakRef<RTCPeerConnection> (or a plain holder without WeakRef)
  const pcSeen = new WeakSet();
  const remoteTracks = new Map(); // MediaStreamTrack -> { track, onEnded, src, el }
  let remote = null; // { bus, proc, silent, enc } while the tap exists
  let scanTimer = 0;
  let lastRemoteKey = '';

  function post(msg) {
    try {
      winPost.call(window, Object.assign({ source: 'mt-page' }, msg), '*');
    } catch (e) {
      /* ignore */
    }
  }

  function wantsAudio(constraints) {
    return !!constraints && constraints.audio !== undefined && constraints.audio !== false && constraints.audio !== null;
  }

  // ---- audio context -------------------------------------------------------------------------

  function ctxRunning() {
    try {
      return !!ctx && ctx.state === 'running';
    } catch (e) {
      return false;
    }
  }

  function micStateNow() {
    if (!sessions.size) return 'none';
    return ctxRunning() ? 'virtual' : 'suspended';
  }

  // Meet's mute of the feeding virtual mic (see isFeeder / unmuted below); false without a mic.
  function micMutedNow() {
    let pick = null;
    for (const x of sessions) {
      if (liveOutTracks(x).length) pick = x;
    }
    return !!pick && !unmuted(pick);
  }

  // mic-state carries `muted` on every post; a mute/unmute transition alone is a change too.
  function postMicState(force) {
    const st = micStateNow();
    const muted = st !== 'none' && micMutedNow();
    const key = st + ':' + muted;
    if (!force && key === lastMicKey) return;
    lastMicKey = key;
    lastMuted = muted;
    post({ type: 'mic-state', state: st, muted });
  }

  function onCtxState() {
    try {
      postMicState(false);
      reportRemote(false);
    } catch (e) {
      /* ignore */
    }
  }

  function resumeCtx() {
    try {
      if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') {
        const p = ctx.resume();
        if (p && typeof p.then === 'function') p.then(onCtxState, () => {});
      }
    } catch (e) {
      /* ignore */
    }
  }

  // Autoplay policy: a context created before any user gesture starts suspended.
  // Resume it on the first gesture anywhere in the page (capture phase, passive,
  // never stops or prevents the event).
  function hookGestures() {
    if (gestureHooked) return;
    gestureHooked = true;
    const h = () => {
      if (ctx && !ctxRunning()) resumeCtx();
    };
    for (const t of GESTURES) {
      try {
        window.addEventListener(t, h, { capture: true, passive: true });
      } catch (e) {
        /* ignore */
      }
    }
  }

  function getCtx() {
    if (ctx && ctx.state !== 'closed') return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    let c;
    try {
      c = new AC({ latencyHint: 'interactive' });
    } catch (e) {
      return null;
    }
    if (remote) remoteTapOff(); // nodes of a closed context are useless
    ctx = c;
    ttsBus = c.createGain();
    ttsBus.gain.value = 1;
    nextTime = 0;
    playing.clear();
    try {
      c.addEventListener('statechange', onCtxState);
    } catch (e) {
      /* ignore */
    }
    hookGestures();
    if (c.state !== 'running') resumeCtx();
    return c;
  }

  // ---- virtual microphone --------------------------------------------------------------------

  function micTarget() {
    if (!active || passthrough) return 1;
    return opts.originalVoice === 'low' ? LOW_VOICE_GAIN : 0;
  }

  function applyMicGain(s) {
    const target = micTarget();
    try {
      const g = s.micGain.gain;
      const t = s.micGain.context.currentTime;
      if (typeof g.cancelScheduledValues === 'function') g.cancelScheduledValues(t);
      g.setTargetAtTime(target, t, RAMP_TC);
    } catch (e) {
      try {
        s.micGain.gain.value = target;
      } catch (e2) {
        /* ignore */
      }
    }
  }

  // Releases our audio graph. Never touches the real track (see dispose).
  function teardownGraph(s) {
    try {
      if (s.proc) s.proc.onaudioprocess = null;
    } catch (e) {
      /* ignore */
    }
    for (const n of [s.src, s.micGain, s.proc, s.silent]) {
      try {
        if (n) n.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    try {
      if (ttsBus && s.dest) ttsBus.disconnect(s.dest);
    } catch (e) {
      /* ignore */
    }
  }

  function dispose(s) {
    if (s.disposed) return;
    s.disposed = true;
    sessions.delete(s);
    teardownGraph(s);
    try {
      s.realTrack.removeEventListener('ended', s.onRealEnded);
    } catch (e) {
      /* ignore */
    }
    try {
      s.realTrack.stop();
    } catch (e) {
      /* ignore */
    }
    if (!sessions.size && sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = 0;
    }
    postMicState(false);
  }

  // Safety net for sessions whose outgoing tracks all ended without calling our stop().
  function sweep() {
    for (const s of Array.from(sessions)) {
      try {
        if (!liveOutTracks(s).length) dispose(s);
      } catch (e) {
        /* ignore */
      }
    }
  }

  // ---- outgoing tracks: the virtual track plus any clones Meet makes of it ----------------------
  // The graph must live as long as ANY of them is live (Meet may clone the track and stop the
  // original); "muted" means any live one is disabled (privacy first: never transcribe a muted user).

  const nativeStops = new WeakMap(); // outgoing track -> its native stop()

  function liveOutTracks(s) {
    const out = [];
    for (const t of [s.track].concat(s.clones ? Array.from(s.clones) : [])) {
      try {
        if (t && t.readyState === 'live') out.push(t);
      } catch (e) {
        /* ignore */
      }
    }
    return out;
  }

  function unmuted(s) {
    const live = liveOutTracks(s);
    if (!live.length) return false;
    for (const t of live) {
      try {
        if (!t.enabled) return false;
      } catch (e) {
        return false;
      }
    }
    return true;
  }

  function releaseIfUnused(s) {
    if (!s.disposed && !liveOutTracks(s).length) dispose(s);
  }

  function spoofIdentity(t, realTrack) {
    try {
      const label = realTrack.label;
      Object.defineProperty(t, 'label', { get: () => label, configurable: true });
      t.getSettings = () => {
        try {
          return realTrack.getSettings();
        } catch (e) {
          return {};
        }
      };
      t.getCapabilities = () => {
        try {
          return realTrack.getCapabilities();
        } catch (e) {
          return {};
        }
      };
      t.getConstraints = () => {
        try {
          return realTrack.getConstraints();
        } catch (e) {
          return {};
        }
      };
      // Forward to the real mic and report its real outcome, exactly as without the extension.
      t.applyConstraints = (cons) => {
        try {
          return Promise.resolve(realTrack.applyConstraints(cons));
        } catch (e) {
          return Promise.reject(e);
        }
      };
    } catch (e) {
      /* ignore */
    }
  }

  // stop() releases the graph (and the real mic) once no outgoing track is live; clone() registers
  // the clone with the same session; device identity mirrors the real mic.
  function hookOutTrack(s, t) {
    try {
      const nativeStop = t.stop.bind(t);
      nativeStops.set(t, nativeStop);
      t.stop = function stop() {
        try {
          nativeStop();
        } finally {
          if (t !== s.track) s.clones.delete(t);
          releaseIfUnused(s);
        }
      };
    } catch (e) {
      /* ignore */
    }
    try {
      if (typeof t.clone === 'function') {
        const nativeClone = t.clone.bind(t);
        t.clone = function clone() {
          const c = nativeClone();
          adoptClone(s, c);
          return c;
        };
      }
    } catch (e) {
      /* ignore */
    }
    spoofIdentity(t, s.realTrack);
  }

  function adoptClone(s, c) {
    try {
      if (s.disposed || !c || s.clones.has(c) || c === s.track) return;
      s.clones.add(c);
      hookOutTrack(s, c);
    } catch (e) {
      /* ignore */
    }
  }

  // Only one virtual mic feeds the STT: the newest one with a live outgoing track (two live
  // getUserMedia streams must not interleave chunks). If that one is muted, nothing is sent: an
  // older, still enabled stream must not keep transcribing a user who muted.
  function isFeeder(s) {
    let pick = null;
    for (const x of sessions) {
      if (liveOutTracks(x).length) pick = x;
    }
    return pick === s;
  }

  function wrapStream(real) {
    const c = getCtx();
    if (!c) return null;
    const realTrack = real.getAudioTracks()[0];
    if (!realTrack) return null;

    const s = { disposed: false, realTrack, track: null, enc: null, sending: false };
    try {
      s.src = c.createMediaStreamSource(new MS([realTrack]));
      s.micGain = c.createGain();
      s.micGain.gain.value = micTarget();
      s.dest = c.createMediaStreamDestination();
      s.proc = c.createScriptProcessor(PROC_FRAMES, 1, 1);
      s.silent = c.createGain();
      s.silent.gain.value = 0;

      s.src.connect(s.micGain);
      s.micGain.connect(s.dest);
      s.src.connect(s.proc); // the STT tap always gets my full voice (pre-gain)
      s.proc.connect(s.silent);
      s.silent.connect(c.destination); // ScriptProcessor only runs while connected; gain 0 = inaudible
      ttsBus.connect(s.dest);

      s.track = s.dest.stream.getAudioTracks()[0];
      if (!s.track) throw new Error('no destination track');

      s.enc = new PcmEncoder(c.sampleRate, (chunk) => post({ type: 'mic', b64: pcm16ToBase64(chunk) }), CHUNK_SAMPLES);
      s.proc.onaudioprocess = (e) => {
        try {
          // Respect Meet's mute (track.enabled on every live outgoing track), the session flag and the feeder choice.
          const feeder = !s.disposed && isFeeder(s);
          const open = feeder && unmuted(s);
          if (feeder && !open !== lastMuted) postMicState(false); // Meet (un)muted: report the transition once
          const ok = active && open;
          if (!ok) {
            if (s.sending) {
              s.enc.reset();
              s.sending = false;
            }
            return;
          }
          s.sending = true;
          s.enc.push(e.inputBuffer.getChannelData(0));
        } catch (err) {
          /* never throw out of the audio callback */
        }
      };
    } catch (e) {
      // Leave the real track alive: the caller hands Meet the untouched real stream.
      s.disposed = true;
      teardownGraph(s);
      return null;
    }

    // Meet calls track.stop() when leaving / switching devices; stop() fires no 'ended' event, so
    // hook it (and clone()) to release the graph and the real mic once nothing outgoing is live.
    s.clones = new Set();
    hookOutTrack(s, s.track);
    // If the real device disappears, end the outgoing tracks the way a real one would.
    s.onRealEnded = () => {
      if (s.disposed) return;
      const outs = [s.track].concat(Array.from(s.clones));
      for (const t of outs) {
        try {
          const ns = nativeStops.get(t);
          if (ns) ns();
        } catch (e) {
          /* ignore */
        }
      }
      dispose(s);
      for (const t of outs) {
        try {
          t.dispatchEvent(new Event('ended'));
        } catch (e) {
          /* ignore */
        }
      }
    };
    try {
      realTrack.addEventListener('ended', s.onRealEnded);
    } catch (e) {
      /* ignore */
    }

    sessions.add(s);
    if (!sweepTimer) sweepTimer = setInterval(sweep, SWEEP_MS);

    const out = new MS([s.track]);
    for (const v of real.getVideoTracks()) out.addTrack(v);
    // MediaStream.clone() clones tracks natively (not through track.clone()): adopt those clones too.
    try {
      if (typeof out.clone === 'function') {
        const nativeStreamClone = out.clone.bind(out);
        out.clone = function clone() {
          const copy = nativeStreamClone();
          try {
            for (const t of copy.getAudioTracks()) adoptClone(s, t);
          } catch (e) {
            /* ignore */
          }
          return copy;
        };
      }
    } catch (e) {
      /* ignore */
    }
    return out;
  }

  function install() {
    const md = navigator.mediaDevices;
    if (!md) return;
    // Patch where the method actually resolves: an own property on the instance
    // (another script got there first; we chain onto it) or the prototype.
    const MD = window.MediaDevices;
    const proto = MD && MD.prototype && typeof MD.prototype.getUserMedia === 'function' ? MD.prototype : null;
    const target = Object.prototype.hasOwnProperty.call(md, 'getUserMedia') || !proto ? md : proto;
    const orig = target.getUserMedia;
    if (typeof orig !== 'function') return;
    const wrapped = function getUserMedia(constraints) {
      // Real errors (permission denied, no device) propagate untouched.
      return orig.apply(this === undefined ? md : this, arguments).then((real) => {
        try {
          if (!wantsAudio(constraints) || !real || !real.getAudioTracks().length) return real;
          const virtual = wrapStream(real);
          postMicState(true); // 'virtual', or 'suspended' until the first gesture / start
          return virtual || real; // the real stream only when no graph could be built at all
        } catch (e) {
          return real;
        }
      });
    };
    try {
      Object.defineProperty(wrapped, 'length', { value: orig.length });
    } catch (e) {
      /* ignore */
    }
    try {
      target.getUserMedia = wrapped;
    } catch (e) {
      /* ignore */
    }
  }

  // ---- remote meeting audio (capture 'page') --------------------------------------------------

  function tapWanted() {
    return active && opts.capture === 'page';
  }

  function makeRef(o) {
    return WR ? new WR(o) : { deref: () => o };
  }

  function onPcTrack(ev) {
    try {
      const t = ev && ev.track;
      if (t && t.kind === 'audio') addRemoteTrack(t);
    } catch (e) {
      /* ignore */
    }
  }

  function registerPc(pc) {
    if (!pc || typeof pc !== 'object' || pcSeen.has(pc)) return;
    pcSeen.add(pc);
    pcRefs.add(makeRef(pc));
    try {
      pc.addEventListener('track', onPcTrack);
    } catch (e) {
      /* ignore */
    }
  }

  // Learn every RTCPeerConnection without replacing the constructor: wrap three
  // prototype methods; each calls the original first (same this, arguments,
  // return value and exceptions) and then registers `this`.
  function hookPeerConnections() {
    const PC = window.RTCPeerConnection;
    const proto = PC && PC.prototype;
    if (!proto) return;
    for (const name of ['setRemoteDescription', 'addTransceiver', 'addTrack']) {
      const orig = proto[name];
      if (typeof orig !== 'function') continue;
      const wrapped = function () {
        try {
          return orig.apply(this, arguments);
        } finally {
          try {
            registerPc(this);
          } catch (e) {
            /* ignore */
          }
        }
      };
      try {
        Object.defineProperty(wrapped, 'name', { value: name });
        Object.defineProperty(wrapped, 'length', { value: orig.length });
      } catch (e) {
        /* ignore */
      }
      try {
        proto[name] = wrapped;
      } catch (e) {
        /* ignore */
      }
    }
  }

  function trackLive(t) {
    try {
      return t.readyState === 'live';
    } catch (e) {
      return false;
    }
  }

  function addRemoteTrack(t) {
    if (remoteTracks.has(t) || !trackLive(t)) return;
    const e = { track: t, onEnded: null, src: null, el: null };
    e.onEnded = () => removeRemoteTrack(t);
    try {
      t.addEventListener('ended', e.onEnded);
    } catch (err) {
      /* ignore */
    }
    remoteTracks.set(t, e);
    pruneRemote();
    if (remote && tapWanted()) attachRemote(e);
    reportRemote(false);
  }

  function attachRemote(e) {
    if (e.src || !remote || !ctx) return;
    try {
      const stream = new MS([e.track]);
      // Chrome delivers silence for remote WebRTC audio in Web Audio unless the
      // stream is also attached to a media element: a muted, detached one.
      try {
        const el = new AudioEl();
        el.muted = true;
        el.srcObject = stream;
        const p = el.play();
        if (p && typeof p.catch === 'function') p.catch(() => {});
        e.el = el;
      } catch (err) {
        /* ignore */
      }
      e.src = ctx.createMediaStreamSource(stream);
      e.src.connect(remote.bus);
    } catch (err) {
      detachRemote(e);
    }
  }

  function detachRemote(e) {
    if (e.src) {
      try {
        e.src.disconnect();
      } catch (err) {
        /* ignore */
      }
      e.src = null;
    }
    if (e.el) {
      try {
        e.el.pause();
      } catch (err) {
        /* ignore */
      }
      try {
        e.el.srcObject = null;
      } catch (err) {
        /* ignore */
      }
      e.el = null;
    }
  }

  function removeRemoteTrack(t) {
    const e = remoteTracks.get(t);
    if (!e) return;
    remoteTracks.delete(t);
    detachRemote(e);
    try {
      t.removeEventListener('ended', e.onEnded);
    } catch (err) {
      /* ignore */
    }
    reportRemote(false);
  }

  // Remote tracks can end without an 'ended' event (e.g. pc.close()).
  function pruneRemote() {
    for (const t of Array.from(remoteTracks.keys())) {
      if (!trackLive(t)) removeRemoteTrack(t);
    }
  }

  function scanPcs() {
    for (const ref of Array.from(pcRefs)) {
      let pc = null;
      try {
        pc = ref.deref();
      } catch (e) {
        /* ignore */
      }
      if (!pc) {
        pcRefs.delete(ref);
        continue;
      }
      let closed = false;
      try {
        closed = pc.signalingState === 'closed';
      } catch (e) {
        /* ignore */
      }
      if (closed) {
        pcRefs.delete(ref);
        continue;
      }
      let list = [];
      try {
        list = Array.from(pc.getReceivers() || []);
      } catch (e) {
        continue;
      }
      for (const r of list) {
        try {
          const t = r && r.track;
          if (t && t.kind === 'audio' && trackLive(t)) addRemoteTrack(t);
        } catch (e) {
          /* a misbehaving receiver must not stop the scan */
        }
      }
    }
    pruneRemote();
    reportRemote(false);
  }

  function attachedCount() {
    let n = 0;
    for (const e of remoteTracks.values()) if (e.src) n++;
    return n;
  }

  function remoteTapOn() {
    const c = getCtx();
    if (!c) return;
    if (!remote) {
      let r = null;
      try {
        r = { bus: c.createGain(), proc: c.createScriptProcessor(PROC_FRAMES, 1, 1), silent: c.createGain(), enc: null };
        r.bus.gain.value = 1;
        r.silent.gain.value = 0; // the tap's output is never audible (no double playback)
        r.bus.connect(r.proc);
        r.proc.connect(r.silent);
        r.silent.connect(c.destination); // ScriptProcessor only runs while connected
        r.enc = new PcmEncoder(c.sampleRate, (chunk) => {
          if (tapWanted()) post({ type: 'remote', b64: pcm16ToBase64(chunk) });
        }, CHUNK_SAMPLES);
        const enc = r.enc;
        r.proc.onaudioprocess = (ev) => {
          try {
            if (!tapWanted() || !attachedCount()) {
              enc.reset();
              return;
            }
            enc.push(ev.inputBuffer.getChannelData(0));
          } catch (err) {
            /* never throw out of the audio callback */
          }
        };
        remote = r;
      } catch (e) {
        if (r) {
          for (const n of [r.bus, r.proc, r.silent]) {
            try {
              if (n) n.disconnect();
            } catch (err) {
              /* ignore */
            }
          }
        }
        return;
      }
    }
    scanPcs();
    for (const e of remoteTracks.values()) attachRemote(e);
    if (!scanTimer) {
      scanTimer = setInterval(() => {
        try {
          scanPcs();
        } catch (e) {
          /* ignore */
        }
      }, SCAN_MS);
    }
    resumeCtx();
  }

  function remoteTapOff() {
    if (scanTimer) {
      clearInterval(scanTimer);
      scanTimer = 0;
    }
    for (const e of remoteTracks.values()) detachRemote(e);
    if (remote) {
      const r = remote;
      remote = null;
      try {
        r.proc.onaudioprocess = null;
      } catch (e) {
        /* ignore */
      }
      for (const n of [r.bus, r.proc, r.silent]) {
        try {
          n.disconnect();
        } catch (e) {
          /* ignore */
        }
      }
    }
  }

  // tracks = remote audio tracks feeding the tap (while it runs) or known live ones.
  function reportRemote(force) {
    let tracks = 0;
    if (remote && tapWanted()) {
      tracks = attachedCount();
    } else {
      for (const t of remoteTracks.keys()) if (trackLive(t)) tracks++;
    }
    const running = !!(remote && tapWanted() && ctxRunning());
    const key = tracks + ':' + running;
    if (!force && key === lastRemoteKey) return;
    lastRemoteKey = key;
    post({ type: 'remote-state', tracks, running });
  }

  // ---- TTS playback ---------------------------------------------------------------------------

  function playTts(b64) {
    if (!ctx || !ttsBus || !active || typeof b64 !== 'string') return;
    resumeCtx();
    const f = base64ToFloat32(b64);
    if (!f.length) return;
    const buf = ctx.createBuffer(1, f.length, TTS_RATE);
    buf.copyToChannel(f, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ttsBus);
    const now = ctx.currentTime;
    if (nextTime < now + 0.01) nextTime = now + TTS_LEAD; // first chunk or underrun
    src.start(nextTime);
    nextTime += buf.duration;
    playing.add(src);
    src.onended = () => {
      playing.delete(src);
      try {
        src.disconnect();
      } catch (e) {
        /* ignore */
      }
    };
  }

  function clearTts() {
    for (const src of Array.from(playing)) {
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch (e) {
        /* ignore */
      }
    }
    playing.clear();
    nextTime = 0;
  }

  // ---- session control ------------------------------------------------------------------------

  function onStart(d) {
    opts = {
      originalVoice: d.originalVoice === 'low' ? 'low' : 'off',
      capture: d.capture === 'tab' ? 'tab' : 'page',
    };
    if (!active) clearTts();
    active = true;
    passthrough = false; // a new engine reports its own state
    for (const s of sessions) applyMicGain(s);
    resumeCtx();
    if (opts.capture === 'page') remoteTapOn();
    else remoteTapOff();
    postMicState(true);
    reportRemote(true);
  }

  function onStop() {
    active = false;
    passthrough = false;
    for (const s of sessions) applyMicGain(s);
    clearTts();
    remoteTapOff();
    reportRemote(true);
  }

  // Translation temporarily impossible: let my real voice through at full level until the engine
  // says otherwise. Only during a session (outside one the real voice already goes out unchanged).
  function onPassthrough(d) {
    if (!active) return;
    const on = d.on === true;
    if (on === passthrough) return;
    passthrough = on;
    for (const s of sessions) applyMicGain(s);
  }

  window.addEventListener('message', (ev) => {
    try {
      if (ev.source !== window) return;
      const d = ev.data;
      if (!d || typeof d !== 'object' || d.source !== 'mt-content') return;
      switch (d.type) {
        case 'start': onStart(d); break;
        case 'stop': onStop(); break;
        case 'voice-passthrough': onPassthrough(d); break;
        case 'tts-chunk': playTts(d.b64); break;
        case 'tts-end': break; // chunks are already queued back-to-back
        case 'tts-clear': clearTts(); break; // restart: speech queued by the previous session
        default: break;
      }
    } catch (e) {
      /* never break the page */
    }
  });

  try {
    install();
  } catch (e) {
    /* leave Meet untouched */
  }
  try {
    hookPeerConnections();
  } catch (e) {
    /* leave Meet untouched */
  }
})();
