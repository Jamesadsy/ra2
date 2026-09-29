import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { expect, it } from 'vitest';

interface WorkletMessageEvent {
  data: Record<string, unknown>;
}

interface TestWorkletProcessor {
  port: {
    onmessage: ((event: WorkletMessageEvent) => void) | null;
    postMessage: (message: unknown) => void;
  };
  process(inputs: unknown[], outputs: Float32Array[][]): boolean;
}

it('Bink 22.05 kHz PCM is linearly resampled at fractional 48 kHz output positions', () => {
  const source = readFileSync('src/adapter/pcmStreamWorklet.js', 'utf8');
  const reports: unknown[] = [];
  let processorName = '';
  let Processor: (new () => TestWorkletProcessor) | null = null;
  class FakeAudioWorkletProcessor {
    readonly port = {
      onmessage: null as ((event: WorkletMessageEvent) => void) | null,
      postMessage: (message: unknown) => reports.push(message),
    };
  }

  runInNewContext(source, {
    AudioWorkletProcessor: FakeAudioWorkletProcessor,
    registerProcessor: (name: string, constructor: new () => TestWorkletProcessor) => {
      processorName = name;
      Processor = constructor;
    },
    sampleRate: 48_000,
    currentTime: 0,
  });

  expect(processorName).toBe('ra2-pcm-stream');
  expect(Processor).not.toBeNull();
  const processor = new Processor!();
  processor.port.onmessage!({
    data: { kind: 'create', channels: 1, frames: 4, frequency: 22_050, loop: true, frame: 0 },
  });
  processor.port.onmessage!({
    data: { kind: 'update', offsetFrames: 0, data: Float32Array.from([0, 0.5, 1, 0.5]) },
  });
  const output = new Float32Array(4);
  expect(processor.process([], [[output]])).toBe(true);
  expect(output[0]).toBe(0);
  expect(output[1]).toBeCloseTo(0.5 * (22_050 / 48_000), 5);
  expect(output[2]).toBeCloseTo(0.5 * (22_050 / 48_000) * 2, 5);
  expect(output[3]).toBeCloseTo(0.5 + 0.5 * ((22_050 / 48_000) * 3 - 1), 5);
  expect(reports).toHaveLength(0);
});
