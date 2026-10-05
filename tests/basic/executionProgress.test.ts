import { expect, it } from 'vitest';
import { ExecutionProgress } from '../../src/adapter/executionProgress';

it('two sequential media completions require guest frames; continuing hypercalls cannot pass the progress gate', () => {
  const progress = new ExecutionProgress();
  progress.frame(0);
  for (let event = 1; event <= 2; event++) {
    progress.call('BINKW32.DLL!_BinkClose@4');
    progress.frame(event * 1000);
    expect(progress.sample(event * 1000 + 100, true)).toMatchObject({
      mediaCompletionGeneration: event,
      submittedGuestFrames: event + 1,
      activeWithoutFrameProgress: false,
    });
  }
  for (let call = 0; call < 440_000; call++) progress.call('DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition');
  expect(progress.sample(9000, true)).toMatchObject({
    submittedGuestFrames: 3,
    callsSinceFrame: 440_000,
    activeWithoutFrameProgress: true,
    topCallsSinceFrame: [{ key: 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition', count: 440_000 }],
  });
  expect(progress.sample(9000, false).activeWithoutFrameProgress).toBe(false);
  progress.frame(9001);
  expect(progress.sample(9002, true).activeWithoutFrameProgress).toBe(false);
});

it('a stalled capture bounds hypercall identities and exposes the dominant loop without changing scheduling', () => {
  const progress = new ExecutionProgress();
  progress.frame(0);
  for (let call = 0; call < 1000; call++) progress.call('unknown-' + call);
  const sample = progress.sample(3000, true);
  expect(sample.topCallsSinceFrame).toHaveLength(8);
  expect(sample.topCallsSinceFrame[0]).toEqual({ key: '(other)', count: 968 });
});
