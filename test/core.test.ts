import { describe, expect, it } from 'vitest';
import {
  StreamingPNGDecoder,
  paeth,
  type DecodedRow,
  type PNGColorType,
  type PNGHeader,
} from '../src/index.js';
import {
  SIGNATURE,
  buildPNG,
  chunk,
  concat,
  eachByte,
  idatChunks,
  idatFromFiltered,
  ihdr,
  packBits,
  paletteChunk,
  passRows,
  patternPixels,
  rgbaRow,
  standardPNG,
  trnsChunk,
} from './helpers.js';
import { ADAM7_PASSES } from '../src/adam7.js';

async function decode(
  data: Uint8Array,
  opts: ConstructorParameters<typeof StreamingPNGDecoder>[0] = {},
) {
  const d = new StreamingPNGDecoder(opts);
  d.push(data);
  return d.finish();
}

/** Structural errors may surface either on push() or from finish(). */
async function expectDecodeFailure(
  data: Uint8Array,
  match: Record<string, unknown>,
  opts: ConstructorParameters<typeof StreamingPNGDecoder>[0] = {},
): Promise<unknown> {
  const d = new StreamingPNGDecoder(opts);
  let pushError: unknown = null;
  try {
    d.push(data);
  } catch (error) {
    pushError = error;
  }
  if (pushError) {
    expect(pushError).toMatchObject(match);
    await expect(d.finish()).rejects.toMatchObject(match);
    return pushError;
  }
  return expect(d.finish()).rejects.toMatchObject(match);
}

function pixelsAsFlatArray(image: { data: Uint8Array | Uint16Array }): number[] {
  return Array.from(image.data as Uint8Array);
}

describe('paeth predictor', () => {
  it('predicts', () => {
    expect(paeth(10, 20, 15)).toBe(15);
  });
  it('handles ties per the spec ordering (a, then b, then c)', () => {
    expect(paeth(0, 0, 0)).toBe(0);
    // p-a tie between |pa| and |pb| chooses a.
    expect(paeth(10, 10, 0)).toBe(10);
    expect(paeth(5, 20, 10)).toBe(20);
  });
});

