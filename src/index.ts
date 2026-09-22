export type Chunk={type:string;data:Uint8Array;crc:number};export function readChunk(input:Uint8Array):Chunk|null{if(input.length<12)return null;const length=(input[0]<<24)|(input[1]<<16)|(input[2]<<8)|input[3];if(length<0||input.length<12+length)return null;const type=new TextDecoder().decode(input.slice(4,8));return{type,data:input.slice(8,8+length),crc:0}}export function paeth(a:number,b:number,c:number){const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c}

export interface Ihdr {
  /** image width in pixels (>= 1) */
  width: number;
  /** image height in pixels (>= 1); exactly this many rows are emitted */
  height: number;
  /** bits per sample: 1, 2, 4, 8 or 16 */
  bitDepth: number;
  /** PNG color type: 0 gray, 2 rgb, 3 indexed, 4 gray+alpha, 6 rgba */
  colorType: number;
  /** interlace method; only 0 (none) is supported */
  interlace?: number;
}

const COLOR_TYPES: Record<number, { channels: number; depths: readonly number[] } | undefined> = {
  0: { channels: 1, depths: [1, 2, 4, 8, 16] },
  2: { channels: 3, depths: [8, 16] },
  3: { channels: 1, depths: [1, 2, 4, 8] },
  4: { channels: 2, depths: [8, 16] },
  6: { channels: 4, depths: [8, 16] },
};

function colorTypeInfo(colorType: number) {
  const info = COLOR_TYPES[colorType];
  if (info === undefined) throw new Error(`png: unknown color type ${colorType}`);
  return info;
}

/** Parse the 13-byte data of an IHDR chunk. */
export function parseIhdr(data: Uint8Array): Ihdr {
  if (data.length !== 13) throw new Error(`png: IHDR must be 13 bytes, got ${data.length}`);
  if (data[10] !== 0 || data[11] !== 0) throw new Error('png: unsupported compression or filter method');
  const view = new DataView(data.buffer, data.byteOffset, 13);
  return {
    width: view.getUint32(0),
    height: view.getUint32(4),
    bitDepth: data[8],
    colorType: data[9],
    interlace: data[12],
  };
}

/** Bytes per pixel for filtering; bit depths below 8 filter whole bytes, so bpp is 1. */
export function bytesPerPixel(bitDepth: number, colorType: number): number {
  return Math.max(1, Math.ceil((colorTypeInfo(colorType).channels * bitDepth) / 8));
}

/** Bytes per scanline, excluding the leading filter-type byte. */
export function rowLength(width: number, bitDepth: number, colorType: number): number {
  return Math.ceil((width * colorTypeInfo(colorType).channels * bitDepth) / 8);
}

/**
 * Reconstruct one filtered scanline in place. `prev` is the reconstructed row
 * above (pass null on the first row; it is treated as all zeros). Bytes before
 * `bpp` have no left neighbor. All arithmetic wraps as uint8.
 */
export function unfilterRow(filterType: number, row: Uint8Array, prev: Uint8Array | null, bpp: number, rowIndex = 0): void {
  switch (filterType) {
    case 0:
      return;
    case 1:
      for (let i = bpp; i < row.length; i++) row[i] = (row[i] + row[i - bpp]) & 0xff;
      return;
    case 2:
      if (prev !== null) for (let i = 0; i < row.length; i++) row[i] = (row[i] + prev[i]) & 0xff;
      return;
    case 3:
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev !== null ? prev[i] : 0;
        row[i] = (row[i] + ((a + b) >> 1)) & 0xff;
      }
      return;
    case 4:
      for (let i = 0; i < row.length; i++) {
        const a = i >= bpp ? row[i - bpp] : 0;
        const b = prev !== null ? prev[i] : 0;
        const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
        row[i] = (row[i] + paeth(a, b, c)) & 0xff;
      }
      return;
    default:
      throw new Error(`png: invalid filter type ${filterType} on row ${rowIndex}`);
  }
}

/**
 * Incrementally turns a decompressed IDAT byte stream into reconstructed
 * scanlines. Bytes may be pushed in arbitrary chunks — a filter-type byte or
 * row split across chunks simply waits for more data. Exactly `ihdr.height`
 * rows are emitted; only the previous row is kept as filter context.
 */
export class ScanlineReconstructor {
  readonly ihdr: Ihdr;
  readonly bpp: number;
  readonly rowLength: number;
  private prev: Uint8Array;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private emitted = 0;

  constructor(ihdr: Ihdr) {
    const { width, height, bitDepth, colorType } = ihdr;
    if (!Number.isInteger(width) || width < 1) throw new Error(`png: invalid width ${width}`);
    if (!Number.isInteger(height) || height < 1) throw new Error(`png: invalid height ${height}`);
    const info = colorTypeInfo(colorType);
    if (!info.depths.includes(bitDepth)) {
      throw new Error(`png: bit depth ${bitDepth} not allowed for color type ${colorType}`);
    }
    if (ihdr.interlace !== undefined && ihdr.interlace !== 0) {
      throw new Error(`png: interlace method ${ihdr.interlace} not supported`);
    }
    this.ihdr = ihdr;
    this.bpp = bytesPerPixel(bitDepth, colorType);
    this.rowLength = rowLength(width, bitDepth, colorType);
    this.prev = new Uint8Array(this.rowLength); // zeros: the first row's "previous" row
  }

  /** Number of rows emitted so far, i.e. the 0-based index of the next row. */
  get rowsEmitted(): number {
    return this.emitted;
  }

  get done(): boolean {
    return this.emitted === this.ihdr.height;
  }

  /**
   * Push decompressed bytes; returns the rows completed by this chunk
   * (possibly none while a filter byte or row is split across chunks).
   * Throws if bytes arrive after the final row.
   */
  push(data: Uint8Array): Uint8Array[] {
    if (data.length > 0) {
      if (this.done) throw new Error(`png: ${data.length} excess byte(s) after final row ${this.ihdr.height - 1}`);
      this.chunks.push(data);
      this.buffered += data.length;
    }
    const rows: Uint8Array[] = [];
    while (!this.done && this.buffered >= 1 + this.rowLength) {
      const filterType = this.take(1)[0];
      const row = this.take(this.rowLength);
      unfilterRow(filterType, row, this.prev, this.bpp, this.emitted);
      this.prev.set(row);
      rows.push(row);
      this.emitted++;
    }
    return rows;
  }

  /**
   * Assert the stream ended exactly on the final row: throws on a truncated
   * row (naming its index) or on excess bytes beyond the IHDR height.
   */
  finish(): void {
    if (!this.done) {
      throw new Error(
        `png: truncated scanline data on row ${this.emitted} of ${this.ihdr.height} (${this.buffered} of ${1 + this.rowLength} bytes received)`,
      );
    }
    if (this.buffered > 0) throw new Error(`png: ${this.buffered} excess byte(s) after final row`);
  }

  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const head = this.chunks[0];
      const k = Math.min(n - offset, head.length);
      out.set(head.subarray(0, k), offset);
      offset += k;
      if (k === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(k);
    }
    this.buffered -= n;
    return out;
  }
}
