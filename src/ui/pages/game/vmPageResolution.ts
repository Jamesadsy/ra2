/**
 * Local game-resolution preference persistence, extracted from page.ts.
 * Reuse storage keys/parsing from games/resolution, shared by page and toolbar actions.
 */
import { gameResolutionValue, parseGameResolution, type GameResolution } from '../../../games/resolution';
import type { SupportedGameId } from '../../../games/catalog';

const STORED_RESOLUTION_PREFIX = 'vm-resolution-';
export const IOS_DEFAULT_GAME_RESOLUTION: GameResolution = { width: 1280, height: 720 };

/** Prefer the saved choice, otherwise use a balanced 720p 16:9 iPhone profile and retain legacy desktop behavior. */
export function initialGameResolution(stored: GameResolution | null, iosHost: boolean): GameResolution | null {
  return stored ?? (iosHost ? IOS_DEFAULT_GAME_RESOLUTION : null);
}

export function loadStoredResolution(gameId: SupportedGameId): GameResolution | null {
  try {
    return parseGameResolution(window.localStorage.getItem(`${STORED_RESOLUTION_PREFIX}${gameId}`));
  } catch {
    return null;
  }
}

export function storeResolution(gameId: SupportedGameId, resolution: GameResolution | null): void {
  try {
    const key = `${STORED_RESOLUTION_PREFIX}${gameId}`;
    if (resolution) window.localStorage.setItem(key, gameResolutionValue(resolution));
    else window.localStorage.removeItem(key);
  } catch {
    // Persistence may be unavailable in private mode; safely fall back to the original INI after this restart.
  }
}
