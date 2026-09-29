import type { GameSource } from '../../games/source';
import { supportedGame } from '../../games/catalog';
import { HttpGameFileProvider } from './files/http';
import { ScopedGameFileProvider } from '../../resources/providers/scoped';
import type { GameFileProvider } from '../../resources/contracts';
import { sha256Hex } from '../../utils/sha256';
import { reportNativeRuntimePhase } from './nativeDiagnostics';

export const EA108_RA2_EXECUTABLE_SHA256 = '6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d';

/** Files needed for the original RA2 frontend, both campaign maps, briefing media, and music. */
export const EA108_RA2_M1_REQUIRED_FILES = [
  'game.exe',
  'ra2.mix',
  'language.mix',
  'binkw32.dll',
  'blowfish.dll',
  'maps01.mix',
  'maps02.mix',
  'movies01.mix',
  'movies02.mix',
  'multi.mix',
  'theme.mix',
] as const;

declare global {
  interface Window {
    /** Installed by the provenance-clean iOS shell before Route B's entry script runs. */
    __RA2Host?: { platform: 'ios'; version: 1; ownerDataToken: string };
  }
}

export function isEa108IosHost(): boolean {
  return window.__RA2Host?.platform === 'ios' && window.__RA2Host.version === 1;
}

/** Validate the owner-import contract and build the existing Route B source without the legacy 1.006 overlay. */
export async function createEa108OwnerGameSource(files: GameFileProvider): Promise<GameSource> {
  const entries = new Set((await files.list(''))?.map((name) => name.toLowerCase()) ?? []);
  const missing = EA108_RA2_M1_REQUIRED_FILES.filter((name) => !entries.has(name));
  if (missing.length) throw new Error(`EA RA2 1.08 owner data is incomplete: ${missing.join(', ')}`);

  const executableBytes = await files.read('game.exe');
  if (!executableBytes?.length) throw new Error('EA RA2 1.08 owner data is missing game.exe');
  const actualHash = await sha256Hex(executableBytes);
  if (actualHash !== EA108_RA2_EXECUTABLE_SHA256) {
    throw new Error(`Unsupported RA2 executable SHA-256: ${actualHash}`);
  }

  reportNativeRuntimePhase('ownerGameSourceValidated');
  return {
    game: supportedGame('ra2'),
    files,
    executableBytes,
  };
}

/** Load immutable, native-validated owner files exposed read-only by the app's local server. */
export async function loadEa108IosOwnerGameSource(): Promise<GameSource> {
  if (!isEa108IosHost()) throw new Error('EA RA2 1.08 owner source is only available inside the iOS host');
  const token = window.__RA2Host?.ownerDataToken;
  if (!token) throw new Error('The iOS owner-data capability is missing; restart the local host.');
  return createEa108OwnerGameSource(new ScopedGameFileProvider(new HttpGameFileProvider(token), 'ra2'));
}
