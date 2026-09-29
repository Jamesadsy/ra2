import type { GameFileMetadata } from '../../../resources/contracts';
import { normalizeGuestPath } from '../../../vm86/paths';

type CreatedTimeSource = 'win32' | 'cache-write-clock' | 'legacy-migration-fallback';

interface StoredFileRecord {
  formatVersion: 2;
  bytes: ArrayBuffer | Uint8Array;
  metadata: {
    created: string;
    accessed: string;
    written: string;
    createdSource: CreatedTimeSource;
  };
}

const DEVELOPMENT_FILE_DB = 'ra2-vm-development-files';
const DEVELOPMENT_FILE_STORE = 'files';
const DEVELOPMENT_FILE_DB_VERSION = 2;
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
const FILETIME_TICKS_PER_MILLISECOND = 10_000n;
const MAX_FILETIME = 0xffff_ffff_ffff_ffffn;

/**
 * IndexedDB write cache for save/writeback files. Version 2 stores bytes and Win32
 * FILETIME metadata in one object-store record and one transaction. Existing version-1
 * byte-only records are upgraded in place, retaining their payloads.
 */
export class IndexedDbWriteCache {
  private databasePromise: Promise<IDBDatabase | null> | null = null;
  private persistedKeysPromise: Promise<Set<string>> | null = null;
  private persistedKeysSnapshot: Set<string> | null = null;
  private generation = 0;

  invalidate(): void {
    this.generation++;
    this.persistedKeysPromise = null;
    this.persistedKeysSnapshot = null;
  }

  /** Synchronous existence check; null until key enumeration finishes. */
  hasKnownKey(path: string): boolean | null {
    if (!this.persistedKeysSnapshot) return null;
    return this.persistedKeysSnapshot.has(path);
  }

  async read(path: string): Promise<Uint8Array | null> {
    if (!(await this.keys()).has(path)) return null;
    const value = await this.readStoredValue(path);
    if (value === undefined) return null;
    const record = decodeRecord(value);
    const bytes = record?.bytes ?? legacyBytes(value);
    // get already obtains an exclusive copy through IndexedDB structured cloning; copying again doubles large-save memory
    // before handing it to the file port. Preserve view boundaries for legacy Uint8Array records.
    return bytes === null ? null : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  }

  async readMetadata(path: string): Promise<GameFileMetadata | null> {
    if (!(await this.keys()).has(path)) return null;
    const value = await this.readStoredValue(path);
    return value === undefined ? null : (decodeRecord(value)?.metadata ?? null);
  }

  async write(path: string, bytes: Uint8Array, metadata?: GameFileMetadata): Promise<void> {
    const database = await this.database();
    if (!database) return;
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const now = currentFileTime();
    const incoming = normalizeMetadata(metadata, now);
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DEVELOPMENT_FILE_STORE, 'readwrite');
      const store = transaction.objectStore(DEVELOPMENT_FILE_STORE);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new DOMException('保存事务中止', 'AbortError'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Save transaction failed'));
      const request = store.get(path);
      request.onerror = () => reject(request.error ?? new Error('Could not read the previous save record'));
      request.onsuccess = () => {
        const existing = decodeRecord(request.result);
        const next: StoredFileRecord = {
          formatVersion: 2,
          bytes: buffer,
          metadata: {
            created: existing?.metadata.created.toString() ?? incoming.created.toString(),
            accessed: incoming.accessed.toString(),
            written: incoming.written.toString(),
            createdSource: existing?.metadata.createdSource ?? incoming.createdSource,
          },
        };
        const put = store.put(next, path);
        put.onerror = () => reject(put.error ?? new Error('Could not persist the save record'));
      };
    });
    (await this.keys()).add(path);
  }

  /** Update timestamps only when a byte record already exists; never commit detached metadata. */
  async writeMetadata(path: string, metadata: GameFileMetadata): Promise<void> {
    const database = await this.database();
    if (!database) return;
    const incoming = normalizeMetadata(metadata, currentFileTime());
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(DEVELOPMENT_FILE_STORE, 'readwrite');
      const store = transaction.objectStore(DEVELOPMENT_FILE_STORE);
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error ?? new DOMException('元数据事务中止', 'AbortError'));
      transaction.onerror = () => reject(transaction.error ?? new Error('Metadata transaction failed'));
      const request = store.get(path);
      request.onerror = () => reject(request.error ?? new Error('Could not read the save for metadata update'));
      request.onsuccess = () => {
        const existing = decodeRecord(request.result);
        if (!existing) return;
        const put = store.put(
          {
            formatVersion: 2,
            bytes: existing.bytes,
            metadata: {
              created: incoming.created.toString(),
              accessed: incoming.accessed.toString(),
              written: incoming.written.toString(),
              createdSource: 'win32',
            },
          } satisfies StoredFileRecord,
          path,
        );
        put.onerror = () => reject(put.error ?? new Error('Could not persist updated save metadata'));
      };
    });
  }

  keys(): Promise<Set<string>> {
    if (this.persistedKeysPromise) return this.persistedKeysPromise;
    const generation = this.generation;
    const request = (async () => {
      const database = await this.database();
      if (!database) return new Set<string>();
      const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = database.transaction(DEVELOPMENT_FILE_STORE).objectStore(DEVELOPMENT_FILE_STORE).getAllKeys();
        request.onsuccess = () => resolve(request.result as IDBValidKey[]);
        request.onerror = () => reject(request.error);
      });
      return new Set(keys.map((key) => normalizeGuestPath(String(key))));
    })();
    this.persistedKeysPromise = request;
    void request.then(
      (keys) => {
        if (generation === this.generation) this.persistedKeysSnapshot = keys;
      },
      () => {},
    );
    return request;
  }

  private async readStoredValue(path: string): Promise<unknown | undefined> {
    const database = await this.database();
    if (!database) return undefined;
    return new Promise<unknown | undefined>((resolve, reject) => {
      const request = database.transaction(DEVELOPMENT_FILE_STORE).objectStore(DEVELOPMENT_FILE_STORE).get(path);
      request.onsuccess = () => resolve(request.result as unknown | undefined);
      request.onerror = () => reject(request.error);
    });
  }

  private async database(): Promise<IDBDatabase | null> {
    if (typeof indexedDB === 'undefined') return null;
    this.databasePromise ??= openDevelopmentDatabase();
    return this.databasePromise;
  }
}

function openDevelopmentDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVELOPMENT_FILE_DB, DEVELOPMENT_FILE_DB_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!database.objectStoreNames.contains(DEVELOPMENT_FILE_STORE)) {
        database.createObjectStore(DEVELOPMENT_FILE_STORE);
      }
      if (event.oldVersion < 2 && transaction) {
        migrateByteOnlyRecords(transaction.objectStore(DEVELOPMENT_FILE_STORE), currentFileTime());
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      // A stale page/Worker connection must not block a later schema upgrade.
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error);
  });
}

function migrateByteOnlyRecords(store: IDBObjectStore, migrationTime: bigint): void {
  const request = store.openCursor();
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (!decodeRecord(cursor.value)) {
      const bytes = legacyBytes(cursor.value);
      if (bytes) {
        cursor.update({
          formatVersion: 2,
          bytes,
          metadata: {
            created: migrationTime.toString(),
            accessed: migrationTime.toString(),
            written: migrationTime.toString(),
            createdSource: 'legacy-migration-fallback',
          },
        } satisfies StoredFileRecord);
      }
    }
    cursor.continue();
  };
}

function decodeRecord(value: unknown): {
  formatVersion: 2;
  bytes: ArrayBuffer | Uint8Array;
  metadata: GameFileMetadata & { createdSource: CreatedTimeSource };
} | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<StoredFileRecord>;
  if (candidate.formatVersion !== 2 || !candidate.bytes || !candidate.metadata) return null;
  const { created, accessed, written, createdSource } = candidate.metadata;
  if (
    typeof created !== 'string' ||
    typeof accessed !== 'string' ||
    typeof written !== 'string' ||
    typeof createdSource !== 'string' ||
    !['win32', 'cache-write-clock', 'legacy-migration-fallback'].includes(createdSource)
  ) {
    return null;
  }
  const parsed = { created: safeFileTime(created), accessed: safeFileTime(accessed), written: safeFileTime(written) };
  if (parsed.created === null || parsed.accessed === null || parsed.written === null) return null;
  return {
    formatVersion: 2,
    bytes: candidate.bytes,
    metadata: {
      created: parsed.created,
      accessed: parsed.accessed,
      written: parsed.written,
      createdSource: createdSource as CreatedTimeSource,
    },
  };
}

function legacyBytes(value: unknown): ArrayBuffer | Uint8Array | null {
  return value instanceof ArrayBuffer || value instanceof Uint8Array ? value : null;
}

function normalizeMetadata(
  metadata: GameFileMetadata | undefined,
  fallback: bigint,
): GameFileMetadata & {
  createdSource: CreatedTimeSource;
} {
  return {
    created: validFileTime(metadata?.created, fallback),
    accessed: validFileTime(metadata?.accessed, fallback),
    written: validFileTime(metadata?.written, fallback),
    createdSource: metadata?.createdSource ?? (metadata ? 'win32' : 'cache-write-clock'),
  };
}

function validFileTime(value: bigint | undefined, fallback: bigint): bigint {
  return value !== undefined && value > 0n && value <= MAX_FILETIME ? value : fallback;
}

function safeFileTime(value: string): bigint | null {
  try {
    const parsed = BigInt(value);
    return parsed > 0n && parsed <= MAX_FILETIME ? parsed : null;
  } catch {
    return null;
  }
}

function currentFileTime(): bigint {
  return BigInt(Date.now()) * FILETIME_TICKS_PER_MILLISECOND + FILETIME_UNIX_EPOCH;
}
