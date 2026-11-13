// .env parsing shared by build.mjs and the live test.

// .env name -> settings field (see src/defaults.js)
export const ENV_MAP = {
  ELEVENLABS_API_KEY: ['elevenKey', 'string'],
  ANTHROPIC_API_KEY: ['anthropicKey', 'string'],
  CLAUDE_MODEL: ['claudeModel', 'string'],
  FAST_MODE: ['fastMode', 'bool'],
  LIVE_DRAFTS: ['liveDrafts', 'bool'],
  TTS_MODEL: ['ttsModel', 'string'],
  VOICE_ID: ['voiceId', 'string'],
  FORMALITY: ['formality', 'string'],
  SPEAKER_GENDER: ['speakerGender', 'string'],
  GLOSSARY: ['glossary', 'list'],
  ORIGINAL_VOICE: ['originalVoice', 'string'],
  ECHO_GUARD: ['echoGuard', 'bool'],
  INCOMING_SOURCE: ['incomingSource', 'string'],
  CAPTION_SIZE: ['captionSize', 'string'],
  SHOW_LATENCY: ['showLatency', 'bool'],
};

export function parseDotEnv(text) {
  const out = {};
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Quoted value, optionally followed by a comment: KEY="value"  # note
    const quoted = value.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    if (quoted) {
      value = quoted[2];
    } else {
      value = value.replace(/\s+#.*$/, ''); // trailing comment on an unquoted value
    }
    out[m[1]] = value;
  }
  return out;
}

export function envToSettings(vars) {
  const settings = {};
  for (const [name, [field, kind]] of Object.entries(ENV_MAP)) {
    const v = vars[name];
    if (v === undefined || v.trim() === '') continue;
    if (kind === 'bool') settings[field] = /^(1|true|yes|on|evet)$/i.test(v.trim());
    else if (kind === 'list') settings[field] = v.split(/[,;|]/).map((t) => t.trim()).filter(Boolean);
    else settings[field] = v.trim();
  }
  return settings;
}
