import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

it('quiesce acknowledges an actual silent render boundary before renderer destruction', () => {
  const reports: Array<{ kind: string; frame?: number }> = [];
  interface Processor {
    port: { onmessage: (event: { data: Record<string, unknown> }) => void };
    process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  }
  let Constructor!: new () => Processor;
  runInNewContext(readFileSync('src/adapter/pcmStreamWorklet.js', 'utf8'), {
    AudioWorkletProcessor: class {
      port = { onmessage: null, postMessage: (message: { kind: string }) => reports.push(message) };
    },
    registerProcessor: (_name: string, constructor: new () => Processor) => (Constructor = constructor),
    sampleRate: 48000,
    currentTime: 0,
  });
  const processor = new Constructor();
  const send = (data: Record<string, unknown>) => processor.port.onmessage({ data });
  const control = new SharedArrayBuffer(20);
  new Int32Array(control).set([0, 0, 0, 7, 1]);
  send({
    kind: 'create',
    channels: 1,
    frames: 256,
    frequency: 48000,
    loop: true,
    frame: 0,
    readerControl: control,
    readerGeneration: 7,
  });
  send({ kind: 'update', offsetFrames: 0, data: new Float32Array(256).fill(0.75) });
  const active = new Float32Array(128);
  processor.process([], [[active]]);
  expect(active.at(-1)).toBe(0.75);
  const consumed = Atomics.load(new Int32Array(control), 2);
  send({ kind: 'quiesce' });
  expect(reports.some((r) => r.kind === 'quiesced')).toBe(false);
  const boundary = new Float32Array(128);
  processor.process([], [[boundary]]);
  expect(boundary.at(-1)).toBe(0);
  expect(Math.abs(boundary[0]! - active.at(-1)!)).toBeLessThanOrEqual(0.75 / 128 + 0.00001);
  expect(reports.some((r) => r.kind === 'quiesced')).toBe(false);
  const silent = new Float32Array(128).fill(1);
  processor.process([], [[silent]]);
  expect([...silent]).toEqual(new Array(128).fill(0));
  expect(reports.filter((r) => r.kind === 'quiesced')).toHaveLength(1);
  expect(Atomics.load(new Int32Array(control), 2)).toBe(consumed);
  send({ kind: 'destroy' });
  expect(Atomics.load(new Int32Array(control), 4)).toBe(0);
  expect(processor.process([], [[new Float32Array(128)]])).toBe(false);
  send({ kind: 'play' });
  expect(processor.process([], [[new Float32Array(128)]])).toBe(false);
  expect(Atomics.load(new Int32Array(control), 4)).toBe(0);
});
