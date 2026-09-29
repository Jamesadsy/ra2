import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:https';
import { join, resolve } from 'node:path';
import { chromium, type Locator, type Page } from '@playwright/test';
import { assessBriefingAudioHealth } from './briefingAudioHealth';

const ORIGIN = process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174';
const MENU_FRAME_SAMPLES = 6;
const GAME_ID = process.env.RA2_BROWSER_GAME === 'yr' ? 'yr' : 'ra2';
const IOS_HOST_MODE = process.env.RA2_BROWSER_IOS_HOST === '1';
const TAP_TO_START = IOS_HOST_MODE && process.env.RA2_BROWSER_TAP_TO_START !== '0';
const INITIAL_RESOLUTION = process.env.RA2_BROWSER_INITIAL_RESOLUTION ?? '1440x900';
const EXPECTED_SELECTOR_RESOLUTION =
  process.env.RA2_BROWSER_EXPECTED_SELECTOR_RESOLUTION ?? (INITIAL_RESOLUTION === 'none' ? '' : INITIAL_RESOLUTION);
const EXPECTED_INITIAL_RESOLUTION =
  process.env.RA2_BROWSER_EXPECTED_RESOLUTION ?? (INITIAL_RESOLUTION === 'none' ? '800x600' : INITIAL_RESOLUTION);
const EXPECT_EFFECTIVE_INI_DIAGNOSTIC = process.env.RA2_BROWSER_EXPECT_INI_DIAGNOSTIC !== '0';
const [EXPECTED_GUEST_WIDTH, EXPECTED_GUEST_HEIGHT] = EXPECTED_INITIAL_RESOLUTION.split('x').map(Number);
const FOUR_THREE_GUEST =
  Number.isFinite(EXPECTED_GUEST_WIDTH) &&
  Number.isFinite(EXPECTED_GUEST_HEIGHT) &&
  EXPECTED_GUEST_WIDTH! / EXPECTED_GUEST_HEIGHT! < 1.45;
const WIDE_GUEST =
  Number.isFinite(EXPECTED_GUEST_WIDTH) &&
  Number.isFinite(EXPECTED_GUEST_HEIGHT) &&
  EXPECTED_GUEST_WIDTH! / EXPECTED_GUEST_HEIGHT! > 1.6;
const EVIDENCE_DIR = process.env.RA2_BROWSER_EVIDENCE_DIR;
const PRESENTATION_ONLY = process.env.RA2_BROWSER_PRESENTATION_ONLY === '1';
const LIFECYCLE_ONLY = process.env.RA2_BROWSER_LIFECYCLE_ONLY === '1';
const CAMPAIGN_SELECTION_ONLY = process.env.RA2_BROWSER_CAMPAIGN_SELECTION_ONLY === '1';
const CAMPAIGN_CHOICE = process.env.RA2_BROWSER_CAMPAIGN_CHOICE;
const SKIP_BRIEFING_WITH_LONG_PRESS = process.env.RA2_BROWSER_SKIP_BRIEFING === '1';
const GAME_LABEL = GAME_ID === 'yr' ? 'RA2YR' : 'RA2';
const EXECUTABLE = GAME_ID === 'yr' ? 'gamemd.exe' : 'game.exe';
const GAME_ROOT = resolve(process.env.RA2_GAME_ROOT || 'game');
const GAME_ASSET_RESPONSES: Array<{ path: string; status: number }> = [];
const GAME_ASSET_FAILURES: Array<{ path: string; error: string }> = [];
// clickLogical takes normalized 1440x900 coordinates; RA2 and YR sidebars have different actual horizontal positions.
const MAIN_SINGLE_PLAYER: readonly [number, number] =
  GAME_ID === 'yr' || FOUR_THREE_GUEST ? [1288, 330] : WIDE_GUEST ? [1080, 330] : [1034, 371];
const SINGLE_PLAYER_BACK: readonly [number, number] =
  GAME_ID === 'yr' || FOUR_THREE_GUEST ? [1288, 830] : WIDE_GUEST ? [1080, 840] : [1034, 708];
const SINGLE_PLAYER_CAMPAIGN: readonly [number, number] =
  GAME_ID === 'yr' || FOUR_THREE_GUEST ? [1288, 330] : [1034, 371];

interface AudioProgressProbe {
  contextState: string;
  contextTimeSeconds: number | null;
  contextSampleRateHz: number | null;
  sourceStartCount: number;
  streamStartCount: number;
  workletStartCount: number;
  dynamicStreamWrites: number;
  bufferCreateCount: number;
  bufferDuplicateCount: number;
  buffers: Array<{
    id: number;
    byteLength: number;
    positionBytes: number;
    playing: boolean;
    loop: boolean;
    sampleRate: number;
    channels: number;
    bitsPerSample: number;
    blockAlign: number;
    frequency: number;
    writeCount: number;
    writeAgeMs: number | null;
    frequencyChangeCount: number;
    worklet: boolean;
    scriptStream: boolean;
    source: boolean;
  }>;
}

async function readAudioProgress(page: Page): Promise<AudioProgressProbe | null> {
  return page.evaluate(() => {
    const probe = (window as Window & { __RA2AudioProgressProbe?: () => AudioProgressProbe }).__RA2AudioProgressProbe;
    return probe?.() ?? null;
  });
}

async function captureGuestFrame(page: Page, filename: string): Promise<void> {
  await page.evaluate(() => {
    const captureWindow = window as Window & { __RA2CaptureGuestFrame?: boolean; __RA2CapturedGuestFrame?: string };
    captureWindow.__RA2CapturedGuestFrame = undefined;
    captureWindow.__RA2CaptureGuestFrame = true;
  });
  await page
    .waitForFunction(
      () => typeof (window as Window & { __RA2CapturedGuestFrame?: string }).__RA2CapturedGuestFrame === 'string',
      undefined,
      { timeout: 10_000 },
    )
    .catch(async (error: unknown) => {
      const diagnostics = await page.locator('#screen').evaluate((element: HTMLCanvasElement) => ({
        shell: element.dataset.shellPage ?? null,
        status: element.dataset.vmStatus ?? null,
        frame: element.dataset.vmFrame ?? null,
        batch: element.dataset.vmBatch ?? null,
        movie: element.dataset.moviePlaybackState ?? null,
        bink: element.dataset.vmBinkCalls ?? null,
        battlefield: element.dataset.vmBattlefield ?? null,
      }));
      throw new Error(`Guest frame capture stalled: ${JSON.stringify(diagnostics)}`, { cause: error });
    });
  if (!EVIDENCE_DIR) return;
  const image = await page.evaluate(
    () => (window as Window & { __RA2CapturedGuestFrame?: string }).__RA2CapturedGuestFrame ?? '',
  );
  const base64 = image.replace(/^data:image\/png;base64,/, '');
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, filename), Buffer.from(base64, 'base64'));
}

function serverReady(): Promise<boolean> {
  return new Promise((resolve) => {
    const req = request(ORIGIN, { rejectUnauthorized: false }, (response) => {
      response.resume();
      resolve((response.statusCode ?? 500) < 500);
    });
    req.setTimeout(1_000, () => req.destroy());
    req.on('error', () => resolve(false));
    req.end();
  });
}

