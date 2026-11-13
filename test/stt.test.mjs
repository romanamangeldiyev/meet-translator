// SttSocket v2 (src/engine/stt.js) with a mock WebSocket factory, fake timers/clock and an injected
// normalizeLang. No network. Run: npm test  (or bundle with esbuild --platform=node --format=esm and run with node)
import assert from 'node:assert/strict';
import { normalizeLang } from '../src/engine/util.js';
import {
  HttpError, MAX_KEYTERMS, OPTIONAL_PARAMS, SILENCE_CHUNK_B64, SttSocket, buildSttUrl, fetchRealtimeToken,
  filterKeyterms, optionalParamsInUse, tailForContext,
} from '../src/engine/stt.js';

// ---------------------------------------------------------------- harness
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

/** Fake timers on a virtual clock; advance() fires due timers in time order (including ones they schedule). */
function fakeClock(start = 100000) {
  let now = start;
  let seq = 0;
  const timers = new Map();
  const nextDue = (limit) => {
    let best = null;
    for (const t of timers.values()) {
      if (t.at <= limit && (!best || t.at < best.at || (t.at === best.at && t.id < best.id))) best = t;
    }
    return best;
  };
  return {
    now: () => now,
    setTimeout: (fn, ms) => {
      const id = ++seq;
      timers.set(id, { id, fn, ms, at: now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout: (id) => { timers.delete(id); },
    advance(ms) {
      const end = now + ms;
      for (let t = nextDue(end); t; t = nextDue(end)) {
        timers.delete(t.id);
        now = t.at;
        t.fn();
      }
      now = end;
    },
    pending: () => [...timers.values()],
    count: () => timers.size,
  };
}

class MockWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.bufferedAmount = 0;
    this.closedWith = null;
  }
  send(data) {
    if (this.readyState !== 1) throw new Error('send on a socket that is not open');
    this.sent.push(JSON.parse(data));
  }
  close(code) { this.closedWith = code; this.readyState = 3; }
  // test helpers
  open() { this.readyState = 1; }
  msg(o) { if (this.onmessage) this.onmessage({ data: JSON.stringify(o) }); }
  drop(code = 1006) { this.readyState = 3; if (this.onclose) this.onclose({ code }); }
  params() { return new URL(this.url).searchParams; }
}

const flush = () => new Promise((r) => setImmediate(r));

const LANG_STUB = {
  tr: 'tr', tur: 'tr', en: 'en', eng: 'en', es: 'es', spa: 'es', fr: 'fr', fra: 'fr', fre: 'fr', de: 'de', deu: 'de',
  ger: 'de', it: 'it', ita: 'it', ru: 'ru', rus: 'ru', pt: 'pt', por: 'pt',
};
function stubNormalizeLang(code) {
  if (typeof code !== 'string') return null;
  return LANG_STUB[code.trim().toLowerCase().split(/[-_]/)[0]] || null;
}

function setup(extra = {}) {
  const clock = fakeClock();
  const sockets = [];
  const tokens = [];
  const ev = { partial: [], committed: [], ready: 0, reconnecting: [], fatal: [] };
  const sock = new SttSocket({
    label: 'test',
    lang: 'tr',
    secondaryLanguages: ['en'],
    silenceSecs: 0.8,
    getToken: async () => {
      const t = `tok${tokens.length + 1}`;
      tokens.push(t);
      return t;
    },
    onPartial: (text, meta) => ev.partial.push([text, meta]),
    onCommitted: (text, meta) => ev.committed.push([text, meta]),
    onReady: () => { ev.ready++; },
    onReconnecting: (n) => ev.reconnecting.push(n),
    onFatal: (r) => ev.fatal.push(r),
    createWebSocket: (url) => {
      const ws = new MockWS(url);
      sockets.push(ws);
      return ws;
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    random: () => 0.5,
    normalizeLang: stubNormalizeLang,
    sentenceCommit: false, // the sentence-commit tests turn it on explicitly
    ...extra,
  });
  return { sock, ev, clock, sockets, tokens, ws: () => sockets[sockets.length - 1] };
}

/** base64 of `ms` of 16 kHz PCM16 audio at a constant amplitude (0 = digital silence). */
function pcmB64(ms, amp = 0) {
  const n = Math.round(ms * 16);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
  return b.toString('base64');
}

test('sentence commit: commit:true rides on the next chunk once a sentence ended and the voice went quiet', async () => {
  const fx = setup({ sentenceCommit: true });
  fx.sock.connect();
  const ws = await start(fx);
  const loud = pcmB64(100, 8000); // about -12 dBFS
  const quiet = pcmB64(100, 0);
  const commitsSent = () => ws.sent.filter((m) => m.message_type === 'input_audio_chunk' && m.commit).length;
  // 0.6 s of speech with partials; the sentence ends with "."
  for (let i = 0; i < 6; i++) {
    fx.sock.sendAudio(loud);
    fx.clock.advance(100);
  }
  ws.msg({ message_type: 'partial_transcript', text: 'I think we can start with the pricing.' });
  fx.sock.sendAudio(loud); // still voiced: no commit
  fx.clock.advance(100);
  assert.equal(commitsSent(), 0, 'not while the voice is still on');
  for (let i = 0; i < 2; i++) { fx.sock.sendAudio(quiet); fx.clock.advance(100); }
  assert.equal(commitsSent(), 0, 'quiet for only ~100-200 ms so far');
  fx.sock.sendAudio(quiet); // 300 ms since the last voiced chunk -> this chunk carries commit:true
  assert.equal(commitsSent(), 1);
  assert.equal(fx.sock.stats().clientCommits, 1);
  fx.clock.advance(100);
  fx.sock.sendAudio(quiet);
  assert.equal(commitsSent(), 1, 'the same sentence is never committed twice');
  // the server commits; a new segment begins
  ws.msg({ message_type: 'committed_transcript_with_timestamps', text: 'I think we can start with the pricing.', language_code: 'en' });
  ws.msg({ message_type: 'committed_transcript', text: 'I think we can start with the pricing.' });
  assert.equal(fx.ev.committed.length, 1);
  const s = fx.sock.stats();
  assert.equal(s.commits, 1);
  assert.ok(s.partials >= 1 && s.chunks >= 10);
  assert.equal(typeof s.levelDb, 'number');
});

test('sentence commit: no commit for a hallucinated partial in silence, mid-sentence, a single word, or without punctuation', async () => {
  const fx = setup({ sentenceCommit: true });
  fx.sock.connect();
  const ws = await start(fx);
  const loud = pcmB64(100, 8000);
  const quiet = pcmB64(100, 0);
  const commitsSent = () => ws.sent.filter((m) => m.message_type === 'input_audio_chunk' && m.commit).length;
  // "Yeah." appears while the audio is digitally silent (no voice in this segment)
  ws.msg({ message_type: 'partial_transcript', text: 'Yeah, sure.' });
  for (let i = 0; i < 10; i++) { fx.sock.sendAudio(quiet); fx.clock.advance(100); }
  assert.equal(commitsSent(), 0, 'no voice energy in the segment: never committed');
  // speech that keeps going although a partial briefly ends with "."
  for (let i = 0; i < 5; i++) { fx.sock.sendAudio(loud); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'Then we can talk about the delivery date.' });
  for (let i = 0; i < 5; i++) { fx.sock.sendAudio(loud); fx.clock.advance(100); }
  assert.equal(commitsSent(), 0, 'voice still on: a premature period does not commit');
  // no sentence-final punctuation: left to the server VAD
  ws.msg({ message_type: 'partial_transcript', text: 'Then we can talk about the delivery dates next' });
  for (let i = 0; i < 10; i++) { fx.sock.sendAudio(quiet); fx.clock.advance(100); }
  assert.equal(commitsSent(), 0, 'no punctuation: the server VAD decides');
  // a single word is left to the VAD too
  ws.msg({ message_type: 'committed_transcript', text: 'Then we can talk about the delivery dates next' });
  for (let i = 0; i < 4; i++) { fx.sock.sendAudio(loud); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'Yes.' });
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(quiet); fx.clock.advance(100); }
  assert.equal(commitsSent(), 0, 'single word: no client commit');
});

test('echo gate: mic closed while the other side speaks (onset + recognized text), open on silence or text-less noise', async () => {
  const { echoGated } = await import('../src/engine/echo.js');
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  const inc = fx.sock;
  const now = () => fx.clock.now();
  assert.equal(echoGated(inc, {}, now()), false, 'nobody spoke yet');
  fx.sock.sendAudio(pcmB64(100, 8000)); // the other side starts talking
  assert.equal(echoGated(inc, {}, now()), true, 'onset: gated before any partial');
  assert.equal(echoGated(inc, { echoGuard: false }, now()), false, 'can be turned off');
  for (let i = 0; i < 20; i++) { fx.clock.advance(100); fx.sock.sendAudio(pcmB64(100, 8000)); }
  assert.equal(echoGated(inc, {}, now()), false, '2 s of voice without any recognized text (noise/music): open');
  ws.msg({ message_type: 'partial_transcript', text: 'Merhaba nasılsınız' });
  assert.equal(echoGated(inc, {}, now()), true, 'recognized speech: gated');
  fx.clock.advance(500);
  fx.sock.sendAudio(pcmB64(100, 0));
  assert.equal(echoGated(inc, {}, now()), false, '500 ms after the last voice: open again');
});

