import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { createDeflate } from 'node:zlib';
import { StreamingPNGDecoder, type DecodedRow } from '../src/index.js';
import {
  buildPNG,
  chunk,
  concat,
  corruptCrc,
  idatChunks,
  idatFromFiltered,
  ihdr,
  paletteChunk,
  rgbaRow,
  standardPNG,
} from './helpers.js';

function rgba(w: number, h: number, fill: (x: number, y: number) => [number, number, number, number]) {
  const rows: Uint8Array[] = [];
  for (let y = 0; y < h; y++) {
    const pixels: Array<[number, number, number, number]> = [];
    for (let x = 0; x < w; x++) pixels.push(fill(x, y));
    rows.push(rgbaRow(pixels));
  }
  return rows;
}

/** Structural errors may surface either on push() or from finish(). */
async function expectFailure(
  png: Uint8Array,
  match: Record<string, unknown>,
  opts: ConstructorParameters<typeof StreamingPNGDecoder>[0] = {},
): Promise<void> {
  const d = new StreamingPNGDecoder(opts);
  let pushError: unknown = null;
  try {
    d.push(png);
  } catch (error) {
    pushError = error;
  }
  await expect(d.finish()).rejects.toMatchObject(match);
  if (pushError) expect(pushError).toMatchObject(match);
}

describe('structural validation', () => {
  it('rejects CRC errors in IHDR', async () => {
    const badIhdr = corruptCrc(ihdr(1, 1, 8, 6));
    const png = buildPNG([badIhdr, ...idatChunks([rgbaRow([[0, 0, 0, 0]])]), chunk('IEND')]);
    await expectFailure(png, { code: 'CRC_MISMATCH' });
  });

  it('rejects CRC errors in IDAT as CRC_MISMATCH', async () => {
    // Force two IDAT chunks; corrupt the CRC of the first one.
    const rows = [rgbaRow([[1, 2, 3, 4], [5, 6, 7, 8]])];
    const [a, b] = idatChunks(rows, { splits: 2 });
    const badIdat = corruptCrc(a!);
    const png = buildPNG([ihdr(2, 1, 8, 6), badIdat, b!, chunk('IEND')]);
    await expectFailure(png, { code: 'CRC_MISMATCH' }, { collect: false });
  });

  it('rejects CRC errors in IEND', async () => {
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      ...idatChunks([rgbaRow([[0, 0, 0, 255]])]),
      corruptCrc(chunk('IEND')),
    ]);
    await expectFailure(png, { code: 'CRC_MISMATCH' });
  });

  it('rejects unknown critical chunks', async () => {
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      chunk('XzYt', new Uint8Array([1, 2, 3])),
      ...idatChunks([rgbaRow([[0, 0, 0, 0]])]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'UNKNOWN_CRITICAL_CHUNK' });
  });

  it('rejects chunks after IEND', async () => {
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      ...idatChunks([rgbaRow([[0, 0, 0, 0]])]),
      chunk('IEND'),
      chunk('tEXt', new TextEncoder().encode('a\x00b')),
    ]);
    await expectFailure(png, { code: 'DATA_AFTER_IEND' });
  });

  it('rejects IEND without any IDAT', async () => {
    const png = buildPNG([ihdr(1, 1, 8, 6), chunk('IEND')]);
    await expectFailure(png, { code: 'MISSING_IDAT' });
  });

  it('rejects IDAT before IHDR', async () => {
    // Construct manually: IDAT first.
    const png = buildPNG([
      ...idatChunks([rgbaRow([[0, 0, 0, 0]])]),
      ihdr(1, 1, 8, 6),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'BAD_CHUNK_ORDER' });
  });

  it('rejects PLTE before IHDR', async () => {
    const png = buildPNG([
      paletteChunk([[1, 2, 3]]),
      ihdr(1, 1, 8, 3),
      ...idatChunks([Uint8Array.of(0)]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'BAD_CHUNK_ORDER' });
  });

  it('rejects PLTE after IDAT', async () => {
    const rows = [rgbaRow([[0, 0, 0, 0]])];
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      ...idatChunks(rows),
      paletteChunk([[1, 2, 3]]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'BAD_CHUNK_ORDER' });
  });

  it('rejects indexed images without a palette', async () => {
    const png = buildPNG([
      ihdr(1, 1, 8, 3),
      ...idatChunks([Uint8Array.of(0)]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'BAD_PALETTE' });
  });

  it('rejects illegal IHDR combinations', async () => {
    // depth 16 for indexed
    let png = buildPNG([
      ihdr(1, 1, 16, 3),
      paletteChunk([[0, 0, 0]]),
      ...idatChunks([new Uint8Array(2)]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'BAD_IHDR' });

    // unknown colour type 7
    png = buildPNG([
      ihdr(1, 1, 8, 7 as never),
      ...idatChunks([rgbaRow([[0, 0, 0, 0]])]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'BAD_IHDR' });
  });

  it('rejects decompressed data that is too short', async () => {
    // Claim 2 rows but only provide one.
    const png = buildPNG([
      ihdr(1, 2, 8, 6),
      ...idatChunks([rgbaRow([[0, 0, 0, 0]])]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'RAW_DATA_LENGTH' });
  });

  it('rejects decompressed data that is too long', async () => {
    // Claim 1 row but provide two.
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      ...idatChunks([rgbaRow([[0, 0, 0, 0]]), rgbaRow([[0, 0, 0, 0]])]),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'RAW_DATA_LENGTH' });
  });

  it('rejects garbage IDAT content as INFLATE_FAILED', async () => {
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      chunk('IDAT', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])),
      chunk('IEND'),
    ]);
    await expectFailure(png, { code: 'INFLATE_FAILED' });
  });

  it('rejects a non-empty IEND chunk', async () => {
    const png = buildPNG([
      ihdr(1, 1, 8, 6),
      ...idatChunks([rgbaRow([[0, 0, 0, 0]])]),
      chunk('IEND', new Uint8Array(1)),
    ]);
    await expectFailure(png, { code: 'BAD_CHUNK_LENGTH' });
  });
});

