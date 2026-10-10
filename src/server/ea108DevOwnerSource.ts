import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const EA108_DEV_OWNER_TOKEN_PATH = '/__ra2-ea108-owner/token';
const GAME_PREFIX = '/game/';
const OWNER_SCOPE = '/game/ra2/';

export interface Ea108DevOwnerSourceOptions {
  ownerDataDirectory: string;
  token: string;
  expectedExecutableSha256: string;
  expectedExecutableSize: number;
}

type Next = (error?: unknown) => void;

/** The private-data endpoint exists only when the Vite launch opts in exactly. */
export function isEa108DevOwnerSourceEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.RA2_EA108_DEV_LOCAL_OWNER_SOURCE === '1';
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().replace(/^::ffff:/, '');
  return normalized === '127.0.0.1' || normalized === '::1';
}

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  try {
    const parsed = new URL(`http://${host}`);
    return (
      (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

function isLoopbackBrowserRequest(request: IncomingMessage): boolean {
  const host = request.headers.host;
  if (
    (host !== undefined && !isLoopbackHost(host)) ||
    !isLoopbackAddress(request.socket.remoteAddress) ||
    !isLoopbackAddress(request.socket.localAddress)
  )
    return false;

  const source = request.headers.origin ?? request.headers.referer;
  if (!source || Array.isArray(source)) return false;
  try {
    const origin = new URL(source);
    return (
      (origin.protocol === 'http:' || origin.protocol === 'https:') &&
      (origin.hostname === '127.0.0.1' || origin.hostname === 'localhost') &&
      (host === undefined || origin.host.toLowerCase() === host.toLowerCase())
    );
  } catch {
    return false;
  }
}

function requestPath(request: IncomingMessage): { pathname: string; search: string } | null {
  const rawUrl = request.url ?? '/';
  const rawPath = rawUrl.split('?', 1)[0] ?? '/';
  if (/%2f|%5c/i.test(rawPath)) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (pathname.includes('\\') || pathname.split('/').some((part) => part === '.' || part === '..')) return null;
  try {
    const parsed = new URL(rawUrl, `http://${request.headers.host ?? '127.0.0.1'}`);
    return { pathname, search: parsed.search };
  } catch {
    return null;
  }
}

function writeText(response: ServerResponse, status: number, body: string): void {
  response.statusCode = status;
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(body);
}

function constantTimeTokenMatch(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual !== 'string') return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function isReadOnlyOwnerFile(name: string): boolean {
  const lower = name.toLowerCase();
  return lower === 'game.exe' || lower.endsWith('.dll') || lower.endsWith('.mix');
}

/**
 * Serve only RA2's local original EXE/DLL/MIX files. The route is loopback/origin/capability gated,
 * accepts no write methods, and validates the exact executable before exposing a source listing.
 */
export function createEa108DevOwnerSourceHandler(options: Ea108DevOwnerSourceOptions) {
  const root = resolve(options.ownerDataDirectory);
  let executableBytes: Buffer | null = null;
  let verification: Promise<Buffer> | null = null;

  const verifyExecutable = (): Promise<Buffer> => {
    if (executableBytes) return Promise.resolve(executableBytes);
    if (verification) return verification;
    verification = (async () => {
      const rootStat = await lstat(root);
      if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unavailable');
      const actualRoot = await realpath(root);
      const rootRelative = relative(root, actualRoot);
      if (rootRelative !== '' && (rootRelative.startsWith('..') || isAbsolute(rootRelative)))
        throw new Error('unavailable');

      const executablePath = resolve(root, 'game.exe');
      if (relative(root, executablePath) !== 'game.exe') throw new Error('unavailable');
      const executableStat = await lstat(executablePath);
      if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error('unavailable');
      const bytes = await readFile(executablePath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (
        bytes.length !== options.expectedExecutableSize ||
        digest !== options.expectedExecutableSha256.toLowerCase()
      ) {
        throw new Error('unavailable');
      }
      executableBytes = bytes;
      return bytes;
    })().catch((error) => {
      verification = null;
      throw error;
    });
    return verification;
  };

  const respond = async (request: IncomingMessage, response: ServerResponse, next: Next): Promise<void> => {
    const parsed = requestPath(request);
    if (!parsed) {
      writeText(response, 400, 'bad request');
      return;
    }
    const { pathname, search } = parsed;
    if (pathname !== EA108_DEV_OWNER_TOKEN_PATH && pathname !== '/game' && !pathname.startsWith(GAME_PREFIX)) {
      next();
      return;
    }
    if (!isLoopbackBrowserRequest(request)) {
      writeText(response, 403, 'local owner source denied');
      return;
    }

    if (pathname === EA108_DEV_OWNER_TOKEN_PATH) {
      if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        writeText(response, 405, 'method not allowed');
        return;
      }
      const query = new URLSearchParams(search);
      if (query.get('opt-in') !== '1' || request.headers['x-ra2-owner-opt-in'] !== '1') {
        writeText(response, 403, 'explicit local opt-in required');
        return;
      }
      try {
        await verifyExecutable();
      } catch {
        writeText(response, 409, 'EA 1.08 owner executable identity failed');
        return;
      }
      response.statusCode = 200;
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'application/json; charset=utf-8');
      response.end(JSON.stringify({ token: options.token }));
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      writeText(response, 405, 'method not allowed');
      return;
    }
    if (!constantTimeTokenMatch(request.headers['x-ra2-owner-token'], options.token)) {
      writeText(response, 403, 'local owner source denied');
      return;
    }
    try {
      const exe = await verifyExecutable();
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Accept-Ranges', 'bytes');
      if (pathname === '/game/.list') {
        const directory = new URLSearchParams(search).get('dir');
        if (directory !== 'ra2') {
          writeText(response, 404, 'not found');
          return;
        }
        const entries = (await readdir(root)).filter(isReadOnlyOwnerFile);
        const names: string[] = [];
        for (const name of entries) {
          const entry = await lstat(resolve(root, name)).catch(() => null);
          if (entry?.isFile() && !entry.isSymbolicLink()) names.push(name);
        }
        names.sort((left, right) => left.localeCompare(right));
        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(JSON.stringify(names));
        return;
      }

      if (!pathname.startsWith(OWNER_SCOPE)) {
        writeText(response, 404, 'not found');
        return;
      }
      const name = pathname.slice(OWNER_SCOPE.length);
      if (!name || name.includes('/') || !isReadOnlyOwnerFile(name)) {
        writeText(response, 404, 'not found');
        return;
      }
      let actualName: string;
      try {
        actualName = (await readdir(root)).find((entry) => entry.toLowerCase() === name.toLowerCase()) ?? '';
      } catch {
        writeText(response, 404, 'not found');
        return;
      }
      if (!actualName || !isReadOnlyOwnerFile(actualName)) {
        writeText(response, 404, 'not found');
        return;
      }
      const filePath = resolve(root, actualName);
      const fileRelative = relative(root, filePath);
      if (fileRelative !== actualName || fileRelative.startsWith('..') || isAbsolute(fileRelative)) {
        writeText(response, 404, 'not found');
        return;
      }
      const fileStat = await lstat(filePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        writeText(response, 404, 'not found');
        return;
      }

      const bytes = actualName.toLowerCase() === 'game.exe' ? exe : null;
      const size = bytes?.length ?? fileStat.size;
      response.setHeader('Content-Type', 'application/octet-stream');
      const rangeHeader = request.headers.range;
      if (rangeHeader) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader);
        if (!match) {
          response.setHeader('Content-Range', `bytes */${size}`);
          writeText(response, 416, 'range not satisfiable');
          return;
        }
        const start = Number(match[1]);
        const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) {
          response.setHeader('Content-Range', `bytes */${size}`);
          writeText(response, 416, 'range not satisfiable');
          return;
        }
        response.statusCode = 206;
        response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
        response.setHeader('Content-Length', String(end - start + 1));
        if (request.method === 'HEAD') response.end();
        else if (bytes) response.end(bytes.subarray(start, end + 1));
        else {
          const stream = createReadStream(filePath, { start, end });
          stream.once('error', () => response.destroy());
          stream.pipe(response);
        }
        return;
      }
      response.statusCode = 200;
      response.setHeader('Content-Length', String(size));
      if (request.method === 'HEAD') response.end();
      else if (bytes) response.end(bytes);
      else {
        const stream = createReadStream(filePath);
        stream.once('error', () => response.destroy());
        stream.pipe(response);
      }
    } catch {
      writeText(response, 404, 'local owner source unavailable');
    }
  };

  return (request: IncomingMessage, response: ServerResponse, next: Next): void => {
    void respond(request, response, next);
  };
}