test('echo gate: the substituted silence never lowers the mic noise floor (sentence commits keep working in a noisy room)', async () => {
  const { forwardMic } = await import('../src/engine/echo.js');
  const inc = setup();
  inc.sock.connect();
  const inWs = await start(inc);
  // the out socket shares the in socket's clock
  const out = setup({ sentenceCommit: true, now: inc.clock.now, setTimeout: inc.clock.setTimeout, clearTimeout: inc.clock.clearTimeout });
  out.sock.connect();
  const outWs = await start(out);
  const clock = inc.clock;
  const room = pcmB64(100, 184); // about -45 dBFS of room noise on the mic
  const step = (inChunk, micChunk) => {
    inc.sock.sendAudio(inChunk);
    const gated = forwardMic(inc.sock, out.sock, {}, micChunk, clock.now());
    clock.advance(100);
    return gated;
  };
  for (let i = 0; i < 30; i++) assert.equal(step(pcmB64(100, 0), room), false, 'nobody else talks: mic open');
  // the other side talks for 2 s; it leaks into the mic and is gated
  const words = 'Merhaba arkadaşlar bugün önce fiyatlardan sonra teslim tarihlerinden konuşalım'.split(' ');
  let gated = 0;
  for (let i = 0; i < 20; i++) {
    if (i % 3 === 2) inWs.msg({ message_type: 'partial_transcript', text: words.slice(0, 1 + i / 3).join(' ') });
    if (step(pcmB64(100, 8000), pcmB64(100, 2000))) gated++;
  }
  assert.equal(gated, 20, 'echo gated');
  assert.equal(out.sock.stats().gated, 20, 'gated mic chunks are counted for the diagnostics');
  assert.ok(out.sock.stats().levelDb > -60, 'diagnostics show what the mic really hears while gated');
  for (let i = 0; i < 6; i++) step(pcmB64(100, 0), room); // the gate reopens
  assert.equal(forwardMic(inc.sock, out.sock, {}, room, clock.now()), false);
  // the user answers, then stops; the room noise goes on
  for (let i = 0; i < 8; i++) step(pcmB64(100, 0), pcmB64(100, 8000));
  outWs.msg({ message_type: 'partial_transcript', text: 'Sure, let us start with the pricing.' });
  for (let i = 0; i < 6; i++) step(pcmB64(100, 0), room);
  const commits = outWs.sent.filter((m) => m.message_type === 'input_audio_chunk' && m.commit).length;
  assert.equal(commits, 1, 'room noise after the gate is not taken for voice: the sentence commit is sent');
  inc.sock.close();
  out.sock.close();
});

test('echo gate: an incoming "evet" while the user speaks never cuts the user; echo onsets are still gated', async () => {
  const { forwardMic, echoGated } = await import('../src/engine/echo.js');
  const inc = setup();
  inc.sock.connect();
  const inWs = await start(inc);
  const out = setup({ now: inc.clock.now, setTimeout: inc.clock.setTimeout, clearTimeout: inc.clock.clearTimeout });
  out.sock.connect();
  await start(out);
  const clock = inc.clock;
  const quiet = pcmB64(100, 0);
  const voice = pcmB64(100, 8000);
  const echo = pcmB64(100, 2000);
  const step = (inChunk, micChunk, micFirst = false) => {
    if (!micFirst) inc.sock.sendAudio(inChunk);
    const g = forwardMic(inc.sock, out.sock, {}, micChunk, clock.now());
    if (micFirst) inc.sock.sendAudio(inChunk);
    clock.advance(100);
    return g;
  };
  for (let i = 0; i < 20; i++) step(quiet, quiet);
  // the user talks; 600 ms in, the other side says "evet" (300 ms) and coughs
  let cut = 0;
  for (let i = 0; i < 6; i++) cut += step(quiet, voice);
  for (let i = 0; i < 3; i++) cut += step(voice, voice);
  inWs.msg({ message_type: 'partial_transcript', text: 'Evet' });
  for (let i = 0; i < 6; i++) cut += step(quiet, voice);
  assert.equal(cut, 0, 'not a single chunk of the user\'s sentence was replaced by silence');
  for (let i = 0; i < 15; i++) step(quiet, quiet); // both quiet
  // the other side starts talking while the user is silent: its echo is gated
  let gated = 0;
  for (let i = 0; i < 10; i++) {
    if (i === 3) inWs.msg({ message_type: 'partial_transcript', text: 'Peki fiyatlar' });
    gated += step(voice, echo);
  }
  assert.equal(gated, 10);
  for (let i = 0; i < 3; i++) step(quiet, quiet);
  assert.equal(echoGated(inc.sock, {}, clock.now(), out.sock), false, 'open 250 ms after the incoming voice ended');
  for (let i = 0; i < 10; i++) step(quiet, quiet);
  // the echo of an onset can reach the mic one chunk before the incoming chunk that carries it:
  // that leaked chunk must not make the gate believe the user holds the floor
  assert.equal(step(voice, echo, true), false, 'the very first echo chunk slips through (chunk timing)');
  gated = 0;
  for (let i = 0; i < 3; i++) gated += step(voice, echo);
  assert.equal(gated, 3, 'then gated: no text yet, onset window');
  for (let i = 0; i < 4; i++) step(quiet, quiet);
  // an incoming cough without any text closes the mic for the onset window only
  gated = 0;
  for (let i = 0; i < 10; i++) gated += step(voice, echo);
  assert.ok(gated >= 9 && gated <= 10, `onset-only window ~1 s (${gated} chunks)`);
  for (let i = 0; i < 6; i++) gated += step(voice, echo);
  assert.ok(gated <= 11, 'after the onset window, text-less sound (a cough, music) no longer gates');
  assert.equal(echoGated(inc.sock, { echoGuard: false }, clock.now(), out.sock), false, 'headphones: off');
  inc.sock.close();
  out.sock.close();
});

test('echo gate: the double-talk pass cannot be sustained by the echo itself (other side interrupts and keeps talking)', async () => {
  const { forwardMic } = await import('../src/engine/echo.js');
  const inc = setup();
  inc.sock.connect();
  const inWs = await start(inc);
  const out = setup({ now: inc.clock.now, setTimeout: inc.clock.setTimeout, clearTimeout: inc.clock.clearTimeout });
  out.sock.connect();
  await start(out);
  const clock = inc.clock;
  const quiet = pcmB64(100, 0);
  const step = (inChunk, micChunk) => {
    inc.sock.sendAudio(inChunk);
    const g = forwardMic(inc.sock, out.sock, {}, micChunk, clock.now());
    clock.advance(100);
    return g;
  };
  for (let i = 0; i < 20; i++) step(quiet, quiet);
  for (let i = 0; i < 8; i++) step(quiet, pcmB64(100, 8000)); // the user talks...
  // ...and stops as the other side interrupts with short phrases (0.8 s speech, 0.35 s pauses) for 9 s.
  // The echo reaches the mic ~100 ms late, so it bridges the pauses on the mic side.
  let passed = 0;
  for (let p = 0; p < 8; p++) {
    for (let i = 0; i < 8; i++) {
      if (i === 2) inWs.msg({ message_type: 'partial_transcript', text: `ifade ${p} devam ediyor` });
      passed += step(pcmB64(100, 8000), pcmB64(100, 2000)) ? 0 : 1;
    }
    step(quiet, pcmB64(100, 2000)); // echo tail
    step(quiet, quiet);
    clock.advance(50);
  }
  assert.ok(passed <= 24, `echo passed to the recognizer for ${passed} of 64 chunks (the pass must run out)`);
  inc.sock.close();
  out.sock.close();
});

