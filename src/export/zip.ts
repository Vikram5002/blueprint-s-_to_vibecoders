/**
 * Minimal ZIP archive writer, store-only (no compression).
 *
 * Task 2 of the "generate an application" final milestone: the simplest
 * real way for a browser to receive a generated project is a single
 * downloadable file. A zip needs no new runtime dependency beyond Node's
 * own `Buffer` - CLAUDE.md's "do not install heavy dependencies without
 * asking" - and every generated project so far (Milestones 1-3) is a
 * handful of small text files, so the space a real DEFLATE implementation
 * would save is not worth the extra surface: this writes valid,
 * standard-conforming ZIP entries with compression method 0 (stored),
 * openable by any real zip tool (Explorer, Finder, `unzip`, 7-Zip).
 *
 * Deliberately narrow: text files only (UTF-8), no directory entries (a
 * real zip reader infers directories from `/`-separated names), no
 * timestamps beyond a fixed placeholder (the exact modified time of a
 * generated file is not meaningful information worth carrying).
 */

/** Every real zip tool's CRC-32 table (ISO/IEC 8877), computed once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  /** Forward-slash path inside the archive, e.g. "backend/src/index.ts". */
  readonly path: string;
  readonly contents: string;
}

/** DOS date/time for 2020-01-01 00:00:00 - a fixed, meaningless-but-valid placeholder every entry shares. */
const DOS_TIME = 0;
const DOS_DATE = (2020 - 1980) << 9 | (1 << 5) | 1;

/**
 * General-purpose bit flag bit 11: "filename and comment fields are UTF-8".
 * Without it, a tool that isn't already assuming UTF-8 (older `unzip` on a
 * non-UTF-8 locale) can mis-decode a non-ASCII path - a real generated
 * project's file names are always UTF-8 (see component-codegen.ts), so this
 * is always set, never conditional.
 */
const UTF8_NAME_FLAG = 0x0800;

/**
 * Builds a complete ZIP archive (local file headers + central directory +
 * end-of-central-directory record) from a flat list of text entries.
 * Returns the whole archive as one Buffer - every generated project so far
 * is small enough that streaming would be premature.
 */
export function buildZipArchive(entries: readonly ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.path, 'utf8');
    const dataBuffer = Buffer.from(entry.contents, 'utf8');
    const crc = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // local file header signature
    localHeader.writeUInt16LE(20, 4); // version needed to extract
    localHeader.writeUInt16LE(UTF8_NAME_FLAG, 6); // general purpose flag
    localHeader.writeUInt16LE(0, 8); // compression method: stored
    localHeader.writeUInt16LE(DOS_TIME, 10);
    localHeader.writeUInt16LE(DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18); // compressed size
    localHeader.writeUInt32LE(dataBuffer.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28); // extra field length

    localParts.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); // central directory file header signature
    centralHeader.writeUInt16LE(20, 4); // version made by
    centralHeader.writeUInt16LE(20, 6); // version needed to extract
    centralHeader.writeUInt16LE(UTF8_NAME_FLAG, 8); // general purpose flag
    centralHeader.writeUInt16LE(0, 10); // compression method: stored
    centralHeader.writeUInt16LE(DOS_TIME, 12);
    centralHeader.writeUInt16LE(DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20); // compressed size
    centralHeader.writeUInt32LE(dataBuffer.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30); // extra field length
    centralHeader.writeUInt16LE(0, 32); // file comment length
    centralHeader.writeUInt16LE(0, 34); // disk number start
    centralHeader.writeUInt16LE(0, 36); // internal file attributes
    centralHeader.writeUInt32LE(0, 38); // external file attributes
    centralHeader.writeUInt32LE(offset, 42); // relative offset of local header

    centralParts.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const centralDirectoryOffset = offset;

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  endRecord.writeUInt16LE(0, 4); // disk number
  endRecord.writeUInt16LE(0, 6); // disk with central directory
  endRecord.writeUInt16LE(entries.length, 8); // entries on this disk
  endRecord.writeUInt16LE(entries.length, 10); // total entries
  endRecord.writeUInt32LE(centralDirectory.length, 12); // central directory size
  endRecord.writeUInt32LE(centralDirectoryOffset, 16); // central directory offset
  endRecord.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...localParts, centralDirectory, endRecord]);
}
