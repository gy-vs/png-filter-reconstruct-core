import { describe, expect, it } from 'vitest';
import {
  Ihdr,
  ScanlineReconstructor,
  bytesPerPixel,
  paeth,
  parseIhdr,
  readChunk,
  rowLength,
  unfilterRow,
} from '../src/index.js';

const gray = (width: number, height: number, bitDepth = 8): Ihdr => ({ width, height, bitDepth, colorType: 0 });

/** Push `stream` (in chunks of `chunkSize` when given), finish, and return all rows. */
function collect(header: Ihdr, stream: number[], chunkSize?: number): Uint8Array[] {
  const data = new Uint8Array(stream);
  const r = new ScanlineReconstructor(header);
  const rows: Uint8Array[] = [];
  if (chunkSize === undefined) rows.push(...r.push(data));
  else for (let i = 0; i < data.length; i += chunkSize) rows.push(...r.push(data.subarray(i, i + chunkSize)));
  r.finish();
  return rows;
}

const rowsOf = (rows: Uint8Array[]) => rows.map((r) => [...r]);

describe('bytesPerPixel', () => {
  it.each([
    [1, 0, 1], [2, 0, 1], [4, 0, 1], [8, 0, 1], [16, 0, 2],
    [8, 2, 3], [16, 2, 6],
    [1, 3, 1], [4, 3, 1], [8, 3, 1],
    [8, 4, 2], [16, 4, 4],
    [8, 6, 4], [16, 6, 8],
  ])('bitDepth %i colorType %i -> %i', (bitDepth, colorType, expected) => {
    expect(bytesPerPixel(bitDepth, colorType)).toBe(expected);
  });

  it('rejects unknown color types', () => {
    expect(() => bytesPerPixel(8, 5)).toThrow(/unknown color type 5/);
  });
});

describe('rowLength', () => {
  it.each([
    [1, 8, 0, 1],
    [3, 4, 0, 2],   // ceil(3*4/8)
    [9, 1, 0, 2],   // ceil(9/8)
    [5, 2, 0, 2],   // ceil(10/8)
    [2, 8, 2, 6],
    [1, 16, 2, 6],
    [7, 16, 0, 14],
    [4, 8, 6, 16],
    [3, 1, 3, 1],   // ceil(3/8)
  ])('width %i bitDepth %i colorType %i -> %i', (width, bitDepth, colorType, expected) => {
    expect(rowLength(width, bitDepth, colorType)).toBe(expected);
  });
});

describe('unfilterRow', () => {
  it('treats bytes before bpp as having no left neighbor (rows narrower than bpp)', () => {
    const sub = new Uint8Array([7, 8]);
    unfilterRow(1, sub, null, 4); // row shorter than bpp: Sub never applies
    expect([...sub]).toEqual([7, 8]);

    const avg = new Uint8Array([5, 5]);
    unfilterRow(3, avg, new Uint8Array([10, 10]), 4); // only "up" contributes
    expect([...avg]).toEqual([10, 10]);

    const pae = new Uint8Array([1, 1]);
    unfilterRow(4, pae, new Uint8Array([10, 20]), 4);
    expect([...pae]).toEqual([11, 21]);
  });

  it('locates invalid filter types by row number', () => {
    expect(() => unfilterRow(9, new Uint8Array(1), null, 1, 3)).toThrow('png: invalid filter type 9 on row 3');
  });
});