test('sentence commit: voice energy without any transcript is forgotten after a quiet stretch (a later hallucination is not committed)', async () => {
  const fx = setup({ sentenceCommit: true });
  fx.sock.connect();
  const ws = await start(fx);
  const commitsSent = () => ws.sent.filter((m) => m.message_type === 'input_audio_chunk' && m.commit).length;
  for (let i = 0; i < 5; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); } // a cough, no text
  for (let i = 0; i < 50; i++) { fx.sock.sendAudio(pcmB64(100, 0)); fx.clock.advance(100); } // 5 s of silence
  ws.msg({ message_type: 'partial_transcript', text: 'Thank you.' }); // hallucinated in the silence
  for (let i = 0; i < 10; i++) { fx.sock.sendAudio(pcmB64(100, 0)); fx.clock.advance(100); }
  assert.equal(commitsSent(), 0, 'the cough 5 s earlier does not vouch for this text');
  // real speech in the same (uncommitted) segment still commits
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'Thank you. I agree with that.' });
  for (let i = 0; i < 4; i++) { fx.sock.sendAudio(pcmB64(100, 0)); fx.clock.advance(100); }
  assert.equal(commitsSent(), 1);
  fx.sock.close();
});

test('mute: when the mic stops sending mid-segment (Meet mute / push-to-talk), the voiced text is committed', async () => {
  const fx = setup({ sentenceCommit: true });
  fx.sock.connect();
  const ws = await start(fx);
  const commitsSent = () => ws.sent.filter((m) => m.message_type === 'input_audio_chunk' && m.commit);
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  fx.sock.sendAudio(pcmB64(100, 0));
  // muted: no more chunks; the last partial arrives after the audio stopped
  fx.clock.advance(300);
  ws.msg({ message_type: 'partial_transcript', text: 'Thanks everyone, that is all from me' });
  fx.clock.advance(1000);
  assert.equal(commitsSent().length, 1, 'committed shortly after the audio stopped');
  assert.equal(commitsSent()[0].audio_base_64, SILENCE_CHUNK_B64);
  assert.equal(fx.sock.stats().clientCommits, 1);
  fx.clock.advance(20000); // keepalives go on, never committing again
  assert.equal(commitsSent().length, 1);
  assert.ok(chunks(ws).length >= 5);
  // a hallucinated partial without voice is never committed this way
  ws.msg({ message_type: 'committed_transcript', text: 'Thanks everyone, that is all from me' });
  ws.msg({ message_type: 'partial_transcript', text: 'Thank you.' });
  fx.clock.advance(10000);
  assert.equal(commitsSent().length, 1);
  // a steady stream (speaking, then pausing without punctuation) is left to the server VAD
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'and then we can talk about' });
  for (let i = 0; i < 20; i++) { fx.sock.sendAudio(pcmB64(100, 0)); fx.clock.advance(100); }
  assert.equal(commitsSent().length, 1);
  fx.sock.close();
  assert.equal(fx.clock.count(), 0);
});

test('commitNow (Meet mute): commits the open voiced segment once; nothing without text, voice or a session', async () => {
  const fx = setup();
  fx.sock.connect();
  assert.equal(fx.sock.commitNow(), false, 'not connected yet');
  const ws = await start(fx);
  const commitsSent = () => ws.sent.filter((m) => m.message_type === 'input_audio_chunk' && m.commit);
  assert.equal(fx.sock.commitNow(), false, 'nothing said');
  ws.msg({ message_type: 'partial_transcript', text: 'Thank you.' });
  assert.equal(fx.sock.commitNow(), false, 'text without any voice behind it');
  for (let i = 0; i < 3; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'Yes we' });
  assert.equal(fx.sock.commitNow(), true);
  assert.equal(commitsSent().length, 1);
  assert.equal(commitsSent()[0].audio_base_64, SILENCE_CHUNK_B64);
  assert.equal(fx.sock.commitNow(), false, 'the same text is never committed twice');
  assert.equal(fx.sock.stats().clientCommits, 1);
  fx.sock.close();
});

test('clause commit: a long partial without sentence punctuation is committed at a 250 ms pause', async () => {
  const fx = setup({ sentenceCommit: true });
  fx.sock.connect();
  const ws = await start(fx);
  const commitsSent = () => ws.sent.filter((m) => m.message_type === 'input_audio_chunk' && m.commit).length;
  for (let i = 0; i < 30; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'so what we were thinking is that the delivery could happen in two parts and the first' }); // 17 words
  fx.sock.sendAudio(pcmB64(100, 8000));
  fx.clock.advance(100);
  fx.sock.sendAudio(pcmB64(100, 0));
  fx.clock.advance(100);
  fx.sock.sendAudio(pcmB64(100, 0));
  assert.equal(commitsSent(), 0, 'quiet for only 200 ms');
  fx.clock.advance(100);
  fx.sock.sendAudio(pcmB64(100, 0)); // 300 ms after the last voiced chunk (>= 250)
  assert.equal(commitsSent(), 1);
  // a shorter unpunctuated partial still waits for the server VAD
  ws.msg({ message_type: 'committed_transcript', text: 'so what we were thinking' });
  for (let i = 0; i < 10; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'and the second part would come later in the month' }); // 10 words
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 0)); fx.clock.advance(100); }
  assert.equal(commitsSent(), 1);
  fx.sock.close();
});

test('commit meta: the span of the segment\'s voice and its gated audio ride along; voiceDuring() answers overlaps', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  const t0 = fx.clock.now();
  for (let i = 0; i < 5; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  for (let i = 0; i < 3; i++) { fx.sock.sendSilenceFor(pcmB64(100, 2000)); fx.clock.advance(100); }
  ws.msg(sibling('Hello there.', 'en'));
  const [, m] = fx.ev.committed[0];
  assert.equal(m.startAt, t0);
  assert.equal(m.endAt, t0 + 400);
  assert.equal(m.gatedMs, 300);
  assert.equal(fx.sock.voiceDuring(t0 + 100, t0 + 200), true);
  assert.equal(fx.sock.voiceDuring(t0 + 500, t0 + 900), false, 'gated audio is not voice');
  assert.equal(fx.sock.voiceDuring(t0 - 1000, t0 - 1), false);
  fx.sock.close();
});

test('reconnect mid-utterance: the text recognized so far is committed, not lost (once; never for unvoiced text)', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  fx.clock.advance(5000);
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws.msg(partial('Bugün önce fiyatları konuşalım, sonra', 'tr'));
  ws.msg({ message_type: 'session_time_limit_exceeded' }); // quiet reconnect while the speaker is mid-sentence
  assert.deepEqual(fx.ev.committed.map(([t, m]) => [t, m.lang]), [['Bugün önce fiyatları konuşalım, sonra', 'tr']]);
  const ws2 = await start(fx);
  fx.sock.sendAudio('AAAA');
  assert.equal(chunks(ws2)[0].previous_text, 'Bugün önce fiyatları konuşalım, sonra');
  // the segment was committed by the server before the drop: nothing more
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws2.msg(partial('Teslim tarihi', 'tr'));
  ws2.msg(sibling('Teslim tarihi cuma.', 'tr'));
  fx.clock.advance(5000);
  ws2.drop();
  assert.equal(fx.ev.committed.length, 2);
  // a partial without any voice behind it (hallucination in silence) is not committed on a drop
  const ws3 = await start(fx);
  fx.clock.advance(5000);
  ws3.msg(partial('Thank you.', 'en'));
  ws3.drop();
  assert.equal(fx.ev.committed.length, 2);
  fx.sock.close();
});

test('sentence commit: off by option; chunkLevelDb reads PCM16 loudness', async () => {
  const fx = setup({ sentenceCommit: false });
  fx.sock.connect();
  const ws = await start(fx);
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 8000)); fx.clock.advance(100); }
  ws.msg({ message_type: 'partial_transcript', text: 'This sentence is done.' });
  for (let i = 0; i < 6; i++) { fx.sock.sendAudio(pcmB64(100, 0)); fx.clock.advance(100); }
  assert.equal(ws.sent.filter((m) => m.commit).length, 0);
  const { chunkLevelDb } = await import('../src/engine/stt.js');
  assert.equal(chunkLevelDb(pcmB64(100, 0)), -100);
  const db = chunkLevelDb(pcmB64(100, 8000));
  assert.ok(db > -13 && db < -11, `about -12 dBFS, got ${db}`);
  assert.equal(chunkLevelDb(''), null);
});

/** Lets the token promise settle, then opens the newest socket and starts its session. */
async function start(fx) {
  await flush();
  const ws = fx.ws();
  assert.ok(ws, 'a socket was created');
  ws.open();
  ws.msg({ message_type: 'session_started', session_id: 'sess' });
  return ws;
}

/** [text, {lang, at}] of a recorded commit (the span fields have their own test). */
const langAt = ([t, m]) => [t, { lang: m.lang, at: m.at }];
const chunks = (ws) => ws.sent.filter((m) => m.message_type === 'input_audio_chunk');
const present = (ws) => OPTIONAL_PARAMS.filter((k) => ws.params().has(k));
const plain = (text, extra = {}) => ({ message_type: 'committed_transcript', text, ...extra });
const sibling = (text, language_code) => ({
  message_type: 'committed_transcript_with_timestamps', text, language_code, words: [],
});
const partial = (text, language_code) => ({ message_type: 'partial_transcript', text, language_code });

