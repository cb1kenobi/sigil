import { createCanvas } from '../../src/canvas/index.js';
import {
	arrange,
	arrangedExtent,
	box,
	createTree,
	type Element,
	paint,
	resolveStyles,
	text,
} from '../../src/element/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Out-of-flow positioning, paint order, and clipping.
 *
 * Read as pictures for the reason the layout tests give: this is arithmetic
 * about where things land, and a failing assertion that prints two grids says
 * what went wrong while one that prints a box does not.
 */

/** Resolves, lays out, paints, and reads the cells back as rows of text. */
function picture(root: Element, width: number, height: number): string {
	const canvas = createCanvas({ height, width });
	resolveStyles(root);
	arrange(root, { height, width });
	canvas.paint((painter) => paint(root, painter));
	// padded before the substitution, because `toString()` trims a row's trailing
	// blanks and a picture is about where things are not as much as where they are
	return canvas
		.toString()
		.split('\n')
		.map((row) => row.padEnd(width, ' ').replaceAll(' ', '.'))
		.join('\n');
}

describe('position: absolute', () => {
	it('should take a box out of flow without moving what is left', () => {
		// an overlay that reflowed the panel underneath it would be an overlay
		// nobody could use, which is why CSS takes it out and why this does
		const flow = box(
			{ 'flex-direction': 'column', height: '3', width: '6' },
			text('aa'),
			text('bb')
		);
		const withOverlay = box(
			{ 'flex-direction': 'column', height: '3', width: '6' },
			text('aa'),
			text('XX', { left: '4', position: 'absolute', top: '0' }),
			text('bb')
		);

		expect(picture(flow, 6, 3)).toBe(['aa....', 'bb....', '......'].join('\n'));
		// `bb` is still on row one: the overlay took no space on the way past
		expect(picture(withOverlay, 6, 3)).toBe(['aa..XX', 'bb....', '......'].join('\n'));
	});

	it('should resolve against the nearest positioned ancestor', () => {
		// the containing-block rule, which is worth keeping because everybody
		// already knows it: a dropdown anchors to the panel it was written inside
		const anchored = box(
			{ height: '4', padding: '1', position: 'relative', width: '6' },
			text('X', { left: '0', position: 'absolute', top: '0' })
		);
		// the padding box, so the anchor is the panel's edge and not its text
		expect(picture(anchored, 6, 4)).toBe(['X.....', '......', '......', '......'].join('\n'));

		// with nothing positioned between it and the root, it anchors to the root
		const loose = box(
			{ height: '4', padding: '1', width: '6' },
			box({ height: '2', width: '4' }, text('X', { position: 'absolute', right: '0', top: '1' }))
		);
		expect(picture(loose, 6, 4)).toBe(['......', '.....X', '......', '......'].join('\n'));
	});

	it('should size itself from two insets, a declaration, or its content', () => {
		const stretched = box(
			{ height: '3', position: 'relative', width: '8' },
			text('ab cd ef', { left: '1', position: 'absolute', right: '1', top: '0' })
		);
		// six columns between the insets, so the text wraps to them
		expect(picture(stretched, 8, 3)).toBe(['.ab.cd..', '.ef.....', '........'].join('\n'));

		const shrunk = box(
			{ height: '2', position: 'relative', width: '8' },
			text('hi', { position: 'absolute', right: '0', top: '1' })
		);
		expect(picture(shrunk, 8, 2)).toBe(['........', '......hi'].join('\n'));
	});

	it('should not size the parent it was taken out of', () => {
		// CSS says it does not participate in intrinsic sizing, and that is the
		// useful answer: a dropdown that made its panel wider could not be placed
		const shrinkToFit = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'row' },
			box(
				{ 'flex-direction': 'column', position: 'relative' },
				text('ab'),
				text('a much longer line', { left: '0', position: 'absolute', top: '0' })
			)
		);

		resolveStyles(shrinkToFit);
		arrange(shrinkToFit, { height: 4, width: 40 });
		expect(shrinkToFit.children[0].box?.width).toBe(2);
	});

	it('should pin a fixed box to the canvas whatever contains it', () => {
		// a status line at the bottom of a full-screen app, which is what `fixed`
		// is for and the one thing an ancestor must not be able to move
		const app = box(
			{ height: '4', padding: '1', position: 'relative', width: '8' },
			box(
				{ height: '2', position: 'relative', width: '4' },
				text('st', { bottom: '0', left: '0', position: 'fixed' })
			)
		);

		expect(picture(app, 8, 4)).toBe(['........', '........', '........', 'st......'].join('\n'));
	});
});

