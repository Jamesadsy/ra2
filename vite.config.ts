import { defineConfig, type Plugin } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { createReadStream, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { PreviewServer, ViteDevServer } from 'vite';
import { createGameRelay } from 'relay-package/server';
import { parseRelayFaultConfig } from 'relay-package/faults';
import { createThirdPartyCacheHandler } from './src/server/thirdPartyCache';
import { createEa108DevOwnerSourceHandler, isEa108DevOwnerSourceEnabled } from './src/server/ea108DevOwnerSource';
import { EA108_RA2_OWNER_EXECUTABLE } from './src/games/ra2/ea108Identity';
import { randomBytes } from 'node:crypto';

type ViteHttpServer = NonNullable<ViteDevServer['httpServer']> | NonNullable<PreviewServer['httpServer']>;

/**
 * Expose local, Git-ignored original game/ resources to the browser at /game/*.
 * For example, fetch('/game/Title.bmp') reads the original data file without copying assets.
 */
const GAME_DIR = resolve(process.env.RA2_GAME_ROOT || fileURLToPath(new URL('./game', import.meta.url)));
const EA108_DEV_OWNER_SOURCE_ENABLED = isEa108DevOwnerSourceEnabled(process.env);
// Loopback is a secure browser context. This explicit opt-in keeps the private owner-data run on HTTP without
// teaching the browser test to suppress a certificate warning; the default development server remains HTTPS.
const EA108_DEV_LOCAL_HTTP = EA108_DEV_OWNER_SOURCE_ENABLED && process.env.RA2_EA108_DEV_LOCAL_HTTP === '1';

function ea108DevOwnerSourcePlugin(): Plugin {
  return {
    name: 'ra2:ea108-dev-owner-source',
    apply: 'serve',
    configResolved(config) {
      if (EA108_DEV_OWNER_SOURCE_ENABLED && config.server.host !== '127.0.0.1') {
        throw new Error('EA 1.08 owner-source diagnostics require Vite to bind exactly to 127.0.0.1.');
      }
    },
    configureServer(server) {
      if (!EA108_DEV_OWNER_SOURCE_ENABLED) return;
      const ownerDataDirectory = process.env.RA2_EA108_OWNER_DATA_DIR;
      if (!ownerDataDirectory)
        throw new Error('RA2_EA108_OWNER_DATA_DIR is required for the opted-in local source route.');
      server.middlewares.use(
        createEa108DevOwnerSourceHandler({
          ownerDataDirectory,
          token: randomBytes(32).toString('hex'),
          expectedExecutableSha256: EA108_RA2_OWNER_EXECUTABLE.sha256,
          expectedExecutableSize: EA108_RA2_OWNER_EXECUTABLE.size,
        }),
      );
    },
  };
}

function gameAssetsPlugin(): Plugin {
  return {
    name: 'ra2:game-assets',
    configureServer(server) {
      // The cache stays outside public/dist; production builds and preview do not expose this endpoint.
      server.middlewares.use(
        '/__third-party',
        createThirdPartyCacheHandler(
          resolve(
            process.env.RA2_THIRD_PARTY_CACHE_DIR || fileURLToPath(new URL('./.tmp-third-party', import.meta.url)),
          ),
        ),
      );
      server.middlewares.use('/game', serveGameAsset);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/game', serveGameAsset);
    },
  };
}

function ra2NetworkRelayPlugin(): Plugin {
  return {
    name: 'ra2:network-relay',
    configureServer(server) {
      attachRa2NetworkRelay(server);
    },
    configurePreviewServer(server) {
      attachRa2NetworkRelay(server);
    },
  };
}

/** attachDplayRelay needs only these two members; dev/preview servers are structural subsets. */
interface RelayHostServer {
  httpServer: ViteHttpServer | null;
  close(): Promise<void>;
}

/** Mount the RA2 virtual-LAN relay at /ra2. */
function attachRa2NetworkRelay(server: RelayHostServer): void {
  const httpServer = server.httpServer;
  if (!httpServer) return;
  const relay = createGameRelay({ faults: parseRelayFaultConfig(process.env.RA2_NET_FAULTS) });
  const onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let pathname: string;
    try {
      pathname = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`).pathname;
    } catch {
      return;
    }
    if (pathname !== '/ra2') return;
    relay.handleUpgrade(request, socket, head);
  };
  httpServer.on('upgrade', onUpgrade);
  httpServer.once('close', () => httpServer.off('upgrade', onUpgrade));
  const originalClose = server.close.bind(server);
  server.close = async () => {
    relay.close();
    await relay.drained();
    return originalClose();
  };
}

function serveGameAsset(req: IncomingMessage, res: ServerResponse): void {
  const rawUrl = req.url ?? '';
  const query = rawUrl.split('?')[1] ?? '';
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(rawUrl.split('?')[0]);
  } catch {
    res.statusCode = 400;
    res.end('bad path');
    return;
  }
  // Game-directory enumeration endpoint for browser EXE discovery, such as /game/.list?dir=ra2.
  if (urlPath === '/.list') {
    const directory = new URLSearchParams(query).get('dir') ?? '';
    const target = resolveGameDirectory(directory);
    if (!target) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    try {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(readdirSync(target)));
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
    return;
  }
  const resolved = resolveGameFile(urlPath);
  if (!resolved) {
    // Terminate within /game; passing to Vite's SPA fallback would mistake index.html for a game file.
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  const st = statSync(resolved);
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'max-age=86400');
  const range = req.headers.range;
  if (range) {
    const m = /bytes=(\d+)-(\d*)/.exec(range);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? Math.min(parseInt(m[2], 10), st.size - 1) : st.size - 1;
      if (start <= end && start < st.size) {
        res.statusCode = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', String(end - start + 1));
        createReadStream(resolved, { start, end }).pipe(res);
        return;
      }
    }
  }
  res.statusCode = 200;
  res.setHeader('Content-Length', String(st.size));
  createReadStream(resolved).pipe(res);
}

/** Directory counterpart of resolveGameFile: resolve each level case-insensitively; the result must be a directory within GAME_DIR. */
function resolveGameDirectory(urlPath: string): string | null {
  if (!urlPath) return GAME_DIR;
  const parts = urlPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) return null;
  let current = GAME_DIR;
  try {
    for (const part of parts) {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!actual) return null;
      current = join(current, actual);
    }
    return statSync(current).isDirectory() && isWithinGameDirectory(current) ? current : null;
  } catch {
    return null;
  }
}

/** Original directory and file names use inconsistent casing; resolve each level case-insensitively. */
function resolveGameFile(urlPath: string): string | null {
  const parts = urlPath.replace(/\\/g, '/').split('/').filter(Boolean);
  if (!parts.length || parts.some((part) => part === '.' || part === '..')) return null;
  let current = GAME_DIR;
  try {
    for (const part of parts) {
      const actual = readdirSync(current).find((name) => name.toLowerCase() === part.toLowerCase());
      if (!actual) return null;
      current = join(current, actual);
    }
    return statSync(current).isFile() && isWithinGameDirectory(current) ? current : null;
  } catch {
    return null;
  }
}

/** Cross-platform check that the resolved path remains within the game root; Windows uses backslashes, so do not hardcode '/'. */
function isWithinGameDirectory(candidate: string): boolean {
  const relativePath = relative(resolve(GAME_DIR), resolve(candidate));
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

export default defineConfig({
  plugins: [
    ...(EA108_DEV_LOCAL_HTTP ? [] : [basicSsl()]),
    ea108DevOwnerSourcePlugin(),
    gameAssetsPlugin(),
    ra2NetworkRelayPlugin(),
  ],
  // VM pages with hmr=false cannot rely on reloads to handle a second prebundle. Register JSX and Worker dynamic dependencies
  // up front to avoid a second React instance in lazy pages. This only builds development caches; browser experiments are not preloaded.
  optimizeDeps: {
    include: [
      'react',
      'react-dom',
      'react-dom/client',
      'react/jsx-runtime',
      'react/jsx-dev-runtime',
      'fflate',
      'v86',
      '7z-wasm',
      'onnxruntime-web/webgpu',
    ],
  },
  server: {
    // The private EA 1.08 source lane is never exposed beyond this machine.
    host: EA108_DEV_OWNER_SOURCE_ENABLED ? '127.0.0.1' : true, // Normal development remains available to LAN devices.
    port: 15174,
    strictPort: true,
    // VMs and long regressions are stateful; code changes must not reload pages or destroy VMs under test.
    hmr: false,
    // Disable caching in development to prevent stale modules during hot updates/hard reloads (previously mixed old and new map.ts code).
    // The /game resource middleware sets its own max-age=86400 and is unaffected.
    headers: {
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'require-corp',
    },
    fs: { allow: ['.'] },
  },
  preview: {
    port: 4174,
    strictPort: true,
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
  },
  build: { target: 'es2022' },
  worker: {
    // vmClient.ts starts a module Worker with new Worker(new URL('./vmWorker.ts', import.meta.url), { type: 'module' }).
    // Vite requires ES output for code-split Workers; the default iife format fails.
    format: 'es',
  },
});
