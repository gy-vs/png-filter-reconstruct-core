import { Inflate, createInflate } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { Crc32 } from './crc.js';
import { ChunkQueue } from './queue.js';
import {
  ADAM7_PASSES,
  adam7PassHeight,
  adam7PassWidth,
  type Adam7Pass,
} from './adam7.js';
import type {
  DecodedRow,
  PNGColorType,
  PNGDecoderOptions,
  PNGHeader,
  PNGImage,
} from './types.js';
import { PNGDecodeError } from './types.js';

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

/** Number of stored channels per PNG colour type. */
const CHANNELS: Record<number, number> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};

const LEGAL_DEPTHS: Record<number, readonly number[]> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

export function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

interface PassRuntime {
  pass: Adam7Pass;
  width: number;
  height: number;
  /** Bytes per scanline (without the filter byte). */
  rowBytes: number;
  index: number;
}

type ChunkParserState =
  | { phase: 'signature' }
  | { phase: 'chunk-head' }
  | {
      phase: 'chunk-body';
      length: number;
      type: string;
      typeBytes: Uint8Array;
      crc: Crc32;
      remaining: number;
      /** Collected body for non-IDAT chunks. */
      body: Uint8Array | null;
      bodyFilled: number;
    };

/**
 * Streaming PNG decoder.
 *
 * Feed arbitrary byte pieces with {@link push} (one byte at a time or the
 * whole file, both work), then `await` {@link finish}. Pixels are either
 * delivered per reconstructed scanline through `onRow` and/or gathered into
 * a full RGBA buffer returned by `finish()`.
 *
 * In line-streaming mode the decoder keeps O(width) state: its retained
 * buffers never grow with image height.
 */
export class StreamingPNGDecoder {
  private readonly input = new ChunkQueue();
  private readonly opts: PNGDecoderOptions;

  private parser: ChunkParserState = { phase: 'signature' };
  private fatal: PNGDecodeError | null = null;
  private finished = false;
  private donePromise: Promise<PNGImage | null> | null = null;

  // Image description (filled from IHDR).
  private header: PNGHeader | null = null;
  private width = 0;
  private height = 0;
  private bitDepth = 0;
  private colorType: PNGColorType = 0;
  private channels = 0;
  private bpp = 0; // filter byte distance: ceil(channels*bitDepth/8), min 1

  private palette: Uint8Array | null = null; // PLTE bytes (r,g,b triples)
  private trnsGray = -1; // 16-bit grayscale transparency value
  private trnsRgb: [number, number, number] | null = null; // 16-bit
  private trnsAlpha: Uint8Array | null = null; // indexed alpha table

  // Chunk ordering.
  private ihdrSeen = false;
  private idatStarted = false;
  private idatSequenceClosed = false;
  private iendSeen = false;

  private inflate: Inflate | null = null;

  // Pass / scanline state.
  private passes: PassRuntime[] = [];
  private passIndex = 0;
  private expectedRawSize = 0;
  private rawConsumed = 0;
  private rowBuf: Uint8Array = new Uint8Array(0);
  private prevRow: Uint8Array = new Uint8Array(0);
  private rowPos = 0;
  private rowFilter = -1;
  private waitingFilter = true;
  private rowsInPass = 0;
  private passExhausted = false;

  private image: Uint8Array | Uint16Array | null = null;

  constructor(opts: PNGDecoderOptions = {}) {
    const collect =
      opts.collect ?? (opts.onRow === undefined ? true : false);
    this.opts = { ...opts, collect };
  }

  /**
   * Feed more file bytes. The view may be retained briefly by the
   * decompressor (zero copy); do not mutate a pushed buffer until
   * `finish()` has resolved.
   *
   * Throws (and permanently stops the decoder) as soon as a structural
   * problem is detected. Errors surfaced asynchronously by zlib or a row
   * callback are reported via `onError` and the `finish()` rejection.
   */
  push(chunk: Uint8Array): void {
    if (this.fatal) throw this.fatal;
    if (this.finished) {
      throw new PNGDecodeError(
        'UNEXPECTED_END',
        'push() called after finish()',
      );
    }
    this.input.push(chunk);
    this.pumpChunks();
  }