async function ensureServer(): Promise<ChildProcess | null> {
  if (await serverReady()) return null;
  const origin = new URL(ORIGIN);
  // Start Vite directly so finally terminates the server itself, leaving no npm grandchild holding the port.
  const server = spawn(
    process.execPath,
    ['node_modules/vite/bin/vite.js', '--host', origin.hostname, '--port', origin.port || '443'],
    {
      cwd: process.cwd(),
      stdio: 'inherit',
    },
  );
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Vite 提前退出：${server.exitCode}`);
    if (await serverReady()) return server;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  server.kill('SIGTERM');
  throw new Error('等待 Vite 启动超时');
}

async function expectShellPage(page: Page, expected: string, timeout: number): Promise<void> {
  await page.waitForFunction(
    (name) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage?.toLowerCase().includes(name),
    expected.toLowerCase(),
    { timeout },
  );
}

/** A private RA2 owner-data stage contains only RA2, so the shell auto-launches it instead of showing a game chooser. */
async function chooseLocalGameIfPrompted(page: Page, canvas: Locator, gameIndex: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  const choices = page.locator('.detected-games button');
  while (Date.now() < deadline) {
    const count = await choices.count();
    if (count > 0) {
      assert(count > gameIndex, `本地游戏选择项不足：需要索引 ${gameIndex}，实际 ${count}`);
      await choices.nth(gameIndex).click();
      return;
    }
    if (((await canvas.getAttribute('data-shell-page')) ?? '').toLowerCase().includes('mainmenu')) return;
    await page.waitForTimeout(100);
  }
  throw new Error('本地 RA2 资源既未显示游戏选择项，也未自动进入主菜单');
}

async function waitForQuietFileReads(page: Page, canvas: Locator): Promise<void> {
  const deadline = Date.now() + 10_000;
  let quietBatches = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(500);
    const batchText = await canvas.getAttribute('data-vm-batch');
    if (!batchText) continue;
    const batch = JSON.parse(batchText) as { calls: number; hot: Array<[string, number]> };
    const reads = batch.hot.find(([key]) => key === 'KERNEL32.DLL!ReadFile')?.[1] ?? 0;
    quietBatches = batch.calls < 4_000 && reads <= 100 ? quietBatches + 1 : 0;
    if (quietBatches >= 2) return;
  }
  throw new Error('主菜单文件读取在 10 秒内未进入稳态');
}

async function waitForBinkOpen(page: Page, before: number, label: string): Promise<void> {
  await page
    .waitForFunction(
      ({ count }) => {
        const raw = document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmBinkCalls ?? '{}';
        const calls = JSON.parse(raw) as Record<string, number>;
        return (calls['BINKW32.DLL!_BinkOpen@8'] ?? 0) > count;
      },
      { count: before },
      { timeout: 60_000 },
    )
    .catch(async (error: unknown) => {
      const canvas = page.locator('#screen');
      throw new Error(
        `${GAME_LABEL} ${label} 60 秒内没有执行新的 BinkOpen：` +
          `frame=${await canvas.getAttribute('data-vm-frame')}，` +
          `status=${await canvas.getAttribute('data-vm-status')}，` +
          `calls=${await canvas.getAttribute('data-vm-bink-calls')}`,
        { cause: error },
      );
    });
}

async function clickUntilShellPage(page: Page, canvas: Locator, expected: string, x: number, y: number): Promise<void> {
  const offsets = [
    [0, 0],
    [-20, 0],
    [20, 0],
    [-50, 0],
    [50, 0],
    [0, -10],
    [0, 10],
    [0, -25],
    [0, 25],
    [-35, -12],
    [35, 12],
    [0, 0],
  ] as const;
  for (let attempt = 0; attempt < offsets.length; attempt++) {
    const current = (await canvas.getAttribute('data-shell-page')) ?? '';
    if (current.toLowerCase().includes(expected.toLowerCase())) return;
    await clickLogical(page, canvas, x + offsets[attempt]![0], y + offsets[attempt]![1]);
    try {
      // Native page transitions synchronously destroy batches of Win32 child windows and may reopen
      // LANGUAGE.MIX/Bink when returning to the main menu. Clicking old owner-drawn controls too early causes reentrancy during destruction.
      // After one real click, allow a full settling window before retrying a click potentially swallowed by animation.
      await expectShellPage(page, expected, 6_000);
      return;
    } catch {
      const rawStatus = await canvas.getAttribute('data-vm-status');
      if (rawStatus) {
        const status = JSON.parse(rawStatus) as { phase: string; detail: string };
        if (status.phase === 'error' || status.phase === 'blocked') {
          throw new Error(`菜单切换中断：${status.phase}：${status.detail}`);
        }
      }
      // The original game may swallow a click while repainting buttons in the same tick; retry only if still on the original page.
    }
  }
  await canvas.screenshot({ path: `/tmp/${GAME_ID}-${expected}-click-failed.png` });
  await expectShellPage(page, expected, 1_000);
}

async function clickLogical(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('RA2 canvas 不可见');
  const resolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [width, height] = resolution.split('x').map(Number);
  const targetX = (x / 1440) * width!;
  const targetY = (y / 900) * height!;
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await clickLockedGuest(page, canvas, targetX, targetY, width!, height!, box.width, box.height);
    return;
  }
  const clientX = box.x + (targetX / width!) * box.width;
  const clientY = box.y + (targetY / height!) * box.height;
  // After a page transition, the same position refers to the next-level button; move away and back to generate a fresh hover.
  // RA2 sidebar buttons are about 100 CSS pixels wide; moving only 30 pixels stays inside the same button and produces no
  // mouse-leave -> enter hover transition. Move to the left half of the screen before returning to the button center.
  await page.mouse.move(box.x + box.width * 0.25, clientY);
  await page.waitForTimeout(100);
  await page.mouse.move(clientX, clientY);
  await page.waitForTimeout(300);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
}

async function clickLockedGuest(
  page: Page,
  canvas: Locator,
  x: number,
  y: number,
  width: number,
  height: number,
  cssWidth: number,
  cssHeight: number,
): Promise<void> {
  await moveLockedGuest(page, canvas, x, y, width, height, cssWidth, cssHeight);
  await page.waitForTimeout(100);
  await canvas.dispatchEvent('pointerdown', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 1,
  });
  await page.waitForTimeout(200);
  await canvas.dispatchEvent('pointerup', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    button: 0,
    buttons: 0,
  });
}

async function moveLockedGuest(
  _page: Page,
  canvas: Locator,
  x: number,
  y: number,
  width: number,
  height: number,
  cssWidth: number,
  cssHeight: number,
): Promise<void> {
  const cursor = (await canvas.getAttribute('data-vm-cursor'))?.match(/^(\d+),(\d+)\//);
  const currentX = Number(cursor?.[1] ?? width / 2);
  const currentY = Number(cursor?.[2] ?? height / 2);
  const relative = (logicalDelta: number, cssExtent: number, logicalExtent: number): number => {
    if (!logicalDelta) return 0;
    const scaled = (logicalDelta * cssExtent) / logicalExtent;
    // PointerEvent movement uses integer device counts; even a remainder below 1 CSS pixel must produce one event.
    return Math.sign(scaled) * Math.max(1, Math.abs(scaled));
  };
  await canvas.dispatchEvent('pointermove', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    movementX: relative(x - currentX, cssWidth, width),
    movementY: relative(y - currentY, cssHeight, height),
  });
}

function callsOf(raw: string | null): Record<string, number> {
  return JSON.parse(raw ?? '{}') as Record<string, number>;
}

async function probeHostUi(page: Page): Promise<void> {
  const theme = await page.evaluate(() => ({
    yellow: getComputedStyle(document.documentElement).getPropertyValue('--ra2-yellow').trim(),
    buttonText: getComputedStyle(document.documentElement).getPropertyValue('--ra2-button-text').trim(),
    debugBorder: getComputedStyle(document.querySelector<HTMLElement>('#vm-debug')!).borderLeftColor,
    sectionRadius: getComputedStyle(document.querySelector<HTMLElement>('#vm-debug .vm-debug-section')!).borderRadius,
    toolbarBackground: getComputedStyle(document.querySelector<HTMLElement>('#vm-controls .toolbar-button')!)
      .backgroundImage,
  }));
  assert.equal(theme.yellow.toLowerCase(), '#d8cf00', `网页未应用 RA2 信息黄：${JSON.stringify(theme)}`);
  assert.equal(theme.yellow, theme.buttonText, `RA2 信息黄未引用按钮文本色：${JSON.stringify(theme)}`);
  assert.equal(theme.debugBorder, 'rgb(150, 150, 150)', `Debug 金属边框未生效：${JSON.stringify(theme)}`);
  assert.equal(theme.sectionRadius, '0px', `Debug 面板仍是普通圆角卡片：${JSON.stringify(theme)}`);
  // Toolbar buttons use three CSS states and no longer depend on game-menu sprites.
  assert(theme.toolbarBackground.includes('linear-gradient'), `CSS 工具按钮未生效：${JSON.stringify(theme)}`);

  // The old game-specific cursor table is gone; use the generic memory-recording output box to verify accelerated panel wheel scrolling.
  const scroller = page.locator('#vm-debug pre').first();
  const oldStyle = (await scroller.getAttribute('style')) ?? '';
  const oldText = (await scroller.textContent()) ?? '';
  await scroller.evaluate((element: HTMLElement) => {
    element.style.height = '80px';
    element.style.maxHeight = '80px';
    element.style.overflowY = 'auto';
    element.textContent = Array.from({ length: 40 }, (_, index) => `probe ${index}`).join('\n');
    element.scrollTop = 0;
  });
  await scroller.hover();
  await page.mouse.wheel(0, 40);
  await page.waitForTimeout(100);
  const scrollTop = await scroller.evaluate((element: HTMLElement) => element.scrollTop);
  assert(scrollTop >= 90, `网页面板滚轮未加速：deltaY=40 后只滚动 ${scrollTop}px`);
  await scroller.evaluate(
    (element: HTMLElement, previous: { style: string; text: string }) => {
      element.setAttribute('style', previous.style);
      element.textContent = previous.text;
      element.scrollTop = 0;
    },
    { style: oldStyle, text: oldText },
  );
  console.log(
    `🔬 网页 HUD：信息黄=${theme.yellow}，灰黑金属按钮，工业边角=${theme.sectionRadius}，滚轮 40→${scrollTop}px`,
  );
}

async function probeCampaignHover(page: Page, canvas: Locator, playCallsBeforePage: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Campaign canvas 不可见');
  const [width, height] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600').split('x').map(Number);
  await moveLockedGuest(page, canvas, 80, 520, width!, height!, box.width, box.height);
  await page.waitForTimeout(300);
  const hoverDispatchesBefore = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  const beforeCalls = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const before = beforeCalls['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  await moveLockedGuest(page, canvas, 454, 188, width!, height!, box.width, box.height);
  const hashes = new Set<string>();
  for (let sample = 0; sample < 6; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    await page.waitForTimeout(150);
  }
  const hoverDispatchesEntered = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  assert.equal(
    hoverDispatchesEntered,
    hoverDispatchesBefore + 1,
    `阵营 logo 首次进入未产生且仅产生一次 hover：${hoverDispatchesBefore}→${hoverDispatchesEntered}`,
  );
  for (const [x, y] of [
    [465, 188],
    [475, 192],
    [460, 180],
    [470, 186],
  ] as const) {
    await moveLockedGuest(page, canvas, x, y, width!, height!, box.width, box.height);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(300);
  const hoverDispatchesAfterWiggle = Number((await canvas.getAttribute('data-vm-campaign-hover-dispatches')) ?? 0);
  assert.equal(
    hoverDispatchesAfterWiggle,
    hoverDispatchesEntered,
    `同一阵营内部移动重复触发 hover 音频：${hoverDispatchesEntered}→${hoverDispatchesAfterWiggle}`,
  );
  const afterCalls = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const after = afterCalls['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  const changedAudio = Object.fromEntries(
    Object.entries(afterCalls).filter(([key, count]) => count !== (beforeCalls[key] ?? 0)),
  );
  const target = await canvas.getAttribute('data-vm-worker-mouse');
  const dispatchTarget = await canvas.getAttribute('data-vm-worker-dispatch');
  assert(
    (afterCalls['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) >
      (beforeCalls['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) &&
      (afterCalls['DSOUND.COM!IDirectSoundBuffer.Unlock'] ?? 0) >
        (beforeCalls['DSOUND.COM!IDirectSoundBuffer.Unlock'] ?? 0),
    `阵营 logo hover 后 DirectSound PCM 没有继续写入：${JSON.stringify(changedAudio)}`,
  );
  assert(hashes.size >= 2, `阵营 logo hover 没有动画：6 次采样只有 ${hashes.size} 张画面，命中=${target}`);
  console.log(
    `🔬 阵营 hover：页面前/移开/移入 DirectSound Play ` +
      `${playCallsBeforePage}/${before}/${after}，Static 分派=${dispatchTarget}，` +
      `enter-edge=${hoverDispatchesBefore}→${hoverDispatchesEntered}→${hoverDispatchesAfterWiggle}，` +
      `PCM Lock/Unlock 持续更新，变化帧=${hashes.size}/6`,
  );
}

async function probeCampaignVideo(
  page: Page,
  canvas: Locator,
  opensBefore: number,
  closesBefore: number,
  audioBefore: Record<string, number>,
  binkBefore: Record<string, number>,
): Promise<void> {
  try {
    await page.waitForFunction(
      (before) => {
        const raw = document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmBinkCalls ?? '{}';
        const calls = JSON.parse(raw) as Record<string, number>;
        return (calls['BINKW32.DLL!_BinkOpen@8'] ?? 0) > before;
      },
      opensBefore,
      { timeout: 30_000 },
    );
  } catch (error) {
    await canvas.screenshot({ path: `/tmp/${GAME_ID}-campaign-video-timeout.png` });
    throw new Error(
      `${GAME_LABEL} 战役选择后 30 秒未打开 Bink：frame=${await canvas.getAttribute('data-vm-frame')}，` +
        `resolution=${await canvas.getAttribute('data-vm-resolution')}，` +
        `shell=${await canvas.getAttribute('data-shell-page')}，` +
        `status=${await canvas.getAttribute('data-vm-status')}，` +
        `calls=${await canvas.getAttribute('data-vm-bink-calls')}`,
      { cause: error },
    );
  }
  // The reported failure occurs during audio/wait processing mid-playback, not on the first frame. Observe for eight seconds,
  // checking call batches every 500 ms to avoid missing a BinkWait storm by examining only the first 1.2 seconds.
  const hashes = new Set<string>();
  let maxBinkWaitCalls = 0;
  let maxSoundPositionCalls = 0;
  let maxBatchCalls = 0;
  const startedAt = Date.now();
  const audioSamples: Array<{
    contextState: string;
    contextTimeSeconds: number | null;
    buffers: Array<{
      id: number;
      byteLength: number;
      positionBytes: number;
      playing: boolean;
      loop: boolean;
      sampleRate: number;
      blockAlign: number;
      worklet: boolean;
      scriptStream: boolean;
      source: boolean;
    }>;
  } | null> = [];
  for (let sample = 0; sample < 32; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    const batchText = await canvas.getAttribute('data-vm-batch');
    if (sample >= 4 && batchText) {
      const batch = JSON.parse(batchText) as { calls: number; hot: Array<[string, number]> };
      maxBatchCalls = Math.max(maxBatchCalls, batch.calls);
      maxBinkWaitCalls = Math.max(
        maxBinkWaitCalls,
        batch.hot.find(([key]) => key === 'BINKW32.DLL!_BinkWait@4')?.[1] ?? 0,
      );
      maxSoundPositionCalls = Math.max(
        maxSoundPositionCalls,
        batch.hot.find(([key]) => key === 'DSOUND.COM!IDirectSoundBuffer.GetCurrentPosition')?.[1] ?? 0,
      );
    }
    audioSamples.push(
      await page.evaluate(() => {
        const probe = (
          window as Window & {
            __RA2AudioProgressProbe?: () => {
              contextState: string;
              contextTimeSeconds: number | null;
              buffers: Array<{
                id: number;
                byteLength: number;
                positionBytes: number;
                playing: boolean;
                loop: boolean;
                sampleRate: number;
                blockAlign: number;
                worklet: boolean;
                scriptStream: boolean;
                source: boolean;
              }>;
            };
          }
        ).__RA2AudioProgressProbe;
        return probe?.() ?? null;
      }),
    );
    await page.waitForTimeout(250);
  }
  const audioTimes = audioSamples
    .filter((sample): sample is NonNullable<typeof sample> => sample !== null)
    .map((sample) => sample.contextTimeSeconds)
    .filter((time): time is number => time !== null);
  const bufferSamples = audioSamples.flatMap((sample) => sample?.buffers ?? []).filter((buffer) => buffer.playing);
  const activeBufferIds = [...new Set(bufferSamples.map((buffer) => buffer.id))];
  const advancingBufferIds = activeBufferIds.filter((id) => {
    const positions = audioSamples
      .map((sample) => sample?.buffers.find((buffer) => buffer.id === id))
      .filter((buffer): buffer is NonNullable<typeof buffer> => buffer?.playing === true)
      .map((buffer) => buffer.positionBytes);
    return new Set(positions).size >= 4;
  });
  const audioContextState = audioSamples.filter((sample) => sample !== null).at(-1)?.contextState ?? 'unavailable';
  const audioClockStart = audioTimes[0] ?? null;
  const audioClockEnd = audioTimes.at(-1) ?? null;
  const audioClockDelta = audioClockStart !== null && audioClockEnd !== null ? audioClockEnd - audioClockStart : 0;
  const audioHealth = assessBriefingAudioHealth({
    elapsedMs: Date.now() - startedAt,
    contextState: audioContextState,
    contextTimeStartSeconds: audioClockStart,
    contextTimeEndSeconds: audioClockEnd,
    advancingPlayingBuffers: advancingBufferIds.length,
    peakCursorPollsPer500Ms: maxSoundPositionCalls,
  });
  const binkAfter = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const audioAfter = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const asset404s = [...new Set(GAME_ASSET_RESPONSES.filter((response) => response.status >= 400).map((r) => r.path))];
  const assetFailures = [...new Set(GAME_ASSET_FAILURES.map((failure) => `${failure.path}: ${failure.error}`))];
  console.log(
    `🔬 A/B brief probe: elapsed=${Date.now() - startedAt}ms，canvasHashes=${hashes.size}/32，` +
      `VMFrames=${await canvas.getAttribute('data-vm-frame')}，` +
      `BinkNextFrameΔ=${(binkAfter['BINKW32.DLL!_BinkNextFrame@4'] ?? 0) - (binkBefore['BINKW32.DLL!_BinkNextFrame@4'] ?? 0)}，` +
      `BinkDoFrameΔ=${(binkAfter['BINKW32.DLL!_BinkDoFrame@4'] ?? 0) - (binkBefore['BINKW32.DLL!_BinkDoFrame@4'] ?? 0)}，` +
      `BinkCopyToBufferΔ=${(binkAfter['BINKW32.DLL!_BinkCopyToBuffer@28'] ?? 0) - (binkBefore['BINKW32.DLL!_BinkCopyToBuffer@28'] ?? 0)}，` +
      `BinkWaitMax=${maxBinkWaitCalls}/500ms，GetCurrentPositionMax=${maxSoundPositionCalls}/500ms，` +
      `batchMax=${maxBatchCalls}/500ms，AudioContext=${audioContextState} Δt=${audioClockDelta.toFixed(3)}s，` +
      `activeBuffers=${activeBufferIds.length} advancingBuffers=${advancingBufferIds.length}，` +
      `cursorPolls=${audioHealth.cursorPollsPerAudioSecond.toFixed(0)}/audio-s，` +
      `CreateBufferΔ=${(audioAfter['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0) - (audioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0)}，` +
      `PlayΔ=${(audioAfter['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0) - (audioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0)}，` +
      `asset4xx=${asset404s.length} assetFailures=${assetFailures.length}`,
  );
  if (asset404s.length || assetFailures.length) {
    console.log(`🔬 A/B game asset misses: ${JSON.stringify({ asset404s, assetFailures })}`);
  }
  assert(hashes.size >= 12, `战役过场没有持续播放：32 次采样只有 ${hashes.size} 张画面`);
  assert(
    maxBinkWaitCalls < 100,
    `战役过场 BinkWait 仍在宿主 hypercall 自旋：最高 ${maxBinkWaitCalls}/500ms，总调用 ${maxBatchCalls}/500ms`,
  );
  assert(
    audioHealth.passed,
    `战役 briefing 音频未通过实际进度/非 runaway 健康契约：` +
      `context=${audioContextState}，时钟Δ=${audioHealth.audioClockDeltaSeconds.toFixed(3)}s，` +
      `推进缓冲=${advancingBufferIds.length}，游标查询=${audioHealth.cursorPollsPerAudioSecond.toFixed(0)}/音频秒，` +
      `失败=${audioHealth.failures.join(',')}`,
  );
  const buffersBefore = audioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0;
  const buffersAfter = audioAfter['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0;
  const playsBefore = audioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  const playsAfter = audioAfter['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  assert(
    buffersAfter > buffersBefore && playsAfter > playsBefore,
    `战役过场没有建立并播放音频缓冲：CreateSoundBuffer ${buffersBefore}→${buffersAfter}，Play ${playsBefore}→${playsAfter}`,
  );
  if (SKIP_BRIEFING_WITH_LONG_PRESS) {
    try {
      await page.waitForFunction(
        () => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.moviePlayback === 'skippable-briefing',
        undefined,
        { timeout: 30_000 },
      );
    } catch (error) {
      throw new Error(
        `Briefing skip state not detected: movie=${await canvas.getAttribute('data-movie-playback')} ` +
          `details=${await canvas.getAttribute('data-movie-playback-state')} ` +
          `shell=${await canvas.getAttribute('data-shell-page')} ` +
          `status=${await canvas.getAttribute('data-vm-status')} bink=${await canvas.getAttribute('data-vm-bink-calls')}`,
        { cause: error },
      );
    }
    await dispatchTouchLongPress(page, canvas);
    await page.waitForFunction(
      ({ before }) => {
        const raw = document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmBinkCalls ?? '{}';
        const calls = JSON.parse(raw) as Record<string, number>;
        return (calls['BINKW32.DLL!_BinkClose@4'] ?? 0) > before;
      },
      { before: closesBefore },
      { timeout: 30_000 },
    );
    console.log(
      `🔬 战役过场：触控长按 movie skip，BinkCloseΔ=${(callsOf(await canvas.getAttribute('data-vm-bink-calls'))['BINKW32.DLL!_BinkClose@4'] ?? 0) - closesBefore}，` +
        `movie=${await canvas.getAttribute('data-movie-playback')}`,
    );
  } else {
    // Natural completion remains the default probe; the explicit skip mode exercises the native touch gesture separately.
    await page.waitForFunction(
      ({ before }) => {
        const raw = document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmBinkCalls ?? '{}';
        const calls = JSON.parse(raw) as Record<string, number>;
        return (calls['BINKW32.DLL!_BinkClose@4'] ?? 0) > before;
      },
      { before: closesBefore },
      { timeout: 180_000 },
    );
    console.log(
      `🔬 战役过场：8 秒变化帧=${hashes.size}/32，` +
        `BinkWait=${maxBinkWaitCalls}/500ms，声音游标=${maxSoundPositionCalls}/500ms，` +
        `音频 buffer=${buffersBefore}→${buffersAfter}、Play=${playsBefore}→${playsAfter}；` +
        `原始战役 briefing 自然完成 BinkClose`,
    );
  }
}

async function clickGuest(page: Page, canvas: Locator, x: number, y: number): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('RA2 canvas 不可见');
  const resolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [width, height] = resolution.split('x').map(Number);
  if (await page.evaluate(() => document.pointerLockElement?.id === 'screen')) {
    await clickLockedGuest(page, canvas, x, y, width!, height!, box.width, box.height);
    return;
  }
  await page.mouse.move(box.x + (x / width!) * box.width, box.y + (y / height!) * box.height);
  await page.waitForTimeout(200);
  await page.mouse.down();
  await page.waitForTimeout(200);
  await page.mouse.up();
}

async function dispatchTouchLongPress(page: Page, canvas: Locator): Promise<void> {
  const box = await canvas.boundingBox();
  if (!box) throw new Error('RA2 canvas 不可见，无法送出 movie 长按');
  const clientX = box.x + box.width * 0.5;
  const clientY = box.y + box.height * 0.5;
  const pointerId = 37;
  await canvas.dispatchEvent('pointerdown', {
    pointerType: 'touch',
    pointerId,
    isPrimary: true,
    clientX,
    clientY,
    button: 0,
    buttons: 1,
  });
  await page.waitForTimeout(600);
  await canvas.dispatchEvent('pointerup', {
    pointerType: 'touch',
    pointerId,
    isPrimary: true,
    clientX,
    clientY,
    button: 0,
    buttons: 0,
  });
}

type BattlefieldSignal = {
  rightEdgeRatio: number;
  fieldRatio: number;
  frame: number;
};

async function battlefieldSignal(canvas: Locator): Promise<BattlefieldSignal> {
  const ratios = ((await canvas.getAttribute('data-vm-battlefield')) ?? '0,0').split(',').map(Number);
  return {
    rightEdgeRatio: ratios[0] ?? 0,
    fieldRatio: ratios[1] ?? 0,
    frame: Number((await canvas.getAttribute('data-vm-frame')) ?? 0),
  };
}

async function waitForPlayableBattle(
  page: Page,
  canvas: Locator,
  timeoutMs: number,
): Promise<{
  elapsedMs: number;
  signal: BattlefieldSignal;
}> {
  const startedAt = Date.now();
  let lastSignal: BattlefieldSignal = { rightEdgeRatio: 0, fieldRatio: 0, frame: 0 };
  let lastLogAt = 0;
  while (Date.now() - startedAt < timeoutMs) {
    await page.waitForTimeout(500);
    const rawStatus = await canvas.getAttribute('data-vm-status');
    if (rawStatus) {
      const status = JSON.parse(rawStatus) as { phase: string; detail: string };
      if (status.phase === 'error' || status.phase === 'blocked') {
        throw new Error(`战役运行中断：${status.phase}：${status.detail}`);
      }
    }
    lastSignal = await battlefieldSignal(canvas);
    if (lastSignal.rightEdgeRatio >= 0.08 && lastSignal.fieldRatio >= 0.05) {
      return { elapsedMs: Date.now() - startedAt, signal: lastSignal };
    }
    if (Date.now() - lastLogAt >= 5_000) {
      lastLogAt = Date.now();
      console.log(
        `⏳ 等待可操作战场 ${Math.round((Date.now() - startedAt) / 1_000)}s：` +
          `右栏=${lastSignal.rightEdgeRatio.toFixed(3)}，地图=${lastSignal.fieldRatio.toFixed(3)}，` +
          `帧=${lastSignal.frame}，批次=${await canvas.getAttribute('data-vm-batch')}`,
      );
    }
  }
  throw new Error(
    `等待可操作战场超时：右栏=${lastSignal.rightEdgeRatio.toFixed(3)}，` +
      `地图=${lastSignal.fieldRatio.toFixed(3)}，帧=${lastSignal.frame}`,
  );
}

async function probeMainMenu(
  page: Page,
  canvas: Locator,
): Promise<{
  uniqueFrames: number;
  displayedFps: number;
  maxBatchCalls: number;
  maxReadFileCalls: number;
  emittedFrames: number;
  maxBatchHot: Array<[string, number]>;
}> {
  const hashes = new Set<string>();
  const batches: Array<{ calls: number; hot: Array<[string, number]> }> = [];
  const startFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
  await page.waitForTimeout(750);
  for (let sample = 0; sample < MENU_FRAME_SAMPLES; sample++) {
    hashes.add(
      (await canvas.getAttribute('data-vm-frame-sample')) ?? `frame:${await canvas.getAttribute('data-vm-frame')}`,
    );
    const batch = await canvas.getAttribute('data-vm-batch');
    if (batch) batches.push(JSON.parse(batch));
    await page.waitForTimeout(250);
  }
  const fpsOutput = page.locator('#vm-fps');
  let fpsText = await fpsOutput.evaluate((output: HTMLOutputElement) => output.value);
  if (Number(fpsText.match(/显示\s+([\d.]+)/)?.[1] ?? 0) < 20) {
    await page.waitForTimeout(1_000);
    fpsText = await fpsOutput.evaluate((output: HTMLOutputElement) => output.value);
  }
  return {
    uniqueFrames: hashes.size,
    displayedFps: Number(fpsText.match(/显示\s+([\d.]+)/)?.[1] ?? 0),
    maxBatchCalls: Math.max(0, ...batches.map((batch) => batch.calls)),
    maxReadFileCalls: Math.max(
      0,
      ...batches.map((batch) => batch.hot.find(([key]) => key === 'KERNEL32.DLL!ReadFile')?.[1] ?? 0),
    ),
    emittedFrames: Number((await canvas.getAttribute('data-vm-frame')) ?? 0) - startFrame,
    maxBatchHot: [...batches].sort((left, right) => right.calls - left.calls)[0]?.hot ?? [],
  };
}

type NativeLifecycleMetric = Record<string, number | string | undefined>;

async function nativeLifecycleRows(page: Page): Promise<NativeLifecycleMetric[]> {
  return page.evaluate(
    () => (window as Window & { __RA2TestNativeRows?: NativeLifecycleMetric[] }).__RA2TestNativeRows ?? [],
  );
}

async function waitForNativeLifecycleMetric(
  page: Page,
  phase: string,
  fromIndex: number,
  timeoutMs = 12_000,
): Promise<NativeLifecycleMetric> {
  await page
    .waitForFunction(
      ({ phase: expectedPhase, fromIndex: start }) => {
        const rows = (window as Window & { __RA2TestNativeRows?: NativeLifecycleMetric[] }).__RA2TestNativeRows ?? [];
        return rows.slice(start).some((row) => row.event === 'lifecycle' && row.lifecyclePhase === expectedPhase);
      },
      { phase, fromIndex },
      { polling: 100, timeout: timeoutMs },
    )
    .catch(async (error: unknown) => {
      const rows = await nativeLifecycleRows(page);
      throw new Error(`Lifecycle metric ${phase} timed out; recent=${JSON.stringify(rows.slice(fromIndex))}`, {
        cause: error,
      });
    });
  const rows = await nativeLifecycleRows(page);
  return [...rows.slice(fromIndex)].reverse().find((row) => row.event === 'lifecycle' && row.lifecyclePhase === phase)!;
}

async function runShortLifecycleMatrix(page: Page, canvas: Locator): Promise<void> {
  const cycles = [1_000, 1_000, 1_000, 5_000];
  for (const [index, backgroundMs] of cycles.entries()) {
    const beforeFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
    const backgroundStart = (await nativeLifecycleRows(page)).length;
    await page.evaluate(() =>
      (window as Window & { __RA2TestHoldAnimationFrames?: () => void }).__RA2TestHoldAnimationFrames?.(),
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('ra2-native-lifecycle', { detail: { phase: 'background', nativeTimestampMs: Date.now() } }),
      ),
    );
    const background = await waitForNativeLifecycleMetric(page, 'background-paused', backgroundStart);
    assert.equal(Number(background.workerResponsive), 1, 'background Worker probe did not respond');
    assert.equal(Number(background.guestClockPaused), 1, 'background guest clock did not pause');
    assert.equal(Number(background.flushOk), 1, 'background writable state flush did not complete');
    await page.waitForTimeout(backgroundMs);

    const foregroundStart = (await nativeLifecycleRows(page)).length;
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('ra2-native-lifecycle', { detail: { phase: 'foreground', nativeTimestampMs: Date.now() } }),
      ),
    );
    const foreground = await waitForNativeLifecycleMetric(page, 'after-foreground-resume', foregroundStart);
    await page.evaluate(() =>
      (window as Window & { __RA2TestReleaseAnimationFrames?: () => void }).__RA2TestReleaseAnimationFrames?.(),
    );
    await page
      .waitForFunction(
        (frame) => Number(document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmFrame ?? 0) > frame,
        beforeFrame,
        { polling: 100, timeout: 5_000 },
      )
      .catch(async (error: unknown) => {
        const rows = await nativeLifecycleRows(page);
        const diagnostic = await canvas.evaluate((element: HTMLCanvasElement) => ({
          frame: element.dataset.vmFrame,
          batch: element.dataset.vmBatch,
          status: element.dataset.vmStatus,
          movie: element.dataset.moviePlaybackState,
        }));
        throw new Error(
          `No guest frame after lifecycle cycle ${index + 1}; canvas=${JSON.stringify(diagnostic)} ` +
            `metrics=${JSON.stringify(rows.slice(-6))}`,
          { cause: error },
        );
      });
    if (index === 0) {
      const box = await canvas.boundingBox();
      if (box) await page.mouse.click(box.x + box.width * 0.08, box.y + box.height * 0.08);
      await page.evaluate(() => document.exitPointerLock());
    }
    const afterFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
    assert.equal(Number(foreground.workerResponsive), 1, 'foreground Worker probe did not respond');
    if (foreground.lifecyclePaused !== undefined) {
      assert.equal(Number(foreground.lifecyclePaused), 0, 'foreground VM remains lifecycle-paused');
    }
    assert.equal(Number(foreground.guestClockPaused), 0, 'foreground guest clock remains paused');
    assert.equal(Number(foreground.safeToResume), 1, 'foreground VM failed the safe-to-resume check');
    assert(afterFrame > beforeFrame, 'actual guest frame did not advance after foreground');
    console.log(
      `🔬 lifecycle A/B cycle ${index + 1} background=${backgroundMs}ms: ` +
        `run=${background.workerRunning}->${foreground.workerRunning} ` +
        `clock=${background.guestClockPaused}->${foreground.guestClockPaused} ` +
        `logic=${background.guestLogicFrame}->${foreground.guestLogicFrame} ` +
        `guestTime=${background.guestTimeMs}->${foreground.guestTimeMs} ` +
        `frame=${beforeFrame}->${afterFrame} ` +
        `workerFrame=${foreground.workerFrameEmittedCount}/${foreground.workerFrameAcknowledgedCount} ` +
        `mainFrame=${foreground.mainFrameReceivedCount}/${foreground.mainFrameAcknowledgedCount} ` +
        `pendingAck=${foreground.mainFramePendingAckId} raf=${foreground.mainFrameAckRafPending} ` +
        `audio=${foreground.audioContextState}/${foreground.audioWorkletCount}worklets`,
    );
  }
  const lastCycleStart = Math.max(0, (await nativeLifecycleRows(page)).length - 12);
  const probe = await waitForNativeLifecycleMetric(page, 'foreground-runtime-probe', lastCycleStart, 6_000);
  assert.equal(Number(probe.workerResponsive), 1, 'post-resume Worker health probe did not respond');
  for (const key of ['mainFrameReceivedDelta', 'mainFrameAcknowledgedDelta', 'presentedFrameDelta'] as const) {
    if (probe[key] !== undefined) assert(Number(probe[key]) > 0, `post-resume ${key} did not advance`);
  }
  console.log(`🔬 lifecycle post-resume health: ${JSON.stringify(probe)}`);
}

