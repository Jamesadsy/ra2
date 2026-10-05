import { describe, expect, it } from 'vitest';
import {
  ExecutionProgressTracker,
  MAX_EXECUTION_PROGRESS_COUNTER,
  MAX_HYPERCALL_IDENTITY_LENGTH,
  MAX_RECENT_HYPERCALL_IDENTITIES,
  MAX_TOP_HYPERCALL_IDENTITIES,
} from '../../src/adapter/executionProgress';

describe('bounded passive execution progress diagnostics', () => {
  it('tracks submitted frames, frame age, last return address, and hypercalls since the last frame', () => {
    const progress = new ExecutionProgressTracker();

    progress.recordHypercall('KERNEL32.DLL!Sleep', 0x1234);
    progress.recordHypercall('DSOUND.COM!IDirectSoundBuffer.Lock', 0x2345);
    expect(progress.snapshot(100)).toMatchObject({
      guestFrameSequence: 0,
      guestFrameAgeMs: null,
      hypercallsSinceLastFrame: 2,
      lastHypercallIdentity: 'DSOUND.COM!IDirectSoundBuffer.Lock',
      topHypercalls: 'DSOUND.COM!IDirectSoundBuffer.Lock:1;KERNEL32.DLL!Sleep:1',
      lastGuestReturnAddress: 0x2345,
    });

    progress.recordGuestFrameSubmitted(90);
    expect(progress.snapshot(105)).toMatchObject({
      guestFrameSequence: 1,
      guestFrameAgeMs: 15,
      hypercallsSinceLastFrame: 0,
    });
    progress.recordHypercall('GDI32.DLL!TextOutA', 0x3456);
    expect(progress.snapshot(110)).toMatchObject({
      guestFrameSequence: 1,
      guestFrameAgeMs: 20,
      hypercallsSinceLastFrame: 1,
      lastGuestReturnAddress: 0x3456,
    });
  });

  it('retains only the fixed recent-identity window and bounded top list', () => {
    const progress = new ExecutionProgressTracker();
    for (let index = 0; index < MAX_RECENT_HYPERCALL_IDENTITIES + 12; index++) {
      progress.recordHypercall(index < 20 ? 'KERNEL32.DLL!Sleep' : `API_${index}_${'x'.repeat(120)}`, index);
    }

    const snapshot = progress.snapshot(500);
    const identities = snapshot.topHypercalls ? snapshot.topHypercalls.split(';') : [];
    expect(identities).toHaveLength(MAX_TOP_HYPERCALL_IDENTITIES);
    expect(snapshot.topHypercalls.length).toBeLessThanOrEqual(
      MAX_TOP_HYPERCALL_IDENTITIES * (MAX_HYPERCALL_IDENTITY_LENGTH + 5),
    );
    expect(snapshot.lastHypercallIdentity?.length).toBeLessThanOrEqual(MAX_HYPERCALL_IDENTITY_LENGTH);
    expect(snapshot.hypercallsSinceLastFrame).toBe(MAX_RECENT_HYPERCALL_IDENTITIES + 12);
  });

  it('saturates counters and reset clears every diagnostic field', () => {
    const progress = new ExecutionProgressTracker();
    const state = progress as unknown as { guestFrameSequence: number; hypercallsSinceLastFrame: number };
    state.guestFrameSequence = MAX_EXECUTION_PROGRESS_COUNTER;
    state.hypercallsSinceLastFrame = MAX_EXECUTION_PROGRESS_COUNTER;
    progress.recordHypercall('KERNEL32.DLL!Sleep', 0x4567);
    expect(progress.snapshot(260)).toMatchObject({
      guestFrameSequence: MAX_EXECUTION_PROGRESS_COUNTER,
      hypercallsSinceLastFrame: MAX_EXECUTION_PROGRESS_COUNTER,
    });
    progress.recordGuestFrameSubmitted(250);
    expect(progress.snapshot(260)).toMatchObject({
      guestFrameSequence: MAX_EXECUTION_PROGRESS_COUNTER,
      guestFrameAgeMs: 10,
      hypercallsSinceLastFrame: 0,
    });

    progress.reset();
    expect(progress.snapshot(300)).toEqual({
      guestFrameSequence: 0,
      guestFrameAgeMs: null,
      hypercallsSinceLastFrame: 0,
      lastHypercallIdentity: null,
      topHypercalls: '',
      lastGuestReturnAddress: null,
    });
  });
});
