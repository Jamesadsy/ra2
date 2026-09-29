/** Verify the native WebView gate becomes interactive before its trusted click unlocks WebAudio. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  // tsx adds this helper when serializing named functions inside Playwright evaluate callbacks.
  await page.evaluate('globalThis.__name ??= (fn) => fn');
  await page.evaluate(async () => {
    Object.defineProperty(window, '__RA2Host', {
      value: { platform: 'ios', version: 1, ownerDataToken: 'synthetic-test-only' },
      configurable: true,
    });
    const modulePath = '/src/ui/pages/game/iosTapToStartGate.ts';
    const module = await import(modulePath);
    const audioPath = '/src/adapter/audio.ts';
    const audioModule = await import(audioPath);
    (
      window as typeof window & { __createIosTapToStartGate?: typeof module.createIosTapToStartGate }
    ).__createIosTapToStartGate = module.createIosTapToStartGate;
    (window as typeof window & { __WebAudioPcmSink?: typeof audioModule.WebAudioPcmSink }).__WebAudioPcmSink =
      audioModule.WebAudioPcmSink;
  });

  await page.evaluate(async () => {
    const phases: string[] = [];
    const events: string[] = [];
    const metrics: Array<Record<string, unknown>> = [];
    const timeline: string[] = [];
    let trustedClick = false;
    const readinessSnapshots: Array<{ surfaceConnected: boolean; buttonConnected: boolean; buttonEnabled: boolean }> =
      [];
    const audioContexts: AudioContext[] = [];
    const audioErrors: string[] = [];
    Object.defineProperty(window, '__RA2NativeDiagnostics', {
      value: {
        phase: (phase: string) => {
          phases.push(phase);
          if (phase === 'tapToStartReady') {
            const surface = document.getElementById('ios-tap-to-start');
            const button = surface?.querySelector('button');
            readinessSnapshots.push({
              surfaceConnected: surface?.isConnected === true,
              buttonConnected: button?.isConnected === true,
              buttonEnabled: button instanceof HTMLButtonElement && !button.disabled,
            });
          }
        },
        event: (event: string) => {
          events.push(event);
        },
        metrics: (record: Record<string, unknown>) => {
          metrics.push(record);
        },
        error: () => {},
        touch: () => {},
      },
      configurable: true,
    });
    document.addEventListener(
      'click',
      (event) => {
        if ((event.target as Element | null)?.closest?.('#ios-tap-to-start')) {
          trustedClick = event.isTrusted;
          timeline.push(`click:${event.isTrusted}`);
        }
      },
      true,
    );

    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const Sink = (window as typeof window & { __WebAudioPcmSink: new (options: object) => any }).__WebAudioPcmSink;
    const context = new AudioContext();
    const resume = context.resume.bind(context);
    context.resume = () => {
      timeline.push(`resume-called:${navigator.userActivation?.isActive === true}`);
      return resume();
    };
    audioContexts.push(context);
    await context.suspend();
    const sink = new Sink({
      contextFactory: () => context,
      onError: (error: unknown) => audioErrors.push(String(error)),
    });
    const vm = {
      unlockAudioForStart() {
        timeline.push(`unlock:${trustedClick}`);
        const unlock = sink.unlockForStart();
        timeline.push('unlock-returned');
        return unlock.then((unlockResult: boolean) => sink.getLifecycleSnapshot(unlockResult));
      },
    };
    const createGate = (
      window as typeof window & {
        __createIosTapToStartGate: typeof import('../../../src/ui/pages/game/iosTapToStartGate').createIosTapToStartGate;
      }
    ).__createIosTapToStartGate;
    const gate = createGate(
      canvas,
      vm as never,
      () => true,
      () => timeline.push('on-started'),
    );
    let resolutionCount = 0;
    gate.ready.then((result) => {
      resolutionCount++;
      (window as typeof window & { __tapToStartResult?: boolean }).__tapToStartResult = result;
    });
    (
      window as typeof window & {
        __tapToStartProbe?: {
          gate: typeof gate;
          audioContexts: AudioContext[];
          audioErrors: string[];
          sink: { destroy(): Promise<void> };
          phases: string[];
          events: string[];
          metrics: Array<Record<string, unknown>>;
          readinessSnapshots: typeof readinessSnapshots;
          timeline: string[];
          getResolutionCount: () => number;
        };
      }
    ).__tapToStartProbe = {
      gate,
      audioContexts,
      audioErrors,
      sink,
      phases,
      events,
      metrics,
      readinessSnapshots,
      timeline,
      getResolutionCount: () => resolutionCount,
    };
  });

  await page.waitForFunction(() =>
    (window as typeof window & { __tapToStartProbe?: { phases: string[] } }).__tapToStartProbe?.phases.includes(
      'tapToStartReady',
    ),
  );
  const ready = await page.evaluate(() => {
    const probe = (
      window as typeof window & {
        __tapToStartProbe: {
          phases: string[];
          events: string[];
          readinessSnapshots: Array<{ surfaceConnected: boolean; buttonConnected: boolean; buttonEnabled: boolean }>;
        };
      }
    ).__tapToStartProbe;
    return {
      count: document.querySelectorAll('#ios-tap-to-start').length,
      phases: probe.phases,
      events: probe.events,
      snapshot: probe.readinessSnapshots[0],
    };
  });
  assert.equal(ready.count, 1, 'exactly one gate exists');
  assert.deepEqual(ready.phases, ['tapToStartReady']);
  assert.equal(ready.snapshot.surfaceConnected, true, 'gate surface is attached before ready');
  assert.equal(ready.snapshot.buttonConnected, true, 'button exists before ready');
  assert.equal(ready.snapshot.buttonEnabled, true, 'button is enabled before ready');
  assert.ok(ready.events.indexOf('tap-to-start DOM created') < ready.events.indexOf('tap-to-start gate-ready emitted'));

  await page.locator('#ios-tap-to-start button').click();
  await page.waitForFunction(
    () => (window as typeof window & { __tapToStartResult?: boolean }).__tapToStartResult === true,
  );
  const accepted = await page.evaluate(async () => {
    await Promise.resolve();
    const probe = (
      window as typeof window & {
        __tapToStartProbe: {
          gate: { cancel(): void };
          audioContexts: AudioContext[];
          audioErrors: string[];
          sink: { destroy(): Promise<void> };
          phases: string[];
          events: string[];
          metrics: Array<Record<string, unknown>>;
          timeline: string[];
          getResolutionCount: () => number;
        };
      }
    ).__tapToStartProbe;
    const clickIndex = probe.timeline.indexOf('click:true');
    const result = {
      phases: probe.phases,
      events: probe.events,
      metrics: probe.metrics,
      timeline: probe.timeline,
      resolutionCount: probe.getResolutionCount(),
      surfaceCount: document.querySelectorAll('#ios-tap-to-start').length,
      clickWasTrusted: clickIndex >= 0,
      unlockWasDirect: clickIndex >= 0 && probe.timeline[clickIndex + 1] === 'unlock:true',
      resumeWasImmediate: clickIndex >= 0 && probe.timeline[clickIndex + 2]?.startsWith('resume-called:') === true,
      audioContextCount: probe.audioContexts.length,
      audioErrors: probe.audioErrors,
    };
    probe.gate.cancel();
    await probe.sink.destroy();
    await Promise.resolve();
    result.resolutionCount = probe.getResolutionCount();
    return result;
  });
  assert.deepEqual(accepted.phases, ['tapToStartReady', 'tapToStartAccepted']);
  assert.equal(accepted.clickWasTrusted, true, 'Playwright produced a trusted DOM click');
  assert.equal(accepted.unlockWasDirect, true, 'Audio unlock started in the click handler');
  assert.equal(
    accepted.resumeWasImmediate,
    true,
    `AudioContext.resume was called in the trusted click stack: ${accepted.timeline.join(' -> ')}`,
  );
  assert.ok(accepted.events.includes('tap-to-start audio unlock passed'));
  assert.ok(accepted.events.includes('tap-to-start user gesture accepted'));
  const audioMetrics = accepted.metrics.find((item) => item.event === 'ios-audio-gate');
  assert.equal(audioMetrics?.audioUnlockResult, 1);
  assert.equal(audioMetrics?.audioContextState, 'running');
  if (audioMetrics?.audioWorkletSupported === 1) assert.equal(audioMetrics.audioWorkletModuleLoaded, 1);
  assert.deepEqual(accepted.audioErrors, []);
  assert.equal(accepted.resolutionCount, 1, 'gate result resolves exactly once');
  assert.equal(accepted.surfaceCount, 0, 'accepted gate cleans up its DOM');

  await page.evaluate(() => {
    const probe = (window as typeof window & { __tapToStartProbe: { gate: { cancel(): void }; phases: string[] } })
      .__tapToStartProbe;
    const canvas = document.querySelector('canvas') as HTMLCanvasElement;
    const createGate = (
      window as typeof window & {
        __createIosTapToStartGate: typeof import('../../../src/ui/pages/game/iosTapToStartGate').createIosTapToStartGate;
      }
    ).__createIosTapToStartGate;
    const retryGate = createGate(
      canvas,
      { unlockAudioForStart: async () => ({}) } as never,
      () => true,
      () => {},
    );
    const cancelled = retryGate.ready.then((result) => {
      (window as typeof window & { __tapToStartCancelled?: boolean }).__tapToStartCancelled = !result;
    });
    retryGate.cancel();
    void cancelled;
    const replacement = createGate(
      canvas,
      { unlockAudioForStart: async () => ({}) } as never,
      () => true,
      () => {},
    );
    (window as typeof window & { __tapToStartReplacement?: typeof replacement }).__tapToStartReplacement = replacement;
    probe.gate.cancel();
  });
  await page.waitForFunction(
    () => (window as typeof window & { __tapToStartCancelled?: boolean }).__tapToStartCancelled === true,
  );
  const retry = await page.evaluate(() => {
    const replacement = (window as typeof window & { __tapToStartReplacement: { cancel(): void } })
      .__tapToStartReplacement;
    const count = document.querySelectorAll('#ios-tap-to-start').length;
    replacement.cancel();
    return count;
  });
  assert.equal(retry, 1, 'cancel and replacement leave one gate and no orphan overlay');
  console.log({ ready, accepted, retry });
} finally {
  await browser.close();
}
