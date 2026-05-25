import { zonedDateTimeToUtc } from './businessTime.js';

const EXIF_DATE_TAGS = new Set([0x0132, 0x9003, 0x9004]);
const EXIF_SUB_IFD_POINTER = 0x8769;

export function readExifCapturedAt(buffer: Buffer): Date | null {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return null;
  }

  let offset = 2;

  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) break;

    const marker = buffer[offset + 1];
    if (marker === 0xda || marker === 0xd9) break;

    const segmentLength = buffer.readUInt16BE(offset + 2);
    if (segmentLength < 2) break;

    const payloadStart = offset + 4;
    const payloadEnd = offset + 2 + segmentLength;
    if (payloadEnd > buffer.length) break;

    if (
      marker === 0xe1 &&
      payloadStart + 6 <= buffer.length &&
      buffer.subarray(payloadStart, payloadStart + 6).toString('ascii') === 'Exif\0\0'
    ) {
      return parseTiffData(buffer.subarray(payloadStart + 6, payloadEnd));
    }

    offset = payloadEnd;
  }

  return null;
}

function parseTiffData(buffer: Buffer): Date | null {
  if (buffer.length < 8) return null;

  const byteOrder = buffer.subarray(0, 2).toString('ascii');
  if (byteOrder !== 'II' && byteOrder !== 'MM') return null;

  const readUInt16 = (offset: number) =>
    byteOrder === 'II' ? buffer.readUInt16LE(offset) : buffer.readUInt16BE(offset);
  const readUInt32 = (offset: number) =>
    byteOrder === 'II' ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);

  if (readUInt16(2) !== 42) return null;

  const queue = [readUInt32(4)];
  const visited = new Set<number>();

  while (queue.length > 0) {
    const directoryOffset = queue.shift() ?? 0;
    if (
      directoryOffset <= 0 ||
      visited.has(directoryOffset) ||
      directoryOffset + 2 > buffer.length
    ) {
      continue;
    }

    visited.add(directoryOffset);

    const entryCount = readUInt16(directoryOffset);
    for (let index = 0; index < entryCount; index += 1) {
      const entryOffset = directoryOffset + 2 + index * 12;
      if (entryOffset + 12 > buffer.length) break;

      const tag = readUInt16(entryOffset);
      const type = readUInt16(entryOffset + 2);
      const count = readUInt32(entryOffset + 4);

      if (tag === EXIF_SUB_IFD_POINTER) {
        queue.push(readUInt32(entryOffset + 8));
        continue;
      }

      if (!EXIF_DATE_TAGS.has(tag)) continue;

      const raw = readAsciiTagValue(buffer, entryOffset, type, count, readUInt32);
      if (!raw) continue;

      const parsed = parseExifDate(raw);
      if (parsed) return parsed;
    }

    const nextDirectoryOffset = directoryOffset + 2 + entryCount * 12;
    if (nextDirectoryOffset + 4 <= buffer.length) {
      const next = readUInt32(nextDirectoryOffset);
      if (next > 0) {
        queue.push(next);
      }
    }
  }

  return null;
}

function readAsciiTagValue(
  buffer: Buffer,
  entryOffset: number,
  type: number,
  count: number,
  readUInt32: (offset: number) => number,
): string | null {
  if (type !== 2 || count === 0) return null;

  const valueOffset = entryOffset + 8;
  if (count <= 4) {
    return buffer
      .subarray(valueOffset, valueOffset + count)
      .toString('ascii')
      .replace(/\0+$/g, '')
      .trim();
  }

  const dataOffset = readUInt32(valueOffset);
  if (dataOffset + count > buffer.length) return null;

  return buffer
    .subarray(dataOffset, dataOffset + count)
    .toString('ascii')
    .replace(/\0+$/g, '')
    .trim();
}

function parseExifDate(raw: string): Date | null {
  const match = raw.match(
    /^(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/,
  );

  if (!match) return null;

  const [, year, month, day, hour, minute, second] = match;
  return zonedDateTimeToUtc(
    Number.parseInt(year, 10),
    Number.parseInt(month, 10),
    Number.parseInt(day, 10),
    Number.parseInt(hour, 10),
    Number.parseInt(minute, 10),
    Number.parseInt(second, 10),
  );
}
