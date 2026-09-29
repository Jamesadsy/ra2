import { describe, expect, it, vi } from 'vitest';
import type { SessionRuntime } from '../../src/app/session/runtime';
import { VmSessionController } from '../../src/app/session/vmSessionController';

function runtime(): SessionRuntime {
  return {
    start: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };
}

describe('VM session startup cancellation', () => {
  it('does not start a shell when the Tap-to-Start gate is cancelled', async () => {
    const controller = new VmSessionController();
    const vm = runtime();
    const ready = Promise.resolve(false);

    const result = await controller.start(async () => ((await ready) ? vm : null));

    expect(result).toBeNull();
    expect(vm.start).not.toHaveBeenCalled();
    expect(vm.destroy).not.toHaveBeenCalled();
    expect(controller.isActive(vm)).toBe(false);
  });

  it('starts a fresh shell on retry after a cancelled gate', async () => {
    const controller = new VmSessionController();
    const cancelled = await controller.start(async () => null);
    const vm = runtime();

    const result = await controller.start(async () => vm);

    expect(cancelled).toBeNull();
    expect(result).toBe(vm);
    expect(vm.start).toHaveBeenCalledOnce();
    expect(controller.isActive(vm)).toBe(true);
    await controller.destroy();
    expect(vm.destroy).toHaveBeenCalledOnce();
  });
});
