# Streaming PNG decoder

A dependency-free, streaming PNG decoder written in TypeScript. Pixels are
produced **while the file is still being received**: push arbitrary-length
chunks (even one byte at a time), receive each decoded scanline as soon as
its bytes are available, and abort immediately when the file is malformed.

Decompression uses `node:zlib`; everything else (signature/chunk parsing,
CRC checks, scanline filter reconstruction, Adam7 interlace, pixel-format
conversion) is implemented in this package. No image libraries are used.

## Install / build / test

```sh
npm install
npm run build   # tsc -> dist/
npm test        # vitest
```

## Usage

### Row streaming (bounded memory)

```ts
import { PngDecoder } from 'png-filter-reconstruct-core';

const decoder = new PngDecoder({
  onHeader(header) {
    // header.width, height, bitDepth, colorType, interlaceMethod,
    // header.interlaced
  },
  onRow(row) {
    // Called as soon as one scanline is reconstructed.
    // row.data:     Uint8Array (depth <= 8) or Uint16Array (depth 16),
    //               tightly packed RGBA, length row.width * 4
    // row.pass:     0 for non-interlaced, 1..7 for Adam7
    // row.yPosition final-image row
    // row.xStart / row.xStep: final-image columns for interlaced rows
    generateThumbnailTile(row);
  },
});

socket.on('data', async (bytes) => {
  await decoder.push(bytes); // throws as soon as the file is known bad
});
socket.on('end', () => decoder.end());
```

For Adam7 images, pixel `i` of `row.data` belongs to final-image column
`row.xStart + i * row.xStep`. Assembling every streamed row yields the same
pixels as decoding the non-interlaced version of the image.

### Whole image at the end

```ts
const decoder = new PngDecoder();
await decoder.push(part1);
await decoder.push(part2);
const image = await decoder.end();
image.data; // Uint8Array or Uint16Array, width*height*4 RGBA samples
```

### Options

| option | meaning |
| --- | --- |
| `onHeader` | called once right after IHDR is validated |
| `onRow` | called per reconstructed scanline; switches to streaming mode (`end()` then resolves to `undefined`) |
| `errorOnAncillaryCrc` | default `false`: an ancillary chunk with a bad CRC is skipped. Set `true` to reject the whole decode. Critical chunk CRC errors always reject. |

## Supported format

- All legal color-type / bit-depth combinations:
  grayscale (1/2/4/8/16), truecolor (8/16), indexed (1/2/4/8),
  grayscale+alpha (8/16), RGBA (8/16).
- `tRNS` for grayscale, truecolor and indexed images.
- All five scanline filters (None, Sub, Up, Average, Paeth).
- Adam7 interlace, with per-pass placement metadata in streaming mode.
- Uniform RGBA output: 8 bits/channel for source depths ≤ 8,
  16 bits/channel for 16-bit sources.

## Errors

`push`/`end` reject with `PngDecodeError` (`.code` discriminates the cause).
After the first error the decoder is permanently stopped: later pushes
never produce more rows or buffers. Detected structural problems include:
bad signature, bad order/duplication of critical chunks, non-contiguous
IDAT, unknown critical chunks, bad critical-chunk CRCs, trailing data after
IEND, truncated input, zlib failures, decompressed length mismatches,
invalid filter bytes, out-of-range palette indices (the failing row is
never delivered).

## Memory

In row-streaming mode the decoder retains only width-sized state (a raw
scanline, two reconstruction buffers and a partial-line tail); retained
memory is independent of image height. The whole-image mode allocates one
`width*height*4` output buffer, as required to return the assembled image.
