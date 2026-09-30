/**
 * The three passes that put an element tree on screen: style, arrange, paint.
 *
 * Settling styles resolves the cascade over the tree and writes each element's
 * resolved style back onto it. Arrange runs the layout engine and writes each box
 * back onto the element that earned it. Paint walks the result in document order
 * and draws backgrounds, borders, text, and whatever a `raw` element draws for
 * itself. They live together because they are one sequence and because each is
 * the precondition of the next.
 *
 * Paint order is `z-index` then document order, and a box whose `overflow` is not
 * `visible` clips what its descendants draw to its padding box.
 */

import { ATTR, DEFAULT_COLOR, type Painter, type Style as CellStyle } from '../canvas/index.js';
import {
	borderWidth,
	type Box,
	type LayoutOptions,
	type LayoutResult,
	layout,
} from '../layout/index.js';
import type { Style, Update } from '../style/index.js';
import { Cascade, Restyler } from '../style/index.js';
import { stringWidth } from '../width/index.js';
import { truncate } from '../wrap/index.js';
// paint order lives in `hit.js` rather than here, though this is its primary
// reader: the hit test walks the same list backwards, and that module is the one
// that has to stay clear of the drawing stack, since the input router imports it
import { paintOrder } from './hit.js';
import type { Element } from './index.js';

/**
 * The characters each border style is drawn with.
 *
 * Top-left, top, top-right, right, bottom-right, bottom, bottom-left, left. The
 * property is named for a character set rather than for a rendering mode --
 * `solid` and `dashed` mean nothing to a terminal -- so this table is the whole
 * of what `border-style` means.
 */
const BORDERS: Record<string, readonly string[]> = {
	ascii: ['+', '-', '+', '|', '+', '-', '+', '|'],
	bold: ['┏', '━', '┓', '┃', '┛', '━', '┗', '┃'],
	double: ['╔', '═', '╗', '║', '╝', '═', '╚', '║'],
	round: ['╭', '─', '╮', '│', '╯', '─', '╰', '│'],
	single: ['┌', '─', '┐', '│', '┘', '─', '└', '│'],
};

/**
 * The cell style a resolved style paints with.
 *
 * One `Color` type is shared with the canvas already, so this is the attributes
 * and nothing else -- the resolved style carries them as booleans because that
 * is what a stylesheet writes, and a cell carries them as bits because that is
 * what a diff compares.
 *
 * @param style - The resolved style.
 * @returns The cell style.
 */
export function cellStyle(style: Style): CellStyle {
	let attrs = ATTR.none;
	if (style.bold) {
		attrs |= ATTR.bold;
	}
	if (style.dim) {
		attrs |= ATTR.dim;
	}
	if (style.italic) {
		attrs |= ATTR.italic;
	}
	if (style.underline) {
		attrs |= ATTR.underline;
	}
	if (style.strikethrough) {
		attrs |= ATTR.strikethrough;
	}
	if (style.overline) {
		attrs |= ATTR.overline;
	}
	if (style.inverse) {
		attrs |= ATTR.inverse;
	}

	return { attrs, bg: style.backgroundColor, fg: style.color, link: '' };
}

/**
 * The rectangle a box clips its descendants to.
 *
 * The padding box, which is the border box with the border taken off: what a box
 * clips is what its descendants draw and never its own border, because the border
 * *is* the edge and a box that clipped itself would erase the frame it is drawing.
 *
 * @param area - The element's border box.
 * @param style - Its resolved style.
 * @returns The padding box.
 */
function paddingBox(area: Box, style: Style): Box {
	const border = borderWidth(style);
	return {
		height: Math.max(0, area.height - border * 2),
		width: Math.max(0, area.width - border * 2),
		x: area.x + border,
		y: area.y + border,
	};
}

/**
 * The rectangle two clips both allow.
 *
 * A clipping box inside another one cannot reach where its parent could not, so
 * this intersects rather than replacing -- the same rule `Painter.clip()` keeps,
 * for the same reason, and the reason `element.clip` is already the whole
 * intersection by the time paint or a hit test reads it.
 *
 * @param outer - The clip already in effect, if any.
 * @param inner - The one being added.
 * @returns The overlap, which may be empty.
 */
function intersect(outer: Box | undefined, inner: Box): Box {
	if (!outer) {
		return inner;
	}
	const x = Math.max(outer.x, inner.x);
	const y = Math.max(outer.y, inner.y);
	return {
		height: Math.max(0, Math.min(outer.y + outer.height, inner.y + inner.height) - y),
		width: Math.max(0, Math.min(outer.x + outer.width, inner.x + inner.width) - x),
		x,
		y,
	};
}