  /**
   * Signal end of input. Resolves with the full image when collecting,
   * otherwise null. Rejects with a {@link PNGDecodeError} on any failure.
   */
  finish(): Promise<PNGImage | null> {
    if (this.donePromise) return this.donePromise;

    if (this.fatal) {
      this.donePromise = Promise.reject(this.fatal);
      return this.donePromise;
    }
    this.finished = true;
    this.pumpChunks();

    if (this.fatal) {
      this.donePromise = Promise.reject(this.fatal);
      return this.donePromise;
    }

    // Structural completeness: IEND consumed exactly at a chunk boundary.
    if (
      !this.iendSeen ||
      this.input.available() > 0 ||
      this.parser.phase !== 'chunk-head'
    ) {
      this.fail(
        new PNGDecodeError(
          'UNEXPECTED_END',
          'input ended before a complete PNG was received',
        ),
      );
      this.donePromise = Promise.reject(this.fatal!);
      return this.donePromise;
    }

    const inflate = this.inflate;
    if (!inflate) {
      this.fail(
        new PNGDecodeError('MISSING_IDAT', 'stream contains no IDAT chunk'),
      );
      this.donePromise = Promise.reject(this.fatal!);
      return this.donePromise;
    }

    this.donePromise = new Promise((resolve, reject) => {
      this.doneResolve = resolve;
      this.doneReject = reject;
    });
    inflate.end();
    return this.donePromise;
  }

  private doneResolve: ((image: PNGImage | null) => void) | null = null;
  private doneReject: ((error: PNGDecodeError) => void) | null = null;

  // ---------------------------------------------------------------- chunk I/O

  private pumpChunks(): void {
    try {
      if (this.parser.phase === 'signature') {
        if (this.input.available() < 8) return;
        const sig = this.input.readBytes(8);
        for (let i = 0; i < 8; i++) {
          if (sig[i] !== PNG_SIGNATURE[i]) {
            throw new PNGDecodeError(
              'BAD_SIGNATURE',
              'not a PNG file (signature mismatch)',
            );
          }
        }
        this.parser = { phase: 'chunk-head' };
      }

      // eslint-disable-next-line no-constant-condition
      outer: while (true) {
        if (this.parser.phase === 'chunk-head') {
          if (this.iendSeen) {
            if (this.input.available() > 0) {
              throw new PNGDecodeError(
                'DATA_AFTER_IEND',
                'encountered data after IEND',
              );
            }
            return;
          }
          if (this.input.available() < 8) return;
          const head = this.input.readBytes(8);
          const length = readUint32(head, 0);
          const typeBytes = head.subarray(4, 8);
          const type = String.fromCharCode(...typeBytes);
          const crc = new Crc32();
          crc.update(typeBytes);
          this.parser = {
            phase: 'chunk-body',
            length,
            type,
            typeBytes: typeBytes.slice(),
            crc,
            remaining: length,
            body: null,
            bodyFilled: 0,
          };
        }

        const st = this.parser;
        if (st.phase !== 'chunk-body') return;

        if (st.type === 'IDAT') {
          // Stream IDAT payload straight into zlib; never hold a whole
          // (potentially multi-megabyte) chunk body.
          while (st.remaining > 0) {
            if (this.input.available() === 0) return;
            const take = Math.min(st.remaining, this.input.available());
            const part = this.input.readContiguous(take);
            st.crc.update(part);
            st.remaining -= take;
            this.writeInflate(part);
          }
        } else {
          // Non-IDAT bodies are bounded and small; gather them whole.
          if (st.body === null) {
            if (st.length > 0x7fffffff) {
              throw new PNGDecodeError(
                'BAD_CHUNK_LENGTH',
                `chunk ${st.type} is implausibly large`,
              );
            }
            st.body = new Uint8Array(st.length);
          }
          if (this.input.available() < st.remaining + 4) return;
          const part = this.input.readBytes(st.remaining);
          st.body.set(part, st.bodyFilled);
          st.bodyFilled += st.remaining;
          st.crc.update(part);
          st.remaining = 0;
        }

        if (this.input.available() < 4) return;
        const storedCrc = readUint32(this.input.readBytes(4), 0);
        const actualCrc = st.crc.value();
        const critical = (st.typeBytes[0] & 0x20) === 0;
        this.parser = { phase: 'chunk-head' };

        if (storedCrc !== actualCrc) {
          if (critical || this.opts.failOnCorruptAncillaryCRC) {
            throw new PNGDecodeError(
              'CRC_MISMATCH',
              `CRC mismatch in ${st.type} chunk`,
            );
          }
          // Corrupt ancillary chunk: skip it entirely.
          this.noteChunkBoundary(st.type);
          continue outer;
        }

        this.dispatchChunk(st.type, st.body ?? new Uint8Array(0));
      }
    } catch (error) {
      this.fail(toPNGError(error));
      throw this.fatal!;
    }
  }

