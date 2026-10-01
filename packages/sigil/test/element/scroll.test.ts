import { CellBuffer, Painter, StyleTable } from '../../src/canvas/index.js';
import {
	arrange,
	box,
	type Element,
	hitTest,
	paint,
	raw,
	resolveStyles,
	scrollBy,
	scrollIntoView,
	scrollRange,
	text,
} from '../../src/element/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Scrolling a clipping box, and the rectangle two walks cull against.
 *
 * Every case lays a real tree out rather than writing boxes by hand, for the
 * reason the hit test's own tests give: the whole claim is that these agree with
 * what is on screen, and a literal box asserts agreement with an arrangement
 * nobody did.
 */

/** Styles and lays a tree out, which is what writes the boxes, clips and extents. */
function lay(root: Element, width = 20, height = 6): Element {
	resolveStyles(root);
	arrange(root, { height, width });
	return root;
}

/** A clipping viewport holding `count` one-row texts, as a scroll box is shaped. */
function list(count: number, height = 4): { rows: Element[]; view: Element } {
	const rows = Array.from({ length: count }, (_, i) => text(`row ${i}`, { focusable: true }));
	const content = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, ...rows);
	const view = box(
		{
			'flex-direction': 'column',
			height,
			id: 'view',
			overflow: 'hidden',
			width: 10,
		},
		content
	);
	return { rows, view };
}

/** Paints a tree into a grid and reads it back, one string per row. */
function picture(root: Element, width: number, height: number): string[] {
	const buffer = new CellBuffer(width, height);
	paint(root, new Painter(buffer, new StyleTable()));

	const lines: string[] = [];
	for (let y = 0; y < height; y++) {
		let line = '';
		for (let x = 0; x < width; x++) {
			line += buffer.charAt(x, y) || ' ';
		}
		lines.push(line.trimEnd());
	}
	return lines;
}

describe('an element extent', () => {
	it('should be a leaf box for a leaf', () => {
		const leaf = box({ height: 2, id: 'leaf', width: 4 });
		lay(box({}, leaf));
		expect(leaf.extent).toStrictEqual(leaf.box);
	});

	it('should hold a child drawn outside its parent', () => {
		// the whole reason this is not the element's own box: a child with
		// `overflow: visible` is drawn outside its parent, so culling on the
		// parent's box alone would take a visible child with it
		const child = box({ height: 2, id: 'child', position: 'relative', top: 4, width: 4 });
		const parent = box({ height: 1, id: 'parent', width: 4 }, child);
		lay(box({}, parent));

		expect(parent.box?.height).toBe(1);
		expect(parent.extent?.height).toBe(6);
	});

	it('should stop at a box that clips, so a nested region reports only itself', () => {
		const { view } = list(40);
		const outer = box({ height: 4, id: 'outer', width: 12 }, view);
		lay(box({}, outer));

		// the view's content is forty rows tall and none of it can be drawn outside
		// the view, so the box around it is four rows and not forty
		expect(view.extent).toStrictEqual(view.box);
		expect(outer.extent?.height).toBe(4);
	});

	it('should not grow for a display:none child, which the engine gives no box', () => {
		// what makes the union need no check of its own: such a child is a zero box
		// at the content origin and nothing inside it is laid out at all, so there
		// is nothing for a skip to leave out. Pinned here because a guard for it was
		// written and deleted for failing its sabotage, and this is the property
		// that made the sabotage survive
		const inside = box({ height: 4, width: 4 });
		const gone = box({ display: 'none', height: 9, width: 4 }, inside);
		const parent = box({ height: 1, width: 4 }, gone);
		lay(box({}, parent));

		expect(gone.box).toStrictEqual({ height: 0, width: 0, x: 0, y: 0 });
		expect(inside.box).toBeUndefined();
		expect(parent.extent?.height).toBe(1);
	});
});