describe('failure is terminal', () => {
  it('does not emit any more rows after a failure', async () => {
    // Three stored rows (filter 0), except the middle one uses filter 5.
    const W = 2;
    const good = (): Uint8Array => {
      const r = new Uint8Array(1 + W * 4);
      r.set([1, 2, 3, 4, 5, 6, 7, 8], 1);
      return r;
    };
    const bad = (): Uint8Array => {
      const r = good();
      r[0] = 5;
      return r;
    };
    const png = buildPNG([
      ihdr(W, 3, 8, 6),
      ...idatFromFiltered([good(), bad(), good()]),
      chunk('IEND'),
    ]);
    const delivered: DecodedRow[] = [];
    let errorCount = 0;
    const d = new StreamingPNGDecoder({
      collect: false,
      onRow: (r) => delivered.push(r),
      onError: () => {
        errorCount++;
      },
    });
    d.push(png);
    await expect(d.finish()).rejects.toMatchObject({ code: 'BAD_FILTER' });
    // The bad row never fires.
    expect(delivered.map((r) => r.yPos)).toEqual([0]);

    // Further pushes are inert and throw the same error.
    expect(() => d.push(new Uint8Array(100))).toThrow(
      expect.objectContaining({ code: 'BAD_FILTER' }),
    );
    // finish() stays rejected with the same error.
    await expect(d.finish()).rejects.toMatchObject({ code: 'BAD_FILTER' });
    expect(errorCount).toBe(1);
  });
});

describe('streaming modes', () => {
  it('onRow works while still collecting the full image', async () => {
    const rows = rgba(3, 2, (x, y) => [x, y, 0, 255]);
    const png = standardPNG(3, 2, 8, 6, rows);
    const seen: DecodedRow[] = [];
    const d = new StreamingPNGDecoder({
      collect: true,
      onRow: (r) => seen.push(r),
    });
    d.push(png);
    const image = await d.finish();
    expect(seen.length).toBe(2);
    expect(Array.from(seen[0]!.data as Uint8Array)).toEqual([
      0, 0, 0, 255, 1, 0, 0, 255, 2, 0, 0, 255,
    ]);
    expect(image!.data.length).toBe(3 * 2 * 4);
  });

  it('does not collect when collect:false', async () => {
    const rows = rgba(2, 1, () => [1, 2, 3, 4]);
    const png = standardPNG(2, 1, 8, 6, rows);
    const d = new StreamingPNGDecoder({ collect: false });
    d.push(png);
    expect(await d.finish()).toBeNull();
  });

  it('delivers rows progressively before finish() resolves', async () => {
    // A tall, highly compressible image: well before the last byte is
    // pushed, early scanlines must already have been handed out.
    const rows = rgba(16, 200, (x, y) => [x & 0xff, y & 0xff, 99, 255]);
    const png = standardPNG(16, 200, 8, 6, rows);

    let rowsBeforeEnd = 0;
    const d = new StreamingPNGDecoder({
      collect: false,
      onRow: (r) => {
        if (r.yPos < 100) rowsBeforeEnd++;
      },
    });

    // Feed only the first ~70% of the file.
    const cutAt = Math.floor(png.length * 0.7);
    for (let i = 0; i < cutAt; i += 64) {
      d.push(png.subarray(i, Math.min(i + 64, cutAt)));
    }
    // Let zlib's queued data events drain (they fire on I/O threadpool
    // completion, a timer tick or two after the writes).
    await new Promise((r) => setTimeout(r, 20));
    expect(rowsBeforeEnd).toBeGreaterThan(0);

    // Finish the rest.
    for (let i = cutAt; i < png.length; i += 64) {
      d.push(png.subarray(i, Math.min(i + 64, png.length)));
    }
    expect(await d.finish()).toBeNull();
  });
});

