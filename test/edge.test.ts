import { expect, it, describe } from 'vitest';
import { PngDecoder, type DecodedRow } from '../src/index.js';
import {
  buildPng,
  mulberry32,
  chunkBytes,
} from './helpers/png-builder.js';

describe('arbitrary push boundaries', () => {
  const cases: Array<[number, number, number, number, 0 | 1]> = [
    [3, 3, 8, 6, 0],
    [17, 11, 8, 2, 1],
    [5, 7, 4, 3, 0],
    [33, 5, 16, 6, 1],
    [1, 1, 1, 0, 0],
    [1, 1, 8, 6, 1],
  ];

  for (const [w, h, bd, ct, il] of cases) {
    it(`${w}x${h} ct${ct} bd${bd} il${il} byte-at-a-time equals whole-push`, async () => {
      const max = (1 << bd) - 1;
      const pix =
        ct === 0
          ? (x: number, y: number) => [(x * 9 + y * 3) & max]
          : ct === 2
            ? (x: number, y: number) => [
                (x * 7 + y) & max,
                (x + y * 5) & max,
                (x ^ y) & max,
              ]
            : (x: number, y: number) => [
                (x * 13 + y * 29) & 0xff,
                (x * 7 + y * 101) & 0xff,
                (x * 3 + y * 11) & 0xff,
                ((x + y) & 1) ? 255 : 64,
              ];

      let palette: Uint8Array | undefined;
      if (ct === 3) {
        palette = new Uint8Array(256 * 3);
        for (let i = 0; i < 256; i++) {
          palette[i * 3] = i;
          palette[i * 3 + 1] = (i * 2) & 0xff;
          palette[i * 3 + 2] = (i * 4) & 0xff;
        }
      }

      const opts = {
        width: w,
        height: h,
        bitDepth: bd,
        colorType: ct,
        interlace: il,
        pixel: pix,
        palette,
        filter: (pass: number, y: number) => (pass + y) % 5,
      } as const;
      const png = buildPng(opts);

      // Whole push
      const dWhole = new PngDecoder();
      await dWhole.push(png);
      const whole = (await dWhole.end())!.data;

      // Byte-at-a-time, row mode, reassembled
      const assembled = new (bd === 16 ? Uint16Array : Uint8Array)(w * h * 4);
      const dBytes = new PngDecoder({
        onRow: (r) => scatter(r, assembled, w),
      });
      for (let i = 0; i < png.length; i++) {
        await dBytes.push(png.subarray(i, i + 1));
      }
      await dBytes.end();
      expect(Array.from(assembled)).toEqual(Array.from(whole as any));

      // Random odd chunk sizes (including size 1)
      const rng = mulberry32(w * 1000 + h + ct * 7 + bd + il);
      const assembled2 = new (bd === 16 ? Uint16Array : Uint8Array)(
        w * h * 4,
      );
      const dRand = new PngDecoder({
        onRow: (r) => scatter(r, assembled2, w),
      });
      for (const part of chunkBytes(png, rng, 3)) {
        await dRand.push(part);
      }
      await dRand.end();
      expect(Array.from(assembled2)).toEqual(Array.from(whole as any));
    });
  }
});

function scatter(
  r: DecodedRow,
  canvas: Uint8Array | Uint16Array,
  width: number,
): void {
  for (let i = 0; i < r.width; i++) {
    const x = r.xStart + i * r.xStep;
    const base = (r.yPosition * width + x) * 4;
    canvas[base] = r.data[i * 4];
    canvas[base + 1] = r.data[i * 4 + 1];
    canvas[base + 2] = r.data[i * 4 + 2];
    canvas[base + 3] = r.data[i * 4 + 3];
  }
}