describe('ScanlineReconstructor filters', () => {
  it('None passes bytes through', () => {
    expect(rowsOf(collect(gray(3, 2), [0, 10, 20, 30, 0, 40, 50, 60]))).toEqual([
      [10, 20, 30],
      [40, 50, 60],
    ]);
  });

  it('Sub adds the reconstructed left byte', () => {
    expect(rowsOf(collect(gray(3, 1), [1, 10, 5, 5]))).toEqual([[10, 15, 20]]);
  });

  it('Up adds the row above', () => {
    expect(rowsOf(collect(gray(3, 2), [0, 10, 20, 30, 2, 1, 2, 3]))).toEqual([
      [10, 20, 30],
      [11, 22, 33],
    ]);
  });

  it('Average adds floor((left + up) / 2)', () => {
    // row 1: 8 + (0+4)>>1 = 10, 11 + (10+8)>>1 = 20
    expect(rowsOf(collect(gray(2, 2), [0, 4, 8, 3, 8, 11]))).toEqual([
      [4, 8],
      [10, 20],
    ]);
  });

  it('Paeth adds the Paeth predictor of left/up/up-left', () => {
    // row 1: 20 + paeth(0,100,0)=100 -> 120; 10 + paeth(120,50,100)=50 -> 60
    expect(rowsOf(collect(gray(2, 2), [0, 100, 50, 4, 20, 10]))).toEqual([
      [100, 50],
      [120, 60],
    ]);
  });

  it('treats the previous row as zeros on the first row (Up)', () => {
    expect(rowsOf(collect(gray(3, 1), [2, 5, 6, 7]))).toEqual([[5, 6, 7]]);
  });

  it('treats the previous row as zeros on the first row (Paeth == Sub)', () => {
    // paeth(a,0,0) === a: 5, then 3 + 5 = 8
    expect(rowsOf(collect(gray(2, 1), [4, 5, 3]))).toEqual([[5, 8]]);
  });

  it('wraps arithmetic as uint8 (Up)', () => {
    expect(rowsOf(collect(gray(2, 2), [0, 0, 200, 2, 100, 100]))).toEqual([
      [0, 200],
      [100, 44], // 200 + 100 = 300 wraps to 44
    ]);
  });

  it('wraps arithmetic as uint8 (Sub)', () => {
    expect(rowsOf(collect(gray(2, 1), [1, 250, 10]))).toEqual([[250, 4]]); // 250 + 10 wraps to 4
  });
});

describe('ScanlineReconstructor bit depths', () => {
  it('filters 1-bit rows per byte (bpp = 1)', () => {
    const r = new ScanlineReconstructor(gray(16, 1, 1));
    expect(r.bpp).toBe(1);
    expect(r.rowLength).toBe(2);
    const rows = r.push(new Uint8Array([1, 0xff, 0x01])); // Sub on packed bytes
    expect([...rows[0]]).toEqual([0xff, 0x00]); // 0x01 + 0xff wraps to 0x00
    r.finish();
  });

  it('filters 2-bit rows per byte', () => {
    const rows = collect(gray(5, 2, 2), [0, 0x1b, 0x80, 2, 0x01, 0x01]);
    expect(rowsOf(rows)).toEqual([
      [0x1b, 0x80],
      [0x1c, 0x81],
    ]);
  });

  it('filters 4-bit rows per byte', () => {
    expect(rowsOf(collect(gray(3, 1, 4), [1, 0x12, 0x22]))).toEqual([[0x12, 0x34]]);
  });

  it('filters 4-bit indexed rows per byte', () => {
    const rows = collect({ width: 4, height: 1, bitDepth: 4, colorType: 3 }, [0, 0xab, 0xcd]);
    expect(rowsOf(rows)).toEqual([[0xab, 0xcd]]);
  });

  it('uses 2-byte bpp for 16-bit gray', () => {
    const r = new ScanlineReconstructor(gray(2, 1, 16));
    expect(r.bpp).toBe(2);
    expect(r.rowLength).toBe(4);
    // Sub: second sample's bytes differ from the first sample's
    const rows = r.push(new Uint8Array([1, 0x12, 0x34, 0x44, 0x44]));
    expect([...rows[0]]).toEqual([0x12, 0x34, 0x56, 0x78]);
    r.finish();
  });

  it('uses 6-byte bpp for 16-bit rgb; a 1-pixel row is all "no left neighbor"', () => {
    const r = new ScanlineReconstructor({ width: 1, height: 1, bitDepth: 16, colorType: 2 });
    expect(r.bpp).toBe(6);
    expect(r.rowLength).toBe(6);
    const rows = r.push(new Uint8Array([1, 0, 1, 2, 3, 4, 5])); // Sub
    expect([...rows[0]]).toEqual([0, 1, 2, 3, 4, 5]);
    r.finish();
  });

  it('handles rows exactly as wide as bpp (1-pixel rgb)', () => {
    expect(rowsOf(collect({ width: 1, height: 1, bitDepth: 8, colorType: 2 }, [1, 10, 20, 30]))).toEqual([
      [10, 20, 30],
    ]);
  });
});

