// Pure helpers shared by the engine modules (no chrome.* / DOM access, so they run under node tests).

export class FatalError extends Error {
  constructor(message) {
    super(message);
    this.name = 'FatalError';
    this.fatal = true;
  }
}

export function isAbortError(e) {
  return !!e && (e.name === 'AbortError' || e.code === 'ABORT_ERR' || /aborted/i.test(String(e.message || '')));
}

export const LANG_NAMES = {
  tr: 'Turkish',
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  ru: 'Russian',
  pt: 'Portuguese',
};

// ISO 639-1, ISO 639-3 (incl. the bibliographic fre/ger) and plain names -> one of the 8 codes.
const LANG_ALIASES = {
  tr: ['tr', 'tur', 'turkish', 'türkçe', 'turkce'],
  en: ['en', 'eng', 'english'],
  es: ['es', 'spa', 'spanish', 'español', 'espanol'],
  fr: ['fr', 'fra', 'fre', 'french', 'français', 'francais'],
  de: ['de', 'deu', 'ger', 'german', 'deutsch'],
  it: ['it', 'ita', 'italian', 'italiano'],
  ru: ['ru', 'rus', 'russian'],
  pt: ['pt', 'por', 'portuguese', 'português', 'portugues'],
};
const LANG_LOOKUP = new Map();
for (const [code, aliases] of Object.entries(LANG_ALIASES)) {
  for (const a of aliases) LANG_LOOKUP.set(a, code);
}

/**
 * Normalizes a language code (ISO 639-1 / 639-3 / BCP47 such as `en-US` or `pt_BR`, any case)
 * to 'tr'|'en'|'es'|'fr'|'de'|'it'|'ru'|'pt', or null when it is none of those.
 */
export function normalizeLang(code) {
  if (typeof code !== 'string') return null;
  const s = code.trim().toLowerCase();
  if (!s) return null;
  const direct = LANG_LOOKUP.get(s);
  if (direct) return direct;
  return LANG_LOOKUP.get(s.split(/[-_\s]/)[0]) || null;
}

/**
 * A child AbortController that aborts when `parent` aborts. Call release() when done so
 * long-lived parent signals do not collect listeners.
 */
export function childAbort(parent) {
  const controller = new AbortController();
  if (!parent) return { controller, signal: controller.signal, release() {} };
  if (parent.aborted) {
    controller.abort();
    return { controller, signal: controller.signal, release() {} };
  }
  const onAbort = () => controller.abort();
  parent.addEventListener('abort', onAbort);
  return {
    controller,
    signal: controller.signal,
    release: () => parent.removeEventListener('abort', onAbort),
  };
}

export function abortError(message = 'The operation was aborted.') {
  const e = new Error(message);
  e.name = 'AbortError';
  return e;
}

/** Float32 [-1, 1] -> Int16 PCM. */
export function floatToPcm16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff);
  }
  return out;
}

/**
 * Streaming box-filter downsampler (keeps fractional position between calls so
 * frame boundaries do not glitch). Input Float32 at `inRate`, output Float32 at `outRate`.
 */
export class Downsampler {
  constructor(inRate, outRate = 16000) {
    this.ratio = inRate / outRate;
    this.sum = 0;
    this.count = 0;
    this.pos = 0;
  }

  process(input) {
    if (this.ratio <= 1) {
      // Equal rate (or upsampling request, which we do not support): pass through.
      return Float32Array.from(input);
    }
    const out = [];
    for (let i = 0; i < input.length; i++) {
      this.sum += input[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        out.push(this.sum / this.count);
        this.sum = 0;
        this.count = 0;
        this.pos -= this.ratio;
      }
    }
    return Float32Array.from(out);
  }
}

/** Collects Int16 samples and emits fixed-size-or-larger chunks as bytes. */
export class SampleBatcher {
  constructor(minSamples, onChunk) {
    this.min = minSamples;
    this.onChunk = onChunk;
    this.parts = [];
    this.n = 0;
  }

  push(int16) {
    if (!int16.length) return;
    this.parts.push(int16);
    this.n += int16.length;
    if (this.n >= this.min) this.flush();
  }

  flush() {
    if (!this.n) return;
    const all = new Int16Array(this.n);
    let o = 0;
    for (const p of this.parts) {
      all.set(p, o);
      o += p.length;
    }
    this.parts = [];
    this.n = 0;
    this.onChunk(all);
  }
}

/** Uint8Array -> base64, chunked so large arrays never blow the argument limit. */
export function bytesToBase64(bytes) {
  let bin = '';
  const STEP = 0x8000;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Int16Array (platform endianness; every Chrome target is little-endian) -> base64. */
export function pcm16ToBase64(int16) {
  return bytesToBase64(new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength));
}

/**
 * Splits a byte stream into even-length pieces, carrying a trailing odd byte to the next push
 * (PCM16 samples are 2 bytes; a network read can end mid-sample).
 */
export class EvenChunker {
  constructor() {
    this.carry = null;
  }

  push(bytes) {
    let data = bytes;
    if (this.carry !== null) {
      data = new Uint8Array(bytes.length + 1);
      data[0] = this.carry;
      data.set(bytes, 1);
      this.carry = null;
    }
    if (data.length % 2 === 1) {
      this.carry = data[data.length - 1];
      data = data.subarray(0, data.length - 1);
    }
    return data.length ? data : null;
  }
}
