import { describe, expect, it, vi } from 'vitest';
import type { GameFileProvider } from '../../src/resources/contracts';
import { ScopedGameFileProvider } from '../../src/resources/providers/scoped';
import { httpOwnerDataTokenOf } from '../../src/platform/browser/files/directoryAccess';
import { HttpGameFileProvider } from '../../src/platform/browser/files/http';
import {
  createEa108OwnerGameSource,
  EA108_RA2_EXECUTABLE_SHA256,
  EA108_RA2_M1_REQUIRED_FILES,
} from '../../src/platform/browser/ea108MobileHost';

class FixtureProvider implements GameFileProvider {
  readonly label = 'asset-free iOS owner-data fixture';

  constructor(private readonly files: Map<string, Uint8Array>) {}

  async read(path: string): Promise<Uint8Array | null> {
    return this.files.get(path.toLowerCase())?.slice() ?? null;
  }

  async write(): Promise<void> {
    throw new Error('fixture is read-only');
  }

  async flush(): Promise<void> {}

  async list(directory: string): Promise<string[] | null> {
    if (directory) return [];
    return [...this.files.keys()];
  }
}

function fixture(executable: Uint8Array, names: readonly string[] = EA108_RA2_M1_REQUIRED_FILES): FixtureProvider {
  const files = new Map<string, Uint8Array>(names.map((name) => [name.toLowerCase(), new Uint8Array([1])]));
  files.set('game.exe', executable);
  return new FixtureProvider(files);
}

describe('EA RA2 1.08 iOS owner-source gate', () => {
  it('pins the accepted Chairman executable and requires the original campaign media surface', () => {
    expect(EA108_RA2_EXECUTABLE_SHA256).toBe('6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d');
    expect(EA108_RA2_M1_REQUIRED_FILES).toEqual([
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
    ]);
  });

  it('fails closed when either campaign map archive is absent', async () => {
    for (const missing of ['maps01.mix', 'maps02.mix']) {
      const provider = fixture(
        new Uint8Array([0x4d, 0x5a]),
        EA108_RA2_M1_REQUIRED_FILES.filter((name) => name !== missing),
      );
      await expect(createEa108OwnerGameSource(provider)).rejects.toThrow(new RegExp(missing.replace('.', '\\.')));
    }
  });

  it('fails closed for any executable other than the exact accepted EA 1.08 bytes', async () => {
    await expect(createEa108OwnerGameSource(fixture(new Uint8Array([0x4d, 0x5a])))).rejects.toThrow(
      /Unsupported RA2 executable SHA-256/,
    );
  });

  it('carries the private capability through RA2 scoping to owner listings and file reads', async () => {
    const token = 'asset-free-test-token';
    const requests: Array<{ url: string; token: string | null }> = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, token: new Headers(init?.headers).get('X-RA2-Owner-Token') });
      return url.includes('/.list')
        ? new Response(JSON.stringify(['game.exe']), { status: 200 })
        : new Response(new Uint8Array([0x4d, 0x5a]), { status: 200 });
    });
    try {
      const source = new ScopedGameFileProvider(new HttpGameFileProvider(token), 'ra2');
      expect(httpOwnerDataTokenOf(source)).toBe(token);
      expect(await source.list('')).toContain('game.exe');
      expect(await source.read('game.exe')).toEqual(new Uint8Array([0x4d, 0x5a]));
      expect(requests).toEqual([
        { url: '/game/.list?dir=ra2', token },
        { url: '/game/ra2/game.exe', token },
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
