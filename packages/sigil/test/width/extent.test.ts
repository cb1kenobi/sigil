import { maxOf, minOf } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

/**
 * `maxOf()` and `minOf()` replace `Math.max(...values)` and `Math.min(...values)`
 * wherever the list is as long as somebody's data, so the one thing they must
 * never do is answer differently from the spread they replaced -- including for
 * the inputs the spread answers oddly.
 */
const LISTS: Record<string, number[]> = {
  empty: [],
  equal: [3, 3, 3],
  infinite: [1, Infinity, -Infinity, 3],
  nan: [1, NaN, 3],
  'nan alone': [NaN],
  negative: [-2, -1, -5],
  one: [5],
  'signed zeros': [-0, 0],
  'signed zeros, the other way': [0, -0],
};

describe('maxOf()', () => {
  it('should answer exactly what Math.max(...values) answers', () => {
    for (const [name, values] of Object.entries(LISTS)) {
      expect(Object.is(maxOf(values), Math.max(...values)), name).to.equal(true);
    }
  });

  it('should answer exactly what Math.max(floor, ...values) answers', () => {
    for (const floor of [0, 1, -Infinity, NaN, -0]) {
      for (const [name, values] of Object.entries(LISTS)) {
        expect(Object.is(maxOf(values, floor), Math.max(floor, ...values)), name).to.equal(true);
      }
    }
  });

  // a million rather than the 200,000 a main thread fails at, because a vitest
  // worker has four times the stack and spreads 300,000 happily
  it('should answer for more values than a call has room for arguments', () => {
    const values = Array.from({ length: 1_000_000 }, (_, i) => (i === 123_456 ? 7 : i % 3));

    expect(maxOf(values)).to.equal(7);
  });

  it('should read any iterable', () => {
    expect(maxOf(new Set([1, 9, 4]))).to.equal(9);
  });
});

describe('minOf()', () => {
  it('should answer exactly what Math.min(...values) answers', () => {
    for (const [name, values] of Object.entries(LISTS)) {
      expect(Object.is(minOf(values), Math.min(...values)), name).to.equal(true);
    }
  });

  it('should answer exactly what Math.min(ceiling, ...values) answers', () => {
    for (const ceiling of [0, 1, Infinity, NaN, -0]) {
      for (const [name, values] of Object.entries(LISTS)) {
        expect(Object.is(minOf(values, ceiling), Math.min(ceiling, ...values)), name).to.equal(
          true
        );
      }
    }
  });

  it('should answer for more values than a call has room for arguments', () => {
    const values = Array.from({ length: 1_000_000 }, (_, i) => (i === 123_456 ? -7 : i % 3));

    expect(minOf(values)).to.equal(-7);
  });
});
