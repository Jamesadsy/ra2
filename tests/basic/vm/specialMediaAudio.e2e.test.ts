import { expect, it } from 'vitest';
import { RA2_SHIM_PROFILE } from '../../../src/games/ra2/profile';
import type { Win32AudioSink } from '../../../src/vm86/win32';
import { buildPe32 } from '../../fixture/peBuilder';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32 } from '../../helpers/guestMemory';
import { call32, finish, PROGRAM, push32, store32, withGuestMachine } from '../../helpers/guestMachine';

const DLL_BASE = 0x0050_0000;
const DATA = 0x0031_0000;

const silentSink = (): Win32AudioSink => ({
  createBuffer() {},
  duplicateBuffer: () => true,
  setFormat: () => true,
  writeBuffer: (_id, _offset, bytes) => bytes.length,
  play: () => true,
  stop: () => true,
  setCurrentPosition: () => true,
  setVolume: () => true,
  setPan: () => true,
  setFrequency: () => true,
  getState: () => null,
  releaseBuffer: () => true,
});

// Original machine code generated for this test, with no decoder or owner media.
const dll = buildPe32({
  imageBase: DLL_BASE,
  entryRva: 0,
  sections: [{ name: '.text', data: Uint8Array.of(0xc3), characteristics: 0x60000020 }],
  imports: [],
}).exe;
const dllHeaders = new DataView(dll.buffer, dll.byteOffset, dll.byteLength);
const DLL_SIZE = dllHeaders.getUint32(dllHeaders.getUint32(0x3c, true) + 80, true);

it.each([
  ['special-media', 'main'],
  ['ordinary', 'main'],
  ['special-media', 'worker'],
  ['ordinary', 'worker'],
] as const)(
  '%s producer in %s polls before its first playing overwrite use the intended cursor policy',
  async (kind, mode) => {
    let consumed = 0;
    const writes: number[] = [];
    const audio: Win32AudioSink = {
      createBuffer() {},
      duplicateBuffer: () => true,
      setFormat: () => true,
      writeBuffer(_id, offset, bytes) {
        writes.push(offset);
        return bytes.length;
      },
      play: () => true,
      stop: () => true,
      setCurrentPosition: () => true,
      setVolume: () => true,
      setPan: () => true,
      setFrequency: () => true,
      getState: () => (mode === 'main' ? { positionBytes: consumed, playing: true } : null),
      getConsumerCursor: () =>
        mode === 'worker'
          ? { positionBytes: consumed, outputSampleRateHz: 48000, transportLatencyMs: 0, ageMs: 0 }
          : null,
      releaseBuffer: () => true,
    };
    await withGuestMachine(
      async (m) => {
        m.shim.initializeGuestDllBeforeEntry('BINKW32.DLL', PROGRAM);
        m.write(DATA, 20);
        m.write(DATA + 4, 0x180e0); // Native Bink's secondary buffer flags.
        m.write(DATA + 8, 4096);
        m.write(DATA + 32, kind === 'special-media' ? DLL_BASE + 0x1000 : PROGRAM);
        callShim(m.shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, DATA, DATA + 24, 0], DATA + 32);
        const buffer = m.read(DATA + 24);
        callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [buffer, 0, 0, 1]);
        callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [buffer, DATA + 48, 0]);
        const initialBudget = m.read(buffer + 12);
        const position = m.read(m.read(buffer) + 16);
        const checkpoint = m.api('GetTickCount', 0);
        const observed: number[] = [];
        m.afterCall = (call) => {
          if (call.imported.name !== 'GetTickCount') return;
          observed.push(m.read(DATA + 48));
          consumed = (consumed + 1024) % 4096;
        };
        const poll = [
          ...push32(0),
          ...push32(DATA + 48),
          ...push32(buffer),
          ...call32(position),
          ...call32(checkpoint),
        ];
        m.code(PROGRAM, [...Array.from({ length: 9 }, () => poll).flat(), ...finish]);
        await m.run();
        expect(observed).toEqual(
          kind === 'special-media' ? [0, 1024, 2048, 3072, 0, 1024, 2048, 3072, 0] : new Array(9).fill(0),
        );
        expect(initialBudget).toBe(kind === 'special-media' ? 0 : 1023);
        // Segment transitions are the native producer's permission to consume new decoded source bytes.
        // Service of an unchanged segment must not reuse source zero; explicit Lock/Unlock advances through wrap.
        let source = 4096;
        let segment = observed[0]!;
        for (const cursor of observed.slice(1)) {
          if (cursor === segment) continue;
          callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Lock', [
            buffer,
            segment,
            1024,
            DATA + 64,
            DATA + 68,
            0,
            0,
            0,
          ]);
          m.code(m.read(DATA + 64), new Uint8Array(1024).fill(source / 1024));
          callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Unlock', [
            buffer,
            m.read(DATA + 64),
            m.read(DATA + 68),
            0,
            0,
          ]);
          source += 1024;
          segment = cursor;
        }
        expect(writes).toEqual(kind === 'special-media' ? [0, 1024, 2048, 3072, 0, 1024, 2048, 3072] : []);
        expect(source).toBe(kind === 'special-media' ? 12288 : 4096);
      },
      {
        audio,
        files: new Map([['binkw32.dll', dll]]),
        importArgBytes: () => 0,
        gameProfile: { ...RA2_SHIM_PROFILE, guestDllPatches: {} },
      },
    );
  },
);

