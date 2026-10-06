/**
 * A threshold field over a rectangle of cells, which is what a dissolve, a wipe
 * and an iris all are.
 *
 * One number per cell saying *when* it shows, plus one threshold saying how far
 * through the transition we are. A cell is in when `values[i] <= threshold`, so
 * ramping the threshold from `-1` to `MASK_MAX` reveals the rectangle in the
 * order the field put it, and what makes one transition differ from another is
 * only which generator filled the field.
 *
 * **Generated once, never per frame.** A per-frame random gives exactly the
 * shimmer `distribute()` exists to prevent one layer up: a cell that was in on
 * frame nine and out on frame ten flickers, and the reveal reads as noise rather
 * than as a dissolve. Every generator here is a pure function of its arguments
 * and a `Random`, so a seeded one reproduces.
 *
 * Not a layers feature, which is why it is a module of its own. A mask is a
 * `Uint8Array` and an integer; nothing in it knows what a `CellBuffer` is, and
 * nothing in it imports one.
 */

import { type Random, seeded } from '../util/random.js';

export { type Random, seeded };

/**
 * The largest value a field holds, and the threshold at which everything shows.
 *
 * 256 buckets rather than one value per cell, which is the whole reason the
 * field is a `Uint8Array`: a permutation of 1,920 distinct ranks does not fit in
 * a byte, and nothing wants 1,920 steps of a reveal. What a generator produces
 * is a cell's *position in the ramp*, scaled to the same 0-255 whatever the
 * rectangle's size -- so a caller ramping over thirty frames does the same
 * arithmetic for an 80x24 canvas and for a three-cell one.
 */
export const MASK_MAX = 255;

/**
 * Which cells of a rectangle show, and how far through.
 *
 * The field is `readonly` and the threshold is not, because that is the split
 * the whole design rests on: generated once, ramped every frame.
 */
export interface Mask {
	/** Rows. */
	readonly height: number;
	/**
	 * How far through the reveal. A cell shows when its value is at most this, so
	 * `-1` is nothing and `MASK_MAX` is everything.
	 *
	 * Mutable, and the one thing a frame loop writes. `maskThreshold()` is the
	 * arithmetic that turns a fraction into one without the off-by-one at either
	 * end.
	 */
	threshold: number;
	/** One value per cell, in row order. */
	readonly values: Uint8Array;
	/** Columns. */
	readonly width: number;
}

/**
 * Whether a cell of a mask shows.
 *
 * A coordinate outside the field does not: a mask is a statement about its own
 * rectangle, and a cell it says nothing about is one the mask is not revealing.
 * That is the direction that cannot surprise anybody -- the other reading would
 * make a mask narrower than its layer silently reveal the whole right-hand side.
 *
 * @param mask - The field.
 * @param x - The column, relative to the mask's own top-left.
 * @param y - The row.
 * @returns Whether the cell is in.
 */
export function masked(mask: Mask, x: number, y: number): boolean {
	if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) {
		return false;
	}
	return mask.values[y * mask.width + x] <= mask.threshold;
}

/**
 * The threshold that reveals a given fraction of a mask.
 *
 * Three lines, and it exists because both ends are off by one in a way every
 * caller gets wrong once. A cell shows at `<=`, so the threshold that reveals
 * *nothing* is `-1` rather than `0` -- a field always has cells at zero -- and
 * the one that reveals everything is `MASK_MAX`. `progress` is clamped rather
 * than trusted, which is the rule `unit()` already keeps for a generator's
 * answer: a `NaN` threshold compares false against every value, so a reveal
 * driven by one would show nothing for ever with nothing to say so.
 *
 * @param progress - How far through, `0` for nothing and `1` for all of it.
 * @returns The threshold.
 */
export function maskThreshold(progress: number): number {
	const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
	return Math.round(p * (MASK_MAX + 1)) - 1;
}

/** A rectangle's cell count, with a degenerate size read as empty. */
function area(width: number, height: number): { height: number; size: number; width: number } {
	const w = Math.max(0, Math.trunc(width));
	const h = Math.max(0, Math.trunc(height));
	return { height: h, size: w * h, width: w };
}

/**
 * A rank in `0`-`MASK_MAX`, from a position in `0`-`count - 1`.
 *
 * Scaled by `count` rather than by `count - 1` so that the last cell lands on
 * `MASK_MAX` only when the ramp has actually finished: `floor(i * 256 / n)`
 * spreads `n` cells evenly over the 256 buckets, which is what makes a ramp of
 * the threshold reveal roughly `n / 256` cells a step. Dividing by `n - 1`
 * instead puts the first cell at 0 and the last at 255 and bunches everything in
 * between, which for `n` of two is a transition with one step in it.
 *
 * @param position - Where in the order this cell comes.
 * @param count - How many cells there are.
 * @returns The value.
 */
