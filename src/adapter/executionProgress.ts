/** Bounded, passive guest frame and hypercall observations for post-cameo diagnostics. */
export const MAX_RECENT_HYPERCALL_IDENTITIES = 64;
export const MAX_TOP_HYPERCALL_IDENTITIES = 6;
export const MAX_HYPERCALL_IDENTITY_LENGTH = 64;
export const MAX_EXECUTION_PROGRESS_COUNTER = 0xffff_ffff;

export interface ExecutionProgressSnapshot {
  guestFrameSequence: number;
  guestFrameAgeMs: number | null;
  hypercallsSinceLastFrame: number;
  lastHypercallIdentity: string | null;
  topHypercalls: string;
  lastGuestReturnAddress: number | null;
}

/**
 * Keep only a fixed recent-call window and saturated scalar counters. Sampling
 * has no callbacks and never feeds execution or scheduling decisions.
 */
export class ExecutionProgressTracker {
  private guestFrameSequence = 0;
  private lastGuestFrameAtMs: number | null = null;
  private hypercallsSinceLastFrame = 0;
  private lastHypercallIdentity: string | null = null;
  private lastGuestReturnAddress: number | null = null;
  private readonly recentHypercallIdentities: string[] = new Array(MAX_RECENT_HYPERCALL_IDENTITIES);
  private recentHypercallCount = 0;
  private nextHypercallIndex = 0;

  recordHypercall(identity: string, guestReturnAddress: number): void {
    const safeIdentity = identity.slice(0, MAX_HYPERCALL_IDENTITY_LENGTH);
    this.hypercallsSinceLastFrame = Math.min(MAX_EXECUTION_PROGRESS_COUNTER, this.hypercallsSinceLastFrame + 1);
    this.lastHypercallIdentity = safeIdentity;
    this.lastGuestReturnAddress =
      Number.isInteger(guestReturnAddress) && guestReturnAddress >= 0 && guestReturnAddress <= 0xffff_ffff
        ? guestReturnAddress
        : null;
    this.recentHypercallIdentities[this.nextHypercallIndex] = safeIdentity;
    this.nextHypercallIndex = (this.nextHypercallIndex + 1) % MAX_RECENT_HYPERCALL_IDENTITIES;
    this.recentHypercallCount = Math.min(MAX_RECENT_HYPERCALL_IDENTITIES, this.recentHypercallCount + 1);
  }

  recordGuestFrameSubmitted(atMs: number): void {
    this.guestFrameSequence = Math.min(MAX_EXECUTION_PROGRESS_COUNTER, this.guestFrameSequence + 1);
    this.lastGuestFrameAtMs = Number.isFinite(atMs) ? Math.max(0, atMs) : null;
    this.hypercallsSinceLastFrame = 0;
  }

  snapshot(nowMs: number): ExecutionProgressSnapshot {
    const counts = new Map<string, number>();
    for (let offset = 0; offset < this.recentHypercallCount; offset++) {
      const oldestIndex =
        (this.nextHypercallIndex - this.recentHypercallCount + MAX_RECENT_HYPERCALL_IDENTITIES) %
        MAX_RECENT_HYPERCALL_IDENTITIES;
      const identity = this.recentHypercallIdentities[(oldestIndex + offset) % MAX_RECENT_HYPERCALL_IDENTITIES];
      if (identity !== undefined)
        counts.set(identity, Math.min(MAX_EXECUTION_PROGRESS_COUNTER, (counts.get(identity) ?? 0) + 1));
    }
    const topHypercalls = [...counts.entries()]
      .sort(
        ([leftIdentity, leftCount], [rightIdentity, rightCount]) =>
          rightCount - leftCount || (leftIdentity < rightIdentity ? -1 : leftIdentity > rightIdentity ? 1 : 0),
      )
      .slice(0, MAX_TOP_HYPERCALL_IDENTITIES)
      .map(([identity, count]) => `${identity}:${count}`)
      .join(';');
    const guestFrameAgeMs =
      this.lastGuestFrameAtMs === null || !Number.isFinite(nowMs)
        ? null
        : Math.min(MAX_EXECUTION_PROGRESS_COUNTER, Math.max(0, nowMs - this.lastGuestFrameAtMs));

    return {
      guestFrameSequence: this.guestFrameSequence,
      guestFrameAgeMs,
      hypercallsSinceLastFrame: this.hypercallsSinceLastFrame,
      lastHypercallIdentity: this.lastHypercallIdentity,
      topHypercalls,
      lastGuestReturnAddress: this.lastGuestReturnAddress,
    };
  }

  reset(): void {
    this.guestFrameSequence = 0;
    this.lastGuestFrameAtMs = null;
    this.hypercallsSinceLastFrame = 0;
    this.lastHypercallIdentity = null;
    this.lastGuestReturnAddress = null;
    this.recentHypercallIdentities.fill('');
    this.recentHypercallCount = 0;
    this.nextHypercallIndex = 0;
  }
}
