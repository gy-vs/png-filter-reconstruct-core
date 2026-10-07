/**
 * Adam7 interlace pass layout (PNG 1.2, chapter 8).
 *
 * Pass n contains pixels whose final-image coordinates satisfy
 * x === xStart (mod xStep) and y === yStart (mod yStep).
 */
export interface Adam7Pass {
  xStart: number;
  yStart: number;
  xStep: number;
  yStep: number;
}

export const ADAM7_PASSES: readonly Adam7Pass[] = [
  { xStart: 0, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 4, yStart: 0, xStep: 8, yStep: 8 },
  { xStart: 0, yStart: 4, xStep: 4, yStep: 8 },
  { xStart: 2, yStart: 0, xStep: 4, yStep: 4 },
  { xStart: 0, yStart: 2, xStep: 2, yStep: 4 },
  { xStart: 1, yStart: 0, xStep: 2, yStep: 2 },
  { xStart: 0, yStart: 1, xStep: 1, yStep: 2 },
];

export function adam7PassWidth(pass: Adam7Pass, width: number): number {
  return Math.max(0, Math.ceil((width - pass.xStart) / pass.xStep));
}

export function adam7PassHeight(pass: Adam7Pass, height: number): number {
  return Math.max(0, Math.ceil((height - pass.yStart) / pass.yStep));
}
