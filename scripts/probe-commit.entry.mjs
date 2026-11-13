// Live probe (real ElevenLabs APIs, keys from .env, never printed):
//  A) commit_strategy=vad + a client commit:true at a sentence boundary: accepted? how fast?
//  B) commit_strategy=manual with client commits: timing.
//  C) partial cadence and punctuation while speaking.
//  D) TTS time to first byte: eleven_v4_turbo vs eleven_flash_v2_5.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseDotEnv, envToSettings } from './env.mjs';

const env = envToSettings(parseDotEnv(readFileSync(path.join(process.cwd(), '.env'), 'utf8')));
const KEY = env.elevenKey;
const VOICE = env.voiceId || '21m00Tcm4TlvDq8ikWAM';
if (!KEY) { console.error('ELEVENLABS_API_KEY yok'); process.exit(2); }
const API = 'https://api.elevenlabs.io';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CH = 3200;

async function synth(text, lang) {
  const r = await fetch(`${API}/v1/text-to-speech/${VOICE}?output_format=pcm_16000`, {
    method: 'POST', headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: 'eleven_flash_v2_5', language_code: lang }),
  });
  if (!r.ok) throw new Error('tts ' + r.status);
  return new Uint8Array(await r.arrayBuffer());
}
function trimEnd(pcm) {
  const v = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let end = pcm.length;
  for (let i = pcm.length - 2; i >= 0; i -= 2) if (Math.abs(v.getInt16(i, true)) > 520) { end = i + 2; break; }
  return pcm.subarray(0, end);
}
async function token() {
  const r = await fetch(`${API}/v1/single-use-token/realtime_scribe`, { method: 'POST', headers: { 'xi-api-key': KEY } });
  if (!r.ok) throw new Error('token ' + r.status);
  return (await r.json()).token;
}

async function run(label, strategy, s1, s2, { commitAfterS1 = true, finalCommit = false } = {}) {
  const q = new URLSearchParams({ model_id: 'scribe_v3_live', audio_format: 'pcm_16000', commit_strategy: strategy, language_code: 'en', include_language_detection: 'true', no_verbatim: 'true' });
  if (strategy === 'vad') q.set('vad_silence_threshold_secs', '0.8');
  q.set('token', await token());
  const ws = new WebSocket(`wss://api.elevenlabs.io/v1/speech-to-text/realtime?${q}`);
  const ev = [];
  let started = false;
  ws.onmessage = (m) => {
    const o = JSON.parse(m.data);
    ev.push({ t: Date.now(), type: o.message_type, text: o.text, err: o.error });
    if (o.message_type === 'session_started') started = true;
  };
  ws.onclose = (c) => ev.push({ t: Date.now(), type: 'CLOSE', text: String(c.code) });
  for (let i = 0; i < 100 && !started; i++) await sleep(50);
  if (!started) { console.log(label, 'oturum açılamadı', ev); return; }
  const gap = new Uint8Array(CH * 4); // 0.4 s pause between the sentences
  const tail = new Uint8Array(CH * 25);
  const all = new Uint8Array(CH * 2 + s1.length + gap.length + s2.length + tail.length);
  let o = CH * 2;
  all.set(s1, o); const s1End = o + s1.length; o = s1End + gap.length;
  all.set(s2, o); const s2End = o + s2.length;
  const t0 = Date.now();
  const at = (byte) => t0 + (byte / 32000) * 1000;
  let commitSentAt = null;
  let finalCommitAt = null;
  for (let k = 0, off = 0; off < all.length; k++, off += CH) {
    const due = t0 + (k + 1) * 100;
    if (due > Date.now()) await sleep(due - Date.now());
    let commit = false;
    // commit 0.3 s into the pause after sentence 1 (what a client-side "sentence ended" rule would do)
    if (commitAfterS1 && commitSentAt === null && off >= s1End + CH * 3) { commit = true; commitSentAt = Date.now(); }
    if (finalCommit && finalCommitAt === null && off >= s2End + CH * 3) { commit = true; finalCommitAt = Date.now(); }
    if (ws.readyState !== 1) break;
    ws.send(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: Buffer.from(all.subarray(off, Math.min(off + CH, all.length))).toString('base64'), commit, sample_rate: 16000 }));
  }
  await sleep(1500);
  ws.close();
  console.log(`\n=== ${label}`);
  const partials = ev.filter((e) => e.type === 'partial_transcript' && e.text);
  const gaps = partials.slice(1).map((p, i) => p.t - partials[i].t);
  if (gaps.length) console.log(`  ara metin aralığı: ort ${Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length)} ms, en uzun ${Math.max(...gaps)} ms (${partials.length} adet)`);
  const endsDot = partials.filter((p) => /[.?!]$/.test(p.text.trim())).map((p) => `${((p.t - t0) / 1000).toFixed(2)}s "${p.text.slice(-40)}"`);
  console.log(`  noktayla biten ara metinler: ${endsDot.length}`); endsDot.slice(0, 8).forEach((l) => console.log('    ' + l));
  console.log(`  1. cümle sonu: ${((at(s1End) - t0) / 1000).toFixed(2)}s, 2. cümle sonu: ${((at(s2End) - t0) / 1000).toFixed(2)}s, commit gönderildi: ${commitSentAt ? ((commitSentAt - t0) / 1000).toFixed(2) + 's' : '-'}`);
  for (const e of ev.filter((x) => !/partial/.test(x.type))) {
    console.log(`  ${((e.t - t0) / 1000).toFixed(2)}s ${e.type}${e.text ? ` "${e.text}"` : ''}${e.err ? ` ERR ${e.err}` : ''}`);
  }
  const commits = ev.filter((e) => e.type === 'committed_transcript');
  if (commits[0]) console.log(`  → 1. cümle sonu → ilk kesin metin: ${commits[0].t - at(s1End)} ms`);
  if (commits[1]) console.log(`  → 2. cümle sonu → ikinci kesin metin: ${commits[1].t - at(s2End)} ms`);
}

async function ttfb(model, text, lang) {
  const t0 = performance.now();
  const r = await fetch(`${API}/v1/text-to-speech/${VOICE}/stream?output_format=pcm_24000`, {
    method: 'POST', headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, model_id: model, language_code: lang }),
  });
  const rd = r.body.getReader();
  await rd.read();
  const ms = performance.now() - t0;
  rd.cancel().catch(() => {});
  return r.ok ? ms : -r.status;
}

const s1 = trimEnd(await synth('I think we can start with the pricing.', 'en'));
const s2 = trimEnd(await synth('Then we can talk about the delivery dates next week.', 'en'));
await run('A) vad 0.8 + istemci commit (cümle sonunda)', 'vad', s1, s2);
await run('B) manual + istemci commit (her cümle sonunda)', 'manual', s1, s2, { finalCommit: true });
await run('C) yalnız vad 0.8 (bugünkü durum)', 'vad', s1, s2, { commitAfterS1: false });

console.log('\n=== D) TTS ilk ses süresi (Türkçe cümle, 3 deneme)');
const tr = 'Fiyatlandırma konusunda biraz daha bilgi verebilir misiniz?';
for (const m of ['eleven_v4_turbo', 'eleven_flash_v2_5']) {
  await ttfb(m, 'Merhaba.', 'tr'); // warm
  const xs = [];
  for (let i = 0; i < 3; i++) xs.push(await ttfb(m, tr, 'tr'));
  console.log(`  ${m}: ${xs.map((x) => Math.round(x) + ' ms').join(', ')}`);
}
process.exit(0);
