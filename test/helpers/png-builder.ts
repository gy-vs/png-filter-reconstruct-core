import zlib from 'node:zlib';
import { Crc32 } from '../../src/crc.js';
import { adam7Passes } from '../../src/adam7.js';
import { paeth } from '../../src/filter.js';

export const SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface AncillarySpec {
  type: string;
  data: Uint8Array;
  /** Place after the IDAT stream instead of before it. */
  afterIdat?: boolean;
  /** Emit a deliberately wrong CRC. */
  badCrc?: boolean;
}

export interface BuildOptions {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace?: 0 | 1;
  /** RGB triplets (color type 3). */
  palette?: Uint8Array;
  trns?: Uint8Array;
  /**
   * Samples for pixel (x, y): gray -> [v], rgb -> [r,g,b], indexed -> [i],
   * gray+alpha -> [v,a], rgba -> [r,g,b,a]. Samples in their native depth.
   */
  pixel: (x: number, y: number) => number[];
  /** Filter type for each generated scanline. */
  filter?: number | ((pass: number, y: number) => number);
  ancillary?: AncillarySpec[];
  /** Split the zlib stream into IDAT chunks of at most this many bytes. */
  idatSplit?: number;
  /** Corrupt the CRC of the nth IDAT chunk (0-based). */
  badIdatCrcIndex?: number;
  /** Corrupt the IHDR CRC. */
  badIhdrCrc?: boolean;
  /** Don't emit IEND. */
  omitIend?: boolean;
  /** Append junk after IEND. */
  junkAfterIend?: Uint8Array;
  /** Corrupt the signature. */
  badSignature?: boolean;
  /**
   * Override the bytes fed to zlib (e.g. invalid filter bytes or wrong
   * length); disables raw generation.
   */
  rawOverride?: Uint8Array;
}

const CHANNELS: Record<number, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

function encodeType(type: string): Uint8Array {
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = type.charCodeAt(i);
  return out;
}

export function makeChunk(
  type: string,
  data: Uint8Array,
  badCrc = false,
): Uint8Array {
  const typeBytes = encodeType(type);
  const crc = badCrc
    ? (Crc32.chunk(typeBytes, data) ^ 0xffff) >>> 0
    : Crc32.chunk(typeBytes, data);
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc);
  return out;
}

function packSamples(
  samples: number[][],
  bitDepth: number,
): Uint8Array {
  if (bitDepth >= 8) {
    const out = new Uint8Array(samples.length * samples[0].length * (bitDepth / 8));
    let o = 0;
    for (const s of samples) {
      for (const v of s) {
        if (bitDepth === 16) {
          out[o++] = (v >>> 8) & 0xff;
          out[o++] = v & 0xff;
        } else {
          out[o++] = v & 0xff;
        }
      }
    }
    return out;
  }
  const out = new Uint8Array(Math.ceil(samples.length / (8 / bitDepth)));
  samples.forEach((s, x) => {
    const v = s[0] & ((1 << bitDepth) - 1);
    const shift = 8 - bitDepth - bitDepth * (x % (8 / bitDepth));
    out[Math.floor(x / (8 / bitDepth))] |= v << shift;
  });
  return out;
}

function forwardFilter(
  raw: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  filter: number,
): Uint8Array {
  const out = new Uint8Array(raw.length + 1);
  out[0] = filter;
  for (let i = 0; i < raw.length; i++) {
    const a = i >= bpp ? raw[i - bpp] : 0;
    const b = prev ? prev[i] : 0;
    const c = prev && i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    switch (filter) {
      case 0:
        pred = 0;
        break;
      case 1:
        pred = a;
        break;
      case 2:
        pred = b;
        break;
      case 3:
        pred = (a + b) >> 1;
        break;
      case 4:
        pred = paeth(a, b, c);
        break;
      default:
        throw new Error(`bad filter ${filter} in test helper`);
    }
    out[i + 1] = (raw[i] - pred) & 0xff;
  }
  return out;
}

/** Build the filtered, possibly interlaced, zlib payload of a PNG. */
export function buildRaw(
  opts: Pick<
    BuildOptions,
    'width' | 'height' | 'bitDepth' | 'colorType' | 'interlace' | 'pixel' | 'filter'
  >,
): Uint8Array {
  const { width, height, bitDepth, colorType } = opts;
  const channels = CHANNELS[colorType];
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
  const filterOf =
    typeof opts.filter === 'function'
      ? opts.filter
      : () => opts.filter ?? 0;

  const passes =
    opts.interlace === 1
      ? adam7Passes(width, height).filter((p) => p.width > 0 && p.height > 0)
      : [
          {
            pass: 0,
            xStart: 0,
            yStart: 0,
            xStep: 1,
            yStep: 1,
            width,
            height,
          },
        ];

  const parts: Uint8Array[] = [];
  for (const p of passes) {
    let prev: Uint8Array | null = null;
    for (let y = 0; y < p.height; y++) {
      const samples: number[][] = [];
      for (let x = 0; x < p.width; x++) {
        samples.push(
          opts.pixel(p.xStart + x * p.xStep, p.yStart + y * p.yStep),
        );
      }
      const raw = packSamples(samples, bitDepth);
      const filtered = forwardFilter(
        raw,
        prev,
        bpp,
        filterOf(p.pass, y) & 0xff,
      );
      parts.push(filtered);
      prev = raw;
    }
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function buildPng(opts: BuildOptions): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, opts.width);
  dv.setUint32(4, opts.height);
  ihdr[8] = opts.bitDepth;
  ihdr[9] = opts.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = opts.interlace ?? 0;

  const raw = opts.rawOverride ?? buildRaw(opts);
  const compressed = zlib.deflateSync(raw);

  const beforeAnc = (opts.ancillary ?? []).filter((a) => !a.afterIdat);
  const afterAnc = (opts.ancillary ?? []).filter((a) => a.afterIdat);

  const chunks: Uint8Array[] = [];
  chunks.push(makeChunk('IHDR', ihdr, opts.badIhdrCrc));
  if (opts.palette) chunks.push(makeChunk('PLTE', opts.palette));
  if (opts.trns) chunks.push(makeChunk('tRNS', opts.trns));
  for (const a of beforeAnc) chunks.push(makeChunk(a.type, a.data, a.badCrc));

  const split = opts.idatSplit ?? compressed.length;
  let idatIndex = 0;
  for (let off = 0; off < compressed.length; off += split) {
    const piece = compressed.subarray(off, Math.min(off + split, compressed.length));
    chunks.push(
      makeChunk(
        'IDAT',
        new Uint8Array(piece),
        opts.badIdatCrcIndex === idatIndex,
      ),
    );
    idatIndex++;
  }

  for (const a of afterAnc) chunks.push(makeChunk(a.type, a.data, a.badCrc));

  if (!opts.omitIend) chunks.push(makeChunk('IEND', new Uint8Array(0)));
  if (opts.junkAfterIend) chunks.push(opts.junkAfterIend);

  const sig = opts.badSignature
    ? new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0])
    : SIGNATURE;

  const total =
    sig.length + chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let o = sig.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Deterministic pseudo-pixel generator for benchmarks. */