// ---------------------------------------------------------------- query building
test('url: every param on the in socket; list params repeat their key; no include_timestamps', () => {
  const url = buildSttUrl({
    lang: 'tr', secondaryLanguages: ['en'], silenceSecs: 0.8, keyterms: ['Acme', 'Kubernetes'], token: 'abc',
  });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'wss://api.elevenlabs.io/v1/speech-to-text/realtime');
  const p = u.searchParams;
  assert.deepEqual([...p.keys()], [
    'model_id', 'audio_format', 'commit_strategy', 'vad_silence_threshold_secs', 'language_code',
    'secondary_languages', 'include_language_detection', 'no_verbatim', 'keyterms', 'keyterms', 'token',
  ]);
  assert.equal(p.get('model_id'), 'scribe_v3_live');
  assert.equal(p.get('audio_format'), 'pcm_16000');
  assert.equal(p.get('commit_strategy'), 'vad');
  assert.equal(p.get('vad_silence_threshold_secs'), '0.8');
  assert.equal(p.get('language_code'), 'tr');
  assert.deepEqual(p.getAll('secondary_languages'), ['en']);
  assert.equal(p.get('include_language_detection'), 'true');
  assert.equal(p.get('no_verbatim'), 'true');
  assert.deepEqual(p.getAll('keyterms'), ['Acme', 'Kubernetes']);
  assert.equal(p.get('token'), 'abc');
  assert.equal(p.has('filter_background_audio'), false);
  assert.equal(p.has('include_timestamps'), false);
  assert.ok(url.includes('&secondary_languages=en&'));
  assert.ok(url.includes('&keyterms=Acme&keyterms=Kubernetes&'));
});

test('url: out socket shape (en + secondary lang, filter_background_audio, 0.7 s VAD); secondaries de-duplicated', () => {
  const p = new URL(buildSttUrl({
    lang: 'en', secondaryLanguages: ['de'], silenceSecs: 0.7, filterBackgroundAudio: true, token: 't',
  })).searchParams;
  assert.equal(p.get('language_code'), 'en');
  assert.deepEqual(p.getAll('secondary_languages'), ['de']);
  assert.equal(p.get('vad_silence_threshold_secs'), '0.7');
  assert.equal(p.get('filter_background_audio'), 'true');
  assert.equal(p.has('keyterms'), false); // empty glossary
  assert.equal(p.has('include_timestamps'), false);
  const q = new URL(buildSttUrl({
    lang: 'tr', secondaryLanguages: ['en', 'de', 'en', 'tr', '', null], silenceSecs: 0.8, token: 't',
  })).searchParams;
  assert.deepEqual(q.getAll('secondary_languages'), ['en', 'de']);
});

test('url: keyterms filtered (strings, trimmed, <= 20 chars, longer skipped, de-duplicated, max 50) and encoded', () => {
  const twenty = 'abcdefghijklmnopqrst';
  const long = `${twenty}u`;
  const turkish20 = 'ğüşıöçĞÜŞİÖÇğüşıöçĞÜ';
  assert.equal(Array.from(turkish20).length, 20);
  assert.deepEqual(
    filterKeyterms(['  Acme  ', long, twenty, '', '   ', null, 42, {}, 'Acme', 'C++ & Co', turkish20, 'çok  boşluklu   ad']),
    ['Acme', twenty, 'C++ & Co', turkish20, 'çok boşluklu ad'],
  );
  const many = Array.from({ length: 60 }, (_, i) => `term${i}`);
  const kept = filterKeyterms([long, ...many]);
  assert.equal(kept.length, MAX_KEYTERMS);
  assert.equal(kept[0], 'term0');
  assert.equal(kept.at(-1), 'term49');
  assert.deepEqual(filterKeyterms(`Acme, Globex\nInitech;${long}`), ['Acme', 'Globex', 'Initech']);
  assert.deepEqual(filterKeyterms(undefined), []);

  const url = buildSttUrl({ lang: 'tr', silenceSecs: 0.8, keyterms: ['C++ & Co', 'a=b', long], token: 'x/y+z' });
  assert.ok(url.includes('keyterms=C%2B%2B%20%26%20Co'), url);
  assert.ok(!url.includes('+'), 'spaces are %20, never +');
  const p = new URL(url).searchParams;
  assert.deepEqual(p.getAll('keyterms'), ['C++ & Co', 'a=b']);
  assert.equal(p.get('token'), 'x/y+z');
});

test('url: dropped params are omitted; optionalParamsInUse lists only params actually sent, in drop order', () => {
  const out = { lang: 'en', secondaryLanguages: ['fr'], silenceSecs: 0.7, keyterms: ['Acme'], filterBackgroundAudio: true };
  assert.deepEqual(optionalParamsInUse(out, []), [...OPTIONAL_PARAMS]);
  assert.deepEqual(OPTIONAL_PARAMS, [
    'keyterms', 'filter_background_audio', 'secondary_languages', 'include_language_detection', 'no_verbatim',
  ]);
  assert.deepEqual(
    optionalParamsInUse({ lang: 'tr', secondaryLanguages: ['en'], keyterms: [] }, []),
    ['secondary_languages', 'include_language_detection', 'no_verbatim'],
  );
  assert.deepEqual(optionalParamsInUse(out, ['keyterms', 'secondary_languages']), [
    'filter_background_audio', 'include_language_detection', 'no_verbatim',
  ]);
  const p = new URL(buildSttUrl({ ...out, dropped: OPTIONAL_PARAMS, token: 't' })).searchParams;
  assert.deepEqual([...p.keys()], [
    'model_id', 'audio_format', 'commit_strategy', 'vad_silence_threshold_secs', 'language_code', 'token',
  ]);
});

test('socket: URL built from its options (out socket, glossary filtered, fresh token)', async () => {
  const fx = setup({
    label: 'mikrofon', lang: 'en', secondaryLanguages: ['it'], silenceSecs: 0.7,
    keyterms: ['Acme', 'x'.repeat(21), 'Globex'], filterBackgroundAudio: true,
  });
  fx.sock.connect();
  await flush();
  const p = fx.ws().params();
  assert.equal(p.get('language_code'), 'en');
  assert.deepEqual(p.getAll('secondary_languages'), ['it']);
  assert.equal(p.get('vad_silence_threshold_secs'), '0.7');
  assert.equal(p.get('filter_background_audio'), 'true');
  assert.deepEqual(p.getAll('keyterms'), ['Acme', 'Globex']);
  assert.equal(p.get('token'), 'tok1');
  fx.sock.close();
});

// ---------------------------------------------------------------- graceful degradation
test('degradation: rejections before session_started drop params in order, retried at once with fresh tokens', async () => {
  const fx = setup({
    lang: 'en', secondaryLanguages: ['fr'], silenceSecs: 0.7, keyterms: ['Acme', 'Globex'], filterBackgroundAudio: true,
  });
  fx.sock.connect();
  await flush();
  assert.deepEqual(present(fx.ws()), [...OPTIONAL_PARAMS]);
  const steps = [
    ['invalid_request', ['filter_background_audio', 'secondary_languages', 'include_language_detection', 'no_verbatim']],
    ['input_error', ['secondary_languages', 'include_language_detection', 'no_verbatim']],
    ['invalid_request', ['include_language_detection', 'no_verbatim']],
    ['input_error', ['no_verbatim']],
    ['invalid_request', []],
  ];
  for (const [type, left] of steps) {
    const before = fx.sockets.length;
    const old = fx.ws();
    old.open();
    old.msg({ message_type: type, error: 'Invalid parameter' });
    assert.equal(fx.sock.state, 'connecting', 'retried immediately, no backoff');
    assert.equal(old.closedWith, 1000);
    await flush();
    assert.equal(fx.sockets.length, before + 1);
    assert.deepEqual(present(fx.ws()), left);
    assert.equal(fx.ws().params().get('token'), `tok${fx.sockets.length}`);
  }
  assert.deepEqual(fx.ev.reconnecting, [], 'degradation retries are not connection failures');
  assert.equal(fx.sock.failures, 0);
  assert.equal(fx.sock.degradations, 5);

  // Nothing left to drop: the next rejection is an ordinary counted failure.
  fx.ws().open();
  fx.ws().msg({ message_type: 'invalid_request', error: 'still invalid' });
  assert.equal(fx.sock.state, 'backoff');
  assert.deepEqual(fx.ev.reconnecting, [1]);

  // Remembered for the session: later (quiet) reconnects keep the params dropped.
  fx.clock.advance(500);
  const ws = await start(fx);
  assert.deepEqual(present(ws), []);
  assert.equal(fx.ev.ready, 1);
  fx.clock.advance(20000);
  ws.msg({ message_type: 'session_time_limit_exceeded', error: 'limit' });
  await flush();
  assert.notEqual(fx.ws(), ws);
  assert.deepEqual(present(fx.ws()), []);
  assert.equal(fx.ev.fatal.length, 0);
  fx.sock.close();
});

