import { afterEach, describe, expect, it, vi } from 'vitest';
import { installGameInput, type InstalledGameInput } from '../../src/ui/pages/game/gameInput';
import type { VmShell } from '../../src/adapter/runtime';

let installed: InstalledGameInput | undefined;
afterEach(() => {
  installed?.cleanup();
  installed = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(search = '', locked = true, movieActive = false) {
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    tabIndex: 0,
    parentElement: null,
    focus: vi.fn(),
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => false,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    requestPointerLock: vi.fn().mockResolvedValue(undefined),
  });
  const doc = Object.assign(new EventTarget(), {
    pointerLockElement: locked ? canvas : null,
    activeElement: canvas,
    fullscreenElement: null,
    hidden: false,
    createElement: () => ({ remove: vi.fn(), classList: { add: vi.fn(), remove: vi.fn() } }),
    exitPointerLock: vi.fn(),
  });
  vi.stubGlobal('document', doc);
  const touchReports: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    'window',
    Object.assign(new EventTarget(), {
      location: { search },
      setTimeout,
      clearTimeout,
      innerWidth: 800,
      innerHeight: 600,
      __RA2Host: { platform: 'ios', version: 1, ownerDataToken: 'never-log-this' },
      __RA2NativeDiagnostics: {
        phase: vi.fn(),
        error: vi.fn(),
        event: vi.fn(),
        metrics: vi.fn(),
        touch: (record: Record<string, unknown>) => touchReports.push(record),
      },
    }),
  );
  vi.stubGlobal('navigator', { platform: 'Win32', userAgent: 'Windows' });
  const frames = new Map<number, FrameRequestCallback>();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const vm = { setCursorPosition: vi.fn(), postMessage: vi.fn(), setKeyState: vi.fn() };
  const present = vi.fn();
  installed = installGameInput(
    canvas as unknown as HTMLCanvasElement,
    vm as unknown as VmShell,
    true,
    present,
    () => ({ width: 800, height: 600 }),
    () => movieActive,
  );
  const pointer = (type: string, fields: Record<string, number | boolean | string> = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerType: 'mouse',
      isPrimary: true,
      pointerId: 1,
      button: 0,
      buttons: 0,
      clientX: 400,
      clientY: 300,
      movementX: 0,
      movementY: 0,
      ctrlKey: false,
      shiftKey: false,
      ...fields,
    });
    canvas.dispatchEvent(event);
  };
  const flush = () => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  };
  return { canvas, doc, vm, present, pointer, frames, flush, touchReports };
}