  /** Track IDAT sequence closure for chunks dropped due to bad CRC. */
  private noteChunkBoundary(type: string): void {
    if (type === 'IDAT') return;
    if (this.idatStarted) this.idatSequenceClosed = true;
  }

  private dispatchChunk(type: string, data: Uint8Array): void {
    switch (type) {
      case 'IHDR':
        this.handleIHDR(data);
        return;
      case 'PLTE':
        this.handlePLTE(data);
        return;
      case 'IDAT':
        this.handleIDAT();
        return;
      case 'IEND':
        this.handleIEND(data);
        return;
      case 'tRNS':
        this.handleTRNS(data);
        return;
      default: {
        const critical = (type.charCodeAt(0) & 0x20) === 0;
        if (critical) {
          throw new PNGDecodeError(
            'UNKNOWN_CRITICAL_CHUNK',
            `unsupported critical chunk ${type}`,
          );
        }
        // Recognised and unknown ancillary chunks are ignored.
        this.noteChunkBoundary(type);
      }
    }
  }

  // ----------------------------------------------------------------- chunks

  private handleIHDR(data: Uint8Array): void {
    if (this.ihdrSeen) {
      throw new PNGDecodeError('BAD_CHUNK_ORDER', 'duplicate IHDR chunk');
    }
    if (data.length !== 13) {
      throw new PNGDecodeError('BAD_IHDR', 'IHDR must be exactly 13 bytes');
    }
    const width = readUint32(data, 0);
    const height = readUint32(data, 4);
    const bitDepth = data[8]!;
    const colorType = data[9]!;
    const compression = data[10]!;
    const filterMethod = data[11]!;
    const interlace = data[12]!;

    if (width === 0 || width > 0x7fffffff || height === 0 || height > 0x7fffffff) {
      throw new PNGDecodeError('BAD_IHDR', `illegal dimensions ${width}x${height}`);
    }
    if (!LEGAL_DEPTHS[colorType]) {
      throw new PNGDecodeError('BAD_IHDR', `unsupported colour type ${colorType}`);
    }
    if (!LEGAL_DEPTHS[colorType].includes(bitDepth)) {
      throw new PNGDecodeError(
        'BAD_IHDR',
        `illegal bit depth ${bitDepth} for colour type ${colorType}`,
      );
    }
    if (compression !== 0) {
      throw new PNGDecodeError('BAD_IHDR', `unsupported compression method ${compression}`);
    }
    if (filterMethod !== 0) {
      throw new PNGDecodeError('BAD_IHDR', `unsupported filter method ${filterMethod}`);
    }
    if (interlace > 1) {
      throw new PNGDecodeError('BAD_IHDR', `unsupported interlace method ${interlace}`);
    }

    this.ihdrSeen = true;
    this.width = width;
    this.height = height;
    this.bitDepth = bitDepth;
    this.colorType = colorType as PNGColorType;
    this.channels = CHANNELS[colorType];
    // Bytes used by the filter "left" distance, never less than one.
    this.bpp = Math.max(1, Math.floor((this.channels * bitDepth) / 8));
    this.header = {
      width,
      height,
      bitDepth,
      colorType: colorType as PNGColorType,
      interlaced: interlace === 1,
    };

    const full: Adam7Pass = { xStart: 0, yStart: 0, xStep: 1, yStep: 1 };
    const passDefs = interlace === 1 ? ADAM7_PASSES : [full];
    for (let i = 0; i < passDefs.length; i++) {
      const pass = passDefs[i]!;
      const pw = adam7PassWidth(pass, width);
      const ph = adam7PassHeight(pass, height);
      if (ph === 0 || pw === 0) continue;
      const rowBytes = Math.ceil((pw * this.channels * bitDepth) / 8);
      this.passes.push({
        pass,
        width: pw,
        height: ph,
        rowBytes,
        index: i,
      });
      this.expectedRawSize += ph * (1 + rowBytes);
    }

    if (this.opts.collect) {
      const samples = width * height * 4;
      this.image =
        bitDepth === 16 ? new Uint16Array(samples) : new Uint8Array(samples);
    }

    this.preparePass(0);

    try {
      this.opts.onHeader?.(this.header);
    } catch (cause) {
      throw new PNGDecodeError(
        'CALLBACK_ERROR',
        `onHeader callback failed: ${(cause as Error).message}`,
      );
    }
  }