test('degradation: in socket without glossary skips absent params (secondary_languages goes first)', async () => {
  const fx = setup();
  fx.sock.connect();
  await flush();
  assert.deepEqual(present(fx.ws()), ['secondary_languages', 'include_language_detection', 'no_verbatim']);
  fx.ws().open();
  fx.ws().msg({ message_type: 'invalid_request', error: 'x' });
  await flush();
  assert.deepEqual(present(fx.ws()), ['include_language_detection', 'no_verbatim']);
  assert.deepEqual([...fx.sock.dropped], ['secondary_languages']);
  fx.sock.close();
});

test('degradation: two consecutive closes before session_started drop a param (the first is a counted failure)', async () => {
  const fx = setup({ keyterms: ['Acme'] });
  fx.sock.connect();
  await flush();
  fx.ws().drop(); // 1st pre-start close: counted, backoff
  assert.equal(fx.sock.state, 'backoff');
  assert.deepEqual(fx.ev.reconnecting, [1]);
  fx.clock.advance(500);
  await flush();
  assert.equal(fx.sockets.length, 2);
  assert.ok(fx.ws().params().has('keyterms'));
  fx.ws().drop(); // 2nd consecutive: drop keyterms and retry at once
  assert.equal(fx.sock.state, 'connecting');
  await flush();
  assert.equal(fx.sockets.length, 3);
  assert.equal(fx.ws().params().has('keyterms'), false);
  assert.deepEqual(fx.ev.reconnecting, [1]);

  // A started session resets the streak; a young close after start is a counted failure, not a pre-start close.
  const ws3 = fx.ws();
  ws3.open();
  ws3.msg({ message_type: 'session_started' });
  fx.clock.advance(1000);
  ws3.drop();
  assert.deepEqual(fx.ev.reconnecting, [1, 2]);
  fx.clock.advance(1000);
  await flush();
  fx.ws().drop(); // first pre-start close of a new streak: counted, nothing dropped
  assert.deepEqual(fx.ev.reconnecting, [1, 2, 3]);
  assert.deepEqual([...fx.sock.dropped], ['keyterms']);
  fx.sock.close();
});

test('degradation: transient errors never degrade; other pre-start errors count like a close', async () => {
  const fx = setup({ keyterms: ['Acme'] });
  fx.sock.connect();
  await flush();
  fx.ws().open();
  fx.ws().msg({ message_type: 'rate_limited', error: 'x' });
  fx.clock.advance(500);
  await flush();
  fx.ws().open();
  fx.ws().msg({ message_type: 'queue_overflow', error: 'x' });
  assert.deepEqual(fx.ev.reconnecting, [1, 2]);
  assert.equal(fx.sock.dropped.size, 0);
  fx.clock.advance(1000);
  await flush();
  fx.ws().open();
  fx.ws().msg({ message_type: 'transcriber_error', error: 'x' }); // pre-start: streak 1 (counted)
  assert.deepEqual(fx.ev.reconnecting, [1, 2, 3]);
  fx.clock.advance(2000);
  await flush();
  fx.ws().drop(); // streak 2: degrade
  assert.equal(fx.sock.state, 'connecting');
  assert.deepEqual([...fx.sock.dropped], ['keyterms']);
  assert.deepEqual(fx.ev.reconnecting, [1, 2, 3]);
  fx.sock.close();
});

// ---------------------------------------------------------------- commits + language
test('commits: plain then sibling within 250 ms -> one commit with the sibling language, stamped at the plain', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(partial('Merhaba'));
  ws.msg(partial('Merhaba dünya', 'tur'));
  const t0 = fx.clock.now();
  ws.msg(plain(' Merhaba dünya. '));
  assert.equal(fx.ev.committed.length, 0, 'waits for the sibling');
  fx.clock.advance(120);
  assert.equal(fx.ev.committed.length, 0);
  ws.msg(sibling('Merhaba dünya.', 'eng'));
  assert.deepEqual(fx.ev.committed.map(langAt), [['Merhaba dünya.', { lang: 'en', at: t0 }]]);
  fx.clock.advance(5000);
  assert.equal(fx.ev.committed.length, 1, 'never double-emitted');
  assert.deepEqual(fx.ev.partial, [['Merhaba', { lang: null }], ['Merhaba dünya', { lang: 'tr' }]]);
  fx.sock.close();
});

test('commits: sibling first -> emitted at once; its plain twin is swallowed', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(sibling('Evet.', 'tr'));
  assert.deepEqual(fx.ev.committed.map(langAt), [['Evet.', { lang: 'tr', at: fx.clock.now() }]]);
  fx.clock.advance(30);
  ws.msg(plain('Evet.'));
  fx.clock.advance(1000);
  assert.equal(fx.ev.committed.length, 1);
  fx.sock.close();
});

test('commits: sibling never arrives -> after 250 ms with the partials language (else null); late sibling swallowed', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(partial('Hola a todos', 'spa'));
  const t0 = fx.clock.now();
  ws.msg(plain('Hola a todos.'));
  fx.clock.advance(249);
  assert.equal(fx.ev.committed.length, 0);
  fx.clock.advance(1);
  assert.deepEqual(fx.ev.committed.map(langAt), [['Hola a todos.', { lang: 'es', at: t0 }]]);
  fx.clock.advance(400);
  ws.msg(sibling('Hola a todos.', 'es'));
  fx.clock.advance(1000);
  assert.equal(fx.ev.committed.length, 1, 'late sibling never double-emits');

  const t1 = fx.clock.now();
  ws.msg(plain('Bilinmeyen.')); // no partial language, no sibling
  fx.clock.advance(250);
  assert.deepEqual(langAt(fx.ev.committed[1]), ['Bilinmeyen.', { lang: null, at: t1 }]);
  fx.sock.close();
});

test('commits: identical consecutive utterances are each emitted exactly once (pairs in any order)', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  for (let i = 0; i < 2; i++) {
    ws.msg(plain('Tamam.'));
    ws.msg(sibling('Tamam.', 'tr'));
  }
  for (let i = 0; i < 2; i++) {
    ws.msg(sibling('Tamam.', 'tr'));
    ws.msg(plain('Tamam.'));
  }
  ws.msg(sibling('Tamam.', 'tr'));
  ws.msg(sibling('Tamam.', 'tr'));
  ws.msg(plain('Tamam.'));
  ws.msg(plain('Tamam.'));
  fx.clock.advance(3000);
  assert.equal(fx.ev.committed.length, 6);
  assert.ok(fx.ev.committed.every(([t, m]) => t === 'Tamam.' && m.lang === 'tr'));
  fx.sock.close();
});

test('commits: waiting plains are released in order; a sibling-first segment never jumps the queue', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(partial('Bir', 'tr'));
  ws.msg(plain('Bir.'));
  ws.msg(plain('Two.'));
  ws.msg(sibling('Two.', 'en'));
  assert.deepEqual(fx.ev.committed.map(([t, m]) => [t, m.lang]), [['Bir.', 'tr'], ['Two.', 'en']]);
  ws.msg(sibling('Bir.', 'tr')); // late sibling of a commit that already went out
  ws.msg(plain('Üç.'));
  ws.msg(sibling('Four.', 'eng')); // new segment, sibling first, while "Üç." still waits
  ws.msg(sibling('Üç.', 'tr'));
  ws.msg(plain('Four.'));
  fx.clock.advance(2000);
  assert.deepEqual(fx.ev.committed.map(([t, m]) => [t, m.lang]), [
    ['Bir.', 'tr'], ['Two.', 'en'], ['Üç.', null], ['Four.', 'en'],
  ]);
  fx.sock.close();
});

test('commits: language detection dropped -> plain commits go out at once; stray siblings still swallowed', async () => {
  const fx = setup();
  fx.sock.connect();
  await flush();
  fx.ws().open();
  fx.ws().msg({ message_type: 'invalid_request', error: 'x' }); // drops secondary_languages
  await flush();
  fx.ws().open();
  fx.ws().msg({ message_type: 'invalid_request', error: 'x' }); // drops include_language_detection
  const ws = await start(fx);
  assert.equal(ws.params().has('include_language_detection'), false);
  ws.msg(partial('merhaba'));
  const t0 = fx.clock.now();
  ws.msg(plain('Merhaba.'));
  assert.deepEqual(fx.ev.committed.map(langAt), [['Merhaba.', { lang: null, at: t0 }]]);
  ws.msg(sibling('Merhaba.', 'tr'));
  fx.clock.advance(1000);
  assert.equal(fx.ev.committed.length, 1);
  fx.sock.close();
});

