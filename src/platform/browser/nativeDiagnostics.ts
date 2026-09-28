type NativeDiagnosticRecord = Record<string, number | string | undefined>;

interface NativeDiagnosticsBridge {
  phase: (phase: string) => void;
  error: (event: string, message: string, stack?: string) => void;
  touch: (record: NativeDiagnosticRecord) => void;
  metrics: (record: NativeDiagnosticRecord) => void;
  event: (event: string) => void;
}

let lastJoystickDiagnosticAt = 0;

declare global {
  interface Window {
    __RA2Host?: { platform: 'ios'; version: 1; ownerDataToken: string };
    __RA2NativeDiagnostics?: NativeDiagnosticsBridge;
    __ra2NativeTouchDiagnosticsInstalled?: boolean;
  }
}

function nativeBridge(): NativeDiagnosticsBridge | undefined {
  if (typeof window === 'undefined' || window.__RA2Host?.platform !== 'ios' || window.__RA2Host.version !== 1) {
    return undefined;
  }
  return window.__RA2NativeDiagnostics;
}

export function reportNativeRuntimePhase(phase: string): void {
  nativeBridge()?.phase(phase);
}

export function reportNativeRuntimeEvent(event: string): void {
  nativeBridge()?.event(event);
}

export function reportNativeRuntimeError(event: string, error: unknown): void {
  const value = error instanceof Error ? error : new Error(String(error));
  nativeBridge()?.error(event, value.message, value.stack ?? '');
}

export function reportNativeTouch(record: NativeDiagnosticRecord): void {
  if (record.gesture === 'joystick') {
    const now = performance.now();
    if (now - lastJoystickDiagnosticAt < 100) return;
    lastJoystickDiagnosticAt = now;
  }
  nativeBridge()?.touch(record);
}

function orientation(): string {
  const type = screen.orientation?.type ?? '';
  if (type.startsWith('portrait-primary')) return 'portrait';
  if (type.startsWith('portrait-secondary')) return 'portraitUpsideDown';
  if (type.startsWith('landscape-primary')) return 'landscapeLeft';
  if (type.startsWith('landscape-secondary')) return 'landscapeRight';
  return 'unknown';
}

function reportViewport(): void {
  if (!nativeBridge()) return;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;visibility:hidden;pointer-events:none;padding-top:env(safe-area-inset-top);padding-right:env(safe-area-inset-right);padding-bottom:env(safe-area-inset-bottom);padding-left:env(safe-area-inset-left)';
  document.documentElement.appendChild(probe);
  const inset = getComputedStyle(probe);
  const record: NativeDiagnosticRecord = {
    event: 'viewport',
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    screenWidth: screen.width,
    screenHeight: screen.height,
    devicePixelRatio: window.devicePixelRatio,
    safeAreaTop: Number.parseFloat(inset.paddingTop) || 0,
    safeAreaRight: Number.parseFloat(inset.paddingRight) || 0,
    safeAreaBottom: Number.parseFloat(inset.paddingBottom) || 0,
    safeAreaLeft: Number.parseFloat(inset.paddingLeft) || 0,
    orientation: orientation(),
  };
  probe.remove();
  nativeBridge()?.metrics(record);
  nativeBridge()?.touch(record);
}

/** Capture only bounded pointer metadata; no DOM text, paths, owner bytes, or capability values enter diagnostics. */
export function installNativeTouchDiagnostics(): void {
  if (!nativeBridge() || window.__ra2NativeTouchDiagnosticsInstalled) return;
  window.__ra2NativeTouchDiagnosticsInstalled = true;
  let lastMove = 0;
  let previous: { x: number; y: number } | null = null;
  const onPointer = (event: PointerEvent): void => {
    const now = performance.now();
    if (event.type === 'pointermove' && now - lastMove < 100) return;
    if (event.type === 'pointermove') lastMove = now;
    const x = Number.isFinite(event.clientX) ? event.clientX : 0;
    const y = Number.isFinite(event.clientY) ? event.clientY : 0;
    const record: NativeDiagnosticRecord = {
      event: event.type,
      pointerType: event.pointerType,
      pointerId: event.pointerId,
      button: event.button,
      buttons: event.buttons,
      x,
      y,
      deltaX: previous ? x - previous.x : 0,
      deltaY: previous ? y - previous.y : 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      devicePixelRatio: window.devicePixelRatio,
      pressure: event.pressure,
      orientation: orientation(),
    };
    previous = { x, y };
    nativeBridge()?.touch(record);
  };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const) {
    window.addEventListener(type, onPointer, { capture: true, passive: true });
  }
  window.addEventListener('resize', reportViewport, { passive: true });
  window.addEventListener('orientationchange', reportViewport, { passive: true });
  window.addEventListener('pagehide', () => nativeBridge()?.event('web pagehide'), { once: true });
  reportViewport();
}