  private handlePLTE(data: Uint8Array): void {
    if (!this.ihdrSeen) throw new PNGDecodeError('BAD_CHUNK_ORDER', 'PLTE before IHDR');
    if (this.idatStarted) throw new PNGDecodeError('BAD_CHUNK_ORDER', 'PLTE after IDAT');
    if (this.palette !== null) {
      throw new PNGDecodeError('BAD_CHUNK_ORDER', 'duplicate PLTE chunk');
    }
    if (this.colorType === 0 || this.colorType === 4) {
      throw new PNGDecodeError('BAD_PALETTE', 'PLTE forbidden for grayscale images');
    }
    if (data.length === 0 || data.length % 3 !== 0 || data.length > 768) {
      throw new PNGDecodeError('BAD_PALETTE', `illegal PLTE length ${data.length}`);
    }
    this.palette = data.slice();
  }

  private handleTRNS(data: Uint8Array): void {
    if (!this.ihdrSeen) throw new PNGDecodeError('BAD_CHUNK_ORDER', 'tRNS before IHDR');
    if (this.idatStarted) throw new PNGDecodeError('BAD_CHUNK_ORDER', 'tRNS after IDAT');
    if (this.trnsAlpha !== null || this.trnsRgb || this.trnsGray !== -1) {
      throw new PNGDecodeError('BAD_CHUNK_ORDER', 'duplicate tRNS chunk');
    }
    if (this.colorType === 4 || this.colorType === 6) {
      throw new PNGDecodeError('BAD_TRNS', 'tRNS forbidden for images that have alpha');
    }
    if (this.colorType === 0) {
      if (data.length !== 2) {
        throw new PNGDecodeError('BAD_TRNS', 'grayscale tRNS must be 2 bytes');
      }
      this.trnsGray = readUint16(data, 0);
    } else if (this.colorType === 2) {
      if (data.length !== 6) {
        throw new PNGDecodeError('BAD_TRNS', 'RGB tRNS must be 6 bytes');
      }
      this.trnsRgb = [readUint16(data, 0), readUint16(data, 2), readUint16(data, 4)];
    } else {
      if (!this.palette) {
        throw new PNGDecodeError('BAD_CHUNK_ORDER', 'tRNS before PLTE');
      }
      if (data.length > this.palette.length / 3) {
        throw new PNGDecodeError(
          'BAD_TRNS',
          'tRNS has more entries than the palette',
        );
      }
      this.trnsAlpha = data.slice();
    }
  }

  private handleIDAT(): void {
    if (!this.ihdrSeen) {
      throw new PNGDecodeError('BAD_CHUNK_ORDER', 'IDAT before IHDR');
    }
    if (this.idatSequenceClosed) {
      throw new PNGDecodeError(
        'IDAT_NOT_CONTIGUOUS',
        'IDAT chunks must be consecutive',
      );
    }
    if (this.colorType === 3 && !this.palette) {
      throw new PNGDecodeError('BAD_PALETTE', 'indexed image is missing PLTE');
    }
    this.idatStarted = true;
    this.ensureInflate();
  }

