import type { VmShell } from '../../../adapter/vmShell';
import { reportNativeRuntimeMetrics } from '../../../platform/browser/nativeDiagnostics';

export interface IosTapToStartGate {
  ready: Promise<boolean>;
  cancel(): void;
}

/** Show one in-WebView trusted gesture before starting native iOS guest execution. */
export function createIosTapToStartGate(
  canvas: HTMLCanvasElement,
  vm: VmShell,
  isCurrent: () => boolean,
  onStarted: () => void,
): IosTapToStartGate {
  document.getElementById('ios-tap-to-start')?.remove();
  const surface = document.createElement('div');
  surface.id = 'ios-tap-to-start';
  surface.className = 'ios-tap-start-gate';
  surface.setAttribute('role', 'dialog');
  surface.setAttribute('aria-modal', 'true');
  surface.setAttribute('aria-labelledby', 'ios-tap-to-start-title');

  const panel = document.createElement('div');
  panel.className = 'ios-tap-start-panel';
  const title = document.createElement('h1');
  title.id = 'ios-tap-to-start-title';
  title.textContent = 'RA2 is ready';
  const detail = document.createElement('p');
  detail.textContent = 'Tap once to start the game and enable audio.';
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'Tap to Start';
  const status = document.createElement('p');
  status.className = 'ios-tap-start-status';
  status.setAttribute('aria-live', 'polite');
  panel.append(title, detail, button, status);
  surface.append(panel);
  (canvas.closest('#screen-frame') ?? canvas.parentElement ?? document.body).append(surface);

  let settled = false;
  let busy = false;
  let settle!: (ready: boolean) => void;
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const cleanup = (result: boolean): void => {
    if (settled) return;
    settled = true;
    button.removeEventListener('click', startFromGesture);
    surface.remove();
    settle(result);
  };
  const startFromGesture = async (): Promise<void> => {
    if (settled || busy) return;
    busy = true;
    button.disabled = true;
    status.textContent = 'Enabling audio…';
    try {
      // Calling this before the first await keeps AudioContext.resume() within this trusted WebView click.
      const audio = await vm.unlockAudioForStart();
      const workletReady = !audio.audioWorkletSupported || audio.audioWorkletModuleLoaded === true;
      const unlocked = audio.unlockResult === true && audio.contextState === 'running' && workletReady;
      reportNativeRuntimeMetrics({
        event: 'ios-audio-gate',
        gatePhase: 'tap-to-start',
        audioContextState: audio.contextState,
        audioContextTimeSeconds: audio.contextTimeSeconds ?? undefined,
        audioUnlockResult: Number(audio.unlockResult === true),
        audioWorkletSupported: Number(audio.audioWorkletSupported === true),
        audioWorkletModuleLoaded: Number(audio.audioWorkletModuleLoaded === true),
        audioSourceCount: audio.sourceCount,
        audioStreamCount: audio.streamCount,
        audioWorkletCount: audio.workletCount,
        audioLiveProcessorCount: audio.liveProcessorCount,
      });
      if (!isCurrent()) {
        cleanup(false);
        return;
      }
      if (!unlocked) throw new Error('Audio could not start. Tap to retry.');
      onStarted();
      cleanup(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      status.textContent = message.slice(0, 120);
      button.disabled = false;
      busy = false;
      reportNativeRuntimeMetrics({ event: 'ios-audio-gate', gatePhase: 'unlock-failed', error: message.slice(0, 120) });
    }
  };
  button.addEventListener('click', startFromGesture);
  button.focus();

  return { ready, cancel: () => cleanup(false) };
}