function rank(position: number, count: number): number {
	return Math.min(MASK_MAX, Math.floor((position * (MASK_MAX + 1)) / Math.max(1, count)));
}

/**
 * A field every cell of which shows at once, which is what no mask means.
 *
 * Useful as the thing a caller reaches for when a layer should be whole: a
 * `Layer` with no mask composites entirely, so this is for the case where the
 * mask has to exist -- a slot in an array of them, a ramp that starts at the end
 * -- and it is cheaper to say than to generate.
 *
 * It is also the hook for a generator of a caller's own, which is why `values`
 * is `readonly` as a *field* rather than as a buffer: the array cannot be
 * swapped, and writing into it is how a field gets filled. Take one of these and
 * `values.set()` whatever a wipe, a spiral or a Bayer matrix comes to -- there is
 * nothing privileged about the four here beyond being the ones with callers.
 *
 * @param width - Columns.
 * @param height - Rows.
 * @returns The mask, at `threshold: MASK_MAX`.
 */
export function openMask(width: number, height: number): Mask {
	const { height: h, size, width: w } = area(width, height);
	return { height: h, threshold: MASK_MAX, values: new Uint8Array(size), width: w };
}

/**
 * A dissolve: every cell at its own moment, in a shuffled order.
 *
 * An even permutation of the ramp, shuffled -- so each step of the threshold
 * takes roughly the same number of cells and no region finishes before another.
 * Fisher-Yates over the ranks rather than a random value per cell, which is the
 * difference between a dissolve and a cloud: independent values clump, so a
 * random field at `threshold` 128 has visible patches still fully hidden while
 * others are gone.
 *
 * What it does *not* have is spatial evenness within a step. The cells revealed
 * between two thresholds are drawn from the whole rectangle uniformly, so at
 * terminal sizes -- where a step is a handful of cells out of two thousand --
 * they land in a visibly random scatter. `blueNoiseMask()` is what fixes that,
 * and costs a generation pass to do it.
 *
 * @param width - Columns.
 * @param height - Rows.
 * @param random - Randomness in `[0, 1)`. Defaults to `Math.random`.
 * @returns The mask, at `threshold: -1`.
 */
export function dissolveMask(width: number, height: number, random: Random = Math.random): Mask {
	const { height: h, size, width: w } = area(width, height);
	const values = new Uint8Array(size);
	const order = new Int32Array(size);
	for (let i = 0; i < size; i++) {
		order[i] = i;
	}
	for (let i = size - 1; i > 0; i--) {
		const j = Math.floor(unit(random()) * (i + 1));
		const swap = order[i];
		order[i] = order[j];
		order[j] = swap;
	}
	for (let i = 0; i < size; i++) {
		values[order[i]] = rank(i, size);
	}
	return { height: h, threshold: -1, values, width: w };
}

/**
 * A fraction, whatever the source answered.
 *
 * The clamp is what makes a generator safe to hand somebody else's `Random`, and
 * the rule is the decrypt component's said again: a value at or above one indexes
 * one past the end of the shuffle, which swaps a cell with `undefined` and leaves
 * a hole in the permutation, and a `NaN` does the same by way of
 * `Math.floor(NaN)`. Read as zero rather than propagated, for the same reason --
 * every comparison against `NaN` is false, so nothing downstream would say so.
 *
 * @param value - Whatever the generator answered.
 * @returns A fraction in `[0, 1)`.
 */
function unit(value: number): number {
	if (!Number.isFinite(value)) {
		return 0;
	}
	// strictly below one: this is an index multiplier, and 1 is one past the end
	return Math.min(0.999_999_999_9, Math.max(0, value));
}

/** Which edge a wipe starts from. */
export type WipeDirection = 'down' | 'left' | 'right' | 'up';

/**
 * A wipe: a hard edge travelling across the rectangle.
 *
 * The same field with the position along one axis in place of a shuffle, which
 * is the thing that makes masks worth having as their own module rather than as
 * a dissolve helper on a layer. Every cell of a column (or a row) shares a value,
 * so the edge is a straight line and the reveal is a sweep.
 *
 * @param width - Columns.
 * @param height - Rows.
 * @param direction - Which edge it starts from. `'right'` means it travels
 *   rightwards, so the left-hand column goes first.
 * @returns The mask, at `threshold: -1`.
 */
