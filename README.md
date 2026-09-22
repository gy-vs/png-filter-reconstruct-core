# PNG codec core

TypeScript library for PNG chunks and scanlines.

Run `npm install`, then `npm test` and `npm run build`.

## Scanline filter reconstruction

`ScanlineReconstructor` turns the decompressed IDAT byte stream into raw pixel
rows, incrementally:

- all five PNG filters (None, Sub, Up, Average, Paeth) with uint8 wraparound
  arithmetic
- `bytesPerPixel` / `rowLength` derived from color type, bit depth and
  channels; bit depths below 8 filter whole bytes (bpp = 1)
- bytes can be pushed in any chunking — a filter-type byte or row split across
  IDAT boundaries simply waits for more data
- exactly `ihdr.height` rows are emitted; only the previous row is kept as
  filter context
- errors name the row: invalid filter type, truncated rows, excess data

```ts
import { ScanlineReconstructor, parseIhdr, readChunk } from 'png-filter-reconstruct-core';

const recon = new ScanlineReconstructor(parseIhdr(ihdrChunk.data));
const rows = [];
for (const inflated of inflateIdats()) rows.push(...recon.push(inflated));
recon.finish(); // throws on truncated rows or excess data
```
