import { describe, expect, it } from 'vitest';
import { callShim, createGuestMemory, createTestShim, readU32, writeU32, writeAsciiZ } from '../helpers/guestMemory';
import type { MediaProvenanceEvent } from '../../src/contracts/mediaProvenance';
import { RA2_SHIM_PROFILE } from '../../src/games/ra2/profile';
import { buildBinkExportFixture } from '../fixture/binkExportFixture';

const waveFormat = Uint8Array.from([
  0xff, 0xff, 0x01, 0x00, 0x02, 0x00, 0x22, 0x56, 0x00, 0x00, 0x88, 0x58, 0x01, 0x00, 0x04, 0x00, 0x10, 0x00, 0x00,
  0x00,
]);

describe('read-only media provenance instrumentation', () => {
  it('records native DirectSound lifecycle and cursor metadata without classifying the audio as speech', () => {
    const memory = createGuestMemory();
    const events: MediaProvenanceEvent[] = [];
    let guestCallOrdinal = 0;
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      moduleName: 'game.exe',
      mainModuleBase: 0x0040_0000,
      mainModuleSize: 0x0002_0000,
      mediaProvenance: true,
      guestCallOrdinal: () => guestCallOrdinal,
      onMediaProvenance: (event) => events.push(event),
    });
    writeU32(memory, 0x2000, 0x0040_1234);
    memory.write_memory(waveFormat.subarray(2), 0x1100);
    writeU32(memory, 0x1000, 20);
    writeU32(memory, 0x1008, 1024);
    writeU32(memory, 0x1010, 0x1100);
    expect(callShim(shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, 0x1000, 0x1200, 0], 0x2000).eax).toBe(0);
    const firstBuffer = readU32(memory, 0x1200);
    expect(callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Play', [firstBuffer, 0, 0, 1], 0x2000).eax).toBe(0);
    guestCallOrdinal = 255;
    expect(callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [firstBuffer, 0x1220, 0x1224]).eax).toBe(
      0,
    );
    expect(events.some((event) => event.action === 'cursor-sample')).toBe(false);
    guestCallOrdinal = 256;
    expect(callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', [firstBuffer, 0x1220, 0x1224]).eax).toBe(
      0,
    );
    expect(callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Stop', [firstBuffer], 0x2000).eax).toBe(0);
    expect(callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Release', [firstBuffer]).eax).toBe(0);

    expect(events.map((event) => event.action)).toEqual(['create', 'play', 'cursor-sample', 'stop', 'destroy']);
    expect(events[0]?.details).toMatchObject({
      producerClass: 'main-executable',
      rootCreatorModule: 'GAME.EXE',
      contentClass: 'unknown',
      transmissionOwned: null,
      sampleRateHz: 22_050,
      channels: 2,
      byteLength: 1024,
    });
    expect(events[1]?.details).toMatchObject({ loopFlag: true, playing: true, looping: true });
    expect(events[2]?.details).toMatchObject({ sampledVia: 'existing-guest-GetCurrentPosition-call' });
    expect(events[3]?.details).toMatchObject({ previousPlaying: true, playing: false, looping: true });
    expect(events[4]?.details).toMatchObject({ lifetimeMs: expect.any(Number), referenceCountBeforeRelease: 1 });
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain('PCM');
    expect(serialized).not.toContain('0x');
    expect(serialized).not.toContain('C:\\');
    expect(serialized).not.toMatch(/"(?:guestPointer|rawHandle|pcm|mediaPath)"/i);
  });

  it('links duplicate lifetime metadata to its source buffer without promoting ownership', () => {
    const memory = createGuestMemory();
    const events: MediaProvenanceEvent[] = [];
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      moduleName: 'game.exe',
      mainModuleBase: 0x0040_0000,
      mainModuleSize: 0x0002_0000,
      mediaProvenance: true,
      onMediaProvenance: (event) => events.push(event),
    });
    writeU32(memory, 0x2000, 0x0040_1234);
    memory.write_memory(waveFormat.subarray(2), 0x1100);
    writeU32(memory, 0x1000, 20);
    writeU32(memory, 0x1008, 1024);
    writeU32(memory, 0x1010, 0x1100);
    expect(callShim(shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, 0x1000, 0x1200, 0], 0x2000).eax).toBe(0);
    const source = readU32(memory, 0x1200);
    expect(callShim(shim, 'DSOUND.COM!IDirectSound.DuplicateSoundBuffer', [0, source, 0x1210], 0x2000).eax).toBe(0);
    const duplicate = readU32(memory, 0x1210);
    const duplicateEvent = events.find((event) => event.action === 'duplicate');
    expect(duplicateEvent?.details).toMatchObject({
      sourceBufferId: events[0]?.details.bufferId,
      rootBufferId: events[0]?.details.rootBufferId,
      transmissionOwned: null,
      contentClass: 'unknown',
    });
    expect(callShim(shim, 'DSOUND.COM!IDirectSoundBuffer.Release', [duplicate]).eax).toBe(0);
  });

  it('identifies BINKW32 as a buffer creator while keeping the audio content and transmission relation unknown', () => {
    const memory = createGuestMemory();
    const events: MediaProvenanceEvent[] = [];
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      files: new Map([['binkw32.dll', buildBinkExportFixture()]]),
      importArgBytes: () => 0,
      gameProfile: { ...RA2_SHIM_PROFILE, guestDllPatches: {} },
      mediaProvenance: true,
      onMediaProvenance: (event) => events.push(event),
    });
    shim.initializeGuestDllBeforeEntry('BINKW32.DLL', 0x0040_0000);
    writeU32(memory, 0x2000, 0x0050_10b0);
    memory.write_memory(waveFormat.subarray(2), 0x1100);
    writeU32(memory, 0x1000, 20);
    writeU32(memory, 0x1008, 1024);
    writeU32(memory, 0x1010, 0x1100);
    expect(callShim(shim, 'DSOUND.COM!IDirectSound.CreateSoundBuffer', [0, 0x1000, 0x1200, 0], 0x2000).eax).toBe(0);

    expect(events[0]?.details).toMatchObject({
      producerClass: 'bink-codec',
      rootCreatorModule: 'BINKW32.DLL',
      rootCreatorRva: 0x10b0,
      contentClass: 'unknown',
      transmissionOwned: null,
      producerEvidence: 'creator return address is inside BINKW32.DLL',
    });
    expect(JSON.stringify(events)).not.toMatch(/speech|voice|music|ambient/i);
  });

  it('records synthetic Bink source names and explicit synthetic completion without claiming a native EOF', () => {
    const memory = createGuestMemory();
    const events: MediaProvenanceEvent[] = [];
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      mediaProvenance: true,
      onMediaProvenance: (event) => events.push(event),
    });
    writeAsciiZ(memory, 0x3000, 'C:\\PRIVATE\\MOVIES.MIX');
    const handle = callShim(shim, 'BINKW32.DLL!_BinkOpen@8', [0x3000, 0]).eax;
    expect(handle).toBeTruthy();
    expect(callShim(shim, 'BINKW32.DLL!_BinkNextFrame@4', [handle]).eax).toBe(0);
    expect(callShim(shim, 'BINKW32.DLL!_BinkClose@4', [handle]).eax).toBe(0);

    expect(events.map((event) => event.action)).toEqual(['open-call', 'synthetic-frame-advance', 'close-call']);
    expect(events[0]?.details).toMatchObject({
      mode: 'synthetic',
      logicalMediaName: 'MOVIES.MIX',
      openResultObserved: true,
      frameNumber: 1,
      totalFrames: 1,
    });
    expect(events[2]?.details).toMatchObject({
      mode: 'synthetic',
      closeReason: 'synthetic-shim-close-observed',
      naturalEndState: 'synthetic-complete',
    });
    expect(JSON.stringify(events)).not.toContain('C:\\PRIVATE');
  });
});
