/**
 * Public type definitions for the streaming PNG decoder.
 */

/** Legal PNG colour types: grayscale, RGB, indexed, gray+alpha, RGBA. */
export type PNGColorType = 0 | 2 | 3 | 4 | 6;

export interface PNGHeader {
  width: number;
  height: number;
  /** Original PNG bit depth: 1, 2, 4, 8 or 16. */
  bitDepth: number;
  colorType: PNGColorType;
  interlaced: boolean;
}

/**
 * One decoded scanline delivered through `onRow`.
 *
 * Pixel data is always RGBA. `data` is a Uint8Array (4 bytes per pixel)
 * unless the source bit depth is 16, in which case it is a Uint16Array
 * (4 samples per pixel, big-endian PNG samples decoded to native order).
 *
 * For non-interlaced images: `pass` is 0, `y === yPos`, `x0 === 0` and
 * `xStep === 1`.
 *
 * For Adam7 images the final image position of pixel `i` is
 * `(x0 + i * xStep, yPos)` and `pass` is the Adam7 pass index (0..6).
 */
export interface DecodedRow {
  data: Uint8Array | Uint16Array;
  /** Number of pixels in this row of the pass. */
  width: number;
  /** Adam7 pass index (0 for non-interlaced images, 0..6 otherwise). */
  pass: number;
  /** Row index within the pass (0-based). */
  y: number;
  /** Row position in the final image. */
  yPos: number;
  /** X position of the first pixel in the final image. */
  x0: number;
  /** Distance between consecutive final-image x positions. */
  xStep: number;
}

export interface PNGImage extends PNGHeader {
  /**
   * Full RGBA pixel buffer, tightly packed rows of `width * 4` samples.
   * Uint8Array for bit depth <= 8, Uint16Array for bit depth 16.
   */
  data: Uint8Array | Uint16Array;
}

export interface PNGDecoderOptions {
  /**
   * Accumulate the complete image so it can be returned from `finish()`.
   * Defaults to true when no `onRow` callback is supplied, false otherwise.
   */
  collect?: boolean;
  /** Invoked once, immediately after IHDR has been parsed and verified. */
  onHeader?: (header: PNGHeader) => void;
  /** Invoked whenever a complete scanline has been reconstructed. */
  onRow?: (row: DecodedRow) => void;
  /** Invoked exactly once if decoding fails. */
  onError?: (error: PNGDecodeError) => void;
  /**
   * How to treat a recognisable ancillary chunk whose CRC is wrong.
   * By default such a chunk is skipped (as permitted by the PNG spec);
   * set this to true to fail the whole decode instead.
   */
  failOnCorruptAncillaryCRC?: boolean;
}

/** Error codes returned in {@link PNGDecodeError.code}. */
export type PNGErrorCode =
  | 'BAD_SIGNATURE'
  | 'BAD_IHDR'
  | 'BAD_CHUNK_ORDER'
  | 'BAD_CHUNK_LENGTH'
  | 'UNKNOWN_CRITICAL_CHUNK'
  | 'CRC_MISMATCH'
  | 'UNEXPECTED_END'
  | 'DATA_AFTER_IEND'
  | 'MISSING_IDAT'
  | 'IDAT_NOT_CONTIGUOUS'
  | 'BAD_TRNS'
  | 'BAD_PALETTE'
  | 'BAD_FILTER'
  | 'PALETTE_INDEX_OUT_OF_RANGE'
  | 'INFLATE_FAILED'
  | 'RAW_DATA_LENGTH'
  | 'CALLBACK_ERROR';

export class PNGDecodeError extends Error {
  readonly code: PNGErrorCode;
  /** Final-image row number (0-based) when the failure is row specific. */
  readonly row?: number;

  constructor(code: PNGErrorCode, message: string, row?: number) {
    super(message);
    this.name = 'PNGDecodeError';
    this.code = code;
    if (row !== undefined) this.row = row;
  }
}
