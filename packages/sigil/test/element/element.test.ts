import { createCanvas } from '../../src/canvas/index.js';
import {
	arrange,
	box,
	createTree,
	type Element,
	paint,
	raw,
	resolveStyles,
	text,
} from '../../src/element/index.js';
import { Cascade, parseStylesheet, Restyler } from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/**
 * The element tree, and the two passes that put one on screen.
 *
 * Read as pictures wherever a picture says it, for the reason the layout tests
 * give: a failing assertion that prints two grids says what went wrong, and one
 * that prints a box does not.
 */

/**
 * Resolves, lays out, paints, and reads the cells back as rows of text.
 *
 * The whole pipeline in four lines, which is the point: the tree is what the
 * cascade resolves over, what layout measures, and what paint walks.
 */
function picture(root: Element, width: number, height: number, restyler?: Restyler): string {
	const canvas = createCanvas({ height, width });
	resolveStyles(root, restyler);
	arrange(root, { height, width });
	canvas.paint((painter) => paint(root, painter));
	return canvas.toString();
}

describe('an element', () => {
	it('should carry what a selector matches and what layout measures', () => {
		const el = box({ class: 'panel wide', id: 'main', padding: '1' });

		// `StyleNode`'s half
		expect(el.type).toBe('box');
		expect(el.classes).toEqual(['panel', 'wide']);
		expect(el.id).toBe('main');
		expect(el.props).toEqual({ padding: '1' });

		// `LayoutNode`'s half: a resolved style from the start, so a tree can be
		// laid out before a stylesheet has ever been resolved over it
		expect(el.style.display).toBe('flex');
		expect(el.measure).toBeUndefined();
	});

	it('should measure a text and cache it until the text or the style changes', () => {
		const el = text('one two three');
		let calls = 0;
		const measure = el.measure;
		expect(measure).toBeDefined();

		const at = (width: number) => {
			calls++;
			return measure?.(width);
		};

		expect(at(5)).toMatchObject({ height: 3, minWidth: 5, width: 5 });
		// the same width twice is one measurement, which is the single most
		// repeated expensive thing in the stack
		expect(at(5)).toBe(at(5));

		el.setText('four');
		expect(at(5)).toMatchObject({ height: 1, width: 4 });
		expect(calls).toBeGreaterThan(0);
	});

	it('should throw the measurement away when the resolved style changes', () => {
		// keyed on the style *object* rather than on a list of properties: the
		// cascade hands back a new one when anything changed and the same one when
		// nothing did, so identity answers exactly the question being asked
		const el = text('one two three');
		const before = el.measure?.(20);
		expect(before).toMatchObject({ height: 1 });

		el.style = { ...el.style, whiteSpace: 'nowrap' };
		el.setProp('color', 'red');
		expect(el.measure?.(5)).toMatchObject({ height: 1, minWidth: 13 });
	});

	it('should apply text-transform where the measurement can see it', () => {
		// `textTransform` is a layout property because it changes how wide a text
		// measures, so the transform has to happen before the measure rather than
		// at paint time
		const el = text('ab cd', { 'text-transform': 'uppercase' });

		expect(picture(el, 5, 1)).toBe('AB CD');
		expect(el.displayText).toBe('AB CD');
	});

	it('should refuse to have children where children make no sense', () => {
		expect(() => text('hi').append(box())).toThrow(/cannot have children/);
		expect(() => box().setText('hi')).toThrow(/has no text/);
	});

	it('should refuse to contain itself', () => {
		const outer = box();
		const inner = box();
		outer.append(inner);

		expect(() => inner.append(outer)).toThrow(/cannot contain itself/);
		expect(() => outer.append(outer)).toThrow(/cannot contain itself/);
	});

	it('should move a child rather than duplicate it', () => {
		const from = box();
		const to = box();
		const child = text('x');
		from.append(child);
		to.append(child);

		expect(from.children).toEqual([]);
		expect(to.children).toEqual([child]);
		expect(child.parent).toBe(to);
	});
});

describe('mutation marks', () => {
	it('should mark children when the tree changes shape, and nothing else', () => {
		const root = box();
		const tree = createTree(root);
		const child = text('hi');

		root.append(child);
		expect(tree.marks.children).toEqual(new Set([root]));
		expect(tree.marks.classes.size).toBe(0);
		expect(tree.marks.props.size).toBe(0);
	});

	it('should mark props for a style prop and classes for a class', () => {
		const root = box();
		const tree = createTree(root);

		root.setProp('color', 'red');
		expect(tree.marks.props).toEqual(new Set([root]));

		root.addClass('active');
		expect(tree.marks.classes).toEqual(new Set([root]));
	});

	it('should mark layout when a text changes, because everything after it moves', () => {
		const root = box();
		const child = text('hi');
		root.append(child);
		const tree = createTree(root);
		tree.take();

		child.setText('hello');
		expect(tree.marks.layout).toEqual(new Set([child]));
		expect(tree.marks.paint.size).toBe(0);
	});

	it('should record nothing for a write that changed nothing', () => {
		const root = box({ color: 'red', class: 'a' });
		const tree = createTree(root);

		root.setProp('color', 'red');
		root.addClass('a');
		root.setState('focus', false);

		expect(tree.marks.props.size).toBe(0);
		expect(tree.marks.classes.size).toBe(0);
	});

	it('should record nothing at all for a subtree not in a tree yet', () => {
		// a page being built before it is attached has nothing on screen to
		// invalidate, and marking every `append()` would hand the first frame a set
		// naming every element in it
		const detached = box(undefined, text('a'), text('b'));
		const root = box();
		const tree = createTree(root);

		detached.append(text('c'));
		expect(tree.marks.children.size).toBe(0);

		// and joining a tree carries membership down the whole subtree
		root.append(detached);
		tree.take();
		detached.children[0].setText('changed');
		expect(tree.marks.layout.size).toBe(1);
	});

	it('should drain on take() so a mutation during a frame lands in the next set', () => {
		const root = box();
		const tree = createTree(root);
		root.setProp('color', 'red');

		const taken = tree.take();
		expect(taken.props).toEqual(new Set([root]));
		expect(tree.marks.props.size).toBe(0);

		root.setProp('color', 'blue');
		expect(taken.props).toEqual(new Set([root]));
		expect(tree.marks.props).toEqual(new Set([root]));
	});
});