export function patternPixel(x: number, y: number): number[] {
  const v = (x * 131 + y * 197 + (x ^ y) * 7) & 0xff;
  return [v, (v + 50) & 0xff, (255 - v) & 0xff, ((x + y) & 1) ? 255 : 200];
}

export interface StreamingPngHandle {
  prefix: Uint8Array;
  /** IDAT pieces (caller pushes each as its own chunk or concatenates). */
  idatPieces: Uint8Array[];
  tail: Uint8Array;
}

/**
 * Build a large RGBA8 PNG without ever materializing the full raw image:
 * scanlines are generated one at a time and streamed through deflate.
 * The compressed output is split into IDAT-sized pieces <= maxPiece.
 */
export async function buildLargeRgbaPng(
  width: number,
  height: number,
  maxPiece = 8192,
  pixel: (x: number, y: number) => number[] = patternPixel,
): Promise<StreamingPngHandle> {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr.set([8, 6, 0, 0, 0], 8);

  const deflater = zlib.createDeflate({ level: 6 });
  const pieces: Uint8Array[] = [];
  let current = new Uint8Array(maxPiece);
  let used = 0;
  const ingest = (input0: Buffer): void => {
    let input = new Uint8Array(input0);
    while (input.length > 0) {
      const room = maxPiece - used;
      if (input.length <= room) {
        current.set(input, used);
        used += input.length;
        input = new Uint8Array(0);
      } else {
        current.set(input.subarray(0, room), used);
        pieces.push(current);
        current = new Uint8Array(maxPiece);
        used = 0;
        input = input.subarray(room);
      }
    }
  };
  deflater.on('data', (c: Buffer) => ingest(c));

  const write = (b: Uint8Array): Promise<void> =>
    new Promise((res, rej) =>
      (deflater as zlib.Deflate).write(b, (e) => (e ? rej(e) : res())),
    );
  const flush = (): Promise<void> =>
    new Promise((res, rej) =>
      deflater.flush(zlib.Z_SYNC_FLUSH, (e) => (e ? rej(e) : res())),
    );

  // Accumulate several scanlines into one write to avoid per-line async
  // overhead when generating very tall images.
  const BATCH = 128;
  const batch = new Uint8Array((1 + width * 4) * BATCH);
  let batched = 0;
  const line = new Uint8Array(1 + width * 4);

  const emitLine = async (): Promise<void> => {
    batch.set(line, (1 + width * 4) * batched);
    batched++;
    if (batched === BATCH) await flushBatch();
  };
  const flushBatch = async (): Promise<void> => {
    if (batched === 0) return;
    const bytes = batch.subarray(0, (1 + width * 4) * batched);
    await write(bytes);
    await flush();
    batched = 0;
  };

  for (let y = 0; y < height; y++) {
    line[0] = 0; // filter None
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = 1 + x * 4;
      line[o] = r;
      line[o + 1] = g;
      line[o + 2] = b;
      line[o + 3] = a;
    }
    await emitLine();
  }
  await flushBatch();
  await new Promise<void>((res, rej) =>
    deflater.end((e) => (e ? rej(e) : res())),
  );
  if (used > 0) pieces.push(current.subarray(0, used));

  const prefix = concatBytes([SIGNATURE, makeChunk('IHDR', ihdr)]);
  const tail = makeChunk('IEND', new Uint8Array(0));
  return { prefix, idatPieces: pieces, tail };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Push a streaming PNG into a decoder one IDAT piece at a time. */
export async function pushStreamingPng(
  decoder: { push: (d: Uint8Array) => Promise<unknown>; end: () => Promise<unknown> },
  handle: StreamingPngHandle,
): Promise<void> {
  await decoder.push(handle.prefix);
  for (const piece of handle.idatPieces) {
    await decoder.push(makeChunk('IDAT', piece));
  }
  await decoder.push(handle.tail);
  await decoder.end();
}

/** Split a byte array into variable-size chunks for streaming tests. */
export function chunkBytes(
  data: Uint8Array,
  rng: () => number,
  maxChunk = 300,
): Uint8Array[] {
  const out: Uint8Array[] = [];
  let off = 0;
  while (off < data.length) {
    const n = Math.min(
      data.length - off,
      1 + Math.floor(rng() * maxChunk),
    );
    out.push(data.subarray(off, off + n));
    off += n;
  }
  return out;
}

/** Simple deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