describe('paint order', () => {
	it('should paint a later sibling over an earlier one', () => {
		const stack = box(
			{ height: '1', position: 'relative', width: '4' },
			text('aaaa', { left: '0', position: 'absolute', top: '0' }),
			text('bb', { left: '0', position: 'absolute', top: '0' })
		);

		expect(picture(stack, 4, 1)).toBe('bbaa');
	});

	it('should let z-index lift a box over a later sibling', () => {
		const lifted = box(
			{ height: '1', position: 'relative', width: '4' },
			text('aaaa', { left: '0', position: 'absolute', 'z-index': '1', top: '0' }),
			text('bb', { left: '0', position: 'absolute', top: '0' })
		);

		expect(picture(lifted, 4, 1)).toBe('aaaa');
	});

	it('should keep a subtree together rather than letting a descendant escape', () => {
		// a stacking context by another name: a child ordered above its sibling
		// takes its own descendants with it, and a descendant's own `z-index`
		// orders it inside that child rather than against the whole tree. Without
		// it `z-index` is a global free-for-all and every component fights over
		// integers
		const root = box(
			{ height: '1', position: 'relative', width: '6' },
			box(
				{ height: '1', left: '0', position: 'absolute', top: '0', 'z-index': '2', width: '6' },
				text('above', { left: '0', position: 'absolute', 'z-index': '-5', top: '0' })
			),
			text('BBBBBB', { left: '0', position: 'absolute', top: '0', 'z-index': '1' })
		);

		// the inner `-5` loses to its own parent's `2`, so it is still on top
		expect(picture(root, 6, 1)).toBe('aboveB');
	});
});

describe('overflow', () => {
	it('should clip what a child draws to the padding box', () => {
		const clipped = box(
			{ height: '2', overflow: 'hidden', width: '4' },
			text('abcdef ghij', { 'white-space': 'nowrap' })
		);

		expect(picture(clipped, 8, 2)).toBe(['abcd....', '........'].join('\n'));
	});

	it('should not clip the box its own border draws', () => {
		// the border *is* the edge, and a box that clipped itself would erase the
		// frame it is drawing
		const framed = box(
			{ border: 'single', height: '3', overflow: 'hidden', width: '4' },
			text('abcdef', { 'white-space': 'nowrap' })
		);

		expect(picture(framed, 6, 3)).toBe(['┌──┐..', '│ab│..', '└──┘..'].join('\n'));
	});

	it('should blank a wide cluster the clip cuts in half', () => {
		// half a glyph is worse than none, which the grid already said for its own
		// right edge -- a clip edge is the same edge one column in
		// two columns: `a` takes the first, and `漢` wants the second and a third
		// that the clip does not allow
		const half = box(
			{ height: '1', overflow: 'hidden', width: '2' },
			text('a漢字', { 'white-space': 'nowrap' })
		);

		expect(picture(half, 6, 1)).toBe('a.....');

		// and one column further out it fits, which is what says the blank above
		// was the clip rather than the text
		const whole = box(
			{ height: '1', overflow: 'hidden', width: '3' },
			text('a漢字', { 'white-space': 'nowrap' })
		);
		// one dot per *character* of padding, and a wide cluster is one character
		expect(picture(whole, 6, 1)).toBe('a漢....');
	});

	it('should nest, so an inner clip cannot paint past an outer one', () => {
		const nested = box(
			{ height: '1', overflow: 'hidden', width: '3' },
			box(
				{ height: '1', overflow: 'hidden', width: '10' },
				text('abcdefghij', { 'white-space': 'nowrap' })
			)
		);

		expect(picture(nested, 8, 1)).toBe('abc.....');
	});

	it('should carry the clip on the tree rather than leaving it to the paint walk', () => {
		// which is what lets the hit test ask about the same rectangle paint drew
		// inside: a box clipped by an ancestor is not hittable where it is clipped, and
		// two walks computing one intersection is two answers to one question
		const deep = text('x');
		const inner = box({ height: 4, overflow: 'hidden', width: 4 }, deep);
		const outer = box({ height: 2, overflow: 'hidden', width: 6 }, inner);
		const root = box({ height: 8, width: 10 }, outer);

		resolveStyles(root);
		arrange(root, { height: 8, width: 10 });

		// nothing above the outer box clips, so it draws wherever it likes -- including
		// its own border, which is the edge and is never its own to clip
		expect(root.clip).toBeUndefined();
		expect(outer.clip).toBeUndefined();
		// and what it clips *for* is the rectangle its children are subject to
		expect(inner.clip).toEqual({ height: 2, width: 6, x: 0, y: 0 });
		// intersected rather than replaced, which is what the nesting means
		expect(deep.clip).toEqual({ height: 2, width: 4, x: 0, y: 0 });
	});

	it('should take the border off the rectangle a box clips to', () => {
		// the padding box, which is what CSS clips to: the border is the edge, so a box
		// that clipped itself would erase the frame it is drawing
		const child = text('x');
		const root = box({ border: 'single', height: 4, overflow: 'hidden', width: 6 }, child);

		resolveStyles(root);
		arrange(root, { height: 6, width: 10 });

		expect(child.clip).toEqual({ height: 2, width: 4, x: 1, y: 1 });
	});
});

