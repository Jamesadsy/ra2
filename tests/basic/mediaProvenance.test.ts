import { describe, expect, it } from 'vitest';
import {
  isLocalMediaProvenanceOptIn,
  MediaProvenanceBuffer,
  sanitizeGuestMediaName,
  type MediaProvenanceEvent,
} from '../../src/contracts/mediaProvenance';

const event = (sequence: number): MediaProvenanceEvent => ({
  sequence,
  observedAt: '2026-10-14T00:00:00.000Z',
  monotonicMs: sequence,
  guestLogicFrame: 10,
  guestCallOrdinal: 20,
  domain: 'bink',
  action: 'open-call',
  details: { openCallId: `bink-native-call-${sequence}` },
});

describe('metadata-only media provenance contracts', () => {
  it('enables collection only for explicitly opted-in loopback RA2 routes', () => {
    expect(isLocalMediaProvenanceOptIn('ra2', { hostname: '127.0.0.1', search: '?media-provenance=1' })).toBe(true);
    expect(isLocalMediaProvenanceOptIn('ra2', { hostname: 'localhost', search: '?media-provenance=1' })).toBe(true);
    expect(isLocalMediaProvenanceOptIn('yr', { hostname: '127.0.0.1', search: '?media-provenance=1' })).toBe(false);
    expect(isLocalMediaProvenanceOptIn('ra2', { hostname: 'example.com', search: '?media-provenance=1' })).toBe(false);
    expect(isLocalMediaProvenanceOptIn('ra2', { hostname: '127.0.0.1', search: '' })).toBe(false);
    expect(isLocalMediaProvenanceOptIn('ra2', {})).toBe(false);
  });

  it('sanitizes source names to one bounded logical component', () => {
    expect(sanitizeGuestMediaName('C:\\PRIVATE\\MOVIES.MIX')).toBe('MOVIES.MIX');
    expect(sanitizeGuestMediaName('..')).toBeNull();
    expect(sanitizeGuestMediaName('C:\\PRIVATE\\' + 'A'.repeat(300))).toHaveLength(96);
  });

  it('bounds event retention and reports the dropped sequence boundary', () => {
    const buffer = new MediaProvenanceBuffer(2);
    buffer.append(event(1));
    buffer.append(event(2));
    buffer.append(event(3));

    expect(buffer.read()).toMatchObject({
      events: [event(2), event(3)],
      firstAvailableSequence: 2,
      lastSequence: 3,
      droppedThroughSequence: 1,
    });
    expect(buffer.read(2).events).toEqual([event(3)]);
    buffer.clear();
    expect(buffer.read()).toMatchObject({ events: [], firstAvailableSequence: null, lastSequence: 0 });
  });
});
