import { describe, expect, it } from 'vitest';
import { StreamingPNGDecoder, type DecodedRow, paeth } from '../src/index.js';
import {
  buildPNG,
  chunk,
  concat,
  idatFromFiltered,
  ihdr,
  standardPNG,
} from './helpers.js';

/**
 * Filter reconstruction at 16-bit depth: the "left" byte distance is
 * channels*2, so a wrong bpp silently corrupts all but the first pixel.
 */
describe('16-bit filter reconstruction', () => {
  const filters = [0, 1, 2, 3, 4];

  for (const filter of filters) {
    it(`type ${filter} on 16-bit gray+alpha`, async () => {
      const W = 5;
      const H = 3;
      // Logical [gray, alpha] per pixel, 16-bit.
      const logical: number[][] = [];
      for (let y = 0; y < H; y++) {
        const row: number[] = [];
        for (let x = 0; x < W; x++) {
          row.push((x * 7000 + y * 300 + 1) & 0xffff, ((x ^ y) * 1000 + 5) & 0xffff);
        }
        logical.push(row);
      }
      const stored = logical.map((row) => {
        const bytes = new Uint8Array(W * 4);
        const dv = new DataView(bytes.buffer);
        row.forEach((v, i) => dv.setUint16(i * 2, v));
        return bytes;
      });

      const bpp = 4; // gray+alpha 16-bit => 4 bytes
      const filtered: Uint8Array[] = [];
      for (let y = 0; y < H; y++) {
        const row = stored[y]!;
        const prev = y > 0 ? stored[y - 1]! : null;
        const out = new Uint8Array(1 + row.length);
        out[0] = filter;
        out.set(row, 1);
        for (let x = 0; x < row.length; x++) {
          const left = x >= bpp ? row[x - bpp]! : 0;
          const up = prev?.[x] ?? 0;
          const upLeft = x >= bpp && prev ? prev[x - bpp]! : 0;
          let delta = 0;
          switch (filter) {
            case 0: continue;
            case 1: delta = left; break;
            case 2: delta = up; break;
            case 3: delta = (left + up) >> 1; break;
            case 4: delta = paeth(left, up, upLeft); break;
          }
          out[x + 1] = (row[x]! - delta) & 0xff;
        }
        filtered.push(out);
      }

      const png = buildPNG([
        ihdr(W, H, 16, 4),
        ...idatFromFiltered(filtered),
        chunk('IEND'),
      ]);
      const image = await (() => {
        const d = new StreamingPNGDecoder();
        d.push(png);
        return d.finish();
      })();
      const data = image!.data as Uint16Array;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          const gray = logical[y]![x * 2]!;
          const alpha = logical[y]![x * 2 + 1]!;
          expect([data[o], data[o + 1], data[o + 2], data[o + 3]]).toEqual([
            gray,
            gray,
            gray,
            alpha,
          ]);
        }
      }
    });
  }
});

describe('onError callback', () => {
  it('is invoked exactly once on structural failure', async () => {
    // Type 3 with a bad index somewhere in the middle rows.
    const W = 4;
    const palette = chunk(
      'PLTE',
      Uint8Array.from([10, 20, 30, 40, 50, 60]),
    );
    const good = Uint8Array.from([0, 0, 0, 0]);
    const bad = Uint8Array.from([0, 0, 2, 0]); // index 2, only 2 entries
    const png = buildPNG([
      ihdr(W, 4, 8, 3),
      palette,
      ...idatFromFiltered([
        concat([Uint8Array.of(0), good]),
        concat([Uint8Array.of(0), bad]),
        concat([Uint8Array.of(0), good]),
        concat([Uint8Array.of(0), good]),
      ]),
      chunk('IEND'),
    ]);

    const errors: Error[] = [];
    const rows: DecodedRow[] = [];
    const d = new StreamingPNGDecoder({
      collect: false,
      onError: (e) => errors.push(e),
      onRow: (r) => rows.push(r),
    });
    d.push(png);
    await expect(d.finish()).rejects.toMatchObject({
      code: 'PALETTE_INDEX_OUT_OF_RANGE',
      row: 1,
    });
    expect(errors.length).toBe(1);
    // Only the one good row before the bad one was emitted.
    expect(rows.length).toBe(1);
  });
});

describe('row callback failure', () => {
  it('aborts decoding when onRow throws, without emitting further rows', async () => {
    const rows: Uint8Array[] = [];
    for (let i = 0; i < 4; i++) rows.push(new Uint8Array(4));
    const png = standardPNG(1, 4, 8, 6, rows);
    let seen = 0;
    const d = new StreamingPNGDecoder({
      collect: false,
      onRow: () => {
        seen++;
        throw new Error('consumer gave up');
      },
    });
    d.push(png);
    await expect(d.finish()).rejects.toMatchObject({ code: 'CALLBACK_ERROR' });
    expect(seen).toBe(1);
  });
});
