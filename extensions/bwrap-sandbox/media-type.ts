import { closeSync, openSync, readSync } from "node:fs";

const HEADER_BYTES = 4 * 1024;

function startsWith(header: Uint8Array, bytes: readonly number[]): boolean {
  return bytes.every((value, index) => header[index] === value);
}

function text(header: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...header.subarray(start, start + length));
}

function isoMediaBrand(header: Uint8Array): boolean {
  if (text(header, 4, 4) !== "ftyp") return false;
  const brands = new Set([
    "3g2a", "3g2b", "3g2c", "3ge6", "3ge7", "3gg6", "3gp1", "3gp2",
    "3gp3", "3gp4", "3gp5", "3gp6", "3gp7", "avif", "avis", "dash",
    "heic", "heix", "hevc", "hevx", "heim", "heis", "iso2", "iso3",
    "iso4", "iso5", "iso6", "isom", "M4A ", "M4B ", "M4P ", "M4V ",
    "mif1", "mj2s", "mjp2", "moov", "mp41", "mp42", "mp71", "MSNV",
    "qt  ", "SDV ", "XAVC",
  ]);
  for (let offset = 8; offset + 4 <= Math.min(header.length, 64); offset += 4) {
    if (brands.has(text(header, offset, 4))) return true;
  }
  return false;
}

export function hasMediaSignature(header: Uint8Array): boolean {
  if (header.length < 4) return false;

  if (startsWith(header, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return true;
  if (startsWith(header, [0xff, 0xd8, 0xff])) return true;
  if (text(header, 0, 6) === "GIF87a" || text(header, 0, 6) === "GIF89a") return true;
  if (text(header, 0, 2) === "BM") return true;
  if (startsWith(header, [0x49, 0x49, 0x2a, 0x00]) || startsWith(header, [0x4d, 0x4d, 0x00, 0x2a])) return true;
  if (startsWith(header, [0x00, 0x00, 0x01, 0x00])) return true;

  if (text(header, 0, 4) === "RIFF") {
    const kind = text(header, 8, 4);
    if (kind === "WEBP" || kind === "WAVE" || kind === "AVI ") return true;
  }

  if (text(header, 0, 4) === "fLaC" || text(header, 0, 4) === "OggS") return true;
  if (text(header, 0, 3) === "ID3") return true;
  if (startsWith(header, [0x1a, 0x45, 0xdf, 0xa3])) return true;
  if (startsWith(header, [0x00, 0x00, 0x01, 0xb3]) || startsWith(header, [0x00, 0x00, 0x01, 0xba])) return true;
  if (header[0] === 0xff && (header[1] & 0xe0) === 0xe0) return true;

  return header.length >= 12 && isoMediaBrand(header);
}

export function readMediaHeader(path: string): Uint8Array | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, "r");
    const buffer = Buffer.alloc(HEADER_BYTES);
    const bytesRead = readSync(descriptor, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        // An unreadable header uses normal classifier review.
      }
    }
  }
}
