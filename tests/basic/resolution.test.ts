import { describe, expect, it } from 'vitest';
import { MemoryGameFileProvider } from '../../src/resources/providers/memory';
import { type GameSource } from '../../src/games/source';
import { supportedGame } from '../../src/games/catalog';
import {
  GAME_RESOLUTIONS,
  gameResolutionIni,
  parseGameResolution,
  patchGameResolutionIni,
  withGameResolutionOverride,
} from '../../src/games/resolution';
import { initialGameResolution } from '../../src/ui/pages/game/vmPageResolution';

const encode = (text: string): Uint8Array => Uint8Array.from(text, (character) => character.charCodeAt(0));
const decode = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

describe('RA2/YR 分辨率 INI 内存覆盖', () => {
  it('iOS 和桌面都不隐式选择客体分辨率，显式保存值优先', () => {
    expect(initialGameResolution(null, true)).toBeNull();
    expect(initialGameResolution({ width: 1600, height: 900 }, true)).toEqual({ width: 1600, height: 900 });
    expect(initialGameResolution(null, false)).toBeNull();
    expect(initialGameResolution({ width: 800, height: 600 }, true)).toEqual({ width: 800, height: 600 });
  });

  it('保留有效 RA2.INI，并将 800×600、1280×720 和 1920×1080 保持为可选模式', () => {
    const ini = encode('[Video]\nAllowHiResModes=yes\nScreenWidth=1024\nScreenHeight=768\n');
    expect(parseGameResolution('800x600')).toEqual({ width: 800, height: 600 });
    expect(parseGameResolution('1280x720')).toEqual({ width: 1280, height: 720 });
    expect(parseGameResolution('1920x1080')).toEqual({ width: 1920, height: 1080 });
    expect(GAME_RESOLUTIONS).toContainEqual({ width: 800, height: 600 });
    expect(GAME_RESOLUTIONS).toContainEqual({ width: 1280, height: 720 });
    expect(GAME_RESOLUTIONS).toContainEqual({ width: 1920, height: 1080 });
    expect(decode(patchGameResolutionIni(ini, { width: 800, height: 600 }))).toContain('ScreenWidth=800');
    expect(decode(patchGameResolutionIni(ini, { width: 1280, height: 720 }))).toContain('ScreenWidth=1280');
    expect(decode(patchGameResolutionIni(ini, { width: 1920, height: 1080 }))).toContain('ScreenWidth=1920');
  });

  it('只修改 [Video] 的三个键并保留 CRLF 与其他 section', () => {
    const original = encode(
      '[Options]\r\nScreenWidth=123\r\n\r\n[Video]\r\nVideoBackBuffer=no\r\n' +
        'AllowHiResModes=no\r\nScreenWidth=800\r\nScreenHeight=600\r\n\r\n[Audio]\r\nSoundVolume=1\r\n',
    );
    const patched = decode(patchGameResolutionIni(original, { width: 1440, height: 900 }));
    expect(patched).toContain('[Options]\r\nScreenWidth=123');
    expect(patched).toContain(
      '[Video]\r\nVideoBackBuffer=no\r\nAllowHiResModes=yes\r\n' + 'ScreenWidth=1440\r\nScreenHeight=900',
    );
    expect(patched).toContain('[Audio]\r\nSoundVolume=1\r\n');
    expect(patched.replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('缺少 [Video] 或键时补齐，并严格限制为预设值', () => {
    const patched = decode(
      patchGameResolutionIni(encode('[Options]\nGameSpeed=1'), {
        width: 1920,
        height: 1080,
      }),
    );
    expect(patched).toBe('[Options]\nGameSpeed=1\n\n[Video]\nAllowHiResModes=yes\nScreenWidth=1920\nScreenHeight=1080');
    expect(parseGameResolution('1440x900')).toEqual({ width: 1440, height: 900 });
    expect(parseGameResolution('1366x768')).toBeNull();
    expect(parseGameResolution('99999x1')).toBeNull();
  });

  it('RA2/YR 使用各自 INI，覆盖层可读但不会写回父 provider', async () => {
    for (const gameId of ['ra2', 'yr'] as const) {
      const ini = gameResolutionIni(gameId);
      const files = new MemoryGameFileProvider(
        new Map([[ini, encode('[Video]\nScreenWidth=800\nScreenHeight=600\n')]]),
      );
      const source: GameSource = { game: supportedGame(gameId), files, executableBytes: new Uint8Array([1]) };
      const overlaid = await withGameResolutionOverride(source, { width: 1600, height: 900 });
      expect(decode((await overlaid.files.read(ini))!)).toContain('ScreenWidth=1600\nScreenHeight=900');
      await overlaid.files.write(ini, encode('[Video]\nScreenWidth=1024\nScreenHeight=768\n'));
      expect(decode((await files.read(ini))!)).toContain('ScreenWidth=800\nScreenHeight=600');
      await overlaid.files.write('Save/slot.sav', new Uint8Array([7]));
      expect(await files.read('Save/slot.sav')).toEqual(new Uint8Array([7]));
    }
  });

  it('未设置分辨率时：无可用 INI 模式回退到 800×600，有效现有 INI 原样保留', async () => {
    for (const gameId of ['ra2', 'yr'] as const) {
      const ini = gameResolutionIni(gameId);
      const missingFiles = new MemoryGameFileProvider();
      const missingSource: GameSource = {
        game: supportedGame(gameId),
        files: missingFiles,
        executableBytes: new Uint8Array([1]),
      };
      // The online package lacks ra2.ini: provide well-formed defaults (missing/empty INI makes the game
      // fall back to a frozen 640x400 intro). Writes are shadowed and do not reach the provider.
      const overlaid = await withGameResolutionOverride(missingSource, null);
      expect(decode((await overlaid.files.read(ini))!)).toBe(
        '[Video]\nAllowHiResModes=yes\nScreenWidth=800\nScreenHeight=600\n',
      );
      await overlaid.files.write(ini, encode('[Video]\nScreenWidth=1024\n'));
      expect(await missingFiles.read(ini)).toBeNull();

      const existingBytes = encode('[Video]\nScreenWidth=1024\nScreenHeight=768\n[Audio]\nSoundVolume=1\n');
      const existingFiles = new MemoryGameFileProvider(new Map([[ini, existingBytes]]));
      const existingSource: GameSource = { ...missingSource, files: existingFiles };
      expect(await withGameResolutionOverride(existingSource, null)).toBe(existingSource);
      const nonPresetIni = encode('[Video]\nScreenWidth=1366\nScreenHeight=768\n');
      const nonPresetSource: GameSource = {
        ...missingSource,
        files: new MemoryGameFileProvider(new Map([[ini, nonPresetIni]])),
      };
      expect(await withGameResolutionOverride(nonPresetSource, null)).toBe(nonPresetSource);
      const incompleteSource: GameSource = {
        ...missingSource,
        files: new MemoryGameFileProvider(new Map([[ini, encode('[Video]\n')]])),
      };
      const fallback = await withGameResolutionOverride(incompleteSource, null);
      expect(decode((await fallback.files.read(ini))!)).toBe(
        '[Video]\nAllowHiResModes=yes\nScreenWidth=800\nScreenHeight=600\n',
      );
      const invalidSource: GameSource = {
        ...missingSource,
        files: new MemoryGameFileProvider(new Map([[ini, encode('[Video]\nScreenWidth=99999\nScreenHeight=1\n')]])),
      };
      const invalidFallback = await withGameResolutionOverride(invalidSource, null);
      expect(decode((await invalidFallback.files.read(ini))!)).toContain('ScreenWidth=800\nScreenHeight=600');
    }
  });

  it('空原稿生成格式规范的 INI：首行即段名、行尾换行', () => {
    const patched = decode(patchGameResolutionIni(new Uint8Array(), { width: 1024, height: 768 }));
    expect(patched).toBe('[Video]\nAllowHiResModes=yes\nScreenWidth=1024\nScreenHeight=768\n');
    expect(patched.startsWith('[')).toBe(true);
    expect(patched.endsWith('\n')).toBe(true);
  });
});