describe('桌面鼠标跟手性', () => {
  it.each(['blur-first', 'unlock-first', 'unlock-only'])('失焦/隐藏/解锁不伪造 Esc：%s', (order) => {
    vi.useFakeTimers();
    const { doc, vm } = setup();
    const blur = () => {
      window.dispatchEvent(new Event('blur'));
      doc.hidden = true;
      doc.dispatchEvent(new Event('visibilitychange'));
    };
    if (order === 'blur-first') blur();
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    if (order === 'unlock-first') blur();
    vi.advanceTimersByTime(1000);
    expect(vm.postMessage).not.toHaveBeenCalled();
    expect(vm.setKeyState).not.toHaveBeenCalled();
  });

  it('真实 Esc 只转发一组 DOWN/UP，随后解锁不补发', () => {
    vi.useFakeTimers();
    const { doc, vm } = setup();
    for (const type of ['keydown', 'keyup']) {
      window.dispatchEvent(
        Object.assign(new Event(type, { cancelable: true }), {
          key: 'Escape',
          code: 'Escape',
          keyCode: 27,
          altKey: false,
          ctrlKey: false,
          shiftKey: false,
          metaKey: false,
          repeat: false,
          isComposing: false,
        }),
      );
    }
    doc.pointerLockElement = null;
    doc.dispatchEvent(new Event('pointerlockchange'));
    vi.advanceTimersByTime(1000);
    expect(
      vm.postMessage.mock.calls
        .filter(([message]) => message === 0x100 || message === 0x101)
        .map(([message, key]) => [message, key]),
    ).toEqual([
      [0x100, 27],
      [0x101, 27],
    ]);
  });
  it('首个移动立即到达 VM，同帧后续位移合并且不丢距离', () => {
    const { vm, present, pointer, frames, flush } = setup();
    pointer('pointermove', { movementX: 3, movementY: 2 });
    expect(present).toHaveBeenLastCalledWith(403, 302, true);
    expect(vm.postMessage).toHaveBeenCalledExactlyOnceWith(0x200, 0, (302 << 16) | 403);
    pointer('pointermove', { movementX: 4, movementY: -1 });
    expect(present).toHaveBeenLastCalledWith(407, 301, true);
    expect(frames.size).toBe(1);
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    flush();
    expect(vm.setCursorPosition).toHaveBeenLastCalledWith(407, 301);
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 0, (301 << 16) | 407);
    expect(vm.postMessage).toHaveBeenCalledTimes(2);
    expect(present).toHaveBeenCalledTimes(2); // flush neither presents twice nor rolls back the cursor
  });

  it('单次移动不在帧尾重复投递，下一帧的首个移动仍立即发送', () => {
    const { vm, pointer, flush } = setup();
    pointer('pointermove', { movementX: 1 });
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    pointer('pointermove', { movementX: 1 });
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x200, 0, (300 << 16) | 402);
    expect(vm.postMessage).toHaveBeenCalledTimes(2);
  });

  it('千次高频移动只发送首尾两次，点击前冲刷尾部', () => {
    const { vm, pointer, flush } = setup();
    for (let i = 0; i < 1000; i++) pointer('pointermove', { movementX: i % 2 ? -1 : 1 });
    expect(vm.postMessage).toHaveBeenCalledTimes(1);
    pointer('pointerdown', { buttons: 1 });
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x200, 0x200, 0x201]);
    expect(vm.postMessage).toHaveBeenLastCalledWith(0x201, 1, (300 << 16) | 400);
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(3);
  });

  it('点击前先冲刷移动消息，保留 MOVE/DOWN/UP 的顺序', () => {
    const { vm, pointer, frames, flush } = setup();
    pointer('pointermove', { movementX: 10 });
    pointer('pointerdown', { buttons: 1 });
    pointer('pointerup');
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x200, 0x201, 0x202]);
    expect(vm.postMessage.mock.calls.every(([, , point]) => point === ((300 << 16) | 410))).toBe(true);
    expect(frames.size).toBe(0);
    flush();
    expect(vm.postMessage).toHaveBeenCalledTimes(3);
  });

  it('失焦后取消尚未投递的移动', () => {
    const { canvas, vm, pointer, flush } = setup();
    pointer('pointermove', { movementX: 10 });
    vm.postMessage.mockClear();
    pointer('pointermove', { movementX: 10 });
    canvas.dispatchEvent(new Event('blur'));
    flush();
    expect(vm.postMessage).not.toHaveBeenCalled();
  });

  it.each(['', '?raw-mouse=0', '?raw-mouse=1'])('Windows 锁定沿用系统调整，原始计数须显式开启：%s', (search) => {
    const { canvas, pointer } = setup(search, false);
    pointer('pointerdown', { buttons: 1 });
    pointer('pointerup');
    expect(canvas.requestPointerLock).toHaveBeenCalledExactlyOnceWith(
      search === '?raw-mouse=1' ? { unadjustedMovement: true } : undefined,
    );
  });
});

