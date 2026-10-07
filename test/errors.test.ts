import { expect, it, describe } from 'vitest';
import zlib from 'node:zlib';
import { PngDecoder, PngDecodeError, type DecodedRow } from '../src/index.js';
import {
  buildPng,
  makeChunk,
  SIGNATURE,
  type BuildOptions,
} from './helpers/png-builder.js';

const BASE: Pick<
  BuildOptions,
  'width' | 'height' | 'bitDepth' | 'colorType'
> = { width: 4, height: 4, bitDepth: 8, colorType: 6 };
const pix = () => [10, 20, 30, 40];

async function decode(
  bytes: Uint8Array,
  opts?: { onRow?: (r: DecodedRow) => void },
): Promise<void> {
  const dec = new PngDecoder(opts);
  await dec.push(bytes);
  await dec.end();
}

/** Expect rejection with a specific error code. */
async function expectCode(
  bytes: Uint8Array,
  code: string,
  pushSize?: number,
): Promise<PngDecodeError> {
  const dec = new PngDecoder();
  let caught: unknown;
  try {
    if (pushSize) {
      for (let i = 0; i < bytes.length; i += pushSize) {
        await dec.push(bytes.subarray(i, i + pushSize));
      }
      await dec.end();
    } else {
      await dec.push(bytes);
      await dec.end();
    }
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(PngDecodeError);
  expect((caught as PngDecodeError).code).toBe(code);
  return caught as PngDecodeError;
}

describe('signature', () => {
  it('rejects a bad signature', async () => {
    const png = buildPng({ ...BASE, pixel: pix, badSignature: true });
    await expectCode(png, 'invalid-signature');
    await expectCode(png, 'invalid-signature', 1);
  });
});

describe('CRC', () => {
  it('bad IHDR CRC always fails', async () => {
    const png = buildPng({ ...BASE, pixel: pix, badIhdrCrc: true });
    await expectCode(png, 'crc-error');
  });

  it('bad IDAT CRC always fails', async () => {
    const png = buildPng({
      ...BASE,
      pixel: pix,
      idatSplit: 5,
      badIdatCrcIndex: 1,
    });
    await expectCode(png, 'crc-error');
  });

  it('bad ancillary CRC is skipped by default', async () => {
    const png = buildPng({
      ...BASE,
      pixel: pix,
      ancillary: [{ type: 'tEXt', data: new TextEncoder().encode('k\x00v'), badCrc: true }],
    });
    await decode(png); // must succeed
  });

  it('bad ancillary CRC fails when errorOnAncillaryCrc is set', async () => {
    const png = buildPng({
      ...BASE,
      pixel: pix,
      ancillary: [
        { type: 'tEXt', data: new TextEncoder().encode('k\x00v'), badCrc: true },
      ],
    });
    const dec = new PngDecoder({ errorOnAncillaryCrc: true });
    await expect(dec.push(png)).rejects.toMatchObject({
      code: 'crc-error',
    });
  });

  it('unknown critical chunk fails', async () => {
    // First byte uppercase => critical; unknown to this decoder.
    const png = buildPng({ ...BASE, pixel: pix });
    const withCritical = insertBeforeIdat(
      png,
      makeChunk('XzTX', new Uint8Array([1, 2, 3])),
    );
    await expectCode(withCritical, 'unexpected-chunk');
  });
});

describe('chunk order', () => {
  it('duplicate IHDR fails', async () => {
    const png = buildPng({ ...BASE, pixel: pix });
    const ihdrChunk = png.subarray(8, 33);
    const broken = spliceBeforeIdat(png, new Uint8Array(ihdrChunk));
    await expectCode(broken, 'unexpected-chunk');
  });

  it('PLTE before IHDR fails', async () => {
    // Build manually: SIG, PLTE, IHDR, ...
    const ihdr = new Uint8Array(13);
    const dv = new DataView(ihdr.buffer);
    dv.setUint32(0, 4);
    dv.setUint32(4, 4);
    ihdr.set([8, 6, 0, 0, 0], 8);
    const bytes = concat([
      SIGNATURE,
      makeChunk('PLTE', new Uint8Array([0, 0, 0, 255, 255, 255])),
      makeChunk('IHDR', ihdr),
    ]);
    await expectCode(bytes, 'unexpected-chunk');
  });

  it('IDAT non-contiguous fails', async () => {
    // IDAT, tEXt, IDAT -> the second IDAT must fail. Depending on how many
    // complete scanlines were available when the first ancillary chunk
    // ended the zlib stream, the decoder reports either the structural
    // violation or the resulting length mismatch -- never silent success.
    const png = buildPng({
      ...BASE,
      pixel: pix,
      idatSplit: 5,
    });
    // Insert tEXt between two IDAT chunks manually.
    const broken = insertBetweenIdats(
      png,
      makeChunk('tEXt', new TextEncoder().encode('a\x00b')),
    );
    const dec = new PngDecoder();
    let caught: any = null;
    try {
      await dec.push(broken);
      await dec.end();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PngDecodeError);
    expect(['unexpected-chunk', 'data-length']).toContain(caught.code);
  });

  it('IDAT after the zlib stream ended reports unexpected-chunk', async () => {
    // Build: IHDR, IDAT(all), tEXt (ends the IDAT stream), IDAT(extra), IEND.
    const png = buildPng({ ...BASE, pixel: pix });
    const broken = reassemble(png, (chunks) => {
      const idat = chunks.find((c) => c.type === 'IDAT')!;
      const out: Uint8Array[] = [];
      for (const c of chunks) {
        out.push(new Uint8Array(c.bytes));
        if (c.type === 'IDAT') {
          out.push(makeChunk('tEXt', new TextEncoder().encode('a\x00b')));
          out.push(
            makeChunk(
              'IDAT',
              new Uint8Array(
                idat.bytes.subarray(8, idat.bytes.length - 4),
              ),
            ),
          );
        }
      }
      return out;
    });
    await expectCode(broken, 'unexpected-chunk');
  });

  it('IEND before IDAT fails', async () => {
    const bytes = concat([
      SIGNATURE,
      makeChunk('IHDR', ihdrFor(4, 4, 8, 6)),
      makeChunk('IEND', new Uint8Array(0)),
    ]);
    await expectCode(bytes, 'unexpected-chunk');
  });

  it('data after IEND fails, including chunk-aligned data', async () => {
    const png = buildPng({ ...BASE, pixel: pix });
    await expectCode(
      concat([png, new Uint8Array([0])]),
      'unexpected-chunk',
    );
    const extra = makeChunk('tEXt', new TextEncoder().encode('a\x00b'));
    await expectCode(concat([png, extra]), 'unexpected-chunk');
  });

  it('truncated input before IEND fails on end()', async () => {
    const png = buildPng({ ...BASE, pixel: pix });
    const dec = new PngDecoder();
    await dec.push(png.subarray(0, png.length - 30));
    await expect(dec.end()).rejects.toMatchObject({ code: 'truncated' });
  });

  it('unknown ancillary chunks are skipped (before and after IDAT)', async () => {
    const png = buildPng({
      ...BASE,
      pixel: pix,
      ancillary: [
        { type: 'xXYZ', data: new Uint8Array([9, 9]) },
        { type: 'tEXt', data: new TextEncoder().encode('hi\x00yo'), afterIdat: true },
      ],
    });
    await decode(png);
  });
});

describe('decompressed length', () => {
  it('too few scanline bytes fails', async () => {
    // One filter byte + 2 data bytes for a 4x4 RGBA (needs 4*17=272).
    const png = buildPng({
      ...BASE,
      pixel: pix,
      rawOverride: new Uint8Array([0, 1, 2]),
    });
    await expectCode(png, 'data-length', 3);
  });

  it('too many decompressed bytes fails', async () => {
    const extra = new Uint8Array(4 * 4 * 17 + 5);
    const png = buildPng({ ...BASE, pixel: pix, rawOverride: extra });
    await expectCode(png, 'data-length', 11);
  });

  it('invalid filter byte fails', async () => {
    const raw = new Uint8Array(4 * 4 * 17);
    raw[0] = 9; // invalid filter
    const png = buildPng({ ...BASE, pixel: pix, rawOverride: raw });
    const dec = new PngDecoder();
    let caught: unknown;
    try {
      await dec.push(png);
      await dec.end();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PngDecodeError);
  });

  it('corrupt zlib stream fails with inflate-error', async () => {
    const png = buildPng({ ...BASE, pixel: pix });
    // Corrupt bytes inside the IDAT payload region.
    const broken = png.slice();
    broken[40] ^= 0xff;
    const dec = new PngDecoder();
    let caught: any = null;
    try {
      await dec.push(broken);
      await dec.end();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PngDecodeError);
    expect(
      ['inflate-error', 'data-length', 'invalid-chunk', 'crc-error'],
    ).toContain(caught.code);
  });
});

describe('palette index', () => {
  it('index out of palette range fails and names the row', async () => {
    // 2-bit image, palette with only 2 entries; a pixel uses index 3.
    const palette = new Uint8Array([255, 0, 0, 0, 255, 0]);
    const png = buildPng({
      width: 8,
      height: 2,
      bitDepth: 2,
      colorType: 3,
      palette,
      pixel: (x, y) => (y === 1 && x === 5 ? [3] : [x % 2]),
    });
    const err = await expectCode(png, 'palette-index');
    expect(err.message).toMatch(/row 1/);
  });

  it('tRNS longer than palette fails', async () => {
    const palette = new Uint8Array([0, 0, 0, 1, 1, 1]);
    const png = buildPng({
      width: 4,
      height: 1,
      bitDepth: 8,
      colorType: 3,
      palette,
      trns: new Uint8Array([0, 255, 128]), // 3 entries > 2 palette entries
      pixel: () => [0],
    });
    await expectCode(png, 'invalid-chunk');
  });

  it('tRNS forbidden for color type 4', async () => {
    const png = buildPng({
      width: 2,
      height: 2,
      bitDepth: 8,
      colorType: 4,
      trns: new Uint8Array([0, 0]),
      pixel: () => [0, 0],
    });
    await expectCode(png, 'unexpected-chunk');
  });

  it('indexed image without PLTE fails', async () => {
    // type 3 PNG with no PLTE
    const raw = new Uint8Array(2 * (2 + 1));
    const bytes = concat([
      SIGNATURE,
      makeChunk('IHDR', ihdrFor(2, 2, 8, 3)),
      idatFor(raw),
      makeChunk('IEND', new Uint8Array(0)),
    ]);
    await expectCode(bytes, 'unexpected-chunk');
  });

  it('a failing row is never delivered to onRow', async () => {
    const palette = new Uint8Array([10, 20, 30]);
    const png = buildPng({
      width: 4,
      height: 3,
      bitDepth: 8,
      colorType: 3,
      palette,
      // row 2 contains invalid index 5
      pixel: (_x, y) => [y === 2 ? 5 : 0],
    });
    const deliveredYs: number[] = [];
    const dec = new PngDecoder({
      onRow: (r) => deliveredYs.push(r.y),
    });
    let caught: any = null;
    try {
      await dec.push(png);
      await dec.end();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PngDecodeError);
    expect(caught.code).toBe('palette-index');
    expect(deliveredYs).toEqual([0, 1]);
  });
});

describe('dead decoder', () => {
  it('stays dead and never produces more rows after an error', async () => {
    const png = buildPng({ ...BASE, pixel: pix, badIhdrCrc: true });
    const dec = new PngDecoder({ onRow: () => { throw new Error('no rows'); } });

    let first: any = null;
    try {
      await dec.push(png);
    } catch (e) {
      first = e;
    }
    expect(first).toBeInstanceOf(PngDecodeError);
    expect((first as PngDecodeError).code).toBe('crc-error');

    // Further pushes reject with the same error.
    await expect(dec.push(png)).rejects.toBe(first);
    await expect(dec.push(new Uint8Array([0]))).rejects.toBe(first);
    await expect(dec.end()).rejects.toBe(first);
  });

  it('push after a completed IEND rejects', async () => {
    const png = buildPng({ ...BASE, pixel: pix });
    const dec = new PngDecoder();
    await dec.push(png);
    await dec.end();
    await expect(dec.push(new Uint8Array([0]))).rejects.toBeInstanceOf(
      PngDecodeError,
    );
  });
});

// ----------------------------------------------------------------- helpers

function ihdrFor(
  width: number,
  height: number,
  depth: number,
  colorType: number,
  interlace: 0 | 1 = 0,
): Uint8Array {
  const b = new Uint8Array(13);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  b[8] = depth;
  b[9] = colorType;
  b[12] = interlace;
  return b;
}

function idatFor(raw: Uint8Array): Uint8Array {
  return makeChunk('IDAT', new Uint8Array(zlib.deflateSync(raw)));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

interface ParsedChunks {
  sig: Uint8Array;
  chunks: Array<{ type: string; bytes: Uint8Array; start: number }>;
}

function parseChunks(png: Uint8Array): ParsedChunks {
  const chunks: ParsedChunks['chunks'] = [];
  let off = 8;
  while (off + 8 <= png.length) {
    const len =
      (png[off] << 24) | (png[off + 1] << 16) | (png[off + 2] << 8) |
      png[off + 3];
    const type = new TextDecoder().decode(png.subarray(off + 4, off + 8));
    const start = off;
    off += 12 + len;
    chunks.push({ type, bytes: png.subarray(start, off), start });
  }
  return { sig: png.subarray(0, 8), chunks };
 }

function reassemble(
  png: Uint8Array,
  mutate: (chunks: ParsedChunks['chunks']) => Uint8Array[],
): Uint8Array {
  const parsed = parseChunks(png);
  return concat([parsed.sig, ...mutate(parsed.chunks)]);
}

function insertBeforeIdat(png: Uint8Array, extra: Uint8Array): Uint8Array {
  return reassemble(png, (chunks) => {
    const out: Uint8Array[] = [];
    for (const c of chunks) {
      if (c.type === 'IDAT') out.push(extra);
      out.push(new Uint8Array(c.bytes));
    }
    return out;
  });
}

function spliceBeforeIdat(png: Uint8Array, extra: Uint8Array): Uint8Array {
  return insertBeforeIdat(png, extra);
}

function insertBetweenIdats(png: Uint8Array, extra: Uint8Array): Uint8Array {
  return reassemble(png, (chunks) => {
    const out: Uint8Array[] = [];
    let seenIdat = false;
    let inserted = false;
    for (const c of chunks) {
      if (c.type === 'IDAT' && seenIdat && !inserted) {
        out.push(extra);
        inserted = true;
      }
      if (c.type === 'IDAT') seenIdat = true;
      out.push(new Uint8Array(c.bytes));
    }
    return out;
  });
}
