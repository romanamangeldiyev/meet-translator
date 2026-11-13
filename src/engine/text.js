// Text helpers: normalization, word similarity (echo guard / speculation) and a streaming
// sentence splitter for early speech. Pure functions, no I/O.

/** Lowercase, strip punctuation (\p{P}) and combining marks, collapse whitespace. */
export function normText(s) {
  if (typeof s !== 'string' || !s) return '';
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\p{M}+/gu, '')
    .replace(/\p{P}+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(s) {
  const n = normText(s);
  return n ? n.split(' ') : [];
}

export function wordCount(s) {
  return words(s).length;
}

/** Trim and collapse whitespace (transcripts can carry stray newlines/tabs). */
export function cleanTranscript(s) {
  return typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '';
}

/** Removes sound tags like "(laughs)", "[music]" or "<noise>" so they are never read aloud. */
export function stripSoundTags(s) {
  return String(s || '').replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

/** True when nothing speakable is left once sound tags like "(laughs)" or "[music]" are removed. */
export function isNonSpeech(s) {
  const stripped = String(s || '').replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}|<[^>]*>/g, ' ');
  return !/[\p{L}\p{N}]/u.test(stripped);
}

/** Share of `a`'s normalized words that also occur in `b` (0..1). */
export function wordOverlap(a, b) {
  const aw = words(a);
  if (!aw.length) return 0;
  const set = new Set(words(b));
  let hit = 0;
  for (const w of aw) if (set.has(w)) hit++;
  return hit / aw.length;
}

const DIGITS_ONLY = /^\p{N}+$/u;

/**
 * Echo guard: `text` has >= minWords words and >= ratio of them appear in one candidate. Tokens made only of
 * digits are ignored on both sides: a repeated phone number, date or amount is the user confirming, not echo.
 */
export function isEchoOf(text, candidates, { minWords = 5, ratio = 0.8 } = {}) {
  const tw = words(text).filter((w) => !DIGITS_ONLY.test(w));
  if (tw.length < minWords) return false;
  for (const c of candidates || []) {
    if (!c) continue;
    const set = new Set(words(c));
    let hit = 0;
    for (const w of tw) if (set.has(w)) hit++;
    if (hit / tw.length >= ratio) return true;
  }
  return false;
}

// ---- sentence splitting ---------------------------------------------------------------------

const TERMINATORS = new Set(['.', '!', '?', '…', ';', '。', '？', '！']);
const FULL_WIDTH = new Set(['。', '？', '！']);
const CLOSERS = new Set(['"', "'", '”', '’', '»', '«', ')', ']', '}', '›', '」', '』']);
const isSpace = (c) => /\s/.test(c);
const isLowerLetter = (c) => c !== c.toUpperCase() && c === c.toLowerCase();

/**
 * Streaming sentence splitter. A boundary is a run of `. ! ? … ; 。 ？ ！` (plus closing quotes or
 * brackets) followed by whitespace or the end of the text. Never inside numbers such as `3.5`
 * (no whitespace after the dot). A `. ! ? …` run followed by a lowercase word is not a boundary
 * (abbreviations like "e.g." / "z.B.", mid-sentence ellipses, ordinals like "3. sırada");
 * `;` always is. Full-width terminators split without whitespace (CJK). Pieces shorter than
 * `minChars` are merged into the next one; end() flushes the rest even when it is short.
 */
export class SentenceSplitter {
  constructor({ minChars = 12 } = {}) {
    this.min = minChars;
    this.buf = '';
    this.start = 0; // start of the piece not emitted yet
    this.scan = 0; // next index to examine
  }

  push(text) {
    if (text) this.buf += text;
    return this._extract(false);
  }

  end() {
    const out = this._extract(true);
    const rest = this.buf.slice(this.start).trim();
    if (rest) out.push(rest);
    this.buf = '';
    this.start = 0;
    this.scan = 0;
    return out;
  }

  _extract(final) {
    const b = this.buf;
    const out = [];
    let i = this.scan;
    while (i < b.length) {
      if (!TERMINATORS.has(b[i])) {
        i++;
        continue;
      }
      let j = i;
      let fullWidth = false;
      let semicolonOnly = true;
      while (j < b.length && TERMINATORS.has(b[j])) {
        if (FULL_WIDTH.has(b[j])) fullWidth = true;
        if (b[j] !== ';') semicolonOnly = false;
        j++;
      }
      while (j < b.length && CLOSERS.has(b[j])) j++;
      if (j >= b.length) {
        if (!final) break; // more text may follow ("3." + "5", "?" + "!")
        i = j; // end of text: the remainder is flushed by end()
        continue;
      }
      let boundary = false;
      if (isSpace(b[j])) {
        let k = j;
        while (k < b.length && isSpace(b[k])) k++;
        if (k >= b.length) {
          if (!final) break; // need the next word to decide
          boundary = true;
        } else {
          boundary = semicolonOnly || fullWidth || !isLowerLetter(b[k]);
        }
      } else if (fullWidth) {
        boundary = true;
      }
      if (boundary) {
        const piece = b.slice(this.start, j).trim();
        if (piece.length >= this.min) {
          out.push(piece);
          this.start = j;
        }
      }
      i = j;
    }
    this.scan = i;
    return out;
  }
}

/** Whole-text convenience wrapper around SentenceSplitter. */
export function splitSentences(text, opts) {
  const s = new SentenceSplitter(opts);
  return [...s.push(text || ''), ...s.end()];
}
