import { expect, it, describe } from 'vitest';
import {
  paeth,
  bytesPerPixel,
  rowByteLength,
  channelsForColorType,
  parseIhdr,
  ScanlineReconstructor,
  UnfilterError,
  unfilterScanlines,
  type ImageInfo,
} from '../src/index.js';

it('predicts', () => expect(paeth(10, 20, 15)).toBe(15));

/** Forward-filter one row (encoder side) so tests can round-trip. */
function encodeRow(filter: number, cur: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(cur.length);
  for (let i = 0; i < cur.length; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let pred = 0;
    if (filter === 1) pred = a;
    else if (filter === 2) pred = b;
    else if (filter === 3) pred = (a + b) >> 1;
    else if (filter === 4) pred = paeth(a, b, c);
    out[i] = (cur[i] - pred) & 0xff;
  }
  return out;
}

/** Build a decompressed stream: filter byte + row bytes, per row. */
function makeStream(rows: Uint8Array[], filters: number[], bpp: number): Uint8Array {
  const rowLen = rows[0].length;
  const stream = new Uint8Array(rows.length * (1 + rowLen));
  let prev = new Uint8Array(rowLen);
  rows.forEach((row, r) => {
    const off = r * (1 + rowLen);
    stream[off] = filters[r];
    stream.set(encodeRow(filters[r], row, prev, bpp), off + 1);
    prev = row;
  });
  return stream;
}

const info = (partial: Partial<ImageInfo>): ImageInfo => ({
  width: 4,
  height: 2,
  bitDepth: 8,
  colorType: 2,
  ...partial,
});

describe('geometry', () => {
  it('computes channels per color type', () => {
    expect(channelsForColorType(0)).toBe(1);
    expect(channelsForColorType(2)).toBe(3);
    expect(channelsForColorType(3)).toBe(1);
    expect(channelsForColorType(4)).toBe(2);
    expect(channelsForColorType(6)).toBe(4);
    expect(() => channelsForColorType(1)).toThrow(UnfilterError);
  });

  it('computes bytes per pixel, byte-aligned with sub-8-bit as 1', () => {
    expect(bytesPerPixel(8, 2)).toBe(3);
    expect(bytesPerPixel(8, 6)).toBe(4);
    expect(bytesPerPixel(16, 0)).toBe(2);
    expect(bytesPerPixel(16, 6)).toBe(8);
    expect(bytesPerPixel(1, 0)).toBe(1);
    expect(bytesPerPixel(2, 3)).toBe(1);
    expect(bytesPerPixel(4, 0)).toBe(1);
  });

  it('computes row byte length with sub-byte packing', () => {
    expect(rowByteLength(4, 8, 2)).toBe(12);
    expect(rowByteLength(8, 1, 0)).toBe(1);
    expect(rowByteLength(3, 1, 0)).toBe(1);
    expect(rowByteLength(5, 2, 0)).toBe(2);
    expect(rowByteLength(3, 4, 0)).toBe(2);
    expect(rowByteLength(2, 16, 6)).toBe(16);
  });

  it('rejects invalid bit depth / color type combinations', () => {
    expect(() => new ScanlineReconstructor(info({ colorType: 5 }))).toThrow(UnfilterError);
    expect(() => new ScanlineReconstructor(info({ colorType: 2, bitDepth: 4 }))).toThrow(
      UnfilterError,
    );
    expect(() => new ScanlineReconstructor(info({ colorType: 3, bitDepth: 16 }))).toThrow(
      UnfilterError,
    );
    expect(() => new ScanlineReconstructor(info({ width: 0 }))).toThrow(UnfilterError);
    expect(() => new ScanlineReconstructor(info({ height: 0 }))).toThrow(UnfilterError);
  });

  it('parses IHDR', () => {
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, 7);
    view.setUint32(4, 3);
    ihdr[8] = 16;
    ihdr[9] = 6;
    expect(parseIhdr(ihdr)).toEqual({ width: 7, height: 3, bitDepth: 16, colorType: 6 });
    expect(() => parseIhdr(new Uint8Array(12))).toThrow(UnfilterError);
  });
});

