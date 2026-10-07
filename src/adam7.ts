/**
 * Adam7 interlace parameters (PNG spec section 8, table 8.1).
 *
 * For pass n (1-indexed), pixels are sampled from final-image columns
 * xStart + k * xStep and rows yStart + k * yStep. The reduced image has
 * `passWidth` columns and `passHeight` rows (either may be 0).
 */
export interface Adam7Pass {
  pass: number;
  xStart: number;
  yStart: number;
  xStep: number;
  yStep: number;
  width: number;
  height: number;
}

export function reducedDim(
  size: number,
  start: number,
  step: number,
): number {
  return size <= start ? 0 : Math.floor((size - start - 1) / step) + 1;
}

// start/step per pass: x first then y.
const TABLE = [
  [0, 8, 0, 8],
  [4, 8, 0, 8],
  [0, 4, 4, 8],
  [2, 4, 0, 4],
  [0, 2, 2, 4],
  [1, 2, 0, 2],
  [0, 1, 1, 2],
] as const;

export function adam7Passes(
  width: number,
  height: number,
): Adam7Pass[] {
  return TABLE.map(([xStart, xStep, yStart, yStep], i) => ({
    pass: i + 1,
    xStart,
    yStart,
    xStep,
    yStep,
    width: reducedDim(width, xStart, xStep),
    height: reducedDim(height, yStart, yStep),
  }));
}
