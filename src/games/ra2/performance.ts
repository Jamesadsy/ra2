import type { GuestMemory } from '../../vm86/win32';
import { createFrameCounterReader } from '../shared/frameCounter';
import { RA2_STARTUP_PAGE_HASH } from './startupPage';

/** Official EA RA2 1.08 executable accepted for read-only performance diagnostics. */
export const RA2_108_PERFORMANCE_HASH = '6fc4b410f8841ba3ad6c57b59fccae65f58a8871d86750af3c1e2d5a7c5ad39d';

/** RA2 1.006: read the frame counter at 0x540676, INC EDX at 0x540681, and write back at 0x540684. */
export function createRa2FrameReader(memory: GuestMemory, hash: string) {
  if (hash === RA2_108_PERFORMANCE_HASH) {
    return createFrameCounterReader(memory, hash, {
      hash: RA2_108_PERFORMANCE_HASH,
      site: 0x540676,
      signature: [
        0x8b, 0x15, 0x2c, 0x0d, 0xa4, 0, 0xa1, 0x74, 0x91, 0xab, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x2c, 0x0d, 0xa4, 0,
      ],
      frame: 0xa40d2c,
      gameSpeed: 0xa40b18,
      sessionSpeed: 0xa3d2c8,
      requestedFps: 0xa3d568,
    });
  }

  return createFrameCounterReader(memory, hash, {
    hash: RA2_STARTUP_PAGE_HASH,
    site: 0x540676,
    signature: [
      0x8b, 0x15, 0x2c, 0x0d, 0xa4, 0, 0xa1, 0x74, 0x91, 0xab, 0, 0x42, 0x3b, 0xc7, 0x89, 0x15, 0x2c, 0x0d, 0xa4, 0,
    ],
    frame: 0xa40d2c,
    gameSpeed: 0xa40b18,
    sessionSpeed: 0xa3d2c8,
    requestedFps: 0xa3d568,
  });
}
