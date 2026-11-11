/**
 * Safe, read-only ZIP reader for untrusted archives. Pure TypeScript apart from the platform's
 * standard `DecompressionStream` (Node 18+, every current browser).
 *
 * Safety: entry count, declared and actual sizes, compression ratio and total output are all bounded;
 * entry names are sanitized and unsafe ones are refused (never written anywhere by this module);
 * encrypted entries, ZIP64 and unknown compression methods are reported, not guessed at. The inflated size
 * is counted while streaming, so a lying header cannot make this allocate more than the limit.
 */

export interface ZipLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRatio: number;
}
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 5000, maxEntryBytes: 30_000_000, maxTotalBytes: 200_000_000, maxRatio: 1000 };

export interface ZipEntryData {
  /** Sanitized path with forward slashes. */
  readonly path: string;
  readonly bytes: Uint8Array;
}
export interface ZipRefusal {
  readonly name: string;
  readonly reason: string;
}
export interface ZipContents {
  readonly entries: ZipEntryData[];
  readonly refused: ZipRefusal[];
}

interface StreamReaderLike {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  cancel(): Promise<void>;
}
interface DecompressionStreamLike {
  readonly readable: { getReader(): StreamReaderLike };
  readonly writable: { getWriter(): { write(chunk: Uint8Array): Promise<void>; close(): Promise<void> } };
}
type DSCtor = new (format: string) => DecompressionStreamLike;
const utf8 = (b: Uint8Array): string => new (globalThis as unknown as { TextDecoder: new (l: string) => { decode(b: Uint8Array): string } }).TextDecoder("utf-8").decode(b);

let CRC_TABLE: Uint32Array | null = null;
/** CRC-32 (IEEE), as stored in ZIP headers. */
export function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const u16 = (b: Uint8Array, o: number) => b[o]! | (b[o + 1]! << 8);
const u32 = (b: Uint8Array, o: number) => (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;

/** Returns a safe relative path, or a reason it was refused. */
export function sanitizeZipPath(name: string): { ok: true; path: string } | { ok: false; reason: string } {
  if (name.length === 0) return { ok: false, reason: "empty name" };
  if (name.length > 300) return { ok: false, reason: "name too long" };
  if (name.includes("\0")) return { ok: false, reason: "NUL in name" };
  const p = name.replace(/\\/g, "/");
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return { ok: false, reason: "absolute path" };
  const parts = p.split("/").filter((s) => s !== "");
  if (parts.some((s) => s === "..")) return { ok: false, reason: "path escapes the extraction folder (..)" };
  if (parts.some((s) => s === ".")) return { ok: false, reason: "'.' segment" };
  if (parts.length === 0) return { ok: false, reason: "empty path" };
  return { ok: true, path: parts.join("/") };
}

async function inflateRaw(data: Uint8Array, maxBytes: number): Promise<Uint8Array> {
  const Ctor = (globalThis as unknown as { DecompressionStream?: DSCtor }).DecompressionStream;
  if (!Ctor) throw new Error("this runtime has no DecompressionStream");
  const ds = new Ctor("deflate-raw");
  const writer = ds.writable.getWriter();
  const write = writer.write(data).then(() => writer.close());
  write.catch(() => undefined);
  const reader = ds.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`inflates to more than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  await write;
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export async function readZip(bytes: Uint8Array, limits: ZipLimits = DEFAULT_ZIP_LIMITS): Promise<ZipContents> {
  // End of central directory record: the last 22..65557 bytes.
  let eocd = -1;
  for (let k = bytes.length - 22; k >= Math.max(0, bytes.length - 22 - 65535); k--) {
    if (u32(bytes, k) === 0x06054b50) {
      eocd = k;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP file (no end-of-central-directory record)");
  const count = u16(bytes, eocd + 10);
  const cdSize = u32(bytes, eocd + 12);
  const cdOffset = u32(bytes, eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported");
  if (count > limits.maxEntries) throw new Error(`archive has ${count} entries (limit ${limits.maxEntries})`);
  if (cdOffset + cdSize > eocd) throw new Error("central directory lies outside the file");

  const entries: ZipEntryData[] = [];
  const refused: ZipRefusal[] = [];
  const seen = new Set<string>();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > bytes.length || u32(bytes, p) !== 0x02014b50) throw new Error(`corrupt central directory at entry ${n}`);
    const flags = u16(bytes, p + 8);
    const method = u16(bytes, p + 10);
    const crc = u32(bytes, p + 16);
    const csize = u32(bytes, p + 20);
    const usize = u32(bytes, p + 24);
    const nameLen = u16(bytes, p + 28);
    const extraLen = u16(bytes, p + 30);
    const commentLen = u16(bytes, p + 32);
    const localOffset = u32(bytes, p + 42);
    const rawName = utf8(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (rawName.endsWith("/")) continue; // directory
    const refuse = (reason: string) => void refused.push({ name: rawName, reason });
    const safe = sanitizeZipPath(rawName);
    if (!safe.ok) {
      refuse(safe.reason);
      continue;
    }
    if (seen.has(safe.path)) {
      refuse("duplicate entry name");
      continue;
    }
    seen.add(safe.path);
    if (flags & 1) {
      refuse("encrypted entry");
      continue;
    }
    if (method !== 0 && method !== 8) {
      refuse(`unsupported compression method ${method}`);
      continue;
    }
    if (usize > limits.maxEntryBytes) {
      refuse(`declared size ${usize} exceeds ${limits.maxEntryBytes}`);
      continue;
    }
    if (csize > 0 && usize / csize > limits.maxRatio) {
      refuse(`compression ratio above ${limits.maxRatio}:1`);
      continue;
    }
    if (localOffset + 30 > bytes.length || u32(bytes, localOffset) !== 0x04034b50) {
      refuse("bad local header");
      continue;
    }
    const dataStart = localOffset + 30 + u16(bytes, localOffset + 26) + u16(bytes, localOffset + 28);
    if (dataStart + csize > bytes.length) {
      refuse("entry data runs past the end of the file");
      continue;
    }
    const raw = bytes.subarray(dataStart, dataStart + csize);
    let data: Uint8Array;
    try {
      data = method === 0 ? raw.slice() : await inflateRaw(raw, Math.min(limits.maxEntryBytes, usize + 1024));
    } catch (e) {
      refuse(`could not decompress: ${(e as Error).message}`);
      continue;
    }
    if (data.length !== usize) {
      refuse(`size mismatch (header says ${usize}, got ${data.length})`);
      continue;
    }
    if (crc32(data) !== crc) {
      refuse("CRC-32 mismatch (the entry is corrupted)");
      continue;
    }
    total += data.length;
    if (total > limits.maxTotalBytes) throw new Error(`archive inflates to more than ${limits.maxTotalBytes} bytes`);
    entries.push({ path: safe.path, bytes: data });
  }
  return { entries, refused };
}
