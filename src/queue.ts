/**
 * A zero-copy FIFO of byte chunks.
 *
 * Pushed Uint8Arrays are kept as references (only the queued prefix may be
 * later detached when handed to zlib), and bytes are consumed from the
 * front. No growing monolithic buffer is allocated regardless of how many
 * pushes happen.
 */
export class ChunkQueue {
  private parts: Uint8Array[] = [];
  private offset = 0;
  private total = 0;

  get length(): number {
    return this.total;
  }

  push(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.parts.push(chunk);
    this.total += chunk.length;
  }

  /** Number of bytes currently available. */
  available(): number {
    return this.total;
  }

  peekByte(index: number): number {
    let pos = index - this.offset;
    for (const part of this.parts) {
      if (pos < part.length) return part[pos];
      pos -= part.length;
    }
    throw new RangeError('peekByte past end of queue');
  }

  private readExact(len: number, into: Uint8Array | null): void {
    let remaining = len;
    while (remaining > 0) {
      const part = this.parts[0];
      const available = part.length - this.offset;
      const take = Math.min(available, remaining);
      if (into) {
        into.set(
          part.subarray(this.offset, this.offset + take),
          len - remaining,
        );
      }
      remaining -= take;
      this.total -= take;
      if (take === available) {
        this.parts.shift();
        this.offset = 0;
      } else {
        this.offset += take;
      }
    }
  }

  /** Remove and return exactly `len` bytes in a fresh buffer. */
  readBytes(len: number): Uint8Array {
    if (len > this.total) throw new RangeError('not enough bytes');
    const out = new Uint8Array(len);
    this.readExact(len, out);
    return out;
  }

  /** Drop `len` bytes from the front. */
  skip(len: number): void {
    if (len > this.total) throw new RangeError('not enough bytes');
    this.readExact(len, null);
  }

  /**
   * Remove and return exactly `len` bytes without copying when they live
   * in a single contiguous queued part. Otherwise a copy is made.
   */
  readContiguous(len: number): Uint8Array {
    if (len > this.total) throw new RangeError('not enough bytes');
    const first = this.parts[0];
    const available = first.length - this.offset;
    if (available >= len) {
      const slice = first.subarray(this.offset, this.offset + len);
      this.offset += len;
      this.total -= len;
      if (this.offset === first.length) {
        this.parts.shift();
        this.offset = 0;
      }
      return slice;
    }
    return this.readBytes(len);
  }
}
