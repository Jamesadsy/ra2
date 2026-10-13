export interface CampaignAudioBufferEvidence {
  playing: boolean;
  looping: boolean;
  /** True only when the buffer is positively attributed to this transmission; false means another known source. */
  transmissionOwned: boolean | null;
}

export interface CampaignAudioBoundaryInput {
  binkClosed: boolean;
  /** BinkClose alone cannot distinguish a natural end from cancellation or skip. */
  binkCompletion: 'natural' | 'cancelled' | 'unknown';
  /** Null means the available state cannot rule out overlapping native Bink sessions. */
  activeNativeBinkSessions: number | null;
  /** Null means no bounded audio snapshot was available for this sample. */
  audioBuffers: readonly CampaignAudioBufferEvidence[] | null;
  mediaQuietMs: number;
  canvasFrame: number | null;
}

export interface CampaignAudioBoundaryAssessment {
  safe: boolean;
  blockers: string[];
}

/** Require positive completion, session, and audio ownership evidence before naming a restoration boundary. */
export function assessCampaignAudioBoundary(input: CampaignAudioBoundaryInput): CampaignAudioBoundaryAssessment {
  const blockers: string[] = [];

  if (!input.binkClosed) blockers.push('bink-close-not-observed');
  if (input.binkCompletion !== 'natural') blockers.push('native-bink-natural-completion-unproven');
  if (input.activeNativeBinkSessions === null) blockers.push('native-bink-session-count-unresolved');
  else if (input.activeNativeBinkSessions > 0) blockers.push('native-bink-session-still-active');

  if (input.audioBuffers === null) {
    blockers.push('audio-progress-unavailable');
  } else {
    const unclassified = input.audioBuffers.filter((buffer) => buffer.transmissionOwned === null);
    if (unclassified.length) blockers.push(`audio-buffer-ownership-unresolved:${unclassified.length}`);

    const unclassifiedPlaying = unclassified.filter((buffer) => buffer.playing);
    if (unclassifiedPlaying.length) {
      blockers.push(`unattributed-playing-audio:${unclassifiedPlaying.length}`);
    }

    const unclassifiedLoops = unclassifiedPlaying.filter((buffer) => buffer.looping);
    if (unclassifiedLoops.length) blockers.push(`unattributed-playing-loops:${unclassifiedLoops.length}`);

    const transmissionPlaying = input.audioBuffers.filter(
      (buffer) => buffer.transmissionOwned === true && buffer.playing,
    );
    if (transmissionPlaying.length) blockers.push(`transmission-audio-still-playing:${transmissionPlaying.length}`);
  }

  if (input.mediaQuietMs < 6_000) blockers.push('post-media-quiet-window-incomplete');
  if (input.canvasFrame === null || input.canvasFrame <= 0) blockers.push('battlefield-frame-not-observed');

  return { safe: blockers.length === 0, blockers };
}
