import { describe, expect, it, vi } from 'vitest';
import { VmCore } from '../../../src/adapter/vmCore';
import type { VmMoviePlaybackState } from '../../../src/contracts/moviePlayback';
import type { GuestMemory } from '../../../src/vm86/win32';

interface TestGameSpeedHooks {
  mediaSafeGameSpeed: number;
  readGameSpeedFlag: (_memory: GuestMemory) => number | null;
  writeGameSpeedFlag: (_memory: GuestMemory, value: number) => number | null;
}

function createCore(initialSpeed: number, options: { readValue?: number | null; failSafeWrite?: boolean } = {}) {
  let currentSpeed = initialSpeed;
  let state: VmMoviePlaybackState = {
    nativeBinkActive: false,
    syntheticBinkActive: false,
    skippableBriefingActive: false,
    shellPageTitle: 'battle',
  };
  const reads: number[] = [];
  const writes: number[] = [];
  const hooks: TestGameSpeedHooks = {
    mediaSafeGameSpeed: 0,
    readGameSpeedFlag: vi.fn((_memory: GuestMemory) => {
      reads.push(currentSpeed);
      return options.readValue === undefined ? currentSpeed : options.readValue;
    }),
    writeGameSpeedFlag: vi.fn((_memory: GuestMemory, value: number) => {
      writes.push(value);
      if (options.failSafeWrite && value === 0) {
        currentSpeed = value;
        return null;
      }
      currentSpeed = value;
      return value;
    }),
  };
  const core = Object.create(VmCore.prototype) as VmCore;
  Object.assign(core, {
    lastMoviePlaybackState: '',
    lastNativeBinkActive: false,
    mediaGameSpeedScope: null,
    source: { game: { runtimeHooks: hooks } },
    emulator: {},
    shim: { inspectMoviePlaybackState: () => state },
    callbacks: { onMoviePlaybackState: vi.fn() },
    gameClockRate: 0.5,
  });
  const publish = () => (core as unknown as { publishMoviePlaybackState: () => void }).publishMoviePlaybackState();
  const setState = (next: Partial<VmMoviePlaybackState>) => {
    state = { ...state, ...next };
  };
  return {
    core,
    hooks,
    reads,
    writes,
    publish,
    setState,
    get currentSpeed() {
      return currentSpeed;
    },
    set currentSpeed(value: number) {
      currentSpeed = value;
    },
  };
}

describe('native Bink media GameSpeed scope', () => {
  it.each([0, 1, 2, 3, 4, 5, 6])(
    'captures raw %i, applies safe 0 only while active, and restores the exact value',
    (speed) => {
      const test = createCore(speed);
      test.setState({ nativeBinkActive: true });
      test.publish();
      expect(test.currentSpeed).toBe(0);
      expect(test.hooks.readGameSpeedFlag).toHaveBeenCalledOnce();
      expect(test.writes).toEqual(speed === 0 ? [] : [0]);

      test.setState({ nativeBinkActive: false });
      test.publish();
      expect(test.currentSpeed).toBe(speed);
      expect(test.writes).toEqual(speed === 0 ? [] : [0, speed]);
    },
  );

  it('does not overwrite the first saved value on repeated activation and restores once on repeated deactivation', () => {
    const test = createCore(5);
    test.setState({ nativeBinkActive: true });
    test.publish();
    test.publish();
    expect(test.hooks.readGameSpeedFlag).toHaveBeenCalledOnce();
    expect(test.writes).toEqual([0]);

    test.setState({ nativeBinkActive: false });
    test.publish();
    test.publish();
    expect(test.currentSpeed).toBe(5);
    expect(test.writes).toEqual([0, 5]);
  });

  it('captures the user-selected value afresh for a later movie', () => {
    const test = createCore(3);
    test.setState({ nativeBinkActive: true });
    test.publish();
    test.setState({ nativeBinkActive: false });
    test.publish();
    expect(test.currentSpeed).toBe(3);

    test.currentSpeed = 6;
    test.setState({ nativeBinkActive: true });
    test.publish();
    test.setState({ nativeBinkActive: false });
    test.publish();
    expect(test.currentSpeed).toBe(6);
    expect(test.reads).toEqual([3, 6]);
    expect(test.writes).toEqual([0, 3, 0, 6]);
  });

  it('does not activate for synthetic or incomplete Bink state', () => {
    const test = createCore(4);
    test.setState({ syntheticBinkActive: true });
    test.publish();
    test.setState({ syntheticBinkActive: false });
    test.publish();
    expect(test.currentSpeed).toBe(4);
    expect(test.hooks.readGameSpeedFlag).not.toHaveBeenCalled();
    expect(test.writes).toEqual([]);
  });

  it('leaves the scope inactive when validation fails and never tries a fallback value', () => {
    const test = createCore(4, { readValue: null });
    test.setState({ nativeBinkActive: true });
    test.publish();
    test.setState({ nativeBinkActive: false });
    test.publish();
    expect(test.currentSpeed).toBe(4);
    expect(test.writes).toEqual([]);
  });

  it('restores the validated original if the safe write reports failure after changing memory', () => {
    const test = createCore(4, { failSafeWrite: true });
    test.setState({ nativeBinkActive: true });
    test.publish();
    expect(test.currentSpeed).toBe(0);
    test.setState({ nativeBinkActive: false });
    test.publish();
    expect(test.currentSpeed).toBe(4);
    expect(test.writes).toEqual([0, 4]);
  });

  it('leaves clock state untouched', () => {
    const test = createCore(5);
    test.setState({ nativeBinkActive: true });
    test.publish();
    test.setState({ nativeBinkActive: false });
    test.publish();
    expect((test.core as unknown as { gameClockRate: number }).gameClockRate).toBe(0.5);
  });
});
