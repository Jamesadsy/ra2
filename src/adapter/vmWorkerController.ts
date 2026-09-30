import type { GamePerformanceSample } from '../games/performance';
import { PortRelaySocket } from 'relay-package/client';
import { createBrowserEmulator } from '../platform/browser/emulator';
import { BrowserEmulatorProbe } from '../platform/browser/emulatorProbe';
import type { VmDiagnosticAction, VmDiagnostics } from './vmDiagnostics';
import { DirectoryGameFileProvider } from '../platform/browser/files/directory';
import { gameVmConfiguration } from '../games/vmConfiguration';
import { HttpGameFileProvider } from '../platform/browser/files/http';
import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { discoverGameSources } from '../resources/discovery/discoverGameSources';
import { type GameFileProvider } from '../resources/contracts';
import { type GameSource } from '../games/source';
import { SessionGameFileProvider } from '../platform/browser/files/sessionFiles';
import { PortGameFileProvider } from './fileProviderPort';
import { withMultiplayerNameOverride } from '../games/multiplayerName';
import { mountCustomMapFiles, prepareDynamicMaps } from './customMapPackage';
import { VmCore, type VmAudioSink, type VmCorePlatform } from './vmCore';
import type { MainToWorkerMessage, VmInitConfig, WorkerToMainMessage } from './vmProtocol';
import type { GuestMemRecordResult } from './memRecord';
import type { VmPointerState } from './vmShell';
import type { VmLifecycleSnapshot } from './vmLifecycle';
import type { SoundConsumerCursor, SoundStreamingTrace } from '../vm86/win32';
import type { GameVmCallbacks } from '../app/session/runtimeEvents';
import type { PcmPlayOptions, PcmWaveFormat } from '../vm86/audio';
import type { VmFrame } from '../vm86/win32';
import { gameResolutionFromIni, gameResolutionIni, withGameResolutionOverride } from '../games/resolution';
import { SerialTaskQueue } from '../utils/serialTaskQueue';
import { FrameBufferPool } from './frameBufferPool';

export interface VmWorkerCore {
  getDiagnostics(action: VmDiagnosticAction): Promise<VmDiagnostics>;
  start(): Promise<void>;
  stop(): Promise<void>;
  flushFiles(): Promise<void>;
  pauseForLifecycle?(): Promise<VmLifecycleSnapshot>;
  resumeForLifecycle?(): Promise<VmLifecycleSnapshot>;
  getLifecycleSnapshot?(): VmLifecycleSnapshot;
  postMessage(message: number, wParam?: number, lParam?: number): void;
  setKeyState(virtualKey: number, down: boolean): void;
  setCursorPosition(x: number, y: number): void;
  setGameClockRate(rate: number): number;
  setMasterVolume(linear: number): void;
  getPointerState(): VmPointerState | null;
  getGamePerformance(): Promise<GamePerformanceSample | null>;
  setGameSpeedFlag(value: number): number | null;
  startMemRecord(): boolean;
  stopMemRecord(): GuestMemRecordResult | null;
  setFileProvider(files: GameFileProvider): void;
}

export interface VmWorkerControllerDependencies {
  postMessage: (message: WorkerToMainMessage, transfer?: Transferable[]) => void;
  createProvider?: (config: VmInitConfig) => GameFileProvider;
  discoverSources?: (provider: GameFileProvider) => Promise<GameSource[]>;
  applyResolution?: typeof withGameResolutionOverride;
  createCore?: (callbacks: GameVmCallbacks, source: GameSource, platform: VmCorePlatform) => VmWorkerCore;
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  audio?: VmAudioSink;
}

interface WorkerScope {
  postMessage(message: WorkerToMainMessage, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<MainToWorkerMessage>) => void) | null;
}

class ProxyAudioSink implements VmAudioSink {
  private readonly consumerSamples = new Map<number, Extract<MainToWorkerMessage, { type: 'audio-cursor' }>>();
  constructor(private readonly post: VmWorkerControllerDependencies['postMessage']) {}

  updateConsumerCursor(sample: Extract<MainToWorkerMessage, { type: 'audio-cursor' }>): void {
    const previous = this.consumerSamples.get(sample.id);
    this.consumerSamples.set(sample.id, {
      ...sample,
      transportLatencyMs: Math.min(50, Math.max(previous?.transportLatencyMs ?? 0, sample.transportLatencyMs)),
    });
  }

