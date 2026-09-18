import { createCanvas } from '../../src/canvas/index.js';
import {
	arrange,
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
