import zlib from 'node:zlib';
import { ChunkReader, isCritical, typeName } from './chunks.js';
import { PngDecodeError } from './error.js';
import { unfilterScanline } from './filter.js';
import { adam7Passes, type Adam7Pass } from './adam7.js';
import {
  createPixelConverter,
  type LineLocation,
  type PixelConverter,
} from './pixel.js';
import type {
  ColorType,
  DecodedImage,
  DecodedRow,
  PngDecoderOptions,
  PngHeader,
} from './types.js';

const VALID_DEPTHS: Record<ColorType, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

const CHANNELS: Record<ColorType, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

type Stage =
  | 'start'
  | 'ihdr'
  | 'after-plte'
  | 'idat'
  | 'after-idat'
  | 'iend';

interface PassState {
  /** 0 for non-interlaced, 1..7 for Adam7. */
  pass: number;
  width: number;
  height: number;
  xStart: number;
  yStart: number;
  xStep: number;
  yStep: number;
  /** Bytes per reconstructed scanline (excluding the filter byte). */
  stride: number;
  /** Rows already processed in this pass. */
  y: number;
}

function passHasRows(p: Pick<PassState, 'width' | 'height'>): boolean {
  return p.width > 0 && p.height > 0;
}

export class PngDecoder {
  private readonly onHeader?: PngDecoderOptions['onHeader'];
  private readonly onRow?: PngDecoderOptions['onRow'];
  private readonly errorOnAncillaryCrc: boolean;

  private readonly reader: ChunkReader;

  private stage: Stage = 'start';
  private header: PngHeader | null = null;
  private palette: Uint8Array | null = null;
  private trns: Uint8Array | null = null;
  private trnsSeen = false;

  private inflate: zlib.Inflate | null = null;
  private inflateClosed = false;
  private converter: PixelConverter | null = null;
  private passes: PassState[] = [];
  private passIndex = -1;
  private currentPass: PassState | null = null;

  /** Bytes per pixel in the raw format (minimum 1). */
  private bpp = 1;
  private outputDepth: 8 | 16 = 8;

  /** Incoming inflated bytes not yet aligned to a scanline boundary. */
  private rawTail: Uint8Array = new Uint8Array(0);
  private inflatedBytes = 0;
  private expectedBytes = 0;

  // Scanline assembly buffers: all bounded by image width, never by height.
  private rawLine: Uint8Array | null = null;
  private lineBufA: Uint8Array | null = null;
  private lineBufB: Uint8Array | null = null;
  /** Reusable RGBA reduced-row buffer for interlaced whole-image assembly. */
  private rowScratch: Uint8Array | Uint16Array | null = null;

  /** Whole-image output; null in row-streaming mode. */
  private imageData: Uint8Array | Uint16Array | null = null;
  private result: DecodedImage | null = null;