describe('reconstruction', () => {
  it('passes through filter None', () => {
    const rows = unfilterScanlines(
      new Uint8Array([0, 1, 2, 3, 0, 4, 5, 6]),
      info({ width: 1, height: 2 }),
    );
    expect(rows).toHaveLength(2);
    expect([...rows[0]]).toEqual([1, 2, 3]);
    expect([...rows[1]]).toEqual([4, 5, 6]);
  });

  it('treats Up on the first row as identity (zero previous row)', () => {
    const rows = unfilterScanlines(
      new Uint8Array([2, 10, 20, 30]),
      info({ width: 1, height: 1 }),
    );
    expect([...rows[0]]).toEqual([10, 20, 30]);
  });

  it('treats Paeth on the first row like Sub (zero previous row)', () => {
    // width 2 RGB: row is 6 bytes > bpp 3, so bytes 3..5 pick up `a`;
    // prev is all zeros, so paeth(a, 0, 0) === a.
    const rows = unfilterScanlines(
      new Uint8Array([4, 100, 5, 5, 10, 20, 30]),
      info({ width: 2, height: 1 }),
    );
    expect([...rows[0]]).toEqual([100, 5, 5, 110, 25, 35]);
  });

  it('reconstructs Sub, Up, Average and Paeth round-trips with uint8 wraparound', () => {
    const i = info({ width: 4, height: 4 }); // RGB8, bpp 3
    const pixels = [
      new Uint8Array([250, 3, 7, 9, 255, 0, 128, 64, 32, 1, 2, 3]),
      new Uint8Array([2, 250, 10, 20, 30, 40, 200, 100, 50, 255, 254, 253]),
      new Uint8Array([90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101]),
      new Uint8Array([0, 255, 128, 127, 64, 192, 33, 77, 201, 5, 250, 60]),
    ];
    const stream = makeStream(pixels, [1, 2, 3, 4], 3);
    const rows = unfilterScanlines(stream, i);
    rows.forEach((row, r) => expect([...row]).toEqual([...pixels[r]]));
  });

  it('handles 1-bit depth (packed bytes, bpp 1)', () => {
    const i = info({ width: 8, height: 2, bitDepth: 1, colorType: 0 });
    const pixels = [new Uint8Array([0b10110001]), new Uint8Array([0b01101110])];
    const rows = unfilterScanlines(makeStream(pixels, [1, 2], 1), i);
    expect([...rows[0]]).toEqual([...pixels[0]]);
    expect([...rows[1]]).toEqual([...pixels[1]]);
  });

  it('handles 2-bit depth', () => {
    const i = info({ width: 5, height: 2, bitDepth: 2, colorType: 0 }); // 2 bytes/row
    const pixels = [new Uint8Array([0x1b, 0x40]), new Uint8Array([0xe4, 0x80])];
    const rows = unfilterScanlines(makeStream(pixels, [4, 3], 1), i);
    rows.forEach((row, r) => expect([...row]).toEqual([...pixels[r]]));
  });

  it('handles 4-bit depth with odd width', () => {
    const i = info({ width: 3, height: 2, bitDepth: 4, colorType: 0 }); // 2 bytes/row
    const pixels = [new Uint8Array([0xab, 0xc0]), new Uint8Array([0x12, 0x30])];
    const rows = unfilterScanlines(makeStream(pixels, [1, 4], 1), i);
    rows.forEach((row, r) => expect([...row]).toEqual([...pixels[r]]));
  });

  it('handles 16-bit depth (bpp spans two bytes)', () => {
    const i = info({ width: 2, height: 2, bitDepth: 16, colorType: 0 }); // 4 bytes/row, bpp 2
    const pixels = [
      new Uint8Array([0x12, 0x34, 0xab, 0xcd]),
      new Uint8Array([0xff, 0x00, 0x00, 0xff]),
    ];
    const rows = unfilterScanlines(makeStream(pixels, [1, 4], 2), i);
    rows.forEach((row, r) => expect([...row]).toEqual([...pixels[r]]));
  });

  it('handles 16-bit RGBA (bpp 8)', () => {
    const i = info({ width: 1, height: 2, bitDepth: 16, colorType: 6 });
    const pixels = [
      new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      new Uint8Array([250, 251, 252, 253, 254, 255, 0, 1]),
    ];
    const rows = unfilterScanlines(makeStream(pixels, [3, 2], 8), i);
    rows.forEach((row, r) => expect([...row]).toEqual([...pixels[r]]));
  });

  it('handles rows no wider than bpp (left predictors stay zero)', () => {
    // width 1 RGB8: row is exactly bpp long, so Sub/Average/Paeth never see `a`/`c`.
    const i = info({ width: 1, height: 3 });
    const pixels = [
      new Uint8Array([10, 20, 30]),
      new Uint8Array([200, 100, 50]),
      new Uint8Array([255, 0, 128]),
    ];
    const rows = unfilterScanlines(makeStream(pixels, [1, 3, 4], 3), i);
    rows.forEach((row, r) => expect([...row]).toEqual([...pixels[r]]));
  });

  it('emits exactly the IHDR row count', () => {
    const i = info({ width: 1, height: 3, colorType: 0 }); // 1 byte/row
    const stream = new Uint8Array([0, 1, 0, 2, 0, 3]);
    const rows = unfilterScanlines(stream, i);
    expect(rows).toHaveLength(3);
  });
});

