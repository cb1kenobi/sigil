import { distribute, layout, measureNode } from '../../src/layout/index.js';
import { declare } from '../../src/style/index.js';
import { box, boxes, checkInvariants, picture, text } from './helpers.js';
import { describe, expect, it } from 'vitest';

describe('distribute', () => {
	it('should hand out whole cells that add up to the total', () => {
		// the spare cell moves forward, so it lands on the last column rather than
		// in the middle of the row
		expect(distribute(7, [1, 1, 1])).toEqual([2, 2, 3]);
		expect(distribute(10, [1, 1])).toEqual([5, 5]);
		// exactly 7.5 and 2.5: the half carried forward is what makes it 7 and 3
		expect(distribute(10, [3, 1])).toEqual([7, 3]);
	});

	it('should always add up, whatever the weights', () => {
		for (const total of [0, 1, 7, 13, 100]) {
			for (const weights of [[1], [1, 1], [1, 2, 3], [5, 1, 1, 1], [0, 1, 0, 1]]) {
				const parts = distribute(total, weights);
				expect(
					parts.reduce((a, b) => a + b, 0),
					`${total} across ${weights.join(',')}`
				).toBe(total);
				expect(parts.every((n) => Number.isInteger(n))).toBe(true);
			}
		}
	});

	it('should give nothing to a zero weight', () => {
		expect(distribute(10, [0, 1, 0])).toEqual([0, 10, 0]);
	});

	it('should be stable, so a layout does not shimmer between frames', () => {
		const first = distribute(7, [1, 1, 1]);
		const again = distribute(7, [1, 1, 1]);
		expect(first).toEqual(again);
	});

	it('should hand out nothing when there is nothing to hand out', () => {
		expect(distribute(0, [1, 2])).toEqual([0, 0]);
		expect(distribute(10, [])).toEqual([]);
		expect(distribute(10, [0, 0])).toEqual([0, 0]);
	});
});

describe('a row', () => {
	it('should place children left to right', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '3', height: '2' }),
			box({ width: '4', height: '2' })
		);

		expect(picture(tree, 10, 2)).toBe(['bbbccccaaa', 'bbbccccaaa'].join('\n'));
	});

	it('should separate children by the gap', () => {
		const tree = box(
			{ 'flex-direction': 'row', gap: '2' },
			box({ width: '2', height: '1' }),
			box({ width: '2', height: '1' })
		);

		expect(picture(tree, 8, 1)).toBe('bbaaccaa');
	});

	it('should grow a child into the space left over', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '3', height: '1' }),
			box({ 'flex-grow': '1', height: '1' })
		);

		expect(picture(tree, 10, 1)).toBe('bbbccccccc');
	});

	it('should share leftover space between two growing children', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-grow': '1', height: '1' }),
			box({ 'flex-grow': '1', height: '1' })
		);

		expect(picture(tree, 10, 1)).toBe('bbbbbccccc');
	});

	it('should split an odd remainder without losing a cell', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-grow': '1', height: '1' }),
			box({ 'flex-grow': '1', height: '1' }),
			box({ 'flex-grow': '1', height: '1' })
		);

		// seven across three: nobody gets two and a third, and no column is left
		// unaccounted for
		const picture7 = picture(tree, 7, 1);
		expect(picture7).not.toContain('.');
		expect(picture7.length).toBe(7);
	});

	it('should weight growth by flex-grow', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-grow': '1', height: '1' }),
			box({ 'flex-grow': '3', height: '1' })
		);

		expect(picture(tree, 8, 1)).toBe('bbcccccc');
	});

	it('should shrink children that do not fit', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '8', height: '1' }),
			box({ width: '8', height: '1' })
		);

		const result = picture(tree, 10, 1);
		expect(result.length).toBe(10);
		expect(result).not.toContain('.');
	});

	it('should not shrink a child below its min-width', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '8', 'min-width': '6', height: '1' }),
			box({ width: '8', height: '1' })
		);

		const [, first] = boxes(layout(tree, { height: 1, width: 10 }));
		expect(first.width).toBeGreaterThanOrEqual(6);
	});

	it('should not grow a child past its max-width', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-grow': '1', 'max-width': '4', height: '1' })
		);

		const [, first] = boxes(layout(tree, { height: 1, width: 10 }));
		expect(first.width).toBe(4);
	});
});

describe('a column', () => {
	it('should place children top to bottom', () => {
		const tree = box(
			{ 'flex-direction': 'column' },
			box({ height: '1', width: '4' }),
			box({ height: '2', width: '4' })
		);

		expect(picture(tree, 4, 3)).toBe(['bbbb', 'cccc', 'cccc'].join('\n'));
	});

	it('should grow a child down the page', () => {
		const tree = box(
			{ 'flex-direction': 'column' },
			box({ height: '1', width: '3' }),
			box({ 'flex-grow': '1', width: '3' })
		);

		expect(picture(tree, 3, 4)).toBe(['bbb', 'ccc', 'ccc', 'ccc'].join('\n'));
	});
});

describe('padding and border', () => {
	it('should inset children by the padding', () => {
		const tree = box({ padding: '1' }, box({ 'flex-grow': '1', height: '1' }));

		expect(picture(tree, 5, 3)).toBe(['aaaaa', 'abbba', 'aaaaa'].join('\n'));
	});

	it('should take a cell on each edge for a border', () => {
		const tree = box({ border: 'single' }, box({ 'flex-grow': '1', height: '1' }));

		expect(picture(tree, 5, 3)).toBe(['aaaaa', 'abbba', 'aaaaa'].join('\n'));
	});

	it('should add the border to the padding', () => {
		const tree = box({ border: 'single', padding: '1' }, box({ 'flex-grow': '1', height: '1' }));

		expect(picture(tree, 7, 5)).toBe(
			['aaaaaaa', 'aaaaaaa', 'aabbbaa', 'aaaaaaa', 'aaaaaaa'].join('\n')
		);
	});
});

describe('margins', () => {
	it('should push a child away from its neighbours', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '2', height: '1', 'margin-right': '2' }),
			box({ width: '2', height: '1' })
		);

		expect(picture(tree, 8, 1)).toBe('bbaaccaa');
	});

	it('should push a child to the far end with an auto margin', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '2', height: '1', 'margin-left': 'auto' })
		);

		expect(picture(tree, 6, 1)).toBe('aaaabb');
	});
});

describe('justify-content', () => {
	const two = () =>
		box(
			{ 'flex-direction': 'row' },
			box({ width: '2', height: '1' }),
			box({ width: '2', height: '1' })
		);

	it('should start at the beginning by default', () => {
		expect(picture(two(), 8, 1)).toBe('bbccaaaa');
	});

	it('should push to the end', () => {
		const tree = two();
		tree.style = declare({ 'flex-direction': 'row', 'justify-content': 'flex-end' });
		expect(picture(tree, 8, 1)).toBe('aaaabbcc');
	});

	it('should centre', () => {
		const tree = two();
		tree.style = declare({ 'flex-direction': 'row', 'justify-content': 'center' });
		expect(picture(tree, 8, 1)).toBe('aabbccaa');
	});

	it('should space between', () => {
		const tree = two();
		tree.style = declare({ 'flex-direction': 'row', 'justify-content': 'space-between' });
		expect(picture(tree, 8, 1)).toBe('bbaaaacc');
	});
});

describe('align-items', () => {
	it('should stretch a child across the cross axis by default', () => {
		const tree = box({ 'flex-direction': 'row' }, box({ width: '2' }));
		expect(picture(tree, 4, 3)).toBe(['bbaa', 'bbaa', 'bbaa'].join('\n'));
	});

	it('should put a child at the start', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'align-items': 'flex-start' },
			box({ width: '2', height: '1' })
		);
		expect(picture(tree, 4, 3)).toBe(['bbaa', 'aaaa', 'aaaa'].join('\n'));
	});

	it('should put a child at the end', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'align-items': 'flex-end' },
			box({ width: '2', height: '1' })
		);
		expect(picture(tree, 4, 3)).toBe(['aaaa', 'aaaa', 'bbaa'].join('\n'));
	});

	it('should centre a child', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'align-items': 'center' },
			box({ width: '2', height: '1' })
		);
		expect(picture(tree, 4, 3)).toBe(['aaaa', 'bbaa', 'aaaa'].join('\n'));
	});

	it('should let a child override with align-self', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'align-items': 'flex-start' },
			box({ width: '2', height: '1', 'align-self': 'flex-end' })
		);
		expect(picture(tree, 4, 3)).toBe(['aaaa', 'aaaa', 'bbaa'].join('\n'));
	});
});

