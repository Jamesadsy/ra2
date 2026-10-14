import { describe, expect, it } from 'vitest';
import type { MediaProvenanceEvent } from '../../src/contracts/mediaProvenance';
import { RA2_SHIM_PROFILE } from '../../src/games/ra2/profile';
import { buildBinkExportFixture } from '../fixture/binkExportFixture';
import { callShim, createGuestMemory, createTestShim, writeAsciiZ } from '../helpers/guestMemory';

describe('native Bink call provenance', () => {
  it('records source identity and close-handle token while keeping native return, frame, and EOF semantics unknown', () => {
    const memory = createGuestMemory();
    const events: MediaProvenanceEvent[] = [];
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      files: new Map([['binkw32.dll', buildBinkExportFixture()]]),
      importArgBytes: () => 0,
      gameProfile: { ...RA2_SHIM_PROFILE, skipIncompleteBinkPlayback: false, guestDllPatches: {} },
      mediaProvenance: true,
      onMediaProvenance: (event) => events.push(event),
    });
    const loadedDll = (
      shim as unknown as {
        loadGuestDll: (name: string) => { exports: Map<string, number> } | null;
      }
    ).loadGuestDll('BINKW32.DLL');
    expect(loadedDll?.exports.has('_BinkClose@4')).toBe(true);
    expect(loadedDll?.exports.has('_BinkOpen@8')).toBe(true);
    writeAsciiZ(memory, 0x3000, 'C:\\PRIVATE\\CAMPAIGN.MIX');
    callShim(shim, 'BINKW32.DLL!_BinkOpen@8', [0x3000, 0]);
    callShim(shim, 'BINKW32.DLL!_BinkClose@4', [0x0012_3456]);

    expect(events.map((event) => event.action)).toEqual(['open-call', 'close-call']);
    expect(events[0]?.details).toMatchObject({
      mode: 'native',
      openCallId: 'bink-native-call-0001',
      logicalMediaName: 'CAMPAIGN.MIX',
      sourceKind: 'guest-name',
      openResultObserved: false,
      actualSessionHandle: null,
      actualSessionCount: null,
      frameNumber: null,
      totalFrames: null,
      naturalEndState: 'unknown',
    });
    expect(events[1]?.details).toMatchObject({
      mode: 'native',
      openCallCandidate: 'bink-native-call-0001',
      correlation: 'single-outstanding-open-call-candidate-only',
      closeReason: 'unknown',
      actualSessionCountAfter: null,
      naturalEndState: 'unknown',
    });
    expect(events[1]?.details.handleToken).toMatch(/^bink-handle-\d{4}$/);
    expect(JSON.stringify(events)).not.toContain('C:\\PRIVATE');
    expect(JSON.stringify(events)).not.toContain('00123456');
  });

  it('marks overlapping native open-call candidates ambiguous instead of matching a close to a session', () => {
    const memory = createGuestMemory();
    const events: MediaProvenanceEvent[] = [];
    const shim = createTestShim(memory, {
      gameId: 'ra2',
      files: new Map([['binkw32.dll', buildBinkExportFixture()]]),
      importArgBytes: () => 0,
      gameProfile: {
        ...RA2_SHIM_PROFILE,
        skipIncompleteBinkPlayback: false,
        nativeBinkPlaybackLimit: 2,
        guestDllPatches: {},
      },
      mediaProvenance: true,
      onMediaProvenance: (event) => events.push(event),
    });
    writeAsciiZ(memory, 0x3000, 'C:\\PRIVATE\\ONE.MIX');
    writeAsciiZ(memory, 0x3100, 'C:\\PRIVATE\\TWO.MIX');
    callShim(shim, 'BINKW32.DLL!_BinkOpen@8', [0x3000, 0]);
    callShim(shim, 'BINKW32.DLL!_BinkOpen@8', [0x3100, 0]);
    callShim(shim, 'BINKW32.DLL!_BinkClose@4', [0x0012_3456]);

    expect(events.at(-1)?.details).toMatchObject({
      correlation: 'ambiguous-open-candidates',
      candidateOpenCallIds: ['bink-native-call-0001', 'bink-native-call-0002'],
      nativeOpenCandidateCountBefore: 2,
      overlapObserved: true,
      closeReason: 'unknown',
      naturalEndState: 'unknown',
    });
  });
});
