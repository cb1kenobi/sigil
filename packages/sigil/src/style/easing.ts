/**
 * Timing functions: what a fraction of the way through becomes.
 *
 * A timing function is a pure map from `[0, 1]` to a number, and it is the one
 * piece of the animation machinery that is worth testing on its own -- no clock,
 * no element, no frame. `steps()` is here for the reason the whole feature is:
 * a terminal animation that cycles through a handful of states is a step
 * function, and writing one by hand is a `setInterval`.
 *
 * ```js
 * import { ease, parseEasing } from '@ttylabs/sigil/style';
 *
 * ease(parseEasing('steps(4, end)'), 0.5); // 0.5
 * ease(parseEasing('ease-out'), 0.5);      // 0.685...
 * ```
 */

import { parseCount, StyleError } from './value.js';

/** Where a step function jumps, in CSS Easing 1's vocabulary. */
export type StepPosition = 'jump-both' | 'jump-end' | 'jump-none' | 'jump-start';

/**
 * A timing function.
 *
 * Three kinds rather than one function, because a descriptor compares and prints
 * and a closure does neither -- `difference()` asks whether two resolved styles
 * disagree about a property, and two closures built from one source string are
 * never equal. Frozen and interned by source for the same reason, which is why
 * that comparison needs no branch for this type at all.
 */
export type Easing =
	| {
			readonly kind: 'cubic';
			readonly points: readonly [number, number, number, number];
			readonly source: string;
	  }
	| { readonly kind: 'linear'; readonly source: string }
	| {
			readonly kind: 'steps';
			readonly count: number;
			readonly position: StepPosition;
			readonly source: string;
	  };

/**
 * The named curves, which are the cubic-beziers CSS defines them as.
 *
 * Written out rather than resolved through `cubic-bezier()` at parse time so
 * that the source a style reports back is the name that was written: `ease-out`
 * is what the author said, and `cubic-bezier(0, 0, 0.58, 1)` is a worse answer
 * to "what does this style say" even though it is the same curve.
 */
const NAMED: Record<string, readonly [number, number, number, number]> = {
	__proto__: null,
	ease: [0.25, 0.1, 0.25, 1],
	'ease-in': [0.42, 0, 1, 1],
	'ease-in-out': [0.42, 0, 0.58, 1],
	'ease-out': [0, 0, 0.58, 1],
} as unknown as Record<string, readonly [number, number, number, number]>;

/** The step positions, with CSS's two older spellings mapped onto the `jump-` ones. */
const POSITIONS: Record<string, StepPosition> = {
	__proto__: null,
	end: 'jump-end',
	'jump-both': 'jump-both',
	'jump-end': 'jump-end',
	'jump-none': 'jump-none',
	'jump-start': 'jump-start',
	start: 'jump-start',
} as unknown as Record<string, StepPosition>;

/**
 * Every easing ever parsed, by what it *is* rather than by what it was written
 * as.
 *
 * Interned so that two rules writing `ease-out` resolve to the same object and
 * `difference()` answers with `===`. The alternative was a second comparison
 * branch in `difference()` for an object shape it does not otherwise know
 * about, which is a list to keep in agreement with this file.
 *
 * Keyed on the **canonical** shape and not on the source, which is the half that
 * is easy to get wrong: `steps(4, end)` and `steps(4,end)` are one timing
 * function written two ways, and interning by source made them two objects --
 * so a sheet that wrote one and a theme that wrote the other reported a changed
 * property, and the frame that followed repainted to draw exactly what was
 * already on screen. `source` is then the first spelling that produced the
 * entry, which is arbitrary between two spellings of one thing and is still
 * something somebody wrote; `cubic-bezier(0, 0, 0.58, 1)` and `ease-out` stay
 * separate, because those are different entries in the table of names rather
 * than two spellings of one entry.
 *
 * Unbounded, for the reason the degrader's memo is: what reaches it is a
 * *declared* timing function, of which an app has a few.
 */
const INTERNED = new Map<string, Easing>();

/** What a parsed easing is, with the spelling taken out of it. */
function canonical(easing: Easing): string {
	switch (easing.kind) {
		case 'linear':
			return 'linear';
		case 'steps':
			return `steps:${String(easing.count)}:${easing.position}`;
		default:
			// the name, so that `ease-out` and the bezier it stands for stay apart:
			// what a style reports back should be what the author wrote, and the two
			// are different things to have written
			return `cubic:${easing.source}`;
	}
}

