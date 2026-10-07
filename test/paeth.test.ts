import { expect, it, describe } from 'vitest';
import { paeth } from '../src/index.js';

describe('paeth predictor', () => {
  it('matches the PNG reference tie-breaking', () => {
    // classic example
    expect(paeth(10, 20, 15)).toBe(15);
    // first row (no left/up): predictor is 0
    expect(paeth(0, 0, 0)).toBe(0);
    // pure horizontal/vertical edges
    expect(paeth(100, 0, 0)).toBe(100);
    expect(paeth(0, 100, 0)).toBe(100);
    // a closest
    expect(paeth(40, 10, 5)).toBe(40);
    // tie between a and b prefers a
    expect(paeth(30, 30, 0)).toBe(30);
    // c wins when it is closest: a=10,b=20,c=15 -> 15
    // b-c aligned with c: paeth(50,200,200): p=50,pa=0,pb=0,pc=150 -> a
    expect(paeth(50, 200, 200)).toBe(50);
    // wraparound-safe values
    expect(paeth(255, 255, 255)).toBe(255);
    expect(paeth(255, 0, 255)).toBe(0);
  });
});
