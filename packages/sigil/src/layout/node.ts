import type { Length, Style } from '../style/index.js';

/**
 * What the layout engine needs from a node, and nothing more.
 *
 * Deliberately not the element tree (M2-66). Layout is the one layer in the
 * whole stack that can be tested with no terminal, no renderer, and no
 * reactivity -- lay out a tree, render it to a grid of characters, and read the
 * result as a picture -- and it keeps that property only if it does not know
 * what an element is. The element tree will satisfy this interface; so will a
 * literal in a test.
 */
export interface LayoutNode {
	children?: LayoutNode[];
	/**
	 * Measures content that is not laid out from children -- text, almost always.
	 *
	 * Called with the width available, because wrapping makes height a function
	 * of width. Called at most a handful of times per node per pass, and the
	 * caller is expected to cache: measuring is the most repeated expensive
	 * operation in the stack.
	 */
	measure?: (availableWidth: number) => Measurement;
	style: Style;
}

export interface Measurement {
	height: number;
	/** The widest the content can be, wrapping only where it must. */
	width: number;
	/**
	 * The narrowest the content can be without overflowing -- the longest word,
	 * for text. Flexbox needs both: `min-content` is the floor a shrinking item
	 * cannot go below, and `max-content` is what it asks for.
	 */
	minWidth?: number;
	/**
	 * The shortest the content can be without losing any of itself.
	 *
	 * The column-axis twin of `minWidth`, and it has to exist for the same reason:
	 * CSS's automatic minimum size applies to whichever axis is the main one, so a
	 * column of text with no room was being crushed to a single row while the same
	 * text in a row was correctly protected from shrinking past its longest word.
	 */
	minHeight?: number;
}

/** Where a node ended up, in cells, relative to the canvas origin. */
export interface Box {
	height: number;
	width: number;
	x: number;
	y: number;
}

/** A laid-out node: the box, the content area inside it, and its children. */
export interface LayoutResult {
	/** The area inside padding and border, which is where children were placed. */
	content: Box;
	/** The border box, which is what `overflow` clips and what paint fills. */
	box: Box;
	children: LayoutResult[];
	node: LayoutNode;
}

/** How many cells a border takes on each edge. Always one, or none. */
export function borderWidth(style: Style): number {
	return style.borderStyle === 'none' ? 0 : 1;
}

/**
 * Resolves a length against what is available.
 *
 * A percentage of an unknown size is `auto`, which is what CSS does and what
 * keeps a column layout from resolving heights against nothing.
 *
 * @param length - The length to resolve.
 * @param available - The containing size, or `undefined` when it is not known.
 * @returns The number of cells, or `undefined` for `auto`.
 */
export function resolve(length: Length, available: number | undefined): number | undefined {
	if (length.type === 'cells') {
		return length.value;
	}
	if (length.type === 'percent') {
		// rounded rather than truncated: `33%` of 100 is 33 either way, but `50%`
		// of 5 is 2.5, and two boxes at 50% should still fill the row
		return available === undefined ? undefined : Math.round((available * length.value) / 100);
	}
	return undefined;
}

/**
 * Clamps a size to its min and max, min winning where they conflict -- which is
 * the CSS rule and the one that keeps a box from collapsing below its content.
 *
 * @param value - The size to clamp.
 * @param min - The minimum, if any.
 * @param max - The maximum, if any.
 * @returns The clamped size, never negative.
 */
export function clamp(value: number, min: number | undefined, max: number | undefined): number {
	let out = value;
	if (max !== undefined) {
		out = Math.min(out, max);
	}
	if (min !== undefined) {
		out = Math.max(out, min);
	}
	return Math.max(0, out);
}

/**
 * Distributes `total` cells across `weights` so that the parts are whole
 * numbers and add up to exactly `total`.
 *
 * The reason this is its own function: a layout that reshuffles its rounding
 * between frames shimmers, and one whose parts do not add up leaves a gap that
 * moves. Fractional remainders are carried forward left to right, so the same
 * weights always produce the same integers and the last part absorbs whatever
 * is left.
 *
 * @param total - The cells to hand out.
 * @param weights - How much each part asks for. Zero gets nothing.
 * @returns One whole number per weight, summing to `total`.
 */
export function distribute(total: number, weights: number[]): number[] {
	const sum = weights.reduce((a, b) => a + b, 0);
	const out = Array.from({ length: weights.length }, () => 0);

	if (sum <= 0 || total === 0) {
		return out;
	}

	let handed = 0;
	let carried = 0;

	for (let i = 0; i < weights.length; i++) {
		if (weights[i] <= 0) {
			continue;
		}
		const exact = (total * weights[i]) / sum + carried;
		// floored rather than rounded, so the remainder always moves *forward*.
		// Rounding sends it backwards half the time, which puts the spare cell in
		// the middle of a row of equal columns -- seven across three came out
		// 2, 3, 2 -- and contradicts the rule this function is supposed to keep
		const whole = Math.floor(exact);
		carried = exact - whole;
		out[i] = whole;
		handed += whole;
	}

	// rounding can leave the total a cell out either way; the last part that
	// asked for anything absorbs it, so the parts always add up
	if (handed !== total) {
		for (let i = weights.length - 1; i >= 0; i--) {
			if (weights[i] > 0) {
				out[i] += total - handed;
				break;
			}
		}
	}

	return out;
}
