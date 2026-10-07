// Standard CRC-32 (ISO 3309 / RFC 1952), as used by PNG chunk CRC fields.
// Polynomial 0xEDB88320, init 0xFFFFFFFF, result XOR 0xFFFFFFFF.

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
  private crc = 0xffffffff;

  update(data: Uint8Array, start = 0, end: number = data.length): this {
    let crc = this.crc;
    for (let i = start; i < end; i++) {
      crc = TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
    }
    this.crc = crc;
    return this;
  }

  /** CRC over type bytes followed by chunk data. */
  static chunk(type: Uint8Array, data: Uint8Array): number {
    return new Crc32().update(type).update(data).finish();
  }

  finish(): number {
    return (this.crc ^ 0xffffffff) >>> 0;
  }
}
