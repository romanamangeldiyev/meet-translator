// Shared conversation memory for both directions: the last committed utterances (prompt context)
// plus a short time-indexed list of incoming originals for the echo guard.
import { LANG_NAMES } from './util.js';

export const CONTEXT_SIZE = 8;
const INCOMING_KEEP_MS = 60000;
const INCOMING_MAX = 64;

const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export class Conversation {
  constructor({ max = CONTEXT_SIZE, now = Date.now } = {}) {
    this.max = max;
    this.now = now;
    this.entries = []; // { dir, original, translated, lang, at }
    this.incoming = []; // { text, at } — incoming originals, newest last
  }

  /** Records a committed utterance and returns its (mutable) entry. */
  add({ dir, original, lang, at }) {
    const entry = { dir, original, translated: null, lang: lang || null, at: Number.isFinite(at) ? at : this.now() };
    this.entries.push(entry);
    while (this.entries.length > this.max) this.entries.shift();
    if (dir === 'in') {
      this.incoming.push({ text: original, at: entry.at });
      const cutoff = this.now() - INCOMING_KEEP_MS;
      while (this.incoming.length && (this.incoming[0].at < cutoff || this.incoming.length > INCOMING_MAX)) {
        this.incoming.shift();
      }
    }
    return entry;
  }

  /** Removes an entry from the prompt context (noise, echo); keeps it for the echo guard. */
  drop(entry) {
    const i = this.entries.indexOf(entry);
    if (i !== -1) this.entries.splice(i, 1);
  }

  /** Context lines: `OTHERS (Turkish): …` / `SELF (English): …` with the original text. */
  render() {
    return this.entries
      .map((e) => `${e.dir === 'out' ? 'SELF' : 'OTHERS'} (${LANG_NAMES[e.lang] || e.lang || 'unknown'}): ${oneLine(e.original)}`)
      .join('\n');
  }

  /** Incoming originals committed at or after `since` (ms timestamp). */
  incomingSince(since) {
    return this.incoming.filter((x) => x.at >= since).map((x) => x.text);
  }
}