test('commits: a waiting commit goes out when the connection drops (and feeds previous_text); close() discards one', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(partial('Görüşürüz', 'tr'));
  fx.clock.advance(5000);
  ws.msg(plain('Görüşürüz.'));
  ws.drop(); // healthy session (> 3 s): quiet reconnect, but the waiting commit is released first
  assert.deepEqual(fx.ev.committed.map(([t, m]) => [t, m.lang]), [['Görüşürüz.', 'tr']]);
  const ws2 = await start(fx);
  assert.deepEqual(fx.ev.reconnecting, []);
  fx.sock.sendAudio('AAAA');
  assert.equal(chunks(ws2)[0].previous_text, 'Görüşürüz.');
  ws2.msg(plain('Son.'));
  fx.sock.close();
  fx.clock.advance(1000);
  assert.equal(fx.ev.committed.length, 1);
  assert.equal(fx.clock.count(), 0, 'no timers left after close');
});

test('partials: language null until detected, sticky within a segment, reset after a commit; blanks ignored', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(partial('Bonjour'));
  ws.msg(partial('Bonjour à', 'fra'));
  ws.msg(partial('Bonjour à tous'));
  ws.msg(partial('   ', 'fr'));
  ws.msg({ message_type: 'partial_transcript' });
  ws.msg(sibling('Bonjour à tous.', 'fr'));
  ws.msg(plain('Bonjour à tous.'));
  ws.msg(partial('Hello there', 'en-US'));
  ws.msg(plain('Hello there.'));
  ws.msg(sibling('Hello there.', 'en-US'));
  ws.msg(partial('Next'));
  assert.deepEqual(fx.ev.partial, [
    ['Bonjour', { lang: null }],
    ['Bonjour à', { lang: 'fr' }],
    ['Bonjour à tous', { lang: 'fr' }],
    ['Hello there', { lang: 'en' }],
    ['Next', { lang: null }],
  ]);
  assert.deepEqual(fx.ev.committed.map(([t, m]) => [t, m.lang]), [['Bonjour à tous.', 'fr'], ['Hello there.', 'en']]);
  fx.sock.close();
});

test('normalizeLang: the injected function is used; the default is util.normalizeLang', async () => {
  const seen = [];
  const fx = setup({ normalizeLang: (c) => { seen.push(c); return c === 'zz' ? 'de' : null; } });
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(partial('Hallo', 'zz'));
  ws.msg(sibling('Hallo.', 'qq'));
  assert.deepEqual(seen, ['zz', 'qq']);
  assert.deepEqual(fx.ev.partial[0], ['Hallo', { lang: 'de' }]);
  assert.deepEqual(fx.ev.committed[0][1].lang, 'de', 'unknown sibling language falls back to the partials one');
  fx.sock.close();

  const throwing = setup({ normalizeLang: () => { throw new Error('bad code'); } });
  throwing.sock.connect();
  const ws2 = await start(throwing);
  ws2.msg(partial('Hi', 'en'));
  assert.deepEqual(throwing.ev.partial, [['Hi', { lang: null }]]);
  throwing.sock.close();

  const dflt = setup({ normalizeLang: undefined }); // undefined options fall back to the defaults
  dflt.sock.connect();
  const ws3 = await start(dflt);
  ws3.msg(partial('Hi', 'en-US'));
  ws3.msg(partial('Hi there', 'ger'));
  ws3.msg(plain('Hi there.'));
  ws3.msg(sibling('Hi there.', 'xx'));
  assert.equal(normalizeLang('en-US'), 'en');
  assert.deepEqual(dflt.ev.partial, [['Hi', { lang: 'en' }], ['Hi there', { lang: 'de' }]]);
  assert.equal(dflt.ev.committed[0][1].lang, 'de');
  dflt.sock.close();
});

// ---------------------------------------------------------------- keepalive
test('keepalive: 4 s without a chunk -> 100 ms of silence, every 4 s; real audio pushes it back', async () => {
  assert.deepEqual(Buffer.from(SILENCE_CHUNK_B64, 'base64'), Buffer.alloc(3200));
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  const silent = () => chunks(ws).filter((m) => m.audio_base_64 === SILENCE_CHUNK_B64).length;
  fx.clock.advance(3999);
  assert.equal(chunks(ws).length, 0);
  fx.clock.advance(1);
  assert.equal(silent(), 1);
  assert.deepEqual(chunks(ws)[0], {
    message_type: 'input_audio_chunk', audio_base_64: SILENCE_CHUNK_B64, commit: false, sample_rate: 16000,
  });
  fx.clock.advance(4000);
  assert.equal(silent(), 2);
  fx.clock.advance(1000);
  fx.sock.sendAudio('AAAA'); // real audio 1 s after the last keepalive
  fx.clock.advance(3999);
  assert.equal(silent(), 2);
  fx.clock.advance(1);
  assert.equal(silent(), 3);
  for (let i = 0; i < 100; i++) { // a steady stream never needs it
    fx.clock.advance(100);
    fx.sock.sendAudio('AAAA');
  }
  assert.equal(silent(), 3);
  ws.drop(); // healthy close: reconnecting, no keepalive on the old socket
  fx.clock.advance(9000);
  assert.equal(silent(), 3);
  fx.sock.close();
  assert.equal(fx.clock.count(), 0);
});

test('keepalive: not before session_started, and stops in backoff', async () => {
  const fx = setup();
  fx.sock.connect();
  await flush();
  const ws = fx.ws();
  ws.open(); // open but no session yet
  fx.clock.advance(9000);
  assert.equal(ws.sent.length, 0);
  ws.msg({ message_type: 'session_started' });
  fx.clock.advance(1000);
  ws.msg({ message_type: 'transcriber_error', error: 'x' }); // counted -> backoff
  assert.equal(fx.sock.state, 'backoff');
  fx.clock.advance(400);
  assert.equal(ws.sent.length, 0);
  fx.sock.close();
});

// ---------------------------------------------------------------- previous_text
test('previous_text: only on the first chunk after each (re)connect, tail of the last commit', async () => {
  const fx = setup();
  fx.sock.connect();
  let ws = await start(fx);
  fx.sock.sendAudio('AAAA');
  assert.equal('previous_text' in chunks(ws)[0], false, 'nothing committed yet');
  ws.msg(sibling('Bugün hava çok güzel ve toplantıya birazdan başlayacağız, hazır mısınız?', 'tr'));
  fx.sock.sendAudio('BBBB');
  assert.equal('previous_text' in chunks(ws)[1], false, 'later chunk on the same connection');
  fx.clock.advance(5000);
  ws.drop(); // healthy close -> quiet reconnect
  fx.sock.sendAudio('CCCC'); // buffered while connecting
  fx.sock.sendAudio('DDDD');
  ws = await start(fx);
  assert.deepEqual(chunks(ws).map((m) => m.audio_base_64), ['CCCC', 'DDDD']);
  assert.equal(chunks(ws)[0].previous_text, 'toplantıya birazdan başlayacağız, hazır mısınız?');
  assert.equal('previous_text' in chunks(ws)[1], false);
  fx.sock.sendAudio('EEEE');
  assert.equal('previous_text' in chunks(ws)[2], false);
  fx.sock.close();
});

test('previous_text: rides on the keepalive chunk when that is the first chunk of the connection', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.msg(sibling('Tamam, görüşürüz.', 'tr'));
  fx.clock.advance(5000); // the session is now old enough for a quiet (uncounted) reconnect
  ws.drop();
  const ws2 = await start(fx);
  fx.clock.advance(4000);
  fx.clock.advance(4000);
  const c = chunks(ws2);
  assert.equal(c.length, 2);
  assert.equal(c[0].audio_base_64, SILENCE_CHUNK_B64);
  assert.equal(c[0].previous_text, 'Tamam, görüşürüz.');
  assert.equal('previous_text' in c[1], false);
  fx.sock.close();
});

test('tailForContext: <= 50 characters, cut at a word boundary', () => {
  assert.equal(tailForContext('  kısa   metin  '), 'kısa metin');
  assert.equal(tailForContext(''), '');
  assert.equal(tailForContext(null), '');
  assert.equal(tailForContext('a'.repeat(50)), 'a'.repeat(50));
  assert.equal(tailForContext('x'.repeat(80)), '', 'no boundary in the tail -> nothing');
  const atBoundary = `zzzz ${'y'.repeat(20)} ${'x'.repeat(29)}`; // last 50 chars start right after a space
  assert.equal(tailForContext(atBoundary), `${'y'.repeat(20)} ${'x'.repeat(29)}`);
  const midWord = `zzzzzz${'y'.repeat(20)} ${'x'.repeat(29)}`; // the cut splits a word: its remainder is dropped
  assert.equal(tailForContext(midWord), 'x'.repeat(29));
  const tr = `${'ş'.repeat(10)} ${'ğ'.repeat(49)}`;
  assert.equal(tailForContext(tr), 'ğ'.repeat(49));
  assert.equal(tailForContext('😀'.repeat(60)), '', 'counts code points, never splits a surrogate pair');
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  const tail = tailForContext(long);
  assert.ok(tail.length <= 50 && long.endsWith(tail) && long[long.length - tail.length - 1] === ' ');
});