  getConsumerCursor(id: number): SoundConsumerCursor | null {
    const sample = this.consumerSamples.get(id);
    if (!sample || !sample.byteLength || !sample.blockAlign) return null;
    const ageMs = Math.max(0, Date.now() - sample.observedAtEpochMs);
    if (ageMs > 250) return null;
    const advanced = sample.playing ? Math.floor((ageMs * sample.frequency) / 1000) * sample.blockAlign : 0;
    const aligned = Math.floor((sample.positionBytes + advanced) / sample.blockAlign) * sample.blockAlign;
    return {
      positionBytes: aligned % sample.byteLength,
      outputSampleRateHz: sample.outputSampleRateHz,
      transportLatencyMs: sample.transportLatencyMs,
      ageMs,
    };
  }

  createBuffer(id: number, byteLength: number, format: PcmWaveFormat): void {
    this.post({ type: 'audio', op: { op: 'createBuffer', id, byteLength, format } });
  }

  duplicateBuffer(sourceId: number, destinationId: number): boolean {
    this.post({ type: 'audio', op: { op: 'duplicateBuffer', sourceId, destinationId } });
    return true;
  }

  setFormat(id: number, format: PcmWaveFormat): boolean {
    this.post({ type: 'audio', op: { op: 'setFormat', id, format } });
    return true;
  }

  writeBuffer(id: number, offset: number, bytes: Uint8Array): number {
    const snapshot = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
    this.post({ type: 'audio', op: { op: 'writeBuffer', id, offset, bytes: snapshot } }, [snapshot.buffer]);
    return snapshot.byteLength;
  }

  play(id: number, options: PcmPlayOptions = {}): boolean {
    this.post({ type: 'audio', op: { op: 'play', id, options } });
    return true;
  }

  stop(id: number): boolean {
    this.post({ type: 'audio', op: { op: 'stop', id } });
    return true;
  }

  setCurrentPosition(id: number, byteOffset: number): boolean {
    this.post({ type: 'audio', op: { op: 'setCurrentPosition', id, byteOffset } });
    return true;
  }

  setVolume(id: number, volume: number): boolean {
    this.post({ type: 'audio', op: { op: 'setVolume', id, volume } });
    return true;
  }

  setPan(id: number, pan: number): boolean {
    this.post({ type: 'audio', op: { op: 'setPan', id, pan } });
    return true;
  }

  setFrequency(id: number, frequency: number): boolean {
    this.post({ type: 'audio', op: { op: 'setFrequency', id, frequency } });
    return true;
  }

  getState(_id: number): { positionBytes: number; playing: boolean } | null {
    return null;
  }

  recordStreamTrace(trace: SoundStreamingTrace): void {
    this.post({ type: 'audio', op: { op: 'streamTrace', trace } });
  }

  releaseBuffer(id: number): boolean {
    this.consumerSamples.delete(id);
    this.post({ type: 'audio', op: { op: 'releaseBuffer', id } });
    return true;
  }

  setMasterVolume(linear: number): void {
    this.post({ type: 'audio-control', action: 'master-volume', linear });
  }

  stopAll(): void {
    this.post({ type: 'audio-control', action: 'stop-all' });
  }

  async destroy(): Promise<void> {
    this.post({ type: 'audio-control', action: 'destroy' });
  }
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestIdOf(message: MainToWorkerMessage): number | undefined {
  switch (message.type) {
    case 'diagnostics':
    case 'game-performance':
    case 'init':
    case 'state':
    case 'guest-speed-flag':
    case 'mem-record-start':
    case 'mem-record-stop':
    case 'flush':
    case 'attach-maps':
    case 'lifecycle':
      return message.requestId;
    case 'control':
      return message.requestId;
    default:
      return undefined;
  }
}

export class VmWorkerController {
  private core: VmWorkerCore | null = null;
  private audioProxy: ProxyAudioSink | null = null;
  private sourceTemplate: GameFileProvider | null = null;
  private started = false;
  private initReady: Promise<void> = Promise.resolve();
  private pendingClock: number | null = null;
  private pendingVolume: number | null = null;
  private callBatchOrdinal = 0;
  private callBatchDelta = 0;
  private callBatchLogicFrames = 0;
  private callBatchHistogram = new Map<string, number>();
  private callBatchSamples: Array<{ call: Parameters<NonNullable<GameVmCallbacks['onCall']>>[0]; ordinal: number }> =
    [];
  private callBatchTimer: ReturnType<typeof globalThis.setInterval> | null = null;
  private callTracing = false;
  private relayPort: MessagePort | undefined;
  private portFiles: PortGameFileProvider | null = null;
  private nextFrameId = 1;
  private inFlightFrameId = 0;
  private pendingFrameEmit: (() => void) | null = null;
  private scheduledFrameEmission = false;
  private frameEmittedCount = 0;
  private frameAcknowledgedCount = 0;
  private readonly frameBuffers = new FrameBufferPool();
  private frameScheduleGeneration = 0;
  private readonly dependencies: Required<
    Pick<VmWorkerControllerDependencies, 'discoverSources' | 'applyResolution' | 'createCore' | 'fetchBytes'>
  > &
    Pick<VmWorkerControllerDependencies, 'createProvider' | 'audio'>;

