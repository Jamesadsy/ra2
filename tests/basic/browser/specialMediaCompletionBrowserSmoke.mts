/** Sequential real-renderer completion without owner assets or a proprietary decoder. */
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
    events: number;
    frames: number;
    input: number;
    liveBuffers: number;
  }>(`(async () => {
    const {WebAudioPcmSink} = await import('/src/adapter/audio.ts');
    const {RA2_SHIM_PROFILE} = await import('/src/games/ra2/profile.ts');
    const {createGuestMemory, createTestShim, callShim, readU32, writeU32} = await import('/tests/helpers/guestMemory.ts');
    const memory = createGuestMemory();
    let reader, frames = 0, events = 0; const errors = [];
    const sink = new WebAudioPcmSink({onStreamReader: (_id, value) => reader = value, onError: e => errors.push(String(e))});
    const shim = createTestShim(memory, {audio: sink, files: new Map([['binkw32.dll', Uint8Array.from(${JSON.stringify([...dll])})]]),
      importArgBytes: () => 0, gameProfile: {...RA2_SHIM_PROFILE, guestDllPatches: {}}, onFrame: () => frames++, scheduleFrame: emit => emit()});
    shim.initializeGuestDllBeforeEntry('BINKW32.DLL', 0x400000);
    const write = (a,v) => writeU32(memory,a,v), read = a => readU32(memory,a);
    const call = (method,args) => callShim(shim, 'DSOUND.COM!' + method,args,0x2000);
    const wait = async condition => {const end = performance.now()+5000; while(!condition()) {
      if(errors.length || performance.now()>end) throw new Error(errors.join('; ') || 'Media completion renderer stalled');
      await new Promise(r => setTimeout(r,10));
    }};
    try {
      await sink.unlockForStart();
      write(0x2000,0x501000); write(0x1000,20); write(0x1004,0x180e0); write(0x1008,65536);
      write(0x1400,124); write(0x1404,7); write(0x1408,2); write(0x140c,2); write(0x1468,0x200);
      callShim(shim,'DDRAW.COM!IDirectDraw.CreateSurface',[0,0x1400,0x1500,0]); const surface=read(0x1500);
      shim.setKeyState(0x20,true);
      for(let event=0; event<2; event++) {
        reader = null;
        call('IDirectSound.CreateSoundBuffer',[0,0x1000,0x1200,0]); const id=read(0x1200);
        const refill = origin => {
          call('IDirectSoundBuffer.Lock',[id,origin,16384,0x1210,0x1214,0,0,0]);
          memory.write_memory(new Uint8Array(16384),read(0x1210));
          call('IDirectSoundBuffer.Unlock',[id,read(0x1210),read(0x1214),0,0]);
        };
        for(let segment=0; segment<4; segment++) refill(segment*16384);
        call('IDirectSoundBuffer.Play',[id,0,0,1]); refill(0);
        await wait(() => reader && Atomics.load(new Int32Array(reader.control),2)>256);
        const retired = reader;
        call('IDirectSoundBuffer.Stop',[id]); call('IDirectSoundBuffer.SetCurrentPosition',[id,0]);
        call('IDirectSoundBuffer.GetCurrentPosition',[id,0x1220,0]);
        if(read(0x1220)!==0) throw new Error('Stopped media cursor overrode completion reset');
        refill(0);
        if(sink.getState(id).playing) throw new Error('Final refill resurrected playback');
        call('IDirectSoundBuffer.Release',[id]);
        if(Atomics.load(new Int32Array(retired.control),4)!==0) throw new Error('Closed media reader remained active');
        await new Promise(r => setTimeout(r,250));
        if(sink.getLifecycleSnapshot().workletCount!==0 || shim.inspectSpecialMediaState().ownedSoundBuffers!==0) throw new Error('Media resources accumulated');
        for(let frame=0; frame<16; frame++) {
          callShim(shim,'DDRAW.COM!IDirectDrawSurface.Flip',[surface,0,0]);
          await new Promise(requestAnimationFrame);
        }
        events++;
      }
      return {events,frames,input:callShim(shim,'USER32.DLL!GetAsyncKeyState',[0x20]).eax & 0x8000,
        liveBuffers:sink.getLifecycleSnapshot().buffers.length};
    } finally {await sink.destroy();}
  })()`);
  assert.deepEqual(result, { events: 2, frames: 32, input: 0x8000, liveBuffers: 0 });
  console.log(result);
} finally {
  await browser.close();
}
