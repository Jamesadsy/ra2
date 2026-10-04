/** Bounded observations only: never changes guest execution, media duration, or recovery policy. */
export class ExecutionProgress {
  private frameCount = 0;
  private lastFrameAtMs: number | null = null;
  private callsSinceFrame = 0;
  private mediaCompletionGeneration = 0;
  private readonly calls = new Map<string, number>();

  frame(atMs: number): void {
    this.frameCount++;
    this.lastFrameAtMs = atMs;
    this.callsSinceFrame = 0;
    this.calls.clear();
  }

  call(key: string): void {
    this.callsSinceFrame++;
    if (key.endsWith('!_BinkClose@4')) this.mediaCompletionGeneration++;
    const boundedKey = this.calls.has(key) || this.calls.size < 32 ? key : '(other)';
    this.calls.set(boundedKey, (this.calls.get(boundedKey) ?? 0) + 1);
  }

  sample(atMs: number, running: boolean) {
    const ageMs = this.lastFrameAtMs === null ? null : Math.max(0, atMs - this.lastFrameAtMs);
    return {
      submittedGuestFrames: this.frameCount,
      lastGuestFrameAtMs: this.lastFrameAtMs,
      noFrameProgressMs: ageMs,
      callsSinceFrame: this.callsSinceFrame,
      mediaCompletionGeneration: this.mediaCompletionGeneration,
      // Diagnostic classification, not a playback timeout or forced restart.
      activeWithoutFrameProgress: running && ageMs !== null && ageMs >= 2_000 && this.callsSinceFrame >= 512,
      topCallsSinceFrame: [...this.calls]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([key, count]) => ({ key, count })),
    };
  }
}