  constructor(
    private readonly post: VmWorkerControllerDependencies['postMessage'],
    dependencies: Omit<VmWorkerControllerDependencies, 'postMessage'> = {},
  ) {
    this.dependencies = {
      discoverSources: dependencies.discoverSources ?? discoverGameSources,
      applyResolution: dependencies.applyResolution ?? withGameResolutionOverride,
      createCore: dependencies.createCore ?? ((callbacks, source, platform) => new VmCore(callbacks, source, platform)),
      fetchBytes: dependencies.fetchBytes ?? fetchBytes,
      createProvider: dependencies.createProvider,
      audio: dependencies.audio,
    };
  }

  async handleMessage(message: MainToWorkerMessage): Promise<void> {
    try {
      switch (message.type) {
        case 'audio-cursor':
          this.audioProxy?.updateConsumerCursor(message);
          break;
        case 'init':
          this.initReady = this.handleInit(message.config);
          await this.initReady;
          this.post({ type: 'init-done', requestId: message.requestId });
          break;
        case 'control':
          if (message.action === 'start') {
            await this.initReady;
            await this.handleStart();
            this.post({ type: 'control-done', action: 'start', requestId: message.requestId });
          } else {
            this.frameScheduleGeneration++;
            this.inFlightFrameId = 0;
            this.pendingFrameEmit = null;
            this.scheduledFrameEmission = false;
            if (this.core) await this.core.stop();
            this.started = false;
            this.post({ type: 'control-done', action: 'stop', requestId: message.requestId });
          }
          break;
        case 'wm':
          this.core?.postMessage(message.m, message.w, message.l);
          break;
        case 'key':
          this.core?.setKeyState(message.vk, message.down);
          break;
        case 'cursor':
          this.core?.setCursorPosition(message.x, message.y);
          break;
        case 'clock':
          this.pendingClock = message.rate;
          this.core?.setGameClockRate(message.rate);
          break;
        case 'volume':
          this.pendingVolume = message.linear;
          this.core?.setMasterVolume(message.linear);
          break;
        case 'call-tracing':
          this.callTracing = message.enabled;
          break;
        case 'game-performance':
          this.post({
            type: 'game-performance-reply',
            requestId: message.requestId,
            value: (await this.core?.getGamePerformance()) ?? null,
          });
          break;
        case 'diagnostics':
          if (!this.core) throw new Error('VM 尚未 init');
          this.post({
            type: 'diagnostics-reply',
            requestId: message.requestId,
            value: await this.core.getDiagnostics(message.action),
          });
          break;
        case 'state':
          this.post({
            type: 'state-reply',
            requestId: message.requestId,
            kind: message.kind,
            value: this.core?.getPointerState() ?? null,
          });
          break;
        case 'guest-speed-flag':
          this.post({
            type: 'guest-speed-flag-reply',
            requestId: message.requestId,
            value: this.core?.setGameSpeedFlag(message.value) ?? null,
          });
          break;
        case 'mem-record-start':
          this.post({
            type: 'mem-record-start-reply',
            requestId: message.requestId,
            ok: this.core?.startMemRecord() ?? false,
          });
          break;
        case 'mem-record-stop':
          this.post({
            type: 'mem-record-stop-reply',
            requestId: message.requestId,
            result: this.core?.stopMemRecord() ?? null,
          });
          break;
        case 'flush':
          await this.core?.flushFiles();
          this.post({ type: 'flush-done', requestId: message.requestId });
          break;
        case 'lifecycle': {
          let value: VmLifecycleSnapshot;
          if (!this.core) throw new Error('VM 尚未 init');
          if (message.action === 'pause') {
            this.frameScheduleGeneration++;
            this.inFlightFrameId = 0;
            this.pendingFrameEmit = null;
            this.scheduledFrameEmission = false;
            value =
              (await this.core.pauseForLifecycle?.()) ??
              this.core.getLifecycleSnapshot?.() ??
              unavailableLifecycleSnapshot();
          } else if (message.action === 'resume') {
            value =
              (await this.core.resumeForLifecycle?.()) ??
              this.core.getLifecycleSnapshot?.() ??
              unavailableLifecycleSnapshot();
          } else {
            value = this.core.getLifecycleSnapshot?.() ?? unavailableLifecycleSnapshot();
          }
          this.post({
            type: 'lifecycle-reply',
            action: message.action,
            requestId: message.requestId,
            value: this.withFramePipelineSnapshot(value),
          });
          break;
        }
        case 'attach-maps': {
          if (!this.core || !this.sourceTemplate) throw new Error('VM 尚未初始化');
          const { provider, result } = await prepareDynamicMaps(
            this.sourceTemplate,
            new Map(message.files.map(({ path, bytes }) => [path, bytes])),
          );
          this.core.setFileProvider(provider);
          this.sourceTemplate = provider;
          this.post({ type: 'attach-maps-done', requestId: message.requestId, result });
          break;
        }
        case 'frame-ack':
          this.acknowledgeFrame(message.frameId, message.frameGeneration);
          break;
        case 'recycle-frame':
          this.frameBuffers.release(message.buffer);
          break;
      }
    } catch (error) {
      const requestId = requestIdOf(message);
      this.post(
        requestId === undefined
          ? { type: 'error', message: errorMessage(error) }
          : { type: 'error', requestId, message: errorMessage(error) },
      );
      if (message.type === 'init' || (message.type === 'control' && message.action === 'start')) {
        this.post({ type: 'status', phase: 'error', detail: errorMessage(error) });
      }
    }
  }

