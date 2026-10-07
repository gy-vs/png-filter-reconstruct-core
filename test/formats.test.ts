import { expect, it, describe } from 'vitest';
import { PngDecoder, PngDecodeError } from '../src/index.js';
import {
  buildPng,
  mulberry32,
  chunkBytes,
  type BuildOptions,
} from './helpers/png-builder.js';

const VALID: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [0, 4],
  [0, 8],
  [0, 16],
  [2, 8],
  [2, 16],
  [3, 1],
  [3, 2],
  [3, 4],
  [3, 8],
  [4, 8],
  [4, 16],
  [6, 8],
  [6, 16],
];

// Expected RGBA for pixel (x,y) in each format; samples are 16-bit where
// applicable.
function expectedRgba(
  colorType: number,
  bitDepth: number,
  samples: number[],
  trns?: { kind: number; value?: number; rgb?: number[]; alpha?: Map<number, number> },
): number[] {
  const depth = bitDepth === 16 ? 16 : 8;
  const opaque = bitDepth === 16 ? 0xffff : 255;
  const gray8 = (v: number, d: number) =>
    d === 8 ? v : Math.round((v * 255) / ((1 << d) - 1));
  void trns;

  switch (colorType) {
    case 0: {
      const v = bitDepth === 16 ? samples[0] : gray8(samples[0], bitDepth);
      const a =
        trns && samples[0] === trns.value
          ? 0
          : opaque;
      return [v, v, v, a];
    }
    case 2: {
      let a = opaque;
      if (trns && trns.rgb) {
        const [r, g, b] = trns.rgb;
        if (samples[0] === r && samples[1] === g && samples[2] === b) a = 0;
      }
      return [samples[0], samples[1], samples[2], a];
    }
    case 3: {
      return []; // handled by palette tests
    }
    case 4:
      return [samples[0], samples[0], samples[0], samples[1]];
    case 6:
      return samples.slice(0, 4);
    default:
      throw new Error('unreachable');
  }
}

// A pixel generator exercising different sample values across the image.
function makePixel(colorType: number, bitDepth: number) {
  const max = (1 << bitDepth) - 1;
  return (x: number, y: number): number[] => {
    const v = (x * 17 + y * 31) & max;
    const v2 = (x * 7 + y * 13 + 3) & max;
    switch (colorType) {
      case 0:
        return [v];
      case 2:
        return [v, v2, (v ^ v2) & max];
      case 3:
        return [v];
      case 4:
        return [v, (x + y) % 2 === 0 ? max : v2];
      case 6:
        return [v, v2, (v ^ v2) & max, (x + y) % 3 === 0 ? v : max];
      default:
        throw new Error('unreachable');
    }
  };
}

describe('all legal color-type / bit-depth combinations', () => {
  for (const [colorType, bitDepth] of VALID) {
    for (const interlace of [0, 1] as const) {
      it(`type ${colorType} depth ${bitDepth} interlace ${interlace}`, async () => {
        const w = 13;
        const h = 9;
        const pixel = makePixel(colorType, bitDepth);

        let palette: Uint8Array | undefined;
        let trns: Uint8Array | undefined;
        if (colorType === 3) {
          // palette covers every index the generator produces
          const entries = 1 << bitDepth;
          palette = new Uint8Array(entries * 3);
          for (let i = 0; i < entries; i++) {
            palette[i * 3] = (i * 11) & 255;
            palette[i * 3 + 1] = (i * 23 + 1) & 255;
            palette[i * 3 + 2] = (i * 47 + 2) & 255;
          }
          // fewer tRNS entries than palette entries
          trns = new Uint8Array(Math.max(1, entries - 3));
          for (let i = 0; i < trns.length; i++) trns[i] = i * 5;
        }

        const opts: BuildOptions = {
          width: w,
          height: h,
          bitDepth,
          colorType,
          interlace,
          pixel,
          palette,
          trns,
          filter: (pass, y) => (pass + y) % 5,
          idatSplit: 97,
        };
        const png = buildPng(opts);

        const decoder = new PngDecoder();
        const rng = mulberry32(colorType * 1000 + bitDepth * 10 + interlace);
        for (const part of chunkBytes(png, rng, 23)) {
          await decoder.push(part);
        }
        const img = await decoder.end();
        expect(img).toBeDefined();
        const data = img!.data as Uint8Array | Uint16Array;
        const is16 = bitDepth === 16;
        expect(data.length).toBe(w * h * 4);

        const expand8 = (v: number) =>
          bitDepth === 8 ? v : Math.round((v * 255) / ((1 << bitDepth) - 1));

        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const s = pixel(x, y);
            let expected: number[];
            if (colorType === 3) {
              const idx = s[0];
              expected = [
                palette![idx * 3],
                palette![idx * 3 + 1],
                palette![idx * 3 + 2],
                idx < trns!.length ? trns![idx] : 255,
              ];
            } else {
              expected = expectedRgba(colorType, bitDepth, s);
              if (colorType === 0 && bitDepth !== 16) {
                expected = [
                  expand8(s[0]),
                  expand8(s[0]),
                  expand8(s[0]),
                  255,
                ];
              }
            }
            const i = (y * w + x) * 4;
            const actual = [
              data[i],
              data[i + 1],
              data[i + 2],
              data[i + 3],
            ];
            if (!actual.every((v, k) => v === expected[k])) {
              throw new Error(
                `mismatch at (${x},${y}) ct=${colorType} bd=${bitDepth}: ` +
                  `got ${actual.join(',')} want ${expected.join(',')}`,
              );
            }
            void is16;
          }
        }
      });
    }
  }
});

describe('invalid combinations rejected', () => {
  const bad: Array<[number, number]> = [
    [0, 3],
    [2, 1],
    [2, 4],
    [3, 16],
    [4, 1],
    [6, 2],
  ];
  for (const [ct, bd] of bad) {
    it(`type ${ct} depth ${bd}`, async () => {
      const png = buildPng({
        width: 2,
        height: 2,
        bitDepth: bd,
        colorType: ct,
        pixel: () => [0, 0, 0, 0],
      });
      const decoder = new PngDecoder();
      await expect(decoder.push(png)).rejects.toBeInstanceOf(PngDecodeError);
    });
  }
});
