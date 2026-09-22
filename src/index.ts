export type Chunk={type:string;data:Uint8Array;crc:number};export function readChunk(input:Uint8Array):Chunk|null{if(input.length<12)return null;const length=(input[0]<<24)|(input[1]<<16)|(input[2]<<8)|input[3];if(length<0||input.length<12+length)return null;const type=new TextDecoder().decode(input.slice(4,8));return{type,data:input.slice(8,8+length),crc:0}}export function paeth(a:number,b:number,c:number){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}

export interface ImageInfo {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
}

export class UnfilterError extends Error {
  /** 0-based index of the scanline being decoded when the error occurred, or -1 if not row-specific. */
  readonly row: number;

  constructor(message: string, row: number) {
    super(message);
    this.name = 'UnfilterError';
    this.row = row;
  }
}

const CHANNELS_BY_COLOR_TYPE: Readonly<Record<number, number>> = {
  0: 1, // grayscale
  2: 3, // truecolor
  3: 1, // indexed
  4: 2, // grayscale + alpha
  6: 4, // truecolor + alpha
};

const ALLOWED_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function channelsForColorType(colorType: number): number {
  const channels = CHANNELS_BY_COLOR_TYPE[colorType];
  if (channels === undefined) {
    throw new UnfilterError(`unknown color type ${colorType}`, -1);
  }
  return channels;
}

/**
 * Bytes per complete pixel, rounded up to whole bytes. Filtering always
 * operates on bytes, so sub-8-bit pixels (depths 1/2/4) use a bpp of 1.
 */
export function bytesPerPixel(bitDepth: number, colorType: number): number {
  const bitsPerPixel = channelsForColorType(colorType) * bitDepth;
  return Math.max(1, Math.ceil(bitsPerPixel / 8));
}

/** Bytes in one scanline, not including the leading filter-type byte. */
export function rowByteLength(width: number, bitDepth: number, colorType: number): number {
  return Math.ceil((width * channelsForColorType(colorType) * bitDepth) / 8);
}

/** Parse the 13-byte IHDR chunk data into an ImageInfo. */
export function parseIhdr(data: Uint8Array): ImageInfo {
  if (data.length < 13) {
    throw new UnfilterError(`IHDR too short: ${data.length} bytes`, -1);
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    width: view.getUint32(0),
    height: view.getUint32(4),
    bitDepth: data[8],
    colorType: data[9],
  };
}

function validateInfo(info: ImageInfo): void {
  const depths = ALLOWED_BIT_DEPTHS[info.colorType];
  if (depths === undefined) {
    throw new UnfilterError(`unknown color type ${info.colorType}`, -1);
  }
  if (!depths.includes(info.bitDepth)) {
    throw new UnfilterError(
      `bit depth ${info.bitDepth} not allowed for color type ${info.colorType}`,
      -1,
    );
  }
  if (!Number.isInteger(info.width) || info.width <= 0) {
    throw new UnfilterError(`invalid width ${info.width}`, -1);
  }
  if (!Number.isInteger(info.height) || info.height <= 0) {
    throw new UnfilterError(`invalid height ${info.height}`, -1);
  }
}

/**
 * Incrementally reconstructs filtered scanlines from a decompressed IDAT
 * byte stream. Bytes may be pushed in arbitrarily sized pieces (e.g. as
 * IDAT chunks arrive); a filter-type byte split across pushes is fine.
 * Only the single previous reconstructed row is retained.
 */
export class ScanlineReconstructor {
  readonly info: ImageInfo;
  readonly bpp: number;
  readonly rowBytes: number;

  private prev: Uint8Array;
  private pending: Uint8Array = new Uint8Array(0);
  private rowIndex = 0;
  private finished = false;

  constructor(info: ImageInfo) {
    validateInfo(info);
    this.info = info;
    this.bpp = bytesPerPixel(info.bitDepth, info.colorType);
    this.rowBytes = rowByteLength(info.width, info.bitDepth, info.colorType);
    this.prev = new Uint8Array(this.rowBytes);
  }

  /** Number of rows reconstructed so far. */
  get rowsEmitted(): number {
    return this.rowIndex;
  }

  /**
   * Feed more decompressed bytes. Returns every scanline completed by this
   * push (possibly none). Throws UnfilterError on an invalid filter type or
   * once more rows arrive than IHDR height declares.
   */
  push(data: Uint8Array): Uint8Array[] {
    if (this.finished) {
      throw new UnfilterError('push() after finish()', this.rowIndex);
    }
    const merged = new Uint8Array(this.pending.length + data.length);
    merged.set(this.pending, 0);
    merged.set(data, this.pending.length);

    const stride = 1 + this.rowBytes;
    const rows: Uint8Array[] = [];
    let offset = 0;
    while (merged.length - offset >= stride) {
      if (this.rowIndex >= this.info.height) {
        throw new UnfilterError(
          `excess data: stream yields more than the ${this.info.height} rows declared by IHDR`,
          this.rowIndex,
        );
      }
      const filter = merged[offset];
      const raw = merged.subarray(offset + 1, offset + stride);
      const row = this.reconstruct(filter, raw, this.rowIndex);
      rows.push(row);
      this.prev = row;
      this.rowIndex++;
      offset += stride;
    }
    this.pending = merged.slice(offset);
    return rows;
  }

  /**
   * Signal end of stream. Throws UnfilterError if fewer rows arrived than
   * IHDR height (truncated stream/row) or if unconsumed bytes remain
   * (excess data), so the emitted row count always matches IHDR exactly.
   */
  finish(): void {
    this.finished = true;
    if (this.rowIndex < this.info.height) {
      const detail =
        this.pending.length > 0
          ? `row ${this.rowIndex} truncated at ${this.pending.length} of ${1 + this.rowBytes} bytes`
          : `only ${this.rowIndex} of ${this.info.height} rows received`;
      throw new UnfilterError(`truncated stream: ${detail}`, this.rowIndex);
    }
    if (this.pending.length > 0) {
      throw new UnfilterError(
        `excess data: ${this.pending.length} unconsumed bytes after ${this.info.height} rows`,
        this.rowIndex,
      );
    }
  }

  private reconstruct(filter: number, raw: Uint8Array, row: number): Uint8Array {
    const out = new Uint8Array(this.rowBytes);
    const bpp = this.bpp;
    const prev = this.prev;
    switch (filter) {
      case 0: // None
        out.set(raw);
        break;
      case 1: // Sub
        for (let i = 0; i < out.length; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          out[i] = (raw[i] + a) & 0xff;
        }
        break;
      case 2: // Up
        for (let i = 0; i < out.length; i++) {
          out[i] = (raw[i] + prev[i]) & 0xff;
        }
        break;
      case 3: // Average
        for (let i = 0; i < out.length; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          out[i] = (raw[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
        break;
      case 4: // Paeth
        for (let i = 0; i < out.length; i++) {
          const a = i >= bpp ? out[i - bpp] : 0;
          const c = i >= bpp ? prev[i - bpp] : 0;
          out[i] = (raw[i] + paeth(a, prev[i], c)) & 0xff;
        }
        break;
      default:
        throw new UnfilterError(`invalid filter type ${filter} on row ${row}`, row);
    }
    return out;
  }
}

/** Reconstruct all scanlines from a complete decompressed stream in one call. */
export function unfilterScanlines(data: Uint8Array, info: ImageInfo): Uint8Array[] {
  const reconstructor = new ScanlineReconstructor(info);
  const rows = reconstructor.push(data);
  reconstructor.finish();
  return rows;
}
