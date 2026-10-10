import { createEa108OwnerGameSource, isEa108DevOwnerSourceOptedIn } from './ea108MobileHost';
import { HttpGameFileProvider } from './files/http';
import { ScopedGameFileProvider } from '../../resources/providers/scoped';
import type { GameSource } from '../../games/source';

/** Load the owner source only after the development browser and server both grant the loopback capability. */
export async function loadEa108DevOwnerGameSource(): Promise<GameSource> {
  if (!isEa108DevOwnerSourceOptedIn()) {
    throw new Error('EA RA2 1.08 local owner source requires explicit loopback development opt-in.');
  }

  const response = await fetch('/__ra2-ea108-owner/token?opt-in=1', {
    cache: 'no-store',
    credentials: 'same-origin',
    headers: { 'X-RA2-Owner-Opt-In': '1' },
  });
  if (!response.ok) throw new Error(`EA RA2 1.08 local owner source is unavailable (HTTP ${response.status}).`);
  const body = (await response.json()) as { token?: unknown };
  if (typeof body.token !== 'string' || !/^[a-f0-9]{64}$/.test(body.token)) {
    throw new Error('EA RA2 1.08 local owner source did not provide a valid local capability.');
  }

  const files = new ScopedGameFileProvider(new HttpGameFileProvider(body.token), 'ra2');
  return createEa108OwnerGameSource(files);
}
