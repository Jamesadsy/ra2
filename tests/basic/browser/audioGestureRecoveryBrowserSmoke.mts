/** Model WKWebView autoplay denial, then prove resume starts inside a real trusted browser gesture. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

declare global {
  interface Window {
    __ra2GestureActive: boolean;
    __ra2GestureResumeAttempts: Array<{ trusted?: boolean; state?: string; error?: string }>;
    __ra2AudioTest: any;
  }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] });
const freshContextPolicy = process.env.RA2_BROWSER_FRESH_CONTEXT === '1';
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  await page.evaluate(() => {
    document.body.innerHTML = '<button id="begin">Begin audio</button><button id="gesture">Recover audio</button>';
  });
  await page.evaluate(`(async () => {
    const { WebAudioPcmSink } = await import('/src/adapter/audio.ts');
    const attempts = [];
    const originalResume = AudioContext.prototype.resume;
    window.__ra2GestureActive = false;
    window.__ra2GestureResumeAttempts = attempts;
    window.addEventListener('pointerdown', event => {
      window.__ra2GestureActive = event.isTrusted;
      setTimeout(() => { window.__ra2GestureActive = false; }, 0);
    }, true);
    AudioContext.prototype.resume = function() {
      const trusted = window.__ra2GestureActive === true;
      attempts.push({ trusted, state: this.state });
      if (!trusted) return Promise.reject(new DOMException('automatic resume denied by deterministic policy', 'NotAllowedError'));
      return originalResume.call(this);
    };

    const contexts = [];
    const sink = new WebAudioPcmSink({
      contextFactory: () => { const context = new AudioContext(); contexts.push(context); return context; },
      foregroundRecoveryPolicy: ${JSON.stringify(freshContextPolicy ? 'fresh-context-on-trusted-input' : 'same-context')},
      onError: error => attempts.push({ error: String(error) })
    });
    const originalNode = AudioWorkletNode;
    let nodesCreated = 0;
    AudioWorkletNode = class extends originalNode {
      constructor(...args) {
        super(...args);
        nodesCreated++;
      }
    };
    let guestFrames = 0;
    const guestTimer = setInterval(() => { guestFrames++; }, 16);
    const format = { wFormatTag: 1, nChannels: 1, nSamplesPerSec: 44100, nAvgBytesPerSec: 88200, nBlockAlign: 2, wBitsPerSample: 16, cbSize: 0 };
    const pcm = new Uint8Array(88200);
    const samples = new DataView(pcm.buffer);
    for (let frame = 0; frame < pcm.length / 2; frame++) samples.setInt16(frame * 2, Math.round(Math.sin(frame * 0.08) * 18000), true);
    document.querySelector('#begin').addEventListener('click', async () => {
      sink.createBuffer('music', pcm.length, format);
      sink.writeBuffer('music', 0, pcm);
      sink.play('music', { loop: true });
      sink.writeBuffer('music', 0, pcm.subarray(0, 1024));
      await sink.unlockForStart();
    });
    document.querySelector('#gesture').addEventListener('click', () => {});
    sink.installUserGestureUnlock(document);
    window.__ra2AudioTest = {
      sink,
      get context() { return contexts.at(-1); },
      get contexts() { return contexts; },
      attempts,
      get nodesCreated() { return nodesCreated; },
      get guestFrames() { return guestFrames; },
      async suspend() { return sink.suspendForLifecycle(); },
      async automaticResume() { return sink.resumeForLifecycle(); },
      snapshot() { return sink.getLifecycleSnapshot(); },
      destroy() { clearInterval(guestTimer); return sink.destroy(); },
    };
  })()`);
  await page.locator('#begin').click();
  await page.waitForFunction(
    () => {
      const test = window.__ra2AudioTest;
      const snapshot = test?.snapshot();
      return (
        snapshot?.contextState === 'running' &&
        snapshot.playingBuffers === 1 &&
        (snapshot.workletCount === 1 || snapshot.streamCount === 1)
      );
    },
    undefined,
    { timeout: 10_000 },
  );

  const delaysMs = [1_000, 7_000, 1_000];
  const cycles = [];
  for (const [cycleIndex, delayMs] of delaysMs.entries()) {
    const before = await page.evaluate(() => window.__ra2AudioTest.snapshot());
    const suspended = await page.evaluate(() => window.__ra2AudioTest.suspend());
    assert.equal(suspended.lifecycleRecoveryPending, true);
    assert.equal(suspended.playingBuffers, 1);
    assert.equal(suspended.sourceCount + suspended.streamCount + suspended.workletCount, 0);
    assert.equal(suspended.suspendSucceeded, true);
    assert.equal(suspended.contextState, 'suspended');
    await page.waitForTimeout(delayMs);
    if (cycleIndex === 2) {
      // Model WebKit reporting "running" while the suspended render clock is still stuck.
      await page.evaluate(
        "Object.defineProperty(window.__ra2AudioTest.context, 'state', { configurable: true, get: function() { return 'running'; } })",
      );
    }
    const automatic = await page.evaluate(() => window.__ra2AudioTest.automaticResume());
    assert.equal(automatic.automaticResumeAttempted, true);
    assert.equal(automatic.automaticResumeResult, false, 'the deterministic policy denies non-gesture resume');
    assert.equal(automatic.lifecycleRecoveryPending, true);
    assert.equal(automatic.contextState, freshContextPolicy || cycleIndex === 2 ? 'running' : 'suspended');
    const framesWhileAway = await page.evaluate(() => window.__ra2AudioTest.guestFrames);

    if (cycleIndex === 0) {
      const attemptsBeforeSynthetic = automatic.trustedGestureAttemptCount;
      await page.locator('#gesture').dispatchEvent('pointerdown');
      const untrusted = await page.evaluate(() => window.__ra2AudioTest.snapshot());
      assert.equal(untrusted.trustedInteractionTrusted, false);
      assert.equal(
        untrusted.trustedGestureAttemptCount,
        attemptsBeforeSynthetic,
        'synthetic events cannot unlock audio',
      );
    }

    await page.locator('#gesture').click();
    await page.waitForFunction(
      () => {
        const test = window.__ra2AudioTest;
        const snapshot = test?.snapshot();
        return (
          snapshot?.contextState === 'running' &&
          snapshot.trustedGestureResumeResult === true &&
          snapshot.lifecycleRecoveryPending === false &&
          snapshot.playingBuffers === 1 &&
          snapshot.sourceCount + snapshot.streamCount + snapshot.workletCount === 1
        );
      },
      undefined,
      { timeout: 10_000 },
    );
    // Graph creation is not evidence that the audio thread has rendered or delivered its first
    // position report. Wait for that report instead of racing a fixed delay on a busy test host.
    await page.waitForFunction(
      ({ position, total, contextTime }) => {
        const test = window.__ra2AudioTest;
        const snapshot = test.snapshot();
        const delta = (snapshot.buffers[0].positionFrames - position + total) % total;
        return snapshot.liveProcessorCount === 1 && test.context.currentTime > contextTime && delta > 0;
      },
      {
        position: suspended.buffers[0].positionFrames,
        total: suspended.buffers[0].totalFrames,
        contextTime: automatic.contextTimeSeconds,
      },
      { timeout: 10_000 },
    );
    const after = await page.evaluate(() => window.__ra2AudioTest.snapshot());
    const state = await page.evaluate(() => ({
      contextTime: window.__ra2AudioTest.context.currentTime,
      frames: window.__ra2AudioTest.guestFrames,
      attempts: window.__ra2GestureResumeAttempts,
      nodesCreated: window.__ra2AudioTest.nodesCreated,
      reportedRunningOverride: Object.hasOwn(window.__ra2AudioTest.context, 'state'),
    }));
    await page.evaluate(() => {
      delete window.__ra2AudioTest.context.state;
    });
    assert.equal(after.trustedInteractionTrusted, true);
    assert.equal(
      after.trustedGestureAttemptCount,
      cycles.length + 2,
      'include the initial start tap and each recovery tap',
    );
    assert.equal(after.contextCreationCount, freshContextPolicy ? cycleIndex + 2 : 1);
    if (freshContextPolicy) {
      assert.notEqual(after.contextIdentity, before.contextIdentity);
      assert.equal(after.freshContextRecoveryCount, cycleIndex + 1);
      assert.equal(after.retiredContextCount, cycleIndex + 1);
      assert.equal(after.retiredContextCloseFailures, 0);
      if (cycleIndex === 2) {
        await page.evaluate(() => {
          delete window.__ra2AudioTest.contexts.at(-2).state;
        });
      }
      await page.waitForFunction(
        () => window.__ra2AudioTest.contexts.slice(0, -1).every((context: AudioContext) => context.state === 'closed'),
        undefined,
        { timeout: 3_000 },
      );
    } else {
      assert.equal(after.contextIdentity, before.contextIdentity);
    }
    assert.equal(after.playingBuffers, 1);
    assert.equal(after.workletCount + after.streamCount, 1);
    assert.equal(after.sourceCount, 0, 'the one-shot source must not remain next to the rebuilt live stream');
    assert.equal(after.liveProcessorCount, 1);
    assert.ok(after.audioWorkletModuleLoaded === true || after.streamCount === 1);
    const totalFrames = after.buffers[0].totalFrames;
    const cursorDelta =
      (after.buffers[0].positionFrames - suspended.buffers[0].positionFrames + totalFrames) % totalFrames;
    assert.ok(cursorDelta < 20_000, `cursor discontinuity after lifecycle recovery: ${cursorDelta} frames`);
    assert.ok(state.contextTime > automatic.contextTimeSeconds, 'AudioContext clock must advance after recovery');
    assert.ok(framesWhileAway > 0, 'the modeled guest heartbeat remains live while audio is suspended');
    assert.ok(state.frames > framesWhileAway, 'gameplay heartbeat continues after the trusted interaction');
    assert.ok(
      state.attempts.some((attempt) => attempt.trusted === false),
      'automatic resume denial must be observed',
    );
    assert.ok(
      state.attempts.some((attempt) => attempt.trusted === true),
      'resume must be called in a trusted event stack',
    );
    if (cycleIndex === 2) {
      assert.equal(state.reportedRunningOverride, !freshContextPolicy);
      assert.ok(
        state.attempts.some((attempt) => attempt.trusted === true),
        'trusted recovery must force resume even when WebKit initially reports running',
      );
    }
    assert.equal(state.nodesCreated, cycles.length + 2, 'each recovery builds exactly one new worklet');
    cycles.push({
      delayMs,
      contextState: after.contextState,
      cursorDelta,
      sources: after.sourceCount,
      streams: after.streamCount,
      worklets: after.workletCount,
    });
  }

  const final = await page.evaluate(async () => {
    const result = { snapshot: window.__ra2AudioTest.snapshot(), attempts: window.__ra2GestureResumeAttempts.slice() };
    await window.__ra2AudioTest.destroy();
    return result;
  });
  assert.equal(final.snapshot.contextCreationCount, freshContextPolicy ? 4 : 1);
  assert.equal(final.snapshot.trustedGestureAttemptCount, 4, 'one start tap plus three recovery taps');
  assert.equal(final.snapshot.contextState, 'running');
  console.log({
    policy: freshContextPolicy ? 'fresh' : 'same',
    cycles,
    resumeAttempts: final.attempts.length,
    contextCreations: final.snapshot.contextCreationCount,
  });
} finally {
  await browser.close();
}