  private error: PngDecodeError | null = null;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: PngDecoderOptions = {}) {
    this.onHeader = options.onHeader;
    this.onRow = options.onRow;
    this.errorOnAncillaryCrc = options.errorOnAncillaryCrc ?? false;

    this.reader = new ChunkReader({
      onHeader: () => undefined,
      onComplete: (type, data) => this.handleChunk(type, data),
      onCrcError: (name) => this.handleCrcError(name),
    });
  }

  /** Push any number of bytes (one byte at a time is fine); resolves when
   * the bytes have been fully consumed and any resulting rows delivered. */
  push(data: Uint8Array): Promise<void> {
    this.chain = this.chain.then(async () => {
      if (this.error) throw this.error;
      if (this.reader.isFinished) {
        throw new PngDecodeError(
          'unexpected-chunk',
          'data pushed after IEND chunk',
        );
      }
      try {
        await this.reader.feed(data);
      } catch (e) {
        throw this.fail(this.toDecodeError(e));
      }
    });
    return this.chain;
  }

  /**
   * Signal end of input. Resolves to the decoded image in full-buffer mode,
   * or undefined when an onRow callback is configured.
   */
  end(): Promise<DecodedImage | undefined> {
    return this.chain.then(async () => {
      if (this.error) throw this.error;
      if (this.stage !== 'iend') {
        throw this.fail(
          new PngDecodeError(
            'truncated',
            `unexpected end of input (stage: ${this.stage})`,
          ),
        );
      }
      return this.result ?? undefined;
    });
  }

  // --------------------------------------------------------------- chunks

  private handleCrcError(name: string): void {
    const critical =
      (name.length === 4 && (name.charCodeAt(0) & 0x20) === 0) ||
      name === 'IHDR' ||
      name === 'PLTE' ||
      name === 'IDAT' ||
      name === 'IEND';
    if (critical || this.errorOnAncillaryCrc) {
      throw this.fail(
        new PngDecodeError('crc-error', `CRC mismatch in ${name} chunk`),
      );
    }
    this.skipCrcChunk = true;
  }

  private skipCrcChunk = false;

  private async handleChunk(
    typeBytes: Uint8Array,
    data: Uint8Array,
  ): Promise<boolean> {
    const type = typeName(typeBytes);

    if (this.skipCrcChunk) {
      this.skipCrcChunk = false;
      // CRC-bad ancillary chunk under the default policy: drop it entirely.
      return false;
    }

    const critical = isCritical(typeBytes);
    if (critical && type !== 'IHDR' && type !== 'PLTE' &&
        type !== 'IDAT' && type !== 'IEND') {
      throw this.fail(
        new PngDecodeError(
          'unexpected-chunk',
          `unsupported critical chunk: ${type}`,
        ),
      );
    }

    switch (type) {
      case 'IHDR':
        this.parseIhdr(data);
        return false;

      case 'PLTE': {
        if (this.stage !== 'ihdr') {
          throw this.fail(
            new PngDecodeError(
              'unexpected-chunk',
              `PLTE chunk out of order (stage: ${this.stage})`,
            ),
          );
        }
        if (data.length === 0 || data.length > 768 || data.length % 3 !== 0) {
          throw this.fail(
            new PngDecodeError(
              'invalid-chunk',
              `invalid PLTE length ${data.length}`,
            ),
          );
        }
        this.palette = data.slice();
        this.stage = 'after-plte';
        return false;
      }

      case 'tRNS': {
        if (this.stage !== 'ihdr' && this.stage !== 'after-plte') {
          throw this.fail(
            new PngDecodeError(
              'unexpected-chunk',
              `tRNS chunk out of order (stage: ${this.stage})`,
            ),
          );
        }
        if (this.trnsSeen) {
          throw this.fail(
            new PngDecodeError('unexpected-chunk', 'duplicate tRNS chunk'),
          );
        }
        this.parseTrns(data);
        this.trnsSeen = true;
        return false;
      }

      case 'IDAT': {
        if (this.stage === 'after-idat') {
          throw this.fail(
            new PngDecodeError(
              'unexpected-chunk',
              'IDAT chunks are not contiguous',
            ),
          );
        }
        if (this.stage !== 'idat') {
          if (this.stage !== 'ihdr' && this.stage !== 'after-plte') {
            throw this.fail(
              new PngDecodeError(
                'unexpected-chunk',
                `IDAT chunk out of order (stage: ${this.stage})`,
              ),
            );
          }
          if (this.header!.colorType === 3 && this.palette === null) {
            throw this.fail(
              new PngDecodeError(
                'unexpected-chunk',
                'indexed-color image without PLTE chunk',
              ),
            );
          }
          this.startIdat();
        }
        if (data.length > 0) await this.writeIdat(data);
        return false;
      }

      case 'IEND': {
        if (data.length !== 0) {
          throw this.fail(
            new PngDecodeError('invalid-chunk', 'IEND chunk must be empty'),
          );
        }
        if (this.stage !== 'idat' && this.stage !== 'after-idat') {
          throw this.fail(
            new PngDecodeError(
              'unexpected-chunk',
              `IEND before IDAT (stage: ${this.stage})`,
            ),
          );
        }
        if (this.stage === 'idat') await this.finishInflate();
        this.stage = 'iend';
        if (!this.onRow) {
          this.result = {
            width: this.header!.width,
            height: this.header!.height,
            bitDepth: this.header!.bitDepth,
            colorType: this.header!.colorType,
            interlaceMethod: this.header!.interlaceMethod,
            outputDepth: this.outputDepth,
            data: this.imageData!,
          };
        }
        return true;
      }

      default: {
        if (critical) {
          throw this.fail(
            new PngDecodeError(
              'unexpected-chunk',
              `unsupported critical chunk: ${type}`,
            ),
          );
        }
        if (this.stage === 'idat') {
          // First non-IDAT chunk marks the end of the IDAT stream.
          await this.finishInflate();
          this.stage = 'after-idat';
        } else if (
          this.stage !== 'ihdr' &&
          this.stage !== 'after-plte' &&
          this.stage !== 'after-idat'
        ) {
          throw this.fail(
            new PngDecodeError(
              'unexpected-chunk',
              `chunk ${type} out of order (stage: ${this.stage})`,
            ),
          );
        }
        // Ancillary chunk: ignored (its bytes are already consumed).
        return false;
      }
    }
  }

  // ---------------------------------------------------------------- IHDR

  private parseIhdr(data: Uint8Array): void {
    if (this.stage !== 'start') {
      throw this.fail(
        new PngDecodeError(
          'unexpected-chunk',
          'duplicate or misplaced IHDR chunk',
        ),
      );
    }
    if (data.length !== 13) {
      throw this.fail(
        new PngDecodeError(
          'invalid-chunk',
          `IHDR length must be 13, got ${data.length}`,
        ),
      );
    }
    const width =
      (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3];
    const height =
      (data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7];
    const bitDepth = data[8];
    const colorType = data[9] as ColorType;
    const compression = data[10];
    const filterMethod = data[11];
    const interlaceMethod = data[12];

    if (width <= 0 || height <= 0) {
      throw this.fail(
        new PngDecodeError(
          'invalid-header',
          `invalid image dimensions ${width}x${height}`,
        ),
      );
    }
    if (!(colorType in VALID_DEPTHS)) {
      throw this.fail(
        new PngDecodeError(
          'unsupported-format',
          `unsupported color type ${colorType}`,
        ),
      );
    }
    if (!VALID_DEPTHS[colorType].includes(bitDepth)) {
      throw this.fail(
        new PngDecodeError(
          'unsupported-format',
          `invalid bit depth ${bitDepth} for color type ${colorType}`,
        ),
      );
    }
    if (compression !== 0) {
      throw this.fail(
        new PngDecodeError(
          'unsupported-format',
          `unsupported compression method ${compression}`,
        ),
      );
    }
    if (filterMethod !== 0) {
      throw this.fail(
        new PngDecodeError(
          'unsupported-format',
          `unsupported filter method ${filterMethod}`,
        ),
      );
    }
    if (interlaceMethod !== 0 && interlaceMethod !== 1) {
      throw this.fail(
        new PngDecodeError(
          'unsupported-format',
          `unsupported interlace method ${interlaceMethod}`,
        ),
      );
    }

    this.header = {
      width,
      height,
      bitDepth,
      colorType,
      interlaceMethod: interlaceMethod as 0 | 1,
      get interlaced() {
        return this.interlaceMethod === 1;
      },
    };
    this.stage = 'ihdr';

    const channels = CHANNELS[colorType];
    this.bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8));
    this.outputDepth = bitDepth === 16 ? 16 : 8;

    const descs: Adam7Pass[] =
      interlaceMethod === 1
        ? adam7Passes(width, height)
        : [
            {
              pass: 0,
              xStart: 0,
              yStart: 0,
              xStep: 1,
              yStep: 1,
              width,
              height,
            },
          ];

    this.passes = descs.map((p) => ({
      pass: p.pass,
      width: p.width,
      height: p.height,
      xStart: p.xStart,
      yStart: p.yStart,
      xStep: p.xStep,
      yStep: p.yStep,
      stride: Math.floor((p.width * channels * bitDepth + 7) / 8),
      y: 0,
    }));

    this.expectedBytes = this.passes.reduce(
      (sum, p) =>
        !passHasRows(p) ? sum : sum + p.height * (p.stride + 1),
      0,
    );

    this.onHeader?.({
      ...this.header,
    } as PngHeader);
  }

  private parseTrns(data: Uint8Array): void {
    const h = this.header!;
    switch (h.colorType) {
      case 0:
        if (data.length < 2) {
          throw this.fail(
            new PngDecodeError(
              'invalid-chunk',
              'tRNS for grayscale needs at least 2 bytes',
            ),
          );
        }
        break;
      case 2:
        if (data.length < 6) {
          throw this.fail(
            new PngDecodeError(
              'invalid-chunk',
              'tRNS for truecolor needs at least 6 bytes',
            ),
          );
        }
        break;
      case 3:
        if (this.palette === null) {
          throw this.fail(
            new PngDecodeError('unexpected-chunk', 'tRNS before PLTE chunk'),
          );
        }
        if (data.length > this.palette.length / 3) {
          throw this.fail(
            new PngDecodeError(
              'invalid-chunk',
              'tRNS has more entries than the PLTE',
            ),
          );
        }
        break;
      default:
        throw this.fail(
          new PngDecodeError(
            'unexpected-chunk',
            `tRNS is not allowed with color type ${h.colorType}`,
          ),
        );
    }
    this.trns = data.slice();
  }

  // --------------------------------------------------------------- inflate

  private startIdat(): void {
    this.stage = 'idat';

    this.converter = createPixelConverter({
      bitDepth: this.header!.bitDepth,
      colorType: this.header!.colorType,
      palette: this.palette,
      trns: this.trns,
    });

    const pixels = this.header!.width * this.header!.height;
    this.imageData = this.onRow
      ? null
      : this.outputDepth === 16
        ? new Uint16Array(pixels * 4)
        : new Uint8Array(pixels * 4);

    const inf = zlib.createInflate();
    this.inflate = inf;
    inf.on('data', (chunk: Uint8Array) => {
      if (this.error) return;
      try {
        // Copy: zlib reuses Buffer backing memory.
        this.onInflated(new Uint8Array(chunk));
      } catch (e) {
        this.fail(this.toDecodeError(e));
      }
    });
    inf.on('error', (err: NodeJS.ErrnoException) => {
      this.fail(
        new PngDecodeError(
          'inflate-error',
          `zlib decompression failed: ${err.message}`,
        ),
      );
    });

    const first = this.passes.findIndex(passHasRows);
    this.passIndex = first;
    this.beginPass(this.passes[first]);
  }

  private async writeIdat(data: Uint8Array): Promise<void> {
    if (this.error) throw this.error;
    const inf = this.inflate!;
    await new Promise<void>((resolve, reject) => {
      inf.write(data, () => {
        if (this.error) reject(this.error);
        else resolve();
      });
    });
    // Emit every byte decompressable from this IDAT before moving on, so
    // rows are delivered as soon as the chunk's bytes arrive.
    await new Promise<void>((resolve, reject) => {
      inf.flush(zlib.Z_SYNC_FLUSH, () => {
        if (this.error) reject(this.error);
        else resolve();
      });
    });
    if (this.error) throw this.error;
  }

  private async finishInflate(): Promise<void> {
    if (this.inflate === null || this.inflateClosed) {
      throw this.fail(
        new PngDecodeError('truncated', 'no IDAT chunks were present'),
      );
    }
    this.inflateClosed = true;
    await new Promise<void>((resolve) => {
      this.inflate!.end(() => resolve());
    });
    if (this.error) throw this.error;

    if (this.rawTail.length > 0 || this.currentPass !== null) {
      throw this.fail(
        new PngDecodeError(
          'data-length',
          'decompressed data ends in the middle of a scanline or pass',
        ),
      );
    }
    if (this.inflatedBytes !== this.expectedBytes) {
      throw this.fail(
        new PngDecodeError(
          'data-length',
          `decompressed length ${this.inflatedBytes} does not match expected ${this.expectedBytes}`,
        ),
      );
    }
  }

  // -------------------------------------------------- scanline assembly

  private beginPass(pass: PassState): void {
    this.currentPass = pass;
    this.rawLine = new Uint8Array(pass.stride + 1);
    this.lineBufA = new Uint8Array(pass.stride);
    this.lineBufB = new Uint8Array(pass.stride);
    this.rawTail = new Uint8Array(0);
    if (
      !this.onRow &&
      pass.pass !== 0 &&
      (!this.rowScratch ||
        this.rowScratch.length < pass.width * 4)
    ) {
      this.rowScratch =
        this.outputDepth === 16
          ? new Uint16Array(pass.width * 4)
          : new Uint8Array(pass.width * 4);
    }
  }

  private onInflated(input: Uint8Array): void {
    this.inflatedBytes += input.length;
    if (this.inflatedBytes > this.expectedBytes) {
      throw this.fail(
        new PngDecodeError(
          'data-length',
          `decompressed data exceeds expected length ${this.expectedBytes}`,
        ),
      );
    }

    // Prefix bytes left over from the previous callback.
    let buf: Uint8Array;
    if (this.rawTail.length === 0) {
      buf = input;
    } else {
      buf = new Uint8Array(this.rawTail.length + input.length);
      buf.set(this.rawTail, 0);
      buf.set(input, this.rawTail.length);
      this.rawTail = new Uint8Array(0);
    }

    let offset = 0;

    while (this.currentPass !== null) {
      const pass = this.currentPass;
      const need = pass.stride + 1;
      if (buf.length - offset < need) break;

      this.rawLine!.set(buf.subarray(offset, offset + need));
      offset += need;
      this.processRawLine(pass);

      pass.y++;
      if (pass.y === pass.height) {
        const nextIdx = this.nextPassIndex(this.passIndex);
        if (nextIdx >= 0) {
          this.passIndex = nextIdx;
          this.beginPass(this.passes[nextIdx]);
        } else {
          this.passIndex = -1;
          this.currentPass = null;
          this.rawLine = null;
        }
      }
    }

    if (buf.length - offset > 0) {
      this.rawTail = buf.slice(offset);
    }
  }

  private nextPassIndex(from: number): number {
    for (let i = from + 1; i < this.passes.length; i++) {
      if (passHasRows(this.passes[i])) return i;
    }
    return -1;
  }

  private processRawLine(pass: PassState): void {
    const raw = this.rawLine!;
    const filter = raw[0];

    // Ping-pong the two reconstruction buffers (no per-row allocation):
    // even rows reconstruct into A, odd into B; "previous" is the other.
    const cur = (pass.y & 1) === 0 ? this.lineBufA! : this.lineBufB!;
    cur.set(raw.subarray(1));
    const prev =
      pass.y === 0
        ? null
        : (pass.y & 1) === 0
          ? this.lineBufB
          : this.lineBufA;
    unfilterScanline(cur, prev, this.bpp, filter);

    const y = pass.y;
    const loc: LineLocation = { pass: pass.pass, y };
    const finalY = pass.pass === 0 ? y : pass.yStart + y * pass.yStep;

    if (this.onRow) {
      const rowData =
        this.outputDepth === 16
          ? new Uint16Array(pass.width * 4)
          : new Uint8Array(pass.width * 4);
      this.converter!(cur, pass.width, rowData, 0, loc);

      const row: DecodedRow = {
        data: rowData,
        pass: pass.pass,
        y,
        yPosition: finalY,
        xStart: pass.xStart,
        xStep: pass.xStep,
        width: pass.width,
      };
      this.onRow(row);
      return;
    }

    const dst = this.imageData!;
    if (pass.pass === 0) {
      this.converter!(cur, pass.width, dst, y * this.header!.width, loc);
      return;
    }

    // Interlaced: convert the reduced row once, then scatter RGBA samples
    // onto their final-image columns.
    const scratch = this.rowScratch!;
    this.converter!(cur, pass.width, scratch, 0, loc);
    const imageWidth = this.header!.width;
    for (let x = 0; x < pass.width; x++) {
      const finalX = pass.xStart + x * pass.xStep;
      const dstBase = (finalY * imageWidth + finalX) * 4;
      const srcBase = x * 4;
      dst[dstBase] = scratch[srcBase];
      dst[dstBase + 1] = scratch[srcBase + 1];
      dst[dstBase + 2] = scratch[srcBase + 2];
      dst[dstBase + 3] = scratch[srcBase + 3];
    }
  }

  // ------------------------------------------------------------------ util

  private toDecodeError(e: unknown): PngDecodeError {
    if (e instanceof PngDecodeError) return e;
    return new PngDecodeError(
      'inflate-error',
      e instanceof Error ? e.message : String(e),
    );
  }

  private fail(err: PngDecodeError): PngDecodeError {
    if (!this.error) {
      this.error = err;
      try {
        this.inflate?.destroy();
      } catch {
        // best effort
      }
    }
    return this.error;
  }
}
