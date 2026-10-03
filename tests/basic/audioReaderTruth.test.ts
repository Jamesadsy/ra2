import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../helpers/guestMemory';
import { DEFAULT_PCM_FORMAT } from '../../src/vm86/audio';
import type { Win32AudioSink } from '../../src/vm86/win32';

/** Metadata only: sequence, ring frame, consumed output frames, generation, active. */
function renderer(frames = 4096, start = 0, retiredBeforeCreate = false) {
  const control = new Int32Array(new SharedArrayBuffer(5 * 4));
  control.set([0, start, 0, 7, retiredBeforeCreate ? 0 : 1]);
  const reports: unknown[] = [];
  interface ProcessorInstance {
    port: { onmessage(event: { data: Record<string, unknown> }): void };
    process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  }
  let Processor: (new () => ProcessorInstance) | null = null;
  const globals = {
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (value: unknown) => reports.push(value) };
    },
    registerProcessor: (_name: string, constructor: new () => ProcessorInstance) => {
      Processor = constructor;
    },
    sampleRate: 48_000,
    currentTime: 0,
    Atomics,
  };
  runInNewContext(readFileSync('src/adapter/pcmStreamWorklet.js', 'utf8'), globals);
  const processor = new Processor!();
  processor.port.onmessage({
    data: {
      kind: 'create',
      channels: 1,
      frames,
      frequency: 48_000,
      loop: true,
      frame: start,
      readerControl: control.buffer,
      readerGeneration: 7,
    },
  });
  processor.port.onmessage({ data: { kind: 'update', offsetFrames: 0, data: new Float32Array(frames) } });
  return { control, processor, globals, reports };
}

describe('authoritative audio reader contract', () => {
  it('cannot revive a reader retired while create was still queued on the audio thread', () => {
    const { control, processor } = renderer(4096, 0, true);
    processor.process([], [[new Float32Array(128)]]);
    expect(Atomics.load(control, 4)).toBe(0);
  });
  it('publishes consumed progress without waiting for position message delivery', () => {
    const { control, processor, reports } = renderer();
    processor.process([], [[new Float32Array(128)]]);
    expect(Atomics.load(control, 0)).toBeGreaterThan(0);
    expect(Atomics.load(control, 0) % 2).toBe(0);
    expect(Atomics.load(control, 1)).toBe(128);
    expect(Atomics.load(control, 2)).toBe(128);
    expect(Atomics.load(control, 3)).toBe(7);
    expect(Atomics.load(control, 4)).toBe(1);
    expect(reports).toHaveLength(0);
  });

  it('does not advance when only wall time or diagnostic messages advance', () => {
    const { control, processor, globals } = renderer();
    processor.process([], [[new Float32Array(128)]]);
    const before = [...control];
    globals.currentTime = 20;
    // No process() means no consumed frames, even after the legacy 250 ms expiry.
    expect([...control]).toEqual(before);
    expect(Atomics.load(control, 1)).toBe(128);
    processor.port.onmessage({ data: { kind: 'stop' } });
    processor.process([], [[new Float32Array(128)]]);
    expect(Atomics.load(control, 1)).toBe(128);
    expect(Atomics.load(control, 2)).toBe(128);
  });

  it('keeps sequence and consumed progress monotonic while the ring wraps', () => {
    const { control, processor } = renderer(256, 192);
    let previousSequence = 0;
    for (let quantum = 1; quantum <= 20; quantum++) {
      processor.process([], [[new Float32Array(128)]]);
      const sequence = Atomics.load(control, 0);
      expect(sequence).toBeGreaterThan(previousSequence);
      expect(sequence % 2).toBe(0);
      expect(Atomics.load(control, 1)).toBe((192 + quantum * 128) % 256);
      expect(Atomics.load(control, 2)).toBe(quantum * 128);
      previousSequence = sequence;
    }
  });

  it('retires the old reader on destroy so late messages cannot revive its generation', () => {
    const { control, processor } = renderer();
    processor.process([], [[new Float32Array(128)]]);
    expect(Atomics.load(control, 4)).toBe(1);
    processor.port.onmessage({ data: { kind: 'destroy' } });
    expect(Atomics.load(control, 4)).toBe(0);
    const consumed = Atomics.load(control, 2);
    expect(processor.process([], [[new Float32Array(128)]])).toBe(false);
    expect(Atomics.load(control, 2)).toBe(consumed);
  });

  it('keeps wrapped and explicit partial Locks outside the renderer quantum under bounded delivery delay', () => {
    const memory = createGuestMemory(12 * 1024 * 1024);
    let consumed = 0;
    const audio: Win32AudioSink = {
      createBuffer() {},
      duplicateBuffer: () => true,
      setFormat: () => true,
      writeBuffer: (_id, _offset, bytes) => bytes.length,
      play: () => true,
      stop: () => true,
      setCurrentPosition: () => true,
      setVolume: () => true,
      setPan: () => true,
      setFrequency: () => true,
      getState: () => null,
      releaseBuffer: () => true,
      getConsumerCursor: () => ({
        positionBytes: consumed * 4,
        outputSampleRateHz: 48000,
        transportLatencyMs: 0,
        ageMs: 0,
        authoritative: true,
      }),
    };
    const shim = createTestShim(memory, { firstDynamicId: 1, audio });
    const call = (method: string, args: number[]) => callShim(shim, `DSOUND.COM!${method}`, args, 0x2000);
    writeU32(memory, 0x1000, 20);
    writeU32(memory, 0x1008, 4096 * 4);
    call('IDirectSound.CreateSoundBuffer', [0, 0x1000, 0x1200, 0]);
    const id = readU32(memory, 0x1200);
    // Use equal source/output rates so the existing four-quantum reserve is exactly 512 frames.
    call('IDirectSoundBuffer.SetFrequency', [id, 48000]);
    call('IDirectSoundBuffer.Play', [id, 0, 0, 1]);
    const writes = (origin: number, frames: number, point: number) => (point - origin + 4096) % 4096 < frames;
    for (const start of [0, 64, 3500, 3800, 4095]) {
      consumed = start;
      call('IDirectSoundBuffer.GetCurrentPosition', [id, 0x1210, 0x1214]);
      const writeFrame = readU32(memory, 0x1214) / DEFAULT_PCM_FORMAT.nBlockAlign;
      for (const delayFrames of [0, 64, 128, 256, 384]) {
        call('IDirectSoundBuffer.Lock', [id, writeFrame * 4, 64 * 4, 0x1220, 0x1224, 0x1228, 0x122c, 0]);
        expect(readU32(memory, 0x1224) + readU32(memory, 0x122c)).toBe(256);
        for (let active = 0; active < 128; active++) {
          expect(writes(writeFrame, 64, (start + delayFrames + active) % 4096)).toBe(false);
        }
      }
      call('IDirectSoundBuffer.Lock', [id, 999, 256, 0x1220, 0x1224, 0x1228, 0x122c, 1]);
      expect(shim.getSoundStreamingTraces().find((trace) => trace.id === id)?.resolvedOrigin).toBe(writeFrame * 4);
    }
  });
});