describe('iOS 触摸到原生消息映射', () => {
  const touch = (pointerId: number, clientX: number, clientY: number, isPrimary = true) => ({
    pointerType: 'touch',
    pointerId,
    clientX,
    clientY,
    isPrimary,
  });

  it('阈值后的拖动以 MK_LBUTTON 发送完整普通选择框序列', () => {
    const { vm, pointer, touchReports } = setup('', false);
    pointer('pointerdown', touch(11, 100, 120));
    pointer('pointermove', touch(11, 115, 135));
    pointer('pointerup', touch(11, 115, 135));

    expect(vm.postMessage.mock.calls.map(([message, flags]) => [message, flags])).toEqual([
      [0x0201, 0x0001],
      [0x0200, 0x0001],
      [0x0202, 0x0000],
    ]);
    const selection = touchReports.find((record) => record.gesture === 'selectionReplaced');
    expect(selection).toMatchObject({
      startX: 100,
      startY: 120,
      endX: 115,
      endY: 135,
      logicalStartX: 100,
      logicalStartY: 120,
      logicalEndX: 115,
      logicalEndY: 135,
      mouseFlagsDuringGesture: 1,
      wmSequence: 'WM_LBUTTONDOWN>WM_MOUSEMOVE>WM_LBUTTONUP',
      mouseFlagsSequence: '1>1>0',
    });

    vm.postMessage.mockClear();
    pointer('pointerdown', touch(14, 700, 500));
    pointer('pointermove', touch(14, 720, 520));
    pointer('pointerup', touch(14, 720, 520));
    // Empty-box clearing remains ordinary RA2 selection behavior; the adapter sends no unit IDs or memory edits.
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x0201, 0x0200, 0x0202]);
  });

  it('简单点按仍发送 MOVE/DOWN/UP；长按仍发送右键', () => {
    vi.useFakeTimers();
    const { vm, pointer } = setup('', false);
    pointer('pointerdown', touch(12, 200, 180));
    pointer('pointerup', touch(12, 200, 180));
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x0200, 0x0201, 0x0202]);

    vm.postMessage.mockClear();
    pointer('pointerdown', touch(13, 200, 180));
    vi.advanceTimersByTime(400);
    pointer('pointerup', touch(13, 200, 180));
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x0204, 0x0205]);
  });

  it('Briefing Bink 活跃时长按只发送一次 Esc；Battlefield 长按仍是右键', () => {
    vi.useFakeTimers();
    const { vm, pointer, touchReports } = setup('', false, true);
    pointer('pointerdown', touch(31, 210, 190));
    vi.advanceTimersByTime(400);
    pointer('pointerup', touch(31, 210, 190));
    expect(vm.postMessage.mock.calls.map(([message, key]) => [message, key])).toEqual([
      [0x0100, 0x1b],
      [0x0101, 0x1b],
    ]);
    expect(vm.setKeyState.mock.calls.filter(([key]) => key === 0x1b)).toEqual([
      [0x1b, true],
      [0x1b, false],
    ]);
    expect(touchReports.find((record) => record.gesture === 'movieSkipLongPress')?.wmSequence).toBe(
      'WM_KEYDOWN>WM_KEYUP',
    );

    installed?.cleanup();
    const gameplay = setup('', false, false);
    gameplay.pointer('pointerdown', touch(32, 210, 190));
    vi.advanceTimersByTime(400);
    gameplay.pointer('pointerup', touch(32, 210, 190));
    expect(gameplay.vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x0204, 0x0205]);
  });

  it('后台/失焦取消拖选时补发 UP 并清除 held input', () => {
    const { canvas, vm, pointer } = setup('', false);
    pointer('pointerdown', touch(15, 100, 100));
    pointer('pointermove', touch(15, 120, 120));
    canvas.dispatchEvent(new Event('blur'));
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x0201, 0x0200, 0x0202]);
    expect(vm.setKeyState).toHaveBeenLastCalledWith(0x01, false);
  });

  it('双指轻点仍保留原生右键点击序列', () => {
    const { vm, pointer } = setup('', false);
    pointer('pointerdown', touch(16, 300, 250));
    pointer('pointerdown', touch(17, 320, 250, false));
    pointer('pointerup', touch(17, 320, 250, false));
    expect(vm.postMessage.mock.calls.map(([message]) => message)).toEqual([0x0200, 0x0204, 0x0205]);
  });

  it.each([
    ['left', 80, 100, 110, 100],
    ['right', 120, 100, 90, 100],
    ['up', 100, 80, 100, 110],
    ['down', 100, 120, 100, 90],
  ])('双指向%s时 cursor 反向移动、相机同向移动', (_direction, primaryX, primaryY, expectedX, expectedY) => {
    const { vm, pointer, present, touchReports } = setup('', false);
    pointer('pointerdown', touch(21, 100, 100));
    pointer('pointerdown', touch(22, 120, 100, false));
    pointer('pointermove', touch(21, primaryX, primaryY));

    expect(vm.postMessage.mock.calls.map(([message, flags]) => [message, flags])).toEqual([
      [0x0204, 0x0002],
      [0x0200, 0x0002],
    ]);
    expect(vm.setCursorPosition).toHaveBeenLastCalledWith(expectedX, expectedY);
    expect(present).toHaveBeenLastCalledWith(expectedX, expectedY, false);
    const pan = touchReports.filter((record) => record.gesture === 'twoPan').at(-1);
    expect(pan).toMatchObject({
      cameraDeltaX: primaryX === 80 ? -10 : primaryX === 120 ? 10 : 0,
      cameraDeltaY: primaryY === 80 ? -10 : primaryY === 120 ? 10 : 0,
      mouseDeltaX: expectedX - 100,
      mouseDeltaY: expectedY - 100,
      mouseFlags: 2,
      wmSequence: 'WM_RBUTTONDOWN>WM_MOUSEMOVE',
      mouseFlagsSequence: '2>2',
    });
    pointer('pointercancel', touch(21, primaryX, primaryY));
    expect(vm.postMessage.mock.calls.at(-1)?.[0]).toBe(0x0205);
    expect(vm.setKeyState).toHaveBeenLastCalledWith(0x02, false);
  });
});