export function wipeMask(width: number, height: number, direction: WipeDirection = 'right'): Mask {
	const { height: h, size, width: w } = area(width, height);
	const values = new Uint8Array(size);
	const horizontal = direction === 'left' || direction === 'right';
	const extent = horizontal ? w : h;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const along = horizontal ? x : y;
			const position = direction === 'left' || direction === 'up' ? extent - 1 - along : along;
			values[y * w + x] = rank(position, extent);
		}
	}
	return { height: h, threshold: -1, values, width: w };
}

export interface IrisOptions {
	/**
	 * How many rows a column is worth, for the distance that decides the shape.
	 *
	 * A terminal cell is about twice as tall as it is wide, so a field built on
	 * raw cell distance draws an ellipse twice as tall as it is round. Two is the
	 * usual ratio and is what makes a circle look like one; a caller whose font
	 * says otherwise says so.
	 */
	aspect?: number;
	/** The column it opens from. The middle, if omitted. */
	x?: number;
	/** The row it opens from. The middle, if omitted. */
	y?: number;
}

/**
 * An iris: a circle opening out from a point.
 *
 * Distance from the centre, scaled so the farthest corner lands on `MASK_MAX` --
 * which is what makes the reveal finish exactly when the threshold does, for a
 * centre anywhere in the rectangle rather than only the middle.
 *
 * @param width - Columns.
 * @param height - Rows.
 * @param opts - The centre and the cell aspect.
 * @returns The mask, at `threshold: -1`.
 */
export function irisMask(width: number, height: number, opts: IrisOptions = {}): Mask {
	const { height: h, size, width: w } = area(width, height);
	const values = new Uint8Array(size);
	const aspect = opts.aspect !== undefined && Number.isFinite(opts.aspect) ? opts.aspect : 2;
	const cx = opts.x !== undefined && Number.isFinite(opts.x) ? opts.x : (w - 1) / 2;
	const cy = opts.y !== undefined && Number.isFinite(opts.y) ? opts.y : (h - 1) / 2;

	// the farthest corner, which is what the ramp is normalized by
	let longest = 0;
	for (const [x, y] of [
		[0, 0],
		[w - 1, 0],
		[0, h - 1],
		[w - 1, h - 1],
	]) {
		longest = Math.max(longest, Math.hypot(x - cx, (y - cy) * aspect));
	}

	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			const distance = Math.hypot(x - cx, (y - cy) * aspect);
			// scaled by the longest rather than ranked by position, because what
			// decides an iris is *how far* a cell is rather than how many cells are
			// nearer: ranking would reveal a constant number of cells per step, which
			// makes the circle crawl at the start and race at the end
			const at = longest === 0 ? 0 : distance / longest;
			values[y * w + x] = Math.min(MASK_MAX, Math.round(at * MASK_MAX));
		}
	}
	return { height: h, threshold: -1, values, width: w };
}

/**
 * How far a cell's energy reaches, in cells.
 *
 * Ulichney's 1.5, which is what the published algorithm uses and what the
 * published results were measured at. It is the one number in here worth leaving
 * alone: it trades the evenness of the field against how local the decision is,
 * and a larger sigma over a terminal-sized rectangle starts to see the whole
 * grid at once.
 */
const SIGMA = 1.5;

/** Where the splat is cut off, past which `exp()` of it is not worth adding. */
const REACH = Math.ceil(SIGMA * 3);

/**
 * A dissolve whose every step is spatially even: blue noise.
 *
 * Void-and-cluster (Ulichney 1993). The field is built by repeatedly asking
 * which set cell is in the tightest cluster and which unset cell sits in the
 * largest void, and ranking them from the outside in -- so any prefix of the
 * ranking is a set of cells spread as evenly over the rectangle as that many
 * cells can be. Which is the whole difference from `dissolveMask()`: there a
 * step's cells are uniform over the rectangle *independently*, so they clump by
 * chance; here they cannot, because a cell that would clump is exactly the one
 * the algorithm ranks last.
 *
 * It costs a generation pass -- `O(cells^2)` on the energy walk, measured over
 * three runs at **8.34 / 8.40 / 8.71ms** for 80x24 and **1.10 / 1.13 / 1.15ms**
 * for 40x12, against `dissolveMask()`'s 0.25ms for the same 80x24 -- and it is
 * generated **once**. A transition that ramps for thirty frames pays it on the
 * frame the transition starts, against a frame already measured at 0.10ms. So it
 * is a frame that takes eighty-odd times as long as the ones after it, which for
 * a full-screen dissolve is a visible hitch at the moment the transition begins:
 * build the mask before the transition starts, or reach for `dissolveMask()`,
 * which is `O(cells)`. That is the whole of the trade, and it is why both ship
 * rather than one.
 *
 * @param width - Columns.
 * @param height - Rows.
 * @param random - Randomness in `[0, 1)`, for the initial pattern. Defaults to
 *   `Math.random`.
 * @returns The mask, at `threshold: -1`.
 */
