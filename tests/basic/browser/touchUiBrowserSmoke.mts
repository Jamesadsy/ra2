import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';
/** No game assets: switch UI through real touch/mouse events without mistaking touch capability for a mobile device. */
import { chromium, expect } from '@playwright/test';

const origin = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 568, height: 320 },
    { width: 844, height: 390 },
    { width: 932, height: 430 },
    { width: 390, height: 844 },
  ]) {
    const safeSide = viewport.width === 568 ? 24 : viewport.width === 844 ? 44 : viewport.width === 932 ? 59 : 0;
    // Keep the desktop UA while enabling touch to reproduce a coarse=true desktop/emulator environment.
    const context = await browser.newContext({
      locale: 'zh-CN',
      ignoreHTTPSErrors: true,
      hasTouch: true,
      isMobile: false,
      deviceScaleFactor: safeSide ? 3 : 1,
      viewport,
    });
    try {
      const page = await context.newPage();
      await preventThirdPartyDownloads(page);
      await page.goto(origin);
      await page.getByRole('button', { name: '↓ 没有游戏文件？点击下载', exact: true }).waitFor();
      expect(await page.evaluate(() => matchMedia('(any-pointer: coarse)').matches)).toBe(true);
      await page.evaluate(async (simulatedSafeSide) => {
        const controlsUrl = '/src/ui/pages/game/touchControls.ts';
        const inputUrl = '/src/ui/pages/game/gameInput.ts';
        const toolbarUrl = '/src/ui/pages/game/runtimeToolbar.ts';
        const stateUrl = '/src/ui/pages/game/state/uiState.ts';
        const { cancelSourceRequest } = await import(stateUrl);
        cancelSourceRequest();
        const { installAdaptiveTouchControls } = (await import(
          controlsUrl
        )) as typeof import('../../../src/ui/pages/game/touchControls');
        const { installGameInput } = (await import(inputUrl)) as typeof import('../../../src/ui/pages/game/gameInput');
        const { installRuntimeToolbar } = (await import(
          toolbarUrl
        )) as typeof import('../../../src/ui/pages/game/runtimeToolbar');
        const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
        document.documentElement.style.setProperty('--safe-top', '0px');
        document.documentElement.style.setProperty('--safe-bottom', '0px');
        document.documentElement.style.setProperty('--safe-left', `${simulatedSafeSide}px`);
        document.documentElement.style.setProperty('--safe-right', `${simulatedSafeSide}px`);
        document.body.classList.add('game-running');
        document.getElementById('ui')!.hidden = true;
        const cursorPositions: Array<{ x: number; y: number }> = [];
        const keyStates: Array<{ vk: number; down: boolean }> = [];
        const touchClients: Array<{ x: number; y: number }> = [];
        canvas.addEventListener('pointerdown', (event) => {
          if (event.pointerType === 'touch') touchClients.push({ x: event.clientX, y: event.clientY });
        });
        const vm = {
          setCursorPosition(x: number, y: number) {
            cursorPositions.push({ x, y });
          },
          setKeyState(vk: number, down: boolean) {
            keyStates.push({ vk, down });
          },
          postMessage() {},
        };
        let movieActive = false;
        const input = installGameInput(
          canvas,
          vm as unknown as import('../../../src/adapter/runtime').VmShell,
          false,
          undefined,
          undefined,
          () => movieActive,
        );
        const { installCanvasFit } = (await import(inputUrl)) as typeof import('../../../src/ui/pages/game/gameInput');
        const fit = installCanvasFit(canvas, () => ({ width: 800, height: 600 }));
        const touch = installAdaptiveTouchControls(canvas, vm);
        const toolbar = installRuntimeToolbar(
          {
            onClockRate() {},
            onVolume() {},
            onPerformance() {},
            onSendCheatText() {},
            onSendCheatKey() {},
            async onResolution() {},
            async onChangeSource() {},
            async onDownloadSave() {},
            async onUploadSave() {
              return false;
            },
          },
          canvas,
          'Canvas 2D',
          '触屏 UI 回归',
        );
        Object.assign(window, {
          cleanupTouchUi() {
            touch();
            input.cleanup();
            fit.destroy();
            toolbar.destroy();
          },
          touchUiProbe: {
            cursorPositions,
            keyStates,
            touchClients,
            setMovie(active: boolean) {
              movieActive = active;
            },
          },
        });
      }, safeSide);

      const controls = page.locator('#vm-touch-controls');
      const joystick = page.locator('#vm-touch-joystick');
      const rail = page.locator('#vm-controls');
      const canvas = page.locator('#screen');
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      await expect(rail).not.toHaveClass(/collapsed/);

      const box = await canvas.boundingBox();
      if (!box) throw new Error('测试画布不可见');
      const x = Math.min(viewport.width - 130, box.x + box.width * 0.6);
      const y = Math.min(viewport.height - 150, box.y + box.height * 0.4);
      await page.mouse.click(x, y);
      await expect(controls).toBeHidden();
      await expect(rail).not.toHaveClass(/collapsed/);

      await page.touchscreen.tap(x, y);
      await expect(controls).toBeVisible();
      await expect(joystick).toBeVisible();
      await expect(rail).toHaveClass(/collapsed/);

      await page.evaluate(() => {
        (
          window as Window & {
            touchUiProbe?: {
              cursorPositions: Array<{ x: number; y: number }>;
              touchClients: Array<{ x: number; y: number }>;
            };
          }
        ).touchUiProbe!.cursorPositions.length = 0;
        (
          window as Window & {
            touchUiProbe?: { touchClients: Array<{ x: number; y: number }> };
          }
        ).touchUiProbe!.touchClients.length = 0;
      });
      await page.touchscreen.tap(x, y);
      const touchMapping = await page.evaluate(() => {
        const probe = (
          window as Window & {
            touchUiProbe?: {
              cursorPositions: Array<{ x: number; y: number }>;
              touchClients: Array<{ x: number; y: number }>;
            };
          }
        ).touchUiProbe!;
        const screen = document.querySelector<HTMLCanvasElement>('#screen')!;
        const rect = screen.getBoundingClientRect();
        const client = probe.touchClients.at(-1)!;
        return {
          mapped: probe.cursorPositions.at(-1),
          expected: {
            x: Math.max(0, Math.min(799, Math.floor(((client.x - rect.left) * 800) / rect.width))),
            y: Math.max(0, Math.min(599, Math.floor(((client.y - rect.top) * 600) / rect.height))),
          },
        };
      });
      expect(touchMapping.mapped).toEqual(touchMapping.expected);

      // Trusted touch input traverses the production 400ms timer, including ordinary right-click fallback.
      const session = await context.newCDPSession(page);
      for (const active of [true, false]) {
        const start = await page.evaluate((movie) => {
          const probe = (
            window as unknown as {
              touchUiProbe: {
                keyStates: Array<{ vk: number; down: boolean }>;
                setMovie(active: boolean): void;
              };
            }
          ).touchUiProbe;
          probe.setMovie(movie);
          return probe.keyStates.length;
        }, active);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(550);
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        const keys = await page.evaluate(
          (index) =>
            (
              window as unknown as { touchUiProbe: { keyStates: Array<{ vk: number; down: boolean }> } }
            ).touchUiProbe.keyStates.slice(index),
          start,
        );
        expect(keys).toEqual([
          { vk: active ? 0x1b : 0x02, down: true },
          { vk: active ? 0x1b : 0x02, down: false },
        ]);
      }
      await session.detach();
      await page.keyboard.press('Escape');
      expect(
        await page.evaluate(() =>
          (
            window as unknown as { touchUiProbe: { keyStates: Array<{ vk: number; down: boolean }> } }
          ).touchUiProbe.keyStates.slice(-2),
        ),
      ).toEqual([
        { vk: 0x1b, down: true },
        { vk: 0x1b, down: false },
      ]);

      if (viewport.height <= 600) {
        const geometry = await page.evaluate(() => {
          const canvasBox = document.querySelector<HTMLElement>('#screen')!.getBoundingClientRect();
          const stageBox = document.querySelector<HTMLElement>('#stage')!.getBoundingClientRect();
          const railBox = document.querySelector<HTMLElement>('#vm-touch-controls')!.getBoundingClientRect();
          const buttons = [...document.querySelectorAll<HTMLElement>('#vm-touch-controls > .touch-key')].map(
            (button) => {
              const box = button.getBoundingClientRect();
              const label = document.createRange();
              label.selectNodeContents(button);
              const text = label.getBoundingClientRect();
              const style = getComputedStyle(button);
              return {
                role: button.dataset.role ?? button.dataset.code,
                width: box.width,
                height: box.height,
                visible: getComputedStyle(button).display !== 'none',
                labelFits:
                  text.width <= button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
              };
            },
          );
          return {
            viewport: { width: innerWidth, height: innerHeight },
            safe: {
              left: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-left')) || 0,
              right:
                Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-right')) || 0,
            },
            stage: { x: stageBox.x, y: stageBox.y, width: stageBox.width, height: stageBox.height },
            canvas: {
              x: canvasBox.x,
              y: canvasBox.y,
              width: canvasBox.width,
              height: canvasBox.height,
              aspect: canvasBox.width / canvasBox.height,
              right: canvasBox.right,
            },
            rail: {
              x: railBox.x,
              y: railBox.y,
              width: railBox.width,
              height: railBox.height,
              right: railBox.right,
            },
            buttons,
          };
        });
        const expectedCanvasWidth =
          (viewport.width - 2 * safeSide) / (viewport.height * (4 / 3)) >= 1
            ? viewport.height * (4 / 3)
            : viewport.width - 2 * safeSide;
        expect(geometry.canvas.width).toBeCloseTo(expectedCanvasWidth, 1);
        expect(geometry.canvas.height).toBe(viewport.height);
        expect(geometry.canvas.aspect).toBeCloseTo(4 / 3, 3);
        expect(geometry.canvas.right).toBeLessThanOrEqual(geometry.rail.x);
        expect(geometry.rail.width).toBeLessThanOrEqual(52);
        expect(geometry.rail.height).toBeLessThanOrEqual(200);
        expect(geometry.buttons.find((button) => button.role === 'Space')?.labelFits).toBe(true);
        expect(geometry.rail.right).toBeLessThanOrEqual(viewport.width - safeSide + 0.5);
        expect(Math.abs(geometry.rail.y + geometry.rail.height / 2 - viewport.height / 2)).toBeLessThanOrEqual(1);
        expect(geometry.buttons.map((button) => button.role)).toEqual(['collapse', 'Escape', 'Enter', 'Space']);
        expect(geometry.buttons.every((button) => button.visible && button.width >= 44 && button.height >= 44)).toBe(
          true,
        );

        console.log(
          `${viewport.width}×${viewport.height}: stage ${geometry.stage.width}×${geometry.stage.height}, ` +
            `canvas ${geometry.canvas.width.toFixed(1)}×${geometry.canvas.height.toFixed(1)}, ` +
            `rail ${geometry.rail.width}×${geometry.rail.height}`,
        );

        for (const [code, vk] of [
          ['Escape', 0x1b],
          ['Enter', 0x0d],
          ['Space', 0x20],
        ] as const) {
          const start = await page.evaluate(
            () =>
              (window as Window & { touchUiProbe?: { keyStates: Array<{ vk: number; down: boolean }> } }).touchUiProbe!
                .keyStates.length,
          );
          await page.locator(`#vm-touch-controls [data-code="${code}"]`).tap();
          const keyEvents = await page.evaluate(
            (startIndex) =>
              (
                window as Window & { touchUiProbe?: { keyStates: Array<{ vk: number; down: boolean }> } }
              ).touchUiProbe!.keyStates.slice(startIndex),
            start,
          );
          expect(keyEvents).toEqual([
            { vk, down: true },
            { vk, down: false },
          ]);
        }
      }

      await page.locator('#vm-touch-controls [data-role="collapse"]').tap();
      await expect(controls).toHaveClass(/collapsed/);
      if (viewport.height <= 600) {
        const collapsedFootprint = await controls.boundingBox();
        expect(collapsedFootprint).not.toBeNull();
        expect(collapsedFootprint!.width).toBeLessThanOrEqual(52);
        expect(collapsedFootprint!.height).toBeLessThanOrEqual(52);
        const collapsedTarget = await page.locator('#vm-touch-controls [data-role="collapse"]').boundingBox();
        expect(collapsedTarget?.width).toBeGreaterThanOrEqual(44);
        expect(collapsedTarget?.height).toBeGreaterThanOrEqual(44);
        console.log(
          `${viewport.width}×${viewport.height}: collapsed rail ` +
            `${collapsedFootprint!.width}×${collapsedFootprint!.height}, ` +
            `keyboard target ${collapsedTarget?.width}×${collapsedTarget?.height}`,
        );
        await page.locator('#vm-touch-controls [data-role="collapse"]').tap();
        await expect(controls).not.toHaveClass(/collapsed/);
        await page.locator('#vm-touch-controls [data-role="collapse"]').tap();
        await expect(controls).toHaveClass(/collapsed/);
      }

      await page.mouse.move(x + 10, y + 10);
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      await page.touchscreen.tap(x, y);
      await expect(controls).toBeVisible();
      await expect(controls).toHaveClass(/collapsed/);

      await page.evaluate(async () => {
        document.documentElement.dataset.hostPlatform = 'ios';
        const gateUrl = '/src/ui/pages/game/iosTapToStartGate.ts';
        const stateUrl = '/src/ui/pages/game/state/uiState.ts';
        const inputUrl = '/src/ui/pages/game/gameInput.ts';
        const { controlsCollapsed } = await import(stateUrl);
        const { toggleImmersiveFullscreen } = (await import(
          inputUrl
        )) as typeof import('../../../src/ui/pages/game/gameInput');
        controlsCollapsed.set(true);
        const canvas = document.querySelector<HTMLCanvasElement>('#screen')!;
        let browserFullscreenCalls = 0;
        canvas.requestFullscreen = async () => {
          browserFullscreenCalls++;
        };
        await toggleImmersiveFullscreen(canvas, true);
        (window as Window & { immersiveProbe?: number }).immersiveProbe = browserFullscreenCalls;
        const { createIosTapToStartGate } = (await import(
          gateUrl
        )) as typeof import('../../../src/ui/pages/game/iosTapToStartGate');
        let gateUnlockCalls = 0;
        let gateStartCalls = 0;
        const fakeVm = {
          async unlockAudioForStart() {
            gateUnlockCalls++;
            return {
              contextState: 'running',
              contextTimeSeconds: 0,
              unlockResult: true,
              audioWorkletSupported: true,
              audioWorkletModuleLoaded: true,
              sourceCount: 0,
              streamCount: 0,
              workletCount: 0,
              liveProcessorCount: 0,
            };
          },
        };
        const gate = createIosTapToStartGate(
          canvas,
          fakeVm as unknown as import('../../../src/adapter/vmShell').VmShell,
          () => true,
          () => {
            gateStartCalls++;
            document.documentElement.dataset.hostImmersive = 'true';
          },
        );
        void gate.ready.then((ready) => {
          const state = window as Window & { gateResult?: boolean };
          state.gateResult = ready;
        });
        (window as Window & { tapGateReadCounts?: () => { unlocks: number; starts: number } }).tapGateReadCounts =
          () => ({
            unlocks: gateUnlockCalls,
            starts: gateStartCalls,
          });
      });
      await expect(rail).toHaveClass(/collapsed/);
      const compact = await page.evaluate(() => {
        const rail = document.querySelector<HTMLElement>('#vm-controls')!;
        const toggle = document.querySelector<HTMLElement>('#vm-controls-toggle')!;
        const outer = rail.getBoundingClientRect();
        const inner = toggle.getBoundingClientRect();
        const outside = document.elementFromPoint(outer.left + 70, outer.top + 22);
        return {
          width: outer.width,
          height: outer.height,
          hitboxWidth: inner.width,
          hitboxHeight: inner.height,
          safeTop: Number.parseFloat(getComputedStyle(rail).top) || 0,
          outsideIntercepted: !!outside?.closest('#vm-controls'),
        };
      });
      expect(compact).toMatchObject({
        width: 44,
        height: 44,
        hitboxWidth: 44,
        hitboxHeight: 44,
        outsideIntercepted: false,
      });
      expect(compact.safeTop).toBeGreaterThanOrEqual(8);
      expect(await page.evaluate(() => document.documentElement.dataset.hostImmersive)).toBe('true');
      expect(await page.evaluate(() => (window as Window & { immersiveProbe?: number }).immersiveProbe)).toBe(0);
      const nativeSurfaceStyles = await page.evaluate(async () => {
        const canvas = document.querySelector('#screen')!;
        const canvasStyle = getComputedStyle(canvas);
        const debugStyle = getComputedStyle(document.querySelector('#vm-debug')!);
        const styleSource = await fetch('/src/ui/pages/game/styles.css?direct').then((response) => response.text());
        const nativeSurfaceRule =
          styleSource.match(/html\[data-host-platform='ios'\] #screen-frame,[\s\S]*?\n\}/)?.[0] ?? '';
        return {
          selection: canvasStyle.userSelect,
          nativeCalloutSuppressionScoped: nativeSurfaceRule.includes('-webkit-touch-callout: none;'),
          debugSelection: debugStyle.userSelect,
        };
      });
      expect(nativeSurfaceStyles.selection).toBe('none');
      expect(nativeSurfaceStyles.nativeCalloutSuppressionScoped).toBe(true);
      expect(nativeSurfaceStyles.debugSelection).not.toBe('none');
      await expect(page.locator('#ios-tap-to-start')).toHaveCount(1);
      await page.locator('#ios-tap-to-start button').click();
      await expect(page.locator('#ios-tap-to-start')).toHaveCount(0);
      expect(await page.evaluate(() => (window as Window & { gateResult?: boolean }).gateResult)).toBe(true);
      expect(
        await page.evaluate(() =>
          (window as Window & { tapGateReadCounts?: () => { unlocks: number; starts: number } }).tapGateReadCounts?.(),
        ),
      ).toEqual({ unlocks: 1, starts: 1 });
      await page.locator('#vm-controls-toggle').click();
      await expect(rail).not.toHaveClass(/collapsed/);
      await page.locator('#vm-controls-toggle').click();
      await expect(rail).toHaveClass(/collapsed/);

      await page.evaluate(() => (window as unknown as { cleanupTouchUi(): void }).cleanupTouchUi());
      await page.touchscreen.tap(x, y);
      await expect(controls).toBeHidden();
      await expect(joystick).toBeHidden();
      console.log(`${viewport.width}×${viewport.height}：coarse 能力不切换 UI，实际触摸/鼠标切换与清理通过`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
}