/** Arranges a tree and asks how much room the drawing it produced takes. */
function roomFor(root: Element, width: number, height: number): { height: number; width: number } {
	resolveStyles(root);
	arrange(root, { height, width });
	return arrangedExtent(root);
}

/** A column of rows that keeps its own size, which is what a clip has to hide. */
function stubbornRows(...rows: string[]): Element {
	return box({ 'flex-direction': 'column', 'flex-shrink': 0 }, ...rows.map((row) => text(row)));
}

describe('the room an arranged tree takes', () => {
	// SIG-130. The clip was right and the grid was not: only `r1` is ever drawn,
	// and `renderToString()` still reserved four rows for a box nobody can see.
	// A child that *can* shrink does not reproduce it -- `flex-shrink` defaults to
	// 1, so it is squeezed to the window and its box never exceeds the clip
	it('should take no room for the rows a clip hides', () => {
		const pane = box({ height: 1, overflow: 'hidden', width: 6 }, stubbornRows('r1', 'r2', 'r3'));

		expect(roomFor(box({ 'flex-direction': 'column' }, pane), 40, 3)).toEqual({
			height: 1,
			width: 6,
		});
	});

	// the width half of the same defect, which `renderToString()` masks: it strips
	// a line's trailing blanks, so a ten-column reel in a one-column window prints
	// as one character over a grid that was still ten wide. Asserted here rather
	// than through the string for exactly that reason
	it('should take no room for the columns a clip hides', () => {
		const reel = box(
			{ height: 1, overflow: 'hidden', width: 1 },
			text('0123456789', { 'flex-shrink': 0, 'white-space': 'nowrap' })
		);

		expect(roomFor(box({ 'flex-direction': 'column' }, reel), 40, 1)).toEqual({
			height: 1,
			width: 1,
		});
	});

	// the regression risk, and the whole difficulty of the ticket: the question is
	// "how much room does the answer take" rather than "did anything escape", so
	// overflow nothing clips is legitimate and is what makes a flag name longer
	// than the terminal survive
	it('should still take room for overflow nothing clips', () => {
		const wide = box(
			{ height: 1, width: 4 },
			text('abcdefghij', { 'flex-shrink': 0, 'white-space': 'nowrap' })
		);
		const tall = box({ height: 1, width: 4 }, stubbornRows('r1', 'r2', 'r3'));

		expect(roomFor(box({ 'flex-direction': 'column' }, wide), 4, 1)).toEqual({
			height: 1,
			width: 10,
		});
		expect(roomFor(box({ 'flex-direction': 'column' }, tall), 4, 1)).toEqual({
			height: 3,
			width: 4,
		});
	});

	// a clipping box is where the walk stops, so the *clamp* is only ever reached
	// below a clipping root -- which is a tree somebody writes: a pane rendered to
	// a string on its own. Its own box is the space the call was offered and is
	// skipped, so what answers for it is its children, clamped.
	//
	// The column is the pane's **main** axis here, which is what makes the clamp
	// bite rather than the guard below it. In a `row` pane the same child is
	// crushed to the window by `align-items: stretch` -- `flex-shrink` is a main
	// axis rule -- so its own box never exceeds the clip and every row past the
	// first is refused for not reaching it instead. The first version of this test
	// was that tree, and it passed with the clamp deleted
	it('should clamp a child to a clip the root itself draws', () => {
		const pane = box(
			{ 'flex-direction': 'column', height: 1, overflow: 'hidden', width: 6 },
			stubbornRows('r1', 'r2', 'r3')
		);

		expect(roomFor(pane, 40, 3)).toEqual({ height: 1, width: 6 });
	});

	// and the same clamp on a box that clips in turn, which is what says the stop
	// at a clipping box is not a licence to report its whole border box: the inner
	// pane is ten columns wide inside a three-column clip
	it('should clamp a clipping box to the clip it is inside', () => {
		const inner = box(
			{ height: 1, overflow: 'hidden', width: 10 },
			text('abcdefghij', { 'flex-shrink': 0, 'white-space': 'nowrap' })
		);
		const outer = box({ height: 1, overflow: 'hidden', width: 3 }, inner);

		expect(roomFor(outer, 40, 1)).toEqual({ height: 1, width: 3 });
	});

	// an empty intersection is still a rectangle *somewhere*, so the clamp alone
	// would report row two and column ten for an overlay anchored twenty columns
	// out: `min(box.bottom, clip.bottom)` says nothing about whether the other
	// axis ever met
	it('should take no room for a box the clip does not reach', () => {
		const away = box({ height: 8, left: 20, position: 'absolute', top: 0, width: 5 });
		const pane = box(
			{ height: 2, overflow: 'hidden', position: 'relative', width: 10 },
			box({ 'flex-shrink': 0, height: 1, width: 5 }),
			away
		);

		expect(roomFor(pane, 40, 10)).toEqual({ height: 1, width: 5 });
	});

	// `layoutNode()` returns before it reaches a hidden node's children, so
	// `arrange()` finds no result for any of them and leaves whatever boxes a
	// *previous* arrange wrote. Walking the element tree is what makes that
	// reachable, and it takes a tree that was laid out visible first -- the boxes
	// have to be stale rather than absent
	it('should take no room for a subtree hidden after it was laid out', () => {
		const panel = box({ 'flex-shrink': 0 }, text('deep', { height: 3, width: 9 }));
		const tree = box({ 'flex-direction': 'column' }, text('x'), panel);

		expect(roomFor(tree, 10, 5)).toEqual({ height: 4, width: 10 });

		panel.setProps({ display: 'none' });

		expect(roomFor(tree, 10, 5)).toEqual({ height: 1, width: 10 });
	});

	// the same staleness one level up: the root's own box is skipped and its
	// children are not, so a hidden root has to be asked about separately
	it('should take no room for a root hidden after it was laid out', () => {
		const tree = box({ 'flex-direction': 'column' }, text('x', { height: 4 }));

		expect(roomFor(tree, 10, 5)).toEqual({ height: 4, width: 10 });

		tree.setProps({ display: 'none', 'flex-direction': 'column' });

		expect(roomFor(tree, 10, 5)).toEqual({ height: 0, width: 0 });
	});

	// nothing has laid this out, so there is no room it takes -- the same honest
	// zero `scrollRange()` gives a box nothing has arranged
	it('should take no room for a tree nothing has arranged', () => {
		expect(arrangedExtent(box({}, text('x')))).toEqual({ height: 0, width: 0 });
		expect(arrangedExtent(text('x'))).toEqual({ height: 0, width: 0 });
	});
});