describe('ScanlineReconstructor incremental input', () => {
  const stream = [0, 1, 2, 2, 10, 10, 1, 5, 5]; // rows: [1,2], Up->[11,12], Sub->[5,10]
  const expected = [
    [1, 2],
    [11, 12],
    [5, 10],
  ];

  it('reassembles rows across irregular IDAT boundaries', () => {
    const r = new ScanlineReconstructor(gray(2, 3));
    const rows: number[][] = [];
    for (const chunk of [[0, 1], [2, 2, 10], [10, 1], [5, 5]]) {
      rows.push(...r.push(new Uint8Array(chunk)).map((row) => [...row]));
    }
    r.finish();
    expect(rows).toEqual(expected);
  });

  it('handles byte-at-a-time pushes', () => {
    expect(rowsOf(collect(gray(2, 3), stream, 1))).toEqual(expected);
  });

  it('waits for a filter-type byte split across chunks', () => {
    const r = new ScanlineReconstructor(gray(2, 1));
    expect(r.push(new Uint8Array(0))).toEqual([]);
    expect(r.push(new Uint8Array([2]))).toEqual([]); // filter byte only, row incomplete
    expect(rowsOf(r.push(new Uint8Array([9, 8])))).toEqual([[9, 8]]);
    r.finish();
  });
});

describe('ScanlineReconstructor strict row count', () => {
  it('emits exactly as many rows as IHDR height', () => {
    const r = new ScanlineReconstructor(gray(2, 3));
    const rows = r.push(new Uint8Array([0, 1, 2, 0, 3, 4, 0, 5, 6]));
    expect(rows).toHaveLength(3);
    expect(r.rowsEmitted).toBe(3);
    expect(r.done).toBe(true);
    expect(r.push(new Uint8Array(0))).toEqual([]);
    r.finish();
  });

  it('reports the row number on truncation', () => {
    const r = new ScanlineReconstructor(gray(2, 2));
    expect(r.push(new Uint8Array([0, 1, 2]))).toHaveLength(1); // row 0 complete
    r.push(new Uint8Array([2, 10])); // filter byte + 1 of 2 bytes of row 1
    expect(r.rowsEmitted).toBe(1);
    expect(() => r.finish()).toThrow(/truncated scanline data on row 1 of 2/);
  });

  it('reports row 0 when no data arrives at all', () => {
    const r = new ScanlineReconstructor(gray(2, 2));
    expect(() => r.finish()).toThrow(/truncated scanline data on row 0 of 2/);
  });

  it('rejects excess bytes pushed after the final row', () => {
    const r = new ScanlineReconstructor(gray(1, 1));
    expect(r.push(new Uint8Array([0, 42]))).toHaveLength(1);
    expect(() => r.push(new Uint8Array([0]))).toThrow(/1 excess byte\(s\) after final row 0/);
  });

  it('keeps row count strict and flags excess from the same chunk at finish', () => {
    const r = new ScanlineReconstructor(gray(1, 2));
    const rows = r.push(new Uint8Array([0, 1, 0, 2, 0, 3, 0])); // 3 rows worth for height 2
    expect(rowsOf(rows)).toEqual([[1], [2]]); // no third row is emitted
    expect(r.rowsEmitted).toBe(2);
    expect(() => r.finish()).toThrow(/3 excess byte\(s\) after final row/);
  });

  it('locates invalid filter types by row number', () => {
    const r = new ScanlineReconstructor(gray(1, 3));
    expect(r.push(new Uint8Array([0, 7]))).toHaveLength(1); // row 0 ok
    expect(() => r.push(new Uint8Array([5, 9]))).toThrow('png: invalid filter type 5 on row 1');
  });
});

