// Live test with the REAL APIs (bundled + run by scripts/live.mjs). Never prints keys or URLs with tokens.
//  1. ElevenLabs TTS makes two sample utterances (Turkish "other side", English "me") as 16 kHz PCM.
//  2. STT probe: each sample is streamed in real time into an SttSocket configured exactly like the extension;
//     reports accepted params, language detection and end-of-speech -> commit latency.
//  3. Claude model comparison: time to first token / total for each model setting on meeting-style utterances.
//  4. End to end: SttSocket -> createEngineCore -> captions + TTS, measuring end-of-speech -> caption / first audio.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import Anthropic from '@anthropic-ai/sdk';
import { parseDotEnv, envToSettings } from './env.mjs';
import { SttSocket, fetchRealtimeToken, SILENCE_CHUNK_B64 } from '../src/engine/stt.js';
import { echoGated } from '../src/engine/echo.js';
import { createEngineCore } from '../src/engine/core.js';

const ROOT = process.cwd();
const OUT_DIR = path.join(os.tmpdir(), 'meet-translator-live');
const ELEVEN = 'https://api.elevenlabs.io';
const only = (process.argv[2] || 'all').toLowerCase();
const CHUNK = 3200; // 100 ms of 16 kHz PCM16

const SAMPLES = {
  tr: 'Merhaba, hoş geldiniz. Bugün yeni ürünün fiyatlandırmasını ve teslim tarihlerini konuşmak istiyoruz.',
  en: 'Thanks for having me. Could you tell me a bit more about the pricing for the enterprise plan?',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sec = (ms) => (ms == null || !Number.isFinite(ms) ? '—' : `${(ms / 1000).toFixed(2)} sn`);
const log = (...a) => console.log(...a);

function die(msg) {
  console.error('\n✗ ' + msg);
  process.exit(2);
}

function loadSettings() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) die('.env bulunamadı.');
  const env = envToSettings(parseDotEnv(readFileSync(envPath, 'utf8')));
  const ctx = { self: {} };
  vm.createContext(ctx);
  vm.runInContext(readFileSync(path.join(ROOT, 'src', 'defaults.js'), 'utf8'), ctx);
  const s = JSON.parse(JSON.stringify(ctx.self.MT.merge(env, {})));
  if (!s.elevenKey || !s.anthropicKey) die('.env içinde ELEVENLABS_API_KEY ve ANTHROPIC_API_KEY dolu olmalı.');
  return s;
}

async function waitFor(pred, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return true;
    await sleep(40);
  }
  return !!pred();
}

// ---- audio helpers ------------------------------------------------------------------------------

