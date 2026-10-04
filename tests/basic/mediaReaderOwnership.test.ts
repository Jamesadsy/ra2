import { expect, it } from 'vitest';
import { ProxyAudioSink } from '../../src/adapter/vmWorkerController';
import type { AudioReader } from '../../src/adapter/audioReader';
import type { WorkerToMainMessage } from '../../src/adapter/vmProtocol';
import { DEFAULT_PCM_FORMAT } from '../../src/vm86/audio';

it('a reader in flight at media close cannot resurrect a retired producer or bind a reused buffer address', () => {
  const messages: WorkerToMainMessage[] = [];
  const sink = new ProxyAudioSink((message) => messages.push(message));
  sink.createBuffer(42, 4096, { ...DEFAULT_PCM_FORMAT });
  const create = messages.at(-1)! as WorkerToMainMessage & { op: { ownershipGeneration?: number } };
  const control = new SharedArrayBuffer(20);
  new Int32Array(control).set([2, 128, 128, 7, 1]);
  const reader: AudioReader & { ownershipGeneration?: number } = {
    control,
    generation: 7,
    byteLength: 4096,
    blockAlign: 4,
    outputSampleRateHz: 48000,
    ownershipGeneration: create.op.ownershipGeneration,
  };
  sink.bindReader(42, reader);
  expect(sink.getConsumerCursor(42)?.positionBytes).toBe(512);
  sink.stop(42);
  sink.bindReader(42, reader); // Main-to-Worker packet sent before it received Stop.
  expect(sink.getConsumerCursor(42)).toBeNull();
  sink.releaseBuffer(42);
  sink.createBuffer(42, 4096, { ...DEFAULT_PCM_FORMAT });
  sink.bindReader(42, reader);
  expect(sink.getConsumerCursor(42)).toBeNull();
});

it('stop-all and a later Play retain the current Worker ownership and reject late cursor samples', () => {
  const messages: WorkerToMainMessage[] = [];
  const sink = new ProxyAudioSink((message) => messages.push(message));
  sink.createBuffer(42, 4096, { ...DEFAULT_PCM_FORMAT });
  const create = messages.at(-1)! as WorkerToMainMessage & { op: { ownershipGeneration?: number } };
  sink.stopAll();
  sink.play(42, { loop: true });
  const play = messages.at(-1)! as WorkerToMainMessage & { op: { ownershipGeneration?: number } };
  expect(play.op.ownershipGeneration).not.toBe(create.op.ownershipGeneration);
  const sample = {
    type: 'audio-cursor' as const,
    id: 42,
    positionBytes: 512,
    playing: false,
    byteLength: 4096,
    blockAlign: 4,
    frequency: 22050,
    outputSampleRateHz: 48000,
    observedAtEpochMs: Date.now(),
    transportLatencyMs: 0,
    ownershipGeneration: create.op.ownershipGeneration,
  };
  sink.updateConsumerCursor(sample);
  expect(sink.getConsumerCursor(42)).toBeNull();
  sink.updateConsumerCursor({ ...sample, ownershipGeneration: play.op.ownershipGeneration });
  expect(sink.getConsumerCursor(42)?.positionBytes).toBe(512);
});
