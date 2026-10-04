/** Original synthetic guest instructions: completion, simulation, input and DirectDraw submission. No decoder/assets. */
import { expect, it } from 'vitest';
import { RA2_SHIM_PROFILE } from '../../../src/games/ra2/profile';
import { buildPe32 } from '../../fixture/peBuilder';
import { callShim } from '../../helpers/guestMemory';
import { withGuestMachine, PROGRAM, call32, push32, le32, finish } from '../../helpers/guestMachine';
import type { Win32AudioSink } from '../../../src/vm86/win32';

const DATA = 0x310000;
const dll = buildPe32({
  imageBase: 0x500000,
  entryRva: 0,
  sections: [{ name: '.text', data: Uint8Array.of(0xc3), characteristics: 0x60000020 }],
  imports: [],
}).exe;

it('first and second media completion retire buffers and resume actual guest simulation, input and frame submission', async () => {
  const resources = new Set<number>();
  const submitted: number[] = [];
  let secondEvent = false;
  const audio: Win32AudioSink = {
    createBuffer: (id) => {
      resources.add(id);
    },
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
    // A late renderer packet at completion must not override the guest's Stop/SetCurrentPosition.
    getConsumerCursor: () => ({
      positionBytes: secondEvent ? 1024 : 0,
      outputSampleRateHz: 48000,
      transportLatencyMs: 0,
      ageMs: 0,
      authoritative: true,
    }),
    releaseBuffer: (id) => resources.delete(id),
  };
  await withGuestMachine(
    async (m) => {
      m.shim.initializeGuestDllBeforeEntry('BINKW32.DLL', PROGRAM);
      m.write(DATA, 20);
      m.write(DATA + 4, 0x180e0);
      m.write(DATA + 8, 4096);
      m.write(DATA + 32, 0x501000);
      const buffers = [0, 1].map((index) => {
        callShim(m.shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, DATA, DATA + 24, 0], DATA + 32);
        const id = m.read(DATA + 24);
        callShim(m.shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [id, 0, 0, 1]);
        expect(m.shim.getSoundStreamingTraces().find((t) => t.id === id)?.producerCursorUncached).toBe(true);
        return { id, simulation: DATA + 256 + index * 4 };
      });
      m.write(DATA + 64, 124);
      m.write(DATA + 68, 0x7);
      m.write(DATA + 72, 2);
      m.write(DATA + 76, 2);
      m.write(DATA + 168, 0x200); // DDSCAPS_PRIMARYSURFACE
      callShim(m.shim, 'DDRAW.COM!IDirectDraw.CreateSurface', [0, DATA + 64, DATA + 196, 0]);
      const surface = m.read(DATA + 196);
      m.shim.setKeyState(0x20, true);
      const api = (name: string, bytes: number, dll: string) => m.api(name, bytes, undefined, dll);
      const stop = api('IDirectSoundBuffer.Stop', 4, 'DSOUND.COM');
      const position = api('IDirectSoundBuffer.SetCurrentPosition', 8, 'DSOUND.COM');
      const current = api('IDirectSoundBuffer.GetCurrentPosition', 12, 'DSOUND.COM');
      const lock = api('IDirectSoundBuffer.Lock', 32, 'DSOUND.COM');
      const unlock = api('IDirectSoundBuffer.Unlock', 20, 'DSOUND.COM');
      const release = api('IDirectSoundBuffer.Release', 4, 'DSOUND.COM');
      const input = api('GetAsyncKeyState', 4, 'USER32.DLL');
      const flip = api('IDirectDrawSurface.Flip', 12, 'DDRAW.COM');
    const invoke = (target: number, args: number[]) => [...args.slice().reverse().flatMap(push32), ...call32(target)];
      const code: number[] = [];
      for (const { id, simulation } of buffers) {
        code.push(...invoke(stop, [id]), ...invoke(position, [id, 0]));
        const loop = code.length;
        code.push(...invoke(current, [id, DATA + 200, 0]), 0x83, 0x3d, ...le32(DATA + 200), 0);
        const branch = code.length;
        code.push(0x0f, 0x85, ...le32(loop - (branch + 6))); // wait for completion/reset truth
        code.push(...invoke(lock, [id, 0, 4096, DATA + 204, DATA + 208, 0, 0, 0]));
        code.push(
          ...push32(0),
          ...push32(0),
          0xff,
          0x35,
          ...le32(DATA + 208),
          0xff,
          0x35,
          ...le32(DATA + 204),
          ...push32(id),
          ...call32(unlock),
          ...invoke(release, [id]),
        );
        code.push(
          0xff,
          0x05,
          ...le32(simulation),
          ...invoke(input, [0x20]),
          0xa3,
          ...le32(simulation + 16),
          ...invoke(flip, [surface, 0, 0]),
        );
      }
      m.code(PROGRAM, [...code, ...finish]);
      try {
        await m.run(2500);
      } catch (error) {
        throw new Error(
          `Post-media guest did not progress: frames=${submitted.length}, hypercalls=${m.calls.length}, ` +
            `last=${m.calls.at(-1)?.imported.key}, cursor=${m.read(DATA + 200)}`,
          { cause: error },
        );
      }
      expect(resources.size).toBe(0);
      expect(m.shim.inspectSpecialMediaState().ownedSoundBuffers).toBe(0);
      expect(m.shim.getSoundStreamingTraces()).toHaveLength(0);
      for (const { simulation } of buffers) {
        expect(m.read(simulation)).toBe(1);
        expect(m.read(simulation + 16) & 0x8000).toBe(0x8000);
      }
      expect(submitted).toHaveLength(2);
      expect(m.calls.filter((c) => c.imported.name === 'IDirectSoundBuffer.GetCurrentPosition')).toHaveLength(2);
    },
    {
      audio,
      files: new Map([['binkw32.dll', dll]]),
      importArgBytes: () => 0,
      gameProfile: { ...RA2_SHIM_PROFILE, guestDllPatches: {} },
      onFrame: (frame) => {
        submitted.push(frame.width);
        secondEvent = true;
      },
      scheduleFrame: (emit) => emit(),
    },
  );
});
