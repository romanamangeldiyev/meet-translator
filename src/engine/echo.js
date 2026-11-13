// Echo gate (real-use bug: the other side's voice leaked from the speakers into the mic and was "translated"
// back to them). While the incoming side is speaking, the mic is replaced by silence for recognition:
//  - incoming voice energy within ECHO_HOLD_MS, AND
//  - either the incoming recognizer produced text within ECHO_TEXT_MS, or this stretch of incoming voice
//    started less than ECHO_ONSET_MS ago (covers the first moments before its first partial),
//  - unless the user already held the floor: their own voice was active right before the incoming voice began
//    (double talk: an "evet" or a cough from the other side must not cut the user's sentence).
// Continuous background noise/music without any recognized text therefore never keeps the mic closed.
// settings.echoGuard === false (headphones) turns it off.
export const ECHO_HOLD_MS = 250;
export const ECHO_TEXT_MS = 1500;
// Covers incoming speech until its first partial arrives (measured live: ~0.5-1 s). Shorter windows let the
// start of every remote sentence leak into the mic again; the double-talk pass above protects a user who
// was already speaking, so the cost of the longer window is small.
export const ECHO_ONSET_MS = 1000;
/** The user's voice within this long before the incoming onset means they hold the floor... */
export const DOUBLE_TALK_MS = 300;
/** ...provided their stretch of voice began at least this long before it (not the echo of that very onset)... */
export const DOUBLE_TALK_LEAD_MS = 200;
/** ...while the other side had been quiet for this long (a stretch that began in incoming voice may be echo)... */
export const DOUBLE_TALK_CLEAR_MS = 150;
/**
 * ...and for at most this much incoming speech per stretch of the user's voice. While the pass runs, the mic
 * carries the echo too, which keeps "the user's voice" going: without a budget an interruption in short
 * phrases would renew the pass at every phrase and leak the other side back to them.
 */
export const DOUBLE_TALK_MAX_MS = 1500;

const floors = new WeakMap(); // out socket -> { userStart, usedMs, lastAt }

/** True when the user (`out`: the outgoing SttSocket) was already speaking when incoming voice began at `onsetAt`. */
export function userHoldsFloor(out, onsetAt, inc = null) {
  if (!out || !(onsetAt > 0)) return false;
  const userAt = out.lastVoiceAt || 0;
  const userStart = out.voiceStartAt || 0;
  if (!(userAt > 0 && userAt >= onsetAt - DOUBLE_TALK_MS && userStart > 0 && userStart <= onsetAt - DOUBLE_TALK_LEAD_MS)) return false;
  if (inc && typeof inc.voiceDuring === 'function' && inc.voiceDuring(userStart - DOUBLE_TALK_CLEAR_MS, userStart)) return false;
  const f = floors.get(out);
  return !f || f.userStart !== userStart || f.usedMs < DOUBLE_TALK_MAX_MS;
}

/** 'open' | 'gated' | 'floor' (incoming speech, but the user holds the floor: the real mic passes). */
function echoState(inc, settings, now, out) {
  if (!inc || (settings && settings.echoGuard === false)) return 'open';
  const voiceAt = inc.lastVoiceAt || 0;
  if (!voiceAt || now - voiceAt >= ECHO_HOLD_MS) return 'open'; // the other side is quiet
  const textAt = (inc.counters && inc.counters.lastPartialAt) || 0;
  const onsetAt = inc.voiceStartAt || 0;
  const speech = (textAt > 0 && now - textAt < ECHO_TEXT_MS) || (onsetAt > 0 && now - onsetAt < ECHO_ONSET_MS);
  if (!speech) return 'open';
  return userHoldsFloor(out, onsetAt, inc) ? 'floor' : 'gated';
}

/**
 * inc: the incoming SttSocket (lastVoiceAt, voiceStartAt, counters.lastPartialAt, voiceDuring); out (optional):
 * the outgoing one (lastVoiceAt, voiceStartAt of the user's voice; gated chunks never count as the user's voice).
 */
export function echoGated(inc, settings, now, out = null) {
  return echoState(inc, settings, now, out) === 'gated';
}

/** Spends the double-talk budget of the user's current stretch of voice. */
function useFloor(out, now) {
  const userStart = out.voiceStartAt || 0;
  let f = floors.get(out);
  if (!f || f.userStart !== userStart) {
    f = { userStart, usedMs: 0, lastAt: 0 };
    floors.set(out, f);
  }
  f.usedMs += f.lastAt ? Math.min(Math.max(0, now - f.lastAt), 250) : 100;
  f.lastAt = now;
}

/**
 * Routes one mic chunk (base64 PCM16) to the outgoing SttSocket `out`: the real audio, or, while the gate is
 * closed, silence of the same length (keeps the stream and the server VAD going) that does not count as
 * heard audio for the noise floor / voice tracking. Returns true when the chunk was gated.
 */
export function forwardMic(inc, out, settings, b64, now) {
  const state = echoState(inc, settings, now, out);
  if (state === 'gated') {
    out.sendSilenceFor(b64);
    return true;
  }
  if (state === 'floor') useFloor(out, now);
  out.sendAudio(b64);
  return false;
}

/**
 * Commit meta of an outgoing segment -> did it overlap incoming voice (gated audio inside it, or incoming voice
 * between its first and last voiced moment)? Only such segments can be an echo worth the text check.
 * Unknown span (no meta) -> true.
 */
export function overlapsIncoming(inc, meta) {
  if (!meta || !Number.isFinite(meta.startAt)) return true;
  if (meta.gatedMs > 0) return true;
  if (!inc || typeof inc.voiceDuring !== 'function') return true;
  const end = Number.isFinite(meta.endAt) ? meta.endAt : meta.startAt;
  return inc.voiceDuring(meta.startAt, end);
}
