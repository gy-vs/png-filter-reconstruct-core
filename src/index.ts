export { StreamingPNGDecoder, paeth } from './decoder.js';
export {
  PNGDecodeError,
  type DecodedRow,
  type PNGColorType,
  type PNGDecoderOptions,
  type PNGErrorCode,
  type PNGHeader,
  type PNGImage,
} from './types.js';

import { StreamingPNGDecoder } from './decoder.js';
import type { PNGDecoderOptions, PNGImage } from './types.js';

/**
 * Decode a complete PNG buffer in one call. Convenience wrapper around
 * {@link StreamingPNGDecoder}.
 */
export function decodePNG(
  data: Uint8Array,
  options: PNGDecoderOptions = {},
): Promise<PNGImage> {
  const decoder = new StreamingPNGDecoder({ ...options, collect: true });
  decoder.push(data);
  return decoder.finish() as Promise<PNGImage>;
}