describe('Adam7 tiny sizes (passes with zero rows/columns)', () => {
  const sizes: Array<[number, number]> = [
    [1, 1],
    [1, 2],
    [2, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [5, 5],
    [7, 7],
    [8, 8],
    [9, 9],
    [16, 1],
    [1, 16],
  ];
  for (const [w, h] of sizes) {
    it(`interlaced ${w}x${h} equals non-interlaced`, async () => {
      const pix = (x: number, y: number) => [
        (x * 31 + y * 17) & 0xff,
        (x + y * 3) & 0xff,
        (x * 7) & 0xff,
        y === h - 1 && x === w - 1 ? 0 : 255,
      ];
      const flat = buildPng({
        width: w,
        height: h,
        bitDepth: 8,
        colorType: 6,
        interlace: 0,
        pixel: pix,
      });
      const inter = buildPng({
        width: w,
        height: h,
        bitDepth: 8,
        colorType: 6,
        interlace: 1,
        pixel: pix,
      });
      const d1 = new PngDecoder();
      await d1.push(flat);
      const a = (await d1.end())!.data;

      const d2 = new PngDecoder();
      await d2.push(inter);
      const b = (await d2.end())!.data;
      expect(Array.from(b as any)).toEqual(Array.from(a as any));
    });
  }
});

describe('tRNS semantics', () => {
  it('indexed: missing tRNS entries are opaque, listed ones honored', async () => {
    const palette = new Uint8Array([
      10, 20, 30,
      40, 50, 60,
      70, 80, 90,
      100, 110, 120,
    ]);
    // Only 2 alpha entries: index0 fully transparent, index1 half.
    const trns = new Uint8Array([0, 128]);
    const png = buildPng({
      width: 4,
      height: 1,
      bitDepth: 8,
      colorType: 3,
      palette,
      trns,
      pixel: (x) => [x],
    });
    const dec = new PngDecoder();
    await dec.push(png);
    const data = (await dec.end())!.data as Uint8Array;
    expect([...data.subarray(0, 16)]).toEqual([
      10, 20, 30, 0,
      40, 50, 60, 128,
      70, 80, 90, 255,
      100, 110, 120, 255,
    ]);
  });

  it('16-bit grayscale tRNS key makes exact match transparent', async () => {
    const png = buildPng({
      width: 3,
      height: 1,
      bitDepth: 16,
      colorType: 0,
      trns: new Uint8Array([0x01, 0x00]), // key = 256
      pixel: (x) => [[255], [256], [1000]][x],
    });
    const dec = new PngDecoder();
    await dec.push(png);
    const data = (await dec.end())!.data as Uint16Array;
    expect(data[3]).toBe(0xffff);
    expect(data[7]).toBe(0);
    expect(data[11]).toBe(0xffff);
  });

  it('8-bit truecolor tRNS reads 2-byte channel fields', async () => {
    // Key color R=10,G=20,G=30 stored as 0,10,0,20,0,30.
    const trns = new Uint8Array([0, 10, 0, 20, 0, 30]);
    const png = buildPng({
      width: 3,
      height: 1,
      bitDepth: 8,
      colorType: 2,
      trns,
      pixel: (x) =>
        [
          [10, 20, 30],
          [10, 20, 31],
          [0, 0, 0],
        ][x],
    });
    const dec = new PngDecoder();
    await dec.push(png);
    const data = (await dec.end())!.data as Uint8Array;
    expect(data[3]).toBe(0);
    expect(data[7]).toBe(255);
    expect(data[11]).toBe(255);
  });

  it('sub-byte grayscale expands samples per spec (depth 1/2/4)', async () => {
    const png = buildPng({
      width: 4,
      height: 1,
      bitDepth: 2,
      colorType: 0,
      pixel: (x) => [x], // samples 0,1,2,3
    });
    const dec = new PngDecoder();
    await dec.push(png);
    const data = (await dec.end())!.data as Uint8Array;
    expect([data[0], data[4], data[8], data[12]]).toEqual([0, 85, 170, 255]);
  });
});

describe('row metadata for non-interlaced deep images', () => {
  it('16-bit RGBA rows expose Uint16Array with correct placement info', async () => {
    const png = buildPng({
      width: 4,
      height: 2,
      bitDepth: 16,
      colorType: 6,
      interlace: 1,
      pixel: (x, y) => [x, y, x + y, 0x8000 + x * 100 + y],
    });
    const rows: DecodedRow[] = [];
    const dec = new PngDecoder({ onRow: (r) => rows.push(r) });
    await dec.push(png);
    await dec.end();
    // Every delivered buffer is Uint16Array; spot check metadata of one
    // pass-7 row (pass 7 samples every column, starting row 1).
    const pass7 = rows.filter((r) => r.pass === 7);
    expect(pass7.length).toBeGreaterThan(0);
    for (const r of pass7) {
      expect(r.data).toBeInstanceOf(Uint16Array);
      expect(r.xStep).toBe(1);
      expect(r.xStart).toBe(0);
      // Pass 7 covers odd final-image rows (yStart 1, step 2).
      expect(r.yPosition % 2).toBe(1);
    }
  });
});
