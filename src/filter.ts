import { PngDecodeError } from './error.js';

/**
 * Paeth predictor (PNG spec section 6.6).
 * `a` = byte to the left, `b` = byte above, `c` = upper-left.
 */
export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Reverse a PNG scanline filter in place.
 *
 * @param line filtered bytes on entry, reconstructed bytes on exit
 * @param prev reconstructed previous scanline in the same pass, or null for
 *             the first scanline of a pass
 * @param bpp  bytes per (complete) pixel in the raw format, minimum 1
 * @param filter  the filter byte taken from the start of the scanline
 */
export function unfilterScanline(
  line: Uint8Array,
  prev: Uint8Array | null,
  bpp: number,
  filter: number,
): void {
  const len = line.length;

  switch (filter) {
    case 0: // None
      return;

    case 1: {
      // Sub: Recon(x) = Filt(x) + Recon(a)
      for (let i = bpp; i < len; i++) {
        line[i] = (line[i] + line[i - bpp]) & 0xff;
      }
      return;
    }

    case 2: {
      // Up: Recon(x) = Filt(x) + Recon(b)
      if (prev === null) return;
      for (let i = 0; i < len; i++) {
        line[i] = (line[i] + prev[i]) & 0xff;
      }
      return;
    }

    case 3: {
      // Average: Recon(x) = Filt(x) + floor((Recon(a) + Recon(b)) / 2)
      if (prev === null) {
        for (let i = bpp; i < len; i++) {
          line[i] = (line[i] + (line[i - bpp] >> 1)) & 0xff;
        }
      } else {
        for (let i = 0; i < bpp; i++) {
          line[i] = (line[i] + (prev[i] >> 1)) & 0xff;
        }
        for (let i = bpp; i < len; i++) {
          line[i] = (line[i] + ((line[i - bpp] + prev[i]) >> 1)) & 0xff;
        }
      }
      return;
    }

    case 4: {
      // Paeth: Recon(x) = Filt(x) + PaethPredictor(Recon(a), Recon(b), Recon(c))
      if (prev === null) {
        for (let i = bpp; i < len; i++) {
          line[i] = (line[i] + paeth(line[i - bpp], 0, 0)) & 0xff;
        }
      } else {
        for (let i = 0; i < bpp; i++) {
          line[i] = (line[i] + paeth(0, prev[i], 0)) & 0xff;
        }
        for (let i = bpp; i < len; i++) {
          line[i] =
            (line[i] + paeth(line[i - bpp], prev[i], prev[i - bpp])) & 0xff;
        }
      }
      return;
    }

    default:
      throw new PngDecodeError(
        'invalid-chunk',
        `unsupported scanline filter type ${filter}`,
      );
  }
}
