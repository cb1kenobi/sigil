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
import { truncate, wrap } from '../wrap/index.js';
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
 * Lays a tree out and writes every box back onto the element it belongs to.
 *
 * Matched by index rather than by identity, which is what the layout engine
 * guarantees and says so: `result.children[i]` answers for `node.children[i]`
 * whatever `order`, `display: none`, or the same node appearing twice did to the
 * placement.
 *
 * @param root - The root element.
 * @param opts - The space available.
 * @returns The laid-out tree, for anything that wants it directly.
 */
export function arrange(root: Element, opts: LayoutOptions): LayoutResult {
	const result = layout(root, opts);

	const walk = (element: Element, node: LayoutResult): void => {
		element.box = node.box;
		element.content = node.content;
		for (const [i, child] of element.children.entries()) {
			const laid = node.children[i];
			if (laid) {
				walk(child, laid);
			}
		}
	};

	walk(root, result);
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
	const content = element.displayText;
	const lines =
		style.whiteSpace === 'nowrap' || area.width <= 0
			? content.split('\n')
			: wrap(content, { width: area.width }).split('\n');

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
		const line =
			stringWidth(raw) > area.width ? truncate(raw, area.width, style.textOverflow) : raw;

		const slack = Math.max(0, area.width - stringWidth(line));
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
 * Document order, which is paint order: a later sibling draws over an earlier
 * one. `z-index` is parsed and is not read here, because a paint order that
 * honours it is SIG-64's along with clipping.
 *
 * @param root - The root element, already arranged.
 * @param painter - The painter to draw through.
 */
export function paint(root: Element, painter: Painter): void {
	const walk = (element: Element, into: Painter): void => {
		const area = element.box;
		if (!area || element.style.display === 'none') {
			return;
		}

		const { style } = element;
		const cell = cellStyle(style);

		// `hidden` hides this element and not its subtree: `visibility` inherits,
		// so a descendant is hidden because it inherited the value rather than
		// because this one was, and a descendant that sets `visible` is drawn. That
		// is CSS, and it is the only reason this is a skip rather than a return
		if (style.visibility !== 'hidden') {
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
		}

		if (element.children.length === 0) {
			return;
		}

		// what a box clips is what its descendants draw, never its own border: the
		// border *is* the edge, and a box that clipped itself would erase the frame
		// it is drawing. The padding box is what CSS clips to, which is the border
		// box with the border taken off
		const border = borderWidth(style);
		const paintChildren = (target: Painter): void => {
			for (const child of ordered(element)) {
				walk(child, target);
			}
		};

		if (style.overflow === 'visible') {
			paintChildren(into);
		} else {
			into.clip(
				{
					height: Math.max(0, area.height - border * 2),
					width: Math.max(0, area.width - border * 2),
					x: area.x + border,
					y: area.y + border,
				},
				paintChildren
			);
		}
	};

	walk(root, painter);
}

/**
 * A box's children in the order they are painted.
 *
 * `z-index` then document order, which is CSS's rule for flex items -- and every
 * child here is one, since `display: flex` is the initial value and the only
 * other one is `none`. So the property applies to all of them rather than to
 * positioned boxes alone, which is both simpler to say and what CSS says for
 * this layout mode.
 *
 * Sorted stably, so children that share a `z-index` keep the order they were
 * written in: the ordering is a way to lift one box over another, not a way to
 * shuffle everything that did not ask.
 *
 * What this does *not* do is let a descendant escape its ancestor. A child with a
 * non-zero `z-index` is painted as a unit -- its own subtree is ordered inside
 * it and cannot reach out past its siblings -- which is a stacking context by
 * another name, and it is what stops `z-index` becoming a global free-for-all
 * that every component fights over with bigger integers.
 *
 * @param element - The parent.
 * @returns Its children, in paint order.
 */
function ordered(element: Element): readonly Element[] {
	const children = element.children;
	// the common case is that nobody asked, and sorting a few hundred children
	// per frame to discover that is work a frame does not need
	if (!children.some((child) => child.style.zIndex !== 0)) {
		return children;
	}
	return [...children].sort((a, b) => a.style.zIndex - b.style.zIndex);
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