describe('incremental feeding', () => {
  const i = info({ width: 2, height: 3 }); // RGB8: 6 bytes/row, stride 7
  const pixels = [
    new Uint8Array([1, 2, 3, 4, 5, 6]),
    new Uint8Array([7, 8, 9, 10, 11, 12]),
    new Uint8Array([13, 14, 15, 16, 17, 18]),
  ];
  const stream = makeStream(pixels, [1, 2, 4], 3);

  it('reconstructs across every possible split point (IDAT boundaries)', () => {
    for (let split = 0; split <= stream.length; split++) {
      const r = new ScanlineReconstructor(i);
      const rows = [...r.push(stream.slice(0, split)), ...r.push(stream.slice(split))];
      r.finish();
      expect(rows).toHaveLength(3);
      rows.forEach((row, n) => expect([...row]).toEqual([...pixels[n]]));
    }
  });

  it('waits for a filter byte split across pushes', () => {
    const r = new ScanlineReconstructor(i);
    expect(r.push(stream.slice(0, 7))).toHaveLength(1); // first row complete
    expect(r.push(stream.slice(7, 8))).toHaveLength(0); // only the filter byte of row 2
    const rows = r.push(stream.slice(8));
    expect(rows).toHaveLength(2);
    expect([...rows[0]]).toEqual([...pixels[1]]);
    expect([...rows[1]]).toEqual([...pixels[2]]);
    r.finish();
  });

  it('accepts one byte at a time', () => {
    const r = new ScanlineReconstructor(i);
    const rows: Uint8Array[] = [];
    for (let n = 0; n < stream.length; n++) rows.push(...r.push(stream.slice(n, n + 1)));
    r.finish();
    rows.forEach((row, n) => expect([...row]).toEqual([...pixels[n]]));
  });
});

describe('error handling', () => {
  it('reports the row number for an invalid filter type', () => {
    const i = info({ width: 1, height: 3, colorType: 0 }); // 1 byte/row
    const stream = new Uint8Array([0, 1, 2, 2, 99, 3]); // bad filter on row 2
    const r = new ScanlineReconstructor(i);
    try {
      r.push(stream);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnfilterError);
      expect((err as UnfilterError).row).toBe(2);
      expect((err as Error).message).toContain('row 2');
      expect((err as Error).message).toContain('99');
    }
  });

  it('rejects a truncated row at finish()', () => {
    const i = info({ width: 2, height: 2 }); // needs 7 bytes/row
    const r = new ScanlineReconstructor(i);
    expect(r.push(new Uint8Array([0, 1, 2, 3, 4, 5, 6]))).toHaveLength(1);
    r.push(new Uint8Array([2, 9, 9])); // partial second row
    try {
      r.finish();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnfilterError);
      expect((err as UnfilterError).row).toBe(1);
      expect((err as Error).message).toContain('truncated');
    }
  });

  it('rejects a stream missing whole rows', () => {
    const r = new ScanlineReconstructor(info({ width: 1, height: 3 }));
    r.push(new Uint8Array([0, 1, 0, 2]));
    expect(() => r.finish()).toThrowError(/truncated/);
  });

  it('rejects excess rows beyond IHDR height', () => {
    const r = new ScanlineReconstructor(info({ width: 1, height: 2, colorType: 0 }));
    expect(() => r.push(new Uint8Array([0, 1, 0, 2, 0, 3]))).toThrowError(/excess data/);
  });

  it('rejects excess trailing bytes at finish()', () => {
    const r = new ScanlineReconstructor(info({ width: 1, height: 1, colorType: 0 }));
    r.push(new Uint8Array([0, 1, 42]));
    try {
      r.finish();
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(UnfilterError);
      expect((err as Error).message).toContain('excess data');
    }
  });

  it('rejects push() after finish()', () => {
    const r = new ScanlineReconstructor(info({ width: 1, height: 1, colorType: 0 }));
    r.push(new Uint8Array([0, 1]));
    r.finish();
    expect(() => r.push(new Uint8Array([0]))).toThrow(UnfilterError);
  });
});
