export type VmLifecycleAction = 'probe' | 'pause' | 'resume';

export interface VmLifecycleSnapshot {
  observedAtEpochMs: number;
  phase: 'loading' | 'ready' | 'running' | 'blocked' | 'exited' | 'stopped' | 'error';
  guestLogicFrame: number;
  guestTimeMs: number | null;
  guestClockPaused: boolean;
  workerRunning: boolean;
  hypercallPending: boolean;
  pendingFileReads: number;
  pendingFileWrites: number;
  rangePrefetchPending: boolean;
  rangePrefetchSpeculating: boolean;
  lifecycleCycles: number;
  flushOk: boolean | null;
  safeToResume: boolean;
  recoveryReason: 'pending-read' | 'flush-failed' | 'runtime-unavailable' | null;
}

export interface VmAudioLifecycleSnapshot {
  contextState: string;
  contextTimeSeconds: number | null;
  contextSampleRateHz: number | null;
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
}