export function blueNoiseMask(width: number, height: number, random: Random = Math.random): Mask {
	const { height: h, size, width: w } = area(width, height);
	const values = new Uint8Array(size);
	if (size === 0) {
		return { height: h, threshold: -1, values, width: w };
	}

	const field = new VoidAndCluster(w, h);
	const order = field.rankAll(random);
	for (let position = 0; position < size; position++) {
		values[order[position]] = rank(position, size);
	}
	return { height: h, threshold: -1, values, width: w };
}

/**
 * The void-and-cluster machinery, which is an energy map and four phases over
 * it.
 *
 * A class rather than four functions sharing five arrays, because every phase
 * reads and writes the same two: the binary pattern and the energy it induces.
 * Energy is maintained incrementally -- a cell being set adds a Gaussian splat
 * and a cell being cleared subtracts the same one -- so a phase is `O(cells)`
 * per rank rather than `O(cells)` per *query*.
 *
 * Toroidal, as the published algorithm is. A terminal rectangle has edges and a
 * torus does not, so wrapping is a choice: it is taken because the alternative
 * is a field whose cells near an edge have less energy around them and are
 * therefore preferred, which puts a visible bias along all four sides of the
 * reveal.
 */
class VoidAndCluster {
	/** The binary pattern: 1 where a cell is set. */
	#pattern: Uint8Array;
	/** The energy each cell sees from the set cells around it. */
	#energy: Float64Array;
	/** `exp(-d^2 / 2 sigma^2)` for each offset within `REACH`. */
	#splat: Float64Array;
	#width: number;
	#height: number;
	#size: number;
	#span: number;