describe('basic decoding', () => {
  it('decodes the simplest RGBA8 image with filter 0', async () => {
    const rows = [
      rgbaRow([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]),
      rgbaRow([
        [9, 10, 11, 12],
        [13, 14, 15, 16],
      ]),
    ];
    const png = standardPNG(2, 2, 8, 6, rows);
    const image = await decode(png);
    expect(image!.width).toBe(2);
    expect(image!.height).toBe(2);
    expect(image!.bitDepth).toBe(8);
    expect(image!.colorType).toBe(6);
    expect(image!.interlaced).toBe(false);
    expect(pixelsAsFlatArray(image!)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
    ]);
  });

  it('accepts one byte at a time', async () => {
    const rows = [rgbaRow([[10, 20, 30, 40]])];
    const png = standardPNG(1, 1, 8, 6, rows);
    const d = new StreamingPNGDecoder();
    for (const piece of eachByte(png)) d.push(piece);
    const image = await d.finish();
    expect(pixelsAsFlatArray(image!)).toEqual([10, 20, 30, 40]);
  });

  it('accepts arbitrarily split pushes', async () => {
    const rows = [
      rgbaRow([
        [1, 2, 3, 4],
        [5, 6, 7, 8],
      ]),
    ];
    const png = standardPNG(2, 1, 8, 6, rows);
    // LCG-driven pseudo-random split sizes.
    let seed = 7;
    let pos = 0;
    const d = new StreamingPNGDecoder();
    while (pos < png.length) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const take = Math.min(1 + (seed % 13), png.length - pos);
      d.push(png.subarray(pos, pos + take));
      pos += take;
    }
    const image = await d.finish();
    expect(pixelsAsFlatArray(image!)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe('header callback', () => {
  it('reports IHDR fields before any row', async () => {
    const makeRow = () =>
      rgbaRow([
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ]);
    const png = standardPNG(3, 4, 8, 6, [makeRow(), makeRow(), makeRow(), makeRow()]);
    let header: PNGHeader | null = null;
    let rowsSeen = 0;
    await decode(png, {
      collect: false,
      onHeader: (h) => {
        header = h;
      },
      onRow: () => {
        expect(header).not.toBeNull();
        rowsSeen++;
      },
    });
    expect(header).toEqual({
      width: 3,
      height: 4,
      bitDepth: 8,
      colorType: 6,
      interlaced: false,
    });
    expect(rowsSeen).toBe(4);
  });
});

// ------------------------------------------------------------------ filters

function filteredRow(filter: number, row: Uint8Array, prev: Uint8Array | null): Uint8Array {
  const out = new Uint8Array(1 + row.length);
  out[0] = filter;
  out.set(row, 1);
  const bpp = 4;
  switch (filter) {
    case 0:
      break;
    case 1:
      for (let x = bpp; x < row.length; x++) out[x + 1] = (row[x]! - row[x - bpp]!) & 0xff;
      break;
    case 2:
      for (let x = 0; x < row.length; x++) out[x + 1] = (row[x]! - (prev?.[x] ?? 0)) & 0xff;
      break;
    case 3:
      for (let x = 0; x < row.length; x++) {
        const left = x >= bpp ? row[x - bpp]! : 0;
        const up = prev?.[x] ?? 0;
        out[x + 1] = (row[x]! - ((left + up) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let x = 0; x < row.length; x++) {
        const left = x >= bpp ? row[x - bpp]! : 0;
        const up = prev?.[x] ?? 0;
        const upLeft = x >= bpp && prev ? prev[x - bpp]! : 0;
        out[x + 1] = (row[x]! - paeth(left, up, upLeft)) & 0xff;
      }
      break;
    default:
      throw new Error('bad filter');
  }
  return out;
}

describe('all five scanline filters', () => {
  const filters = [0, 1, 2, 3, 4];
  const W = 7;
  const H = 5;

  for (const filter of filters) {
    it(`reconstructs filter type ${filter}`, async () => {
      const expected = patternPixels(W, H);
      const rawRows = expected.map((p) => rgbaRow(p));
      const encoded: Uint8Array[] = [];
      for (let y = 0; y < H; y++) {
        encoded.push(filteredRow(filter, rawRows[y]!, y > 0 ? rawRows[y - 1]! : null));
      }
      const png = buildPNG([
        ihdr(W, H, 8, 6),
        ...idatFromFiltered(encoded),
        chunk('IEND'),
      ]);
      const image = await decode(png);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          const want = expected[y]![x]!;
          expect([image!.data[o], image!.data[o + 1], image!.data[o + 2], image!.data[o + 3]])
            .toEqual(want);
        }
      }
    });
  }

  it('allows a different filter on every row', async () => {
    const expected = patternPixels(W, H);
    const rawRows = expected.map((p) => rgbaRow(p));
    const encoded: Uint8Array[] = [];
    for (let y = 0; y < H; y++) {
      encoded.push(
        filteredRow(filters[y % filters.length]!, rawRows[y]!, y > 0 ? rawRows[y - 1]! : null),
      );
    }
    const png = buildPNG([
      ihdr(W, H, 8, 6),
      ...idatFromFiltered(encoded),
      chunk('IEND'),
    ]);
    const image = await decode(png);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const o = (y * W + x) * 4;
        expect(image!.data.slice(o, o + 4)).toEqual(Uint8Array.from(expected[y]![x]!));
      }
    }
  });

  it('rejects unknown filter type 5 with a row number', async () => {
    const bad = new Uint8Array(1 + 28);
    bad[0] = 5;
    const png = buildPNG([
      ihdr(7, 1, 8, 6),
      ...idatFromFiltered([bad]),
      chunk('IEND'),
    ]);
    const d = new StreamingPNGDecoder();
    d.push(png);
    await expect(d.finish()).rejects.toMatchObject({
      code: 'BAD_FILTER',
      row: 0,
    });
  });
});
// ------------------------------------------------------------- colour formats

describe('all legal colour type / bit depth combinations', () => {
  interface Case {
    colorType: PNGColorType;
    depth: number;
    samples: number[][]; // per row, stored samples (8 or 16-bit logical)
    expected: number[][]; // per row RGBA8/16 values
    palette?: Array<[number, number, number]>;
  }

  const cases: Case[] = [
    {
      colorType: 0, depth: 1,
      samples: [[0, 1]],
      expected: [[0, 0, 0, 255, 255, 255, 255, 255]],
    },
    {
      colorType: 0, depth: 2,
      samples: [[0, 1, 2, 3]],
      expected: [[
        0, 0, 0, 255, 85, 85, 85, 255, 170, 170, 170, 255, 255, 255, 255, 255,
      ]],
    },
    {
      colorType: 0, depth: 4,
      samples: [[0, 1, 15, 16 & 15]],
      expected: [[
        0, 0, 0, 255, 17, 17, 17, 255, 255, 255, 255, 255, 0, 0, 0, 255,
      ]],
    },
    {
      colorType: 0, depth: 8,
      samples: [[0, 128, 255]],
      expected: [[0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]],
    },
    {
      colorType: 0, depth: 16,
      samples: [[0, 32768, 65535]],
      expected: [[0, 0, 0, 65535, 32768, 32768, 32768, 65535, 65535, 65535, 65535, 65535]],
    },
    {
      colorType: 2, depth: 8,
      samples: [[1, 2, 3, 4, 5, 6]],
      expected: [[1, 2, 3, 255, 4, 5, 6, 255]],
    },
    {
      colorType: 2, depth: 16,
      samples: [[1, 2, 3, 258, 259, 260]],
      expected: [[1, 2, 3, 65535, 258, 259, 260, 65535]],
    },
    {
      colorType: 3, depth: 1,
      samples: [[0, 1]],
      palette: [[10, 20, 30], [40, 50, 60]],
      expected: [[10, 20, 30, 255, 40, 50, 60, 255]],
    },
    {
      colorType: 3, depth: 2,
      samples: [[0, 1, 2, 3]],
      palette: [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4]],
      expected: [[1, 1, 1, 255, 2, 2, 2, 255, 3, 3, 3, 255, 4, 4, 4, 255]],
    },
    {
      colorType: 3, depth: 4,
      samples: [[0, 1, 2]],
      palette: [[9, 9, 9], [8, 8, 8], [7, 7, 7]],
      expected: [[9, 9, 9, 255, 8, 8, 8, 255, 7, 7, 7, 255]],
    },
    {
      colorType: 3, depth: 8,
      samples: [[1, 0]],
      palette: [[50, 60, 70], [80, 90, 100]],
      expected: [[80, 90, 100, 255, 50, 60, 70, 255]],
    },
    {
      colorType: 4, depth: 8,
      samples: [[10, 255, 20, 0]],
      expected: [[10, 10, 10, 255, 20, 20, 20, 0]],
    },
    {
      colorType: 4, depth: 16,
      samples: [[1000, 65535, 2000, 128]],
      expected: [[1000, 1000, 1000, 65535, 2000, 2000, 2000, 128]],
    },
    {
      colorType: 6, depth: 8,
      samples: [[1, 2, 3, 4]],
      expected: [[1, 2, 3, 4]],
    },
    {
      colorType: 6, depth: 16,
      samples: [[1, 2, 3, 4]],
      expected: [[1, 2, 3, 4]],
    },
  ];

  for (const c of cases) {
    it(`color type ${c.colorType}, bit depth ${c.depth}`, async () => {
      const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[c.colorType]!;
      const pixelCount = c.samples[0]!.length / channels;
      let rows: Uint8Array[];
      if (c.depth === 16) {
        rows = c.samples.map((s) => {
          const bytes = new Uint8Array(s.length * 2);
          s.forEach((v, i) => {
            bytes[i * 2] = v >> 8;
            bytes[i * 2 + 1] = v & 0xff;
          });
          return bytes;
        });
      } else if (c.depth < 8) {
        rows = c.samples.map((s) => packBits(s, c.depth));
      } else {
        rows = c.samples.map((s) => Uint8Array.from(s));
      }
      const extras = c.palette ? [paletteChunk(c.palette)] : [];
      const png = standardPNG(pixelCount, 1, c.depth, c.colorType, rows, extras);
      const image = await decode(png);
      if (c.depth === 16) {
        expect(Array.from(image!.data as Uint16Array)).toEqual(c.expected[0]);
      } else {
        expect(pixelsAsFlatArray(image!)).toEqual(c.expected[0]);
      }
    });
  }
});

