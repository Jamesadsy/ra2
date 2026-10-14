export type MediaProvenanceDomain = 'bink' | 'directsound';
export type MediaProvenanceValue = string | number | boolean | null | readonly string[];

/** Metadata-only observation. Details must never contain media bytes, PCM, host paths, or raw guest pointers. */
export interface MediaProvenanceEvent {
  sequence: number;
  observedAt: string;
  monotonicMs: number;
  guestLogicFrame: number | null;
  guestCallOrdinal: number | null;
  domain: MediaProvenanceDomain;
  action: string;
  details: Readonly<Record<string, MediaProvenanceValue>>;
}

export interface MediaProvenanceSnapshot {
  events: MediaProvenanceEvent[];
  firstAvailableSequence: number | null;
  lastSequence: number;
  droppedThroughSequence: number;
}

/** Diagnostics may run only for an explicit loopback RA2 route; owner data stays in the local browser session. */
export function isLocalMediaProvenanceOptIn(
  gameId: string,
  location: Partial<Pick<Location, 'hostname' | 'search'>>,
): boolean {
  const hostname = (location.hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return (
    gameId === 'ra2' &&
    (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') &&
    new URLSearchParams(location.search ?? '').get('media-provenance') === '1'
  );
}

/** Bounded page-side collection for the opt-in local diagnostic stream. */
export class MediaProvenanceBuffer {
  private readonly events: MediaProvenanceEvent[] = [];
  private droppedThroughSequence = 0;

  constructor(private readonly capacity = 4096) {
    if (!Number.isInteger(capacity) || capacity < 1)
      throw new RangeError('Media provenance capacity must be positive.');
  }

  append(event: MediaProvenanceEvent): void {
    this.events.push(event);
    while (this.events.length > this.capacity) {
      const dropped = this.events.shift();
      if (dropped) this.droppedThroughSequence = Math.max(this.droppedThroughSequence, dropped.sequence);
    }
  }

  read(afterSequence = 0): MediaProvenanceSnapshot {
    return {
      events: this.events.filter((event) => event.sequence > afterSequence).map((event) => ({ ...event })),
      firstAvailableSequence: this.events[0]?.sequence ?? null,
      lastSequence: this.events.at(-1)?.sequence ?? this.droppedThroughSequence,
      droppedThroughSequence: this.droppedThroughSequence,
    };
  }

  clear(): void {
    this.events.length = 0;
    this.droppedThroughSequence = 0;
  }
}

/** Guest-controlled paths are reduced to one safe logical component before appearing in diagnostics. */
export function sanitizeGuestMediaName(value: string): string | null {
  const leaf = value.replace(/\\/g, '/').split('/').at(-1)?.trim() ?? '';
  if (!leaf || leaf === '.' || leaf === '..') return null;
  return leaf.replace(/[^A-Za-z0-9._ -]/g, '_').slice(0, 96) || null;
}
