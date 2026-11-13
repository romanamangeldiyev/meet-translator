// Tab-capture fallback for incoming audio (settings.incomingSource === 'tab'): captures the Meet tab through a
// tabCapture streamId, keeps it audible (capturing a tab mutes it locally) and emits ~100 ms chunks of
// PCM16 LE mono 16 kHz audio as base64.
import { Downsampler, SampleBatcher, floatToPcm16, pcm16ToBase64 } from './util.js';

const CHUNK_SAMPLES = 1600; // 100 ms at 16 kHz
const PROCESSOR_FRAMES = 2048; // ~43 ms at 48 kHz

function abortError() {
  const e = new Error('Tab capture aborted');
  e.name = 'AbortError';
  return e;
}

/**
 * opts: { streamId, onChunk(b64), onEnded(), signal?, mediaDevices?, createAudioContext? }
 * Resolves to { stop() } once audio flows. Rejects when the capture cannot start (AbortError if `signal`
 * aborted first). Aborting `signal` later stops the capture too; stop() is idempotent.
 * onEnded fires once when the captured tab's audio track ends on its own (not after stop()).
 */
export async function startTabCapture(opts) {
  const { streamId, onChunk, onEnded, signal } = opts || {};
  if (!streamId) throw new Error('streamId missing');
  if (signal && signal.aborted) throw abortError();
  const mediaDevices = opts.mediaDevices || navigator.mediaDevices;
  const createAudioContext = opts.createAudioContext || (() => new AudioContext());

  const stream = await mediaDevices.getUserMedia({
    audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } },
    video: false,
  });

  const cleanups = [];
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (signal) signal.removeEventListener('abort', stop);
    while (cleanups.length) {
      try { cleanups.pop()(); } catch (_) { /* ignore */ }
    }
  };
  cleanups.push(() => stream.getTracks().forEach((t) => {
    try { t.stop(); } catch (_) { /* ignore */ }
  }));
  if (signal) {
    if (signal.aborted) {
      stop(); // stop arrived while the stream was being acquired
      throw abortError();
    }
    signal.addEventListener('abort', stop, { once: true });
  }

  try {
    const ctx = createAudioContext();
    cleanups.push(() => {
      const p = ctx.close();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    });
    if (ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) { /* keeps trying on its own when allowed */ }
    }
    if (stopped) throw abortError();

    const source = ctx.createMediaStreamSource(stream);
    source.connect(ctx.destination); // keep the meeting audible

    const processor = ctx.createScriptProcessor(PROCESSOR_FRAMES, 1, 1);
    const sink = ctx.createGain();
    sink.gain.value = 0; // the tap itself is never audible
    source.connect(processor);
    processor.connect(sink);
    sink.connect(ctx.destination); // a ScriptProcessor only runs while connected to the destination

    const down = new Downsampler(ctx.sampleRate, 16000);
    const batch = new SampleBatcher(CHUNK_SAMPLES, (pcm) => {
      if (!stopped) onChunk(pcm16ToBase64(pcm));
    });
    processor.onaudioprocess = (e) => {
      if (stopped) return;
      try {
        batch.push(floatToPcm16(down.process(e.inputBuffer.getChannelData(0))));
      } catch (_) { /* never throw out of the audio callback */ }
    };
    cleanups.push(() => {
      processor.onaudioprocess = null;
      for (const node of [processor, sink, source]) {
        try { node.disconnect(); } catch (_) { /* ignore */ }
      }
    });

    const track = stream.getAudioTracks()[0];
    if (track) {
      const ended = () => {
        if (stopped) return;
        stop();
        if (typeof onEnded === 'function') onEnded();
      };
      track.addEventListener('ended', ended);
      cleanups.push(() => track.removeEventListener('ended', ended));
      if (track.readyState === 'ended') ended();
    }
  } catch (e) {
    stop();
    throw e;
  }
  return { stop };
}
