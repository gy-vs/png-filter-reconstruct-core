export type PngErrorCode =
  | 'invalid-signature'
  | 'invalid-header'
  | 'unsupported-format'
  | 'invalid-chunk'
  | 'crc-error'
  | 'unexpected-chunk'
  | 'inflate-error'
  | 'data-length'
  | 'palette-index'
  | 'truncated';

/**
 * Every structural or data error found while decoding rejects with this class.
 * Once a PngDecodeError has been thrown, the decoder is dead: later push()/end()
 * calls reject with the same error and produce no more rows.
 */
export class PngDecodeError extends Error {
  readonly code: PngErrorCode;

  constructor(code: PngErrorCode, message: string) {
    super(message);
    this.name = 'PngDecodeError';
    this.code = code;
  }
}
