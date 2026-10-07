import { expect, it, describe } from 'vitest';
import { PngDecoder, type DecodedRow } from '../src/index.js';
import {
  buildPng,
  mulberry32,
  chunkBytes,
} from './helpers/png-builder.js';

function rgbaPixel(x: number, y: number): number[] {
  return [
    (x * 37 + y * 7) & 0xff,
    (x * 11 + y * 53) & 0xff,
    (x ^ y) & 0xff,
    255 - ((x + y) & 31),
  ];
}

describe('header callback', () => {
  it('reports dimensions/depth/color type/interlace from IHDR', async () => {
    const png = buildPng({
      width: 7,
      height: 5,
      bitDepth: 8,
      colorType: 6,
      interlace: 1,
      pixel: rgbaPixel,
    });
    let seen: any = null;
    const dec = new PngDecoder({ onHeader: (h) => (seen = h) });
    // Feed signature + the complete IHDR chunk (8 + 25 = 33 bytes).
    await dec.push(png.subarray(0, 33));
    expect(seen.width).toBe(7);
    expect(seen.height).toBe(5);
    expect(seen.bitDepth).toBe(8);
    expect(seen.colorType).toBe(6);
    expect(seen.interlaceMethod).toBe(1);
    expect(seen.interlaced).toBe(true);
    await dec.push(png.subarray(33));
    await dec.end();
  });
});

