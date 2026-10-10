import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createEa108DevOwnerSourceHandler,
  EA108_DEV_OWNER_TOKEN_PATH,
  isEa108DevOwnerSourceEnabled,
} from '../../src/server/ea108DevOwnerSource';
import { isEa108DevOwnerSourceOptedIn } from '../../src/platform/browser/ea108MobileHost';

const TOKEN = 'a'.repeat(64);
const EXECUTABLE = new Uint8Array([0x4d, 0x5a, 0x01, 0x02]);

let directory: string | undefined;
let server: Server | undefined;
let origin = '';

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});

async function startServer(
  options: { executable?: Uint8Array; expectedHash?: string; expectedSize?: number; missingExecutable?: boolean } = {},
) {
  directory = await mkdtemp(join(tmpdir(), 'ra2-ea108-local-source-'));
  const executable = options.executable ?? EXECUTABLE;
  if (!options.missingExecutable) await writeFile(join(directory, 'game.exe'), executable);
  await writeFile(join(directory, 'ra2.mix'), new Uint8Array([1, 2, 3]));
  await writeFile(join(directory, 'video.dll'), new Uint8Array([4, 5]));
  await writeFile(join(directory, 'secret.ini'), new Uint8Array([6]));
  await writeFile(join(directory, 'gamemd.exe'), new Uint8Array([7]));
  const expectedHash = options.expectedHash ?? createHash('sha256').update(executable).digest('hex');
  const expectedSize = options.expectedSize ?? executable.length;
  const handler = createEa108DevOwnerSourceHandler({
    ownerDataDirectory: directory,
    token: TOKEN,
    expectedExecutableSha256: expectedHash,
    expectedExecutableSize: expectedSize,
  });
  server = createServer((request, response) => {
    handler(request, response, () => {
      response.statusCode = 404;
      response.end('not found');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject);
    server!.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind a TCP port');
  origin = `http://127.0.0.1:${address.port}`;
  return { executable };
}

function localHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    Origin: origin,
    Referer: `${origin}/?ea108-local-owner=1`,
    ...extra,
  };
}

async function request(path: string, init: RequestInit = {}) {
  return fetch(`${origin}${path}`, {
    ...init,
    headers: localHeaders(init.headers as Record<string, string> | undefined),
  });
}

describe('development-only EA 1.08 local owner source route', () => {
  it('requires exact server opt-in, browser opt-in, and a loopback origin', () => {
    expect(isEa108DevOwnerSourceEnabled({})).toBe(false);
    expect(isEa108DevOwnerSourceEnabled({ RA2_EA108_DEV_LOCAL_OWNER_SOURCE: 'true' })).toBe(false);
    expect(isEa108DevOwnerSourceEnabled({ RA2_EA108_DEV_LOCAL_OWNER_SOURCE: '1' })).toBe(true);

    expect(
      isEa108DevOwnerSourceOptedIn({
        protocol: 'http:',
        hostname: '127.0.0.1',
        search: '?ea108-local-owner=1',
      }),
    ).toBe(true);
    for (const location of [
      { protocol: 'https:', hostname: '127.0.0.1', search: '' },
      { protocol: 'https:', hostname: 'example.com', search: '?ea108-local-owner=1' },
      { protocol: 'https:', hostname: 'localhost', search: '?ea108-local-owner=0' },
      { protocol: 'file:', hostname: 'localhost', search: '?ea108-local-owner=1' },
    ]) {
      expect(isEa108DevOwnerSourceOptedIn(location)).toBe(false);
    }
  });

  it('serves the verified executable and only read-only RA2 source files with a loopback capability', async () => {
    const { executable } = await startServer();
    const tokenResponse = await request(`${EA108_DEV_OWNER_TOKEN_PATH}?opt-in=1`, {
      headers: { 'X-RA2-Owner-Opt-In': '1' },
    });
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(await tokenResponse.json()).toEqual({ token: TOKEN });

    const listing = await request('/game/.list?dir=ra2', {
      headers: { 'X-RA2-Owner-Token': TOKEN },
    });
    expect(listing.status).toBe(200);
    expect(await listing.json()).toEqual(['game.exe', 'ra2.mix', 'video.dll']);

    const executableResponse = await request('/game/ra2/game.exe', {
      headers: { 'X-RA2-Owner-Token': TOKEN },
    });
    expect(executableResponse.status).toBe(200);
    expect(new Uint8Array(await executableResponse.arrayBuffer())).toEqual(executable);

    const mixRange = await request('/game/ra2/ra2.mix', {
      headers: { 'X-RA2-Owner-Token': TOKEN, Range: 'bytes=1-2' },
    });
    expect(mixRange.status).toBe(206);
    expect(new Uint8Array(await mixRange.arrayBuffer())).toEqual(new Uint8Array([2, 3]));

    for (const path of ['/game/ra2/secret.ini', '/game/ra2/gamemd.exe', '/game/ra2/%2e%2e/secret.ini']) {
      const denied = await request(path, { headers: { 'X-RA2-Owner-Token': TOKEN } });
      expect([400, 404]).toContain(denied.status);
    }
    const write = await request('/game/ra2/ra2.mix', {
      method: 'POST',
      headers: { 'X-RA2-Owner-Token': TOKEN },
    });
    expect(write.status).toBe(405);
  });

  it('fails closed for absent opt-in, unknown origin, bad hash, and missing executable', async () => {
    await startServer();
    expect(
      (
        await request(`${EA108_DEV_OWNER_TOKEN_PATH}?opt-in=1`, {
          headers: { 'X-RA2-Owner-Opt-In': '0' },
        })
      ).status,
    ).toBe(403);

    expect(
      (
        await fetch(`${origin}${EA108_DEV_OWNER_TOKEN_PATH}?opt-in=1`, {
          headers: { Origin: 'https://outside.example', 'X-RA2-Owner-Opt-In': '1' },
        })
      ).status,
    ).toBe(403);

    const badPath = await request('/game/ra2/game.exe');
    expect(badPath.status).toBe(403);

    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;

    await startServer({ expectedHash: '0'.repeat(64) });
    expect(
      (
        await request(`${EA108_DEV_OWNER_TOKEN_PATH}?opt-in=1`, {
          headers: { 'X-RA2-Owner-Opt-In': '1' },
        })
      ).status,
    ).toBe(409);

    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = undefined;

    await startServer({ missingExecutable: true });
    expect(
      (
        await request(`${EA108_DEV_OWNER_TOKEN_PATH}?opt-in=1`, {
          headers: { 'X-RA2-Owner-Opt-In': '1' },
        })
      ).status,
    ).toBe(409);
  });
});