describe('display: none', () => {
	it('should take no space', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '3', height: '1', display: 'none' }),
			box({ width: '3', height: '1' })
		);

		// the hidden child is `b` and paints nothing; the visible one is `c` and
		// starts at column zero
		expect(picture(tree, 6, 1)).toBe('cccaaa');
	});

	it('should still get a result, so the children line up with the tree', () => {
		const hidden = box({ width: '3', height: '1', display: 'none' });
		const shown = box({ width: '3', height: '1' });
		const tree = box({ 'flex-direction': 'row' }, hidden, shown);

		// everything above this matches a box back to its element by index, and a
		// gap in that correspondence is a caveat nobody will remember
		const result = layout(tree, { height: 1, width: 6 });
		expect(result.children).toHaveLength(2);
		expect(result.children[0].node).toBe(hidden);
		expect(result.children[0].box).toMatchObject({ height: 0, width: 0 });
		expect(result.children[1].node).toBe(shown);
	});
});

describe('text', () => {
	it('should take the width of its content', () => {
		const tree = box({ 'flex-direction': 'row' }, text('hello'));
		const [, content] = boxes(layout(tree, { height: 1, width: 20 }));
		expect(content.width).toBe(5);
	});

	it('should grow taller when it has to wrap', () => {
		const tree = box({ 'flex-direction': 'column' }, text('one two three four five'));
		const result = layout(tree, { width: 10 });
		expect(result.children[0].box.height).toBeGreaterThan(1);
	});

	it('should not shrink below its longest word', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			text('antidisestablishmentarianism'),
			box({ width: '20', height: '1' })
		);

		const [, content] = boxes(layout(tree, { height: 1, width: 10 }));
		// shrinking text past its longest word only makes it taller, and in a row
		// that has no height to give
		expect(content.width).toBeGreaterThan(0);
	});

	it('should measure a wide character as two columns', () => {
		const tree = box({ 'flex-direction': 'row' }, text('漢字'));
		const [, content] = boxes(layout(tree, { height: 1, width: 20 }));
		expect(content.width).toBe(4);
	});
});

describe('wrapping', () => {
	it('should break onto a second line when children do not fit', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' })
		);

		const result = picture(tree, 7, 2);
		const [first, second] = result.split('\n');
		expect(first).toContain('b');
		expect(first).toContain('c');
		expect(second).toContain('d');
	});

	it('should keep everything on one line when it says nowrap', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'nowrap' },
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' })
		);

		const [, second] = picture(tree, 7, 2).split('\n');
		expect(second).toBe('aaaaaaa');
	});

	// the property was honoured when a line was packed and ignored when the box
	// was measured, so an auto-height wrapping row came out one line deep with
	// every line after the first drawn outside it
	it('should be as tall as the lines it wraps into', () => {
		const tree = box(
			{ 'flex-direction': 'column' },
			box(
				{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
				box({ width: '3', height: '1' }),
				box({ width: '3', height: '1' }),
				box({ width: '3', height: '1' })
			),
			box({ width: '7', height: '1' })
		);

		// `b` is the wrapping row and `f` the sibling under it: two rows of wrapped
		// children, with `f` below them rather than on top of the second one
		expect(picture(tree, 7, 3)).toBe('cccdddb\neeebbbb\nfffffff');
	});

	// the gap between one line and the next is reserved by the placement, so it
	// has to be reserved by the measure: a wrapping row with a `row-gap` came out
	// a row short per line break and the block under it was drawn on
	it('should count the gap between its lines', () => {
		const tree = box(
			{ 'flex-direction': 'column' },
			box(
				{ 'flex-direction': 'row', 'flex-wrap': 'wrap', 'row-gap': '1' },
				box({ width: '3', height: '1' }),
				box({ width: '3', height: '1' }),
				box({ width: '3', height: '1' })
			),
			box({ width: '7', height: '1' })
		);

		const result = layout(tree, { height: 10, width: 7 });
		expect(result.children[0].box).toMatchObject({ height: 3 });
		expect(result.children[1].box).toMatchObject({ y: 3 });
	});

	// a line is packed with the basis, which is what the placement packs with: a
	// child with `flex-basis: 40` and three columns of content takes forty on the
	// line it is placed on
	it('should pack its lines with the basis rather than the content', () => {
		const tree = box(
			{ 'flex-direction': 'column' },
			box(
				{ 'column-gap': '1', 'flex-direction': 'row', 'flex-wrap': 'wrap' },
				box({ 'flex-basis': '40', height: '1' }),
				box({ 'flex-basis': '40', height: '1' })
			),
			box({ width: '5', height: '1' })
		);

		const result = layout(tree, { height: 10, width: 50 });
		expect(result.children[0].box).toMatchObject({ height: 2 });
		expect(result.children[1].box).toMatchObject({ y: 2 });
	});

	// and in the order it is placed in, which is what `order` moves: the same
	// three children in two orders wrap into different lines
	it('should pack its lines in placement order', () => {
		const tree = box(
			{ 'flex-direction': 'column' },
			box(
				{ 'column-gap': '1', 'flex-direction': 'row', 'flex-wrap': 'wrap' },
				box({ width: '5', height: '1', order: '0' }),
				box({ width: '5', height: '1', order: '2' }),
				box({ width: '9', height: '1', order: '1' })
			),
			box({ width: '5', height: '1' })
		);

		const result = layout(tree, { height: 10, width: 12 });
		expect(result.children[0].box).toMatchObject({ height: 3 });
		expect(result.children[1].box).toMatchObject({ y: 3 });
	});

	// `declared ?? automatic`, which is what the placement reads, and not the
	// larger of the two: a `min-width: 0` is a declaration the automatic minimum
	// does not get a say in, and taking the larger packed a long word at its own
	// width where the placement shrinks it to the line
	it('should pack with the minimum the placement uses', () => {
		const tree = box(
			{ 'flex-direction': 'column' },
			box(
				{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
				text('a'.repeat(30), { 'flex-basis': '10', 'min-width': '0', 'white-space': 'nowrap' }),
				text('b'.repeat(30), { 'flex-basis': '10', 'min-width': '0', 'white-space': 'nowrap' })
			),
			box({ width: '5', height: '1' })
		);

		const result = layout(tree, { height: 10, width: 25 });
		expect(result.children[0].box).toMatchObject({ height: 1 });
		expect(result.children[1].box).toMatchObject({ y: 1 });
	});

	// the smallest a wrapping row can be is its widest single item, because
	// everything else can be pushed onto a line of its own
	it('should report its widest item as its minimum, not the sum', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box(
				{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
				box({ width: '4', height: '1' }),
				box({ width: '4', height: '1' })
			),
			box({ 'flex-grow': '1', height: '1' })
		);

		// the wrapping box shrinks to four and takes two rows rather than holding
		// the whole eight and pushing its sibling off the edge
		const [first] = picture(tree, 6, 2).split('\n');
		expect(first).toBe('ccccee');
	});
});

describe('order', () => {
	it('should change where a child is placed', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '2', height: '1', order: '2' }),
			box({ width: '2', height: '1', order: '1' })
		);

		// `b` is first in the tree and second on screen
		expect(picture(tree, 4, 1)).toBe('ccbb');
	});

	it('should leave the results in tree order', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '2', height: '1', order: '2' }),
			box({ width: '2', height: '1', order: '1' })
		);

		// `result.children[i]` still answers for `node.children[i]`, whatever the
		// placement did -- otherwise nothing above can match a box to its element
		const result = layout(tree, { height: 1, width: 4 });
		expect(result.children[0].node).toBe(tree.children?.[0]);
		expect(result.children[0].box.x).toBe(2);
		expect(result.children[1].box.x).toBe(0);
	});

	it('should be stable for equal orders', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '1', height: '1' }),
			box({ width: '1', height: '1' }),
			box({ width: '1', height: '1' })
		);

		expect(picture(tree, 3, 1)).toBe('bcd');
	});
});

describe('align-content', () => {
	const wrapped = (declarations: Record<string, string>) =>
		box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap', ...declarations },
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' })
		);

	it('should stretch the lines to fill the cross space by default', () => {
		const result = layout(wrapped({}), { height: 4, width: 4 });
		// the *lines* share the four rows, two each, so the second starts halfway
		// down. The items keep their declared height -- stretching a line is not
		// stretching what is on it
		expect(result.children[0].box.y).toBe(0);
		expect(result.children[1].box.y).toBe(2);
		expect(result.children.map((child) => child.box.height)).toEqual([1, 1]);
	});

	it('should stretch an item with no declared cross size to its line', () => {
		const tall = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
			box({ width: '3' }),
			box({ width: '3' })
		);
		const result = layout(tall, { height: 4, width: 4 });
		expect(result.children.map((child) => child.box.height)).toEqual([2, 2]);
	});

	it('should pack the lines at the start', () => {
		const result = layout(wrapped({ 'align-content': 'flex-start' }), { height: 4, width: 4 });
		expect(result.children[0].box.y).toBe(0);
		expect(result.children[1].box.y).toBe(1);
	});

	it('should pack the lines at the end', () => {
		const result = layout(wrapped({ 'align-content': 'flex-end' }), { height: 4, width: 4 });
		expect(result.children[1].box.y).toBe(3);
	});

	it('should centre the lines', () => {
		const result = layout(wrapped({ 'align-content': 'center' }), { height: 4, width: 4 });
		expect(result.children[0].box.y).toBe(1);
	});
});