  dispose(): void {
    this.relayPort?.close();
    this.relayPort = undefined;
    this.frameBuffers.clear();
    this.portFiles?.dispose();
    this.portFiles = null;
    if (this.callBatchTimer !== null) globalThis.clearInterval(this.callBatchTimer);
    this.callBatchTimer = null;
    this.frameScheduleGeneration++;
    this.pendingFrameEmit = null;
    this.inFlightFrameId = 0;
  }

  /** Rebuild the file backend from init: directory handles with optional online overlays, session-package memory files, or development HTTP. */
  private buildProvider(config: VmInitConfig): GameFileProvider {
    if (config.provider.kind === 'port') {
      return (this.portFiles = new PortGameFileProvider(
        config.provider.label,
        config.provider.port,
        config.provider.names,
      ));
    }
    if (config.provider.kind === 'memory') {
      // Session-package (online ZIP) files transfer into the Worker with init; directly rebuild the memory
      // provider with deepDiscovery and persist saves to the same-origin IndexedDB shared with the page.
      return new SessionGameFileProvider(
        config.provider.label,
        new Map(config.provider.files.map((entry) => [entry.path, entry.bytes])),
      );
    }
    if (config.provider.kind === 'directory') {
      const base = new DirectoryGameFileProvider(config.provider.handle);
      const overlays = config.provider.overlays ?? [];
      if (!overlays.length) return base;
      // Online-package overlays only fill gaps: authorized local directories take precedence, including Chinese resources; writes still use the directory backend.
      return new OverlayGameFileProvider(
        base,
        new Map(overlays.map((entry) => [entry.path, entry.bytes])),
        '（在线覆盖）',
        false,
        false,
        true,
      );
    }
    return new HttpGameFileProvider(config.provider.kind === 'http' ? config.provider.ownerDataToken : undefined);
  }