  private handleIEND(data: Uint8Array): void {
    if (data.length !== 0) {
      throw new PNGDecodeError('BAD_CHUNK_LENGTH', 'IEND must be empty');
    }
    if (!this.idatStarted) {
      throw new PNGDecodeError('MISSING_IDAT', 'IEND reached before any IDAT');
    }
    this.iendSeen = true;
    if (this.idatStarted) this.idatSequenceClosed = true;
  }

  // ------------------------------------------------------------------ zlib

  private ensureInflate(): void {
    if (this.inflate) return;
    const inflate = createInflate();
    this.inflate = inflate;
    inflate.on('data', (chunk: Buffer) => {
      if (this.fatal) return;
      try {
        this.feedRaw(chunk);
      } catch (error) {
        this.fail(toPNGError(error));
      }
    });
    inflate.on('error', (error: Error) => {
      if (this.fatal) return;
      this.fail(
        new PNGDecodeError(
          'INFLATE_FAILED',
          `zlib decompression failed: ${error.message}`,
        ),
      );
    });
    inflate.on('end', () => {
      if (this.fatal) return;
      try {
        if (!this.passExhausted || this.rawConsumed !== this.expectedRawSize) {
          throw new PNGDecodeError(
            'RAW_DATA_LENGTH',
            `decompressed data length does not match IHDR ` +
              `(expected ${this.expectedRawSize} bytes, got ${this.rawConsumed})`,
          );
        }
        this.settle();
      } catch (error) {
        this.fail(toPNGError(error));
      }
    });
  }

  private writeInflate(part: Uint8Array): void {
    if (!this.idatStarted) {
      // handleIDAT() validates ordering before any compressed bytes flow.
      this.handleIDAT();
    }
    if (this.fatal || !this.inflate) return;
    // Zero-copy Buffer view over the queued bytes.
    const view = Buffer.from(part.buffer, part.byteOffset, part.byteLength);
    this.inflate.write(view);
  }

  // ---------------------------------------------------- scanline rebuilding

  private preparePass(index: number): void {
    this.passIndex = index;
    this.passExhausted = index >= this.passes.length;
    if (this.passExhausted) {
      this.rowBuf = new Uint8Array(0);
      this.prevRow = new Uint8Array(0);
      return;
    }
    const rt = this.passes[index]!;
    this.rowBuf = new Uint8Array(rt.rowBytes);
    // A missing previous scanline acts as all zeros.
    this.prevRow = new Uint8Array(rt.rowBytes);
    this.rowPos = 0;
    this.waitingFilter = true;
    this.rowsInPass = 0;
  }

  private feedRaw(data: Uint8Array): void {
    let i = 0;
    const n = data.length;
    while (i < n) {
      if (this.passExhausted) {
        throw new PNGDecodeError(
          'RAW_DATA_LENGTH',
          'decompressed more bytes than IHDR predicts',
        );
      }
      const rt = this.passes[this.passIndex]!;

      if (this.waitingFilter) {
        const filter = data[i++];
        this.rawConsumed++;
        if (filter > 4) {
          const yPos =
            rt.pass.yStart + this.rowsInPass * rt.pass.yStep;
          throw new PNGDecodeError(
            'BAD_FILTER',
            `unknown scanline filter type ${filter}`,
            yPos,
          );
        }
        this.rowFilter = filter;
        this.waitingFilter = false;
        this.rowPos = 0;
        continue;
      }

      const need = rt.rowBytes - this.rowPos;
      const take = Math.min(need, n - i);
      this.rowBuf.set(data.subarray(i, i + take), this.rowPos);
      this.rawConsumed += take;
      i += take;
      this.rowPos += take;

      if (this.rowPos === rt.rowBytes) {
        this.unfilterRow();
        this.emitRow(rt);

        // Swap: current becomes previous, old previous buffer is reused.
        const old = this.prevRow;
        this.prevRow = this.rowBuf;
        this.rowBuf = old;
        this.rowPos = 0;
        this.waitingFilter = true;
        this.rowsInPass++;

        if (this.rowsInPass === rt.height) {
          this.preparePass(this.passIndex + 1);
        }
      }
    }
  }

