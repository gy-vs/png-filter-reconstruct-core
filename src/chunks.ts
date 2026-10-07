import { Crc32 } from './crc.js';
import { PngDecodeError } from './error.js';

export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** A byte buffer that grows geometrically while being filled. */
class GrowBuffer {
  view: Uint8Array;
  size = 0;

  constructor(initial: number) {
    this.view = new Uint8Array(initial);
  }

  /** Append as many bytes from input as this buffer wants; return used. */
  fillFrom(input: Uint8Array, offset: number, wanted: number): number {
    const take = Math.min(wanted - this.size, input.length - offset);
    if (this.view.length < wanted) {
      const cap = Math.max(wanted, this.view.length * 2, 64);
      const grown = new Uint8Array(cap);
      grown.set(this.view.subarray(0, this.size));
      this.view = grown;
    }
    this.view.set(input.subarray(offset, offset + take), this.size);
    this.size += take;
    return take;
  }

  reset(initial = Math.max(this.view.length, 16)): void {
    this.size = 0;
    if (this.view.length !== initial) this.view = new Uint8Array(initial);
  }
}

export interface ChunkHandlers {
  onHeader(type: Uint8Array): void;
  /** Return true to stop parsing (IEND). May be async (IDAT inflate). */
  onComplete(
    type: Uint8Array,
    data: Uint8Array,
  ): boolean | Promise<boolean>;
  onCrcError(type: string): void;
}

type Phase = 'signature' | 'header' | 'data' | 'crc';

/**
 * State machine that consumes arbitrary-length byte pushes and yields whole
 * chunks. A chunk's data is only handed over after its 4 CRC bytes have been
 * received and checked, so callers never act on unchecked bytes.
 *
 * The data buffer grows geometrically; the declared chunk length is never
 * used to pre-allocate memory.
 */
export class ChunkReader {
  private phase: Phase = 'signature';
  private pending = new GrowBuffer(8);
  private dataBuf = new GrowBuffer(16);
  private chunkLength = 0;
  private chunkType = new Uint8Array(4);
  private crcCalc = new Crc32();
  private finished = false;

  constructor(private readonly handlers: ChunkHandlers) {}

  get isFinished(): boolean {
    return this.finished;
  }

  async feed(input: Uint8Array): Promise<void> {
    if (this.finished) {
      throw new PngDecodeError(
        'unexpected-chunk',
        'data after IEND chunk',
      );
    }

    let offset = 0;
    outer: while (offset < input.length) {
      switch (this.phase) {
        case 'signature': {
          const used = this.pending.fillFrom(
            input,
            offset,
            PNG_SIGNATURE.length,
          );
          offset += used;
          if (this.pending.size === PNG_SIGNATURE.length) {
            for (let i = 0; i < PNG_SIGNATURE.length; i++) {
              if (this.pending.view[i] !== PNG_SIGNATURE[i]) {
                throw new PngDecodeError(
                  'invalid-signature',
                  'not a PNG file: signature mismatch',
                );
              }
            }
            this.pending.reset(8);
            this.phase = 'header';
          }
          break;
        }

        case 'header': {
          const used = this.pending.fillFrom(input, offset, 8);
          offset += used;
          if (this.pending.size === 8) {
            const h = this.pending.view;
            this.chunkLength =
              (h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3];
            if (this.chunkLength < 0 || this.chunkLength > 0x7fffffff) {
              throw new PngDecodeError(
                'invalid-chunk',
                `invalid chunk length ${this.chunkLength >>> 0}`,
              );
            }
            this.chunkType.set(h.subarray(4, 8));
            this.handlers.onHeader(this.chunkType);
            this.crcCalc = new Crc32().update(this.chunkType);
            this.pending.reset(4);
            this.dataBuf.reset(16);
            this.phase = 'data';
          }
          break;
        }

        case 'data': {
          const used = this.dataBuf.fillFrom(
            input,
            offset,
            this.chunkLength,
          );
          offset += used;
          this.crcCalc.update(
            input,
            offset - used,
            offset,
          );
          if (this.dataBuf.size === this.chunkLength) {
            this.phase = 'crc';
          }
          break;
        }

        case 'crc': {
          const used = this.pending.fillFrom(input, offset, 4);
          offset += used;
          if (this.pending.size === 4) {
            const h = this.pending.view;
            const stored =
              ((h[0] << 24) |
                (h[1] << 16) |
                (h[2] << 8) |
                h[3]) >>>
              0;
            if (stored !== this.crcCalc.finish()) {
              this.handlers.onCrcError(typeName(this.chunkType));
            }
            const data = this.dataBuf.view.subarray(0, this.chunkLength);
            const stop = await this.handlers.onComplete(
              this.chunkType,
              data,
            );
            if (stop) {
              this.finished = true;
              if (offset < input.length) {
                throw new PngDecodeError(
                  'unexpected-chunk',
                  'data after IEND chunk',
                );
              }
              break outer;
            }
            this.chunkType = new Uint8Array(4);
            this.pending.reset(8);
            this.phase = 'header';
          }
          break;
        }
      }
    }
  }
}

export function typeName(type: Uint8Array): string {
  let s = '';
  for (let i = 0; i < 4; i++) s += String.fromCharCode(type[i]);
  return s;
}

export function isCritical(type: Uint8Array): boolean {
  // Critical bit: bit 5 of the first byte must be 0.
  return (type[0] & 0x20) === 0;
}