	constructor(width: number, height: number) {
		this.#width = width;
		this.#height = height;
		this.#size = width * height;
		this.#pattern = new Uint8Array(this.#size);
		this.#energy = new Float64Array(this.#size);

		this.#span = REACH * 2 + 1;
		this.#splat = new Float64Array(this.#span * this.#span);
		for (let dy = -REACH; dy <= REACH; dy++) {
			for (let dx = -REACH; dx <= REACH; dx++) {
				this.#splat[(dy + REACH) * this.#span + (dx + REACH)] = Math.exp(
					-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA)
				);
			}
		}
	}

	/** Adds or removes a cell's own contribution to everything around it. */
	#stamp(index: number, sign: number): void {
		const x = index % this.#width;
		const y = Math.trunc(index / this.#width);
		for (let dy = -REACH; dy <= REACH; dy++) {
			// wrapped rather than clipped, which is what keeps the edges unbiased
			const row = (((y + dy) % this.#height) + this.#height) % this.#height;
			for (let dx = -REACH; dx <= REACH; dx++) {
				const column = (((x + dx) % this.#width) + this.#width) % this.#width;
				this.#energy[row * this.#width + column] +=
					sign * this.#splat[(dy + REACH) * this.#span + (dx + REACH)];
			}
		}
	}

	#set(index: number): void {
		this.#pattern[index] = 1;
		this.#stamp(index, 1);
	}

	#unset(index: number): void {
		this.#pattern[index] = 0;
		this.#stamp(index, -1);
	}

	/**
	 * The set cell with the most energy around it: the tightest cluster.
	 *
	 * @param want - Which pattern value to look among, so phase three can ask the
	 *   same question of the complement.
	 * @returns The index, or `-1` when there is no such cell.
	 */
	#tightest(want: number): number {
		let best = -1;
		let bestEnergy = -Infinity;
		for (let i = 0; i < this.#size; i++) {
			if (this.#pattern[i] === want && this.#energy[i] > bestEnergy) {
				bestEnergy = this.#energy[i];
				best = i;
			}
		}
		return best;
	}

	/** The unset cell with the least energy around it: the largest void. */
	#largest(want: number): number {
		let best = -1;
		let bestEnergy = Infinity;
		for (let i = 0; i < this.#size; i++) {
			if (this.#pattern[i] === want && this.#energy[i] < bestEnergy) {
				bestEnergy = this.#energy[i];
				best = i;
			}
		}
		return best;
	}

	/**
	 * Every cell, in the order the algorithm reveals them.
	 *
	 * @param random - For the initial pattern.
	 * @returns The cell indices, best-spread first.
	 */
	rankAll(random: Random): Int32Array {
		const order = new Int32Array(this.#size);

		// a tenth of the cells, which is Ulichney's suggestion and is the smallest
		// fraction that still has clusters and voids to find. At least one, or the
		// phases below have nothing to work with and a 3x3 rectangle would come
		// back unranked
		const ones = Math.max(1, Math.min(this.#size, Math.round(this.#size / 10)));

		// a partial Fisher-Yates rather than rejection sampling, and that is a hang
		// rather than a preference. "Pick a cell, set it if it is free, try again"
		// terminates only for a generator that eventually answers something else:
		// a stuck one -- `() => 1`, which the clamp turns into the last index, or
		// `() => NaN`, which it reads as the first -- hands back the same cell for
		// ever and the second `ones` never lands. Found by the test written to
		// assert the clamp, which hung instead of failing. A shuffle takes `ones`
		// steps whatever the source answers
		const indices = new Int32Array(this.#size);
		for (let i = 0; i < this.#size; i++) {
			indices[i] = i;
		}
		for (let i = 0; i < ones; i++) {
			const j = i + Math.floor(unit(random()) * (this.#size - i));
			const swap = indices[i];
			indices[i] = indices[j];
			indices[j] = swap;
			this.#set(indices[i]);
		}

		// phase zero: make the initial pattern even, by moving the tightest cluster
		// into the largest void until there is no void emptier than where the
		// cluster was
		for (;;) {
			const cluster = this.#tightest(1);
			if (cluster < 0) {
				break;
			}
			this.#unset(cluster);
			// read after the removal, so both sides of the comparison below are
			// energies the same arrangement induces
			const was = this.#energy[cluster];
			const voidAt = this.#largest(0);
			// a *strict* improvement, which is what makes this terminate rather than
			// what makes it tidy. Stopping only at `voidAt === cluster` lets two
			// equal-energy cells swap back and forth for ever, and exact ties are
			// not exotic -- a symmetric arrangement on a small rectangle produces
			// them.
			//
			// What strictly decreases is the **pairwise** energy -- the sum of
			// `w(distance)` over pairs of set cells -- and not the sum of
			// `#energy`, which on a torus is the same whatever the arrangement,
			// since every cell's splat carries the same mass wherever it sits. A
			// review round caught that distinction in the first wording of this
			// comment, and it is the one that carries the argument: moving a cell
			// from `cluster`, whose energy over the others is `was`, to a `voidAt`
			// whose energy over the others is strictly lower changes the pairwise
			// sum by exactly the difference. Arrangements are finite, so a
			// strictly-decreasing walk over them cannot cycle
			if (voidAt < 0 || this.#energy[voidAt] >= was) {
				this.#set(cluster);
				break;
			}
			this.#set(voidAt);
		}

		const prototype = this.#pattern.slice();

		// phase one: rank the prototype's own cells, outwards in -- the cell in the
		// tightest cluster is the one that matters least, so it goes last of these
		for (let r = ones - 1; r >= 0; r--) {
			const cluster = this.#tightest(1);
			if (cluster < 0) {
				break;
			}
			this.#unset(cluster);
			order[r] = cluster;
		}

		// phase two: put the prototype back, then fill the largest void each time
		// until half the rectangle is set
		this.#pattern.fill(0);
		this.#energy.fill(0);
		for (let i = 0; i < this.#size; i++) {
			if (prototype[i]) {
				this.#set(i);
			}
		}
		const half = Math.trunc(this.#size / 2);

		// one cursor across both of the phases below rather than a range each. They
		// are written as two loops because they ask two different questions, and
		// `half` is not reliably above `ones` -- for a one-cell rectangle it is
		// below it, and a phase three that started at its own `half` would overwrite
		// what phase one had already ranked. Sharing the cursor also means a phase
		// that gives up early is continued from rather than skipped over, which is
		// the difference between a short order and one with a duplicate in it
		let r = ones;
		for (; r < half; r++) {
			const voidAt = this.#largest(0);
			if (voidAt < 0) {
				break;
			}
			this.#set(voidAt);
			order[r] = voidAt;
		}

		// phase three: the same question asked of the holes. Past halfway the
		// pattern's *zeros* are the sparse thing, so the energy map is rebuilt over
		// them and the tightest cluster of zeros is the next cell to reveal
		this.#energy.fill(0);
		for (let i = 0; i < this.#size; i++) {
			if (this.#pattern[i] === 0) {
				this.#stamp(i, 1);
			}
		}
		for (; r < this.#size; r++) {
			const cluster = this.#tightest(0);
			if (cluster < 0) {
				break;
			}
			// setting it in the pattern is removing it from the complement, so the
			// energy it contributed comes off
			this.#pattern[cluster] = 1;
			this.#stamp(cluster, -1);
			order[r] = cluster;
		}

		return order;
	}
}