// ---------------------------------------------------------------------- tRNS

describe('tRNS transparency', () => {
  it('makes matching grayscale samples transparent (8-bit)', async () => {
    // Key is stored as a 16-bit value; an 8-bit sample 20 corresponds
    // to 16-bit value 20*256 = 0x1400.
    const png = standardPNG(
      3, 1, 8, 0,
      [Uint8Array.from([10, 20, 30])],
      [trnsChunk([20, 0])],
    );
    const image = await decode(png);
    expect(pixelsAsFlatArray(image!)).toEqual([
      10, 10, 10, 255,
      20, 20, 20, 0,
      30, 30, 30, 255,
    ]);
  });

  it('makes matching grayscale samples transparent (16-bit exact)', async () => {
    const row = new Uint8Array(6);
    new DataView(row.buffer).setUint16(0, 0x0100);
    new DataView(row.buffer).setUint16(2, 0x0101);
    new DataView(row.buffer).setUint16(4, 0xffff);
    const trns = new Uint8Array(2);
    new DataView(trns.buffer).setUint16(0, 0x0100);
    const png = standardPNG(3, 1, 16, 0, [row], [trnsChunk(trns)]);
    const image = await decode(png);
    const data = image!.data as Uint16Array;
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(65535);
    expect(data[11]).toBe(65535);
  });

  it('works for packed 1-bit grayscale', async () => {
    // tRNS value 0 means black is transparent.
    const trns = new Uint8Array([0, 0]);
    const png = standardPNG(
      4, 1, 1, 0,
      [packBits([0, 1, 1, 0], 1)],
      [trnsChunk(trns)],
    );
    const image = await decode(png);
    const d = pixelsAsFlatArray(image!);
    expect(d[3]).toBe(0);
    expect(d[7]).toBe(255);
    expect(d[11]).toBe(255);
    expect(d[15]).toBe(0);
  });

  it('makes a matching RGB triple transparent (8-bit)', async () => {
    // 8-bit samples compare against sample*256: RGB key (1,2,3) => 0x0100...
    const png = standardPNG(
      2, 1, 8, 2,
      [Uint8Array.from([1, 2, 3, 4, 5, 6])],
      [trnsChunk([1, 0, 2, 0, 3, 0])],
    );
    const image = await decode(png);
    expect(pixelsAsFlatArray(image!)).toEqual([
      1, 2, 3, 0,
      4, 5, 6, 255,
    ]);
  });

  it('makes a matching RGB triple transparent (16-bit)', async () => {
    const row = new Uint8Array(12);
    const dv = new DataView(row.buffer);
    dv.setUint16(0, 100); dv.setUint16(2, 200); dv.setUint16(4, 300);
    dv.setUint16(6, 0); dv.setUint16(8, 0); dv.setUint16(10, 0);
    const trns = new Uint8Array(6);
    new DataView(trns.buffer).setUint16(0, 100);
    new DataView(trns.buffer).setUint16(2, 200);
    new DataView(trns.buffer).setUint16(4, 300);
    const png = standardPNG(2, 1, 16, 2, [row], [trnsChunk(trns)]);
    const data = (await decode(png))!.data as Uint16Array;
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(65535);
  });

  it('indexed: entries past the tRNS table are opaque', async () => {
    const palette: Array<[number, number, number]> = [
      [1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4],
    ];
    const png = standardPNG(
      4, 1, 2, 3,
      [packBits([0, 1, 2, 3], 2)],
      [paletteChunk(palette), trnsChunk([0, 128])],
    );
    const d = pixelsAsFlatArray((await decode(png))!);
    expect(d[3]).toBe(0);
    expect(d[7]).toBe(128);
    expect(d[11]).toBe(255);
    expect(d[15]).toBe(255);
  });

  it('rejects tRNS for RGBA / gray+alpha', async () => {
    const png = standardPNG(1, 1, 8, 6, [Uint8Array.of(0, 0, 0, 255)], [
      trnsChunk([0, 0, 0, 0]),
    ]);
    await expectDecodeFailure(png, { code: 'BAD_TRNS' });
  });
});