/**
 * Lays a tree out and writes every box back onto the element it belongs to.
 *
 * Matched by index rather than by identity, which is what the layout engine
 * guarantees and says so: `result.children[i]` answers for `node.children[i]`
 * whatever `order`, `display: none`, or the same node appearing twice did to the
 * placement.
 *
 * The clip each element is subject to is written here as well, and that is the
 * one thing this walk decides rather than copies: it is every ancestor's
 * `overflow` intersected, it is what paint draws inside, and it is what a hit
 * test asks about -- so it is computed once here rather than a second time in
 * each of them.
 *
 * @param root - The root element.
 * @param opts - The space available.
 * @returns The laid-out tree, for anything that wants it directly.
 */
export function arrange(root: Element, opts: LayoutOptions): LayoutResult {
	const result = layout(root, opts);

	const walk = (element: Element, node: LayoutResult, clip: Box | undefined): void => {
		element.box = node.box;
		element.content = node.content;
		element.clip = clip;

		// what this element clips *for* is the clip its children are subject to,
		// which is this one narrowed by its padding box where its `overflow` asks
		const inner =
			element.style.overflow === 'visible'
				? clip
				: intersect(clip, paddingBox(node.box, element.style));

		for (const [i, child] of element.children.entries()) {
			const laid = node.children[i];
			if (laid) {
				walk(child, laid, inner);
			}
		}
	};

	walk(root, result, undefined);
	return result;
}

/**
 * How far an arranged tree actually reached, in both directions.
 *
 * `measureNode()` answers what a tree would ask for, and it is a guess in two
 * ways. A row whose children flex is measured with each child offered the whole
 * content box while placement hands each one a share, so a description that
 * wraps to three lines in its share measures two lines tall in the room it was
 * offered. And a box with a declared width reports that width however far its
 * content overflows it, so a word wider than the column it is in is invisible to
 * the measure and is cut off by whatever the measure sized. The layout itself is
 * right -- `remeasureLine()` settles each item at the width flexing gave it, and
 * an overflowing word keeps its own box -- so this asks the arranged tree rather
 * than asking again for an estimate.
 *
 * Every descendant is walked rather than only the root's children, because a box
 * that fits can hold one that does not: overflow is legitimate here, and the
 * question is "how much room does the answer take" rather than "did anything
 * escape". The root itself is skipped, since a root with no declared size fills
 * whatever it was given and would report that back.
 *
 * @param result - What `arrange()` returned.
 * @returns The last row and the last column any box reaches, as counts.
 */
export function arrangedExtent(result: LayoutResult): { height: number; width: number } {
	let bottom = 0;
	let right = 0;

	const walk = (node: LayoutResult): void => {
		bottom = Math.max(bottom, node.box.y + node.box.height);
		right = Math.max(right, node.box.x + node.box.width);
		for (const child of node.children) {
			walk(child);
		}
	};

	for (const child of result.children) {
		walk(child);
	}

	// a tree with nothing in it is as big as it measured, which is the root's own
	// box and the one case where reading it back is the answer
	return result.children.length > 0
		? { height: bottom, width: right }
		: { height: result.box.height, width: result.box.width };
}

/** Draws a border around a box, if its style asks for one. */
function paintBorder(painter: Painter, area: Box, style: Style, cell: CellStyle): void {
	const chars = BORDERS[style.borderStyle];
	if (!chars || area.width <= 0 || area.height <= 0) {
		return;
	}

	const [tl, top, tr, right, br, bottom, bl, left] = chars;
	const edge: CellStyle = { ...cell, fg: style.borderColor };
	const { height, width, x, y } = area;
	const last = y + height - 1;
	const end = x + width - 1;

	// a one-cell-wide or one-row-tall border is the corners overlapping, and the
	// corners win: a box that narrow has no edge to draw
	painter.text(x, y, tl, edge);
	painter.text(end, y, tr, edge);
	painter.text(x, last, bl, edge);
	painter.text(end, last, br, edge);

	for (let i = x + 1; i < end; i++) {
		painter.text(i, y, top, edge);
		painter.text(i, last, bottom, edge);
	}
	for (let i = y + 1; i < last; i++) {
		painter.text(x, i, left, edge);
		painter.text(end, i, right, edge);
	}
}