  private unfilterRow(): void {
    const cur = this.rowBuf;
    const prev = this.prevRow;
    const rb = cur.length;
    const bpp = this.bpp;
    switch (this.rowFilter) {
      case 0:
        return;
      case 1: // Sub
        for (let x = bpp; x < rb; x++) {
          cur[x] = (cur[x] + cur[x - bpp]) & 0xff;
        }
        return;
      case 2: // Up
        for (let x = 0; x < rb; x++) {
          cur[x] = (cur[x] + prev[x]) & 0xff;
        }
        return;
      case 3: // Average
        for (let x = 0; x < rb; x++) {
          const left = x >= bpp ? cur[x - bpp] : 0;
          cur[x] = (cur[x] + ((left + prev[x]) >> 1)) & 0xff;
        }
        return;
      default: {
        // Paeth
        for (let x = 0; x < rb; x++) {
          const left = x >= bpp ? cur[x - bpp] : 0;
          const up = prev[x];
          const upLeft = x >= bpp ? prev[x - bpp] : 0;
          cur[x] = (cur[x] + paeth(left, up, upLeft)) & 0xff;
        }
      }
    }
  }

  private emitRow(rt: PassRuntime): void {
    const { width: pw } = rt;
    const yPos = rt.pass.yStart + this.rowsInPass * rt.pass.yStep;
    const out16 = this.bitDepth === 16;

    // Indexed rows are validated in full before anything is emitted or
    // written into the collected image.
    if (this.colorType === 3) {
      this.validateIndexedRow(rt, yPos);
    }

    const samples = pw * 4;
    const rowOut: Uint8Array | Uint16Array = out16
      ? new Uint16Array(samples)
      : new Uint8Array(samples);
    // Conversion always produces one tightly packed pass row, independent
    // of whether the full image is being collected.
    this.convertRow(rt, this.rowBuf, rowOut);

    if (this.opts.collect) {
      const base = (yPos * this.width + rt.pass.xStart) * 4;
      const step = rt.pass.xStep * 4;
      scatter(rowOut, this.image!, base, step, pw);
    }

    if (this.opts.onRow) {
      const message: DecodedRow = {
        data: rowOut,
        width: pw,
        pass: rt.index,
        y: this.rowsInPass,
        yPos,
        x0: rt.pass.xStart,
        xStep: rt.pass.xStep,
      };
      try {
        this.opts.onRow(message);
      } catch (cause) {
        throw new PNGDecodeError(
          'CALLBACK_ERROR',
          `onRow callback failed: ${(cause as Error).message}`,
          yPos,
        );
      }
    }
  }

  private validateIndexedRow(rt: PassRuntime, yPos: number): void {
    const paletteEntries = this.palette!.length / 3;
    const bits = this.bitDepth;
    if (bits === 8) {
      for (let x = 0; x < rt.width; x++) {
        if (this.rowBuf[x] >= paletteEntries) {
          throw new PNGDecodeError(
            'PALETTE_INDEX_OUT_OF_RANGE',
            `palette index ${this.rowBuf[x]} out of range at row ${yPos}`,
            yPos,
          );
        }
      }
      return;
    }
    const mask = (1 << bits) - 1;
    const slotsPerByte = 8 / bits;
    for (let x = 0; x < rt.width; x++) {
      const index = (this.rowBuf[(x * bits) >>> 3]! >>>
        (8 - ((x % slotsPerByte) + 1) * bits)) & mask;
      if (index >= paletteEntries) {
        throw new PNGDecodeError(
          'PALETTE_INDEX_OUT_OF_RANGE',
          `palette index ${index} out of range at row ${yPos}`,
          yPos,
        );
      }
    }
  }