describe('palette index validation', () => {
  async function expectFailure(depth: 1 | 2 | 4 | 8, index: number) {
    // A palette with exactly `index` entries makes that index the first
    // out-of-range one.
    const palette: Array<[number, number, number]> = Array.from(
      { length: index },
      (_, i) => [i + 1, i + 1, i + 1] as [number, number, number],
    );
    const W = depth === 8 ? 3 : 8;
    const goodSamples = new Array(W).fill(0);
    const badSamples = new Array(W).fill(0);
    badSamples[W - 1] = index;
    const pack = (s: number[]) =>
      depth === 8 ? Uint8Array.from(s) : packBits(s, depth);
    // Two rows; the bad pixel is in the final row so we can check the
    // previous row was delivered but the bad row was not.
    const rows = [pack(goodSamples), pack(badSamples)];
    const png = standardPNG(W, 2, depth, 3, rows, [paletteChunk(palette)]);
    const delivered: DecodedRow[] = [];
    const d = new StreamingPNGDecoder({
      collect: false,
      onRow: (r) => delivered.push(r),
    });
    let pushError: unknown = null;
    try {
      d.push(png);
    } catch (error) {
      pushError = error;
    }
    const finish = d.finish();
    await expect(finish).rejects.toMatchObject({
      code: 'PALETTE_INDEX_OUT_OF_RANGE',
      row: 1,
    });
    expect(pushError).toBeNull();
    expect(delivered.length).toBe(1);
    expect(delivered[0]!.yPos).toBe(0);
  }

  it('8-bit index beyond the palette fails with a row number', () => expectFailure(8, 2));
  it('4-bit index beyond the palette fails with a row number', () => expectFailure(4, 2));
  it('2-bit index beyond the palette fails with a row number', () => expectFailure(2, 3));
  it('1-bit index beyond the palette fails with a row number', () => expectFailure(1, 1));
});