describe('scrollRange', () => {
	it('should be the content past the viewport', () => {
		const { view } = list(10);
		lay(box({}, view));
		expect(scrollRange(view)).toStrictEqual({ x: 0, y: 6 });
	});

	it('should be nothing where the content fits', () => {
		const { view } = list(2);
		lay(box({}, view));
		expect(scrollRange(view)).toStrictEqual({ x: 0, y: 0 });
	});

	it('should not change as the box is scrolled', () => {
		// the offset is added back, because the children have already been shifted
		// by it: the question is how tall the content is, not where it now sits
		const { view } = list(10);
		lay(box({}, view));
		view.scrollTo(0, 4);
		lay(box({}, view));
		expect(scrollRange(view)).toStrictEqual({ x: 0, y: 6 });
	});

	it('should report nothing for a box nothing has arranged', () => {
		const { view } = list(10);
		expect(scrollRange(view)).toStrictEqual({ x: 0, y: 0 });
	});

	it('should give a box that does not clip no region at all', () => {
		// the contract `Element.scrollable` states, and the reason it is a field
		// rather than a rectangle on everything: a box that cannot scroll has no
		// region to scroll inside. Nothing asks a non-clipping box for its range
		// today, so writing one anyway would change no answer -- which is exactly
		// what a sabotage of the condition proved, and why the doc needs an
		// assertion rather than a reader's goodwill
		const { view } = list(10);
		const plain = box({ 'flex-direction': 'column', height: 4, width: 10 }, view);
		lay(box({}, plain));

		expect(plain.scrollable).toBeUndefined();
		expect(scrollRange(plain)).toStrictEqual({ x: 0, y: 0 });
		// and the one that does clip has one
		expect(view.scrollable).toBeDefined();
	});
});

describe('scrollBy', () => {
	it('should clamp at the end of the content', () => {
		const { view } = list(10);
		lay(box({}, view));

		expect(scrollBy(view, 0, 100)).toBe(true);
		expect(view.scroll?.y).toBe(6);
		// already there, so nothing moved and nothing is reported
		expect(scrollBy(view, 0, 100)).toBe(false);
	});

	it('should clamp at the start', () => {
		const { view } = list(10);
		lay(box({}, view));
		view.scrollTo(0, 2);
		expect(scrollBy(view, 0, -100)).toBe(true);
		expect(view.scroll?.y).toBe(0);
	});
});

describe('scrollIntoView', () => {
	it('should bring a row below the fold into view', () => {
		const { rows, view } = list(10);
		lay(box({}, view));

		expect(scrollIntoView(rows[7])).toBe(true);
		// row 7 is the eighth row and the view holds four, so the smallest move
		// that shows it is the one that puts it on the last line
		expect(view.scroll?.y).toBe(4);
	});

	it('should bring a row above the fold into view', () => {
		const { rows, view } = list(10);
		lay(box({}, view));
		view.scrollTo(0, 6);
		lay(box({}, view));

		expect(scrollIntoView(rows[1])).toBe(true);
		expect(view.scroll?.y).toBe(1);
	});

	it('should do nothing for a row already on screen', () => {
		const { rows, view } = list(10);
		lay(box({}, view));
		expect(scrollIntoView(rows[2])).toBe(false);
		expect(view.scroll).toBeUndefined();
	});

	it('should keep a margin of rows past it', () => {
		const { rows, view } = list(10);
		lay(box({}, view));

		scrollIntoView(rows[4], { margin: 1 });
		// without the margin row 4 sits on the last line; with it, one more row
		// below has to be visible as well
		expect(view.scroll?.y).toBe(2);
	});

	it('should align the start of a row taller than the view', () => {
		const tall = box({ focusable: true, height: 9, id: 'tall', width: 4 });
		const spacer = box({ height: 6, width: 4 });
		const content = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, spacer, tall);
		const view = box(
			{ 'flex-direction': 'column', height: 4, overflow: 'hidden', width: 10 },
			content
		);
		lay(box({}, view));

		// scrolled past the row's start, so there is a move to make in both
		// directions and the smaller one is the claim
		view.scrollTo(0, 11);
		lay(box({}, view));

		expect(scrollIntoView(tall)).toBe(true);
		// showing the end would keep it where it is; showing the start is six rows
		// back, which is the smaller of the two moves and the useful half of a row
		// that cannot fit
		expect(view.scroll?.y).toBe(6);
	});

	it('should scroll forward only as far as the start of a row taller than the view', () => {
		// the branch the test above does not reach: there the row starts above the
		// view, so the move is the unconditional one. Here it starts *inside* and
		// ends past the bottom, which is where the two candidate moves differ --
		// showing the end is six rows and showing the start is one
		const tall = box({ focusable: true, height: 9, id: 'tall', width: 4 });
		const spacer = box({ height: 1, width: 4 });
		const content = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, spacer, tall);
		const view = box(
			{ 'flex-direction': 'column', height: 4, overflow: 'hidden', width: 10 },
			content
		);
		lay(box({}, view));

		expect(scrollIntoView(tall)).toBe(true);
		expect(view.scroll?.y).toBe(1);
	});

	it('should scroll every clipping ancestor, carrying what the nearer one moved', () => {
		// the accumulation this exists for: scrolling the inner view moves the row
		// and leaves the inner view where it is, so the outer one has to be asked
		// about where the row got to rather than about the box the arrange gave it
		const { rows, view: inner } = list(10, 4);
		const spacer = box({ height: 6, width: 10 });
		// and a trailing spacer, so that the outer box has room past the answer: the
		// first version of this had the outer range stop at exactly six, which is
		// where the unaccumulated reading would have been clamped to -- so both
		// readings agreed and the test said nothing
		const after = box({ height: 12, width: 10 });
		const column = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, spacer, inner, after);
		const outer = box(
			{ 'flex-direction': 'column', height: 4, id: 'outer', overflow: 'hidden', width: 12 },
			column
		);
		lay(box({}, outer), 20, 20);

		expect(scrollRange(outer).y).toBe(18);
		expect(scrollIntoView(rows[7])).toBe(true);
		expect(inner.scroll?.y).toBe(4);
		// the row ends up on the inner view's last line, which is row 9 of the
		// outer content, and the outer view holds four. Read without the
		// accumulation it is row 13 and the answer is ten
		expect(outer.scroll?.y).toBe(6);
	});

	it('should report nothing for an element nothing has laid out', () => {
		const { rows } = list(10);
		expect(scrollIntoView(rows[7])).toBe(false);
	});
});