it('a special-media cursor remains frozen without consumer progress and explicit offsets remain explicit', async () => {
  await withGuestMachine(
    async (m) => {
      m.shim.initializeGuestDllBeforeEntry('BINKW32.DLL', PROGRAM);
      m.write(DATA, 20);
      m.write(DATA + 8, 4096);
      m.write(DATA + 32, DLL_BASE + 0x1000);
      callShim(m.shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, DATA, DATA + 24, 0], DATA + 32);
      const buffer = m.read(DATA + 24);
      callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [buffer, 0, 0, 1]);
      callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [buffer, DATA + 48, 0]);
      expect(m.read(buffer + 12)).toBe(0);
      callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Lock', [
        buffer,
        4000,
        192,
        DATA + 64,
        DATA + 68,
        DATA + 72,
        DATA + 76,
        0,
      ]);
      expect([m.read(DATA + 68), m.read(DATA + 76)]).toEqual([96, 96]);
      const position = m.read(m.read(buffer) + 16);
      m.code(PROGRAM, [
        ...push32(0),
        ...push32(DATA + 48),
        ...push32(buffer),
        ...call32(position),
        ...store32(DATA + 80, 1),
        ...finish,
      ]);
      await m.run();
      expect(m.read(DATA + 48)).toBe(0);
    },
    {
      files: new Map([['binkw32.dll', dll]]),
      importArgBytes: () => 0,
      gameProfile: { ...RA2_SHIM_PROFILE, guestDllPatches: {} },
      audio: {
        ...silentSink(),
        getConsumerCursor: () => ({ positionBytes: 0, outputSampleRateHz: 48000, transportLatencyMs: 0, ageMs: 0 }),
      },
    },
  );
});

it('producer classification is bounded to a loaded configured secondary caller and follows duplicates', () => {
  const memory = createGuestMemory();
  const shim = createTestShim(memory, {
    audio: silentSink(),
    files: new Map([['binkw32.dll', dll]]),
    importArgBytes: () => 0,
    gameProfile: { ...RA2_SHIM_PROFILE, guestDllPatches: {} },
  });
  writeU32(memory, DATA, 20);
  writeU32(memory, DATA + 8, 4096);
  const create = (caller: number, primary = false, stack = DATA + 32) => {
    writeU32(memory, DATA + 4, primary ? 1 : 0x180e0);
    writeU32(memory, DATA + 32, caller);
    expect(callShim(shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, DATA, DATA + 24, 0], stack).eax).toBe(0);
    return readU32(memory, DATA + 24);
  };
  const policy = (id: number) =>
    shim.getSoundStreamingTraces().find((trace) => trace.id === id)!.producerCursorUncached;
  expect(policy(create(DLL_BASE + 0x1000))).toBe(false); // Probe does not load the DLL.
  shim.initializeGuestDllBeforeEntry('BINKW32.DLL', PROGRAM);
  expect(policy(create(DLL_BASE - 1))).toBe(false);
  expect(policy(create(DLL_BASE + DLL_SIZE))).toBe(false); // Exclusive image end.
  expect(policy(create(DLL_BASE + 0x1000, true))).toBe(false);
  expect(policy(create(DLL_BASE + 0x1000, false, 0))).toBe(false);
  const source = create(DLL_BASE + 0x1000);
  expect(policy(source)).toBe(true);
  expect(callShim(shim, 'DSOUND.COM!IDirectSound.DuplicateSoundBuffer', [0, source, DATA + 28]).eax).toBe(0);
  const duplicate = readU32(memory, DATA + 28);
  expect(policy(duplicate)).toBe(true);
  for (const id of [source, duplicate]) {
    callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [id, 0, 0, 1]);
    callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Stop', [id]);
    callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.SetCurrentPosition', [id, 1024]);
    callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [id, 0, 0, 1]);
    callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [id, DATA + 48, 0]);
    expect(readU32(memory, id + 12)).toBe(0);
    expect(policy(id)).toBe(true);
    callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Release', [id]);
    expect(shim.getSoundStreamingTraces().some((trace) => trace.id === id)).toBe(false);
  }
});