function intern(easing: Easing): Easing {
	const key = canonical(easing);
	const already = INTERNED.get(key);
	if (already) {
		return already;
	}
	const frozen = Object.freeze(easing);
	INTERNED.set(key, frozen);
	BY_SOURCE.set(easing.source, frozen);
	return frozen;
}

/** The same entries by source, so that a repeated declaration skips the parse. */
const BY_SOURCE = new Map<string, Easing>();

// declared after both maps, because `intern()` writes to them and a `const`
// further down the file is in its temporal dead zone at load -- which is the
// same dead import the debug logger's `metaRE` carries an entry about, met here
// by an eager initializer rather than by an eager call
/** The initial value of both timing-function properties, and the identity map. */
export const LINEAR: Easing = intern({ kind: 'linear', source: 'linear' });

const STEPS = /^steps\(\s*([^,)]+?)\s*(?:,\s*([a-z-]+)\s*)?\)$/i;
const CUBIC = /^cubic-bezier\(([^)]*)\)$/i;

/**
 * Reads a timing function.
 *
 * @param input - The source text.
 * @returns The easing, interned.
 */
export function parseEasing(input: string): Easing {
	const text = input.trim().toLowerCase();

	const already = BY_SOURCE.get(text);
	if (already) {
		return already;
	}

	if (text === 'linear') {
		return LINEAR;
	}

	// `step-start` and `step-end` are CSS's names for the two one-step functions,
	// and they are spelled out rather than rewritten into `steps(1, ...)` for the
	// reason the named curves are: what comes back should be what was written
	if (text === 'step-start' || text === 'step-end') {
		return intern({
			count: 1,
			kind: 'steps',
			position: text === 'step-start' ? 'jump-start' : 'jump-end',
			source: text,
		});
	}

	if (Object.hasOwn(NAMED, text)) {
		return intern({ kind: 'cubic', points: NAMED[text], source: text });
	}

	const steps = STEPS.exec(text);
	if (steps) {
		const count = parseCount(steps[1], 'steps() count');
		const name = steps[2] ?? 'jump-end';
		if (!Object.hasOwn(POSITIONS, name)) {
			throw new StyleError(
				`Invalid steps() position "${name}": expected start, end, jump-start, jump-end, jump-none or jump-both`
			);
		}
		const position = POSITIONS[name];
		// one step and `jump-none` is a function with no jumps at all, which CSS
		// refuses and which would be a division by zero here -- the one place the
		// count and the position are not independent
		const jumps = jumpsFor(count, position);
		if (jumps <= 0) {
			throw new StyleError(
				`Invalid steps(${String(count)}, ${position}): that is a timing function with nothing to step to`
			);
		}
		return intern({ count, kind: 'steps', position, source: text });
	}

	const cubic = CUBIC.exec(text);
	if (cubic) {
		const numbers = cubic[1].split(',').map((part) => Number(part.trim()));
		if (numbers.length !== 4 || numbers.some((n) => !Number.isFinite(n))) {
			throw new StyleError(`Invalid cubic-bezier "${input}": expected four numbers`);
		}
		// the control points' x coordinates have to stay in [0, 1] or the curve is
		// not a function of time: CSS says so, and a curve that doubles back has no
		// single answer for "where are we at t"
		if (numbers[0] < 0 || numbers[0] > 1 || numbers[2] < 0 || numbers[2] > 1) {
			throw new StyleError(
				`Invalid cubic-bezier "${input}": the first and third numbers are x coordinates and must be 0-1`
			);
		}
		// and the y coordinates are held to the same range here, which CSS does
		// **not** do. An overshoot curve is the point of letting y leave [0, 1] on
		// the web; here every geometry property is whole cells and has a grammar of
		// its own -- a padding is a count and a gap cannot be negative -- so an
		// overshoot resolves to a value no declaration could have written, and
		// nothing on the property table says where to clamp it back to. What it
		// would buy at whole-cell quantization is one cell of spring on a ten-cell
		// box, which is not worth a value the property itself refuses
		if (numbers[1] < 0 || numbers[1] > 1 || numbers[3] < 0 || numbers[3] > 1) {
			throw new StyleError(
				`Invalid cubic-bezier "${input}": an overshoot is refused here -- the y coordinates must be 0-1, because a value outside the range a property accepts is not one a declaration could have written`
			);
		}
		return intern({
			kind: 'cubic',
			points: Object.freeze([numbers[0], numbers[1], numbers[2], numbers[3]]) as readonly [
				number,
				number,
				number,
				number,
			],
			source: text,
		});
	}

	throw new StyleError(
		`Invalid timing function "${input}": expected linear, ease, ease-in, ease-out, ease-in-out, step-start, step-end, steps(...) or cubic-bezier(...)`
	);
}

