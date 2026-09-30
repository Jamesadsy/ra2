import type { VmShell } from './vmShell';
import type { VmAudioLifecycleSnapshot, VmLifecycleFramePipeline, VmLifecycleSnapshot } from './vmLifecycle';
import { reportNativeRuntimeMetrics } from '../platform/browser/nativeDiagnostics';

interface NativeLifecycleDetail {
  phase?: unknown;
  nativeTimestampMs?: unknown;
}

interface NativeLifecycleEvent extends Event {
  detail?: NativeLifecycleDetail;
}

/** Coordinate a retained native WKWebView, its Worker VM, guest clock, input and WebAudio across app lifecycle edges. */
export function installRuntimeLifecycleCoordinator(
  vm: VmShell,
  releaseInput: () => void,
  showRecovery: (reason: string) => void,
  getPresentedFrameCount: () => number = () => 0,
): () => void {
  let appPhase: 'foreground' | 'background' = 'foreground';
  let firstInteractionPending = false;
  let backgroundPauseFailed = false;
  let recoveryShown = false;
  let disposed = false;
  let backgroundSnapshot: VmLifecycleSnapshot | null = null;
  let backgroundAudio: VmAudioLifecycleSnapshot | null = null;
  let backgroundFramePipeline: VmLifecycleFramePipeline | null = null;
  let backgroundPresentedFrames = 0;
  let transitionQueue = Promise.resolve();
  const postRecoveryTimers = new Set<number>();

  const report = (
    lifecyclePhase: string,
    nativeTimestampMs: number,
    worker: VmLifecycleSnapshot | null,
    audio: VmAudioLifecycleSnapshot | null,
    extras: Record<string, number | string | undefined> = {},
    framePipeline: VmLifecycleFramePipeline | undefined = undefined,
  ) => {
    const baseline = backgroundSnapshot;
    const audioBaseline = backgroundAudio;
    const format = audio?.formats[0];
    const buffer = audio?.buffers[0];
    const activeAudioBuffers = audio?.buffers.filter((item) => item.playing) ?? [];
    const activeFrequencies = activeAudioBuffers.map((item) => item.frequency);
    reportNativeRuntimeMetrics({
      event: 'lifecycle',
      lifecyclePhase,
      nativeTimestampMs,
      documentVisibility: document.visibilityState,
      workerResponsive: worker ? 1 : 0,
      workerObservedAtEpochMs: worker?.observedAtEpochMs,
      guestLogicFrame: worker?.guestLogicFrame,
      guestLogicFrameDelta: worker && baseline ? worker.guestLogicFrame - baseline.guestLogicFrame : undefined,
      guestTimeMs: worker?.guestTimeMs ?? undefined,
      guestTimeDeltaMs:
        worker?.guestTimeMs !== null && worker && baseline?.guestTimeMs !== null && baseline
          ? worker.guestTimeMs - baseline.guestTimeMs
          : undefined,
      guestClockPaused: worker ? Number(worker.guestClockPaused) : undefined,
      workerRunning: worker ? Number(worker.workerRunning) : undefined,
      lifecyclePaused: worker ? Number(worker.lifecyclePaused) : undefined,
      hypercallPending: worker ? Number(worker.hypercallPending) : undefined,
      guestRequestPending: worker ? Number(worker.guestRequestPending) : undefined,
      pendingFileReads: worker?.pendingFileReads,
      pendingFileWrites: worker?.pendingFileWrites,
      rangePrefetchPending: worker ? Number(worker.rangePrefetchPending) : undefined,
      rangePrefetchSpeculating: worker ? Number(worker.rangePrefetchSpeculating) : undefined,
      lifecycleCycles: worker?.lifecycleCycles,
      flushOk: worker?.flushOk === null || worker?.flushOk === undefined ? undefined : Number(worker.flushOk),
      safeToResume: worker ? Number(worker.safeToResume) : undefined,
      recoveryReason: worker?.recoveryReason ?? undefined,
      workerFrameInFlightId: framePipeline?.workerInFlightId,
      workerFramePendingEmission: framePipeline ? Number(framePipeline.workerPendingEmission) : undefined,
      workerFrameScheduleGeneration: framePipeline?.workerScheduleGeneration,
      workerFrameEmittedCount: framePipeline?.workerEmittedCount,
      workerFrameAcknowledgedCount: framePipeline?.workerAcknowledgedCount,
      mainFramePendingAckId: framePipeline?.mainPendingAckId,
      mainFrameAckRafPending: framePipeline ? Number(framePipeline.mainAckRafPending) : undefined,
      mainFrameReceivedCount: framePipeline?.mainReceivedCount,
      mainFrameAcknowledgedCount: framePipeline?.mainAcknowledgedCount,
      mainFrameReceivedDelta:
        framePipeline && backgroundFramePipeline
          ? framePipeline.mainReceivedCount - backgroundFramePipeline.mainReceivedCount
          : undefined,
      mainFrameAcknowledgedDelta:
        framePipeline && backgroundFramePipeline
          ? framePipeline.mainAcknowledgedCount - backgroundFramePipeline.mainAcknowledgedCount
          : undefined,
      presentedFrameCount: getPresentedFrameCount(),
      presentedFrameDelta: getPresentedFrameCount() - backgroundPresentedFrames,
      audioContextState: audio?.contextState,
      audioContextIdentity: audio?.contextIdentity ?? undefined,
      audioContextCreationCount: audio?.contextCreationCount,
      audioFreshContextRecoveryCount: audio?.freshContextRecoveryCount,
      audioRetiredContextCount: audio?.retiredContextCount,
      audioRetiredContextCloseFailures: audio?.retiredContextCloseFailures,
      audioLifecycleRecoveryPending: audio ? Number(audio.lifecycleRecoveryPending) : undefined,
      audioSuspendCallAttempted: audio ? Number(audio.suspendCallAttempted) : undefined,
      audioSuspendSucceeded:
        audio?.suspendSucceeded === null || audio?.suspendSucceeded === undefined
          ? undefined
          : Number(audio.suspendSucceeded),
      audioAutomaticResumeAttempted: audio ? Number(audio.automaticResumeAttempted) : undefined,
      audioAutomaticResumeResult:
        audio?.automaticResumeResult === null || audio?.automaticResumeResult === undefined
          ? undefined
          : Number(audio.automaticResumeResult),
      audioTrustedGestureAttemptCount: audio?.trustedGestureAttemptCount,
      audioTrustedGestureResumeResult:
        audio?.trustedGestureResumeResult === null || audio?.trustedGestureResumeResult === undefined
          ? undefined
          : Number(audio.trustedGestureResumeResult),
      audioTrustedInteractionTrusted:
        audio?.trustedInteractionTrusted === null || audio?.trustedInteractionTrusted === undefined
          ? undefined
          : Number(audio.trustedInteractionTrusted),
      audioTrustedEventType: audio?.trustedEventType ?? undefined,
      audioTrustedEventTimestampMs: audio?.trustedEventTimestampMs ?? undefined,
      audioTrustedResumeCallTimestampMs: audio?.trustedResumeCallTimestampMs ?? undefined,
      audioTrustedResumeResultTimestampMs: audio?.trustedResumeResultTimestampMs ?? undefined,
      audioGraphRebuildResult: audio?.graphRebuildResult == null ? undefined : Number(audio.graphRebuildResult),
      audioGraphRebuildTimestampMs: audio?.graphRebuildTimestampMs ?? undefined,
      audioLiveStreamedBuffers: audio?.buffers.filter((item) => item.playing && item.lifecycleWasLiveStreamed).length,
      audioWorkletModuleLoaded: audio ? Number(audio.audioWorkletModuleLoaded) : undefined,
      audioBufferStates: audio?.buffers
        .slice(0, 8)
        .map((item) =>
          [
            item.ordinal,
            Number(item.playing),
            Number(item.loop),
            item.positionFrames,
            item.totalFrames,
            item.frequency,
            item.sampleRate,
            item.channels,
            item.bitsPerSample,
            Number(item.source),
            Number(item.stream),
            Number(item.worklet),
            Number(item.lifecycleWasLiveStreamed),
          ].join(':'),
        )
        .join(';'),
      audioContextTimeSeconds: audio?.contextTimeSeconds ?? undefined,
      audioContextSampleRateHz: audio?.contextSampleRateHz ?? undefined,
      audioLastWorkletCursorUpdateAgeMs: audio?.lastWorkletCursorUpdateAgeMs ?? undefined,
      audioContextDeltaSeconds:
        audio?.contextTimeSeconds !== null && audio && audioBaseline?.contextTimeSeconds !== null && audioBaseline
          ? audio.contextTimeSeconds - audioBaseline.contextTimeSeconds
          : undefined,
      audioPlayingBuffers: audio?.playingBuffers,
      audioSourceCount: audio?.sourceCount,
      audioStreamCount: audio?.streamCount,
      audioWorkletCount: audio?.workletCount,
      audioStaleWorklets: audio?.staleWorklets,
      audioStaleWorkletsDetected: audio?.staleWorkletsDetected,
      audioSampleRateHz: format?.sampleRate,
      audioFrequencyHz: audio?.frequencies[0],
      audioChannels: format?.channels,
      audioBitsPerSample: format?.bitsPerSample,
      audioBlockAlign: format?.blockAlign,
      audioFormatCount: audio?.formats.length,
      audioLiveProcessorCount: audio?.liveProcessorCount,
      audioSourceStartCount: audio?.sourceStartCount,
      audioStreamStartCount: audio?.streamStartCount,
      audioWorkletStartCount: audio?.workletStartCount,
      audioDynamicStreamWrites: audio?.dynamicStreamWrites,
      audioDynamicStreamWriteRateHz: audio?.dynamicStreamWriteRateHz,
      audioBufferCreateCount: audio?.bufferCreateCount,
      audioBufferDuplicateCount: audio?.bufferDuplicateCount,
      audioBufferCursorFrames: buffer?.positionFrames,
      audioBufferTotalFrames: buffer?.totalFrames,
      audioBufferFrequencyHz: buffer?.frequency,
      audioBufferSampleRateHz: buffer?.sampleRate,
      audioBufferChannels: buffer?.channels,
      audioBufferBitsPerSample: buffer?.bitsPerSample,
      audioBufferWriteCount: buffer?.writeCount,
      audioBufferWriteAgeMs: buffer?.writeAgeMs ?? undefined,
      audioBufferFrequencyChanges: buffer?.frequencyChangeCount,
      audioActiveBufferWriteCount: activeAudioBuffers.reduce((sum, item) => sum + item.writeCount, 0),
      audioMaxActiveBufferWriteAgeMs: Math.max(0, ...activeAudioBuffers.map((item) => item.writeAgeMs ?? 0)),
      audioActiveBufferFrequencyChanges: activeAudioBuffers.reduce((sum, item) => sum + item.frequencyChangeCount, 0),
      audioMinActiveFrequencyHz: activeFrequencies.length ? Math.min(...activeFrequencies) : undefined,
      audioMaxActiveFrequencyHz: activeFrequencies.length ? Math.max(...activeFrequencies) : undefined,
      audioBufferPlaying: buffer === undefined ? undefined : Number(buffer.playing),
      audioBufferLooping: buffer === undefined ? undefined : Number(buffer.loop),
      audioUnlockResult: audio?.unlockResult === undefined ? undefined : Number(audio.unlockResult),
      ...extras,
    });
  };

  const scheduleRecoveryProbes = (label: string, timestamp: number, baseline: VmAudioLifecycleSnapshot) => {
    for (const delay of [250, 1_000]) {
      const timer = window.setTimeout(() => {
        postRecoveryTimers.delete(timer);
        if (disposed || appPhase !== 'foreground') return;
        const started = performance.now();
        void vm.lifecycle('probe').then((result) => {
          const current = result.audio.buffers.find((item) => item.playing);
          const previous = baseline.buffers.find((item) => item.playing && item.ordinal === current?.ordinal);
          report(
            `audio-${label}-${delay}ms`,
            timestamp,
            result.worker,
            result.audio,
            {
              postRecoveryProbeMs: delay,
              postRecoveryContextDeltaSeconds:
                result.audio.contextTimeSeconds == null || baseline.contextTimeSeconds == null
                  ? undefined
                  : result.audio.contextTimeSeconds - baseline.contextTimeSeconds,
              postRecoveryCursorDeltaFrames:
                current && previous
                  ? (current.positionFrames - previous.positionFrames + current.totalFrames) %
                    Math.max(1, current.totalFrames)
                  : undefined,
              workerResponseMs: performance.now() - started,
            },
            result.framePipeline,
          );
        });
      }, delay);
      postRecoveryTimers.add(timer);
    }
  };

  const failClosed = (reason: string, timestamp: number) => {
    if (recoveryShown) return;
    recoveryShown = true;
    firstInteractionPending = false;
    reportNativeRuntimeMetrics({
      event: 'lifecycle',
      lifecyclePhase: 'recovery-required',
      nativeTimestampMs: timestamp,
      documentVisibility: document.visibilityState,
      workerResponsive: 0,
      recoveryReason: reason,
    });
    showRecovery(reason);
  };

  const handleNativeLifecycle = async (phase: unknown, timestampValue: unknown) => {
    if (disposed || (phase !== 'background' && phase !== 'foreground')) return;
    const timestamp =
      typeof timestampValue === 'number' && Number.isFinite(timestampValue) ? timestampValue : Date.now();
    const webEventReceivedAtMs = Date.now();
    if (phase === 'background') {
      for (const timer of postRecoveryTimers) window.clearTimeout(timer);
      postRecoveryTimers.clear();
      if (appPhase === 'background') return;
      appPhase = 'background';
      releaseInput();
      reportNativeRuntimeMetrics({
        event: 'lifecycle',
        lifecyclePhase: 'background-entered',
        nativeTimestampMs: timestamp,
        documentVisibility: document.visibilityState,
        webEventReceivedAtMs,
      });
      try {
        const before = await vm.lifecycle('probe');
        backgroundSnapshot = before.worker;
        backgroundFramePipeline = before.framePipeline ?? null;
        backgroundPresentedFrames = getPresentedFrameCount();
        report('before-background', timestamp, before.worker, before.audio, {}, before.framePipeline);
        const paused = await vm.lifecycle('pause');
        backgroundSnapshot = before.worker;
        backgroundFramePipeline = paused.framePipeline ?? backgroundFramePipeline;
        backgroundAudio = paused.audio;
        backgroundPresentedFrames = getPresentedFrameCount();
        backgroundPauseFailed = paused.worker.flushOk === false || !paused.worker.guestClockPaused;
        report(
          'background-paused',
          timestamp,
          paused.worker,
          paused.audio,
          { workerResponsiveBeforeBackground: 1, webTransitionCompletedAtMs: Date.now() },
          paused.framePipeline,
        );
      } catch {
        backgroundPauseFailed = true;
        reportNativeRuntimeMetrics({
          event: 'lifecycle',
          lifecyclePhase: 'background-pause-failed',
          nativeTimestampMs: timestamp,
          documentVisibility: document.visibilityState,
          workerResponsive: 0,
        });
      }
      return;
    }

    if (appPhase === 'foreground') return;
    appPhase = 'foreground';
    firstInteractionPending = true;
    try {
      const beforeResume = await vm.lifecycle('probe');
      report(
        'before-foreground-resume',
        timestamp,
        beforeResume.worker,
        beforeResume.audio,
        {},
        beforeResume.framePipeline,
      );
      if (backgroundPauseFailed) {
        failClosed('background-pause-or-flush-failed', timestamp);
        return;
      }
      const resumed = await vm.lifecycle('resume');
      report(
        'after-foreground-resume',
        timestamp,
        resumed.worker,
        resumed.audio,
        { webEventReceivedAtMs, webTransitionCompletedAtMs: Date.now() },
        resumed.framePipeline,
      );
      scheduleRecoveryProbes('automatic', timestamp, resumed.audio);
      if (!resumed.worker.safeToResume) {
        failClosed(resumed.worker.recoveryReason ?? 'runtime-not-safe-to-resume', timestamp);
      }
    } catch {
      failClosed('worker-unresponsive-after-foreground', timestamp);
    }
  };

  const onNativeLifecycle = (event: Event) => {
    const detail = (event as NativeLifecycleEvent).detail;
    const next = transitionQueue.then(() => handleNativeLifecycle(detail?.phase, detail?.nativeTimestampMs));
    transitionQueue = next.catch(() => undefined);
  };

  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') releaseInput();
    reportNativeRuntimeMetrics({
      event: 'visibility',
      documentVisibility: document.visibilityState,
      nativeTimestampMs: Date.now(),
    });
  };

  const onFirstInteraction = (event: Event) => {
    if (!firstInteractionPending || recoveryShown) return;
    if (!event.isTrusted) {
      reportNativeRuntimeMetrics({
        event: 'lifecycle',
        lifecyclePhase: 'untrusted-post-resume-interaction',
        nativeTimestampMs: Date.now(),
        documentVisibility: document.visibilityState,
      });
      return;
    }
    firstInteractionPending = false;
    const timestamp = Date.now();
    reportNativeRuntimeMetrics({
      event: 'lifecycle',
      lifecyclePhase: 'first-post-resume-interaction',
      nativeTimestampMs: timestamp,
      firstGestureTimestampMs: timestamp,
      documentVisibility: document.visibilityState,
    });
    void vm.lifecycle('audio-unlock', event).then(
      (result) => {
        report('audio-unlocked-by-user', timestamp, result.worker, result.audio, {}, result.framePipeline);
        scheduleRecoveryProbes('trusted', timestamp, result.audio);
        if (result.audio.unlockResult === false) failClosed('audio-resume-failed-after-user-interaction', timestamp);
      },
      () => {
        reportNativeRuntimeMetrics({
          event: 'lifecycle',
          lifecyclePhase: 'audio-unlock-failed',
          nativeTimestampMs: timestamp,
          documentVisibility: document.visibilityState,
          audioUnlockResult: 0,
        });
        failClosed('audio-resume-failed-after-user-interaction', timestamp);
      },
    );
  };

  window.addEventListener('ra2-native-lifecycle', onNativeLifecycle);
  document.addEventListener('visibilitychange', onVisibilityChange);
  for (const type of ['pointerdown', 'touchstart', 'keydown'] as const) {
    window.addEventListener(type, onFirstInteraction, true);
  }
  const diagnosticsTimer = window.setInterval(() => {
    if (disposed || appPhase !== 'foreground' || document.visibilityState === 'hidden' || recoveryShown) return;
    const startedAt = performance.now();
    const timestamp = Date.now();
    void vm.lifecycle('probe').then(
      (result) =>
        report(
          'foreground-runtime-probe',
          timestamp,
          result.worker,
          result.audio,
          { workerResponseMs: performance.now() - startedAt },
          result.framePipeline,
        ),
      () =>
        reportNativeRuntimeMetrics({
          event: 'lifecycle',
          lifecyclePhase: 'foreground-runtime-probe-failed',
          nativeTimestampMs: timestamp,
          documentVisibility: document.visibilityState,
          workerResponsive: 0,
          workerResponseMs: performance.now() - startedAt,
        }),
    );
  }, 5_000);
  return () => {
    disposed = true;
    window.clearInterval(diagnosticsTimer);
    for (const timer of postRecoveryTimers) window.clearTimeout(timer);
    postRecoveryTimers.clear();
    window.removeEventListener('ra2-native-lifecycle', onNativeLifecycle);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    for (const type of ['pointerdown', 'touchstart', 'keydown'] as const) {
      window.removeEventListener(type, onFirstInteraction, true);
    }
  };
}
