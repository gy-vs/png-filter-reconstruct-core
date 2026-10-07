import { PngDecodeError } from './error.js';
import type { ColorType } from './types.js';

/**
 * Where the current raw scanline lives in the final image. Passed to the
 * converter so palette index errors can name the row.
 */
export interface LineLocation {
  /** 0 for non-interlaced, 1..7 for Adam7. */
  pass: number;
  /** Row index inside the pass. */
  y: number;
}

/**
 * Convert one reconstructed raw scanline into tightly packed RGBA samples,
 * writing `width * 4` elements starting at `dstOffset` of `dst`.
 *
 * dst is a Uint8Array for 8-bit output and a Uint16Array for 16-bit output.
 */
export type PixelConverter = (
  src: Uint8Array,
  width: number,
  dst: Uint8Array | Uint16Array,
  dstOffset: number,
  loc: LineLocation,
) => void;

// Grayscale sample -> 8-bit luminance lookup tables (PNG 2.2: samples 0 and
// 2^depth-1 map to 0 and 255, interior samples are scaled).
function grayLut(depth: 1 | 2 | 4 | 8): Uint8Array {
  const lut = new Uint8Array(256);
  if (depth === 8) {
    // identity
  } else {
    const max = (1 << depth) - 1;
    for (let v = 0; v <= max; v++) {
      lut[v] = Math.round((v * 255) / max);
    }
  }
  return lut;
}

const LUT1 = grayLut(1);
const LUT2 = grayLut(2);
const LUT4 = grayLut(4);

function grayConverter(depth: 1 | 2 | 4 | 8): PixelConverter {
  const lut = depth === 1 ? LUT1 : depth === 2 ? LUT2 : depth === 4 ? LUT4 : null;
  if (lut !== null) {
    const bits = depth;
    return (src, width, dst, off) => {
      const mask = (1 << bits) - 1;
      for (let x = 0; x < width; x++) {
        const sample =
          (src[Math.floor(x / (8 / bits))] >>> (8 - bits - bits * (x % (8 / bits)))) & mask;
        const v = lut[sample];
        const j = (off + x) * 4;
        dst[j] = v;
        dst[j + 1] = v;
        dst[j + 2] = v;
        dst[j + 3] = 255;
      }
    };
  }
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const v = src[x];
      const j = (off + x) * 4;
      dst[j] = v;
      dst[j + 1] = v;
      dst[j + 2] = v;
      dst[j + 3] = 255;
    }
  };
}

function grayTrnsConverter(depth: 1 | 2 | 4 | 8, trns: Uint8Array): PixelConverter {
  const key = (trns[0] << 8) | trns[1]; // grayscale value in sample units
  const lut = depth === 1 ? LUT1 : depth === 2 ? LUT2 : depth === 4 ? LUT4 : null;
  if (lut !== null) {
    const bits = depth;
    return (src, width, dst, off) => {
      const mask = (1 << bits) - 1;
      for (let x = 0; x < width; x++) {
        const sample =
          (src[Math.floor(x / (8 / bits))] >>> (8 - bits - bits * (x % (8 / bits)))) & mask;
        const j = (off + x) * 4;
        const v = lut[sample];
        dst[j] = v;
        dst[j + 1] = v;
        dst[j + 2] = v;
        dst[j + 3] = sample === key ? 0 : 255;
      }
    };
  }
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const v = src[x];
      const j = (off + x) * 4;
      dst[j] = v;
      dst[j + 1] = v;
      dst[j + 2] = v;
      dst[j + 3] = v === key ? 0 : 255;
    }
  };
}

function gray16Converter(): PixelConverter {
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const v = (src[x * 2] << 8) | src[x * 2 + 1];
      const j = (off + x) * 4;
      dst[j] = v;
      dst[j + 1] = v;
      dst[j + 2] = v;
      dst[j + 3] = 0xffff;
    }
  };
}

function gray16TrnsConverter(trns: Uint8Array): PixelConverter {
  const key = (trns[0] << 8) | trns[1];
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const v = (src[x * 2] << 8) | src[x * 2 + 1];
      const j = (off + x) * 4;
      dst[j] = v;
      dst[j + 1] = v;
      dst[j + 2] = v;
      dst[j + 3] = v === key ? 0 : 0xffff;
    }
  };
}

function rgb8Converter(): PixelConverter {
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 3;
      const j = (off + x) * 4;
      dst[j] = src[i];
      dst[j + 1] = src[i + 1];
      dst[j + 2] = src[i + 2];
      dst[j + 3] = 255;
    }
  };
}

function rgb8TrnsConverter(trns: Uint8Array): PixelConverter {
  // tRNS stores each channel as a 2-byte big-endian value even for 8-bit
  // images: bytes are 0,R,0,G,0,B.
  const kr = trns[1];
  const kg = trns[3];
  const kb = trns[5];
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 3;
      const j = (off + x) * 4;
      const r = src[i];
      const g = src[i + 1];
      const b = src[i + 2];
      dst[j] = r;
      dst[j + 1] = g;
      dst[j + 2] = b;
      dst[j + 3] = r === kr && g === kg && b === kb ? 0 : 255;
    }
  };
}

function rgb16Converter(): PixelConverter {
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 6;
      const j = (off + x) * 4;
      dst[j] = (src[i] << 8) | src[i + 1];
      dst[j + 1] = (src[i + 2] << 8) | src[i + 3];
      dst[j + 2] = (src[i + 4] << 8) | src[i + 5];
      dst[j + 3] = 0xffff;
    }
  };
}

