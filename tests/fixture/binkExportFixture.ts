import { buildPe32 } from './peBuilder';

/** Tiny metadata-free PE fixture that exposes Bink Open/Close exports for shim-boundary tests. */
export function buildBinkExportFixture(): Uint8Array {
  const code = new Uint8Array(0x1000);
  const view = new DataView(code.buffer);
  const rva = 0x1000;
  view.setUint32(0x0c, rva + 0xa0, true);
  view.setUint32(0x10, 1, true);
  view.setUint32(0x14, 2, true);
  view.setUint32(0x18, 2, true);
  view.setUint32(0x1c, rva + 0x60, true);
  view.setUint32(0x20, rva + 0x68, true);
  view.setUint32(0x24, rva + 0x70, true);
  view.setUint32(0x60, rva + 0xb0, true);
  view.setUint32(0x64, rva + 0xb1, true);
  view.setUint32(0x68, rva + 0x80, true);
  view.setUint32(0x6c, rva + 0x90, true);
  view.setUint16(0x70, 0, true);
  view.setUint16(0x72, 1, true);
  code.set(new TextEncoder().encode('_BinkOpen@8\0'), 0x80);
  code.set(new TextEncoder().encode('_BinkClose@4\0'), 0x90);
  code.set(new TextEncoder().encode('BINKW32.DLL\0'), 0xa0);
  code[0xb0] = 0xc3;
  code[0xb1] = 0xc3;
  const pe = buildPe32({
    imageBase: 0x0050_0000,
    entryRva: 0,
    sections: [{ name: '.text', data: code, characteristics: 0x6000_0020 }],
    imports: [],
  }).exe;
  const image = new DataView(pe.buffer, pe.byteOffset, pe.byteLength);
  const optionalHeader = 0x80 + 4 + 20;
  image.setUint32(optionalHeader + 96, rva, true);
  image.setUint32(optionalHeader + 100, 0x100, true);
  const sectionHeader = optionalHeader + 0xe0;
  const rawOffset = image.getUint32(sectionHeader + 20, true);
  pe.set(code, rawOffset);
  return pe;
}