describe('box-sizing', () => {
	it('should take a declared width as the outer box by default', () => {
		const tree = box({ 'flex-direction': 'row' }, box({ width: '6', padding: '1', height: '3' }));
		const result = layout(tree, { height: 3, width: 10 });
		// six columns on screen, which is what `width: 6` means in a terminal
		expect(result.children[0].box.width).toBe(6);
		expect(result.children[0].content.width).toBe(4);
	});

	it('should add the padding on for content-box', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '6', padding: '1', height: '3', 'box-sizing': 'content-box' })
		);
		const result = layout(tree, { height: 3, width: 10 });
		expect(result.children[0].box.width).toBe(8);
		expect(result.children[0].content.width).toBe(6);
	});
});

describe('nesting', () => {
	it('should lay out a tree several levels deep', () => {
		const tree = box(
			{ 'flex-direction': 'column', padding: '1' },
			box({ 'flex-direction': 'row', height: '1' }, box({ width: '2' }), box({ 'flex-grow': '1' })),
			box({ 'flex-grow': '1' })
		);

		// depth-first: the root is `a`, the row is `b`, its two children are `c`
		// and `d`, and the second top-level child is `e`. The row is covered
		// completely by its own children, so no `b` shows
		expect(picture(tree, 8, 4)).toBe(['aaaaaaaa', 'accdddda', 'aeeeeeea', 'aaaaaaaa'].join('\n'));
	});

	it('should give a child the space its parent padding left', () => {
		const tree = box({ padding: '2' }, box({ 'flex-grow': '1' }));
		const result = layout(tree, { height: 6, width: 10 });
		expect(result.children[0].box).toEqual({ height: 2, width: 6, x: 2, y: 2 });
	});
});

describe('degenerate sizes', () => {
	it('should survive a canvas with no room', () => {
		const tree = box({ 'flex-direction': 'row' }, box({ width: '3', height: '1' }));
		expect(() => layout(tree, { height: 0, width: 0 })).not.toThrow();
	});

	it('should survive a box larger than the space it was given', () => {
		const tree = box({ 'flex-direction': 'row' }, box({ width: '100', height: '100' }));
		const result = layout(tree, { height: 2, width: 4 });
		expect(result.box).toEqual({ height: 2, width: 4, x: 0, y: 0 });
	});

	it('should never produce a negative size', () => {
		const tree = box({ padding: '5' }, box({ 'flex-grow': '1' }));
		for (const region of boxes(layout(tree, { height: 2, width: 2 }))) {
			expect(region.width).toBeGreaterThanOrEqual(0);
			expect(region.height).toBeGreaterThanOrEqual(0);
		}
	});
});

describe('invariants', () => {
	it('should keep a min-width sibling inside the container', () => {
		// the flexible resolution started from the raw basis rather than the basis
		// already clamped to the item's own limits, so a sibling's `min-width` was
		// not accounted for while the space was handed to everyone else -- and the
		// trailing clamp then pushed it past the edge with the space already spent
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-grow': '1', height: '1' }),
			box({ 'min-width': '4', 'flex-grow': '0', height: '1' })
		);

		const result = layout(tree, { height: 1, width: 10 });
		expect(result.children.map((child) => child.box.width)).toEqual([6, 4]);
		checkInvariants(result);
	});

	it('should size a shrink-to-fit parent around its child min-width', () => {
		// a container with no declared size computed itself from its child's
		// *content* minimum and ignored the child's declared one, so it came out
		// zero wide with a six-wide child sitting outside it
		const tree = box(
			{ 'flex-direction': 'row' },
			box(
				{ 'flex-direction': 'row', 'flex-grow': '0', 'flex-shrink': '0', height: '1' },
				box({ 'min-width': '6', 'flex-grow': '0', 'flex-shrink': '0', height: '1' })
			)
		);

		const result = layout(tree, { height: 1, width: 40 });
		expect(result.children[0].box.width).toBeGreaterThanOrEqual(6);
		checkInvariants(result);
	});

	it('should hold a column of text at the height it needs', () => {
		// the automatic minimum size existed on the row axis and not the column
		// one, so text in a column was crushed to a single row while the same text
		// in a row was correctly held at its longest word
		const tree = box({ 'flex-direction': 'column', width: '3' }, text('one two three'));
		const result = layout(tree, { height: 1, width: 3 });
		expect(result.children[0].box.height).toBeGreaterThan(1);
	});

	it('should honor a declared size on the node it was handed', () => {
		// every other node's declared size is resolved by its parent, and the root
		// has no parent -- so `layout(panel, { width: 80 })` gave the panel eighty
		// columns however wide it said it was
		const panel = box({ width: '5', height: '2', 'flex-direction': 'row' });
		expect(layout(panel, { height: 10, width: 20 }).box).toEqual({
			height: 2,
			width: 5,
			x: 0,
			y: 0,
		});
	});

	it('should hold the invariants across a spread of trees', () => {
		const trees = [
			box({ 'flex-direction': 'row', gap: '1' }, box({ width: '3' }), box({ 'flex-grow': '1' })),
			box(
				{ 'flex-direction': 'column', padding: '1' },
				box({ height: '2' }),
				box({ 'flex-grow': '1' })
			),
			box(
				{ 'flex-direction': 'row', 'justify-content': 'space-evenly' },
				box({ width: '1' }),
				box({ width: '1' }),
				box({ width: '1' })
			),
			box(
				{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
				box({ width: '4' }),
				box({ width: '4' }),
				box({ width: '4' })
			),
			box({ 'flex-direction': 'row', border: 'single' }, box({ 'flex-grow': '1' })),
		];

		for (const [index, tree] of trees.entries()) {
			for (const [width, height] of [
				[0, 0],
				[1, 1],
				[10, 3],
				[40, 8],
			]) {
				const result = layout(tree, { height, width });
				expect(() => checkInvariants(result), `tree ${index} at ${width}x${height}`).not.toThrow();
			}
		}
	});

	it('should lay the same tree out identically twice', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'justify-content': 'space-around' },
			box({ 'flex-grow': '1' }),
			box({ width: '3' }),
			box({ 'flex-grow': '2' })
		);

		expect(boxes(layout(tree, { height: 3, width: 17 }))).toEqual(
			boxes(layout(tree, { height: 3, width: 17 }))
		);
	});
});

describe('justify-content shares its remainder', () => {
	const three = (justify: string) =>
		box(
			{ 'flex-direction': 'row', 'justify-content': justify },
			box({ width: '1', height: '1' }),
			box({ width: '1', height: '1' }),
			box({ width: '1', height: '1' })
		);

	it('should keep space-evenly gaps within a cell of each other', () => {
		// seven cells over four slots used to give three gaps of one and a trailing
		// gap of four, because a constant `Math.floor()` cannot hold a remainder
		const result = layout(three('space-evenly'), { height: 1, width: 10 });
		const xs = result.children.map((child) => child.box.x);
		const gaps = [xs[0], xs[1] - xs[0] - 1, xs[2] - xs[1] - 1, 10 - xs[2] - 1];
		expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
	});

	it('should put the last item flush to the edge for space-between', () => {
		// the defining property of space-between, and it held only when the free
		// space happened to divide exactly
		const tree = box(
			{ 'flex-direction': 'row', 'justify-content': 'space-between' },
			box({ width: '1', height: '1' }),
			box({ width: '1', height: '1' }),
			box({ width: '1', height: '1' }),
			box({ width: '1', height: '1' })
		);
		const result = layout(tree, { height: 1, width: 14 });
		const last = result.children[3].box;
		expect(last.x + last.width).toBe(14);
	});
});

describe('auto margins', () => {
	it('should share the free space between two adjacent auto margins', () => {
		// only the following item's leading margin was honoured; a preceding item's
		// own trailing auto counted towards the denominator and then did nothing
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '2', height: '1', 'margin-right': 'auto' }),
			box({ width: '2', height: '1', 'margin-left': 'auto' })
		);

		expect(picture(tree, 12, 1)).toBe('bbaaaaaaaacc');
	});

	it('should still centre a single item with auto on both sides', () => {
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '2', height: '1', 'margin-left': 'auto', 'margin-right': 'auto' })
		);
		expect(picture(tree, 10, 1)).toBe('aaaabbaaaa');
	});
});

