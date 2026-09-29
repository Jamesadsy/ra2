/** Exercise a real IndexedDB v1 migration and save/Win32 enumeration after all Session A page objects are gone. */
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { preventThirdPartyDownloads } from '../../helpers/offlineBrowser';

type PersistedMetadata = {
  created: string;
  accessed: string;
  written: string;
  createdSource: string | null;
};

type SessionAResult = {
  legacy: number[] | null;
  migrationSource: string | null;
  migrationFileTime: string | null;
  written: number;
  persistedBytes: number | null;
  metadata: PersistedMetadata | null;
};

type SessionBResult = {
  bytesLength: number | null;
  bytesEqual: boolean;
  oldBytes: number[] | null;
  names: string[];
  fileTimes: string[];
  freshMetadata: PersistedMetadata | null;
  legacyMetadata: PersistedMetadata | null;
};

const browser = await chromium.launch({ args: ['--no-sandbox'] });
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const sessionA = await context.newPage();
  await preventThirdPartyDownloads(sessionA);
  await sessionA.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const createdBytes = Uint8Array.from({ length: 65_536 }, (_, index) => (index * 29 + 17) & 0xff);
  const legacyBytes = [0x52, 0x41, 0x32, 0x2d, 0x6c, 0x65, 0x67, 0x61, 0x63, 0x79];

  const sessionAResult = await sessionA.evaluate<SessionAResult>(`(async () => {
    const legacyPayload = ${JSON.stringify(legacyBytes)};
    const load = (path) => import(/* @vite-ignore */ path);
    const dbName = 'ra2-vm-development-files';
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('files');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('files', 'readwrite');
        transaction.objectStore('files').put(new Uint8Array(legacyPayload), 'save/legacy.sav');
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error ?? new Error('legacy seed aborted'));
      };
    });

    const { SessionGameFileProvider } = await load('/src/platform/browser/files/sessionFiles.ts');
    const { createGuestMemory, createTestShim, callShim, writeAsciiZ } = await load('/tests/helpers/guestMemory.ts');
    const provider = new SessionGameFileProvider('cold session A', new Map());
    const migratedLegacy = await provider.read('SAVE/LEGACY.SAV');
    const migratedMetadata = await provider.readMetadata('save/legacy.sav');
    const memory = createGuestMemory();
    const pendingWrites = [];
    const shim = createTestShim(memory, {
      onFileWrite: (path, bytes, metadata) => {
        pendingWrites.push(provider.write(path, bytes, metadata));
      },
    });
    writeAsciiZ(memory, 0x10000, 'save/cold.sav');
    const handle = callShim(shim, 'KERNEL32.DLL!_lcreat', [0x10000, 0]).eax;
    const saveBytes = Uint8Array.from({ length: 65_536 }, (_, index) => (index * 29 + 17) & 0xff);
    memory.write_memory(saveBytes, 0x20000);
    const written = callShim(shim, 'KERNEL32.DLL!_lwrite', [handle, 0x20000, saveBytes.length]).eax;
    callShim(shim, 'KERNEL32.DLL!_lclose', [handle]);
    await Promise.all(pendingWrites);
    await provider.flush();
    const metadata = await provider.readMetadata('SAVE/COLD.SAV');
    return {
      legacy: migratedLegacy ? [...migratedLegacy] : null,
      migrationSource: migratedMetadata?.createdSource ?? null,
      migrationFileTime: migratedMetadata?.written.toString() ?? null,
      written,
      persistedBytes: (await provider.read('save/cold.sav'))?.length ?? null,
      metadata: metadata ? {
        created: metadata.created.toString(),
        accessed: metadata.accessed.toString(),
        written: metadata.written.toString(),
        createdSource: metadata.createdSource ?? null,
      } : null,
    };
  })()`);
  assert.deepEqual(sessionAResult.legacy, legacyBytes, 'migration must preserve existing byte-only saves');
  assert.equal(sessionAResult.migrationSource, 'legacy-migration-fallback');
  assert.ok(BigInt(sessionAResult.migrationFileTime!) > 116_444_736_000_000_000n);
  assert.equal(sessionAResult.written, createdBytes.length);
  assert.equal(sessionAResult.persistedBytes, createdBytes.length);
  assert.ok(sessionAResult.metadata);
  assert.equal(sessionAResult.metadata.createdSource, 'win32');
  assert.ok(BigInt(sessionAResult.metadata.created) > 116_444_736_000_000_000n);

  // This closes the page and drops Session A's shim, provider, Worker/page globals and event handlers.
  await sessionA.close();
  const sessionB = await context.newPage();
  await preventThirdPartyDownloads(sessionB);
  await sessionB.goto(process.env.RA2_BROWSER_ORIGIN ?? 'https://127.0.0.1:15174/');
  const sessionBResult = await sessionB.evaluate<SessionBResult>(`(async () => {
    const load = (path) => import(/* @vite-ignore */ path);
    const { SessionGameFileProvider } = await load('/src/platform/browser/files/sessionFiles.ts');
    const { readGuestFileSearch } = await load('/src/adapter/fileSearch.ts');
    const { createGuestMemory, createTestShim, callShim, readU32, writeAsciiZ } = await load('/tests/helpers/guestMemory.ts');
    const provider = new SessionGameFileProvider('cold session B', new Map());
    const bytes = await provider.read('SAVE/COLD.SAV');
    const oldBytes = await provider.read('save/legacy.sav');
    const freshMetadata = await provider.readMetadata('save/cold.sav');
    const legacyMetadata = await provider.readMetadata('save/legacy.sav');
    const entries = await readGuestFileSearch(provider, 'save/*.sav');
    const memory = createGuestMemory();
    const shim = createTestShim(memory);
    shim.setFileSearchResults('save/*.sav', entries);
    writeAsciiZ(memory, 0x30000, 'save/*.sav');
    const handle = callShim(shim, 'KERNEL32.DLL!FindFirstFileA', [0x30000, 0x31000]).eax;
    const names = [];
    const fileTimes = [];
    let more = true;
    while (more) {
      const nameBytes = memory.read_memory(0x31000 + 44, 260);
      const end = nameBytes.indexOf(0);
      names.push(String.fromCharCode(...nameBytes.subarray(0, end < 0 ? nameBytes.length : end)));
      const readTime = (offset) => (BigInt(readU32(memory, 0x31000 + offset)) | (BigInt(readU32(memory, 0x31000 + offset + 4)) << 32n)).toString();
      fileTimes.push(readTime(20));
      more = callShim(shim, 'KERNEL32.DLL!FindNextFileA', [handle, 0x31000]).eax !== 0;
    }
    callShim(shim, 'KERNEL32.DLL!FindClose', [handle]);

    // Exercise the same Win32 file-read boundary the Load dialog reaches after it selects the listed save.
    if (bytes) shim.mountFile('save/cold.sav', bytes);
    writeAsciiZ(memory, 0x32000, 'save/cold.sav');
    const fileHandle = callShim(shim, 'KERNEL32.DLL!_lopen', [0x32000, 0]).eax;
    const readCount = bytes ? callShim(shim, 'KERNEL32.DLL!_lread', [fileHandle, 0x40000, bytes.length]).eax : 0;
    const guestBytes = memory.read_memory(0x40000, Math.max(0, readCount));
    callShim(shim, 'KERNEL32.DLL!_lclose', [fileHandle]);
    return {
      bytesLength: bytes?.length ?? null,
      bytesEqual: Boolean(bytes && guestBytes.length === bytes.length && guestBytes.every((value, index) => value === bytes[index])),
      oldBytes: oldBytes ? [...oldBytes] : null,
      names: names.sort(),
      fileTimes,
      freshMetadata: freshMetadata ? {
        created: freshMetadata.created.toString(),
        accessed: freshMetadata.accessed.toString(),
        written: freshMetadata.written.toString(),
        createdSource: freshMetadata.createdSource ?? null,
      } : null,
      legacyMetadata: legacyMetadata ? {
        created: legacyMetadata.created.toString(),
        accessed: legacyMetadata.accessed.toString(),
        written: legacyMetadata.written.toString(),
        createdSource: legacyMetadata.createdSource ?? null,
      } : null,
    };
  })()`);
  assert.equal(sessionBResult.bytesLength, createdBytes.length);
  assert.equal(sessionBResult.bytesEqual, true, 'restored save bytes must pass through the Win32 file-read boundary');
  assert.deepEqual(sessionBResult.oldBytes, legacyBytes, 'previous byte-only saves remain readable');
  assert.deepEqual(sessionBResult.names, ['cold.sav', 'legacy.sav']);
  assert.equal(sessionBResult.fileTimes.length, 2);
  assert.ok(sessionBResult.fileTimes.every((value) => BigInt(value) > 116_444_736_000_000_000n));
  assert.equal(sessionBResult.freshMetadata?.createdSource, 'win32');
  assert.equal(sessionBResult.legacyMetadata?.createdSource, 'legacy-migration-fallback');
  console.log({
    sessionA: { bytes: sessionAResult.persistedBytes, metadataSource: sessionAResult.metadata?.createdSource },
    sessionB: {
      bytes: sessionBResult.bytesLength,
      listed: sessionBResult.names,
      non1601Times: sessionBResult.fileTimes.length,
    },
    legacySaveRecovered: sessionBResult.oldBytes?.length,
  });
  await context.close();
} finally {
  await browser.close();
}
