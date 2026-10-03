import type { SoundConsumerCursor } from '../vm86/win32';

/** The Worklet owns these five metadata words; PCM and guest memory are never shared. */
export interface AudioReader {
  control: SharedArrayBuffer;
  generation: number;
  byteLength: number;
  blockAlign: number;
  outputSampleRateHz: number;
}

const readerViews = new WeakMap<SharedArrayBuffer, Int32Array>();

/** Bounded seqlock read: a preempted writer cannot make the guest spin waiting for audio. */
export function readAudioReader(reader: AudioReader, previous: SoundConsumerCursor | null): SoundConsumerCursor | null {
  let words = readerViews.get(reader.control);
  if (!words) {
    words = new Int32Array(reader.control);
    readerViews.set(reader.control, words);
  }
  for (let attempt = 0; attempt < 4; attempt++) {
    const sequence = Atomics.load(words, 0) >>> 0;
    if (sequence & 1) continue;
    const frame = Atomics.load(words, 1);
    const generation = Atomics.load(words, 3);
    const active = Atomics.load(words, 4);
    if (sequence !== Atomics.load(words, 0) >>> 0) continue;
    if (!active || generation !== reader.generation) return previous;
    if (previous?.sequence !== undefined && (sequence - previous.sequence) >>> 0 >= 0x80000000) return previous;
    return {
      positionBytes: (Math.max(0, frame) * reader.blockAlign) % reader.byteLength,
      outputSampleRateHz: reader.outputSampleRateHz,
      transportLatencyMs: 0,
      ageMs: 0,
      authoritative: true,
      generation,
      sequence,
    };
  }
  return previous;
}