describe('arrange and paint', () => {
	it('should write every box back onto the element that earned it', () => {
		const first = text('aa');
		const second = text('bb');
		const root = box({ 'flex-direction': 'column' }, first, second);

		resolveStyles(root);
		arrange(root, { height: 2, width: 4 });

		expect(root.box).toEqual({ height: 2, width: 4, x: 0, y: 0 });
		expect(first.box).toMatchObject({ y: 0 });
		expect(second.box).toMatchObject({ y: 1 });
	});

	it('should draw a border around the border box', () => {
		const root = box({ border: 'single', height: '3', width: '6' }, text('hi'));

		expect(picture(root, 6, 3)).toBe(['┌────┐', '│hi  │', '└────┘'].join('\n'));
	});

	it('should draw each border style with its own characters', () => {
		const of = (style: string) =>
			picture(box({ border: style, height: '2', width: '2' }), 2, 2).split('\n')[0];

		expect(of('single')).toBe('┌┐');
		expect(of('round')).toBe('╭╮');
		expect(of('double')).toBe('╔╗');
		expect(of('bold')).toBe('┏┓');
		expect(of('ascii')).toBe('++');
	});

	it('should paint later siblings over earlier ones', () => {
		// document order is paint order. `z-index` parses and is not read here,
		// which is SIG-64's along with clipping
		const root = box({ 'flex-direction': 'column', height: '2', width: '4' });
		const under = text('aaaa');
		const over = text('bb', { position: 'relative', top: '-1' });
		root.append(under, over);

		expect(picture(root, 4, 2)).toBe(['bbaa', ''].join('\n'));
	});

	it('should honour text-align inside the box the layout gave it', () => {
		const root = box({ 'flex-direction': 'column', width: '6' });
		root.append(text('ab', { 'text-align': 'right' }), text('cd', { 'text-align': 'center' }));

		expect(picture(root, 6, 2)).toBe(['    ab', '  cd'].join('\n'));
	});

	it('should skip a hidden element without skipping a descendant that is not', () => {
		// `visibility` inherits, so a descendant is hidden because it inherited the
		// value rather than because this one was -- and one that sets `visible` is
		// drawn, which is CSS and is why this is a skip rather than a return
		const inner = text('in', { visibility: 'visible' });
		const root = box({ 'flex-direction': 'column', visibility: 'hidden', width: '4' });
		root.append(text('out'), inner);

		expect(picture(root, 4, 2)).toBe(['', 'in'].join('\n'));
	});

	it('should give a display: none element no box and paint nothing', () => {
		const gone = text('gone', { display: 'none' });
		const root = box({ 'flex-direction': 'column', width: '4' }, gone, text('here'));

		expect(picture(root, 4, 2)).toBe(['here', ''].join('\n'));
	});

	it('should let a raw element paint its own cells', () => {
		// the trapdoor: a sparkline, an image, anything the layout engine cannot
		// express. It is measured and placed like a text, and what goes inside the
		// box it got is its own business
		const spark = raw(
			{
				measure: () => ({ height: 1, minWidth: 4, width: 4 }),
				paint: (painter, area) => {
					for (let i = 0; i < area.width; i++) {
						painter.text(area.x + i, area.y, '▁▃▅▇'[i % 4]);
					}
				},
			},
			{ 'margin-left': '1' }
		);

		expect(picture(box({ width: '5' }, spark), 5, 1)).toBe(' ▁▃▅▇');
	});
});

describe('the tree against the cascade', () => {
	it('should resolve a stylesheet over the tree it satisfies', () => {
		// the whole point of an element satisfying `StyleTarget`: the cascade
		// written for literals in tests resolves this with nothing added
		const sheet = parseStylesheet(`
			box { padding: 1 }
			.loud { color: red }
		`);
		const label = text('hi', { class: 'loud' });
		const root = box({ class: 'panel' }, label);
		const restyler = new Restyler(new Cascade([sheet]));

		// the resolved styles reach layout, which is the other half of it: the
		// padding is the sheet's, and the text sits inside it
		expect(picture(root, 6, 3, restyler)).toBe(['', ' hi', ''].join('\n'));
		expect(root.style.paddingTop).toBe(1);
		expect(label.style.color).not.toBe(root.style.color);
	});
});