  /**
   * Convert one reconstructed stored scanline into a tightly packed
   * RGBA row (`w * 4` samples, offset 0). Adam7 scattering into the full
   * image is the caller's job ({@link scatter}).
   */
  private convertRow(rt: PassRuntime, src: Uint8Array, dst: Uint8Array | Uint16Array): void {
    const w = rt.width;
    const depth = this.bitDepth;
    const type = this.colorType;

    if (type === 6 && depth === 8) {
      // Stored bytes are already tightly packed RGBA8.
      dst.set(src, 0);
      return;
    }

    let o = 0;
    if (type === 6) {
      // RGBA 16-bit
      for (let x = 0; x < w; x++, o += 4) {
        const s = x * 8;
        dst[o] = readUint16(src, s);
        dst[o + 1] = readUint16(src, s + 2);
        dst[o + 2] = readUint16(src, s + 4);
        dst[o + 3] = readUint16(src, s + 6);
      }
    } else if (type === 2) {
      const transparent = this.trnsRgb;
      if (depth === 16) {
        for (let x = 0; x < w; x++, o += 4) {
          const s = x * 6;
          const r = readUint16(src, s);
          const g = readUint16(src, s + 2);
          const b = readUint16(src, s + 4);
          dst[o] = r;
          dst[o + 1] = g;
          dst[o + 2] = b;
          dst[o + 3] =
            transparent && r === transparent[0] && g === transparent[1] && b === transparent[2]
              ? 0
              : 65535;
        }
      } else {
        for (let x = 0; x < w; x++, o += 4) {
          const s = x * 3;
          const r = src[s]!;
          const g = src[s + 1]!;
          const b = src[s + 2]!;
          dst[o] = r;
          dst[o + 1] = g;
          dst[o + 2] = b;
          dst[o + 3] =
            transparent &&
            (r << 8) === transparent[0] &&
            (g << 8) === transparent[1] &&
            (b << 8) === transparent[2]
              ? 0
              : 255;
        }
      }
    } else if (type === 4) {
      if (depth === 16) {
        for (let x = 0; x < w; x++, o += 4) {
          const s = x * 4;
          const gray = readUint16(src, s);
          const a = readUint16(src, s + 2);
          dst[o] = gray;
          dst[o + 1] = gray;
          dst[o + 2] = gray;
          dst[o + 3] = a;
        }
      } else {
        for (let x = 0; x < w; x++, o += 4) {
          const s = x * 2;
          const gray = src[s]!;
          dst[o] = gray;
          dst[o + 1] = gray;
          dst[o + 2] = gray;
          dst[o + 3] = src[s + 1]!;
        }
      }
    } else if (type === 0) {
      this.convertGrayRow(src, dst, w, depth);
    } else {
      // Indexed
      const pal = this.palette!;
      const alphaTable = this.trnsAlpha;
      if (depth === 8) {
        for (let x = 0; x < w; x++, o += 4) {
          const idx = src[x]!;
          const p = idx * 3;
          dst[o] = pal[p]!;
          dst[o + 1] = pal[p + 1]!;
          dst[o + 2] = pal[p + 2]!;
          dst[o + 3] = alphaTable && idx < alphaTable.length ? alphaTable[idx]! : 255;
        }
      } else {
        const slotsPerByte = 8 / depth;
        const mask = (1 << depth) - 1;
        for (let x = 0; x < w; x++, o += 4) {
          const byte = src[(x * depth) >>> 3]!;
          const inByte = x % slotsPerByte;
          const idx = (byte >> (8 - (inByte + 1) * depth)) & mask;
          const p = idx * 3;
          dst[o] = pal[p]!;
          dst[o + 1] = pal[p + 1]!;
          dst[o + 2] = pal[p + 2]!;
          dst[o + 3] = alphaTable && idx < alphaTable.length ? alphaTable[idx]! : 255;
        }
      }
    }
  }