describe('paint culling', () => {
	/** A `raw` element that records every time paint asked it to draw. */
	function counted(label: string, drawn: string[]): Element {
		return raw(
			{
				measure: () => ({ height: 1, width: 4 }),
				paint: () => {
					drawn.push(label);
				},
			},
			{ height: 1, width: 4 }
		);
	}

	it('should not walk a subtree whose extent misses its clip', () => {
		const drawn: string[] = [];
		const rows = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => counted(label, drawn));
		const content = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, ...rows);
		const view = box(
			{ 'flex-direction': 'column', height: 2, overflow: 'hidden', width: 6 },
			content
		);
		lay(box({}, view));
		paint(view, new Painter(new CellBuffer(6, 2), new StyleTable()));

		expect(drawn).toStrictEqual(['a', 'b']);

		drawn.length = 0;
		view.scrollTo(0, 3);
		lay(box({}, view));
		paint(view, new Painter(new CellBuffer(6, 2), new StyleTable()));

		expect(drawn).toStrictEqual(['d', 'e']);
	});

	it('should draw what it drew before, because a cull changes no cell', () => {
		// the differential the whole optimization rests on: the cells are the cells,
		// and the only thing culling removes is work
		const build = (): Element => {
			const rows = Array.from({ length: 8 }, (_, i) => text(`row ${i}`));
			const content = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, ...rows);
			return box({ 'flex-direction': 'column', height: 3, overflow: 'hidden', width: 8 }, content);
		};

		for (const offset of [0, 1, 4, 5]) {
			const view = build();
			lay(box({}, view), 8, 3);
			view.scrollTo(0, offset);
			lay(box({}, view), 8, 3);
			expect(picture(view, 8, 3), `at ${offset}`).toStrictEqual([
				`row ${offset}`,
				`row ${offset + 1}`,
				`row ${offset + 2}`,
			]);
		}
	});

	it('should keep a child drawn outside a parent that misses the clip', () => {
		// the unsound rule this exists to refuse: the parent's box is above the
		// clip and its child reaches into it, so culling on the parent's own box
		// would delete a row that is on screen
		const drawn: string[] = [];
		const escapee = counted('escapee', drawn);
		escapee.setProps({ position: 'relative', top: 3 });
		const parent = box({ height: 1, width: 4 }, escapee);
		const content = box({ 'flex-direction': 'column', 'flex-shrink': 0 }, parent);
		const view = box(
			{ 'flex-direction': 'column', height: 4, overflow: 'hidden', width: 6 },
			content
		);
		lay(box({}, view));
		view.scrollTo(0, 2);
		lay(box({}, view));
		paint(view, new Painter(new CellBuffer(6, 4), new StyleTable()));

		expect(parent.box?.y).toBe(-2);
		expect(drawn).toStrictEqual(['escapee']);
	});
});

