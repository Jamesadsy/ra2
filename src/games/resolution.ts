import { OverlayGameFileProvider } from '../resources/providers/overlay';
import { type GameSource } from './source';
import type { SupportedGameId } from './catalog';

export interface GameResolution {
  width: number;
  height: number;
}

export const GAME_RESOLUTIONS: readonly GameResolution[] = [
  { width: 800, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 720 },
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
  { width: 1600, height: 900 },
  { width: 1920, height: 1080 },
];

export function gameResolutionValue(resolution: GameResolution): string {
  return `${resolution.width}x${resolution.height}`;
}

export function parseGameResolution(value: string | null): GameResolution | null {
  if (!value) return null;
  return GAME_RESOLUTIONS.find((resolution) => gameResolutionValue(resolution) === value) ?? null;
}

export function gameResolutionIni(gameId: SupportedGameId): string {
  return gameId === 'yr' ? 'RA2MD.INI' : 'RA2.INI';
}

const bytesToLatin1 = (bytes: Uint8Array): string => {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 0x4000) {
    text += String.fromCharCode(...bytes.subarray(offset, offset + 0x4000));
  }
  return text;
};

const latin1ToBytes = (text: string): Uint8Array => {
  const bytes = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index++) bytes[index] = text.charCodeAt(index) & 0xff;
  return bytes;
};

/** Preserve the original INI byte encoding and other settings; override only resolution keys in [Video]. */
export function patchGameResolutionIni(bytes: Uint8Array, resolution: GameResolution): Uint8Array {
  const text = bytesToLatin1(bytes);
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  if (!text.trim()) {
    // If no source INI exists in the online package, generate properly formatted configuration. Leading blank lines or
    // missing trailing newlines make the native INI parser skip [Video], observed to fall back to a 640x400 intro
    // and hang because the transition path cannot exit with a zero-byte movies01.mix.
    return latin1ToBytes(
      `[Video]${newline}AllowHiResModes=yes${newline}` +
        `ScreenWidth=${resolution.width}${newline}ScreenHeight=${resolution.height}${newline}`,
    );
  }
  const trailingNewline = /(?:\r\n|\n|\r)$/.test(text);
  const lines = text.split(/\r\n|\n|\r/);
  if (trailingNewline) lines.pop();

  let videoStart = lines.findIndex((line) => /^\s*\[video\]\s*$/i.test(line));
  if (videoStart < 0) {
    if (lines.length && lines.at(-1)?.trim()) lines.push('');
    videoStart = lines.length;
    lines.push('[Video]');
  }
  let videoEnd = lines.findIndex((line, index) => index > videoStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  if (videoEnd < 0) videoEnd = lines.length;

  const values: Readonly<Record<string, string>> = {
    allowhiresmodes: 'yes',
    screenwidth: String(resolution.width),
    screenheight: String(resolution.height),
  };
  for (const [normalizedKey, value] of Object.entries(values)) {
    const lineIndex = lines.findIndex((line, index) => {
      if (index <= videoStart || index >= videoEnd) return false;
      const match = line.match(/^\s*([^=;#]+?)\s*=/);
      return match?.[1]?.trim().toLowerCase() === normalizedKey;
    });
    const canonicalKey =
      normalizedKey === 'allowhiresmodes'
        ? 'AllowHiResModes'
        : normalizedKey === 'screenwidth'
          ? 'ScreenWidth'
          : 'ScreenHeight';
    if (lineIndex >= 0) lines[lineIndex] = `${canonicalKey}=${value}`;
    else {
      lines.splice(videoEnd, 0, `${canonicalKey}=${value}`);
      videoEnd++;
    }
  }
  return latin1ToBytes(lines.join(newline) + (trailingNewline ? newline : ''));
}

/** Read the selected standard guest mode without returning other user INI settings. */
export function gameResolutionFromIni(bytes: Uint8Array): GameResolution | null {
  const lines = bytesToLatin1(bytes).split(/\r\n|\n|\r/);
  const videoStart = lines.findIndex((line) => /^\s*\[video\]\s*$/i.test(line));
  if (videoStart < 0) return null;
  const videoEnd = lines.findIndex((line, index) => index > videoStart && /^\s*\[[^\]]+\]\s*$/.test(line));
  let width: string | null = null;
  let height: string | null = null;
  for (const line of lines.slice(videoStart + 1, videoEnd < 0 ? undefined : videoEnd)) {
    const match = line.match(/^\s*([^=;#]+?)\s*=\s*([^;#]*?)\s*$/);
    if (!match) continue;
    const key = match[1]!.trim().toLowerCase();
    if (key === 'screenwidth') width = match[2]!.trim();
    else if (key === 'screenheight') height = match[2]!.trim();
  }
  if (!width || !height || !/^\d+$/.test(width) || !/^\d+$/.test(height)) return null;
  const parsedWidth = Number(width);
  const parsedHeight = Number(height);
  // Existing user INIs may contain valid display modes outside the selector's curated choices. Keep those modes
  // intact as long as they are plausible guest dimensions; explicit UI selections remain restricted to GAME_RESOLUTIONS.
  if (
    !Number.isSafeInteger(parsedWidth) ||
    !Number.isSafeInteger(parsedHeight) ||
    parsedWidth < 320 ||
    parsedHeight < 200 ||
    parsedWidth > 8192 ||
    parsedHeight > 8192
  ) {
    return null;
  }
  return { width: parsedWidth, height: parsedHeight };
}

/** Return whether an existing INI has a plausible complete guest mode. */
function hasUsableGameResolutionIni(bytes: Uint8Array): boolean {
  return gameResolutionFromIni(bytes) !== null;
}

/** Default menu resolution when an online package has no INI: the standard RA2 menu setting. */
const FALLBACK_RESOLUTION: GameResolution = { width: 800, height: 600 };

/** Read the INI actually used by the game, then overlay a read-only memory layer; if unreadable, provide an openable empty configuration. */
export async function withGameResolutionOverride(
  source: GameSource,
  resolution: GameResolution | null | undefined,
): Promise<GameSource> {
  const iniPath = gameResolutionIni(source.game.id);
  const original = await source.files.read(iniPath);
  // Preserve a usable player setting unchanged. An absent, empty, malformed, or incomplete Video mode uses the
  // established 800x600 guest fallback so the game cannot silently choose an unsafe display mode.
  if (!resolution && original !== null && hasUsableGameResolutionIni(original)) return source;
  const applied = resolution ?? FALLBACK_RESOLUTION;
  const patched = patchGameResolutionIni(original ?? new Uint8Array(), applied);
  return {
    ...source,
    files: new OverlayGameFileProvider(
      source.files,
      new Map([[iniPath, patched]]),
      resolution ? `（内存分辨率 ${applied.width}×${applied.height}）` : '（内存默认配置）',
      true,
    ),
  };
}