describe('row streaming', () => {
  it('non-interlaced: one row per scanline, in order', async () => {
    const w = 6;
    const h = 4;
    const png = buildPng({
      width: w,
      height: h,
      bitDepth: 8,
      colorType: 6,
      pixel: rgbaPixel,
      filter: (pass, y) => (y + 1) % 5,
    });

    const rows: DecodedRow[] = [];
    const dec = new PngDecoder({ onRow: (r) => rows.push(r) });
    await dec.push(png);
    const result = await dec.end();

    expect(result).toBeUndefined();
    expect(rows.length).toBe(h);
    rows.forEach((r, y) => {
      expect(r.pass).toBe(0);
      expect(r.y).toBe(y);
      expect(r.yPosition).toBe(y);
      expect(r.xStart).toBe(0);
      expect(r.xStep).toBe(1);
      expect(r.width).toBe(w);
      expect(r.data).toBeInstanceOf(Uint8Array);
      for (let x = 0; x < w; x++) {
        const exp = rgbaPixel(x, y);
        const i = x * 4;
        expect([
          r.data[i],
          r.data[i + 1],
          r.data[i + 2],
          r.data[i + 3],
        ]).toEqual(exp);
      }
    });
  });

  it('delivers rows as bytes arrive, before end()', async () => {
    const w = 8;
    const h = 40;
    const png = buildPng({
      width: w,
      height: h,
      bitDepth: 8,
      colorType: 6,
      pixel: rgbaPixel,
      filter: 0,
      idatSplit: 1,
    });

    let rowsBeforeEnd = 0;
    const dec = new PngDecoder({
      onRow: () => rowsBeforeEnd++,
    });
    // Push byte by byte: as soon as a whole scanline is available, it
    // must be emitted well before end of file.
    for (let i = 0; i < png.length; i++) {
      await dec.push(png.subarray(i, i + 1));
      if (i < png.length - 30 && rowsBeforeEnd === 0) {
        // wait for at least first rows
      }
    }
    expect(rowsBeforeEnd).toBe(h);
    await dec.end();
  });

  it('Adam7: rows carry pass / yPosition / xStart / xStep', async () => {
    const w = 29;
    const h = 17;
    const png = buildPng({
      width: w,
      height: h,
      bitDepth: 8,
      colorType: 6,
      interlace: 1,
      pixel: rgbaPixel,
      filter: 4,
      idatSplit: 33,
    });

    // Expected per-pass metadata.
    const expected: Array<[number, number, number, number, number]> = [
      // pass, xStart, yStart, xStep, yStep
      [1, 0, 0, 8, 8],
      [2, 4, 0, 8, 8],
      [3, 0, 4, 4, 8],
      [4, 2, 0, 4, 4],
      [5, 0, 2, 2, 4],
      [6, 1, 0, 2, 2],
      [7, 0, 1, 1, 2],
    ];
    const counts: number[] = new Array(8).fill(0);

    // Rebuild image from streamed rows into a full buffer.
    const canvas = new Uint8Array(w * h * 4);
    const rows: DecodedRow[] = [];
    const dec = new PngDecoder({
      onRow: (r) => {
        rows.push(r);
        counts[r.pass]++;
        for (let i = 0; i < r.width; i++) {
          const x = r.xStart + i * r.xStep;
          const base = (r.yPosition * w + x) * 4;
          const si = i * 4;
          canvas[base] = r.data[si];
          canvas[base + 1] = r.data[si + 1];
          canvas[base + 2] = r.data[si + 2];
          canvas[base + 3] = r.data[si + 3];
        }
      },
    });
    const rng = mulberry32(42);
    for (const part of chunkBytes(png, rng, 7)) {
      await dec.push(part);
    }
    await dec.end();

    // Each expected pass has the right number of rows and metadata.
    let total = 0;
    for (const [pass, xStart, yStart, xStep, yStep] of expected) {
      const pw = xStart >= w ? 0 : Math.floor((w - 1 - xStart) / xStep) + 1;
      const ph = yStart >= h ? 0 : Math.floor((h - 1 - yStart) / yStep) + 1;
      expect(counts[pass]).toBe(ph);
      total += ph;
    }
    expect(rows.length).toBe(total);

    // Monotonic order: passes ascending, y ascending within a pass.
    let lastPass = 0;
    let lastY = -1;
    for (const r of rows) {
      if (r.pass !== lastPass) {
        expect(r.pass).toBeGreaterThan(lastPass);
        lastPass = r.pass;
        lastY = -1;
      }
      expect(r.y).toBe(lastY + 1);
      lastY = r.y;
    }

    // Every pixel covered exactly once and matches the source.
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const exp = rgbaPixel(x, y);
        const i = (y * w + x) * 4;
        expect([
          canvas[i],
          canvas[i + 1],
          canvas[i + 2],
          canvas[i + 3],
        ]).toEqual(exp);
      }
    }
  });

  it('interlaced streaming output equals non-interlaced whole-image decode', async () => {
    // Same pixels, encoded both ways; the assembled interlaced picture
    // must be pixel-identical to the non-interlaced decode.
    const cases: Array<[number, number, number, number]> = [
      [1, 1, 8, 6],
      [3, 1, 8, 6],
      [8, 8, 8, 6],
      [31, 13, 8, 6],
      [17, 9, 4, 0],
      [13, 11, 1, 0],
      [20, 16, 16, 2],
    ];
    for (const [w, h, bd, ct] of cases) {
      const max = (1 << bd) - 1;
      const pix =
        ct === 0
          ? (x: number, y: number) => [(x * 5 + y * 9) & max]
          : ct === 2
            ? (x: number, y: number) => [
                (x * 3 + y * 7) & max,
                (x ^ y) & max,
                (x + y * 11) & max,
              ]
            : rgbaPixel;

      const flat = buildPng({
        width: w,
        height: h,
        bitDepth: bd,
        colorType: ct,
        interlace: 0,
        pixel: pix,
        filter: 3,
      });
      const inter = buildPng({
        width: w,
        height: h,
        bitDepth: bd,
        colorType: ct,
        interlace: 1,
        pixel: pix,
        filter: 2,
      });

      const d1 = new PngDecoder();
      await d1.push(flat);
      const a = (await d1.end())!.data;

      const canvas = new (bd === 16 ? Uint16Array : Uint8Array)(w * h * 4);
      const d2 = new PngDecoder({
        onRow: (r) => {
          for (let i = 0; i < r.width; i++) {
            const x = r.xStart + i * r.xStep;
            const base = (r.yPosition * w + x) * 4;
            canvas[base] = r.data[i * 4];
            canvas[base + 1] = r.data[i * 4 + 1];
            canvas[base + 2] = r.data[i * 4 + 2];
            canvas[base + 3] = r.data[i * 4 + 3];
          }
        },
      });
      await d2.push(inter);
      await d2.end();

      expect(Array.from(canvas)).toEqual(Array.from(a as any));
    }
  });

  it('16-bit depth yields Uint16Array rows and image', async () => {
    const w = 4;
    const h = 3;
    const pix = (x: number, y: number) => [
      (x * 1000 + y * 97) & 0xffff,
      (x * 30000 + y) & 0xffff,
      (x ^ (y * 40000)) & 0xffff,
      x * 16384 + y,
    ];
    const png = buildPng({
      width: w,
      height: h,
      bitDepth: 16,
      colorType: 6,
      pixel: pix,
    });
    let rowTypeOk = true;
    const dec = new PngDecoder({
      onRow: (r) => {
        rowTypeOk = rowTypeOk && r.data instanceof Uint16Array;
      },
    });
    await dec.push(png);
    await dec.end();
    expect(rowTypeOk).toBe(true);

    const d2 = new PngDecoder();
    await d2.push(png);
    const img = await d2.end();
    expect(img!.data).toBeInstanceOf(Uint16Array);
    const data = img!.data as Uint16Array;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const e = pix(x, y);
        const i = (y * w + x) * 4;
        expect([data[i], data[i + 1], data[i + 2], data[i + 3]]).toEqual(e);
      }
    }
  });
});