  private async handleInit(config: VmInitConfig): Promise<void> {
    if (this.core) throw new Error('重复 init');
    this.relayPort = config.relayPort;
    this.pendingClock ??= config.clockRate;
    this.pendingVolume ??= config.masterVolume;
    this.callTracing = config.traceCalls;
    let provider = this.dependencies.createProvider
      ? this.dependencies.createProvider(config)
      : this.buildProvider(config);
    if (config.selectedExecutable) {
      // Overlay before discovery, not merely by replacing executableBytes: discovery, PE loading,
      // and later guest reads of its own EXE must agree. Never fall back to old files through parent-first lookup.
      provider = new OverlayGameFileProvider(
        provider,
        new Map([[config.selectedExecutable.path, config.selectedExecutable.bytes]]),
        '（启动 EXE）',
        true,
        false,
        false,
      );
    }
    const sources = await this.dependencies.discoverSources(provider);
    const discoveredSource =
      sources.find((item) => item.game.id === config.preferredGameId) ??
      (sources.length === 1 ? sources[0] : undefined);
    if (!discoveredSource) {
      throw new Error(`未在游戏目录中找到 ${config.preferredGameId}（发现 ${sources.length} 款已支持游戏）`);
    }
    const mounted = config.additionalFiles?.length
      ? mountCustomMapFiles(discoveredSource, new Map(config.additionalFiles.map(({ path, bytes }) => [path, bytes])))
      : discoveredSource;
    const source = await withMultiplayerNameOverride(
      await this.dependencies.applyResolution(mounted, config.resolution),
      config.playerName,
    );
    this.sourceTemplate = source.files;
    const resolutionIni = await source.files.read(gameResolutionIni(source.game.id)).catch(() => null);
    const effectiveResolution = resolutionIni ? gameResolutionFromIni(resolutionIni) : null;
    this.post({
      type: 'guest-resolution',
      resolution: effectiveResolution ? `${effectiveResolution.width}x${effectiveResolution.height}` : null,
    });
    const callbacks: GameVmCallbacks = {
      onNetworkStatus: (status) => this.post({ type: 'network-status', status }),
      onStatus: (status) => this.post({ type: 'status', phase: status.phase, detail: status.detail }),
      onCall: (call, ordinal) => this.recordCall(call, ordinal),
      onBlocked: (call) => this.post({ type: 'blocked', call }),
      onFrame: (frame) => this.sendFrame(frame),
      onLogicFrame: () => {
        this.callBatchLogicFrames++;
      },
      onShellPage: (title) => this.post({ type: 'shell-page', title }),
      onMoviePlaybackState: (state) => this.post({ type: 'movie-state', state }),
    };
    const probe = new BrowserEmulatorProbe();
    const platform: VmCorePlatform = {
      createEmulator: (options) => createBrowserEmulator(options, probe),
      executionProbe: probe,
      ...gameVmConfiguration(
        source.game,
        callbacks.onNetworkStatus,
        config.ra2Network,
        config.relayPort ? (url) => new PortRelaySocket(config.relayPort!, url) : undefined,
      ),
      startupPage: config.startupPage,
      fetchBytes: this.dependencies.fetchBytes,
      scheduleFrame: (emit) => this.scheduleFrameWithBackpressure(emit),
      deferFrameSnapshot: true,
      packedRgb565Frames: true,
      takeFrameBuffer: (size) => this.frameBuffers.take(size),
      audio: this.dependencies.audio ?? (this.audioProxy = new ProxyAudioSink(this.post)),
      fastFileRead: config.fastFileRead,
    };
    this.core = this.dependencies.createCore(callbacks, source, platform);
    this.callBatchTimer ??= globalThis.setInterval(() => this.flushCallBatch(), 500);
  }

  private async handleStart(): Promise<void> {
    if (!this.core) throw new Error('VM 尚未 init');
    if (this.started) return;
    this.started = true;
    await this.core.start();
    this.core.setGameClockRate(this.pendingClock ?? 1);
    this.core.setMasterVolume(this.pendingVolume ?? 0.25);
  }

  private recordCall(call: Parameters<NonNullable<GameVmCallbacks['onCall']>>[0], ordinal: number): void {
    this.callBatchOrdinal = ordinal;
    this.callBatchDelta++;
    if (!this.callTracing) return;
    const key = call.imported.key;
    this.callBatchHistogram.set(key, (this.callBatchHistogram.get(key) ?? 0) + 1);
    if (ordinal <= 200 || ordinal % 256 === 0) this.callBatchSamples.push({ call, ordinal });
  }

