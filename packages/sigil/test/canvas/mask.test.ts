import {
  blueNoiseMask,
  dissolveMask,
  irisMask,
  MASK_MAX,
  type Mask,
  masked,
  maskThreshold,
  openMask,
  seeded,
  wipeMask,
} from '../../src/canvas/index.js';
import { orderCells } from '../../src/canvas/mask.js';
import { describe, expect, it, vi } from 'vitest';

/**
 * How many cells of each value a field holds.
 *
 * Every generator but the iris lays an even ramp over the rectangle, so the
 * histogram is the whole of what "a permutation of the ramp" means -- and it is
 * what catches a generator that ranked one cell twice and another never, which
 * is the one way the void-and-cluster phases can go wrong and still look right.
 */
function histogram(mask: Mask): Map<number, number> {
  const counts = new Map<number, number>();
  for (const value of mask.values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** The histogram an even ramp over `count` cells has to come to. */
function evenRamp(count: number): Map<number, number> {
  const counts = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const value = Math.min(MASK_MAX, Math.floor((i * (MASK_MAX + 1)) / Math.max(1, count)));
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return counts;
}

/** How many cells of a mask show at a threshold. */
function showing(mask: Mask, threshold: number): number {
  const was = mask.threshold;
  mask.threshold = threshold;
  let count = 0;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (masked(mask, x, y)) {
        count++;
      }
    }
  }
  mask.threshold = was;
  return count;
}

/**
 * How unevenly a mask's revealed cells are spread, at half way.
 *
 * The variance of the per-block count over 4x4 blocks. This is the number blue
 * noise exists to make small: a field whose values are independent of position
 * reveals a uniform *sample* of the rectangle, which clumps by chance, while one
 * built from voids and clusters cannot -- a cell that would clump is exactly the
 * one it ranks last.
 */
