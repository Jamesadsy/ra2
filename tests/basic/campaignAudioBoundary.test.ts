import { describe, expect, it } from 'vitest';
import {
  assessCampaignAudioBoundary,
  type CampaignAudioBoundaryInput,
} from '../real-game/browser/campaignAudioBoundary';

const base: CampaignAudioBoundaryInput = {
  binkClosed: true,
  binkCompletion: 'natural',
  activeNativeBinkSessions: 0,
  audioBuffers: [],
  mediaQuietMs: 6_000,
  canvasFrame: 1,
};

describe('campaign audio-safe boundary evidence', () => {
  it('requires every DirectSound buffer to have a known transmission relationship', () => {
    const result = assessCampaignAudioBoundary({
      ...base,
      audioBuffers: [{ playing: true, looping: true, transmissionOwned: null }],
    });

    expect(result.safe).toBe(false);
    expect(result.blockers).toContain('audio-buffer-ownership-unresolved:1');
    expect(result.blockers).toContain('unattributed-playing-loops:1');
  });

  it('keeps active one-shot audio from being mistaken for a completed transmission', () => {
    const result = assessCampaignAudioBoundary({
      ...base,
      audioBuffers: [{ playing: true, looping: false, transmissionOwned: null }],
    });

    expect(result.safe).toBe(false);
    expect(result.blockers).toContain('unattributed-playing-audio:1');
  });

  it('requires natural Bink completion and a resolved count of overlapping sessions', () => {
    const cancelled = assessCampaignAudioBoundary({ ...base, binkCompletion: 'cancelled' });
    const unknown = assessCampaignAudioBoundary({ ...base, binkCompletion: 'unknown' });
    const nested = assessCampaignAudioBoundary({ ...base, activeNativeBinkSessions: 1 });
    const unresolved = assessCampaignAudioBoundary({ ...base, activeNativeBinkSessions: null });

    expect(cancelled.safe).toBe(false);
    expect(cancelled.blockers).toContain('native-bink-natural-completion-unproven');
    expect(unknown.safe).toBe(false);
    expect(nested.blockers).toContain('native-bink-session-still-active');
    expect(unresolved.blockers).toContain('native-bink-session-count-unresolved');
  });

  it('allows known unrelated looping audio after natural completion and a quiet window', () => {
    const result = assessCampaignAudioBoundary({
      ...base,
      audioBuffers: [{ playing: true, looping: true, transmissionOwned: false }],
    });

    expect(result).toEqual({ safe: true, blockers: [] });
  });

  it('blocks unavailable, incomplete, and non-battlefield samples', () => {
    const noAudio = assessCampaignAudioBoundary({ ...base, audioBuffers: null });
    const tooSoon = assessCampaignAudioBoundary({ ...base, mediaQuietMs: 5_999 });
    const noFrame = assessCampaignAudioBoundary({ ...base, canvasFrame: null });

    expect(noAudio.blockers).toContain('audio-progress-unavailable');
    expect(tooSoon.blockers).toContain('post-media-quiet-window-incomplete');
    expect(noFrame.blockers).toContain('battlefield-frame-not-observed');
  });
});