// ---------------------------------------------------------------- reconnect, errors, tokens
test('reconnect: backoff 0.5/1/2/4/8 s with jitter, fatal after maxRetries', async () => {
  let n = 0;
  // giveUpMs 0: only the retry count matters here (the time-based limit has its own test)
  const fx = setup({ giveUpMs: 0, getToken: async () => { n++; throw new HttpError(500, 'boom'); } });
  fx.sock.connect();
  const delays = [];
  for (let i = 0; i < 5; i++) {
    await flush();
    assert.equal(fx.sock.state, 'backoff');
    const timers = fx.clock.pending();
    assert.equal(timers.length, 1, 'only the backoff timer is pending');
    delays.push(timers[0].ms);
    fx.clock.advance(timers[0].ms);
  }
  await flush();
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000]);
  assert.deepEqual(fx.ev.reconnecting, [1, 2, 3, 4, 5]);
  assert.equal(n, 6);
  assert.deepEqual(fx.ev.fatal, ['Transkripsiyon bağlantısı kurulamadı (test).']);
  assert.equal(fx.sock.state, 'closed');
  assert.equal(fx.clock.count(), 0);

  for (const [random, ms] of [[0, 400], [0.999999, 600]]) {
    const j = setup({ random: () => random, getToken: async () => { throw new HttpError(503, 'x'); } });
    j.sock.connect();
    await flush();
    assert.equal(j.clock.pending()[0].ms, ms);
    j.sock.close();
  }
});

test('reconnect: a ~20 s network outage does not end the session; fatal only after maxRetries AND 90 s', async () => {
  let failing = true;
  let n = 0;
  const fx = setup({ getToken: async () => { n++; if (failing) throw new HttpError(503, 'down'); return 'tok' + n; } });
  fx.sock.connect();
  // 7 failures (well past maxRetries = 5) spread over ~23.5 s: still retrying
  for (let i = 0; i < 7; i++) {
    await flush();
    assert.equal(fx.sock.state, 'backoff');
    fx.clock.advance(fx.clock.pending()[0].ms);
  }
  await flush();
  assert.deepEqual(fx.ev.fatal, [], 'not fatal before 90 s');
  // the network comes back: the next attempt opens a session
  failing = false;
  fx.clock.advance(fx.clock.pending()[0].ms);
  const ws = await start(fx);
  assert.equal(fx.sock.state, 'ready');
  assert.ok(ws);

  // a permanent outage gives up once 90 s of failures have passed
  const dead = setup({ getToken: async () => { throw new HttpError(503, 'down'); } });
  const t0 = dead.clock.now();
  dead.sock.connect();
  for (let i = 0; i < 40 && !dead.ev.fatal.length; i++) {
    await flush();
    const t = dead.clock.pending()[0];
    if (t) dead.clock.advance(t.ms);
  }
  await flush();
  assert.deepEqual(dead.ev.fatal, ['Transkripsiyon bağlantısı kurulamadı (test).']);
  const elapsed = dead.clock.now() - t0;
  assert.ok(elapsed >= 90000 && elapsed < 110000, `gave up only after 90 s (took ${elapsed} ms)`);
});

test('stall: an open socket whose send backlog does not drain for 4 s is reconnected; audio is kept', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  ws.bufferedAmount = 200 * 1024; // queued but under the drop limit: still sent
  fx.sock.sendAudio('AAAA');
  fx.clock.advance(3000);
  fx.sock.sendAudio('BBBB');
  assert.equal(fx.sock.state, 'ready', 'not yet: 3 s');
  fx.clock.advance(1500);
  fx.sock.sendAudio('CCCC'); // > 4 s without draining -> reconnect, chunk buffered for the new socket
  assert.equal(fx.sock.state, 'backoff');
  assert.ok(ws.closedWith !== null || ws.readyState !== 1, 'stalled socket closed');
  fx.clock.advance(fx.clock.pending()[0].ms);
  const ws2 = await start(fx);
  assert.notEqual(ws2, ws);
  const sent = ws2.sent.filter((m) => m.message_type === 'input_audio_chunk').map((m) => m.audio_base_64);
  assert.ok(sent.includes('CCCC'), 'the chunk that detected the stall is sent on the new socket');
  // a backlog that drains resets the timer
  ws2.bufferedAmount = 200 * 1024;
  fx.sock.sendAudio('DDDD');
  fx.clock.advance(3000);
  ws2.bufferedAmount = 0;
  fx.sock.sendAudio('EEEE');
  ws2.bufferedAmount = 200 * 1024;
  fx.clock.advance(3000);
  fx.sock.sendAudio('FFFF');
  assert.equal(fx.sock.state, 'ready', 'drained in between: no reconnect');
});

test('reconnect: every (re)connect uses a fresh token; quiet reconnect on session_time_limit_exceeded', async () => {
  const fx = setup();
  fx.sock.connect();
  let ws = await start(fx);
  assert.equal(ws.params().get('token'), 'tok1');
  fx.clock.advance(1000);
  ws.msg({ message_type: 'transcriber_error', error: 'x' }); // after start: counted
  assert.equal(fx.sock.state, 'backoff');
  assert.deepEqual(fx.ev.reconnecting, [1]);
  fx.clock.advance(500);
  ws = await start(fx);
  assert.equal(ws.params().get('token'), 'tok2');
  fx.clock.advance(20000);
  ws.msg({ message_type: 'session_time_limit_exceeded', error: 'limit' });
  assert.equal(fx.sock.state, 'connecting', 'reconnects at once');
  ws = await start(fx);
  assert.equal(ws.params().get('token'), 'tok3');
  assert.deepEqual(fx.ev.reconnecting, [1], 'quiet');
  assert.equal(fx.sock.failures, 0, 'reset by a session that lived > 10 s');
  assert.equal(fx.ev.ready, 3);
  assert.deepEqual(fx.tokens, ['tok1', 'tok2', 'tok3']);
  fx.sock.close();
});

test('errors: auth_error / quota_exceeded / unaccepted_terms are fatal (Turkish), before or after start', async () => {
  const cases = [
    ['auth_error', "ElevenLabs API anahtarı geçersiz. Ayarlar'dan düzeltin."],
    ['quota_exceeded', 'ElevenLabs kotanız doldu.'],
    ['unaccepted_terms', 'ElevenLabs şartları kabul edilmemiş; elevenlabs.io hesabınızdan kabul edin.'],
  ];
  for (const [type, reason] of cases) {
    for (const started of [true, false]) {
      const fx = setup();
      fx.sock.connect();
      await flush();
      const ws = fx.ws();
      ws.open();
      if (started) ws.msg({ message_type: 'session_started' });
      ws.msg({ message_type: type, error: 'x' });
      assert.deepEqual(fx.ev.fatal, [reason]);
      assert.equal(fx.sock.state, 'closed');
      assert.equal(ws.closedWith, 1000);
      fx.clock.advance(60000);
      await flush();
      assert.equal(fx.sockets.length, 1);
      assert.equal(fx.clock.count(), 0);
    }
  }
});

test('errors: ignored types and unknown info messages; other errors reconnect with backoff; stale sockets ignored', async () => {
  const fx = setup();
  fx.sock.connect();
  const ws = await start(fx);
  for (const type of ['warning', 'commit_throttled', 'insufficient_audio_activity', 'some_new_info']) {
    ws.msg({ message_type: type, message: 'x' });
  }
  ws.onmessage({ data: 'not json' });
  ws.onmessage({ data: new ArrayBuffer(4) });
  ws.msg({ text: 'no type' });
  assert.equal(fx.sock.state, 'ready');
  assert.equal(fx.sockets.length, 1);

  ws.msg({ message_type: 'mystery_failure', error: 'boom' }); // unknown type carrying an error
  assert.equal(fx.sock.state, 'backoff');
  assert.deepEqual(fx.ev.reconnecting, [1]);
  ws.msg(sibling('ghost', 'tr'));
  ws.msg(partial('ghost'));
  assert.equal(fx.ev.committed.length + fx.ev.partial.length, 0);

  fx.clock.advance(500);
  const ws2 = await start(fx);
  ws2.msg({ message_type: 'invalid_request', error: 'x' }); // after start: ordinary counted reconnect
  assert.equal(fx.sock.dropped.size, 0);
  assert.deepEqual(fx.ev.reconnecting, [1, 2]);
  for (const type of ['error', 'chunk_size_exceeded', 'resource_exhausted']) {
    fx.clock.advance(10000);
    const w = await start(fx);
    w.msg({ message_type: type, error: 'x' });
    assert.equal(fx.sock.state, 'backoff', type);
  }
  assert.equal(fx.ev.fatal.length, 0);
  fx.sock.close();
});

