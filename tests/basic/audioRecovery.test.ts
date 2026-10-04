import { afterEach, expect, it, vi } from 'vitest';
import { WebAudioPcmSink } from '../../src/adapter/audio';

class Node {
  connect() {
    return this;
  }
  disconnect() {}
}
class Context {
  state = 'running';
  currentTime = 0;
  sampleRate = 48000;
  destination = new Node();
  resume = vi.fn(async () => {
    this.state = 'running';
  });
  suspend = vi.fn(async () => {
    this.state = 'suspended';
  });
  close = vi.fn(async () => {
    this.state = 'closed';
  });
  createGain() {
    return Object.assign(new Node(), { gain: { value: 1 } });
  }
  createStereoPanner() {
    return Object.assign(new Node(), { pan: { value: 0 } });
  }
  createBuffer(_channels: number, frames: number, rate: number) {
    return { duration: frames / rate, getChannelData: () => new Float32Array(frames) };
  }
  createBufferSource() {
    return Object.assign(new Node(), {
      buffer: null,
      loop: false,
      playbackRate: { value: 1 },
      onended: null,
      start: vi.fn(),
      stop: vi.fn(),
    });
  }
}
const trusted = () => Object.defineProperty(new Event('pointerdown'), 'isTrusted', { value: true });
function setup(fresh = false) {
  vi.useFakeTimers();
  const contexts: Context[] = [];
  const sink = new WebAudioPcmSink({
    foregroundRecoveryPolicy: fresh ? 'fresh-context-on-trusted-input' : 'same-context',
    contextFactory: () => {
      const c = new Context();
      contexts.push(c);
      return c as unknown as AudioContext;
    },
  });
  sink.createBuffer('music', 88200);
  sink.play('music', { loop: true });
  return { sink, contexts };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('automatic and visibility signals never reconstruct a pending fresh renderer before trusted input', async () => {
  const { sink, contexts } = setup(true);
  await sink.suspendForLifecycle();
  await sink.resumeForLifecycle();
  await sink.unlock();
  await sink.resumeForLifecycle();
  expect(contexts).toHaveLength(1);
  expect(sink.getLifecycleSnapshot().sourceCount).toBe(0);
  expect(sink.getLifecycleSnapshot().lifecycleRecoveryPending).toBe(true);
  await sink.destroy();
});

it('running without renderer progress fails the authoritative attempt and retains pending recovery', async () => {
  const { sink } = setup();
  await sink.suspendForLifecycle();
  const recovery = sink.unlockFromTrustedInteraction(trusted());
  await vi.advanceTimersByTimeAsync(2100);
  expect(await recovery).toBe(false);
  expect(sink.getLifecycleSnapshot().lifecycleRecoveryPending).toBe(true);
  await sink.destroy();
});

it('one trusted owner per generation proves progress and repeated cycles retire exactly one context', async () => {
  const { sink, contexts } = setup(true);
  for (let cycle = 0; cycle < 3; cycle++) {
    await sink.suspendForLifecycle();
    await sink.resumeForLifecycle();
    const first = sink.unlockFromTrustedInteraction(trusted());
    const second = sink.unlockFromTrustedInteraction(trusted());
    expect(first).toBe(second);
    contexts.at(-1)!.currentTime += 0.1;
    await vi.advanceTimersByTimeAsync(20);
    expect(await first).toBe(true);
    expect(sink.getLifecycleSnapshot().lifecycleRecoveryPending).toBe(false);
    expect(sink.getLifecycleSnapshot().sourceCount).toBe(1);
    expect(contexts).toHaveLength(cycle + 2);
    expect(contexts.slice(0, -1).every((c) => c.state === 'closed')).toBe(true);
    expect(contexts.at(-1)!.suspend).not.toHaveBeenCalled();
  }
  await sink.destroy();
});

it('a prior generation resume completion cannot rebuild or clear the next background generation', async () => {
  const { sink, contexts } = setup();
  await sink.suspendForLifecycle();
  let finish!: () => void;
  contexts[0]!.resume.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stale = sink.unlockFromTrustedInteraction(trusted());
  await sink.suspendForLifecycle();
  contexts[0]!.state = 'running';
  finish();
  await vi.advanceTimersByTimeAsync(2100);
  expect(await stale).toBe(false);
  expect(sink.getLifecycleSnapshot().lifecycleRecoveryPending).toBe(true);
  expect(sink.getLifecycleSnapshot().sourceCount).toBe(0);
  await sink.destroy();
});
