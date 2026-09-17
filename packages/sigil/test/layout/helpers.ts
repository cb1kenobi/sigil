import { type LayoutNode, type LayoutResult, layout } from '../../src/layout/index.js';
import { declare, type Declarations, type Style } from '../../src/style/index.js';
import { stringWidth } from '../../src/width/index.js';
import { wrap } from '../../src/wrap/index.js';

/**
 * Layout is the one layer in the stack that needs no terminal, no renderer, and
 * no reactivity to test -- so it is tested by laying a tree out and reading the
 * result back as a picture. A failing assertion that prints two grids says what
 * went wrong; one that prints `{ x: 3, y: 0, width: 11, height: 2 }` does not,
 * and this engine has enough arithmetic in it that the difference matters.
 */

/** Builds a node from declarations, so a test reads like a stylesheet. */
export function box(declarations: Declarations, ...children: LayoutNode[]): LayoutNode {
	return { children, style: declare(declarations) };
}

/**
 * A text node that measures the way the real one will: through `stringWidth()`
 * for the width and `wrap()` for the height.
 *
 * @param content - The text.
 * @param declarations - Any style it carries.
 * @returns The node.
 */
export function text(content: string, declarations: Declarations = {}): LayoutNode {
	const style: Style = declare(declarations);
	return {
		measure(availableWidth: number) {
			const longestWord = Math.max(
				0,
				...content
					.split(/\s+/)
					.filter(Boolean)
					.map((word) => stringWidth(word))
			);

			if (style.whiteSpace === 'nowrap' || availableWidth <= 0) {
				return { height: 1, minHeight: 1, minWidth: longestWord, width: stringWidth(content) };
			}

			const wrapped = wrap(content, { width: availableWidth });
			const lines = wrapped.split('\n');
			return {
				height: lines.length,
				// text is as short as it can be at the width it was given: wrapping
				// it narrower makes it taller, not shorter
				minHeight: lines.length,
				minWidth: longestWord,
				width: Math.max(0, ...lines.map((line) => stringWidth(line))),
			};
		},
		style,
	};
}

/**
 * Renders a laid-out tree to a grid of characters.
 *
 * Each node paints its border box with a character of its own, so a picture
 * shows where every box ended up and which is which. Text nodes paint their
 * text. Later nodes paint over earlier ones, which is document order.
 *
 * @param result - The laid-out tree.
 * @param width - The grid width.
 * @param height - The grid height.
 * @param marks - The characters to use, depth-first in document order.
 * @returns The grid, one string per row.
 */
export function render(
	result: LayoutResult,
	width: number,
	height: number,
	marks = 'abcdefghijklmnopqrstuvwxyz'
): string {
	const rows = Array.from({ length: height }, () => Array.from({ length: width }, () => '.'));
	let index = 0;

	const paint = (node: LayoutResult): void => {
		const mark = marks[index % marks.length];
		index++;

		const { box: area } = node;
		for (let y = area.y; y < area.y + area.height; y++) {
			for (let x = area.x; x < area.x + area.width; x++) {
				if (y >= 0 && y < height && x >= 0 && x < width) {
					rows[y][x] = mark;
				}
			}
		}

		for (const child of node.children) {
			paint(child);
		}
	};

	paint(result);
	return rows.map((row) => row.join('')).join('\n');
}

/**
 * Lays a tree out and renders it, which is what most of these tests want.
 *
 * @param node - The tree.
 * @param width - The space available.
 * @param height - The space available.
 * @returns The picture.
 */
export function picture(node: LayoutNode, width: number, height: number): string {
	return render(layout(node, { height, width }), width, height);
}

/** Every node's box, depth-first, for the assertions a picture cannot make. */
export function boxes(
	result: LayoutResult
): { height: number; width: number; x: number; y: number }[] {
	const out: { height: number; width: number; x: number; y: number }[] = [];
	const walk = (node: LayoutResult): void => {
		out.push({ ...node.box });
		for (const child of node.children) {
			walk(child);
		}
	};
	walk(result);
	return out;
}

/**
 * Whether a node was moved off where the flow put it.
 *
 * Both halves are asked, because `position: relative` on its own moves nothing:
 * excusing a box that merely names the keyword would open the net for every one
 * that then overflows for an unrelated reason.
 *
 * @param node - The laid-out node.
 * @returns Whether `relative` and an inset were both declared.
 */
function isOffset(node: LayoutResult): boolean {
	const { style } = node.node;
	return (
		style.position === 'relative' &&
		[style.top, style.right, style.bottom, style.left].some((inset) => inset.type !== 'auto')
	);
}

/**
 * Every invariant a layout has to keep, whatever it was asked for.
 *
 * The picture helper cannot check these: it paints later nodes over earlier ones
 * so an overlap is invisible, and it bounds-checks against the grid so anything
 * placed past the edge simply does not appear. A fuzzer found five hundred
 * containment violations that forty-two picture tests had no way to see.
 *
 * A `position: relative` child that declares an inset is excused both of them,
 * and that is the whole meaning of the property rather than a hole in the check:
 * the flow reserves its space at the un-offset position and the box is then
 * moved off it, so escaping the parent and landing on a sibling are what was
 * asked for. Keyed on the inset rather than on the keyword, because a box that
 * says `relative` and moves nowhere has nothing to excuse. Everything else on
 * the same tree is still checked, including the offset box's own children
 * against the offset box.
 *
 * @param result - The laid-out tree.
 * @param opts - `overflow` allows a child larger than its parent, which is what
 * a declared size too big for its container legitimately produces.
 */
export function checkInvariants(result: LayoutResult, opts: { overflow?: boolean } = {}): void {
	const walk = (node: LayoutResult): void => {
		if (node.box.width < 0 || node.box.height < 0) {
			throw new Error(`negative box ${JSON.stringify(node.box)}`);
		}

		const line: LayoutResult[] = [];

		for (const child of node.children) {
			const offset = isOffset(child);

			// a box with no area paints nothing, so where it sits cannot be wrong.
			// A gap still advances the cursor in a container with no room, which
			// leaves a zero-size child one column past a zero-width content box
			const occupies = child.box.width > 0 && child.box.height > 0;

			if (!opts.overflow && occupies && !offset) {
				const fitsX =
					child.box.x >= node.content.x &&
					child.box.x + child.box.width <= node.content.x + node.content.width;
				const fitsY =
					child.box.y >= node.content.y &&
					child.box.y + child.box.height <= node.content.y + node.content.height;

				if (!fitsX || !fitsY) {
					throw new Error(
						`child ${JSON.stringify(child.box)} escapes content ${JSON.stringify(node.content)}`
					);
				}
			}

			for (const sibling of line) {
				if (offset || isOffset(sibling)) {
					continue;
				}
				const apart =
					child.box.x >= sibling.box.x + sibling.box.width ||
					sibling.box.x >= child.box.x + child.box.width ||
					child.box.y >= sibling.box.y + sibling.box.height ||
					sibling.box.y >= child.box.y + child.box.height;
				if (!apart && child.box.width > 0 && child.box.height > 0) {
					throw new Error(
						`siblings overlap: ${JSON.stringify(child.box)} and ${JSON.stringify(sibling.box)}`
					);
				}
			}

			line.push(child);
			walk(child);
		}
	};

	walk(result);
}