describe('memory: line streaming keeps O(width) state', () => {
  /**
   * Sum byte sizes of TypedArrays reachable from the decoder instance
   * itself. The decoder must never hold a height-proportional buffer in
   * line-streaming mode.
   */
  const retainedSize = (d: StreamingPNGDecoder) => {
    const seen = new Set<object>();
    let total = 0;
    const walk = (obj: unknown, depth: number) => {
      if (!obj || typeof obj !== 'object' || depth > 5 || seen.has(obj)) return;
      seen.add(obj);
      if (ArrayBuffer.isView(obj) && !(obj instanceof DataView)) {
        total += (obj as { byteLength: number }).byteLength;
        return;
      }
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        try {
          walk((obj as Record<string, unknown>)[key], depth + 1);
        } catch {
          // ignore accessors
        }
      }
    };
    walk(d, 0);
    return total;
  };

  /**
   * Stream a synthetic 4000 x h RGBA image: rows are generated one at a
   * time and fed through a deflate stream straight into the decoder, so
   * neither side ever holds the whole image.
   */
  const streamImage = (h: number) =>
    new Promise<{ atHalf: number; atEnd: number; max: number }>((resolve, reject) => {
      const W = 4000;
      const rowBytes = W * 4;
      let atHalf = 0;
      let max = 0;
      const d = new StreamingPNGDecoder({
        collect: false,
        onRow: (r) => {
          if (r.yPos === Math.floor(h / 2) || r.yPos === h - 1) {
            const size = retainedSize(d);
            max = Math.max(max, size);
            if (r.yPos === Math.floor(h / 2)) atHalf = size;
          }
        },
      });

      d.push(buildPNG([ihdr(W, h, 8, 6)]));

      // Each deflate output piece becomes its own (consecutive) IDAT
      // chunk, exactly like a network sender fragmenting the stream.
      const def = createDeflate({ level: 1 });
      def.on('data', (part: Buffer) => {
        const bytes = new Uint8Array(part.buffer, part.byteOffset, part.byteLength);
        // buildPNG with an empty signature yields a bare framed chunk.
        d.push(buildPNG([chunk('IDAT', bytes)], new Uint8Array(0)));
      });
      def.on('error', reject);

      let y = 0;
      const writeNext = () => {
        const stored = new Uint8Array(1 + rowBytes);
        // filter type 0 (None); every pixel identical, so the stream
        // compresses to almost nothing.
        for (let x = 0; x < W; x++) {
          stored[1 + x * 4 + 3] = 255;
        }
        const wrote = def.write(
          Buffer.from(stored.buffer, stored.byteOffset, stored.byteLength),
        );
        y++;
        if (y < h) {
          if (wrote) {
            setImmediate(writeNext);
          } else {
            def.once('drain', writeNext);
          }
        } else {
          def.end();
        }
      };
      // Once compression is fully flushed, every IDAT chunk has been
      // handed over; append IEND and close on a fresh stack frame.
      def.on('end', () => {
        setImmediate(() => {
          try {
            d.push(buildPNG([chunk('IEND')], new Uint8Array(0)));
            d
              .finish()
              .then(() => resolve({ atHalf, atEnd: retainedSize(d), max }))
              .catch(reject);
          } catch (error) {
            reject(error);
          }
        });
      });

      writeNext();
    });

  it('retained state is independent of height (4000x300 vs 4000x30000)', async () => {
    const small = await streamImage(300);
    const large = await streamImage(30_000);
    // Width-proportional state only: allow a small constant slack but never
    // height-proportional growth.
    const slack = 4 * 1024 * 1024; // zlib window + chunk buffers
    expect(large.max).toBeLessThan(small.max + slack);
    expect(large.atHalf).toBeLessThan(small.atHalf + slack);
  }, 60_000);
});

describe('performance', () => {
  it('decodes a 2000x2000 RGBA8 image in well under 1.5s', async () => {
    const w = 2000;
    const h = 2000;
    const rows = rgba(w, h, (x, y) => [
      (x * 3 + y * 5) & 255,
      (x * 7 + y) & 255,
      (x + y * 11) & 255,
      255,
    ]);
    const png = standardPNG(w, h, 8, 6, rows);

    // Warmup (JIT + allocator).
    {
      const d = new StreamingPNGDecoder();
      d.push(png);
      const img = await d.finish();
      expect(img!.data.length).toBe(w * h * 4);
    }

    const start = performance.now();
    const d = new StreamingPNGDecoder();
    d.push(png);
    const img = await d.finish();
    const elapsedMs = performance.now() - start;
    // Verify correctness while we're here.
    expect(img!.data[0]).toBe(0);
    expect(img!.data[(123 * w + 456) * 4]).toBe((456 * 3 + 123 * 5) & 255);
    // Budget 1.5s per the requirement; assert a generous bound so the
    // test is stable on slow CI while still guarding the target.
    expect(elapsedMs).toBeLessThan(1500);
  }, 30_000);
});
