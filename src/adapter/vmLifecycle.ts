export type VmLifecycleAction = 'probe' | 'pause' | 'resume';

export interface VmLifecycleSnapshot {
  observedAtEpochMs: number;
  phase: 'loading' | 'ready' | 'running' | 'blocked' | 'exited' | 'stopped' | 'error';
  guestLogicFrame: number;
  guestTimeMs: number | null;
  guestClockPaused: boolean;
  workerRunning: boolean;
  lifecyclePaused: boolean;
  hypercallPending: boolean;
  guestRequestPending: boolean;
  pendingFileReads: number;
  pendingFileWrites: number;
  rangePrefetchPending: boolean;
  rangePrefetchSpeculating: boolean;
  lifecycleCycles: number;
  flushOk: boolean | null;
  safeToResume: boolean;
  recoveryReason: 'pending-read' | 'flush-failed' | 'runtime-unavailable' | null;
  frameInFlightId: number;
  framePendingEmission: boolean;
  frameScheduleGeneration: number;
  frameEmittedCount: number;
  frameAcknowledgedCount: number;
}

export interface VmLifecycleFramePipeline {
  workerInFlightId: number;
  workerPendingEmission: boolean;
  workerScheduleGeneration: number;
  workerEmittedCount: number;
  workerAcknowledgedCount: number;
  mainPendingAckId: number;
  mainAckRafPending: boolean;
  mainReceivedCount: number;
  mainAcknowledgedCount: number;
}

export interface VmAudioLifecycleSnapshot {
  contextState: string;
  contextIdentity: number | null;
  contextCreationCount: number;
  freshContextRecoveryCount?: number;
  retiredContextCount?: number;
  retiredContextCloseFailures?: number;
  lifecycleRecoveryPending: boolean;
  suspendCallAttempted: boolean;
  suspendSucceeded: boolean | null;
  automaticResumeAttempted: boolean;
  automaticResumeResult: boolean | null;
  trustedGestureAttemptCount: number;
  trustedGestureResumeResult: boolean | null;
  trustedInteractionTrusted: boolean | null;
  trustedEventType?: string | null;
  trustedEventTimestampMs?: number | null;
  trustedResumeCallTimestampMs?: number | null;
  trustedResumeResultTimestampMs?: number | null;
  graphRebuildResult?: boolean | null;
  graphRebuildTimestampMs?: number | null;
  contextTimeSeconds: number | null;
  contextSampleRateHz: number | null;
  lastWorkletCursorUpdateAgeMs?: number | null;
  audioWorkletSupported?: boolean;
  audioWorkletModuleLoaded?: boolean;
  playingBuffers: number;
  sourceCount: number;
  streamCount: number;
  workletCount: number;
  staleWorklets: number;
  staleWorkletsDetected?: number;
  liveProcessorCount: number;
  sourceStartCount: number;
  streamStartCount: number;
  workletStartCount: number;
  dynamicStreamWrites: number;
  dynamicStreamWriteRateHz: number;
  bufferCreateCount: number;
  bufferDuplicateCount: number;
  buffers: Array<{
    ordinal: number;
    positionFrames: number;
    totalFrames: number;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    frequency: number;
    writeCount: number;
    writeAgeMs: number | null;
    frequencyChangeCount: number;
    playing: boolean;
    loop: boolean;
    source: boolean;
    stream: boolean;
    worklet: boolean;
    lifecycleWasLiveStreamed: boolean;
  }>;
  sampleRates: number[];
  frequencies: number[];
  formats: Array<{ sampleRate: number; channels: number; bitsPerSample: number; blockAlign: number }>;
  unlockResult?: boolean;
}

export interface VmLifecycleReport {
  action: VmLifecycleAction | 'audio-unlock';
  worker: VmLifecycleSnapshot;
  audio: VmAudioLifecycleSnapshot;
  framePipeline?: VmLifecycleFramePipeline;
}