function rgb16TrnsConverter(trns: Uint8Array): PixelConverter {
  const kr = (trns[0] << 8) | trns[1];
  const kg = (trns[2] << 8) | trns[3];
  const kb = (trns[4] << 8) | trns[5];
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 6;
      const j = (off + x) * 4;
      const r = (src[i] << 8) | src[i + 1];
      const g = (src[i + 2] << 8) | src[i + 3];
      const b = (src[i + 4] << 8) | src[i + 5];
      dst[j] = r;
      dst[j + 1] = g;
      dst[j + 2] = b;
      dst[j + 3] = r === kr && g === kg && b === kb ? 0 : 0xffff;
    }
  };
}

function indexedConverter(
  depth: 1 | 2 | 4 | 8,
  palette: Uint8Array,
  trns: Uint8Array | null,
): PixelConverter {
  const entries = palette.length / 3;
  if (depth === 8) {
    return (src, width, dst, off, loc) => {
      for (let x = 0; x < width; x++) {
        const idx = src[x];
        if (idx >= entries) {
          throw new PngDecodeError(
            'palette-index',
            `palette index ${idx} out of range (palette has ${entries} entries) at row ${loc.y}${
              loc.pass ? ` of pass ${loc.pass}` : ''
            }, column ${x}`,
          );
        }
        const pi = idx * 3;
        const j = (off + x) * 4;
        dst[j] = palette[pi];
        dst[j + 1] = palette[pi + 1];
        dst[j + 2] = palette[pi + 2];
        dst[j + 3] = idx < (trns?.length ?? 0) ? (trns as Uint8Array)[idx] : 255;
      }
    };
  }
  const bits = depth;
  const mask = (1 << bits) - 1;
  return (src, width, dst, off, loc) => {
    for (let x = 0; x < width; x++) {
      const idx =
        (src[Math.floor(x / (8 / bits))] >>> (8 - bits - bits * (x % (8 / bits)))) & mask;
      if (idx >= entries) {
        throw new PngDecodeError(
          'palette-index',
          `palette index ${idx} out of range (palette has ${entries} entries) at row ${loc.y}${
            loc.pass ? ` of pass ${loc.pass}` : ''
          }, column ${x}`,
        );
      }
      const pi = idx * 3;
      const j = (off + x) * 4;
      dst[j] = palette[pi];
      dst[j + 1] = palette[pi + 1];
      dst[j + 2] = palette[pi + 2];
      dst[j + 3] = idx < (trns?.length ?? 0) ? (trns as Uint8Array)[idx] : 255;
    }
  };
}

function grayAlpha8Converter(): PixelConverter {
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 2;
      const j = (off + x) * 4;
      dst[j] = src[i];
      dst[j + 1] = src[i];
      dst[j + 2] = src[i];
      dst[j + 3] = src[i + 1];
    }
  };
}

function grayAlpha16Converter(): PixelConverter {
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      const v = (src[i] << 8) | src[i + 1];
      const j = (off + x) * 4;
      dst[j] = v;
      dst[j + 1] = v;
      dst[j + 2] = v;
      dst[j + 3] = (src[i + 2] << 8) | src[i + 3];
    }
  };
}

function rgba8Converter(): PixelConverter {
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 4;
      const j = (off + x) * 4;
      dst[j] = src[i];
      dst[j + 1] = src[i + 1];
      dst[j + 2] = src[i + 2];
      dst[j + 3] = src[i + 3];
    }
  };
}

function rgba16Converter(): PixelConverter {
  return (src, width, dst, off) => {
    for (let x = 0; x < width; x++) {
      const i = x * 8;
      const j = (off + x) * 4;
      dst[j] = (src[i] << 8) | src[i + 1];
      dst[j + 1] = (src[i + 2] << 8) | src[i + 3];
      dst[j + 2] = (src[i + 4] << 8) | src[i + 5];
      dst[j + 3] = (src[i + 6] << 8) | src[i + 7];
    }
  };
}

/**
 * Build the raw-scanline -> RGBA converter for a specific IHDR/tRNS/PLTE
 * configuration.
 */
export function createPixelConverter(opts: {
  bitDepth: number;
  colorType: ColorType;
  palette: Uint8Array | null;
  trns: Uint8Array | null;
}): PixelConverter {
  const { bitDepth, colorType, palette, trns } = opts;

  switch (colorType) {
    case 0: {
      const d = bitDepth as 1 | 2 | 4 | 8 | 16;
      if (trns) {
        if (trns.length < 2) {
          throw new PngDecodeError('invalid-chunk', 'tRNS chunk too short');
        }
        return d === 16
          ? gray16TrnsConverter(trns)
          : grayTrnsConverter(d, trns);
      }
      return d === 16 ? gray16Converter() : grayConverter(d);
    }

    case 2: {
      const d = bitDepth as 8 | 16;
      if (trns) {
        if (trns.length < 6) {
          throw new PngDecodeError('invalid-chunk', 'tRNS chunk too short');
        }
        return d === 16 ? rgb16TrnsConverter(trns) : rgb8TrnsConverter(trns);
      }
      return d === 16 ? rgb16Converter() : rgb8Converter();
    }

    case 3: {
      if (palette === null) {
        throw new PngDecodeError('unexpected-chunk', 'missing PLTE chunk');
      }
      return indexedConverter(bitDepth as 1 | 2 | 4 | 8, palette, trns);
    }

    case 4: {
      return (bitDepth as 8 | 16) === 16
        ? grayAlpha16Converter()
        : grayAlpha8Converter();
    }

    case 6: {
      return (bitDepth as 8 | 16) === 16
        ? rgba16Converter()
        : rgba8Converter();
    }

    default: {
      const exhaustive: never = colorType;
      throw new PngDecodeError(
        'unsupported-format',
        `unsupported color type ${String(exhaustive)}`,
      );
    }
  }
}
