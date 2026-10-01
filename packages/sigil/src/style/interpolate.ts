/**
 * What a property's value is part way between two of itself.
 *
 * Pure, and tested with no clock and no element, the way the easing functions
 * are. Everything about *when* a value is part way through is `animate.ts`'s;
 * this answers only what the value is.
 *
 * ```js
 * import { interpolate } from '@ttylabs/sigil/style';
 *
 * interpolate('width', cells(10), cells(20), 0.5, 3);  // cells(15)
 * interpolate('bold', false, true, 0.4, 3);            // false -- discrete
 * ```
 *
 * **Geometry interpolates in whole cells**, which is the constraint the whole
 * feature is shaped around: a box going from 10 to 20 columns has ten visible
 * states however long it takes, and the timing function decides which frames
 * land on which integer. That is why `animate.ts` can skip a frame where
 * nothing quantizes differently -- the quantization is here, so the question
 * "did anything change" has an answer that is cheap and exact.
 */

import type { ColorLevel } from '../ansi/color-support.js';
import type { Color } from '../canvas/style.js';
import { degradeColor, mixColors } from './degrade.js';
import { INTERPOLATION, type PropertyName } from './properties.js';
import { cells, type Length, percent } from './value.js';

/**
 * The value a property holds part way from one of its values to another.
 *
 * The level matters because degradation happens at resolve time, so what the
 * cascade handed over is already degraded and the canvas only ever sees colours
 * the terminal can emit. A mix of two level-2 colours is an off-cube colour that
 * nothing would degrade again, so it is degraded here -- otherwise an animation
 * is the one path that emits truecolor on a 256-colour terminal.
 *
 * @param property - Which property, which decides how it interpolates.
 * @param from - The value at 0.
 * @param to - The value at 1.
 * @param t - How far through, after the timing function. 0 to 1.
 * @param level - How much colour the destination can render.
 * @returns The value.
 */
export function interpolate(
	property: PropertyName,
	from: unknown,
	to: unknown,
	t: number,
	level: ColorLevel
): unknown {
	switch (INTERPOLATION.get(property)) {
		case 'color':
			return mixColor(from as Color, to as Color, t, level);
		case 'integer':
			return Math.round(mix(from as number, to as number, t));
		case 'length':
			return mixLength(from as Length, to as Length, t);
		case 'number':
			return mix(from as number, to as number, t);
		default:
			// `discrete` and `none` alike. CSS flips a non-interpolable property at
			// the midpoint, and a property that does not animate at all should never
			// have been asked -- answering with the endpoint rather than throwing,
			// because a `transition-property` naming one is refused where it is
			// written and a throw here would be a second guard over the same thing
			return discrete(from, to, t);
	}
}

/** The midpoint rule, which is what CSS does with anything it cannot interpolate. */
function discrete(from: unknown, to: unknown, t: number): unknown {
	return t < 0.5 ? from : to;
}

function mix(from: number, to: number, t: number): number {
	return from + (to - from) * t;
}

/**
 * Two lengths, where they are the same kind of length.
 *
 * `auto` to `cells(10)` is not a mix anybody can compute -- `auto` is a question
 * rather than a number, and what it resolves to is the layout engine's and is
 * not known here -- so it snaps, which is CSS. `cells` to `percent` is the same
 * problem one step along: the percentage resolves against a containing block
 * this function has never seen.
 *
 * Cells are **rounded** rather than truncated, which is the one place this
 * differs from `cells()`'s own rule. Truncating biases every frame of an
 * animation downwards and makes the last frame before the end a whole cell
 * short, where rounding puts the crossings at the halfway points and reaches the
 * end exactly. The declaration's own rule -- a fractional length is refused
 * rather than rounded -- is about a value somebody *wrote*, and nobody wrote
 * this one.
 */
function mixLength(from: Length, to: Length, t: number): Length {
	if (from.type !== to.type) {
		return discrete(from, to, t) as Length;
	}
	if (from.type === 'cells' && to.type === 'cells') {
		return cells(Math.round(mix(from.value, to.value, t)));
	}
	if (from.type === 'percent' && to.type === 'percent') {
		return percent(mix(from.value, to.value, t));
	}
	// `auto` to `auto` and `none` to `none`: the same value either way, and the
	// frozen one rather than a new object, so `difference()` answers with `===`
	return from;
}

/**
 * Two colours, degraded to what the destination can render.
 *
 * A mix of colours that cannot be mixed snaps at the midpoint, which is
 * `mixColors()`'s `undefined` honoured rather than worked around: a palette
 * index is the user's own colour and there is no path between two of them that
 * is not invented.
 */
function mixColor(from: Color, to: Color, t: number, level: ColorLevel): Color {
	const mixed = mixColors(from, to, t);
	if (mixed === undefined) {
		return discrete(from, to, t) as Color;
	}
	return degradeColor(mixed, level);
}