describe('parseIhdr', () => {
  const ihdrData = (width: number, height: number, bitDepth: number, colorType: number, interlace = 0) => {
    const data = new Uint8Array(13);
    const view = new DataView(data.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    data[8] = bitDepth;
    data[9] = colorType;
    data[12] = interlace;
    return data;
  };

  it('parses the 13-byte IHDR data', () => {
    expect(parseIhdr(ihdrData(256, 128, 8, 6))).toEqual({
      width: 256,
      height: 128,
      bitDepth: 8,
      colorType: 6,
      interlace: 0,
    });
  });

  it('rejects wrong sizes and unknown methods', () => {
    expect(() => parseIhdr(new Uint8Array(12))).toThrow(/13 bytes/);
    const bad = ihdrData(1, 1, 8, 0);
    bad[10] = 1;
    expect(() => parseIhdr(bad)).toThrow(/compression or filter method/);
  });

  it('composes with readChunk', () => {
    const data = ihdrData(2, 1, 8, 0);
    const chunk = readChunk(new Uint8Array([0, 0, 0, 13, 73, 72, 68, 82, ...data, 0, 0, 0, 0]));
    expect(chunk?.type).toBe('IHDR');
    const r = new ScanlineReconstructor(parseIhdr(chunk!.data));
    expect(rowsOf(r.push(new Uint8Array([0, 9, 8])))).toEqual([[9, 8]]);
    r.finish();
  });
});

describe('ScanlineReconstructor validation', () => {
  it.each<[Ihdr, RegExp]>([
    [{ width: 0, height: 1, bitDepth: 8, colorType: 0 }, /invalid width 0/],
    [{ width: 1, height: 0, bitDepth: 8, colorType: 0 }, /invalid height 0/],
    [{ width: 1, height: 1, bitDepth: 8, colorType: 5 }, /unknown color type 5/],
    [{ width: 1, height: 1, bitDepth: 3, colorType: 0 }, /bit depth 3 not allowed for color type 0/],
    [{ width: 1, height: 1, bitDepth: 16, colorType: 3 }, /bit depth 16 not allowed for color type 3/],
    [{ width: 1, height: 1, bitDepth: 4, colorType: 6 }, /bit depth 4 not allowed for color type 6/],
    [{ width: 1, height: 1, bitDepth: 8, colorType: 0, interlace: 1 }, /interlace method 1 not supported/],
  ])('rejects %o', (bad, pattern) => {
    expect(() => new ScanlineReconstructor(bad)).toThrow(pattern);
  });
});

describe('round-trip', () => {
  const mulberry32 = (seed: number) => {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  /** Forward-filter a reconstructed row (inverse of unfilterRow). */
  const filterRow = (filter: number, recon: Uint8Array, prev: Uint8Array, bpp: number) => {
    const raw = new Uint8Array(recon.length);
    for (let i = 0; i < recon.length; i++) {
      const a = i >= bpp ? recon[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let p = 0;
      if (filter === 1) p = a;
      else if (filter === 2) p = b;
      else if (filter === 3) p = (a + b) >> 1;
      else if (filter === 4) p = paeth(a, b, c);
      raw[i] = (recon[i] - p) & 0xff;
    }
    return raw;
  };

  it('reconstructs random filtered streams pushed in random chunks', () => {
    const rand = mulberry32(12345);
    const configs: Ihdr[] = [
      gray(7, 5), // 8-bit gray
      { width: 5, height: 4, bitDepth: 8, colorType: 6 }, // rgba
      { width: 3, height: 4, bitDepth: 16, colorType: 0 }, // 16-bit gray
      { width: 1, height: 6, bitDepth: 8, colorType: 2 }, // rgb, rowLength == bpp
      { width: 9, height: 4, bitDepth: 4, colorType: 0 }, // packed 4-bit
      { width: 13, height: 3, bitDepth: 1, colorType: 3 }, // packed 1-bit indexed
    ];
    for (const header of configs) {
      const r = new ScanlineReconstructor(header);
      const prev = new Uint8Array(r.rowLength);
      const expected: number[][] = [];
      const stream: number[] = [];
      for (let y = 0; y < header.height; y++) {
        const recon = new Uint8Array(r.rowLength).map(() => Math.floor(rand() * 256));
        const filter = Math.floor(rand() * 5);
        stream.push(filter, ...filterRow(filter, recon, prev, r.bpp));
        prev.set(recon);
        expected.push([...recon]);
      }
      const data = new Uint8Array(stream);
      const rows: number[][] = [];
      for (let i = 0; i < data.length; ) {
        const n = 1 + Math.floor(rand() * 7);
        rows.push(...r.push(data.subarray(i, i + n)).map((row) => [...row]));
        i += n;
      }
      r.finish();
      expect(rows).toEqual(expected);
    }
  });
});
