import { expect, it, describe } from 'vitest';
import { PngDecoder, type DecodedRow } from '../src/index.js';
import {
  buildPng,
  buildLargeRgbaPng,
  pushStreamingPng,
  patternPixel,
} from './helpers/png-builder.js';

const gc: (() => void) | undefined = (globalThis as any).gc;

function usedMb(): number {
  return Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 10) / 10;
}

describe('speed', () => {
  it('decodes a 2000x2000 RGBA image in under 1.5s (whole buffer)', async () => {
    const png = buildPng({
      width: 2000,
      height: 2000,
      bitDepth: 8,
      colorType: 6,
      pixel: patternPixel,
      filter: 4,
    });

    const dec = new PngDecoder();
    const t0 = performance.now();
    await dec.push(png);
    const img = await dec.end();
    const elapsed = performance.now() - t0;

    expect((img!.data as Uint8Array).length).toBe(2000 * 2000 * 4);
    // eslint-disable-next-line no-console
    console.log(`2000x2000 whole-image decode: ${elapsed.toFixed(0)} ms`);
    expect(elapsed).toBeLessThan(1500);
  });
});

describe('streaming memory does not scale with height', () => {
  it(
    '4000x30000 row mode stays in the same memory order as 4000x300',
    { timeout: 60000 },
    async () => {
      const W = 4000;
      const tall = await buildLargeRgbaPng(W, 30000, 16384);
      const short = await buildLargeRgbaPng(W, 300, 16384);

      // Compressed pieces are small; the full raw image is never built.
      expect(tall.idatPieces.length).toBeGreaterThan(50);

      let tallRows = 0;
      const tallDec = new PngDecoder({
        onRow: (r) => {
          tallRows++;
          // Every delivered buffer is exactly one scanline: W*4 bytes.
          if (r.data.length !== W * 4) throw new Error('row buffer too big');
        },
      });

      const measure = gc !== undefined;
      gc?.();
      const before = measure ? usedMb() : 0;
      await pushStreamingPng(tallDec, tall);
      const after = measure ? usedMb() : 0;
      expect(tallRows).toBe(30000);

      let shortRows = 0;
      const shortDec = new PngDecoder({ onRow: () => shortRows++ });
      gc?.();
      const beforeShort = measure ? usedMb() : 0;
      await pushStreamingPng(shortDec, short);
      const afterShort = measure ? usedMb() : 0;
      expect(shortRows).toBe(300);

      if (measure) {
        const tallDelta = after - before;
        const shortDelta = afterShort - beforeShort;
        // eslint-disable-next-line no-console
        console.log(
          `heap delta tall=${tallDelta}MB short=${shortDelta}MB ` +
            `(absolute after: tall=${after}MB short=${afterShort}MB)`,
        );
        // Requirement: the 100x taller decode must not cause ~100x heap
        // growth. Retained decoder state is bounded by width; tolerate GC
        // noise but cap absolute extra growth and require the same order
        // of magnitude as the 300-row decode.
        expect(tallDelta).toBeLessThan(120);
        expect(tallDelta).toBeLessThan(
          Math.max(40, shortDelta * 5 + 40),
        );
      }
    },
  );

  it('row-mode decoder never allocates the full image for tall input', async () => {
    // A 1000x1000 RGBA image would need a 4MB output buffer. In row mode
    // each delivered buffer must be exactly one 4000-byte scanline.
    const handle = await buildLargeRgbaPng(1000, 1000, 4096);
    const seen = new Set<DecodedRow['data']>();
    let rows = 0;
    const dec = new PngDecoder({
      onRow: (r) => {
        rows++;
        expect(r.data).toBeInstanceOf(Uint8Array);
        expect(r.data.length).toBe(1000 * 4);
        seen.add(r.data);
      },
    });
    await pushStreamingPng(dec, handle);
    expect(rows).toBe(1000);
    // Every row got its own buffer: no alias across deliveries.
    expect(seen.size).toBe(1000);
  });
});
