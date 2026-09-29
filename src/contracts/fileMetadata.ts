/** Win32 FILETIME values in 100ns ticks since 1601; bigint preserves the full 64-bit range. */
export interface GameFileMetadata {
  created: bigint;
  accessed: bigint;
  written: bigint;
  /** Distinguishes guest timestamps from the documented cache migration/write-clock fallback. */
  createdSource?: 'win32' | 'cache-write-clock' | 'legacy-migration-fallback';
}
