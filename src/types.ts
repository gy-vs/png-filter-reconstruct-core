/** PNG color types defined by the specification. */
export type ColorType = 0 | 2 | 3 | 4 | 6;

export interface PngHeader {
  width: number;
  height: number;
  /** Sample bit depth: 1, 2, 4, 8 or 16. */
  bitDepth: number;
  colorType: ColorType;
  /** 0 = no interlace, 1 = Adam7. */
  interlaceMethod: 0 | 1;
  get interlaced(): boolean;
}

/**
 * One reconstructed output scanline.
 *
 * In non-interlaced images `pass` is 0, `yPosition === y`, `xStart === 0` and
 * `xStep === 1`.
 *
 * For Adam7 images `pass` is 1..7; pixel `i` of `data` lands at column
 * `xStart + i * xStep` of final-image row `yPosition`.
 *
 * `data` is tightly packed RGBA: width * 4 elements. It is Uint8Array for
 * 8-bit output and Uint16Array for 16-bit output. The decoder hands ownership
 * of the buffer to the callback.
 */
export interface DecodedRow {
  data: Uint8Array | Uint16Array;
  pass: number;
  /** Zero-based row index within the pass. */
  y: number;
  /** Final-image row this scanline contributes to. */
  yPosition: number;
  /** Final-image column of the first pixel. */
  xStart: number;
  /** Column increment between successive pixels. */
  xStep: number;
  /** Number of pixels in the row (the reduced-image width). */
  width: number;
}

export interface DecodedImage {
  width: number;
  height: number;
  bitDepth: number;
  colorType: ColorType;
  interlaceMethod: 0 | 1;
  /** 8 for bit depths <= 8, 16 for bit depth 16. */
  outputDepth: 8 | 16;
  /** width * height * 4 elements. Uint8Array or Uint16Array per outputDepth. */
  data: Uint8Array | Uint16Array;
}

export interface PngDecoderOptions {
  /** Called exactly once, as soon as IHDR has been validated. */
  onHeader?: (header: PngHeader) => void;
  /**
   * Called for every reconstructed scanline as soon as it is available.
   * When provided, end() resolves to undefined and the decoder does not
   * retain the decoded image.
   */
  onRow?: (row: DecodedRow) => void;
  /**
   * How to treat an ancillary chunk whose CRC does not match:
   * false (default) skip the chunk; true reject the whole decode.
   * A bad CRC on a critical chunk always rejects.
   */
  errorOnAncillaryCrc?: boolean;
}
