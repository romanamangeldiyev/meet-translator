// Shared defaults + settings loader for the service worker (importScripts), popup and options page.
// Effective settings = defaults <- dist/env.json (built from .env) <- options page (non-empty values win).
(function (root) {
  'use strict';

  const LANGS = [
    ['tr', 'Türkçe'], ['en', 'English'], ['es', 'Español'], ['fr', 'Français'],
    ['de', 'Deutsch'], ['it', 'Italiano'], ['ru', 'Русский'], ['pt', 'Português'],
  ];

  const DEFAULTS = {
    elevenKey: '',
    anthropicKey: '',
    claudeModel: 'claude-haiku-5-5',
    fastMode: true,
    liveDrafts: true,
    ttsModel: 'eleven_v4_turbo',
    voiceId: '21m00Tcm4TlvDq8ikWAM',
    formality: 'formal',
    speakerGender: '',
    glossary: [],
    originalVoice: 'off',
    echoGuard: true, // false = the user wears headphones: no echo gating of the mic (options: "Kulaklık kullanıyorum")
    incomingSource: 'tab',
    captionSize: 'm',
    showLatency: true,
  };

  const CHOICES = {
    claudeModel: ['claude-opus-5-5', 'claude-fable-5-2', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    ttsModel: ['eleven_v4_turbo', 'eleven_flash_v2_5', 'eleven_v3'],
    formality: ['formal', 'informal'],
    speakerGender: ['', 'male', 'female'],
    originalVoice: ['off', 'low'],
    incomingSource: ['page', 'tab'],
    captionSize: ['s', 'm', 'l'],
  };

  // A stored value counts only if it is a real choice: empty strings / empty lists fall through to .env and defaults.
  function isSet(key, v) {
    if (v === undefined || v === null) return false;
    if (typeof DEFAULTS[key] === 'boolean') return typeof v === 'boolean';
    if (Array.isArray(DEFAULTS[key])) return Array.isArray(v) && v.length > 0;
    if (typeof v !== 'string') return false;
    if (CHOICES[key]) return CHOICES[key].includes(v) && (v !== '' || key === 'speakerGender');
    return v.trim() !== '';
  }

  function merge(env, stored) {
    const out = { ...DEFAULTS };
    for (const layer of [env || {}, stored || {}]) {
      for (const key of Object.keys(DEFAULTS)) {
        if (isSet(key, layer[key])) out[key] = Array.isArray(layer[key]) ? layer[key].slice() : layer[key];
      }
    }
    out.glossary = (out.glossary || []).map((t) => String(t).trim()).filter(Boolean).slice(0, 200);
    return out;
  }

  // What the options page stores: only the values that differ from the base layer (defaults <- .env).
  // A field left at its .env / default value stays unset, so it keeps following .env edits and default
  // changes instead of being pinned by the first "Kaydet". Typed API keys are always kept.
  function overrides(env, form) {
    const base = merge(env, {});
    const out = {};
    for (const key of Object.keys(DEFAULTS)) {
      const v = form ? form[key] : undefined;
      if (!isSet(key, v)) continue;
      if (key === 'elevenKey' || key === 'anthropicKey') {
        out[key] = v.trim();
      } else if (Array.isArray(DEFAULTS[key])) {
        const list = v.map((t) => String(t).trim()).filter(Boolean);
        if (list.join('\n') !== base[key].join('\n')) out[key] = list;
      } else {
        const val = typeof v === 'string' ? v.trim() : v;
        if (val !== base[key]) out[key] = val;
      }
    }
    return out;
  }

  let envCache = null;
  async function loadEnv() {
    if (envCache) return envCache;
    try {
      const res = await fetch(root.chrome.runtime.getURL('env.json'), { cache: 'no-store' });
      envCache = res.ok ? await res.json() : {};
    } catch (_) {
      envCache = {}; // no .env at build time
    }
    return envCache;
  }

  async function loadSettings() {
    const [env, store] = await Promise.all([loadEnv(), root.chrome.storage.local.get('settings')]);
    return merge(env, store.settings);
  }

  root.MT = { LANGS, DEFAULTS, CHOICES, merge, overrides, loadEnv, loadSettings };
})(typeof self !== 'undefined' ? self : this);