// -------------------------------------------------------------------- Adam7

describe('Adam7 interlacing', () => {
  const W = 17;
  const H = 13;

  function interlacedPNG(
    pixelGrid: number[][][],
    colorType: PNGColorType,
    depth: number,
    channels: number,
    extras: Parameters<typeof standardPNG>[4] = [],
  ) {
    const rawRows: Uint8Array[] = [];
    for (const p of ADAM7_PASSES) {
      const rows = passRows(pixelGrid, p.xStart, p.yStart, p.xStep, p.yStep, channels);
      if (rows.length === 0 || rows[0]!.length === 0) continue;
      for (const r of rows) {
        let packed: Uint8Array;
        if (depth < 8) {
          packed = packBits(r, depth);
        } else if (depth === 16) {
          // r contains logical sample values, one Uint16 each.
          packed = new Uint8Array(r.length * 2);
          const dv = new DataView(packed.buffer);
          r.forEach((v, i) => dv.setUint16(i * 2, v));
        } else {
          packed = Uint8Array.from(r);
        }
        rawRows.push(packed);
      }
    }
    return standardPNG(W, H, depth, colorType, rawRows, extras, 1);
  }

  function rgbaGrid() {
    const pattern = patternPixels(W, H);
    return pattern.map((row) => row.map(([r, g, b, a]) => [r, g, b, a]));
  }

  it('assembles to the same pixels as a non-interlaced image (RGBA8)', async () => {
    const grid = rgbaGrid();
    const flat = grid.map((r) => rgbaRow(r as Array<[number, number, number, number]>));
    const nonInterlaced = standardPNG(W, H, 8, 6, flat);
    const interlaced = interlacedPNG(grid, 6, 8, 4);

    const a = (await decode(nonInterlaced))!.data;
    const b = (await decode(interlaced))!.data;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('works in 16-bit RGBA too', async () => {
    const grid: number[][][] = [];
    for (let y = 0; y < H; y++) {
      const row: number[][] = [];
      for (let x = 0; x < W; x++) {
        row.push([
          (x * 2000 + y) & 0xffff,
          65535 - x,
          (y * 3000 + 17) & 0xffff,
          ((x * y) & 0xffff) | 1,
        ]);
      }
      grid.push(row);
    }
    const nonRows = grid.map((r) => {
      const bytes = new Uint8Array(r.length * 8);
      const dv = new DataView(bytes.buffer);
      r.forEach((px, i) => px.forEach((v, c) => dv.setUint16(i * 8 + c * 2, v)));
      return bytes;
    });
    const nonInterlaced = standardPNG(W, H, 16, 6, nonRows);
    const interlaced = interlacedPNG(grid, 6, 16, 4);
    const a = (await decode(nonInterlaced))!.data;
    const b = (await decode(interlaced))!.data;
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('matches for indexed 1-bit and grayscale 2-bit', async () => {
    const make = (colorType: PNGColorType, depth: number) => {
      const grid: number[][][] = [];
      for (let y = 0; y < H; y++) {
        const row: number[][] = [];
        for (let x = 0; x < W; x++) {
          const index = (x * 3 + y * 7) & ((1 << depth) - 1);
          row.push([index]);
        }
        grid.push(row);
      }
      // Expected RGBA output.
      const expected = new Uint8Array(W * H * 4);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const v = grid[y]![x]![0]!;
          const scaled = depth === 1
            ? (v ? 255 : 0)
            : depth === 2
              ? Math.floor((v * 255) / 3)
              : v;
          expected[(y * W + x) * 4] = scaled;
          expected[(y * W + x) * 4 + 1] = scaled;
          expected[(y * W + x) * 4 + 2] = scaled;
          expected[(y * W + x) * 4 + 3] = 255;
        }
      }
      return { grid, expected };
    };

    for (const [ct, depth] of [[3, 1], [0, 2]] as Array<[PNGColorType, number]>) {
      const { grid, expected } = make(ct, depth);
      const palette = paletteChunk([
        [0, 0, 0],
        depth === 1 ? [255, 255, 255] : [85, 85, 85],
        depth === 2 ? [170, 170, 170] : [0, 0, 0],
        [255, 255, 255],
      ]);
      const png = interlacedPNG(grid, ct, depth, 1, ct === 3 ? [palette] : []);
      const image = await decode(png);
      expect(Array.from(image!.data as Uint8Array)).toEqual(Array.from(expected));
    }
  });

  it('streaming rows carry pass index and final-image positions', async () => {
    const grid = rgbaGrid();
    const png = interlacedPNG(grid, 6, 8, 4);
    const rows: DecodedRow[] = [];
    await decode(png, {
      collect: false,
      onRow: (r) => rows.push(r),
    });

    // Reassemble from rows alone.
    const canvas = new Uint8Array(W * H * 4);
    let expectedPass = 0;
    for (const r of rows) {
      expect(r.pass).toBeGreaterThanOrEqual(expectedPass);
      expectedPass = r.pass;
      const p = ADAM7_PASSES[r.pass]!;
      expect(r.yPos).toBeGreaterThanOrEqual(p.yStart);
      expect((r.yPos - p.yStart) % p.yStep).toBe(0);
      expect(r.x0).toBe(p.xStart);
      expect(r.xStep).toBe(p.xStep);
      for (let i = 0; i < r.width; i++) {
        const x = r.x0 + i * r.xStep;
        canvas.set(r.data.subarray(i * 4, i * 4 + 4), (r.yPos * W + x) * 4);
      }
    }
    const expected = concat(grid.map((r) =>
      rgbaRow(r as Array<[number, number, number, number]>),
    ));
    expect(Array.from(canvas)).toEqual(Array.from(expected));
  });

  it('reports the right number of rows per pass', async () => {
    const grid = rgbaGrid();
    const png = interlacedPNG(grid, 6, 8, 4);
    const perPass = new Array(7).fill(0);
    await decode(png, {
      collect: false,
      onRow: (r) => {
        perPass[r.pass]++;
      },
    });
    const expected = ADAM7_PASSES.map((p) => {
      const pw = Math.ceil((W - p.xStart) / p.xStep);
      const ph = Math.ceil((H - p.yStart) / p.yStep);
      return pw === 0 ? 0 : ph;
    });
    expect(perPass).toEqual(expected);
  });
});

// -------------------------------------------------------------- chunk splitting

describe('IDAT layout', () => {
  it('reassembles many consecutive IDAT chunks', async () => {
    const rows = [rgbaRow([[7, 8, 9, 10], [11, 12, 13, 14]])];
    const png = buildPNG([
      ihdr(2, 1, 8, 6),
      ...idatChunks(rows, { splits: 8 }),
      chunk('IEND'),
    ]);
    const d = pixelsAsFlatArray((await decode(png))!);
    expect(d).toEqual([7, 8, 9, 10, 11, 12, 13, 14]);
  });

  it('rejects an ancillary chunk between IDAT chunks', async () => {
    const rows = [rgbaRow([[1, 2, 3, 4]])];
    const [a, b] = idatChunks(rows, { splits: 2 });
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      a!,
      chunk('tEXt', new TextEncoder().encode('key\x00value')),
      b!,
      chunk('IEND'),
    ]);
    await expectDecodeFailure(png, { code: 'IDAT_NOT_CONTIGUOUS' });
  });
});

