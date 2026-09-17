import { type LayoutNode, type LayoutResult, layout, resolve } from '../../src/layout/index.js';
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
 * Whether a container's `justify-content` leaves its items against each other.
 *
 * These three put all the free space at one end or split it between the two, so
 * the distance between adjacent items is the declared gap and nothing else. The
 * `space-*` three are the ones that put free space *between* items, and how much
 * goes where is not something this can recompute without being the engine.
 *
 * @param justify - What the container asked for.
 * @returns Whether adjacent items must abut.
 */
function packsTogether(justify: Style['justifyContent']): boolean {
	return justify === 'flex-start' || justify === 'flex-end' || justify === 'center';
}

/**
 * The gap between adjacent items is the declared gap and their facing margins.
 *
 * This is the observable half of "a child's box is the size its parent allocated
 * for it", which the result itself cannot be asked: the parent placed the next
 * sibling at the far edge of the hole it reserved, so a child that came back
 * smaller than its hole leaves a gap nothing declared. Containment cannot see it
 * -- a shrunken box is still inside its parent and still clear of its siblings --
 * which is how a size clamped a second time, against a percentage base and an
 * automatic minimum that were both wrong by then, stayed green through forty-odd
 * picture tests.
 *
 * Only where the placement is recomputable without being the layout engine: one
 * line, a `justify-content` that does not space items out, and no auto margin on
 * the main axis to absorb what is left. The allocation itself is not in the
 * result, so the last item on a line -- or an only child -- is not covered.
 *
 * @param node - The container.
 */
function checkPacking(node: LayoutResult): void {
	const { style } = node.node;
	const column = style.flexDirection === 'column' || style.flexDirection === 'column-reverse';
	const reverse = style.flexDirection === 'row-reverse' || style.flexDirection === 'column-reverse';

	if (style.flexWrap !== 'nowrap' || !packsTogether(style.justifyContent)) {
		return;
	}

	// a percentage margin resolves against the containing block's width whichever
	// axis it is on, which is what the engine does
	const margin = (child: LayoutResult, end: boolean) => {
		const own = child.node.style;
		const length = column
			? end
				? own.marginBottom
				: own.marginTop
			: end
				? own.marginRight
				: own.marginLeft;
		return length.type === 'auto' ? undefined : (resolve(length, node.content.width) ?? 0);
	};

	const visible = node.children.filter((child) => child.node.style.display !== 'none');

	// an auto margin eats the free space, so the items are no longer packed
	if (
		visible.some((child) => margin(child, false) === undefined || margin(child, true) === undefined)
	) {
		return;
	}

	// placement order, which `order` and a reversed direction both change
	const ordered = [...visible].sort((a, b) => a.node.style.order - b.node.style.order);
	if (reverse) {
		ordered.reverse();
	}

	const gap = column ? style.rowGap : style.columnGap;
	const start = (child: LayoutResult) => (column ? child.box.y : child.box.x);
	const size = (child: LayoutResult) => (column ? child.box.height : child.box.width);

	for (let i = 1; i < ordered.length; i++) {
		const before = ordered[i - 1];
		const after = ordered[i];
		const expected =
			start(before) +
			size(before) +
			(margin(before, true) ?? 0) +
			gap +
			(margin(after, false) ?? 0);

		if (start(after) !== expected) {
			throw new Error(
				`sibling ${JSON.stringify(after.box)} starts at ${start(after)} where its neighbour ` +
					`${JSON.stringify(before.box)} and a gap of ${gap} put it at ${expected}`
			);
		}
	}
}

/**
 * Every invariant a layout has to keep, whatever it was asked for.
 *
 * The picture helper cannot check these: it paints later nodes over earlier ones
 * so an overlap is invisible, and it bounds-checks against the grid so anything
 * placed past the edge simply does not appear. A fuzzer found five hundred
 * containment violations that forty-two picture tests had no way to see.
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
			// a box with no area paints nothing, so where it sits cannot be wrong.
			// A gap still advances the cursor in a container with no room, which
			// leaves a zero-size child one column past a zero-width content box
			const occupies = child.box.width > 0 && child.box.height > 0;

			if (!opts.overflow && occupies) {
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

		checkPacking(node);
	};

	walk(result);
}
