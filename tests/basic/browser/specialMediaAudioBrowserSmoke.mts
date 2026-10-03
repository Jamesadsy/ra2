/** Asset-free startup/refill integration through the real browser sink and renderer. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { buildPe32 } from '../../fixture/peBuilder';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

const dll = buildPe32({
  imageBase: 0x500000,
  entryRva: 0,
  sections: [{ name: '.text', data: Uint8Array.of(0xc3), characteristics: 0x60000020 }],
  imports: [],
}).exe;
const browser = await chromium.launch({ args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await preventThirdPartyDownloads(page);
  await page.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const result = await page.evaluate<{
    initialBudget: number;
    readerBeforeRefill: boolean;
    origins: number[];
    sources: number[];
    consumed: number;
    authoritative: boolean;
    explicit: boolean;
  }>(`(async () => {
    const { WebAudioPcmSink } = await import('/src/adapter/audio.ts');
    const { RA2_SHIM_PROFILE } = await import('/src/games/ra2/profile.ts');
    const { createGuestMemory, createTestShim, callShim, readU32, writeU32 } = await import('/tests/helpers/guestMemory.ts');
    const memory = createGuestMemory();
    let reader, errors = [];
    const sink = new WebAudioPcmSink({ onStreamReader: (_id, value) => reader = value, onError: e => errors.push(String(e)) });
    const shim = createTestShim(memory, { audio: sink,
      files: new Map([['binkw32.dll', Uint8Array.from(${JSON.stringify([...dll])})]]),
      importArgBytes: () => 0, gameProfile: { ...RA2_SHIM_PROFILE, guestDllPatches: {} } });
    shim.initializeGuestDllBeforeEntry('BINKW32.DLL', 0x400000);
    const write = (address, value) => writeU32(memory, address, value);
    const read = address => readU32(memory, address);
    const call = (method, args) => {
      const result = callShim(shim, 'DSOUND.COM!' + method, args, 0x2000);
      if(result.eax !== 0) throw new Error(method + ' failed ' + result.eax);
    };
    write(0x2000, 0x501000); write(0x1000, 20); write(0x1004, 0x180e0); write(0x1008, 65536);
    call('IDirectSound.CreateSoundBuffer', [0, 0x1000, 0x1200, 0]);
    const id = read(0x1200);
    // Four explicit segments filled before Play, as in the native backend. Only synthetic silence.
    const refill = origin => {
      call('IDirectSoundBuffer.Lock', [id, origin, 16384, 0x1210, 0x1214, 0, 0, 0]);
      memory.write_memory(new Uint8Array(16384), read(0x1210));
      call('IDirectSoundBuffer.Unlock', [id, read(0x1210), read(0x1214), 0, 0]);
    };
    try {
      await sink.unlockForStart();
      for(let index = 0; index < 4; index++) refill(index * 16384);
      call('IDirectSoundBuffer.Play', [id, 0, 0, 1]);
      call('IDirectSoundBuffer.GetCurrentPosition', [id, 0x1220, 0]);
      const initialBudget = read(id + 12), readerBeforeRefill = !!reader;
      if(initialBudget !== 0 || readerBeforeRefill) throw new Error('Startup producer/reader qualification failed');
      let segment = Math.floor(read(0x1220) / 16384), sourceBytes = 65536;
      const origins = [], sources = [sourceBytes];
      const deadline = performance.now() + 10000;
      while(origins.length < 8) {
        if(performance.now() > deadline || errors.length) throw new Error(errors.join('; ') || 'Special-media source stalled');
        await new Promise(resolve => setTimeout(resolve, 10));
        call('IDirectSoundBuffer.GetCurrentPosition', [id, 0x1220, 0]);
        if(read(id + 12) !== 0) throw new Error('Producer cache revived');
        const next = Math.floor(read(0x1220) / 16384);
        if(next === segment) continue;
        if(next !== (segment + 1) % 4) throw new Error('Missed a refill segment');
        const origin = segment * 16384;
        refill(origin); origins.push(origin); sourceBytes += 16384; sources.push(sourceBytes); segment = next;
      }
      if(!reader || Atomics.load(new Int32Array(reader.control), 2) <= 0) throw new Error('First refill did not activate shared consumption');
      const traces = shim.getSoundStreamingTraces();
      const consumed = Atomics.load(new Int32Array(reader.control), 2);
      const result = { initialBudget, readerBeforeRefill, origins, sources, consumed, authoritative: sink.getConsumerCursor(id).authoritative,
        explicit: traces.find(t => t.id === id).lockFlags === 0 };
      call('IDirectSoundBuffer.Stop', [id]);
      call('IDirectSoundBuffer.Release', [id]);
      if(Atomics.load(new Int32Array(reader.control), 4) !== 0) throw new Error('Event close did not retire reader');
      return result;
    } finally { await sink.destroy(); }
  })()`);
  assert.equal(result.initialBudget, 0);
  assert.equal(result.readerBeforeRefill, false);
  assert.equal(result.authoritative, true);
  assert.equal(result.explicit, true);
  assert.equal(result.origins.length, 8);
  assert.equal(result.sources.at(-1), 196608);
  assert.ok(result.consumed > 0);
  console.log(result);
} finally {
  await browser.close();
}