describe('scrolling', () => {
	it('should move what a clipping box contains', () => {
		const list = box({ 'flex-direction': 'column', height: '2', overflow: 'hidden', width: '4' });
		for (const line of ['one', 'two', 'six', 'ten']) {
			list.append(text(line));
		}

		expect(picture(list, 4, 2)).toBe(['one.', 'two.'].join('\n'));

		list.scrollTo(0, 2);
		expect(picture(list, 4, 2)).toBe(['six.', 'ten.'].join('\n'));
	});

	it('should put the boxes where they are drawn', () => {
		// a scrolled child's box has to *be* where it is drawn: everything above
		// matches a box to an element, and an offset applied at paint time would
		// make `box` a position nothing is at
		const list = box({ 'flex-direction': 'column', height: '2', overflow: 'hidden', width: '4' });
		const second = text('two');
		list.append(text('one'), second);

		resolveStyles(list);
		arrange(list, { height: 2, width: 4 });
		expect(second.box?.y).toBe(1);

		list.scrollTo(0, 1);
		arrange(list, { height: 2, width: 4 });
		expect(second.box?.y).toBe(0);
	});

	it('should ignore a scroll on a box that does not clip', () => {
		// scrolling what is not clipped moves content out from under nothing
		const open = box(
			{ 'flex-direction': 'column', height: '2', width: '4' },
			text('one'),
			text('two')
		);
		open.scrollTo(0, 1);

		expect(picture(open, 4, 2)).toBe(['one.', 'two.'].join('\n'));
	});

	it('should mark layout rather than paint', () => {
		const list = box({ overflow: 'hidden' });
		const tree = createTree(list);

		list.scrollTo(0, 3);
		expect(tree.marks.layout).toEqual(new Set([list]));
		expect(tree.marks.paint.size).toBe(0);
	});
});
