/**
 * The two readings of a number a caller handed in, written once.
 *
 * Internal: neither is re-exported by the barrel, because a second spelling of
 * "is this a count" beside the runtime's own would be API nobody asked for. What
 * they are here for is that these helpers are reached from **untyped**
 * JavaScript as readily as from TypeScript -- a test file is where somebody
 * writes `columns: process.stdout.columns`, which is `undefined` under a runner
 * -- and the two failures this file refuses are both ones AGENTS.md already
 * records from the other side.
 */

/** The largest delay node stores, which is a signed 32-bit integer. */
const MAX_DELAY = 2_147_483_647;

/**
 * A whole number of cells, at least one, or an error naming what was passed.
 *
 * Refused rather than defaulted, because a size is the caller's whole statement
 * about the screen and silently using 80 instead hides the mistake. `NaN` is the
 * one that has to be refused by *asking* rather than by comparing: every
 * comparison against it is false, so `Math.max(1, NaN)` is `NaN` -- and a
 * `Screen(NaN, 8)` builds no rows, places a cluster into an array that grows
 * under it, and reports a column nothing is at. A fraction is refused rather
 * than floored, which is the rule a fractional length already follows: rounding
 * silently is how something ends up a column out with nobody able to say which
 * value did it.
 *
 * @param value - What was passed.
 * @param name - What to call it in the message.
 * @returns The number.
 * @throws If it is not a whole number of at least one.
 */
export function cells(value: number, name: string): number {
	// `isSafeInteger` rather than `isInteger`, which is the rule the parser's own
	// `int` type already records: `Number.isInteger(1e20)` is true, and a screen
	// of 1e20 columns is an allocation nothing survives. Found by review
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a whole number of cells, at least 1, not ${String(value)}`);
	}
	return value;
}

/**
 * A delay `setTimeout` will really wait for, or the default.
 *
 * Falls back rather than refusing, which is the rule every other timer option in
 * this library follows -- and it is two rules rather than one. A value that is
 * not a finite number of at least one millisecond is not an instruction, so the
 * default stands: `Infinity >= 0` is true, which is how "wait for ever" came to mean
 * "fire at once" elsewhere here. And a **finite** one past 2^31-1 is *clamped*
 * rather than thrown away, because node stores a delay as a signed 32-bit
 * integer and reads anything larger as `1` -- so a timeout of 24 days asked for
 * the longest wait there is and got a millisecond. Clamping gives the nearest
 * answer there is, where the default would be shorter than what was asked for.
 *
 * @param value - What was passed.
 * @param fallback - The default.
 * @returns A delay in milliseconds.
 */
export function delay(value: number | undefined, fallback: number): number {
	// `< 1` rather than `< 0`: a watchdog of zero is not a watchdog, because
	// `setTimeout(fn, 0)` fires on the next tick and kills the child before it has
	// written anything -- so `timeout: 0` read as "no wait" and did the opposite.
	// There is deliberately no way to turn the watchdog off: a fixture that can
	// hang a suite for ever is the thing it exists for. Found by review
	if (value === undefined || !Number.isFinite(value) || value < 1) {
		return fallback;
	}
	return Math.min(value, MAX_DELAY);
}