describe('flexing from the basis', () => {
	it('should give two flex:1 columns the same width whatever their minimums', () => {
		// growing from the *clamped* size pays the minimum twice: the last fix
		// started there, so a column with a bigger min-content came out wider than
		// its equal-flex sibling
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ flex: '1', 'min-width': '2', height: '1' }),
			box({ flex: '1', 'min-width': '6', height: '1' })
		);

		expect(layout(tree, { height: 1, width: 20 }).children.map((c) => c.box.width)).toEqual([
			10, 10,
		]);
	});

	it('should still keep an inflexible min-width sibling inside the container', () => {
		// the case the last fix was for, which the correct version also has to keep
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-grow': '1', height: '1' }),
			box({ 'min-width': '4', 'flex-grow': '0', height: '1' })
		);

		const result = layout(tree, { height: 1, width: 10 });
		expect(result.children.map((c) => c.box.width)).toEqual([6, 4]);
		checkInvariants(result);
	});

	it('should let a declared-size box with children shrink', () => {
		// the automatic minimum is `min(content-based, specified)`. Reporting the
		// declared size flat meant every real panel -- one with children -- could
		// not shrink at all
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '8', height: '1' }, box({ width: '1', height: '1' })),
			box({ width: '8', height: '1' }, box({ width: '1', height: '1' }))
		);

		const result = layout(tree, { height: 1, width: 10 });
		expect(result.children.map((c) => c.box.width)).toEqual([5, 5]);
		checkInvariants(result);
	});
});

describe('reversed directions', () => {
	it('should pack a row-reverse from the right', () => {
		const tree = box(
			{ 'flex-direction': 'row-reverse' },
			box({ width: '2', height: '1' }),
			box({ width: '2', height: '1' })
		);

		// reversing the items moves main-start to the other edge, and the
		// justification has to move with it
		expect(picture(tree, 8, 1)).toBe('aaaaccbb');
	});

	it('should send flex-end to the left in a row-reverse', () => {
		const tree = box(
			{ 'flex-direction': 'row-reverse', 'justify-content': 'flex-end' },
			box({ width: '2', height: '1' }),
			box({ width: '2', height: '1' })
		);
		expect(picture(tree, 8, 1)).toBe('ccbbaaaa');
	});

	it('should pack wrap-reverse lines from the bottom', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap-reverse', 'align-content': 'flex-start' },
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' })
		);

		const result = layout(tree, { height: 4, width: 4 });
		const ys = result.children.map((c) => c.box.y).sort((a, b) => a - b);
		expect(ys[1]).toBe(3);
	});
});

describe('align-content shares its remainder', () => {
	it('should put the last line flush to the far edge for space-between', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap', 'align-content': 'space-between' },
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' }),
			box({ width: '3', height: '1' })
		);

		const result = layout(tree, { height: 8, width: 4 });
		const last = result.children[2].box;
		expect(last.y + last.height).toBe(8);
	});
});

describe('measurement', () => {
	it('should not count a border twice when measuring an empty box', () => {
		// `declaredWidth` is already the border box, and the empty branch added the
		// insets again -- so a bordered `width: 17` measured nineteen
		expect(measureNode(box({ width: '17', border: 'single', height: '3' }), 40)).toMatchObject({
			height: 3,
			width: 17,
		});
	});

	it('should measure a content-box declaration as its outer size', () => {
		expect(
			measureNode(box({ width: '10', height: '3', padding: '2', 'box-sizing': 'content-box' }), 40)
		).toMatchObject({ height: 7, width: 14 });
	});

	it('should apply padding to the axis it belongs to', () => {
		// `insets()` already answers for the axis and `makeItem()` swapped them
		// again, so a row container read the vertical inset as its main one
		const tree = box(
			{ 'flex-direction': 'row', 'align-items': 'flex-start' },
			box({ width: '6', height: '1', 'padding-left': '2', 'box-sizing': 'content-box' })
		);
		expect(layout(tree, { height: 5, width: 20 }).children[0].box).toMatchObject({
			height: 1,
			width: 8,
		});
	});

	it('should give text the height its resolved width needs', () => {
		// the first measure happens at the whole content box, before any flexing --
		// two texts sharing twenty columns each measured twenty wide and one row
		// tall, then got ten each and stayed one row
		const tree = box(
			{ 'flex-direction': 'row', 'align-items': 'flex-start' },
			text('aaaa bbbb cccc dddd'),
			text('eeee ffff gggg hhhh')
		);

		const result = layout(tree, { height: 5, width: 20 });
		expect(result.children.map((c) => c.box.height)).toEqual([2, 2]);
	});

	it('should measure a column child at the width its own max-width leaves it', () => {
		// a column's width is its *cross* size, so the post-flex re-measure in
		// `placeLine()` is a row's alone -- and a `max-width` decides the column
		// child's width outright. Measured at the container's twenty this text
		// wrapped to two rows, and was then placed six wide, where it needs six
		const tree = box(
			{ 'flex-direction': 'column', width: '20' },
			text('one two three four five six', { 'max-width': '6' })
		);

		const result = layout(tree, { height: 10, width: 20 });
		expect(result.children[0].box).toMatchObject({ height: 6, width: 6 });
		checkInvariants(result);
	});

	it('should size an auto column around what its max-width child really needs', () => {
		// the same width has to reach the *intrinsic* measure, or the fix above only
		// moves the error: the column asked how tall its child was at twenty columns,
		// got two, and was drawn two rows around a child six rows tall
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'row', width: '20' },
			box({ 'flex-direction': 'column' }, text('one two three four five six', { 'max-width': '6' }))
		);

		const result = layout(tree, { height: 10, width: 20 });
		expect(result.children[0].box.height).toBe(6);
		checkInvariants(result);
	});

	it('should lay a text out at the width its own limit leaves it', () => {
		// `measure()` had one argument doing two jobs: the width to lay the content
		// out in, and the block a percentage resolves against. A declared `width`
		// won over the clamp so that the second job stayed correct, and the text was
		// then wrapped for a width the box never had -- six wide, three rows, around
		// six rows of text, so half of it was simply gone. The two jobs are two
		// arguments now, so the declaration is resolved against the containing block
		// and the content is laid out at what the limit left
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'row', width: '20' },
			text('one two three four five six', { 'max-width': '6', width: '10' })
		);

		expect(layout(tree, { height: 10, width: 20 }).children[0].box).toMatchObject({
			height: 6,
			width: 6,
		});
	});

	it('should resolve a percentage width against the block, not the room left by a margin', () => {
		// the same argument doing two jobs, one level along: `makeItem()` resolved
		// this child's `50%` against the content box and handed `measure()` the room
		// left after its margin, which resolved the same declaration against
		// sixteen. So the box was placed ten wide with its text wrapped for eight,
		// and one declaration meant two things four lines apart
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'row', width: '20' },
			text('aa bb cc', { 'margin-left': '4', width: '50%' })
		);

		expect(layout(tree, { height: 10, width: 20 }).children[0].box).toMatchObject({
			height: 1,
			width: 10,
		});
	});

	it('should lay a percentage-limited text out at the width it is placed at', () => {
		// a percentage of a containing block that is not settled is `auto`, which is
		// CSS's rule -- so the column first sizes itself around a child measured
		// without the limit, eighteen wide and two rows. What closes the gap is the
		// re-measure: once flexing has settled the column's own width, its subtree
		// is measured again with that width as a definite containing block, the
		// `50%` resolves to nine, and the column comes out as tall as the four rows
		// the text needs there.
		//
		// This used to overflow -- a two-row box around a four-row text -- and the
		// entry recording it said that closing it needed the containing block known
		// before the subtree was measured, which is iteration. It is: one round of
		// it, taken where the width stops being a guess.
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'row', width: '20' },
			box(
				{ 'flex-direction': 'column' },
				text('one two three four five six', { 'max-width': '50%' })
			)
		);

		const result = layout(tree, { height: 10, width: 20 });
		expect(result.children[0].box).toMatchObject({ height: 4, width: 18 });
		expect(result.children[0].children[0].box).toMatchObject({ height: 4, width: 9 });
		checkInvariants(result);
	});

	it('should measure a declared size on a text as the size it will be placed at', () => {
		// the `measure` branch reported the content's own size and ignored the
		// declaration the two branches below it honour, so an auto-width column
		// around a `width: 10` text whose content wraps to five measured itself five
		// and drew the child outside its own box
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'row' },
			box({ 'flex-direction': 'column' }, text('aa bb', { width: '10' }))
		);

		const result = layout(tree, { height: 10, width: 20 });
		expect(result.children[0].box.width).toBe(10);
		checkInvariants(result);
	});

	it('should leave a row child measured at the width flexing gave it', () => {
		// the mirror of the two above, pinned so the column fix stays the column's:
		// a row's main axis is the width, so the basis has to stay the unclamped
		// content size for the flex algorithm to do the clamping -- a `max-width: 6`
		// item is still six wide, not the five its content wraps to at six
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'row', width: '20' },
			text('one two three four five six', { 'max-width': '6' })
		);

		expect(layout(tree, { height: 10, width: 20 }).children[0].box).toMatchObject({
			height: 6,
			width: 6,
		});
	});
});

