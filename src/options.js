// Options page (bundled by esbuild because the connection test uses the Anthropic SDK).
import Anthropic from '@anthropic-ai/sdk';

const MT = self.MT;
const $ = (id) => document.getElementById(id);
const SELECTS = ['claudeModel', 'ttsModel', 'formality', 'speakerGender', 'originalVoice', 'incomingSource', 'captionSize'];
const CHECKS = ['fastMode', 'liveDrafts', 'showLatency'];
const ELEVEN = 'https://api.elevenlabs.io';

let env = {};

function setSelect(id, value) {
  const el = $(id);
  el.value = value;
  if (el.value !== value) el.value = MT.DEFAULTS[id];
}

async function load() {
  env = await MT.loadEnv();
  const { settings: stored = {} } = await chrome.storage.local.get('settings');
  const s = MT.merge(env, stored);

  // Keys: only ever show what the user typed here; a .env key is indicated, never echoed into the field.
  for (const k of ['elevenKey', 'anthropicKey']) {
    $(k).value = typeof stored[k] === 'string' ? stored[k] : '';
    $(k + 'Env').hidden = !env[k];
  }
  $('voiceId').value = s.voiceId;
  $('voiceIdEnv').hidden = !(env.voiceId && !(stored.voiceId && stored.voiceId.trim()));
  for (const id of SELECTS) setSelect(id, s[id]);
  for (const id of CHECKS) $(id).checked = !!s[id];
  $('headphones').checked = s.echoGuard === false; // "Kulaklık kullanıyorum" = echo guard off
  $('glossary').value = (s.glossary || []).join('\n');
}

// Only the values that differ from defaults <- .env are stored (MT.overrides): a field still showing its
// .env / default value keeps following .env instead of being pinned by this save.
function readForm() {
  const form = {};
  for (const k of ['elevenKey', 'anthropicKey', 'voiceId']) form[k] = $(k).value.trim();
  for (const id of SELECTS) form[id] = $(id).value;
  for (const id of CHECKS) form[id] = $(id).checked;
  form.echoGuard = !$('headphones').checked;
  form.glossary = $('glossary').value.split(/\r?\n/).map((t) => t.trim()).filter(Boolean);
  return MT.overrides(env, form);
}

let hideTimer = null;
$('form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await chrome.storage.local.set({ settings: readForm() });
  await load();
  const saved = $('saved');
  saved.classList.add('show');
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => saved.classList.remove('show'), 2000);
});

// ---- connection test -------------------------------------------------------------------------

const results = $('results');
function report(kind, text) {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = (kind === 'ok' ? '✓ ' : kind === 'bad' ? '✗ ' : '⚠ ') + text;
  results.appendChild(li);
}
const secs = (ms) => (ms / 1000).toFixed(1).replace('.', ',') + ' sn';

async function testEleven(s) {
  if (!s.elevenKey) return report('bad', 'ElevenLabs anahtarı yok.');
  const headers = { 'xi-api-key': s.elevenKey };
  try {
    const r = await fetch(`${ELEVEN}/v1/single-use-token/realtime_scribe`, { method: 'POST', headers });
    if (r.ok) report('ok', 'ElevenLabs konuşma tanıma erişimi tamam.');
    else if (r.status === 401) return report('bad', 'ElevenLabs anahtarı geçersiz (HTTP 401).');
    else report('bad', `ElevenLabs konuşma tanıma hatası (HTTP ${r.status}).`);
  } catch (e) {
    return report('bad', 'ElevenLabs sunucusuna ulaşılamadı: ' + e.message);
  }

  try {
    const r = await fetch(`${ELEVEN}/v1/voices/${encodeURIComponent(s.voiceId)}`, { headers });
    if (r.ok) {
      const v = await r.json().catch(() => ({}));
      report('ok', `Ses bulundu: ${v.name || s.voiceId}.`);
    } else if (r.status === 404) {
      report('bad', 'Ses kimliği (Voice ID) bulunamadı.');
    } else {
      const body = await r.text().catch(() => '');
      if (/missing_permissions/i.test(body)) report('warn', 'Anahtarın ses listesini okuma izni yok; ses kimliği doğrulanamadı.');
      else report('warn', `Ses kontrol edilemedi (HTTP ${r.status}).`);
    }
  } catch (_) { /* reported by the TTS check below */ }

  try {
    const t0 = performance.now();
    const r = await fetch(`${ELEVEN}/v1/text-to-speech/${encodeURIComponent(s.voiceId)}/stream?output_format=pcm_24000`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: 'Test.', model_id: s.ttsModel }),
    });
    if (!r.ok) {
      const body = await r.text().catch(() => '');
      return report('bad', `Ses üretimi başarısız (HTTP ${r.status}) ${body.slice(0, 140)}`);
    }
    const reader = r.body.getReader();
    await reader.read();
    const first = performance.now() - t0;
    reader.cancel().catch(() => {});
    report('ok', `Ses üretimi çalışıyor (${s.ttsModel}); ilk ses ${secs(first)}.`);
  } catch (e) {
    report('bad', 'Ses üretimi test edilemedi: ' + e.message);
  }
}

