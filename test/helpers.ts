import { Buffer } from 'node:buffer';
import { deflateSync } from 'node:zlib';
import { crc32 } from '../src/crc.js';
import type { PNGColorType } from '../src/index.js';

export const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

export interface TestChunk {
  type: string;
  data: Uint8Array;
  /** Override CRC (to inject corrupt-CRC cases). */
  crc?: number;
}

export function chunk(type: string, data: Uint8Array = new Uint8Array(0)): TestChunk {
  return { type, data };
}

export function ihdr(
  width: number,
  height: number,
  bitDepth: number,
  colorType: PNGColorType,
  interlace: 0 | 1 = 0,
): TestChunk {
  const data = new Uint8Array(13);
  const view = new DataView(data.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  data[8] = bitDepth;
  data[9] = colorType;
  data[10] = 0; // compression
  data[11] = 0; // filter
  data[12] = interlace;
  return chunk('IHDR', data);
}

export function paletteChunk(rgb: Array<[number, number, number]>): TestChunk {
  const data = new Uint8Array(rgb.length * 3);
  rgb.forEach(([r, g, b], i) => {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  });
  return chunk('PLTE', data);
}

export function trnsChunk(alphaOrRaw: Uint8Array | number[]): TestChunk {
  const data =
    alphaOrRaw instanceof Uint8Array ? alphaOrRaw : Uint8Array.from(alphaOrRaw);
  return chunk('tRNS', data);
}

/**
 * Encode stored scanlines (packed samples without a filter byte) with
 * filter type 0 prepended to every row. Multiple IDAT chunks are emitted
 * when asked.
 */
export function idatChunks(
  rows: Uint8Array[],
  { splits = 1, level = 6 }: { splits?: number; level?: number } = {},
): TestChunk[] {
  const total = concat(rows.map((r) => concat([Uint8Array.of(0), r])));
  const compressed = deflateSync(Buffer.from(total.buffer, total.byteOffset, total.byteLength), {
    level,
  });
  const pieces: TestChunk[] = [];
  const per = Math.ceil(compressed.length / splits);
  for (let i = 0; i < compressed.length; i += per) {
    pieces.push(chunk('IDAT', new Uint8Array(compressed.subarray(i, i + per))));
  }
  return pieces;
}

/** Deflate rows that already carry their own filter bytes. */
export function idatFromFiltered(
  filteredRows: Uint8Array[],
): TestChunk[] {
  const total = concat(filteredRows);
  const compressed = deflateSync(Buffer.from(total.buffer, total.byteOffset, total.byteLength));
  return [chunk('IDAT', new Uint8Array(compressed))];
}

export function buildPNG(chunks: TestChunk[], signature = SIGNATURE): Uint8Array {
  const out: Uint8Array[] = [signature];
  for (const c of chunks) {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, c.data.length);
    for (let i = 0; i < 4; i++) head[4 + i] = c.type.charCodeAt(i);
    out.push(head, c.data);
    const crc = new Uint8Array(4);
    const crcVal = c.crc ?? crc32(concat([head.subarray(4, 8), c.data]));
    new DataView(crc.buffer).setUint32(0, crcVal);
    out.push(crc);
  }
  return concat(out);
}

export function standardPNG(
  width: number,
  height: number,
  bitDepth: number,
  colorType: PNGColorType,
  rawRows: Uint8Array[],
  extras: TestChunk[] = [],
  interlace: 0 | 1 = 0,
): Uint8Array {
  return buildPNG([
    ihdr(width, height, bitDepth, colorType, interlace),
    ...extras,
    ...idatChunks(rawRows),
    chunk('IEND'),
  ]);
}

export function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function corruptCrc(c: TestChunk): TestChunk {
  return { ...c, crc: (crc32(concat([encodeType(c.type), c.data])) ^ 0xffffffff) >>> 0 };
}

function encodeType(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  return out;
}

/** Pack tight samples (1/2/4-bit grayscale or indexed) into bytes. */
export function packBits(
  samples: number[],
  bitsPerSample: number,
): Uint8Array {
  const rowBytes = Math.ceil((samples.length * bitsPerSample) / 8);
  const out = new Uint8Array(rowBytes);
  const perByte = 8 / bitsPerSample;
  const mask = (1 << bitsPerSample) - 1;
  for (let i = 0; i < samples.length; i++) {
    const byteIndex = (i * bitsPerSample) >>> 3;
    const shift = 8 - ((i % perByte) + 1) * bitsPerSample;
    out[byteIndex] |= (samples[i]! & mask) << shift;
  }
  return out;
}

/** Build an unfiltered RGBA8 row. */
export function rgbaRow(pixels: Array<[number, number, number, number]>): Uint8Array {
  const out = new Uint8Array(pixels.length * 4);
  pixels.forEach(([r, g, b, a], i) => {
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = a;
  });
  return out;
}

/**
 * Generate an RGBA pattern uniquely determined by coordinates, so
 * interlaced vs non-interlaced images can be compared pixel by pixel.
 */
export function patternPixels(
  width: number,
  height: number,
): Array<Array<[number, number, number, number]>> {
  const rows: Array<Array<[number, number, number, number]>> = [];
  for (let y = 0; y < height; y++) {
    const row: Array<[number, number, number, number]> = [];
    for (let x = 0; x < width; x++) {
      row.push([
        (x * 31 + y * 17) & 0xff,
        (x * 7 + y * 53) & 0xff,
        (x * 13 + y * 3) & 0xff,
        ((x ^ y) & 0xff) | (x === y ? 1 : 0),
      ]);
    }
    rows.push(row);
  }
  return rows;
}

/** Pick pixels of an Adam7 pass from a full RGBA pixel grid. */
export function passRows(
  allRows: number[][][],
  xStart: number,
  yStart: number,
  xStep: number,
  yStep: number,
  channels: 4,
): number[][] {
  const out: number[][] = [];
  for (let y = yStart; y < allRows.length; y += yStep) {
    const pixels: number[] = [];
    for (let x = xStart; x < allRows[0]!.length; x += xStep) {
      for (let c = 0; c < channels; c++) pixels.push(allRows[y]![x]![c]!);
    }
    out.push(pixels);
  }
  return out;
}

/** Split a buffer into single-byte pushes for torture tests. */
export function* eachByte(data: Uint8Array): Generator<Uint8Array> {
  for (let i = 0; i < data.length; i++) yield data.subarray(i, i + 1);
}