describe('wrapping counts margins', () => {
	it('should break a line when a margin is what makes it too wide', () => {
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
			box({ width: '5', height: '1', 'margin-left': '2', 'flex-shrink': '0' }),
			box({ width: '5', height: '1', 'margin-left': '2', 'flex-shrink': '0' })
		);

		const result = layout(tree, { height: 4, width: 10 });
		// on a second line, wherever `align-content` put it -- the point is that
		// seven and seven do not share a ten-wide line
		expect(result.children[1].box.y).toBeGreaterThan(0);
		checkInvariants(result);
	});
});

describe('a line is as tall as its items can be', () => {
	it('should take a min-height into account when sizing a line', () => {
		// a line took the *unclamped* cross size, so it came out too short for an
		// item with a min-height and the next line started on top of it
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap', 'max-width': '6' },
			box({ 'min-height': '5', flex: '1' }),
			box({ width: '6', height: '2' })
		);

		checkInvariants(layout(tree, { height: 10, width: 6 }));
	});
});

describe('the same node used twice', () => {
	it('should get a result each', () => {
		// the results were rebuilt by node identity, so two appearances of one node
		// collapsed into a single entry
		const shared = box({ width: '2', height: '1' });
		const tree = box({ 'flex-direction': 'row' }, shared, box({ width: '1', height: '1' }), shared);

		const result = layout(tree, { height: 1, width: 8 });
		expect(result.children).toHaveLength(3);
		expect(result.children.map((c) => c.box.x)).toEqual([0, 2, 3]);
	});
});

describe('percentage sizes round per box', () => {
	it('should round each box on its own, so two 50% siblings ask for more than there is', () => {
		// `resolve()` rounds a percentage rather than truncating it, and it rounds
		// one box at a time: 50% of five is 2.5 twice, and each answers 3. Nothing
		// here is a partition to hand out, so `distribute()` is not what this is --
		// the row is put back to exactly full by the shrink pass, which *is*
		// `distribute()`, and 3 + 3 becomes 3 + 2
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ height: '1', width: '50%' }),
			box({ height: '1', width: '50%' })
		);

		const result = layout(tree, { height: 1, width: 5 });
		expect(result.children.map((c) => c.box.width)).toEqual([3, 2]);
		checkInvariants(result);
	});

	it('should overflow when the boxes that rounded up cannot shrink', () => {
		// with nothing to give back, the two threes stay three and the second one
		// leaves the container. That is the price of whole cells: CSS keeps the
		// halves and paints them, and there is no half cell to paint
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-shrink': '0', height: '1', width: '50%' }),
			box({ 'flex-shrink': '0', height: '1', width: '50%' })
		);

		const result = layout(tree, { height: 1, width: 5 });
		expect(result.children.map((c) => c.box.width)).toEqual([3, 3]);
		expect(() => checkInvariants(result)).toThrow(/escapes content/);
	});

	it('should not round a small percentage away', () => {
		// the half that rounding buys: 50% of five is three rather than the two
		// truncation gives, and 10% of five is a cell rather than nothing at all
		const half = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-shrink': '0', height: '1', width: '50%' })
		);
		const tenth = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-shrink': '0', height: '1', width: '10%' })
		);

		expect(layout(half, { height: 1, width: 5 }).children[0].box.width).toBe(3);
		expect(layout(tenth, { height: 1, width: 5 }).children[0].box.width).toBe(1);
	});
});

describe('percentage margins', () => {
	it('should resolve against the width on both axes', () => {
		// CSS resolves every percentage margin against the containing block's
		// width. Using the main axis made one declaration mean two things -- one at
		// measure time and another at placement
		const tree = box(
			{ 'flex-direction': 'column', width: '10' },
			box({ height: '2', 'margin-top': '50%' })
		);

		expect(layout(tree, { height: 20, width: 10 }).children[0].box.y).toBe(5);
	});
});

describe('position: relative', () => {
	it('should offset a box by its insets', () => {
		// `position` and the four insets parsed, marked layout dirty, and were
		// never read: the box laid out in flow at the origin and `top`/`left` did
		// nothing at all
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ position: 'relative', top: '2', left: '2', width: '3', height: '1' })
		);

		expect(picture(tree, 10, 3)).toBe(['aaaaaaaaaa', 'aaaaaaaaaa', 'aabbbaaaaa'].join('\n'));
	});

	it('should leave the flow where it was', () => {
		// the space stays reserved at the un-offset position, which is what
		// separates `relative` from taking the box out of flow: the sibling is
		// placed as though nothing moved
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ position: 'relative', top: '1', left: '3', width: '2', height: '1' }),
			box({ width: '2', height: '1' })
		);

		const result = layout(tree, { height: 3, width: 10 });
		expect(result.children[0].box).toMatchObject({ x: 3, y: 1 });
		expect(result.children[1].box).toMatchObject({ x: 2, y: 0 });
	});

	it('should keep an inset physical when the direction is reversed', () => {
		// `top` is down the screen and `left` is across it, whatever the main axis
		// is doing. Reading them as main-start and cross-start would make one
		// declaration mean two things depending on the container it landed in
		// one across and two down, so reading them as main and cross would move the
		// box somewhere else rather than to the same place by arithmetic accident
		const child = { height: '1', left: '1', position: 'relative', top: '2', width: '2' };
		const at = (direction: string) =>
			layout(box({ 'flex-direction': direction }, box(child)), { height: 3, width: 10 }).children[0]
				.box;

		// the flow puts each of these somewhere different, and every one of them
		// then moves one cell right and two cells down from wherever that was
		expect(at('row')).toMatchObject({ x: 0 + 1, y: 0 + 2 });
		expect(at('row-reverse')).toMatchObject({ x: 10 - 2 + 1, y: 0 + 2 });
		expect(at('column')).toMatchObject({ x: 0 + 1, y: 0 + 2 });
		expect(at('column-reverse')).toMatchObject({ x: 0 + 1, y: 3 - 1 + 2 });
	});

	it('should ignore an inset on a static box', () => {
		// what CSS does, and the reason `position` starts at `static`: a stray
		// `top` in a stylesheet moves nothing until something says it may
		const tree = box({ 'flex-direction': 'row' }, box({ top: '2', left: '2', width: '3' }));
		expect(layout(tree, { height: 3, width: 10 }).children[0].box).toEqual({
			height: 3,
			width: 3,
			x: 0,
			y: 0,
		});
	});

	it('should read bottom and right as a push the other way', () => {
		// the padding is two and the push is one, so neither an ignored offset nor
		// an ignored padding lands on the same answer
		const tree = box(
			{ 'flex-direction': 'column', padding: '2' },
			box({ position: 'relative', bottom: '1', right: '1', width: '2', height: '1' })
		);

		expect(layout(tree, { height: 6, width: 8 }).children[0].box).toEqual({
			height: 1,
			width: 2,
			x: 1,
			y: 1,
		});
	});

	it('should let top beat bottom and left beat right', () => {
		// over-constrained, and CSS picks a winner rather than averaging the two
		// into a compromise neither declaration asked for
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ position: 'relative', top: '2', bottom: '1', left: '2', right: '1', width: '2' })
		);

		const { box: placed } = layout(tree, { height: 4, width: 10 }).children[0];
		expect(placed.x).toBe(2);
		expect(placed.y).toBe(2);
	});

	it('should let a zero top beat a bottom', () => {
		// the winner is whichever inset was *declared*, so a `top: 0` is an answer
		// rather than a falsy value the other edge gets to overrule
		const tree = box(
			{ 'flex-direction': 'column', padding: '2' },
			box({ position: 'relative', top: '0', bottom: '2', left: '0', right: '2', height: '1' })
		);

		const { box: placed } = layout(tree, { height: 6, width: 8 }).children[0];
		expect(placed.x).toBe(2);
		expect(placed.y).toBe(2);
	});

	it('should resolve a percentage inset per axis', () => {
		// `top` against the containing block's height, which is CSS and is *not*
		// what the margins do -- those resolve against the width on both axes
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ position: 'relative', top: '50%', left: '50%', width: '2', height: '1' })
		);

		const { box: placed } = layout(tree, { height: 4, width: 10 }).children[0];
		expect(placed.x).toBe(5);
		expect(placed.y).toBe(2);
	});

	it('should resolve a percentage inset against the content box, not the border box', () => {
		// the containing block is what is inside the padding and border, so a
		// padded parent answers for less than it is wide
		const tree = box(
			{ 'flex-direction': 'row', padding: '1', border: 'single' },
			box({ position: 'relative', left: '50%', width: '2', height: '1' })
		);

		// twelve wide, four of that border and padding, so the containing block is
		// eight and half of it is four -- against the border box it would be six
		const { box: placed } = layout(tree, { height: 5, width: 12 }).children[0];
		expect(placed.x).toBe(2 + 4);
	});

	it('should carry the children of an offset box with it', () => {
		// the offset is applied where the box is placed, so everything inside it is
		// placed relative to a box that has already moved
		const tree = box(
			{ 'flex-direction': 'row' },
			box(
				{ position: 'relative', top: '1', left: '1', width: '4', height: '3', padding: '1' },
				box({ width: '2', height: '1' })
			)
		);

		const result = layout(tree, { height: 5, width: 10 });
		expect(result.children[0].box).toMatchObject({ x: 1, y: 1 });
		// one for the offset and one for the padding, where an unmoved box would
		// have put it at (1, 1)
		expect(result.children[0].children[0].box).toMatchObject({ x: 2, y: 2 });
	});

	it('should offset the root it was handed', () => {
		// every other node's offset is applied by the parent that places it, and
		// the root has no parent -- the same gap its declared size had
		const root = box({ position: 'relative', top: '1', left: '1', width: '2', height: '1' });
		expect(layout(root, { height: 4, width: 10 }).box).toEqual({
			height: 1,
			width: 2,
			x: 1,
			y: 1,
		});
	});

	it('should hold the invariants while overlapping a sibling', () => {
		// an offset box landing on a sibling or leaving its parent is the point of
		// the property rather than a failure of the engine, so `checkInvariants()`
		// excuses it -- and excuses nothing else on the tree
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ width: '4', height: '2' }),
			box({ position: 'relative', left: '-4', top: '1', width: '4', height: '2' })
		);

		const result = layout(tree, { height: 4, width: 10 });
		// the overlap is asserted rather than assumed: an exemption that is never
		// exercised would pass this test with the offset never applied at all
		expect(result.children[1].box).toEqual({ height: 2, width: 4, x: 0, y: 1 });
		expect(() => checkInvariants(result)).not.toThrow();
	});

	it('should still catch a relative box that overflows without having moved', () => {
		// the exemption is keyed on the box having moved, not on the keyword and
		// not on the declaration: a `top: 0` is declared and moves nothing, and a
		// placement bug under either box must not hide behind the property
		const nowhere: Record<string, string>[] = [{}, { top: '0' }, { left: '0%' }];

		for (const declared of nowhere) {
			const tree = box(
				{ 'flex-direction': 'row' },
				box({ position: 'relative', width: '20', 'flex-shrink': '0', height: '1', ...declared })
			);

			expect(
				() => checkInvariants(layout(tree, { height: 1, width: 10 })),
				JSON.stringify(declared)
			).toThrow(/escapes/);
		}
	});
});

