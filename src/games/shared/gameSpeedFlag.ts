import type { GuestMemory } from '../../vm86/win32';
import { readU32, writeU32 } from './guestMemoryIO';

function readValidatedSettingsPointer(memory: GuestMemory, settingsPointerAddress: number): number | null {
  const settings = readU32(memory, settingsPointerAddress);
  return settings < 0x0010_0000 || settings >= 0x1000_0000 ? null : settings;
}

/** Read only an existing, validated native GameSpeed setting in the seven-value 0..6 domain. */
export function readGameSpeedFlag(
  memory: GuestMemory,
  settingsPointerAddress: number,
  gameSpeedOffset: number,
): number | null {
  try {
    const settings = readValidatedSettingsPointer(memory, settingsPointerAddress);
    if (settings === null) return null;
    const value = readU32(memory, settings + gameSpeedOffset);
    return value <= 6 ? value : null;
  } catch {
    return null;
  }
}

/**
 * RA2/YR store Options/GameSpeed in version-specific Rules/Settings singletons; the active battlefield reads this field directly for its tick-rate limit. Accept only native settings 0..6, writing only when the singleton pointer and old value are valid to avoid corrupting guest memory during early startup or after object release. Each game supplies its own singleton pointer and field offset.
 */
export function writeGameSpeedFlag(
  memory: GuestMemory,
  settingsPointerAddress: number,
  gameSpeedOffset: number,
  value: number,
): number | null {
  const speed = value | 0;
  if (speed !== value || speed < 0 || speed > 6) return null;
  try {
    const settings = readValidatedSettingsPointer(memory, settingsPointerAddress);
    if (settings === null) return null;
    const address = settings + gameSpeedOffset;
    const previous = readU32(memory, address);
    if (previous > 6) return null;
    writeU32(memory, address, speed);
    return readU32(memory, address) === speed ? speed : null;
  } catch {
    return null;
  }
}