/** Draws a text element's content inside the box the layout gave it. */
function paintText(painter: Painter, element: Element, area: Box, cell: CellStyle): void {
	const { style } = element;
	// asked for rather than worked out again: the layout engine wrapped this very
	// text at this very width on its way to a height, and re-wrapping it here was
	// half of all the grapheme segmentation a help screen did
	const { lines, widths } = element.wrapped(area.width);

	for (const [i, raw] of lines.entries()) {
		if (i >= area.height) {
			// the rows past the bottom of the box are not this pass's to invent a
			// policy for: clipping is the box's `overflow`, and painting them would
			// draw over whatever the layout put underneath
			break;
		}

		// a line wider than the box it was given is cut here rather than left to
		// run off the edge, because `text-overflow` says how. It bites only where a
		// line overflows, which for wrapped text never happens -- so in practice it
		// is what `white-space: nowrap` costs, exactly as in CSS. Read off the text
		// element's own style: the property does not inherit, so a container
		// setting it does not silently truncate every descendant, and the box doing
		// the clipping is this one
		const width = widths[i] ?? stringWidth(raw);
		const line = width > area.width ? truncate(raw, area.width, style.textOverflow) : raw;

		// the width is already known where the line was not cut, and a cut line is
		// a new string that has to be measured
		const slack = Math.max(0, area.width - (line === raw ? width : stringWidth(line)));
		const offset =
			style.textAlign === 'right'
				? slack
				: style.textAlign === 'center'
					? Math.floor(slack / 2)
					: 0;

		painter.text(area.x + offset, area.y + i, line, cell);
	}
}

/**
 * Walks a laid-out tree and draws it.
 *
 * `z-index` then document order, which is what `paintOrder()` decides and what
 * the hit test reads back: a later-painted child is the one on top, so the hit
 * test walks the same list backwards.
 *
 * Each element is drawn inside the clip `arrange()` wrote onto it, rather than
 * inside a clip this walk nests up for itself. That reads as though it needed
 * `Painter.clip()` to *replace* rather than intersect, and it does not: nothing
 * here leaves a clip in effect between elements, so the painter's ambient clip is
 * always empty when this asks -- and intersecting with nothing is what the
 * element's own already-intersected rectangle wants.
 *
 * @param root - The root element, already arranged.
 * @param painter - The painter to draw through.
 */
export function paint(root: Element, painter: Painter): void {
	const walk = (element: Element): void => {
		const area = element.box;
		if (!area || element.style.display === 'none') {
			return;
		}

		const { style } = element;

		// `hidden` hides this element and not its subtree: `visibility` inherits,
		// so a descendant is hidden because it inherited the value rather than
		// because this one was, and a descendant that sets `visible` is drawn. That
		// is CSS, and it is the only reason this is a skip rather than a return
		if (style.visibility !== 'hidden') {
			const cell = cellStyle(style);
			const draw = (into: Painter): void => {
				if (style.backgroundColor !== DEFAULT_COLOR) {
					into.fill(area.x, area.y, area.width, area.height, cell);
				}

				paintBorder(into, area, style, cell);

				const inner = element.content ?? area;
				if (element.type === 'text') {
					paintText(into, element, inner, cell);
				} else if (element.type === 'raw') {
					element.rawPaint?.(into, inner, element);
				}
			};

			if (element.clip) {
				painter.clip(element.clip, draw);
			} else {
				draw(painter);
			}
		}

		for (const child of paintOrder(element)) {
			walk(child);
		}
	};

	walk(root);
}

/**
 * Resolves a tree's styles and writes each one onto the element it belongs to.
 *
 * The wiring between the cascade and the tree, in one place, because it is the
 * same three lines everywhere and getting them wrong is invisible: the walk has
 * to be in document order, since a child's inherited values come from its
 * parent's *resolved* style.
 *
 * With no cascade handed in it builds one over no stylesheets, which is not a
 * second way of resolving a style but the degenerate case of the only one: props
 * and inheritance, with nothing matched. That is what a tree with no stylesheet
 * means, and it is why `box({ padding: '1' })` lays out padded without anybody
 * having written a sheet.
 *
 * @param root - The root element.
 * @param restyler - The restyler holding the sheets, if there are any.
 * @returns The restyler, so a caller can keep it for the next frame.
 */
export function resolveStyles(root: Element, restyler?: Restyler): Restyler {
	const it = restyler ?? new Restyler(new Cascade([]));
	settleStyles(root, it);
	return it;
}

/**
 * The same walk, handing back what the restyler worked out rather than the
 * restyler.
 *
 * `resolveStyles()` is the spelling for a caller that resolves and draws; a
 * frame loop needs the other half of the answer -- which elements moved and
 * which merely need repainting -- and recovering that by diffing styles it has
 * just been handed would be the restyler's job done twice, to a worse answer.
 * One walk, two callers, so the two can never come to disagree about the order
 * it happens in.
 *
 * @param root - The root element.
 * @param restyler - The restyler holding the sheets.
 * @returns What needs laying out and what needs painting.
 */
export function settleStyles(root: Element, restyler: Restyler): Update {
	const update = restyler.update(root);

	const walk = (element: Element): void => {
		const style = restyler.styleOf(element);
		if (style) {
			element.style = style;
		}
		for (const child of element.children) {
			walk(child);
		}
	};

	walk(root);
	return update;
}
