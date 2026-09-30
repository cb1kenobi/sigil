import {
	ancestry,
	arrange,
	box,
	type Element,
	hitTest,
	resolveStyles,
	text,
} from '../../src/element/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Which element is under a point.
 *
 * Every case here is a tree laid out and then probed, rather than boxes written
 * by hand: the whole claim is that the hit test agrees with what is on screen, and
 * a literal box asserts agreement with an arrangement nobody did.
 */

/** Styles and lays a tree out, which is what writes the boxes and the clips. */
function lay(root: Element, width = 20, height = 8): Element {
	resolveStyles(root);
	arrange(root, { height, width });
	return root;
}

/** What is under a point, by its `id`, so a failure names something readable. */
function at(root: Element, x: number, y: number): string | undefined {
	return hitTest(root, x, y)?.id;
}

describe('the hit test', () => {
	it('should find the innermost box containing the point', () => {
		const inner = box({ height: 2, id: 'inner', width: 4 });
		const root = lay(box({ id: 'root', padding: '1' }, inner));

		expect(at(root, 1, 1)).toBe('inner');
		expect(at(root, 4, 2)).toBe('inner');
		// the padding is the root's own, so a point in it is the root
		expect(at(root, 0, 0)).toBe('root');
		expect(at(root, 5, 1)).toBe('root');
	});

	it('should answer nothing outside the tree', () => {
		const root = lay(box({ height: 2, id: 'root', width: 4 }), 20, 8);
		expect(at(root, 4, 0)).toBeUndefined();
		expect(at(root, 0, 2)).toBeUndefined();
		expect(at(root, -1, 0)).toBeUndefined();
	});

	it('should take the last of two overlapping siblings, which is the one on top', () => {
		// document order is paint order, so the later sibling is drawn over the earlier
		// one -- and the hit test walks the same list backwards
		const root = lay(
			box(
				{ height: 4, id: 'root', position: 'relative', width: 10 },
				box({ height: 2, id: 'under', position: 'absolute', top: 0, left: 0, width: 6 }),
				box({ height: 2, id: 'over', position: 'absolute', top: 0, left: 0, width: 6 })
			)
		);

		expect(at(root, 1, 1)).toBe('over');
	});

	it('should read z-index the way paint does, not document order', () => {
		const root = lay(
			box(
				{ height: 4, id: 'root', position: 'relative', width: 10 },
				box({
					height: 2,
					id: 'lifted',
					left: 0,
					position: 'absolute',
					top: 0,
					width: 6,
					'z-index': 5,
				}),
				box({ height: 2, id: 'later', left: 0, position: 'absolute', top: 0, width: 6 })
			)
		);

		// the later sibling would win on document order and does not, because the
		// other one asked to be lifted over it
		expect(at(root, 1, 1)).toBe('lifted');
	});

	it('should not find a box where an ancestor clips it', () => {
		// the clip is what `arrange()` wrote and what paint drew inside, which is the
		// whole reason it is carried rather than computed twice
		const tall = box({ height: 6, id: 'tall', width: 4 });
		const root = lay(box({ height: 3, id: 'root', overflow: 'hidden', width: 10 }, tall));

		expect(tall.box).toMatchObject({ height: 6 });
		expect(at(root, 1, 1)).toBe('tall');
		// row 3 is inside the child's own box and outside the box that clips it: not
		// on screen, so not hittable
		expect(at(root, 1, 3)).toBeUndefined();
	});

	it('should intersect nested clips rather than replacing them', () => {
		// a panel that clips inside a pane that clips cannot be hit where its parent
		// could not paint, which is what the nesting means
		const deep = box({ height: 6, id: 'deep', width: 20 });
		const inner = box({ height: 6, id: 'inner', overflow: 'hidden', width: 20 }, deep);
		const root = lay(box({ height: 2, id: 'root', overflow: 'hidden', width: 20 }, inner), 20, 8);

		expect(at(root, 1, 1)).toBe('deep');
		expect(at(root, 1, 2)).toBeUndefined();
	});

	it('should find a child that overflows a parent that does not clip', () => {
		// `overflow: visible` draws the child outside its parent, so it is hittable
		// there -- which is why the clip is a separate question from the parent's box.
		// `flex-shrink: 0` is what makes it overflow rather than being squeezed to fit,
		// which is the layout engine doing its job and not this one's subject
		const wide = box({ 'flex-shrink': 0, height: 1, id: 'wide', width: 12 });
		const root = lay(
			box({ height: 3, id: 'root', width: 20 }, box({ id: 'small', width: 4 }, wide))
		);

		expect(wide.box).toMatchObject({ width: 12 });
		expect(at(root, 10, 0)).toBe('wide');
	});

	it('should skip a hidden element and not its subtree', () => {
		// `visibility` inherits, so a descendant that sets `visible` is on screen and is
		// hittable whatever its parent said. That is CSS and it is what paint does
		const shown = box({ height: 1, id: 'shown', visibility: 'visible', width: 4 });
		const root = lay(
			box({ id: 'root', width: 20 }, box({ id: 'hidden', visibility: 'hidden', width: 20 }, shown))
		);

		expect(at(root, 1, 0)).toBe('shown');
		// the hidden box is twenty columns wide and none of them is drawn, so a point
		// inside it that misses its visible child falls through to the root behind it.
		// The width is what makes this assertion mean anything: without it the hidden
		// box is as wide as its child and there is nowhere to probe that is inside one
		// and not the other
		expect(at(root, 10, 0)).toBe('root');
	});

	it('should not find a subtree that was never laid out', () => {
		const root = lay(
			box({ id: 'root', width: 20 }, box({ display: 'none', id: 'gone', width: 4 }))
		);
		expect(at(root, 1, 0)).toBe('root');
	});

	it('should follow a scrolled box, because scrolling moves the boxes', () => {
		// the layout applies the offset to the result rather than at paint time, so a
		// box is where it is drawn -- and the hit test needs no correction pass
		const list = box({ height: 6, id: 'list', width: 4 });
		const pane = box({ height: 3, id: 'pane', overflow: 'hidden', width: 10 }, list);
		pane.scroll = { x: 0, y: 2 };
		const root = lay(pane);

		expect(list.box?.y).toBe(-2);
		expect(at(root, 1, 0)).toBe('list');
	});

	it('should find a text, which is an element like any other', () => {
		const root = lay(box({ id: 'root', padding: '1' }, text('hello', { id: 'label' })));
		expect(at(root, 1, 1)).toBe('label');
	});
});

describe('the hovered chain', () => {
	it('should be the element and every ancestor, innermost first', () => {
		// what `:hover` is set on, because in CSS the pointer is inside every box that
		// contains it rather than only the innermost one
		const leaf = box({ id: 'leaf' });
		const mid = box({ id: 'mid' }, leaf);
		box({ id: 'root' }, mid);

		expect(ancestry(leaf).map((it) => it.id)).toEqual(['leaf', 'mid', 'root']);
		expect(ancestry(undefined)).toEqual([]);
	});
});