  private flushCallBatch(): void {
    if (!this.callBatchDelta && !this.callBatchLogicFrames) return;
    this.post({
      type: 'call-batch',
      batch: {
        ordinal: this.callBatchOrdinal,
        delta: this.callBatchDelta,
        logicFrames: this.callBatchLogicFrames,
        histogram: [...this.callBatchHistogram],
        samples: this.callBatchSamples,
      },
    });
    this.callBatchDelta = 0;
    this.callBatchLogicFrames = 0;
    this.callBatchHistogram = new Map();
    this.callBatchSamples = [];
  }

  private sendFrame(frame: VmFrame): void {
    const frameId = this.nextFrameId++;
    const frameGeneration = this.frameScheduleGeneration;
    this.inFlightFrameId = frameId;
    this.frameEmittedCount++;
    const transfers: Transferable[] = [frame.pixels.buffer, frame.palette.buffer];
    if (frame.rgba) transfers.push(frame.rgba.buffer);
    if (frame.rgb565) transfers.push(frame.rgb565.buffer);
    if (frame.cursor) transfers.push(frame.cursor.rgba.buffer);
    this.post({ type: 'frame', frameId, frameGeneration, frame }, transfers);
  }

  private scheduleFrameWithBackpressure(emit: () => void): void {
    if (this.inFlightFrameId) {
      this.pendingFrameEmit = emit;
      return;
    }
    const generation = this.frameScheduleGeneration;
    this.scheduledFrameEmission = true;
    queueMicrotask(() => {
      if (generation !== this.frameScheduleGeneration || this.inFlightFrameId) return;
      this.scheduledFrameEmission = false;
      emit();
    });
  }

  private acknowledgeFrame(frameId: number, frameGeneration: number): void {
    if (frameId !== this.inFlightFrameId || frameGeneration !== this.frameScheduleGeneration) return;
    this.frameAcknowledgedCount++;
    this.inFlightFrameId = 0;
    const next = this.pendingFrameEmit;
    this.pendingFrameEmit = null;
    if (next) {
      const generation = ++this.frameScheduleGeneration;
      this.scheduledFrameEmission = true;
      queueMicrotask(() => {
        if (generation !== this.frameScheduleGeneration || this.inFlightFrameId) return;
        this.scheduledFrameEmission = false;
        next();
      });
    }
  }

  private withFramePipelineSnapshot(snapshot: VmLifecycleSnapshot): VmLifecycleSnapshot {
    return {
      ...snapshot,
      frameInFlightId: this.inFlightFrameId,
      framePendingEmission: this.pendingFrameEmit !== null || this.scheduledFrameEmission,
      frameScheduleGeneration: this.frameScheduleGeneration,
      frameEmittedCount: this.frameEmittedCount,
      frameAcknowledgedCount: this.frameAcknowledgedCount,
    };
  }
}

export function createVmWorkerController(dependencies: VmWorkerControllerDependencies): VmWorkerController {
  const { postMessage, ...rest } = dependencies;
  return new VmWorkerController(postMessage, rest);
}

function unavailableLifecycleSnapshot(): VmLifecycleSnapshot {
  return {
    observedAtEpochMs: Date.now(),
    phase: 'error',
    guestLogicFrame: 0,
    guestTimeMs: null,
    guestClockPaused: false,
    workerRunning: false,
    lifecyclePaused: false,
    hypercallPending: false,
    guestRequestPending: false,
    pendingFileReads: 0,
    pendingFileWrites: 0,
    rangePrefetchPending: false,
    rangePrefetchSpeculating: false,
    lifecycleCycles: 0,
    flushOk: null,
    safeToResume: false,
    recoveryReason: 'runtime-unavailable',
    frameInFlightId: 0,
    framePendingEmission: false,
    frameScheduleGeneration: 0,
    frameEmittedCount: 0,
    frameAcknowledgedCount: 0,
  };
}

export function installVmWorker(
  scope: WorkerScope,
  dependencies: Omit<VmWorkerControllerDependencies, 'postMessage'> = {},
): VmWorkerController {
  const controller = createVmWorkerController({ postMessage: scope.postMessage.bind(scope), ...dependencies });
  const queue = new SerialTaskQueue((error) => {
    scope.postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
  });
  scope.postMessage({ type: 'probe', ready: true });
  scope.onmessage = (event) => {
    void queue.enqueue(() => controller.handleMessage(event.data));
  };
  return controller;
}
