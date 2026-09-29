export interface VmMoviePlaybackState {
  nativeBinkActive: boolean;
  syntheticBinkActive: boolean;
  skippableBriefingActive: boolean;
  shellPageTitle: string;
}

export interface VmMoviePlaybackTracker {
  lastNonEmptyShellPageTitle: string;
  previousNativeBinkActive: boolean;
}

export interface VmMoviePlaybackUpdate {
  state: VmMoviePlaybackState;
  tracker: VmMoviePlaybackTracker;
}

/** A live native Bink stream on the campaign briefing surface is the only Esc-skippable touch-long-press state. */
export function isSkippableBriefingMovie(nativeBinkActive: boolean, shellPageTitle: string): boolean {
  return nativeBinkActive && /campaign|briefing/i.test(shellPageTitle);
}

/** Preserve the last campaign title while its Bink briefing clears the guest window caption. */
export function updateMoviePlaybackState(
  tracker: VmMoviePlaybackTracker,
  nativeBinkActive: boolean,
  syntheticBinkActive: boolean,
  currentShellPageTitle: string,
): VmMoviePlaybackUpdate {
  const currentTitle = currentShellPageTitle.trim();
  const shellPageTitle = currentTitle || tracker.lastNonEmptyShellPageTitle;
  const state: VmMoviePlaybackState = {
    nativeBinkActive,
    syntheticBinkActive,
    skippableBriefingActive: isSkippableBriefingMovie(nativeBinkActive, shellPageTitle),
    shellPageTitle,
  };
  const endedNativeMovie = !nativeBinkActive && !syntheticBinkActive && tracker.previousNativeBinkActive;
  return {
    state,
    tracker: {
      lastNonEmptyShellPageTitle: endedNativeMovie ? '' : currentTitle || tracker.lastNonEmptyShellPageTitle,
      previousNativeBinkActive: nativeBinkActive,
    },
  };
}
