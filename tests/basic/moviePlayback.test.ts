import { describe, expect, it } from 'vitest';
import {
  isSkippableBriefingMovie,
  updateMoviePlaybackState,
  type VmMoviePlaybackTracker,
} from '../../src/contracts/moviePlayback';

describe('RA2 touch long-press movie state', () => {
  it('requires active native Bink and campaign briefing guest state', () => {
    expect(isSkippableBriefingMovie(true, 'GUI:CampaignMenu')).toBe(true);
    expect(isSkippableBriefingMovie(true, 'GUI:MissionBriefing')).toBe(true);
    expect(isSkippableBriefingMovie(false, 'GUI:CampaignMenu')).toBe(false);
    expect(isSkippableBriefingMovie(true, 'Battlefield')).toBe(false);
    expect(isSkippableBriefingMovie(true, 'GUI:MainMenu')).toBe(false);
  });

  it('keeps the campaign guest state when Bink clears the window title, then clears it before later movies', () => {
    let tracker: VmMoviePlaybackTracker = {
      lastNonEmptyShellPageTitle: '',
      previousNativeBinkActive: false,
    };
    let update = updateMoviePlaybackState(tracker, false, false, 'GUI:CampaignMenu');
    tracker = update.tracker;
    expect(update.state.skippableBriefingActive).toBe(false);

    update = updateMoviePlaybackState(tracker, true, false, '');
    tracker = update.tracker;
    expect(update.state).toMatchObject({
      nativeBinkActive: true,
      skippableBriefingActive: true,
      shellPageTitle: 'GUI:CampaignMenu',
    });

    update = updateMoviePlaybackState(tracker, false, false, '');
    tracker = update.tracker;
    expect(tracker.lastNonEmptyShellPageTitle).toBe('');

    update = updateMoviePlaybackState(tracker, true, false, '');
    expect(update.state.skippableBriefingActive).toBe(false);
  });
});