describe('hit test culling', () => {
	/**
	 * Takes the extents off a subtree, which is how the cull is turned off.
	 *
	 * The guard is written `element.extent && ...`, so a tree with no extents takes
	 * the uncut walk -- one binary, one function, the guard disabled by removing
	 * its input rather than by a second copy of `hitTest()`. The same method the
	 * benchmark and the paint cull's own tests use, for the same reason: two
	 * implementations of a walk are two things that can drift.
	 */
	function clearExtents(element: Element): void {
		element.extent = undefined;
		for (const child of element.children) {
			clearExtents(child);
		}
	}

	/**
	 * Which elements the walk descended into, by shadowing `children`.
	 *
	 * `hitTest()` asks the cull before it asks `paintOrder()`, and `paintOrder()`
	 * is what reads `children` -- so an element whose `children` was read is
	 * exactly an element the cull let through. The counting equivalent of the
	 * `raw` element the paint cull's test counts, and the only thing that can tell
	 * a cull that works from a cull that is not there: the *answer* is the same
	 * either way, which is what makes this a fast path and what made the first
	 * version of these tests say nothing at all.
	 */
	function watchWalk(root: Element): Set<Element> {
		const entered = new Set<Element>();
		const walk = (element: Element): void => {
			const own = element.children;
			Object.defineProperty(element, 'children', {
				configurable: true,
				get(): readonly Element[] {
					entered.add(element);
					return own;
				},
			});
			for (const child of own) {
				walk(child);
			}
		};
		walk(root);
		return entered;
	}

	it('should answer the same element the uncut walk would', () => {
		// the differential, and what makes the cull safe to have: over every cell of
		// the viewport, with the extents and without them, the answer is the same
		const { view } = list(10);
		lay(box({}, view));
		view.scrollTo(0, 4);
		lay(box({}, view));

		const culled: (string | undefined)[] = [];
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 10; x++) {
				culled.push(hitTest(view, x, y)?.text);
			}
		}

		clearExtents(view);
		const whole: (string | undefined)[] = [];
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 10; x++) {
				whole.push(hitTest(view, x, y)?.text);
			}
		}

		expect(culled).toStrictEqual(whole);
		// and it really did answer something, or the comparison is two empty lists
		expect(culled.filter(Boolean).length).toBeGreaterThan(0);
		expect(culled[0]).toBe('row 4');
	});

	it('should not walk the rows the extent rules out', () => {
		const { rows, view } = list(40);
		lay(box({}, view));

		const entered = watchWalk(view);
		expect(hitTest(view, 0, 1)).toBe(rows[1]);
		expect([...entered].filter((element) => rows.includes(element))).toStrictEqual([rows[1]]);

		// and without the extents the same walk enters all forty to find out that
		// thirty-nine of them are not under the point
		clearExtents(view);
		const bare = watchWalk(view);
		expect(hitTest(view, 0, 1)).toBe(rows[1]);
		expect(bare.size).toBeGreaterThanOrEqual(rows.length);
	});

	it('should not reach a row the clip cut away', () => {
		const { rows, view } = list(10);
		lay(box({}, view));

		// row 9 has a box, below the viewport, and nothing may hit it there. The
		// clip is what refuses it rather than the cull, which is why this one stays
		// green with the extents cleared -- it pins the clip, and the two tests
		// above pin the cull
		expect(rows[9].box?.y).toBe(9);
		expect(hitTest(view, 0, 9)).toBeUndefined();
	});
});
