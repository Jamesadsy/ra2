import { afterEach, describe, expect, it, vi } from 'vitest';
import { installRuntimeLifecycleCoordinator } from '../../src/adapter/runtimeLifecycleCoordinator';
import type { VmAudioLifecycleSnapshot, VmLifecycleReport, VmLifecycleSnapshot } from '../../src/adapter/vmLifecycle';
import type { VmShell } from '../../src/adapter/vmShell';

afterEach(() => vi.unstubAllGlobals());

function workerSnapshot(overrides: Partial<VmLifecycleSnapshot> = {}): VmLifecycleSnapshot {
  return {
    observedAtEpochMs: 1_000,
    phase: 'running',
    guestLogicFrame: 90,
    guestTimeMs: 12_500,
    guestClockPaused: false,
    workerRunning: true,
    lifecyclePaused: false,
    hypercallPending: false,
    guestRequestPending: false,
    pendingFileReads: 0,
    pendingFileWrites: 0,
    rangePrefetchPending: false,
    rangePrefetchSpeculating: false,
    lifecycleCycles: 0,
    flushOk: null,
    safeToResume: true,
    recoveryReason: null,
    frameInFlightId: 0,
    framePendingEmission: false,
    frameScheduleGeneration: 0,
    frameEmittedCount: 0,
    frameAcknowledgedCount: 0,
    ...overrides,
  };
}

function audioSnapshot(): VmAudioLifecycleSnapshot {
  return {
    contextState: 'running',
    contextIdentity: 1,
    contextCreationCount: 1,
    lifecycleRecoveryPending: false,
    suspendCallAttempted: false,
    suspendSucceeded: null,
    automaticResumeAttempted: false,
    automaticResumeResult: null,
    trustedGestureAttemptCount: 0,
    trustedGestureResumeResult: null,
    trustedInteractionTrusted: null,
    contextTimeSeconds: 10,
    contextSampleRateHz: 48_000,
    playingBuffers: 1,
    sourceCount: 1,
    streamCount: 0,
    workletCount: 0,
    staleWorklets: 0,
    liveProcessorCount: 0,
    sourceStartCount: 3,
    streamStartCount: 0,
    workletStartCount: 0,
    dynamicStreamWrites: 0,
    dynamicStreamWriteRateHz: 0,
    bufferCreateCount: 2,
    bufferDuplicateCount: 0,
    buffers: [],
    sampleRates: [22_050],
    frequencies: [22_050],
    formats: [{ sampleRate: 22_050, channels: 2, bitsPerSample: 16, blockAlign: 4 }],
  };
}

function setup(
  resumeWorker = workerSnapshot(),
  options: {
    audioUnlock?: 'true' | 'false' | 'reject';
    audioUnlockWorker?: VmLifecycleSnapshot;
    pauseWorker?: VmLifecycleSnapshot;
    pauseReject?: boolean;
    resumeReject?: boolean;
  } = {},
) {
  const win = Object.assign(new EventTarget(), {
    setInterval: () => 1,
    clearInterval: vi.fn(),
    setTimeout: vi.fn(() => 2),
    clearTimeout: vi.fn(),
    __RA2Host: { platform: 'ios', version: 1, ownerDataToken: 'must-not-leak' },
  });
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const metrics: Array<Record<string, number | string | undefined>> = [];
  Object.assign(win, {
    __RA2NativeDiagnostics: {
      phase: vi.fn(),
      error: vi.fn(),
      event: vi.fn(),
      touch: vi.fn(),
      metrics: (record: Record<string, number | string | undefined>) => metrics.push(record),
    },
  });
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', doc);
  const actions: string[] = [];
  const vm = {
    async lifecycle(action: string) {
      actions.push(action);
      if (action === 'pause') {
        if (options.pauseReject) throw new Error('pause failed');
        return {
          action,
          worker: options.pauseWorker ?? workerSnapshot({ guestClockPaused: true, flushOk: true, lifecycleCycles: 1 }),
          audio: { ...audioSnapshot(), contextState: 'suspended', sourceCount: 0 },
        } as VmLifecycleReport;
      }
      if (action === 'resume') {
        if (options.resumeReject) throw new Error('worker failed');
        return { action, worker: resumeWorker, audio: audioSnapshot() } as VmLifecycleReport;
      }
      if (action === 'audio-unlock') {
        if (options.audioUnlock === 'reject') throw new Error('audio unlock rejected');
        return {
          action,
          worker: options.audioUnlockWorker ?? workerSnapshot(),
          audio: { ...audioSnapshot(), unlockResult: options.audioUnlock === 'false' ? false : true },
        } as VmLifecycleReport;
      }
      return { action, worker: workerSnapshot(), audio: audioSnapshot() } as VmLifecycleReport;
    },
  };
  const releaseInput = vi.fn();
  const showRecovery = vi.fn();
  const cleanup = installRuntimeLifecycleCoordinator(vm as unknown as VmShell, releaseInput, showRecovery);
  const emit = (phase: string, nativeTimestampMs: number) => {
    win.dispatchEvent(Object.assign(new Event('ra2-native-lifecycle'), { detail: { phase, nativeTimestampMs } }));
  };
  const settle = async () => {
    for (let index = 0; index < 8; index++) await Promise.resolve();
  };
  return { win, doc, actions, metrics, releaseInput, showRecovery, cleanup, emit, settle };
}