function clumpiness(mask: Mask, block = 4): number {
  mask.threshold = maskThreshold(0.5);
  const counts: number[] = [];
  for (let by = 0; by + block <= mask.height; by += block) {
    for (let bx = 0; bx + block <= mask.width; bx += block) {
      let count = 0;
      for (let y = by; y < by + block; y++) {
        for (let x = bx; x < bx + block; x++) {
          if (masked(mask, x, y)) {
            count++;
          }
        }
      }
      counts.push(count);
    }
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  return counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
}

/**
 * The variance of the revealed count over 4x4 blocks in the four columns from
 * `x0`, at half way -- the same measure `clumpiness()` takes, over one strip.
 */
function stripVariance(mask: Mask, x0: number): number {
  mask.threshold = maskThreshold(0.5);
  const counts: number[] = [];
  for (let by = 0; by + 4 <= mask.height; by += 4) {
    let count = 0;
    for (let y = by; y < by + 4; y++) {
      for (let x = x0; x < x0 + 4; x++) {
        if (masked(mask, x, y)) {
          count++;
        }
      }
    }
    counts.push(count);
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  return counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
}

/**
 * Where on the tile a 64x32 mask starts, found by reading it back.
 *
 * A full tile has no repeated rank, so every start is the same field read round
 * the torus from somewhere else, and exactly one shift of a start-at-zero field
 * reproduces it -- which is also the assertion that it is a window onto one tile
 * and not a tile of its own.
 */
function windowOf(mask: Mask): [number, number] | undefined {
  const zero = blueNoiseMask(64, 32, () => 0).values;
  for (let dy = 0; dy < 32; dy++) {
    for (let dx = 0; dx < 64; dx++) {
      let same = true;
      for (let y = 0; y < 32 && same; y++) {
        for (let x = 0; x < 64; x++) {
          if (mask.values[y * 64 + x] !== zero[((y + dy) % 32) * 64 + ((x + dx) % 64)]) {
            same = false;
            break;
          }
        }
      }
      if (same) {
        return [dx, dy];
      }
    }
  }
  return undefined;
}

describe('a mask', () => {
  it('should reveal nothing at the bottom of the ramp and everything at the top', () => {
    // the one thing every caller gets wrong once, and the reason
    // `maskThreshold()` exists: a cell shows at `<=` and a field always has
    // cells at zero, so the threshold that reveals nothing is -1 rather than 0
    const mask = dissolveMask(8, 4, seeded(1));
    expect(showing(mask, maskThreshold(0))).toBe(0);
    expect(showing(mask, maskThreshold(1))).toBe(32);
    expect(maskThreshold(0)).toBe(-1);
    expect(maskThreshold(1)).toBe(MASK_MAX);
  });

  it('should clamp a progress that is not a fraction rather than trusting it', () => {
    // a NaN threshold compares false against every value, so a reveal driven by
    // one would show nothing for ever with nothing to say so
    expect(maskThreshold(Number.NaN)).toBe(-1);
    expect(maskThreshold(Number.POSITIVE_INFINITY)).toBe(-1);
    expect(maskThreshold(-5)).toBe(-1);
    expect(maskThreshold(9)).toBe(MASK_MAX);
  });

  it('should reveal more as the threshold rises and never less', () => {
    const mask = blueNoiseMask(12, 8, seeded(3));
    let last = -1;
    for (let step = 0; step <= 32; step++) {
      const count = showing(mask, maskThreshold(step / 32));
      expect(count).toBeGreaterThanOrEqual(last);
      last = count;
    }
    expect(last).toBe(96);
  });

  it('should say no about a cell it has nothing to say about', () => {
    // the direction that cannot surprise anybody: the other reading would make
    // a mask narrower than its layer silently reveal the whole right-hand side
    const mask = openMask(2, 2);
    expect(masked(mask, 0, 0)).toBe(true);
    expect(masked(mask, 2, 0)).toBe(false);
    expect(masked(mask, 0, 2)).toBe(false);
    expect(masked(mask, -1, 0)).toBe(false);
    expect(masked(mask, 0, -1)).toBe(false);
  });

  it('should open fully, which is what no mask means', () => {
    const mask = openMask(3, 2);
    expect(mask.threshold).toBe(MASK_MAX);
    expect(showing(mask, mask.threshold)).toBe(6);
  });

  it('should read a degenerate size as empty rather than as a negative one', () => {
    for (const mask of [
      dissolveMask(0, 4, seeded(1)),
      dissolveMask(4, 0, seeded(1)),
      dissolveMask(-3, 2, seeded(1)),
      blueNoiseMask(0, 0, seeded(1)),
      wipeMask(0, 3),
      irisMask(0, 0),
      openMask(-1, -1),
    ]) {
      expect(mask.values.length).toBe(0);
      expect(mask.width * mask.height).toBe(0);
    }
  });

  it('should truncate a fractional size the way a grid does', () => {
    const mask = wipeMask(3.9, 2.9);
    expect([mask.width, mask.height]).toEqual([3, 2]);
    expect(mask.values.length).toBe(6);
  });

  describe('a dissolve', () => {
    it('should lay an even ramp, so a step of the threshold takes a steady share', () => {
      const mask = dissolveMask(16, 8, seeded(5));
      expect(histogram(mask)).toEqual(evenRamp(128));
    });

    it('should reproduce from a seed', () => {
      expect([...dissolveMask(9, 5, seeded(42)).values]).toEqual([
        ...dissolveMask(9, 5, seeded(42)).values,
      ]);
    });

    it('should shuffle, so two seeds disagree', () => {
      // a generator that ignored its source would pass every assertion above
      expect([...dissolveMask(9, 5, seeded(1)).values]).not.toEqual([
        ...dissolveMask(9, 5, seeded(2)).values,
      ]);
    });

    it('should survive a generator that answers out of range', () => {
      // the clamp is what makes a generator safe to hand somebody else's
      // randomness: a value at or above one indexes one past the end of the
      // shuffle, which swaps a cell with `undefined` and leaves a hole in the
      // permutation -- and a hole is a value nothing reveals, so a cell would
      // stay hidden for the whole transition
      for (const random of [
        () => 1,
        () => 1.5,
        () => -1,
        () => Number.NaN,
        () => Number.POSITIVE_INFINITY,
      ]) {
        const mask = dissolveMask(7, 3, random);
        expect(histogram(mask)).toEqual(evenRamp(21));
      }
    });
  });

  describe('a wipe', () => {
    it('should give a whole column one value, so the edge is a straight line', () => {
      const mask = wipeMask(4, 2, 'right');
      expect([...mask.values]).toEqual([0, 64, 128, 192, 0, 64, 128, 192]);
    });

    it('should start from the edge it was named for', () => {
      expect([...wipeMask(4, 1, 'left').values]).toEqual([192, 128, 64, 0]);
      expect([...wipeMask(1, 4, 'down').values]).toEqual([0, 64, 128, 192]);
      expect([...wipeMask(1, 4, 'up').values]).toEqual([192, 128, 64, 0]);
    });

    it('should finish in one step along an axis one cell long', () => {
      // a one-column wipe has one column to wipe, so every cell shares the
      // bottom of the ramp. `rank()` divides by `max(1, count)`, which is what
      // keeps that from being a division by nothing
      expect([...wipeMask(1, 3, 'right').values]).toEqual([0, 0, 0]);
      expect([...wipeMask(3, 1, 'down').values]).toEqual([0, 0, 0]);
    });

    it('should reveal a column at a time, which is what makes it a sweep', () => {
      const mask = wipeMask(4, 3, 'right');
      expect(showing(mask, 0)).toBe(3);
      expect(showing(mask, 64)).toBe(6);
      expect(showing(mask, MASK_MAX)).toBe(12);
    });
  });

  describe('an iris', () => {
    it('should open from the middle outwards', () => {
      const mask = irisMask(5, 3);
      expect(mask.values[1 * 5 + 2]).toBe(0);
      expect(mask.values[0]).toBe(MASK_MAX);
      expect(mask.values[2 * 5 + 4]).toBe(MASK_MAX);
    });

    it('should open from a named point', () => {
      const mask = irisMask(5, 3, { x: 0, y: 0 });
      expect(mask.values[0]).toBe(0);
      expect(mask.values[2 * 5 + 4]).toBe(MASK_MAX);
    });

    it('should count a row as two columns, so a circle looks like one', () => {
      // a terminal cell is about twice as tall as it is wide, so a field on raw
      // cell distance draws an ellipse twice as tall as it is round
      const mask = irisMask(9, 9, { aspect: 2 });
      const center = 4 * 9 + 4;
      // two cells right of center against one cell below it: the same distance
      // on screen, so the same value
      expect(mask.values[center + 2]).toBe(mask.values[center + 9]);
      // and at an aspect of one they part, which is what says the option is read
      const square = irisMask(9, 9, { aspect: 1 });
      expect(square.values[center + 2]).not.toBe(square.values[center + 9]);
    });

    it('should finish exactly when the threshold does, from any center', () => {
      // the farthest corner is what the ramp is normalized by, and the maximum
      // of a Euclidean distance over a rectangle is at a corner whether or not
      // the center is inside it -- so the two outside centers are the cases
      // that say the four-corner read is enough rather than a shortcut
      for (const [x, y] of [
        [0, 0],
        [8, 0],
        [4, 2],
        [7, 3],
        [-20, -9],
        [40, 12],
      ]) {
        const mask = irisMask(9, 5, { x, y });
        expect(showing(mask, MASK_MAX)).toBe(45);
        expect(showing(mask, MASK_MAX - 1)).toBeLessThan(45);
      }
    });

    it('should open by area rather than by cell count', () => {
      // scaled by the longest distance rather than ranked by position, because
      // what decides an iris is *how far* a cell is rather than how many cells
      // are nearer. A circle's area goes as the square of its radius, so at
      // half the ramp a centered iris has nothing like half the cells -- where a
      // ranked field would have exactly half, and the circle would crawl at the
      // start and race at the end. Measured: 307 of 861 cells, which is 35.7%
      // -- not a quarter, because the disc at the full radius reaches the
      // corners and so extends past the rectangle's own edges.
      //
      // Both bounds do work, which took a correction: the lower one was
      // `> 0`, which a reveal of one cell passes, so the upper one was
      // carrying the whole claim. A ranked field reveals exactly half (about
      // 430) and the upper bound at 0.42 catches it; a field that opened far
      // too slowly -- a squared distance, say -- is what the lower bound at
      // 0.25 catches, and 0.357 sits clear of both
      const mask = irisMask(41, 21, { aspect: 2 });
      const half = showing(mask, maskThreshold(0.5));
      expect(half).toBeLessThan(41 * 21 * 0.42);
      expect(half).toBeGreaterThan(41 * 21 * 0.25);
    });

    it('should answer for a one-cell rectangle rather than dividing by nothing', () => {
      const mask = irisMask(1, 1);
      expect([...mask.values]).toEqual([0]);
    });

    it('should honour an aspect of zero rather than reading it as absent', () => {
      // `opts.aspect || 2` would default a zero to two, which is the shape this
      // repo records from the other side -- a uid of `0` is a uid. Zero is a
      // legitimate answer here: the row stops counting, so the field is a wipe
      // out from the center column and every cell of a column shares a value
      const mask = irisMask(5, 3, { aspect: 0 });
      expect(mask.values[0]).toBe(mask.values[1 * 5]);
      expect(mask.values[1 * 5 + 2]).toBe(0);
      expect(mask.values[0]).toBe(MASK_MAX);
      // and a negative one is the same field, because the distance squares it
      expect([...irisMask(5, 3, { aspect: -2 }).values]).toEqual([
        ...irisMask(5, 3, { aspect: 2 }).values,
      ]);
    });

    it('should fall back where an option is not a number', () => {
      const fallback = [...irisMask(5, 3).values];
      expect([...irisMask(5, 3, { aspect: Number.NaN }).values]).toEqual(fallback);
      expect([...irisMask(5, 3, { x: Number.NaN, y: Number.NaN }).values]).toEqual(fallback);
    });
  });

  describe('blue noise', () => {
    it('should rank every cell exactly once', () => {
      // the histogram is what catches a void-and-cluster phase that ranked one
      // cell twice and another never -- which is what the three phases' index
      // ranges can do to each other, and which leaves a cell that never
      // reveals and another that reveals twice
      for (const [w, h] of [
        [1, 1],
        [2, 1],
        [3, 1],
        [1, 3],
        [4, 4],
        [5, 3],
        [9, 4],
        [16, 8],
      ]) {
        expect(histogram(blueNoiseMask(w, h, seeded(11))), `${w}x${h}`).toEqual(evenRamp(w * h));
      }
    });

    it('should spread each step more evenly than a shuffle does', () => {
      // the differential the generator exists for, and the only assertion that
      // can tell the two apart: both lay the same even ramp, so the histogram
      // cannot see the difference. Measured over eight seeds rather than one,
      // because a single shuffle can be lucky -- the mean per-block variance
      // is 0.742 for blue noise against 4.250 for the shuffle (0.813 for the
      // untiled generator this replaced, SIG-401), so the
      // threshold of a third has headroom in the direction that matters and
      // still fails for a generator that stopped being spatially aware
      let blue = 0;
      let shuffled = 0;
      for (let seed = 1; seed <= 8; seed++) {
        blue += clumpiness(blueNoiseMask(32, 16, seeded(seed)));
        shuffled += clumpiness(dissolveMask(32, 16, seeded(seed)));
      }
      expect(blue).toBeLessThan(shuffled / 3);
    });

    it('should reproduce from a seed', () => {
      expect([...blueNoiseMask(8, 5, seeded(9)).values]).toEqual([
        ...blueNoiseMask(8, 5, seeded(9)).values,
      ]);
    });

    it('should read its source, so two seeds disagree', () => {
      // the initial pattern is the only place the randomness enters, and the
      // phases after it are deterministic -- so a generator that was ignored
      // would give the same field every time and still pass every other
      // assertion here, including the one above. A repeated transition that
      // dissolves in exactly the same order reads as mechanical
      expect([...blueNoiseMask(16, 8, seeded(1)).values]).not.toEqual([
        ...blueNoiseMask(16, 8, seeded(2)).values,
      ]);
    });

    it('should run the generator once, however many masks and whatever their size', async () => {
      // the structural fact the tile is for, asserted without a clock: the
      // void-and-cluster builds its splat table with `Math.exp()`, so a call to
      // `Math.exp()` is a generator being constructed. Wall-clock deadlines
      // flaked on CI, and "work does not grow with the cell count" is not
      // something a deadline can say anyway. A fresh module, so that an earlier
      // test having built the tile does not make this one vacuous
      vi.resetModules();
      const fresh = await import('../../src/canvas/mask.js');
      const exp = vi.spyOn(Math, 'exp');
      try {
        fresh.blueNoiseMask(3, 3, seeded(1));
        const built = exp.mock.calls.length;
        expect(built).toBeGreaterThan(0);
        for (const [w, h] of [
          [1, 1],
          [40, 12],
          [64, 32],
          [240, 70],
          [400, 120],
        ]) {
          fresh.blueNoiseMask(w, h, seeded(w));
          fresh.blueNoiseMask(w, h);
        }
        expect(exp.mock.calls.length).toBe(built);
      } finally {
        exp.mockRestore();
      }
    });

    it('should lay an even ramp at any size, smaller than the tile or larger and in between', () => {
      // 64x32 is the tile: the sizes around it are a crop, the tile itself, one
      // more than it, a multiple of it, and a size that is a multiple of neither
      // -- with a long thin one each way, which is a window onto one row or one
      // column of the tile and then onto the next copy of it
      for (const [w, h] of [
        [63, 31],
        [64, 32],
        [65, 33],
        [128, 64],
        [130, 70],
        [240, 70],
        [200, 5],
        [5, 200],
      ]) {
        expect(histogram(blueNoiseMask(w, h, seeded(5))), `${w}x${h}`).toEqual(evenRamp(w * h));
      }
    });

    it('should reveal nothing at the bottom of the ramp and everything at the top, at any size', () => {
      for (const [w, h] of [
        [7, 3],
        [64, 32],
        [240, 70],
      ]) {
        const mask = blueNoiseMask(w, h, seeded(4));
        expect(showing(mask, maskThreshold(0)), `${w}x${h}`).toBe(0);
        expect(showing(mask, maskThreshold(1)), `${w}x${h}`).toBe(w * h);
      }
    });

    it('should reveal the same cells in every whole copy of the tile at any threshold', () => {
      // `() => 0` starts the tile at its own corner, so each of the nine copies is
      // a whole one. The tile is 2048 cells and the ramp has 256 buckets, so a
      // bucket takes eight ranks of every copy exactly and an edge never splits a
      // rank -- which makes this the check that the copies are one field repeated
      // rather than nine, and it fails for an order that gave each copy ranks of
      // its own
      const mask = blueNoiseMask(192, 96, () => 0);
      for (let step = 1; step < 32; step++) {
        mask.threshold = maskThreshold(step / 32);
        const counts = new Set<number>();
        for (let ty = 0; ty < 3; ty++) {
          for (let tx = 0; tx < 3; tx++) {
            let count = 0;
            for (let y = 0; y < 32; y++) {
              for (let x = 0; x < 64; x++) {
                if (masked(mask, tx * 64 + x, ty * 32 + y)) {
                  count++;
                }
              }
            }
            counts.add(count);
          }
        }
        expect([...counts], `step ${step}`).toHaveLength(1);
      }
    });

    it('should not let one copy of the tile lead another every time a bucket splits a rank', () => {
      // 100x32 is one whole tile and 36 columns of a second, so the cells in those
      // columns have a twin 64 columns to the right and a bucket edge can fall
      // between them. Which of the two goes first is the tie-break's to say, and
      // an order that left it to the cell index would put the left one first in
      // every pair -- a reveal that always runs left to right across the repeat,
      // by one cell at a time. Both directions have to occur
      const mask = blueNoiseMask(100, 32, () => 0);
      let leftFirst = 0;
      let rightFirst = 0;
      for (let y = 0; y < 32; y++) {
        for (let x = 0; x < 36; x++) {
          const left = mask.values[y * 100 + x];
          const right = mask.values[y * 100 + x + 64];
          if (left < right) {
            leftFirst++;
          } else if (right < left) {
            rightFirst++;
          }
        }
      }
      expect(leftFirst + rightFirst).toBeGreaterThan(40);
      expect(leftFirst).toBeGreaterThan((leftFirst + rightFirst) / 4);
      expect(rightFirst).toBeGreaterThan((leftFirst + rightFirst) / 4);
    });

    it('should spread a step as evenly across a tile seam as it does inside one', () => {
      // what the tile being toroidal buys, and the most this can honestly say:
      // blocks of 4 columns that straddle the seam at x=64 count revealed cells
      // about as evenly as blocks well inside a tile, and both beat a shuffle by
      // the same margin as everywhere else. Measured over eight seeds, the
      // per-block variance is 0.50 across the seam and 1.07 inside, against 4.3
      // for a shuffle. Which of the two is smaller is noise, at 24 blocks a seed,
      // but a seam that was a border, which would put a column of cells with
      // nothing on one side of them, would show as a multiple. It cannot see a
      // defect smaller than that sampling noise
      let seam = 0;
      let inside = 0;
      let shuffled = 0;
      for (let seed = 1; seed <= 8; seed++) {
        const mask = blueNoiseMask(192, 96, seeded(seed));
        seam += stripVariance(mask, 62);
        inside += stripVariance(mask, 30);
        shuffled += stripVariance(dissolveMask(192, 96, seeded(seed)), 62);
      }
      expect(seam).toBeLessThan(shuffled / 3);
      expect(seam).toBeLessThan(inside * 1.5);
    });

    it('should be no clumpier at a large size than at a small one', () => {
      // the per-block variance is 0.74 at 32x16, 0.75 at 64x32 and 0.74 at
      // 240x70 -- the repeat does not accumulate into anything
      let large = 0;
      let shuffled = 0;
      for (let seed = 1; seed <= 4; seed++) {
        large += clumpiness(blueNoiseMask(240, 70, seeded(seed)));
        shuffled += clumpiness(dissolveMask(240, 70, seeded(seed)));
      }
      expect(large).toBeLessThan(shuffled / 3);
    });

    it('should reproduce from a seed at a size larger than the tile', () => {
      expect([...blueNoiseMask(150, 50, seeded(9)).values]).toEqual([
        ...blueNoiseMask(150, 50, seeded(9)).values,
      ]);
    });

    it('should read its source at a size larger than the tile, so two seeds disagree', () => {
      // a seed picks where the tile starts and how its copies are ordered, and a
      // generator that was ignored would give one field for every caller
      expect([...blueNoiseMask(150, 50, seeded(1)).values]).not.toEqual([
        ...blueNoiseMask(150, 50, seeded(2)).values,
      ]);
    });

    it('should make every seed a window onto one tile rather than a tile of its own', () => {
      // a full tile has no repeated rank, so a field that starts anywhere is the
      // one that starts at (0, 0) read round the torus -- exactly, not
      // approximately. That is what lets the tile be built once for every caller
      const origin = windowOf(blueNoiseMask(64, 32, seeded(3)));
      expect(origin).not.toBeUndefined();
    });

    it('should not start the tile one column further along for each small seed', () => {
      // `seeded()` is very nearly linear in its seed on its first draws, so a
      // draw scaled straight to a column gave seeds 1 to 12 the origins 1 to 12.
      // The draw goes through `mix()` now, and neighbouring seeds land anywhere
      const origins: [number, number][] = [];
      for (let seed = 1; seed <= 12; seed++) {
        const at = windowOf(blueNoiseMask(64, 32, seeded(seed)));
        expect(at, `seed ${seed}`).not.toBeUndefined();
        origins.push(at as [number, number]);
      }
      let adjacent = 0;
      for (let i = 1; i < origins.length; i++) {
        if (origins[i][0] === origins[i - 1][0] + 1) {
          adjacent++;
        }
      }
      expect(adjacent).toBeLessThan(3);
      expect(new Set(origins.map((o) => o.join(','))).size).toBeGreaterThanOrEqual(10);
    });

    it('should break ties between copies from the third draw', () => {
      // above the tile a rank repeats, and the order of its copies is the salt.
      // Two generators with one window and different third draws must disagree,
      // and a generator that dropped the salt from the hash would not
      const draws = (third: number) => {
        const values = [0, 0.5, third];
        let i = 0;
        return () => values[Math.min(i++, values.length - 1)];
      };
      const a = blueNoiseMask(150, 70, draws(0.1));
      const b = blueNoiseMask(150, 70, draws(0.9));
      expect([...a.values]).not.toEqual([...b.values]);
      expect(histogram(a)).toEqual(histogram(b));
    });

    it('should order cells in work that grows with the cells, whatever the buckets hold', () => {
      // an insertion sort of a rank's bucket is quadratic in it, which is
      // `cells / 2048` for a large rectangle and `cells / 32` for a thin one:
      // 550ms at 1x300000, best of three. No clock, because a deadline flaked on CI
      // (SIG-429): the hash is read through a proxy and the reads are counted. The
      // radix sort reads each hash exactly five times -- once for the histogram of
      // all four digits and once per pass -- however many cells share a rank, and
      // a sort that compares reads them again and again. The count is pinned
      // rather than bounded so that a sort which copies the hash once and then
      // sorts the copy, which reads it `size` times, fails too. What it cannot
      // see is a sort that reads five times and is quadratic anyway: it counts
      // reads through the argument and says nothing of what is done with them
      const size = 100_000;
      const ranks = new Uint16Array(size);
      for (let i = 0; i < size; i++) {
        // thirty-two ranks and so about 3,000 cells in each, the 1x100000 case
        ranks[i] = i % 32;
      }
      const hashes = new Uint32Array(size);
      const random = seeded(2);
      for (let i = 0; i < size; i++) {
        hashes[i] = Math.floor(random() * 0x1_0000_0000);
      }
      let reads = 0;
      const counted = new Proxy(hashes, {
        get(target, key) {
          if (typeof key === 'string' && /^\d+$/.test(key)) {
            reads++;
          }
          return Reflect.get(target, key);
        },
      });
      const order = orderCells(ranks, counted, size);
      expect(reads).toBe(5 * size);
      // and it is the order it says: by rank, then hash, then index
      for (let i = 1; i < size; i++) {
        const [p, q] = [order[i - 1], order[i]];
        const before =
          ranks[p] !== ranks[q]
            ? ranks[p] < ranks[q]
            : hashes[p] !== hashes[q]
              ? hashes[p] < hashes[q]
              : p < q;
        expect(before, `position ${i}`).toBe(true);
      }
    });

    it('should survive a generator that answers out of range', () => {
      // `Math.floor(unit(random()) * size)` is an index into the initial
      // pattern, and the loop that fills it only advances on a cell it has not
      // taken -- so a generator stuck at exactly one would never terminate
      // without the clamp
      for (const random of [() => 1, () => Number.NaN, () => -1]) {
        expect(histogram(blueNoiseMask(7, 3, random))).toEqual(evenRamp(21));
      }
    });
  });
});