/** How many jumps a step function has, which is also what its output divides by. */
function jumpsFor(count: number, position: StepPosition): number {
	switch (position) {
		case 'jump-none':
			return count - 1;
		case 'jump-both':
			return count + 1;
		default:
			return count;
	}
}

/**
 * The fraction a timing function turns a fraction into.
 *
 * Output may leave `[0, 1]` for a cubic-bezier whose y coordinates do -- that is
 * what an overshoot curve is, and clamping it here would make `cubic-bezier`
 * accept a value it then quietly ignored. What *is* clamped is the input, since
 * a fraction outside the iteration is not a thing this answers for.
 *
 * @param easing - The timing function.
 * @param fraction - How far through, 0 to 1.
 * @returns The eased fraction.
 */
export function ease(easing: Easing, fraction: number): number {
	const t = fraction <= 0 ? 0 : fraction >= 1 ? 1 : fraction;

	switch (easing.kind) {
		case 'linear':
			return t;
		case 'steps': {
			const jumps = jumpsFor(easing.count, easing.position);
			let step = Math.floor(t * easing.count);
			if (easing.position === 'jump-start' || easing.position === 'jump-both') {
				step += 1;
			}
			// the clamp CSS specifies, and it is what makes the last step land on 1
			// rather than past it: `floor(1 * n)` is `n`, which for `jump-both` is one
			// more than the function has jumps
			if (step > jumps) {
				step = jumps;
			}
			if (step < 0) {
				step = 0;
			}
			return step / jumps;
		}
		default:
			return solveCubic(easing.points, t);
	}
}

/**
 * Where a cubic-bezier is at a given x.
 *
 * Newton-Raphson with a bisection fallback, which is what every browser does:
 * the curve is parametric, so finding y at a given x means solving for the
 * parameter first, and Newton alone wanders off where the derivative is near
 * zero -- which is exactly what `ease-in`'s `(0.42, 0, 1, 1)` has at its end.
 */
function solveCubic(points: readonly [number, number, number, number], x: number): number {
	const [x1, y1, x2, y2] = points;

	// a curve whose x coordinates are the identity is its own answer, which is
	// both the common case for the named curves' endpoints and a cheap exit
	if (x <= 0 || x >= 1) {
		return x;
	}

	let t = x;
	for (let i = 0; i < 8; i++) {
		const error = bezier(t, x1, x2) - x;
		if (Math.abs(error) < 1e-7) {
			return bezier(t, y1, y2);
		}
		const slope = bezierSlope(t, x1, x2);
		if (Math.abs(slope) < 1e-7) {
			break;
		}
		t -= error / slope;
	}

	let low = 0;
	let high = 1;
	t = x;
	for (let i = 0; i < 32; i++) {
		const at = bezier(t, x1, x2);
		if (Math.abs(at - x) < 1e-7) {
			break;
		}
		if (at < x) {
			low = t;
		} else {
			high = t;
		}
		t = (low + high) / 2;
	}

	return bezier(t, y1, y2);
}

/** One axis of a cubic bezier whose first and last control points are 0 and 1. */
function bezier(t: number, a: number, b: number): number {
	const c = 3 * a;
	const d = 3 * (b - a) - c;
	const e = 1 - c - d;
	return ((e * t + d) * t + c) * t;
}

/** Its derivative, for Newton-Raphson. */
function bezierSlope(t: number, a: number, b: number): number {
	const c = 3 * a;
	const d = 3 * (b - a) - c;
	const e = 1 - c - d;
	return (3 * e * t + 2 * d) * t + c;
}
