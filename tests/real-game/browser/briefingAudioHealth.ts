/**
 * A DirectSound cursor can be queried frequently while the original briefing audio keeps advancing.
 * Judge playback against actual AudioContext/cursor progress, and normalize calls to an advancing media second.
 * The 2,304/s ceiling is four times the highest 574/s rate measured across the six LUNA-062 A/B runs.
 */
export const MAX_CURSOR_POLLS_PER_AUDIO_SECOND = 2_304;

export interface BriefingAudioHealthInput {
  elapsedMs: number;
  contextState: string;
  contextTimeStartSeconds: number | null;
  contextTimeEndSeconds: number | null;
  advancingPlayingBuffers: number;
  peakCursorPollsPer500Ms: number;
}

export interface BriefingAudioHealthResult {
  passed: boolean;
  audioClockDeltaSeconds: number;
  audioClockRate: number;
  cursorPollsPerAudioSecond: number;
  failures: string[];
}

export function assessBriefingAudioHealth(input: BriefingAudioHealthInput): BriefingAudioHealthResult {
  const elapsedSeconds = Math.max(0, input.elapsedMs / 1_000);
  const audioClockDeltaSeconds =
    input.contextTimeStartSeconds === null || input.contextTimeEndSeconds === null
      ? 0
      : Math.max(0, input.contextTimeEndSeconds - input.contextTimeStartSeconds);
  const audioClockRate = elapsedSeconds > 0 ? audioClockDeltaSeconds / elapsedSeconds : 0;
  const cursorPollsPerAudioSecond =
    audioClockRate > 0 ? (Math.max(0, input.peakCursorPollsPer500Ms) * 2) / audioClockRate : Infinity;
  const failures: string[] = [];

  if (input.contextState !== 'running') failures.push('audio-context-not-running');
  if (audioClockDeltaSeconds < Math.max(1, elapsedSeconds * 0.75)) failures.push('audio-clock-not-advancing');
  if (input.advancingPlayingBuffers < 1) failures.push('no-playing-buffer-cursor-progress');
  if (cursorPollsPerAudioSecond > MAX_CURSOR_POLLS_PER_AUDIO_SECOND) failures.push('runaway-position-polling');

  return {
    passed: failures.length === 0,
    audioClockDeltaSeconds,
    audioClockRate,
    cursorPollsPerAudioSecond,
    failures,
  };
}