describe('min and max are applied once, by whoever sized the node', () => {
	it('should resolve a percentage against the containing block and not the size allocated', () => {
		// `max-width: 50%` was read twice: once against the row's ten columns, which
		// clamped each growing item to five, and again against the five it had just
		// been given, which clamped it to three. The siblings' positions still came
		// from the first answer, so each box came back two columns short of the hole
		// reserved for it
		const tree = box(
			{ 'flex-direction': 'row' },
			box({ 'flex-grow': '1', 'max-width': '50%' }),
			box({ 'flex-grow': '1', 'max-width': '50%' })
		);

		expect(picture(tree, 10, 2)).toBe(['bbbbbccccc', 'bbbbbccccc'].join('\n'));
		checkInvariants(layout(tree, { height: 2, width: 10 }));
	});

	it('should resolve a cross-axis maximum against the containing block', () => {
		// the same defect on the other axis: stretched to eight rows, clamped to
		// four by `max-height: 50%`, then clamped to two by reading the four back
		const tree = box(
			{ 'flex-direction': 'row', height: '8', width: '4' },
			box({ 'flex-grow': '1', 'max-height': '50%' })
		);

		expect(picture(tree, 4, 8)).toBe(
			['bbbb', 'bbbb', 'bbbb', 'bbbb', 'aaaa', 'aaaa', 'aaaa', 'aaaa'].join('\n')
		);
	});

	it('should resolve down a column against the containing block', () => {
		const tree = box(
			{ 'flex-direction': 'column', height: '8', width: '3' },
			box({ 'flex-grow': '1', 'max-height': '50%' }),
			box({ 'flex-grow': '1', 'max-height': '50%' })
		);

		expect(picture(tree, 3, 8)).toBe(
			['bbb', 'bbb', 'bbb', 'bbb', 'ccc', 'ccc', 'ccc', 'ccc'].join('\n')
		);
		checkInvariants(layout(tree, { height: 8, width: 3 }));
	});

	it('should resolve the root against the space it was given', () => {
		// the root has no parent, so its containing block is `opts` -- not the width
		// its own declaration asked for, which is what the second resolution read
		const panel = box({ width: '20', 'max-width': '50%', height: '2' });

		expect(layout(panel, { height: 4, width: 40 }).box.width).toBe(20);
	});

	it('should resolve a nested percentage against its own parent', () => {
		// three levels, each half the one above: 40, then 20, then 10
		const tree = box(
			{ 'flex-direction': 'row', height: '1' },
			box(
				{ 'flex-direction': 'row', 'flex-grow': '1', 'max-width': '50%' },
				box({ 'flex-grow': '1', 'max-width': '50%' })
			)
		);

		const result = layout(tree, { height: 1, width: 40 });
		expect(result.children[0].box.width).toBe(20);
		expect(result.children[0].children[0].box.width).toBe(10);
	});

	it('should not measure the root at the width its own limits clamped it to', () => {
		// moving the root's clamp into `layout()` made it tempting to measure at the
		// clamped width, and `measure()` reads the node's own `width` back off that
		// argument: `50%` of the eight the `max-width` left it is four, so the text
		// wrapped six rows deep inside a box eight columns wide. Two rows is what it
		// needs at eight, and what measuring at the declared twenty also gives
		const root = text('aa bb cc dd ee ff', { width: '50%', 'max-width': '8' });

		expect(layout(root, { width: 40 }).box).toEqual({ height: 2, width: 8, x: 0, y: 0 });
	});

	it('should not re-clamp a size against an automatic minimum it cannot see', () => {
		// the other half of the same defect, with nothing percentage about it. The
		// parent held this text at the three rows it needs -- `min` wins over `max`
		// -- and the second clamp read `min-height: auto` as no minimum at all,
		// because the content-based one lives in a measurement only the parent takes.
		// So the text came back one row tall into a three-row hole
		const tree = box(
			{ 'flex-direction': 'column', height: '6', width: '5' },
			text('one two three', { 'max-height': '1' }),
			box({ height: '1' })
		);

		expect(picture(tree, 5, 6)).toBe(
			['bbbbb', 'bbbbb', 'bbbbb', 'ccccc', 'aaaaa', 'aaaaa'].join('\n')
		);
		checkInvariants(layout(tree, { height: 6, width: 5 }));
	});
});

describe('a wrapped line is as tall as its text turned out to be', () => {
	it('should size a line from the height its text re-measured to', () => {
		// a line's cross size was taken from `item.crossSize`, which is the height
		// the item measured at the whole content box -- and the re-measure that
		// makes a narrowed text taller ran later, in `placeLine()`. So the line
		// stayed one row tall around a text that had wrapped to two, and the next
		// line was placed on top of the first one's second row. The picture shows
		// it: `c` is painted after `b`, so the overlap reads as `b` losing a row
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap', 'align-content': 'flex-start' },
			text('hello world', { 'flex-basis': '6' }),
			text('again', { 'flex-basis': '6' })
		);

		expect(picture(tree, 11, 4)).toBe(
			['bbbbbbaaaaa', 'bbbbbbaaaaa', 'ccccccaaaaa', 'aaaaaaaaaaa'].join('\n')
		);
		checkInvariants(layout(tree, { height: 4, width: 11 }));
	});

	it('should still let a stretched line grow a text to fill it', () => {
		// the re-measure moving out of `placeLine()` left it reading the height
		// back off the item, and `stretch` has to keep taking the larger of the
		// room and that height: a text's rows past the bottom of its box are lost,
		// while a box crushed by `stretch` merely overflows with its children
		const tree = box(
			{ 'flex-direction': 'row', 'align-items': 'stretch' },
			text('hello there world', { 'flex-basis': '5' })
		);

		expect(layout(tree, { height: 6, width: 11 }).children[0].box.height).toBe(6);
		expect(layout(tree, { height: 1, width: 11 }).children[0].box.height).toBe(3);
	});
});

