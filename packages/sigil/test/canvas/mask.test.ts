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
import { describe, expect, it } from 'vitest';

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
			const centre = 4 * 9 + 4;
			// two cells right of centre against one cell below it: the same distance
			// on screen, so the same value
			expect(mask.values[centre + 2]).toBe(mask.values[centre + 9]);
			// and at an aspect of one they part, which is what says the option is read
			const square = irisMask(9, 9, { aspect: 1 });
			expect(square.values[centre + 2]).not.toBe(square.values[centre + 9]);
		});

		it('should finish exactly when the threshold does, from any centre', () => {
			// the farthest corner is what the ramp is normalized by, and the maximum
			// of a Euclidean distance over a rectangle is at a corner whether or not
			// the centre is inside it -- so the two outside centres are the cases
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
			// half the ramp a centred iris has nothing like half the cells -- where a
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
			// out from the centre column and every cell of a column shares a value
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
			// is 0.813 for blue noise against 4.250 for the shuffle, so the
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
