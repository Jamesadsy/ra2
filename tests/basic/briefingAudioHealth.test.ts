import { describe, expect, it } from 'vitest';
import { assessBriefingAudioHealth } from '../real-game/browser/briefingAudioHealth';

describe('RA2 briefing audio health', () => {
  it('accepts observed cursor polling when video-audio time and a playing buffer advance', () => {
    const result = assessBriefingAudioHealth({
      elapsedMs: 8_462,
      contextState: 'running',
      contextTimeStartSeconds: 12.1,
      contextTimeEndSeconds: 20.3,
      advancingPlayingBuffers: 2,
      peakCursorPollsPer500Ms: 278,
    });

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.cursorPollsPerAudioSecond).toBeLessThan(600);
  });

  it('fails a zero-progress briefing even when cursor polling remains active', () => {
    const result = assessBriefingAudioHealth({
      elapsedMs: 8_000,
      contextState: 'running',
      contextTimeStartSeconds: 10,
      contextTimeEndSeconds: 10,
      advancingPlayingBuffers: 0,
      peakCursorPollsPer500Ms: 278,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain('audio-clock-not-advancing');
    expect(result.failures).toContain('no-playing-buffer-cursor-progress');
    expect(result.failures).toContain('runaway-position-polling');
  });

  it('fails runaway polling even when the audio clock and cursor still move', () => {
    const result = assessBriefingAudioHealth({
      elapsedMs: 8_000,
      contextState: 'running',
      contextTimeStartSeconds: 10,
      contextTimeEndSeconds: 18,
      advancingPlayingBuffers: 1,
      peakCursorPollsPer500Ms: 1_500,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(['runaway-position-polling']);
  });
});
