/** Prove the real Worklet and a real Worker observe one control block, without cursor-message freshness. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const result = await page.evaluate<{
    shared: boolean;
    directProgress: number;
    frozen: boolean;
    retired: boolean;
  }>(`(async () => {
    if(!crossOriginIsolated || typeof SharedArrayBuffer !== 'function') throw new Error('Shared audio-reader unavailable');
    const { WebAudioPcmSink } = await import('/src/adapter/audio.ts');
    const workerURL = URL.createObjectURL(new Blob([
      "let words; onmessage = e => { if(e.data.control) words = new Int32Array(e.data.control); postMessage(Array.from(words)); };"
    ], { type: 'text/javascript' }));
    const worker = new Worker(workerURL);
    const context = new AudioContext();
    let reader, errors = [];
    const sink = new WebAudioPcmSink({ contextFactory: () => context,
      onStreamReader: (_id, value) => { reader = value; }, onError: e => errors.push(String(e)) });
    const wait = async condition => {
      const deadline = performance.now() + 5000;
      while(!condition()) {
        if(errors.length || performance.now() > deadline) throw new Error(errors.join('; ') || 'Reader progress timeout');
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    const snapshot = payload => new Promise(resolve => {
      worker.onmessage = event => resolve(event.data);
      worker.postMessage(payload);
    });
    try {
      await sink.unlockForStart();
      sink.createBuffer(42, 88200);
      sink.writeBuffer(42, 0, new Uint8Array(88200));
      sink.play(42, { loop: true });
      sink.writeBuffer(42, 4096, new Uint8Array(512));
      await wait(() => reader && Atomics.load(new Int32Array(reader.control), 2) > 0);
      const first = await snapshot({control: reader.control});
      // Withhold main-thread servicing; rendering must publish directly to the Worker-visible block.
      const until = performance.now() + 200;
      while(performance.now() < until) {}
      const second = await snapshot({});
      if(second[2] <= first[2]) throw new Error('Worklet did not advance its shared reader during main-thread delay');
      await context.suspend();
      const stopped = await snapshot({});
      await new Promise(resolve => setTimeout(resolve, 350));
      const unchanged = await snapshot({});
      if(unchanged[2] !== stopped[2]) throw new Error('Wall time fabricated consumer progress');
      if(sink.getConsumerCursor(42).positionBytes !== unchanged[1] * 4) throw new Error('Sink extrapolated atomic cursor');
      sink.stop(42);
      if(Atomics.load(new Int32Array(reader.control), 4) !== 0) throw new Error('Reader was not retired');
      return {shared: true, directProgress: second[2] - first[2], frozen: unchanged[2] === stopped[2], retired: true};
    } finally {
      worker.terminate(); URL.revokeObjectURL(workerURL); await sink.destroy();
    }
  })()`);
  assert.equal(result.shared, true);
  assert.ok(result.directProgress > 0);
  assert.equal(result.frozen, true);
  assert.equal(result.retired, true);
  console.log(result);
} finally {
  await browser.close();
}