describe('a row is as tall as the widths flexing hands out', () => {
	// SIG-125. A label-and-description row is what a CLI is made of, and its
	// intrinsic height was taken with every child offered the *whole* content box
	// while placement hands each one a share -- so the description measured two
	// lines in the room it was offered, was placed in the column flexing gave it
	// where it needs three, and the row reserved one row too few
	const labelAndDescription = () =>
		box(
			{ 'column-gap': '1', 'flex-direction': 'row' },
			text('label', { 'flex-shrink': '0', 'white-space': 'nowrap' }),
			text('one two three four five six seven', { 'flex-basis': '0', 'flex-grow': '1' })
		);

	it('should measure the row at the height its own placement comes to', () => {
		// the claim in one line: what the measure says and what the layout does are
		// the same number. It said two
		expect(measureNode(labelAndDescription(), 20).height).toBe(3);
		expect(layout(labelAndDescription(), { width: 20 }).children[1].box.height).toBe(3);
	});

	it('should give the block after it the rows it was promised', () => {
		// the picture is the point: `c` is the label, `d` the description, and `e`
		// the block after. `e` used to be painted over `d`'s third row, because the
		// row reserved two and its child took three
		const tree = box({ 'flex-direction': 'column' }, labelAndDescription(), text('after'));

		expect(picture(tree, 19, 4)).toBe(
			[
				'cccccbddddddddddddd',
				'cccccbddddddddddddd',
				'cccccbddddddddddddd',
				'eeeeeeeeeeeeeeeeeee',
			].join('\n')
		);
		checkInvariants(layout(tree, { height: 4, width: 19 }));
	});

	it('should not draw through a border it is inside', () => {
		// the same defect one layer in: the bordered box's own cross size comes from
		// this measure, so the third line was drawn over the bottom border
		const tree = box({ border: 'single' }, labelAndDescription());

		expect(layout(tree, { width: 24 }).box.height).toBe(5);
		checkInvariants(layout(tree, { height: 5, width: 24 }));
	});

	it('should re-measure an item whose basis was its own content', () => {
		// every other test in this block gives the description a `flex-basis`, and that
		// leaves the commonest shape of all uncovered: two plain texts in a row, each
		// with `flex-basis: auto`, so each basis *is* its content width and flexing
		// only ever shrinks it. Found by asking for a mutation that survives the suite
		// -- skipping the re-measure for a content-sized item that shrank reads as a
		// width-only change and passed every assertion here, because none of them had
		// one. It is SIG-125 with the default basis
		const inner = () =>
			box({ 'flex-direction': 'row' }, text('aaaa bbbb cccc dddd'), text('eeee ffff gggg hhhh'));
		const tree = box({ 'flex-direction': 'column' }, inner(), text('after'));

		// each text is one line at twenty and two lines at the ten flexing gives it, so
		// the row is two rows and `after` starts on the third
		expect(measureNode(tree, 20).height).toBe(3);
		// and the row itself reports two rows as its *minimum* as well as its height.
		// It reported one: the minimum was read at the pre-flex width, where each text
		// is a single line, so a column parent -- which clamps a child's basis up to
		// its automatic minimum and no further -- squeezed the row to one row around
		// two rows of text
		expect(measureNode(inner(), 20)).toMatchObject({ height: 2, minHeight: 2 });
		expect(
			layout(box({ 'flex-direction': 'column', height: '1', width: '20' }, inner()), {
				height: 1,
				width: 20,
			}).children[0].box.height
		).toBe(2);
		expect(picture(tree, 19, 3)).toBe(
			['ccccccccccddddddddd', 'ccccccccccddddddddd', 'eeeeeeeeeeeeeeeeeee'].join('\n')
		);
		checkInvariants(layout(tree, { height: 3, width: 19 }));
	});

	it('should re-measure every item on a line, not just the first two', () => {
		// three children on one line, and the middle one is the only one that re-wraps.
		// Asked for as a mutation that survives the suite: skipping `remeasureLine()`
		// for a line of more than two items left every assertion in this block green,
		// because each of them puts one or two items on the line that matters
		const tree = () =>
			box(
				{ 'column-gap': '1', 'flex-direction': 'row' },
				text('L', { 'flex-shrink': '0', 'white-space': 'nowrap' }),
				text('one two three four five six seven eight', {
					'flex-basis': '0',
					'flex-grow': '1',
				}),
				text('R', { 'flex-shrink': '0', 'white-space': 'nowrap' })
			);

		// the middle text gets eighteen of twenty-two and wraps to three rows there,
		// where the whole content box would have been two
		expect(measureNode(tree(), 22)).toMatchObject({ height: 3, minHeight: 3 });
		expect(layout(tree(), { width: 22 }).children[1].box.height).toBe(3);
	});

	it('should keep a one-line wrapping row squeezable', () => {
		// `wrapping` is true whenever `flex-wrap` is not `nowrap` and there are two
		// children, whether or not they land on two lines -- so the wrapping branch
		// used to overwrite the minimum with the flexed cross size even for a row that
		// packed onto one line, and a column parent could no longer squeeze it. The
		// inner box declares five rows around two rows of content, so its own minimum
		// is two: that is what this row can be squeezed to, and reporting five refuses
		// a squeeze the placement allows
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'wrap' },
			box({ 'flex-direction': 'column', height: '5' }, text('a'), text('b')),
			text('c')
		);

		expect(measureNode(tree, 20)).toMatchObject({ height: 5, minHeight: 2 });
	});

	it('should not let a multi-line wrapping row claim it can be one line tall', () => {
		// the other half of the same expression, and it was unguarded when it was
		// written: replacing it with a bare `Math.min(minCrossMax, cross)` failed no
		// test at all. The loop's minimum is a per-*child* maximum, so three one-row
		// items report one however many lines they pack into -- and a column parent
		// clamps a row's basis to that minimum, so it could squeeze this row to one row
		// and cut the other two
		const tree = box(
			{ 'align-content': 'flex-start', 'flex-direction': 'row', 'flex-wrap': 'wrap' },
			text('aa', { 'flex-basis': '5' }),
			text('bb', { 'flex-basis': '5' }),
			text('cc', { 'flex-basis': '5' })
		);

		expect(measureNode(tree, 11)).toMatchObject({ height: 2, minHeight: 2 });
		expect(measureNode(tree, 5)).toMatchObject({ height: 3, minHeight: 3 });
	});

	it('should size a wrapping row from the lines it really packs into', () => {
		// the wrapping half of it, which had the same bug in the same shape: each
		// line's cross size was the unflexed height of its tallest item, so a line
		// whose text grew when flexing narrowed it came out a row short and the line
		// after it started inside it.
		//
		// The height is asserted as a number rather than against
		// `layout(...).box.height`, which would say nothing: `layout()` takes the
		// root's height from this very measure when the caller names none, so the two
		// are equal by construction whatever the measure said. The picture is what
		// shows the second line landing below the first rather than on it
		const tree = () =>
			box(
				{ 'align-content': 'flex-start', 'flex-direction': 'row', 'flex-wrap': 'wrap' },
				text('aa bb cc', { 'flex-basis': '5', 'flex-grow': '1' }),
				text('dd ee ff', { 'flex-basis': '5', 'flex-grow': '1' }),
				text('gg hh ii', { 'flex-basis': '5', 'flex-grow': '1' })
			);

		// the first two items grow to five and six and wrap to two rows each; the
		// third takes a line of its own
		expect(measureNode(tree(), 11).height).toBe(3);
		expect(picture(tree(), 11, 3)).toBe(['bbbbbcccccc', 'bbbbbcccccc', 'ddddddddddd'].join('\n'));
		checkInvariants(layout(tree(), { width: 11 }));
	});

	it('should honour a max-height the placement honours rather than measuring past it', () => {
		// the flexed cross size *replaces* what the loop found rather than being a
		// floor over it, and this is the case that says which: the text wraps to six
		// rows and `max-height: 1` is what it is placed at, so a `Math.max` of the two
		// would measure the row six rows tall around a one-row box
		const tree = () =>
			box({ 'flex-direction': 'row' }, text('one two three four five six', { 'max-height': '1' }));

		expect(measureNode(tree(), 6)).toMatchObject({ height: 1, minHeight: 1 });

		// and the minimum is asserted beside the height rather than left implicit,
		// because the height alone is not the answer anything downstream reads: a
		// column parent clamps a child's basis up to its automatic minimum, so an
		// unclamped `minHeight: 6` placed this row six rows tall while its own measure
		// said one. That is the defect this whole block is about, reintroduced one
		// number along
		const column = box({ 'flex-direction': 'column', width: '6' }, tree(), text('after'));
		const placed = layout(column, { width: 6 });
		expect(placed.children[0].box.height).toBe(1);
		expect(placed.children[1].box.y).toBe(1);
	});
});