assert(existsSync(join(GAME_ROOT, 'ra2', EXECUTABLE)), `RA2_GAME_ROOT 缺少 ra2/${EXECUTABLE}`);
assert(existsSync(join(GAME_ROOT, 'ra2', 'BINKW32.DLL')), 'RA2_GAME_ROOT 缺少 ra2/BINKW32.DLL');
if (IOS_HOST_MODE) assert.equal(GAME_ID, 'ra2', 'iOS private owner mode only supports RA2');

const server = await ensureServer();
const browser = await chromium.launch({
  headless: process.env.RA2_BROWSER_HEADFUL !== '1',
  // Both games use 640 MiB of v86 RAM. The headless renderer's default V8 old-space limit can occasionally cause
  // GC starvation or Target crashed after repeated frame probes/screenshots. Raise the limit for the test process
  // so failures reflect guest behavior or assertions rather than Playwright host-memory thresholds.
  args: ['--js-flags=--max-old-space-size=4096'],
});
try {
  const context = await browser.newContext({
    locale: 'zh-CN',
    viewport: { width: 1440, height: 1000 },
    ignoreHTTPSErrors: true,
  });
  await context.addInitScript(
    ({ gameId, iosHost, initialResolution, captureWebGl, captureGuestFrames }) => {
      if (captureGuestFrames) {
        const NativeWorker = window.Worker;
        window.Worker = class extends NativeWorker {
          constructor(scriptURL: string | URL, options?: WorkerOptions) {
            super(scriptURL, options);
            this.addEventListener('message', (event: MessageEvent) => {
              const target = window as Window & {
                __RA2CaptureGuestFrame?: boolean;
                __RA2CapturedGuestFrame?: string;
              };
              const message = event.data as {
                type?: string;
                frame?: {
                  width: number;
                  height: number;
                  rgba?: Uint8Array;
                  rgb565?: Uint16Array;
                  pixels: Uint8Array;
                  palette: Uint8Array;
                };
              };
              if (!target.__RA2CaptureGuestFrame || message.type !== 'frame' || !message.frame) return;
              const frame = message.frame;
              const output = document.createElement('canvas');
              output.width = frame.width;
              output.height = frame.height;
              const context = output.getContext('2d');
              if (!context) return;
              const image = context.createImageData(frame.width, frame.height);
              if (frame.rgba) image.data.set(frame.rgba);
              else if (frame.rgb565) {
                for (let index = 0; index < frame.rgb565.length; index++) {
                  const pixel = frame.rgb565[index]!;
                  const offset = index * 4;
                  image.data[offset] = Math.round(((pixel >>> 11) & 31) * (255 / 31));
                  image.data[offset + 1] = Math.round(((pixel >>> 5) & 63) * (255 / 63));
                  image.data[offset + 2] = Math.round((pixel & 31) * (255 / 31));
                  image.data[offset + 3] = 255;
                }
              } else {
                for (let index = 0; index < frame.pixels.length; index++) {
                  const palette = frame.pixels[index]! * 4;
                  const offset = index * 4;
                  image.data[offset] = frame.palette[palette]!;
                  image.data[offset + 1] = frame.palette[palette + 1]!;
                  image.data[offset + 2] = frame.palette[palette + 2]!;
                  image.data[offset + 3] = frame.palette[palette + 3]!;
                }
              }
              context.putImageData(image, 0, 0);
              target.__RA2CapturedGuestFrame = output.toDataURL('image/png');
              target.__RA2CaptureGuestFrame = false;
            });
          }
        };
      }
      if (captureWebGl) {
        const original = HTMLCanvasElement.prototype.getContext as unknown as (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown,
        ) => RenderingContext | null;
        HTMLCanvasElement.prototype.getContext = function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown,
        ): RenderingContext | null {
          if (contextId !== 'webgl2') return original.call(this, contextId, options);
          const attributes = {
            ...(options && typeof options === 'object' ? options : {}),
            preserveDrawingBuffer: true,
          };
          return original.call(this, contextId, attributes);
        } as typeof HTMLCanvasElement.prototype.getContext;
      }
      localStorage.setItem('ra2-vm-preferred-game', gameId);
      if (initialResolution === 'none') localStorage.removeItem(`vm-resolution-${gameId}`);
      else if (initialResolution) localStorage.setItem(`vm-resolution-${gameId}`, initialResolution);
      localStorage.removeItem('vm-clock-rate');
      if (iosHost) {
        window.__RA2Host = { platform: 'ios', version: 1, ownerDataToken: 'asset-free-test-capability' };
      }
    },
    {
      gameId: GAME_ID,
      iosHost: IOS_HOST_MODE,
      initialResolution: INITIAL_RESOLUTION,
      captureWebGl: process.env.RA2_BROWSER_CAPTURE_WEBGL_BUFFER === '1',
      captureGuestFrames: process.env.RA2_BROWSER_CAPTURE_GUEST_FRAMES === '1',
    },
  );
  if (IOS_HOST_MODE && LIFECYCLE_ONLY) {
    await context.addInitScript(`
      window.__RA2Host = { platform: 'ios', version: 1, ownerDataToken: 'asset-free-test-capability' };
      window.__RA2TestNativeRows = [];
      window.__RA2NativeDiagnostics = {
        phase: function(phase) { window.__RA2TestNativeRows.push({ event: 'phase', phase }); },
        error: function(event, message) { window.__RA2TestNativeRows.push({ event: 'error', diagnosticEvent: event, message }); },
        touch: function(record) { window.__RA2TestNativeRows.push(Object.assign({ event: 'touch' }, record)); },
        metrics: function(record) { window.__RA2TestNativeRows.push(record); },
        event: function(event) { window.__RA2TestNativeRows.push({ event: 'event', name: event }); }
      };
      (function() {
        var request = window.requestAnimationFrame.bind(window);
        var cancel = window.cancelAnimationFrame.bind(window);
        var held = new Map();
        var shouldHold = false;
        window.requestAnimationFrame = function(callback) {
          var animationId = 0;
          animationId = request(function(timestamp) {
            if (shouldHold) held.set(animationId, callback);
            else callback(timestamp);
          });
          return animationId;
        };
        window.cancelAnimationFrame = function(animationId) {
          held.delete(animationId);
          cancel(animationId);
        };
        window.__RA2TestHoldAnimationFrames = function() { shouldHold = true; };
        window.__RA2TestReleaseAnimationFrames = function() {
          shouldHold = false;
          var callbacks = Array.from(held.values());
          held.clear();
          callbacks.forEach(function(callback) { callback(performance.now()); });
        };
      })();
    `);
  }
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.toLowerCase().startsWith('/game/ra2/')) {
      GAME_ASSET_RESPONSES.push({ path: url.pathname, status: response.status() });
    }
  });
  page.on('requestfailed', (request) => {
    const url = new URL(request.url());
    if (url.pathname.toLowerCase().startsWith('/game/ra2/')) {
      GAME_ASSET_FAILURES.push({ path: url.pathname, error: request.failure()?.errorText ?? 'unknown' });
    }
  });
  page.on('pageerror', (error) => {
    const detail = error.stack ?? error.message;
    pageErrors.push(detail);
    console.error(`❌ ${GAME_LABEL} pageerror：${detail}`);
  });
  page.on('crash', () => console.error(`❌ ${GAME_LABEL} Chromium renderer crashed`));
  await page.goto(`${ORIGIN}/?debug=1`, { waitUntil: 'domcontentloaded' });
  const canvas = page.locator('#screen');
  if (TAP_TO_START) {
    const tapToStart = page.locator('#ios-tap-to-start');
    await tapToStart.waitFor({ state: 'visible', timeout: 30_000 });
    assert.equal(await tapToStart.count(), 1, 'iOS WebView must show exactly one Tap to Start gate');
    await tapToStart.locator('button').click();
    await tapToStart.waitFor({ state: 'detached', timeout: 10_000 }).catch(async (error: unknown) => {
      const detail = await tapToStart
        .locator('.ios-tap-start-status')
        .textContent()
        .catch(() => null);
      throw new Error(`Tap to Start did not complete: ${detail ?? '(no gate error detail)'}`, { cause: error });
    });
  }
  if (!IOS_HOST_MODE) {
    // Local resources now require explicit selection; a fresh browser context has no IndexedDB import cache.
    await page.getByRole('button', { name: '开发测试', exact: true }).click();
    await chooseLocalGameIfPrompted(page, canvas, GAME_ID === 'ra2' ? 0 : 1);
  }

  const problem = page.locator('h3').filter({ hasText: /运行错误|接口待实现/ });
  await expectShellPage(page, 'mainmenu', 60_000);
  await waitForQuietFileReads(page, canvas);
  await waitForBinkOpen(page, 0, '首次主菜单');
  assert.equal(
    await page.locator('#vm-resolution').inputValue(),
    EXPECTED_SELECTOR_RESOLUTION,
    `${GAME_LABEL} 网页分辨率选择没有匹配启动前的保存设置`,
  );
  assert.equal(await page.getByText('客体状态', { exact: true }).count(), 0, '仍渲染无用的客体状态区块');
  await probeHostUi(page);
  const mainMenuProbe = await probeMainMenu(page, canvas);
  const presentationProbe = await page.evaluate(() => {
    const element = document.querySelector<HTMLCanvasElement>('#screen');
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    const gl = element.getContext('webgl2');
    return {
      guestResolution: element.dataset.vmResolution ?? null,
      effectiveIniResolution: element.dataset.vmIniResolution ?? null,
      renderer: element.dataset.vmRenderer ?? null,
      cssWidth: rect.width,
      cssHeight: rect.height,
      backingWidth: element.width,
      backingHeight: element.height,
      devicePixelRatio: window.devicePixelRatio,
      preserveDrawingBuffer: gl?.getContextAttributes()?.preserveDrawingBuffer ?? null,
      webglContextLost: gl?.isContextLost() ?? null,
      centerFramebufferRgba: (() => {
        if (!gl) return null;
        gl.finish();
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(element.width / 2),
          Math.floor(element.height / 2),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        return [...pixel];
      })(),
    };
  });
  assert.equal(
    presentationProbe?.guestResolution,
    EXPECTED_INITIAL_RESOLUTION,
    `${GAME_LABEL} effective guest resolution differs from the requested A/B value: ${JSON.stringify(presentationProbe)}`,
  );
  if (EXPECT_EFFECTIVE_INI_DIAGNOSTIC && INITIAL_RESOLUTION === 'none' && EXPECTED_INITIAL_RESOLUTION === '800x600') {
    assert.equal(
      presentationProbe?.effectiveIniResolution,
      EXPECTED_INITIAL_RESOLUTION,
      `${GAME_LABEL} effective RA2.INI did not reach the safe 800x600 fallback: ${JSON.stringify(presentationProbe)}`,
    );
  }
  console.log(`🔬 Guest/display A/B: ${JSON.stringify(presentationProbe)}`);
  assert(
    mainMenuProbe.uniqueFrames >= 5,
    `主菜单视频未连续播放：${MENU_FRAME_SAMPLES} 次采样只有 ${mainMenuProbe.uniqueFrames} 张不同画面，` +
      `VM帧=${mainMenuProbe.emittedFrames}，Bink=${await canvas.getAttribute('data-vm-bink-calls')}`,
  );
  assert(mainMenuProbe.emittedFrames >= 20, `主菜单实际输出帧过低：采样窗口只有 ${mainMenuProbe.emittedFrames} 帧`);
  if (mainMenuProbe.displayedFps > 0) {
    assert(mainMenuProbe.displayedFps >= 20, `主菜单显示帧率过低：${mainMenuProbe.displayedFps.toFixed(1)} fps`);
  }
  assert(
    mainMenuProbe.maxBatchCalls < 4_000,
    `Worker 调用批次过载：${mainMenuProbe.maxBatchCalls} calls/500ms，热点=${JSON.stringify(mainMenuProbe.maxBatchHot)}`,
  );
  assert(
    mainMenuProbe.maxReadFileCalls <= 100,
    `文件读取快速路径失效：ReadFile ${mainMenuProbe.maxReadFileCalls} calls/500ms`,
  );
  console.log(
    `🔬 主菜单视频：变化帧=${mainMenuProbe.uniqueFrames}/${MENU_FRAME_SAMPLES}，显示=${mainMenuProbe.displayedFps.toFixed(1)}fps，` +
      `VM帧=${mainMenuProbe.emittedFrames}，最大调用批次=${mainMenuProbe.maxBatchCalls}/500ms，` +
      `ReadFile=${mainMenuProbe.maxReadFileCalls}/500ms`,
  );
  if (process.env.RA2_BROWSER_CAPTURE_GUEST_FRAMES === '1') await captureGuestFrame(page, 'main-menu.png');
  if (LIFECYCLE_ONLY) {
    await runShortLifecycleMatrix(page, canvas);
    console.log('Short lifecycle A/B matrix completed without a page reload.');
    await browser.close();
    server?.kill('SIGTERM');
    process.exit(0);
  }
  if (PRESENTATION_ONLY) {
    console.log(`Presentation-only A/B complete; frameSample=${await canvas.getAttribute('data-vm-frame-sample')}`);
    await browser.close();
    server?.kill('SIGTERM');
    process.exit(0);
  }
  assert.equal(await problem.count(), 0, '主菜单出现运行错误');
  await page.waitForTimeout(750);
  await clickUntilShellPage(page, canvas, 'singleplayer', ...MAIN_SINGLE_PLAYER);
  await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', undefined, { timeout: 5_000 });
  await page.waitForTimeout(500);
  if (!CAMPAIGN_SELECTION_ONLY) {
    // Returning to the main menu reopens the same LANGUAGE.MIX video through BinkOpen; checking only the first screen is insufficient.
    // Do not use Esc to leave ordinary menus: RA2's legacy KillTimer/CallWindowProc chain can re-enter alongside
    // Pointer Lock release messages at that point. Clicking the game's own Back button is the stable native path.
    const mainMenuOpensBeforeReturn =
      callsOf(await canvas.getAttribute('data-vm-bink-calls'))['BINKW32.DLL!_BinkOpen@8'] ?? 0;
    await clickUntilShellPage(page, canvas, 'mainmenu', ...SINGLE_PLAYER_BACK);
    await waitForQuietFileReads(page, canvas);
    await waitForBinkOpen(page, mainMenuOpensBeforeReturn, '返回主菜单');
    let returnedMainMenuProbe = await probeMainMenu(page, canvas);
    // SetWindowText/MainMenu precedes full decoder recovery on return. If the first window still includes BinkOpen
    // initialization, wait one tick and remeasure steady state without lowering the performance threshold.
    if (returnedMainMenuProbe.emittedFrames < 20) {
      await page.waitForTimeout(1_000);
      returnedMainMenuProbe = await probeMainMenu(page, canvas);
    }
    assert(
      returnedMainMenuProbe.uniqueFrames >= 5,
      `返回主菜单后视频未继续播放：${MENU_FRAME_SAMPLES} 次采样只有 ${returnedMainMenuProbe.uniqueFrames} 张不同画面`,
    );
    assert(
      returnedMainMenuProbe.emittedFrames >= 20,
      `返回主菜单后实际输出帧过低：采样窗口只有 ${returnedMainMenuProbe.emittedFrames} 帧`,
    );
    if (returnedMainMenuProbe.displayedFps > 0) {
      assert(
        returnedMainMenuProbe.displayedFps >= 20,
        `返回主菜单后显示帧率过低：${returnedMainMenuProbe.displayedFps.toFixed(1)} fps`,
      );
    }
    console.log(
      `🔬 返回主菜单视频：变化帧=${returnedMainMenuProbe.uniqueFrames}/${MENU_FRAME_SAMPLES}，` +
        `显示=${returnedMainMenuProbe.displayedFps.toFixed(1)}fps，VM帧=${returnedMainMenuProbe.emittedFrames}`,
    );

    const binkCalls = JSON.parse((await canvas.getAttribute('data-vm-bink-calls')) ?? '{}') as Record<string, number>;
    assert(
      (binkCalls['BINKW32.DLL!_BinkOpen@8'] ?? 0) >= 2,
      `${GAME_LABEL} 返回主菜单后没有再次执行 BinkOpen：${JSON.stringify(binkCalls)}`,
    );
    assert(
      (binkCalls['BINKW32.DLL!_BinkClose@4'] ?? 0) >= 1,
      `${GAME_LABEL} 切页没有完成 BinkClose：${JSON.stringify(binkCalls)}`,
    );
    assert.equal(
      binkCalls['BINKW32.DLL!_BinkCopyToBuffer@28'] ?? 0,
      0,
      `${GAME_LABEL} BinkCopyToBuffer 仍在走不安全的串口 hypercall 边界`,
    );
  }

  if (!CAMPAIGN_SELECTION_ONLY) await clickUntilShellPage(page, canvas, 'singleplayer', ...MAIN_SINGLE_PLAYER);
  await page.waitForTimeout(1_000);
  const campaignHoverPlayBefore =
    callsOf(await canvas.getAttribute('data-vm-audio-calls'))['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0;
  await clickUntilShellPage(page, canvas, 'campaign', ...SINGLE_PLAYER_CAMPAIGN);
  await page.waitForTimeout(1_000);
  if (process.env.RA2_BROWSER_CAPTURE_GUEST_FRAMES === '1') await captureGuestFrame(page, 'campaign-selection.png');
  if (CAMPAIGN_SELECTION_ONLY) {
    if (CAMPAIGN_CHOICE === 'allied' || CAMPAIGN_CHOICE === 'soviet') {
      const [x, y] = CAMPAIGN_CHOICE === 'allied' ? [310, 90] : [315, 375];
      const [width, height] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600').split('x').map(Number);
      await clickGuest(page, canvas, Math.round((x * width!) / 800), Math.round((y * height!) / 600));
      await page.waitForTimeout(Number(process.env.RA2_BROWSER_CAMPAIGN_ENTRY_WAIT_MS ?? 2_000));
      if (process.env.RA2_BROWSER_CAPTURE_GUEST_FRAMES === '1') {
        await captureGuestFrame(page, `${CAMPAIGN_CHOICE}-entry.png`);
      }
      console.log(
        `Campaign ${CAMPAIGN_CHOICE} entry probe; shell=${await canvas.getAttribute('data-shell-page')}; ` +
          `movie=${await canvas.getAttribute('data-movie-playback-state')}; ` +
          `battlefield=${await canvas.getAttribute('data-vm-battlefield')}; frame=${await canvas.getAttribute('data-vm-frame')}; ` +
          `status=${await canvas.getAttribute('data-vm-status')}; bink=${await canvas.getAttribute('data-vm-bink-calls')}`,
      );
    }
    console.log(
      `Campaign-selection-only A/B complete; frameSample=${await canvas.getAttribute('data-vm-frame-sample')}`,
    );
    await browser.close();
    server?.kill('SIGTERM');
    process.exit(0);
  }
  await probeCampaignHover(page, canvas, campaignHoverPlayBefore);
  const campaignVideoBinkBefore = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const campaignVideoOpensBefore = campaignVideoBinkBefore['BINKW32.DLL!_BinkOpen@8'] ?? 0;
  const campaignVideoClosesBefore = campaignVideoBinkBefore['BINKW32.DLL!_BinkClose@4'] ?? 0;
  const campaignVideoAudioBefore = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  // Leaving the shell means entering the campaign briefing, not necessarily the battlefield. Wait for both the sidebar and
  // map to render before checking Pointer Lock. Click only once per round, then wait for the original game to finish
  // synchronously destroying CampaignMenu. Do not add a click before the retry loop, which turns a normal click into
  // an artificial double-click and enters the reentrant region between old-window destruction and new-window creation.
  const alliedOffsets = [
    [0, 0],
    [-20, 0],
    [20, 0],
    [0, -10],
    [0, 10],
  ] as const;
  const faction = CAMPAIGN_CHOICE === 'soviet' ? 'soviet' : 'allied';
  const [factionX, factionY] = faction === 'allied' ? [310, 90] : [315, 375];
  const [guestWidth, guestHeight] = ((await canvas.getAttribute('data-vm-resolution')) ?? '800x600')
    .split('x')
    .map(Number);
  for (const [offsetX, offsetY] of alliedOffsets) {
    if (!(await canvas.getAttribute('data-shell-page'))) break;
    await clickGuest(
      page,
      canvas,
      Math.round(((factionX + offsetX) * guestWidth!) / 800),
      Math.round(((factionY + offsetY) * guestHeight!) / 600),
    );
    try {
      await page.waitForFunction(
        () => !document.querySelector<HTMLCanvasElement>('#screen')?.dataset.shellPage,
        undefined,
        { timeout: 4_000 },
      );
      break;
    } catch {
      const rawStatus = await canvas.getAttribute('data-vm-status');
      if (rawStatus) {
        const status = JSON.parse(rawStatus) as { phase: string; detail: string };
        if (status.phase === 'error' || status.phase === 'blocked') {
          throw new Error(`选择阵营中断：${status.phase}：${status.detail}`);
        }
      }
      // Retry clicks swallowed by CampaignMenu repainting only while a shell title remains.
    }
  }
  assert.equal(await canvas.getAttribute('data-shell-page'), null, '选择盟军后仍停在 CampaignMenu');
  await probeCampaignVideo(
    page,
    canvas,
    campaignVideoOpensBefore,
    campaignVideoClosesBefore,
    campaignVideoAudioBefore,
    campaignVideoBinkBefore,
  );
  const battlefieldVideoBinkBefore = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const battlefieldVideoAudioBefore = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const battlefieldAudioSnapshotBefore = await readAudioProgress(page);
  // YR keeps the shell/campaign briefing at 800x600 and reads RA2MD.INI to switch to the selected mode only on
  // entering the actual battlefield. Wait for the resolution change to avoid treating the briefing as a playable battlefield.
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmResolution === expected,
    EXPECTED_INITIAL_RESOLUTION,
    { timeout: 70_000 },
  );
  const playable = await waitForPlayableBattle(page, canvas, 70_000);
  console.log(
    `🔬 可操作战场：等待=${(playable.elapsedMs / 1_000).toFixed(1)}s，` +
      `右栏=${playable.signal.rightEdgeRatio.toFixed(3)}，地图=${playable.signal.fieldRatio.toFixed(3)}`,
  );
  // The battlefield's top-right EVA/briefing window is a separate Bink instance; fullscreen cutscene audio assertions
  // cannot cover it. Observe its Close and DirectSound stream. It may Open before the battlefield is deemed
  // playable, so use the playback-ending Close increment as a stable lifecycle gate.
  const battlefieldAudioSamples: Array<AudioProgressProbe | null> = [];
  for (let sample = 0; sample < 32; sample++) {
    battlefieldAudioSamples.push(await readAudioProgress(page));
    await page.waitForTimeout(250);
  }
  const battlefieldVideoBinkAfter = callsOf(await canvas.getAttribute('data-vm-bink-calls'));
  const battlefieldVideoAudioAfter = callsOf(await canvas.getAttribute('data-vm-audio-calls'));
  const validAudioSamples = battlefieldAudioSamples.filter((sample): sample is AudioProgressProbe => sample !== null);
  const audioWindowStart = validAudioSamples[0];
  const audioWindowEnd = validAudioSamples.at(-1);
  const audioClockDeltaSeconds =
    audioWindowStart?.contextTimeSeconds !== null &&
    audioWindowStart?.contextTimeSeconds !== undefined &&
    audioWindowEnd?.contextTimeSeconds !== null &&
    audioWindowEnd?.contextTimeSeconds !== undefined
      ? audioWindowEnd.contextTimeSeconds - audioWindowStart.contextTimeSeconds
      : 0;
  const baselineBufferIds = new Set((battlefieldAudioSnapshotBefore?.buffers ?? []).map((buffer) => buffer.id));
  const battlefieldBufferIds = new Set(
    validAudioSamples.flatMap((sample) =>
      sample.buffers.filter((buffer) => !baselineBufferIds.has(buffer.id)).map((buffer) => buffer.id),
    ),
  );
  const advancingBattlefieldBuffers = [...battlefieldBufferIds].filter((id) => {
    const positions = validAudioSamples.flatMap((sample) =>
      sample.buffers.filter((buffer) => buffer.id === id && buffer.playing).map((buffer) => buffer.positionBytes),
    );
    return new Set(positions).size >= 4;
  });
  const activeBattlefieldBuffers = [...battlefieldBufferIds].flatMap(
    (id) => validAudioSamples.at(-1)?.buffers.filter((buffer) => buffer.id === id && buffer.playing) ?? [],
  );
  const battlefieldFormats = [
    ...new Map(
      activeBattlefieldBuffers.map((buffer) => [
        `${buffer.sampleRate}/${buffer.channels}/${buffer.bitsPerSample}/${buffer.frequency}`,
        `${buffer.sampleRate}Hz ${buffer.channels}ch ${buffer.bitsPerSample}bit @${buffer.frequency}Hz`,
      ]),
    ).values(),
  ];
  const activeStreamBackends = activeBattlefieldBuffers.filter(
    (buffer) => buffer.worklet || buffer.scriptStream,
  ).length;
  const firstBufferById = new Map((audioWindowStart?.buffers ?? []).map((buffer) => [buffer.id, buffer]));
  const finalBufferById = new Map((audioWindowEnd?.buffers ?? []).map((buffer) => [buffer.id, buffer]));
  const newBufferWriteDelta = [...battlefieldBufferIds].reduce((sum, id) => {
    const first = firstBufferById.get(id);
    const last = finalBufferById.get(id);
    return sum + Math.max(0, (last?.writeCount ?? 0) - (first?.writeCount ?? 0));
  }, 0);
  const newBufferFrequencyChanges = [...battlefieldBufferIds].reduce((sum, id) => {
    const first = firstBufferById.get(id);
    const last = finalBufferById.get(id);
    return sum + Math.max(0, (last?.frequencyChangeCount ?? 0) - (first?.frequencyChangeCount ?? 0));
  }, 0);
  const activeFrequencyValues = validAudioSamples.flatMap((sample) =>
    sample.buffers
      .filter((buffer) => battlefieldBufferIds.has(buffer.id) && buffer.playing)
      .map((buffer) => buffer.frequency),
  );
  const maxActiveWriteAgeMs = Math.max(0, ...activeBattlefieldBuffers.map((buffer) => buffer.writeAgeMs ?? 0));
  const singleBackendPerBuffer = activeBattlefieldBuffers.every(
    (buffer) => Number(buffer.worklet) + Number(buffer.scriptStream) + Number(buffer.source) <= 1,
  );
  const baselineCreateCount = battlefieldAudioSnapshotBefore?.bufferCreateCount ?? 0;
  const finalCreateCount = audioWindowEnd?.bufferCreateCount ?? baselineCreateCount;
  const baselineWorkletStarts = battlefieldAudioSnapshotBefore?.workletStartCount ?? 0;
  const finalWorkletStarts = audioWindowEnd?.workletStartCount ?? baselineWorkletStarts;
  const setFrequencyCallsDelta =
    (battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.SetFrequency'] ?? 0) -
    (battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.SetFrequency'] ?? 0);
  // This corner presentation is a known non-blocking residual. It may remain open beyond this probe window;
  // M1 requires the original campaign briefing and usable audio, both checked independently above/below.
  assert(
    (battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0) >
      (battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0),
    `${GAME_LABEL} 战场右上角过场期间 DirectSound PCM 没有持续写入`,
  );
  assert.equal(audioWindowEnd?.contextState, 'running', '战场通讯视频播放时 AudioContext 未运行');
  assert(audioClockDeltaSeconds >= 5.5, `战场通讯视频探针窗口音频时钟只前进 ${audioClockDeltaSeconds.toFixed(2)}s`);
  assert(finalCreateCount > baselineCreateCount, '战场通讯视频未创建 DirectSound PCM buffer');
  assert(battlefieldBufferIds.size > 0, '战场通讯视频窗口没有新建 WebAudio PCM buffer');
  assert(advancingBattlefieldBuffers.length > 0, '战场通讯视频新增 PCM buffer 游标没有推进');
  assert(activeStreamBackends > 0, '战场通讯视频没有活动的 WebAudio PCM stream/worklet');
  assert(singleBackendPerBuffer, '同一个战场通讯 PCM buffer 同时连接多个播放后端');
  assert(
    activeBattlefieldBuffers.every(
      (buffer) =>
        buffer.sampleRate > 0 &&
        buffer.frequency > 0 &&
        (buffer.channels === 1 || buffer.channels === 2) &&
        [8, 16, 24, 32].includes(buffer.bitsPerSample) &&
        buffer.blockAlign === (buffer.bitsPerSample / 8) * buffer.channels,
    ),
    '战场通讯视频 PCM format/frequency 无效',
  );
  assert(
    (audioWindowEnd?.bufferDuplicateCount ?? 0) <=
      (battlefieldAudioSnapshotBefore?.bufferDuplicateCount ?? 0) + Math.max(1, battlefieldBufferIds.size),
    '战场通讯视频 DirectSound buffer duplicate creation exceeded its new-buffer count',
  );
  console.log(
    `🔬 战场右上角过场：BinkOpen=${battlefieldVideoBinkBefore['BINKW32.DLL!_BinkOpen@8'] ?? 0}` +
      `→${battlefieldVideoBinkAfter['BINKW32.DLL!_BinkOpen@8'] ?? 0}，` +
      `BinkClose=${battlefieldVideoBinkBefore['BINKW32.DLL!_BinkClose@4'] ?? 0}` +
      `→${battlefieldVideoBinkAfter['BINKW32.DLL!_BinkClose@4'] ?? 0}（不作通过门槛），` +
      `buffer=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSound.CreateSoundBuffer'] ?? 0}，` +
      `Play=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Play'] ?? 0}，` +
      `Lock=${battlefieldVideoAudioBefore['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0}` +
      `→${battlefieldVideoAudioAfter['DSOUND.COM!IDirectSoundBuffer.Lock'] ?? 0}，` +
      `AudioContext=${audioWindowEnd?.contextState ?? 'unavailable'} Δt=${audioClockDeltaSeconds.toFixed(2)}s，` +
      `PCM buffer=${battlefieldBufferIds.size} active=${activeBattlefieldBuffers.length} cursor=${advancingBattlefieldBuffers.length}，` +
      `format=${battlefieldFormats.join(',') || 'none'} frequency=${activeFrequencyValues.length ? `${Math.min(...activeFrequencyValues)}-${Math.max(...activeFrequencyValues)}Hz` : 'none'}，` +
      `stream/worklet=${activeStreamBackends} write=${newBufferWriteDelta}/${audioClockDeltaSeconds.toFixed(2)}s ` +
      `staleWriteMax=${maxActiveWriteAgeMs.toFixed(0)}ms freqChanges=${newBufferFrequencyChanges}，` +
      `sourceStarts=${audioWindowEnd?.sourceStartCount ?? 0} streamStarts=${audioWindowEnd?.streamStartCount ?? 0} ` +
      `workletStarts=${finalWorkletStarts - baselineWorkletStarts} ` +
      `SetFrequencyΔ=${setFrequencyCallsDelta} duplicateΔ=${(audioWindowEnd?.bufferDuplicateCount ?? 0) - (battlefieldAudioSnapshotBefore?.bufferDuplicateCount ?? 0)}`,
  );
  const battleFrame = Number((await canvas.getAttribute('data-vm-frame')) ?? 0);
  const battleResolution = (await canvas.getAttribute('data-vm-resolution')) ?? '800x600';
  const [battleWidth, battleHeight] = battleResolution.split('x').map(Number);
  assert(
    Number.isFinite(battleWidth) && Number.isFinite(battleHeight),
    `${GAME_LABEL} 战场分辨率探针无效：${battleResolution}`,
  );
  assert.equal(
    battleResolution,
    EXPECTED_INITIAL_RESOLUTION,
    `${GAME_LABEL} 战场分辨率未采用有效 RA2.INI / 800x600 安全默认：${battleResolution}`,
  );
  const expectedPointer = `${battleWidth! - 1},${battleHeight! - 1}/${battleResolution}`;

  // Headless Chromium does not generate relative movementX/Y for subsequent CDP-injected mouse.move calls,
  // so inject relative counts with a PointerEvent probe only after real document.pointerLockElement is established.
  // This covers page conversion -> Worker -> USER32 without mistaking automation limitations for product regressions.
  const battleBox = await canvas.boundingBox();
  if (!battleBox) throw new Error('战场 canvas 不可见');
  if (!(await page.evaluate(() => document.pointerLockElement?.id === 'screen'))) {
    await page.mouse.click(battleBox.x + 4, battleBox.y + 4);
    await page.waitForFunction(() => document.pointerLockElement?.id === 'screen', undefined, { timeout: 5_000 });
  }
  assert.equal(
    await page.evaluate(() => document.pointerLockElement?.id),
    'screen',
    `${GAME_LABEL} 浏览器没有真实进入 Pointer Lock`,
  );
  await moveLockedGuest(
    page,
    canvas,
    battleWidth! - 1,
    battleHeight! - 1,
    battleWidth!,
    battleHeight!,
    battleBox.width,
    battleBox.height,
  );
  // CSS-to-logical scaling is fractional; flooring the first event can leave the cursor one pixel short of the edge.
  // A real mouse continues producing counts toward the edge. Add a positive sweep spanning the whole canvas and
  // require exact boundary clamping: neither retain the old resolution nor allow excess relative movement outside bounds.
  await page.waitForTimeout(100);
  await canvas.dispatchEvent('pointermove', {
    pointerType: 'mouse',
    isPrimary: true,
    pointerId: 1,
    movementX: battleBox.width,
    movementY: battleBox.height,
  });
  await page.waitForTimeout(500);
  assert.equal(
    await canvas.getAttribute('data-vm-cursor'),
    expectedPointer,
    `Pointer Lock 前端未采用战场 ${battleResolution} 边界`,
  );
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmWorkerCursor === expected,
    expectedPointer,
    { timeout: 5_000 },
  );
  assert.equal(
    await canvas.getAttribute('data-vm-worker-client'),
    battleResolution,
    `客体 GetClientRect 仍未采用战场 ${battleResolution} 边界`,
  );
  // The toolbar no longer has the old data-game-speed buttons. Observe edge scrolling at native speed,
  // without waiting for nonexistent UI or changing guest speed fields to manufacture performance gains.
  // Cover the previously delayed PIT/thread-context corruption after returning from Bink.
  await page.waitForTimeout(10_000);
  assert(Number((await canvas.getAttribute('data-vm-frame')) ?? 0) > battleFrame, '战场画面停止更新');
  assert.equal(
    await canvas.getAttribute('data-vm-cursor'),
    expectedPointer,
    '战场运行 10 秒后前端鼠标边界退回旧分辨率',
  );
  assert.equal(
    await canvas.getAttribute('data-vm-worker-cursor'),
    expectedPointer,
    '战场运行 10 秒后 Worker 鼠标边界退回旧分辨率',
  );
  assert.equal(await problem.count(), 0, '战场出现运行错误');
  assert.deepEqual(pageErrors, [], `浏览器页面异常：${pageErrors.join('\n')}`);
  const finalFrontPointer = await canvas.getAttribute('data-vm-cursor');
  const finalWorkerPointer = await canvas.getAttribute('data-vm-worker-cursor');
  const textOutCalls = Number((await canvas.getAttribute('data-vm-text-out-calls')) ?? 0);

  if (!IOS_HOST_MODE) {
    // The native select is now hidden; a custom listbox triggers change. Use real visible options to cover safe
    // VM disposal -> reload -> preference restoration, without waiting for the hidden select to become actionable.
    await page.evaluate(() => document.exitPointerLock());
    await page.waitForFunction(() => document.pointerLockElement === null, undefined, { timeout: 5_000 });
    await page.keyboard.press('Escape');
    await page.waitForFunction(
      () => document.querySelector<HTMLCanvasElement>('#screen')?.dataset.vmWorkerKey === '0x101:27',
      undefined,
      { timeout: 5_000 },
    );
    await page.locator('#vm-resolution-toggle').click();
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
      page.locator('#vm-resolution-options').getByRole('option', { name: '1024×768', exact: true }).click(),
    ]);
    // The development directory is not a player archive cache; explicitly select development resources again after reload.
    await page.getByRole('button', { name: '开发测试', exact: true }).click();
    await chooseLocalGameIfPrompted(page, canvas, GAME_ID === 'ra2' ? 0 : 1);
    await expectShellPage(page, 'mainmenu', 60_000);
    assert.equal(
      await page.locator('#vm-resolution').inputValue(),
      '1024x768',
      `${GAME_LABEL} 重启后没有恢复新选择的分辨率`,
    );
    assert.equal(
      await page.evaluate((gameId) => localStorage.getItem(`vm-resolution-${gameId}`), GAME_ID),
      '1024x768',
      `${GAME_LABEL} 分辨率没有按游戏持久化`,
    );
  }
  assert.deepEqual(pageErrors, [], `分辨率重启后浏览器页面异常：${pageErrors.join('\n')}`);
  console.log(
    `✅ ${GAME_LABEL} Chromium Worker：主菜单视频连续播放，战役流程持续运行，` +
      `Pointer Lock 前端=${finalFrontPointer}，Worker=${finalWorkerPointer}；` +
      `禁用宿主字体时 TextOutA 调用=${textOutCalls}；` +
      IOS_HOST_MODE
      ? `iOS host mission run preserved 800x600 guest`
      : `控制栏切换 1024×768 后已安全重启并恢复偏好`,
  );
} finally {
  await browser.close();
  server?.kill('SIGTERM');
}