async function synth(settings, text, lang) {
  const res = await fetch(`${ELEVEN}/v1/text-to-speech/${encodeURIComponent(settings.voiceId)}?output_format=pcm_16000`, {
    method: 'POST',
    headers: { 'xi-api-key': settings.elevenKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', language_code: lang }),
  });
  if (!res.ok) throw new Error(`örnek ses üretilemedi (HTTP ${res.status}): ${(await res.text()).slice(0, 200)}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Index (in bytes) just after the last sample louder than ~-36 dBFS: the real end of speech. */
function speechEndByte(pcm) {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  for (let i = pcm.length - 2; i >= 0; i -= 2) if (Math.abs(v.getInt16(i, true)) > 520) return i + 2;
  return pcm.length;
}

/**
 * Streams pcm like a live mic: 0.3 s silence, the speech, then `tailSecs` of silence, chunk k sent when it
 * would have been recorded completely. Returns { speechEndAt } (wall clock of the real end of speech).
 */
async function streamLive(sock, pcm, tailSecs = 3) {
  const lead = new Uint8Array(CHUNK * 3);
  const tail = new Uint8Array(Math.round(tailSecs * 10) * CHUNK);
  const all = new Uint8Array(lead.length + pcm.length + tail.length);
  all.set(lead, 0);
  all.set(pcm, lead.length);
  const speechEndOffset = lead.length + speechEndByte(pcm);
  const t0 = Date.now();
  const speechEndAt = t0 + (speechEndOffset / 32000) * 1000;
  for (let k = 0, off = 0; off < all.length; k++, off += CHUNK) {
    const due = t0 + (k + 1) * 100;
    const wait = due - Date.now();
    if (wait > 0) await sleep(wait);
    sock.sendAudio(Buffer.from(all.subarray(off, Math.min(off + CHUNK, all.length))).toString('base64'));
  }
  return { speechEndAt, startedAt: t0 };
}

function wav24k(pcmParts) {
  const len = pcmParts.reduce((n, p) => n + p.length, 0);
  const buf = Buffer.alloc(44 + len);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + len, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(24000, 24);
  buf.writeUInt32LE(48000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36);
  buf.writeUInt32LE(len, 40);
  let o = 44;
  for (const p of pcmParts) { Buffer.from(p).copy(buf, o); o += p.length; }
  return buf;
}

// Records the raw server messages (types, language codes, errors) without touching the socket logic.
function loggingSocketFactory(raws) {
  class LoggingWS extends WebSocket {
    set onmessage(fn) {
      super.onmessage = (ev) => {
        try {
          const m = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
          raws.push({ t: Date.now(), type: m.message_type, text: m.text, lang: m.language_code, error: m.error });
        } catch (_) { /* binary / non-JSON */ }
        if (fn) fn(ev);
      };
    }
    get onmessage() { return super.onmessage; }
  }
  return (url) => new LoggingWS(url);
}

function makeSocket(settings, dir, lang, handlers, raws) {
  return new SttSocket({
    label: dir === 'in' ? 'gelen ses' : 'mikrofon',
    lang: dir === 'in' ? lang : 'en',
    secondaryLanguages: dir === 'in' ? ['en'] : [], // same as offscreen.js: SELF speaks English
    silenceSecs: dir === 'in' ? 0.8 : 0.7,
    keyterms: settings.glossary,
    filterBackgroundAudio: dir === 'out',
    getToken: (signal) => fetchRealtimeToken(settings.elevenKey, signal),
    createWebSocket: loggingSocketFactory(raws),
    ...handlers,
  });
}

// ---- 2. STT probe -------------------------------------------------------------------------------

async function sttProbe(settings, dir, lang, pcm) {
  const raws = [];
  const events = [];
  let readyAt = 0;
  let fatal = null;
  const t0 = Date.now();
  const sock = makeSocket(settings, dir, lang, {
    onPartial: (text, meta) => events.push({ kind: 'partial', t: Date.now(), text, lang: meta && meta.lang }),
    onCommitted: (text, meta) => events.push({ kind: 'commit', t: Date.now(), text, lang: meta && meta.lang }),
    onReady: () => { if (!readyAt) readyAt = Date.now(); },
    onReconnecting: (n) => events.push({ kind: 'reconnecting', t: Date.now(), n }),
    onFatal: (reason) => { fatal = reason; },
  }, raws);
  sock.connect();
  await waitFor(() => readyAt || fatal, 15000);
  if (!readyAt) {
    sock.close();
    return { dir, fatal: fatal || 'oturum açılamadı (15 sn)', raws, events, dropped: [...(sock.dropped || [])] };
  }
  const { speechEndAt } = await streamLive(sock, pcm, 3);
  await waitFor(() => events.some((e) => e.kind === 'commit'), 4000);
  sock.close();
  const firstPartial = events.find((e) => e.kind === 'partial');
  const commit = events.find((e) => e.kind === 'commit');
  return {
    dir, connectMs: readyAt - t0, dropped: [...(sock.dropped || [])], raws, events,
    firstPartialMs: firstPartial ? firstPartial.t - t0 : null,
    commitAfterSpeechMs: commit ? commit.t - speechEndAt : null,
    commit,
    partialSample: events.filter((e) => e.kind === 'partial').slice(-1)[0],
  };
}

function reportStt(r) {
  log(`\n  [${r.dir === 'in' ? 'GELEN (tr)' : 'GİDEN (en)'}]`);
  if (r.fatal) log(`  ✗ ${r.fatal}`);
  if (r.dropped.length) log(`  ⚠ Sunucunun reddettiği isteğe bağlı parametreler: ${r.dropped.join(', ')}`);
  else if (!r.fatal) log('  ✓ Tüm parametreler kabul edildi (dil algılama, ikincil dil, no_verbatim, terimler, arka plan filtresi).');
  if (r.connectMs != null) log(`  bağlantı: ${sec(r.connectMs)}`);
  if (r.partialSample) log(`  son ara metin: "${r.partialSample.text}" (dil: ${r.partialSample.lang ?? 'yok'})`);
  if (r.commit) log(`  kesin metin: "${r.commit.text}" (dil: ${r.commit.lang ?? 'yok'})`);
  log(`  konuşma bitti → kesin metin: ${sec(r.commitAfterSpeechMs)}`);
  const types = {};
  for (const m of r.raws) types[m.type] = (types[m.type] || 0) + 1;
  log(`  sunucu mesajları: ${Object.entries(types).map(([k, v]) => `${k}×${v}`).join(', ')}`);
  const langs = [...new Set(r.raws.filter((m) => m.lang !== undefined).map((m) => String(m.lang)))];
  if (langs.length) log(`  ham dil kodları: ${langs.join(', ')}`);
  const errs = r.raws.filter((m) => m.error);
  for (const e of errs) log(`  sunucu hatası: ${e.type}: ${e.error}`);
}

// ---- 3. Claude model comparison -------------------------------------------------------------------

const PROBES = [
  { src: 'English', dst: 'Turkish', speaker: 'SELF', text: 'so um yeah I think we could probably ship the first version by the end of next month if the budget gets approved' },
  { src: 'Turkish', dst: 'English', speaker: 'OTHERS', text: 'peki fiyatlandırma konusunda ne düşünüyorsunuz yani kurumsal paket için ayrı bir indirim olacak mı' },
  { src: 'English', dst: 'Turkish', speaker: 'SELF', text: 'Could you send me the contract today?' },
];

function probeSystem(p) {
  return [
    'You are a professional simultaneous interpreter working live in a video meeting between SELF (the person using this interpreter) and OTHERS (the other participants).',
    `Translate the latest utterance from ${p.src} into ${p.dst}.`,
    'The input is an automatic speech-recognition transcript of live speech. It may contain recognition errors, missing punctuation, filler words, false starts, repetitions, and sentences cut off at a pause.',
    `- Say what a skilled human interpreter would say: fluent, natural spoken ${p.dst} that carries the speaker's meaning, tone and intent.`,
    '- Silently fix obvious recognition errors using the conversation context. Drop fillers, false starts and stutters.',
    `- When addressing the listener, use the polite/formal form of "you" where ${p.dst} distinguishes it.`,
    '- Output only the translation as plain text: no quotes, labels, notes, markdown or explanations.',
  ].join('\n');
}

const MODEL_CONFIGS = [
  { name: 'Opus 5.5 + hızlı mod', model: 'claude-opus-5-5', fast: true },
  { name: 'Opus 5.5', model: 'claude-opus-5-5', fast: false },
  { name: 'Sonnet 5.5 (düşünme kapalı)', model: 'claude-sonnet-5-5' },
  { name: 'Haiku 5.5 (düşünme kapalı)', model: 'claude-haiku-5-5' },
];

function modelRequest(cfg, p) {
  const base = {
    model: cfg.model,
    max_tokens: 1024,
    output_config: { effort: 'low' },
    system: probeSystem(p),
    messages: [{ role: 'user', content: `<utterance speaker="${p.speaker}" language="${p.src}">\n${p.text}\n</utterance>` }],
  };
  if (cfg.model === 'claude-haiku-5-5') return { beta: false, body: { ...base, thinking: { type: 'disabled' } } };
  const body = { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
  if (cfg.model === 'claude-sonnet-5-5') body.thinking = { type: 'between_tools' };
  if (cfg.fast) body.speed = 'fast';
  return { beta: true, body };
}

async function timeOne(client, cfg, p) {
  const { beta, body } = modelRequest(cfg, p);
  const t0 = performance.now();
  let first = null;
  const stream = beta ? client.beta.messages.stream(body) : client.messages.stream(body);
  stream.on('text', () => { if (first === null) first = performance.now() - t0; });
  const msg = await stream.finalMessage();
  const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
  return { ttft: first, total: performance.now() - t0, text, speed: msg.usage && msg.usage.speed };
}

async function modelComparison(settings) {
  log('\n━━ 3) Claude model karşılaştırması (her model: 1 ısınma + 3 cümle) ━━');
  const client = new Anthropic({ apiKey: settings.anthropicKey, maxRetries: 0, timeout: 30000 });
  const rows = [];
  for (const cfg of MODEL_CONFIGS) {
    try {
      await timeOne(client, cfg, PROBES[2]); // warm the connection; not counted
      const res = [];
      for (const p of PROBES) res.push(await timeOne(client, cfg, p));
      const avg = (k) => res.reduce((n, r) => n + (r[k] || 0), 0) / res.length;
      rows.push({ cfg, ttft: avg('ttft'), total: avg('total'), res });
      log(`\n  ${cfg.name}: ilk kelime ort. ${sec(avg('ttft'))}, tam çeviri ort. ${sec(avg('total'))}${res[0].speed ? ` (speed: ${res[0].speed})` : ''}`);
      res.forEach((r, i) => log(`    ${i + 1}. ${r.text}`));
    } catch (e) {
      rows.push({ cfg, error: e });
      log(`\n  ${cfg.name}: ✗ ${e.status ? `HTTP ${e.status} ` : ''}${String(e.message || e).slice(0, 220)}`);
    }
  }
  return rows;
}

// ---- 4. end to end ------------------------------------------------------------------------------

async function endToEnd(settings, samples) {
  log('\n━━ 4) Uçtan uca: konuşma tanıma → çeviri → altyazı / seslendirme ━━');
  const lang = 'tr';
  const ctrl = new AbortController();
  const emitted = [];
  let fatal = null;
  const core = createEngineCore({
    settings,
    lang,
    emit: (m) => emitted.push({ t: Date.now(), m }),
    signal: ctrl.signal,
    onFatal: (r) => { fatal = r; },
    onSoftError: (e) => emitted.push({ t: Date.now(), m: { type: 'soft-error', message: String((e && e.message) || e) } }),
  });
  const w0 = Date.now();
  try {
    await core.warmup();
  } catch (e) {
    die(`warmup başarısız: ${e.message}`);
  }
  log(`  ısınma (anahtar/model/ses kontrolü): ${sec(Date.now() - w0)}`);

  const ready = { in: 0, out: 0 };
  const raws = [];
  const wire = (dir, pipe) => makeSocket(settings, dir, lang, {
    onPartial: (t, m) => pipe.partial(t, m),
    onCommitted: (t, m) => pipe.commit(t, m),
    onReady: () => { if (!ready[dir]) ready[dir] = Date.now(); },
    onReconnecting: () => {},
    onFatal: (r) => { fatal = r; },
  }, raws);
  const inSock = wire('in', core.inPipe);
  const outSock = wire('out', core.outPipe);
  inSock.connect();
  outSock.connect();
  await waitFor(() => (ready.in && ready.out) || fatal, 15000);
  if (fatal) die(`motor durdu: ${fatal}`);

  // Incoming: the other side speaks Turkish.
  const inRun = await streamLive(inSock, samples.tr, 3);
  const inFinal = () => emitted.find((e) => e.m.type === 'caption' && e.m.dir === 'in' && !e.m.partial && (e.m.translated || e.m.failed || e.m.skipped));
  await waitFor(() => inFinal() || fatal, 15000);

  // Outgoing: I speak English; the translation is spoken in Turkish.
  const outRun = await streamLive(outSock, samples.en, 3);
  const outEnd = () => emitted.find((e) => e.m.type === 'tts-end');
  await waitFor(() => outEnd() || fatal, 25000);

  // Echo: the other side's Turkish leaks into my mic (laptop speakers). The mic copy goes through the
  // same echo gate as offscreen.js; nothing of it may be translated and spoken back.
  const outBefore = emitted.filter((e) => e.m.type === 'tts-end').length;
  const capsOf = (dir) => emitted.filter((e) => e.m.type === 'caption' && e.m.dir === dir);
  const outCapsBefore = capsOf('out').length;
  {
    const lead = new Uint8Array(CHUNK * 3);
    const tail = new Uint8Array(CHUNK * 30);
    const all = new Uint8Array(lead.length + samples.tr.length + tail.length);
    all.set(samples.tr, lead.length);
    const t0 = Date.now();
    let gated = 0;
    for (let k = 0, off = 0; off < all.length; k++, off += CHUNK) {
      const due = t0 + (k + 1) * 100;
      if (due > Date.now()) await sleep(due - Date.now());
      const b64 = Buffer.from(all.subarray(off, Math.min(off + CHUNK, all.length))).toString('base64');
      inSock.sendAudio(b64);
      // the mic hears it ~50 ms later and quieter
      const pcm = new Int16Array(all.buffer.slice(off, Math.min(off + CHUNK, all.length)));
      for (let i = 0; i < pcm.length; i++) pcm[i] = pcm[i] >> 2;
      if (echoGated(inSock, settings, Date.now())) { gated++; outSock.sendAudio(SILENCE_CHUNK_B64); }
      else outSock.sendAudio(Buffer.from(pcm.buffer).toString('base64'));
    }
    await sleep(3000);
    const leaked = capsOf('out').slice(outCapsBefore).filter((e) => !e.m.partial && e.m.translated && !e.m.skipped);
    const spoken = emitted.filter((e) => e.m.type === 'tts-end').length - outBefore;
    log('\n  [YANKI] Karşı tarafın sesi mikrofona da kaçıyor');
    log(`  mikrofon parçalarının ${gated} tanesi yankı koruması ile susturuldu`);
    log(leaked.length || spoken ? `  ✗ GERİ GÖNDERİLDİ: ${leaked.map((e) => `"${e.m.original}"`).join(', ')}` : '  ✓ karşı tarafa hiçbir şey geri gönderilmedi');
  }

  inSock.close();
  outSock.close();
  core.dispose();
  ctrl.abort();

  const caps = (dir) => emitted.filter((e) => e.m.type === 'caption' && e.m.dir === dir);
  const firstDraft = caps('in').find((e) => e.m.draft);
  const inCommit = caps('in').find((e) => !e.m.partial && !e.m.translated);
  const fin = inFinal();
  const speechStart = (run) => run.startedAt + 300; // 0.3 s lead-in silence
  const finals = (dir) => caps(dir).filter((e) => !e.m.partial && e.m.translated);
  log('\n  [GELEN] Türkçe konuşma (2 cümle) → İngilizce altyazı');
  if (firstDraft) log(`  ilk taslak altyazı: konuşma başladıktan ${sec(firstDraft.t - speechStart(inRun))} sonra: "${firstDraft.m.translated}"`);
  const inFinals = finals('in');
  log(`  kesin çeviri sayısı: ${inFinals.length} (cümle cümle: ${inFinals.length > 1 ? 'evet' : 'hayır'})`);
  if (inFinals[0]) log(`  konuşma başladı → ilk kesin çeviri: ${sec(inFinals[0].t - speechStart(inRun))}: "${inFinals[0].m.translated}"`);
  log(`  konuşma bitti → kesin metin: ${sec(inCommit ? inCommit.t - inRun.speechEndAt : null)}`);
  log(`  konuşma bitti → kesin çeviri: ${sec(fin ? fin.t - inRun.speechEndAt : null)}`);
  if (fin) log(`  "${fin.m.original}"\n   → "${fin.m.translated || '(çevrilemedi)'}"${fin.m.lang ? ` [${fin.m.lang}]` : ''}`);

  const outCommit = caps('out').find((e) => !e.m.partial && !e.m.translated);
  const outFinal = caps('out').find((e) => !e.m.partial && (e.m.translated || e.m.failed || e.m.skipped || e.m.stale));
  const firstAudio = emitted.find((e) => e.m.type === 'tts-chunk');
  const chunks = emitted.filter((e) => e.m.type === 'tts-chunk').map((e) => Buffer.from(e.m.b64, 'base64'));
  log('\n  [GİDEN] İngilizce konuşma (2 cümle) → Türkçe ses');
  const outFinals = finals('out');
  log(`  kesin çeviri sayısı: ${outFinals.length} (cümle cümle: ${outFinals.length > 1 ? 'evet' : 'hayır'})`);
  if (firstAudio) log(`  konuşma başladı → ilk ses karşıya gidiyor: ${sec(firstAudio.t - speechStart(outRun))}`);
  log(`  konuşma bitti → kesin metin: ${sec(outCommit ? outCommit.t - outRun.speechEndAt : null)}`);
  log(`  konuşma bitti → çeviri hazır: ${sec(outFinal ? outFinal.t - outRun.speechEndAt : null)}`);
  log(`  konuşma bitti → ilk ses karşıya gidiyor: ${sec(firstAudio ? firstAudio.t - outRun.speechEndAt : null)}`);
  if (outFinal) log(`  "${outFinal.m.original}"\n   → "${outFinal.m.translated || '(yok)'}"`);
  for (const e of emitted.filter((x) => x.m.type === 'metrics')) log(`  metrik: ${JSON.stringify(e.m)}`);
  for (const e of emitted.filter((x) => x.m.type === 'soft-error')) log(`  ⚠ cümle hatası: ${e.m.message}`);
  if (chunks.length) {
    mkdirSync(OUT_DIR, { recursive: true });
    const f = path.join(OUT_DIR, 'giden-ceviri.wav');
    writeFileSync(f, wav24k(chunks));
    log(`  karşı tarafın duyacağı ses kaydedildi: ${f}`);
  }
  if (fatal) log(`  ✗ motor hatası: ${fatal}`);
  return { emitted, fatal };
}

// ---- main ---------------------------------------------------------------------------------------

const settings = loadSettings();
const fastShown = settings.fastMode && /opus|fable/.test(settings.claudeModel) ? ' (hızlı mod)' : '';
log(`Ayarlar: ${settings.claudeModel}${fastShown}, TTS ${settings.ttsModel}, taslak altyazı ${settings.liveDrafts ? 'açık' : 'kapalı'}`);

let samples = null;
if (only === 'all' || only === 'stt' || only === 'e2e') {
  log('\n━━ 1) Örnek konuşmalar üretiliyor (ElevenLabs) ━━');
  samples = { tr: await synth(settings, SAMPLES.tr, 'tr'), en: await synth(settings, SAMPLES.en, 'en') };
  log(`  ✓ Türkçe ${sec(samples.tr.length / 32)} ve İngilizce ${sec(samples.en.length / 32)} ses hazır.`);
}
if (only === 'all' || only === 'stt') {
  log('\n━━ 2) Konuşma tanıma (Scribe v3 Live) gerçek zamanlı test ━━');
  reportStt(await sttProbe(settings, 'in', 'tr', samples.tr));
  reportStt(await sttProbe(settings, 'out', 'tr', samples.en));
}
if (only === 'all' || only === 'models') await modelComparison(settings);
if (only === 'all' || only === 'e2e') await endToEnd(settings, samples);
log('\nBitti.');
process.exit(0);