describe('a nowrap row is as wide as the basis its children flex from', () => {
	// SIG-126. The height half of this is the block above; the width was left on the
	// other arithmetic. The per-child loop sums each child's measured *content*
	// width, while the placement starts each item from its `flex-basis` -- so a
	// `flex-basis` wider than the content is a width the measure never saw
	const row = (declarations: Parameters<typeof box>[0], ...children: ReturnType<typeof box>[]) =>
		box({ 'flex-direction': 'row', 'flex-wrap': 'nowrap' }, box(declarations, ...children));

	it('should read a flex-basis the placement will read', () => {
		// zero, because an empty box measures nothing and the basis was never asked
		// about. The placement gives that child forty
		expect(measureNode(row({ 'flex-basis': '40' }), 100).width).toBe(40);
		// and the same with content in it, which is the shape that says the loop is
		// reading the content rather than merely missing an empty child: it said two
		expect(
			measureNode(row({ 'flex-basis': '40' }, text('hi', { 'white-space': 'nowrap' })), 100).width
		).toBe(40);
	});

	it('should not let the child vanish, which is what the shrinkable case did', () => {
		// the report AGENTS.md had wrong. `flex-shrink` defaults to 1, so the row
		// measured zero, `resolveFlexible()` shrank the child to fit the zero it had
		// been given, and the content was simply not on screen -- no overflow for
		// `checkInvariants()` to catch and nothing to point at
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'column' },
			row({ 'flex-basis': '40', height: '1' })
		);
		const placed = layout(tree, { height: 3, width: 100 });

		expect(placed.children[0].box.width).toBe(40);
		expect(placed.children[0].children[0].box.width).toBe(40);
	});

	it('should not draw a frozen child outside its own parent', () => {
		// and the report it had right, which needs `flex-shrink: 0`: the row measured
		// zero and the child could not give anything up, so forty columns were drawn
		// outside a parent zero wide
		const tree = box(
			{ 'align-items': 'flex-start', 'flex-direction': 'column' },
			row({ 'flex-basis': '40', 'flex-shrink': '0', height: '1' })
		);

		expect(layout(tree, { height: 3, width: 100 }).children[0].box.width).toBe(40);
		checkInvariants(layout(tree, { height: 3, width: 100 }));
	});

	it('should floor a frozen child in the minimum as well as in the width', () => {
		// the half a narrower fix drops. An item that cannot shrink is frozen at its
		// hypothetical size, so the row cannot be made narrower than it -- and a
		// minimum that summed only each item's clamped floor would report zero here,
		// which squeezes the row back to nothing and draws the child outside it again.
		// Asserted through a parent too narrow to hold it, which is the only place a
		// minimum is read
		const inner = () => row({ 'flex-basis': '40', 'flex-shrink': '0', height: '1' });

		expect(measureNode(inner(), 100)).toMatchObject({ minWidth: 40, width: 40 });

		const squeezed = layout(
			box({ 'flex-direction': 'row', 'flex-wrap': 'nowrap', width: '10' }, inner()),
			{ height: 3, width: 10 }
		);
		expect(squeezed.children[0].box.width).toBe(40);
		expect(squeezed.children[0].children[0].box.width).toBe(40);
	});

	it('should let a declared minimum of zero mean zero', () => {
		// the second divergence, and the same rule the wrapping branch already keeps:
		// the minimum is the placement's `declared ?? automatic`, not the larger of the
		// two. `min-width: 0` on a long word is a declaration the automatic minimum
		// does not get a say in
		const inner = () => row({ 'min-width': '0' }, text('supercalifragilistic'));

		expect(measureNode(inner(), 100)).toMatchObject({ minWidth: 0, width: 20 });

		// what the lie cost: the row reported a minimum of twenty, so a ten-wide
		// parent placed it twenty wide rather than at the ten its child had said it
		// could take
		const tree = box({ 'flex-direction': 'row', 'flex-wrap': 'nowrap', width: '10' }, inner());
		const placed = layout(tree, { height: 6, width: 10 });
		expect(placed.children[0].box.width).toBe(10);
		checkInvariants(layout(tree, { height: 6, width: 10 }), { overflow: true });
	});

	it('should floor a growable item under its own basis', () => {
		// the other half of `maxContentMain()`, and it survived a sabotage before this
		// test existed: an item that can grow takes the larger of its content and its
		// basis, and reading the content alone makes a `flex-grow: 1; flex-basis: 40`
		// box vanish exactly the way the default `flex-grow: 0` one did. Two branches,
		// two ways to reach one bug
		const tree = () => row({ 'flex-basis': '40', 'flex-grow': '1', height: '1' });

		expect(measureNode(tree(), 100).width).toBe(40);

		const placed = layout(
			box({ 'align-items': 'flex-start', 'flex-direction': 'column' }, tree()),
			{ height: 3, width: 100 }
		);
		expect(placed.children[0].children[0].box.width).toBe(40);
	});

	it('should not offer a content size to an item that cannot grow', () => {
		// which is what makes the two branches two branches, and it survived a sabotage
		// too: an item with no `flex-grow` ends at its hypothetical size whatever room
		// there is, so its contribution is that and never its content. Handing it the
		// larger of the two would measure this row at the twenty its text wants and
		// place the child at the five its basis says -- a fifteen-column hole in a row
		// that shrank to fit. A `min-width: 0` is what lets the basis win, since the
		// automatic minimum is otherwise the word's own width
		const tree = () =>
			row(
				{ 'flex-basis': '5', 'min-width': '0' },
				text('supercalifragilistic', { 'white-space': 'nowrap' })
			);

		expect(measureNode(tree(), 100).width).toBe(5);

		const placed = layout(
			box({ 'align-items': 'flex-start', 'flex-direction': 'column' }, tree()),
			{ height: 3, width: 100 }
		);
		expect(placed.children[0].box.width).toBe(5);
		expect(placed.children[0].children[0].box.width).toBe(5);
	});

	it('should clamp a growable item to a max-width its minimum does not beat', () => {
		// and the clamp, which also survived a sabotage. `max-width` is unreachable as a
		// divergence while the automatic minimum is the content's own width, because
		// `min` beats `max` -- so it takes a `min-width: 0` to let the max bind, and
		// then the contribution really is the ten the item is placed at rather than the
		// twenty its content wants. Which is why the test above this one is about the
		// case where they agree and this one is about the case where they do not
		const tree = () =>
			row(
				{ 'flex-grow': '1', 'max-width': '10', 'min-width': '0' },
				text('supercalifragilistic', { 'white-space': 'nowrap' })
			);

		expect(measureNode(tree(), 100).width).toBe(10);

		const placed = layout(
			box({ 'align-items': 'flex-start', 'flex-direction': 'column' }, tree()),
			{ height: 3, width: 100 }
		);
		expect(placed.children[0].box.width).toBe(10);
		// `overflow` allowed, because the text really does escape: a nowrap twenty-column
		// string in the ten columns `max-width` clamps its box to is what
		// `text-overflow` is for, and the box being ten is the assertion above
		checkInvariants(
			layout(box({ 'align-items': 'flex-start', 'flex-direction': 'column' }, tree()), {
				height: 3,
				width: 100,
			}),
			{ overflow: true }
		);
	});

	it('should leave a max-width to the placement, which already agrees', () => {
		// the third candidate, which is *not* a divergence and is asserted so that
		// nobody adds it to the fix. `measureUncached()` lays a child's content out at
		// the width its own limits clamp it to, so the measured width is already
		// inside the max; and where the content cannot shrink that far -- a long word
		// -- `min` beats `max`, which is CSS. Both spellings measure what they place
		expect(measureNode(row({ 'max-width': '10' }, text('aa bb cc dd ee ff gg')), 100).width).toBe(
			8
		);
		expect(
			measureNode(
				row({ 'max-width': '10' }, text('supercalifragilistic', { 'white-space': 'nowrap' })),
				100
			).width
		).toBe(20);
	});

	it('should count the gaps it counted before', () => {
		// the sum moved, so the thing added to it has to be asserted with it: two
		// basis-10 children with a gap of three is twenty-three, not twenty
		const tree = box(
			{ 'column-gap': '3', 'flex-direction': 'row', 'flex-wrap': 'nowrap' },
			box({ 'flex-basis': '10' }),
			box({ 'flex-basis': '10' })
		);

		expect(measureNode(tree, 100).width).toBe(23);
	});

	it('should count a margin the way the line does', () => {
		// `hypotheticalMain()` gives the margins back outside the clamp, which is what
		// the loop's own `+ extraH` did -- so this is the one part of the arithmetic
		// that must not change. A basis of ten with two columns each side is fourteen
		const tree = box(
			{ 'flex-direction': 'row', 'flex-wrap': 'nowrap' },
			box({ 'flex-basis': '10', margin: '0 2' })
		);

		expect(measureNode(tree, 100).width).toBe(14);
	});
});
