/**
 * Incremental CRC-32 (PNG's CRC-32/ISO-HDLC variant).
 *
 * Each chunk's CRC covers its 4-byte type followed by its data. Because
 * bytes arrive in arbitrarily sized pieces, the checksum is computed
 * incrementally while a chunk body is streamed through.
 */

const TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export class Crc32 {
  private state = 0xffffffff;

  update(data: Uint8Array, start = 0, end: number = data.length): void {
    let c = this.state;
    for (let i = start; i < end; i++) {
      c = TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    }
    this.state = c;
  }

  /** Final CRC value; reading it does not finish the stream. */
  value(): number {
    return (this.state ^ 0xffffffff) >>> 0;
  }
}

/** One-shot helper used for small in-memory buffers. */
export function crc32(data: Uint8Array): number {
  const crc = new Crc32();
  crc.update(data);
  return crc.value();
}