test('token: 401/403 fatal (key / permission / quota), network and 5xx errors retry', async () => {
  const cases = [
    [new HttpError(401, 'x', '{"detail":{"status":"invalid_api_key"}}'), "ElevenLabs API anahtarı geçersiz. Ayarlar'dan düzeltin."],
    [new HttpError(401, 'x', '{"detail":{"status":"missing_permissions","message":"speech_to_text"}}'),
      'ElevenLabs API anahtarında "Speech to Text" izni yok.'],
    [new HttpError(401, 'x', '{"detail":{"status":"quota_exceeded"}}'), 'ElevenLabs kotanız doldu.'],
    [new HttpError(403, 'x'), "ElevenLabs API anahtarı geçersiz. Ayarlar'dan düzeltin."],
  ];
  for (const [err, reason] of cases) {
    const fx = setup({ getToken: async () => { throw err; } });
    fx.sock.connect();
    await flush();
    assert.deepEqual(fx.ev.fatal, [reason]);
    assert.equal(fx.sockets.length, 0);
    assert.equal(fx.clock.count(), 0);
  }
  let n = 0;
  const fx = setup({ getToken: async () => { if (++n === 1) throw new TypeError('Failed to fetch'); return 'fresh'; } });
  fx.sock.connect();
  await flush();
  assert.equal(fx.sock.state, 'backoff');
  fx.clock.advance(500);
  await flush();
  assert.equal(fx.sockets.length, 1);
  assert.equal(fx.ws().params().get('token'), 'fresh');
  fx.sock.close();
});

test('connect timeout: no session_started within 10 s -> attempt aborted, counted failure', async () => {
  let aborted = 0;
  const fx = setup({
    getToken: (signal) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => {
        aborted++;
        reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
      });
    }),
  });
  fx.sock.connect();
  await flush();
  fx.clock.advance(9999);
  await flush();
  assert.equal(fx.sock.state, 'connecting');
  fx.clock.advance(1);
  await flush();
  assert.equal(aborted, 1);
  assert.equal(fx.sock.state, 'backoff');
  assert.deepEqual(fx.ev.reconnecting, [1]);
  fx.sock.close();

  const fx2 = setup();
  fx2.sock.connect();
  await flush();
  fx2.ws().open(); // opens but never sends session_started
  fx2.clock.advance(10000);
  assert.equal(fx2.sock.state, 'backoff');
  assert.equal(fx2.sockets[0].closedWith, 1000);
  assert.equal(fx2.sock.dropped.size, 0);
  fx2.sock.close();
});

test('fetchRealtimeToken: POST with xi-api-key and signal; HttpError keeps status and body', async () => {
  const calls = [];
  const signal = new AbortController().signal;
  const token = await fetchRealtimeToken('KEY', signal, async (url, init) => {
    calls.push([url, init]);
    return { ok: true, status: 200, json: async () => ({ token: 'single-use' }) };
  });
  assert.equal(token, 'single-use');
  assert.equal(calls[0][0], 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers['xi-api-key'], 'KEY');
  assert.equal(calls[0][1].signal, signal);
  await assert.rejects(
    fetchRealtimeToken('K', signal, async () => ({ ok: false, status: 401, text: async () => '{"detail":{"status":"missing_permissions"}}' })),
    (e) => e instanceof HttpError && e.status === 401 && /missing_permissions/.test(e.body),
  );
  await assert.rejects(
    fetchRealtimeToken('K', signal, async () => ({ ok: false, status: 502, text: async () => { throw new Error('no body'); } })),
    (e) => e instanceof HttpError && e.status === 502 && e.body === '',
  );
  await assert.rejects(
    fetchRealtimeToken('K', signal, async () => ({ ok: true, status: 200, json: async () => ({}) })),
    (e) => e instanceof HttpError && e.status === 500,
  );
});

// ---------------------------------------------------------------- audio path + lifecycle
test('audio: buffered while connecting (capped ~2 s), flushed in order on session_started; backlog drop', async () => {
  const fx = setup({ bufferBytes: 12 });
  fx.sock.sendAudio('AAAAAAAA'); // idle: buffers and connects
  assert.equal(fx.sock.state, 'connecting');
  for (const c of ['BBBBBBBB', 'CCCCCCCC', 'DDDDDDDD']) fx.sock.sendAudio(c); // 6 bytes each
  const ws = await start(fx);
  assert.equal(fx.ev.ready, 1);
  assert.deepEqual(chunks(ws), [
    { message_type: 'input_audio_chunk', audio_base_64: 'CCCCCCCC', commit: false, sample_rate: 16000 },
    { message_type: 'input_audio_chunk', audio_base_64: 'DDDDDDDD', commit: false, sample_rate: 16000 },
  ]);
  ws.bufferedAmount = 600 * 1024;
  fx.sock.sendAudio('EEEE');
  assert.equal(chunks(ws).length, 2, 'dropped while the network is backed up');
  ws.bufferedAmount = 0;
  fx.sock.sendAudio('FFFF');
  for (const bad of ['', null, undefined, 42]) fx.sock.sendAudio(bad);
  assert.deepEqual(chunks(ws).map((m) => m.audio_base_64), ['CCCCCCCC', 'DDDDDDDD', 'FFFF']);
  ws.drop(); // young close -> backoff; audio keeps buffering
  assert.equal(fx.sock.state, 'backoff');
  fx.sock.sendAudio('GGGG');
  fx.clock.advance(500);
  const ws2 = await start(fx);
  assert.deepEqual(chunks(ws2).map((m) => m.audio_base_64), ['GGGG']);
  fx.sock.close();
});

test('eager connect: connect() opens immediately and only once', async () => {
  const fx = setup();
  assert.equal(fx.sock.state, 'idle');
  fx.sock.connect();
  fx.sock.connect();
  assert.equal(fx.sock.state, 'connecting');
  await flush();
  fx.sock.connect();
  assert.equal(fx.sockets.length, 1);
  assert.deepEqual(fx.tokens, ['tok1']);
  fx.sock.close();
});

test('close(): idempotent, cancels timers and sockets, ignores later audio; late tokens are not used', async () => {
  const fx = setup();
  fx.sock.connect();
  await flush();
  fx.ws().drop(); // backoff
  fx.sock.close();
  fx.sock.close();
  assert.equal(fx.sock.state, 'closed');
  assert.equal(fx.clock.count(), 0);
  fx.clock.advance(60000);
  await flush();
  fx.sock.sendAudio('AAAA');
  fx.sock.connect();
  await flush();
  assert.equal(fx.sockets.length, 1);
  assert.equal(fx.ev.fatal.length, 0);

  const fx2 = setup();
  fx2.sock.connect();
  fx2.sock.close(); // while the token request is in flight
  await flush();
  assert.equal(fx2.sockets.length, 0);

  const fx3 = setup();
  fx3.sock.connect();
  const ws = await start(fx3);
  fx3.sock.close();
  assert.equal(ws.closedWith, 1000);
  ws.msg(sibling('after close', 'tr'));
  assert.equal(fx3.ev.committed.length, 0);
});

test('callbacks that throw or reject never break the socket or leak a rejection', async () => {
  const logged = [];
  const original = console.error;
  console.error = (...a) => logged.push(a);
  try {
    const fx = setup({
      onCommitted: () => { throw new Error('consumer bug'); },
      onPartial: async () => { throw new Error('async consumer bug'); },
      onReady: () => { throw new Error('ready bug'); },
    });
    fx.sock.connect();
    const ws = await start(fx);
    ws.msg(partial('a', 'tr'));
    ws.msg(sibling('A.', 'tr'));
    ws.msg(plain('A.'));
    ws.msg(plain('B.'));
    fx.clock.advance(250);
    await flush();
    assert.equal(fx.sock.state, 'ready');
    assert.equal(logged.length, 3); // ready + two commits
    fx.sock.sendAudio('AAAA');
    assert.equal(chunks(ws).length, 1);
    fx.sock.close();
  } finally {
    console.error = original;
  }
});

// ---------------------------------------------------------------- run
let passed = 0;
const failed = [];
for (const t of tests) {
  try {
    await t.fn();
    passed++;
  } catch (e) {
    failed.push(t.name);
    console.error(`FAIL ${t.name}\n`, e);
  }
}
await flush();
if (unhandled.length) {
  failed.push('no unhandled rejections');
  console.error('FAIL unhandled rejections:', unhandled);
}
if (failed.length) {
  console.error(`\n${failed.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} tests passed`);
