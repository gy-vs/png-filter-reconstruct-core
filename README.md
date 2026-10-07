# streaming-png-decoder

A streaming PNG decoder written in TypeScript. Feed it bytes as they
arrive over the network — a byte at a time, a chunk at a time, or the
whole file at once — and it emits IHDR metadata as soon as the header is
parsed and each reconstructed scanline as soon as it is available,
without waiting for the file to finish downloading.

Pixels are always delivered as RGBA:

- source bit depth ≤ 8 → 8 bits per channel (`Uint8Array`)
- source bit depth 16 → 16 bits per channel (`Uint16Array`, native endian)

All legal PNG colour type / bit depth combinations are supported
(grayscale, RGB, indexed, gray+alpha and RGBA at 1/2/4/8/16 bits where
allowed), `tRNS` transparency for grayscale/truecolour/indexed images,
all five scanline filters, and Adam7 interlacing.

## Install / build / test

```sh
npm install
npm test       # vitest
npm run build  # tsc -> dist/
```

## Line-at-a-time streaming

```ts
import { StreamingPNGDecoder } from 'streaming-png-decoder';

const decoder = new StreamingPNGDecoder({
  collect: false, // don't keep the whole image; rows only
  onHeader: (header) => {
    // { width, height, bitDepth, colorType, interlaced }
  },
  onRow: (row) => {
    // row.data: tight RGBA for this scanline of the current Adam7 pass
    // row.pass / row.y / row.yPos / row.x0 / row.xStep locate it in the
    // final image (pass is always 0 for non-interlaced PNGs).
  },
  onError: (error) => {
    // the upload can be aborted here
  },
});

socket.on('data', (bytes) => decoder.push(bytes)); // may throw on structural errors
socket.on('end', () => decoder.finish());          // resolves when complete
```

In line-streaming mode the decoder's retained state is O(width), never
O(width × height): a 4000×30000 image uses the same order of internal
memory as a 4000×300 image (a couple of scanline buffers plus the zlib
window). Each `row.data` is owned by the caller once delivered.

## Decode a complete buffer

```ts
import { decodePNG } from 'streaming-png-decoder';

const image = await decodePNG(bytes);
// { width, height, bitDepth, colorType, interlaced, data }
// data is width*height*4 samples, tightly packed rows
```

You can also combine both: pass `collect: true` with an `onRow` callback
to get progressive rows and the assembled image from `finish()`.

## Error handling

Any structural problem (bad signature/CRC, bad chunk order,
non-contiguous IDATs, unknown critical chunk, data after IEND,
decompressed length mismatch, palette index out of range, …) fails the
decode permanently. Errors detected synchronously are thrown from
`push()`; every error is also reported via `onError` and rejects the
promise from `finish()`. After a failure, further `push()` calls throw
the same error and no more rows are emitted — the failing scanline is
never handed out.

Ancillary chunks that are not recognised are skipped. By default an
ancillary chunk whose CRC is wrong is also skipped; pass
`failOnCorruptAncillaryCRC: true` to treat that as fatal instead. A bad
CRC on a critical chunk is always fatal.

Decompression uses `node:zlib`; filtering, interlace reassembly and pixel
conversion are implemented here.