describe('RA2 lifecycle coordination', () => {
  it('short and 20m46s cycles keep the same guest clock, probe Worker, and unlock audio on first input', async () => {
    const test = setup();
    try {
      for (const elapsedMs of [90_000, 20 * 60_000 + 46_000, 90_000]) {
        const backgroundAt = 1_000 + test.actions.length * 1_000;
        test.emit('background', backgroundAt);
        await test.settle();
        expect(test.actions.slice(-2)).toEqual(['probe', 'pause']);
        test.emit('foreground', backgroundAt + elapsedMs);
        await test.settle();
        expect(test.actions.slice(-2)).toEqual(['probe', 'resume']);
      }
      expect(test.releaseInput).toHaveBeenCalledTimes(3);
      expect(test.showRecovery).not.toHaveBeenCalled();
      expect(test.metrics.filter((record) => record.lifecyclePhase === 'after-foreground-resume')).toHaveLength(3);
      expect(
        test.metrics
          .filter((record) => record.lifecyclePhase === 'after-foreground-resume')
          .every((record) => record.guestTimeDeltaMs === 0 && record.safeToResume === 1),
      ).toBe(true);
      expect(JSON.stringify(test.metrics)).not.toContain('must-not-leak');

      const trustedInteraction = new Event('pointerdown');
      Object.defineProperty(trustedInteraction, 'isTrusted', { value: true });
      test.win.dispatchEvent(trustedInteraction);
      await test.settle();
      expect(test.actions.at(-1)).toBe('audio-unlock');
      expect(test.metrics.some((record) => record.lifecyclePhase === 'first-post-resume-interaction')).toBe(true);
    } finally {
      test.cleanup();
      expect(test.win.clearInterval).toHaveBeenCalledOnce();
    }
  });

  it('fails closed when the post-resume Worker snapshot has an unresolved guest read', async () => {
    const test = setup(
      workerSnapshot({
        safeToResume: false,
        pendingFileReads: 1,
        recoveryReason: 'pending-read',
      }),
    );
    try {
      test.emit('background', 10_000);
      await test.settle();
      test.emit('foreground', 20_000);
      await test.settle();
      expect(test.showRecovery).toHaveBeenCalledOnce();
      expect(test.showRecovery).toHaveBeenCalledWith('pending-read');
      expect(test.metrics.some((record) => record.lifecyclePhase === 'recovery-required')).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it('offers Continue only for resolved audio-unlock false and permits a later foreground cycle', async () => {
    const test = setup(workerSnapshot(), { audioUnlock: 'false' });
    try {
      test.emit('background', 10_000);
      await test.settle();
      test.emit('foreground', 20_000);
      await test.settle();
      const trustedInteraction = new Event('pointerdown');
      Object.defineProperty(trustedInteraction, 'isTrusted', { value: true });
      test.win.dispatchEvent(trustedInteraction);
      await test.settle();

      expect(test.showRecovery).toHaveBeenCalledOnce();
      expect(test.showRecovery).toHaveBeenCalledWith(
        'audio-resume-failed-after-user-interaction',
        expect.any(Function),
      );
      const onContinue = test.showRecovery.mock.calls[0]?.[1];
      expect(onContinue).toBeTypeOf('function');
      onContinue?.();
      onContinue?.();

      test.emit('background', 30_000);
      await test.settle();
      test.emit('foreground', 40_000);
      await test.settle();
      const laterInteraction = new Event('pointerdown');
      Object.defineProperty(laterInteraction, 'isTrusted', { value: true });
      test.win.dispatchEvent(laterInteraction);
      await test.settle();

      expect(test.actions.filter((action) => action === 'audio-unlock')).toHaveLength(2);
      expect(test.showRecovery).toHaveBeenCalledTimes(2);
      expect(test.showRecovery.mock.calls.every((call) => typeof call[1] === 'function')).toBe(true);
    } finally {
      test.cleanup();
    }
  });

  it('keeps a rejected audio-unlock promise restart-only', async () => {
    const test = setup(workerSnapshot(), { audioUnlock: 'reject' });
    try {
      test.emit('background', 10_000);
      await test.settle();
      test.emit('foreground', 20_000);
      await test.settle();
      const trustedInteraction = new Event('pointerdown');
      Object.defineProperty(trustedInteraction, 'isTrusted', { value: true });
      test.win.dispatchEvent(trustedInteraction);
      await test.settle();

      expect(test.showRecovery).toHaveBeenCalledWith('audio-resume-failed-after-user-interaction');
      expect(test.showRecovery.mock.calls[0]).toHaveLength(1);
    } finally {
      test.cleanup();
    }
  });

  it('keeps a resolved audio-unlock false with unsafe Worker state restart-only', async () => {
    const test = setup(workerSnapshot(), {
      audioUnlock: 'false',
      audioUnlockWorker: workerSnapshot({
        safeToResume: false,
        pendingFileReads: 1,
        recoveryReason: 'pending-read',
      }),
    });
    try {
      test.emit('background', 10_000);
      await test.settle();
      test.emit('foreground', 20_000);
      await test.settle();
      const trustedInteraction = new Event('pointerdown');
      Object.defineProperty(trustedInteraction, 'isTrusted', { value: true });
      test.win.dispatchEvent(trustedInteraction);
      await test.settle();

      expect(test.showRecovery).toHaveBeenCalledWith('pending-read');
      expect(test.showRecovery.mock.calls[0]).toHaveLength(1);
    } finally {
      test.cleanup();
    }
  });

  it.each([
    [
      'pending read',
      workerSnapshot({ safeToResume: false, pendingFileReads: 1, recoveryReason: 'pending-read' }),
      {},
      'pending-read',
    ],
    [
      'safeToResume=false',
      workerSnapshot({ safeToResume: false, recoveryReason: null }),
      {},
      'runtime-not-safe-to-resume',
    ],
    [
      'flush failure',
      workerSnapshot({ safeToResume: false, flushOk: false, recoveryReason: 'flush-failed' }),
      {},
      'flush-failed',
    ],
    ['background pause failure', workerSnapshot(), { pauseReject: true }, 'background-pause-or-flush-failed'],
    [
      'runtime unavailable',
      workerSnapshot({
        phase: 'error',
        workerRunning: false,
        safeToResume: false,
        recoveryReason: 'runtime-unavailable',
      }),
      {},
      'runtime-unavailable',
    ],
  ] as const)('%s remains restart-only', async (_name, resumeWorker, options, reason) => {
    const test = setup(resumeWorker, options);
    try {
      test.emit('background', 10_000);
      await test.settle();
      test.emit('foreground', 20_000);
      await test.settle();
      expect(test.showRecovery).toHaveBeenCalledWith(reason);
      expect(test.showRecovery.mock.calls[0]).toHaveLength(1);
    } finally {
      test.cleanup();
    }
  });

  it('keeps an unresponsive Worker restart-only', async () => {
    const test = setup(workerSnapshot(), { resumeReject: true });
    try {
      test.emit('background', 10_000);
      await test.settle();
      test.emit('foreground', 20_000);
      await test.settle();
      expect(test.showRecovery).toHaveBeenCalledWith('worker-unresponsive-after-foreground');
      expect(test.showRecovery.mock.calls[0]).toHaveLength(1);
    } finally {
      test.cleanup();
    }
  });

  it('keeps a reported flush failure restart-only', async () => {
    const test = setup(workerSnapshot(), {
      pauseWorker: workerSnapshot({ guestClockPaused: false, flushOk: false, recoveryReason: 'flush-failed' }),
    });
    try {
      test.emit('background', 10_000);
      await test.settle();
      test.emit('foreground', 20_000);
      await test.settle();
      expect(test.showRecovery).toHaveBeenCalledWith('background-pause-or-flush-failed');
      expect(test.showRecovery.mock.calls[0]).toHaveLength(1);
    } finally {
      test.cleanup();
    }
  });
});