function translateRequest(s, fast) {
  const base = {
    model: s.claudeModel,
    max_tokens: 200,
    system: 'Translate the user text from English into Turkish. Output only the translation.',
    messages: [{ role: 'user', content: 'Hello, can you hear me clearly?' }],
    output_config: { effort: 'low' },
  };
  if (s.claudeModel === 'claude-haiku-5-5') return { beta: false, body: { ...base, thinking: { type: 'disabled' } } };
  const body = { ...base, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };
  if (s.claudeModel === 'claude-sonnet-5-5') body.thinking = { type: 'between_tools' };
  else if (fast) body.speed = 'fast';
  return { beta: true, body };
}

async function testAnthropic(s) {
  if (!s.anthropicKey) return report('bad', 'Anthropic anahtarı yok.');
  const client = new Anthropic({ apiKey: s.anthropicKey, dangerouslyAllowBrowser: true, maxRetries: 0, timeout: 20000 });
  try {
    const m = await client.models.retrieve(s.claudeModel);
    report('ok', `Claude modeline erişim tamam: ${m.display_name || s.claudeModel}.`);
  } catch (e) {
    if (e.status === 401) return report('bad', 'Anthropic anahtarı geçersiz (HTTP 401).');
    if (e.status === 404) return report('bad', `Model bulunamadı: ${s.claudeModel}.`);
    if (e.status === 403) return report('bad', 'Bu anahtarın modele erişim izni yok (HTTP 403).');
    return report('bad', 'Anthropic hatası: ' + e.message);
  }

  let fast = s.fastMode && /opus|fable/.test(s.claudeModel);
  for (let attempt = 0; attempt < 2; attempt++) {
    const { beta, body } = translateRequest(s, fast);
    const t0 = performance.now();
    try {
      const res = beta ? await client.beta.messages.create(body) : await client.messages.create(body);
      const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      const note = fast ? ' (hızlı mod)' : '';
      report('ok', `Çeviri testi${note}: "${text}" – ${secs(performance.now() - t0)}.`);
      return;
    } catch (e) {
      if (fast && (e.status === 429 || (e.status === 400 && /speed|fast/i.test(e.message)))) {
        report('warn', 'Hızlı mod bu hesapta kullanılamıyor; normal hızda deneniyor.');
        fast = false;
        continue;
      }
      if (e.status === 400 && /credit balance/i.test(e.message)) return report('bad', 'Anthropic bakiyeniz yetersiz.');
      return report('bad', 'Çeviri testi başarısız: ' + e.message);
    }
  }
}

$('test').addEventListener('click', async () => {
  const btn = $('test');
  btn.disabled = true;
  results.textContent = '';
  try {
    const s = MT.merge(env, readForm());
    await Promise.all([testEleven(s), testAnthropic(s)]);
  } finally {
    btn.disabled = false;
  }
});

load();