  private convertGrayRow(
    src: Uint8Array,
    dst: Uint8Array | Uint16Array,
    w: number,
    depth: number,
  ): void {
    const trns = this.trnsGray;
    let o = 0;
    if (depth === 16) {
      for (let x = 0; x < w; x++, o += 4) {
        const gray = readUint16(src, x * 2);
        dst[o] = gray;
        dst[o + 1] = gray;
        dst[o + 2] = gray;
        dst[o + 3] = trns !== -1 && gray === trns ? 0 : 65535;
      }
      return;
    }
    if (depth === 8) {
      for (let x = 0; x < w; x++, o += 4) {
        const gray = src[x]!;
        dst[o] = gray;
        dst[o + 1] = gray;
        dst[o + 2] = gray;
        dst[o + 3] = trns !== -1 && gray << 8 === trns ? 0 : 255;
      }
      return;
    }

    // Sub-byte grayscale: expand packed samples, scaling to full 8 bits.
    const { lut, max, slotsPerByte } = GRAY_PACKED[depth]!;
    // tRNS holds a 16-bit value; compare against the sample shifted to
    // the top bits, matching what encoders write for low depths.
    const trnsSample = trns === -1 ? -1 : trns >> (16 - depth);
    for (let x = 0; x < w; x++, o += 4) {
      const byte = src[(x * depth) >>> 3]!;
      const inByte = x % slotsPerByte;
      const sample = (byte >> (8 - (inByte + 1) * depth)) & max;
      const gray = lut[sample]!;
      dst[o] = gray;
      dst[o + 1] = gray;
      dst[o + 2] = gray;
      dst[o + 3] = trnsSample === sample ? 0 : 255;
    }
  }

  // ------------------------------------------------------------------ teardown

  private settle(): void {
    const image = this.opts.collect
      ? ({ ...this.header!, data: this.image! } satisfies PNGImage)
      : null;
    this.doneResolve?.(image);
    this.doneResolve = null;
    this.doneReject = null;
  }

  private fail(error: PNGDecodeError): void {
    if (this.fatal) return;
    this.fatal = error;
    this.image = null;
    if (this.inflate) {
      this.inflate.removeAllListeners('data');
      this.inflate.destroy();
      this.inflate = null;
    }
    try {
      this.opts.onError?.(error);
    } catch {
      // Error reporting must never throw.
    }
    this.doneReject?.(error);
    this.doneResolve = null;
    this.doneReject = null;
  }
}

/**
 * Copy a tightly packed RGBA pass row into the full image buffer,
 * honouring the Adam7 horizontal pixel spacing.
 */
function scatter(
  src: Uint8Array | Uint16Array,
  dst: Uint8Array | Uint16Array,
  base: number,
  step: number,
  count: number,
): void {
  for (let x = 0, o = base, d = 0; x < count; x++, o += step, d += 4) {
    dst[o] = src[d]!;
    dst[o + 1] = src[d + 1]!;
    dst[o + 2] = src[d + 2]!;
    dst[o + 3] = src[d + 3]!;
  }
}

function readUint16(data: Uint8Array, offset: number): number {
  return (data[offset]! << 8) | data[offset + 1]!;
}

function readUint32(data: Uint8Array, offset: number): number {
  return (
    data[offset]! * 0x1000000 +
    data[offset + 1]! * 0x10000 +
    data[offset + 2]! * 256 +
    data[offset + 3]!
  ) >>> 0;
}

/** Expansion tables for packed grayscale samples (PNG chapter 13.2). */
const GRAY_PACKED: Record<
  number,
  { lut: Uint8Array; max: number; slotsPerByte: number }
> = {
  1: grayPacked(1),
  2: grayPacked(2),
  4: grayPacked(4),
};

function grayPacked(depth: number): {
  lut: Uint8Array;
  max: number;
  slotsPerByte: number;
} {
  const max = (1 << depth) - 1;
  const lut = new Uint8Array(1 << depth);
  for (let v = 0; v <= max; v++) {
  // Expansion tables for packed grayscale samples: floor(v * 255 / max),
  // which gives [0,255], [0,85,170,255], [0,17,...,255].
    lut[v] = Math.floor((v * 255) / max);
  }
  return { lut, max, slotsPerByte: 8 / depth };
}


function toPNGError(error: unknown): PNGDecodeError {
  return error instanceof PNGDecodeError
    ? error
    : new PNGDecodeError(
        'INFLATE_FAILED',
        `unexpected failure: ${(error as Error).message ?? String(error)}`,
      );
}
