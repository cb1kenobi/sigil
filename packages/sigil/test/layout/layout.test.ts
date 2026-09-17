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