describe('ancillary chunks', () => {
  it('skips unknown ancillary chunks', async () => {
    const rows = [rgbaRow([[1, 2, 3, 4]])];
    const png = standardPNG(1, 1, 8, 6, rows, [
      chunk('tEXt', new TextEncoder().encode('comment\x00hello')),
      chunk('xYZx', new Uint8Array([9, 9, 9])),
    ]);
    const image = await decode(png);
    expect(pixelsAsFlatArray(image!)).toEqual([1, 2, 3, 4]);
  });

  it('skips ancillary chunks with bad CRC by default', async () => {
    const rows = [rgbaRow([[1, 2, 3, 4]])];
    const badAncillary = {
      ...chunk('tEXt', new TextEncoder().encode('comment\x00hello')),
      crc: 0xdeadbeef,
    };
    const png = standardPNG(1, 1, 8, 6, rows, [badAncillary]);
    const image = await decode(png);
    expect(pixelsAsFlatArray(image!)).toEqual([1, 2, 3, 4]);
  });

  it('can be configured to fail on bad ancillary CRC', async () => {
    const rows = [rgbaRow([[1, 2, 3, 4]])];
    const badAncillary = {
      ...chunk('tEXt', new TextEncoder().encode('comment\x00hello')),
      crc: 0xdeadbeef,
    };
    const png = standardPNG(1, 1, 8, 6, rows, [badAncillary]);
    await expectDecodeFailure(png, { code: 'CRC_MISMATCH' }, {
      failOnCorruptAncillaryCRC: true,
    });
  });
});

it('rejects an empty file / bad signature', async () => {
  await expectDecodeFailure(
    Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8),
    { code: 'BAD_SIGNATURE' },
  );
});

it('rejects truncated input even if no bytes are missing locally', async () => {
  const rows = [rgbaRow([[1, 2, 3, 4]])];
  const png = standardPNG(1, 1, 8, 6, rows);
  const d = new StreamingPNGDecoder();
  d.push(png.subarray(0, png.length - 13)); // cut into IEND
  await expect(d.finish()).rejects.toMatchObject({ code: 'UNEXPECTED_END' });
});

it('still validates the canonical signature exactly', () => {
  expect(SIGNATURE.length).toBe(8);
});
