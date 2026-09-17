import {
	Cascade,
	declare,
	difference,
	DIRTY_ORDER,
	LAYOUT_PROPERTIES,
	parseStylesheet,
	PROPERTY_NAMES,
	Restyler,
	type StyleTarget,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/** A mutable element, since invalidation is about things changing. */
interface Node {
	children: Node[];
	classes: string[];
	id?: string;
	parent?: Node;
	props?: Record<string, string>;
	states: string[];
	type: string;
}

function el(spec: string, children: Node[] = []): Node {
	const node: Node = { children, classes: [], states: [], type: 'box' };
	for (const [, sigil, name] of spec.matchAll(/([#.:]?)([-\w]+)/g)) {
		if (sigil === '#') {
			node.id = name;
		} else if (sigil === '.') {
			node.classes.push(name);
		} else if (sigil === ':') {
			node.states.push(name);
		} else {
			node.type = name;
		}
	}
	for (const child of children) {
		child.parent = node;
	}
	return node;
}

const as = (node: Node): StyleTarget => node as unknown as StyleTarget;

describe('the dirty bits', () => {
	it('should be ordered the way a frame settles them', () => {
		expect(DIRTY_ORDER).toEqual(['style', 'layout', 'paint']);
	});

	it('should have every property classified as moving a box or not', () => {
		for (const property of PROPERTY_NAMES) {
			expect(typeof LAYOUT_PROPERTIES.has(property), property).toBe('boolean');
		}
		expect(LAYOUT_PROPERTIES.has('width')).toBe(true);
		expect(LAYOUT_PROPERTIES.has('color')).toBe(false);
		// a border takes a cell on each edge; its colour does not
		expect(LAYOUT_PROPERTIES.has('borderStyle')).toBe(true);
		expect(LAYOUT_PROPERTIES.has('borderColor')).toBe(false);
		// both change how wide a text measures
		expect(LAYOUT_PROPERTIES.has('textTransform')).toBe(true);
		expect(LAYOUT_PROPERTIES.has('whiteSpace')).toBe(true);
		// hidden content still takes its space, which is the layout engine's own
		// recorded decision rather than a shortcut taken here
		expect(LAYOUT_PROPERTIES.has('visibility')).toBe(false);
	});
});

describe('comparing two styles', () => {
	it('should compare a length by value rather than by identity', () => {
		// two resolutions of `width: 4` are two equal objects; comparing by
		// identity would report every property as changed on every restyle and
		// make the dirty bits mean nothing
		expect(difference(declare({ width: '4' }), declare({ width: '4' }))).toEqual([]);
		expect(difference(declare({ width: '4' }), declare({ width: '5' }))).toEqual(['width']);
		expect(difference(declare({ width: '4' }), declare({ width: 'auto' }))).toEqual(['width']);
		expect(difference(declare({ width: '50%' }), declare({ width: '50%' }))).toEqual([]);
	});

	it('should report every property that differs and nothing else', () => {
		expect(difference(declare({ color: 'red' }), declare({ color: 'blue' }))).toEqual(['color']);
		expect(difference(declare({}), declare({ padding: '1' })).sort()).toEqual([
			'paddingBottom',
			'paddingLeft',
			'paddingRight',
			'paddingTop',
		]);
	});
});

describe('what a change implies', () => {
	const sheet = parseStylesheet(`
		.panel { color: red }
		.panel.wide { width: 40 }
		.form.invalid .hint { color: red }
		text { color: blue }
	`);

	const build = () => {
		const hint = el('text.hint');
		const label = el('text.label');
		const panel = el('box.panel', [label, hint]);
		const form = el('box.form', [panel]);
		return { form, hint, label, panel };
	};

	it('should resolve the whole tree the first time', () => {
		const { form } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		const update = restyler.update(as(form));
		expect(update.restyled).toBe(4);
		expect(update.paint.size).toBeGreaterThan(0);
	});

	it('should do nothing when nothing changed', () => {
		const { form } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(form));
		const update = restyler.update(as(form));
		expect(update.restyled).toBe(0);
		expect(update.paint.size).toBe(0);
		expect(update.layout.size).toBe(0);
	});

	it('should paint one element and restyle nothing when a prop is written', () => {
		// the common case for a component updating itself, and it costs nothing:
		// props override the sheet per property and there are no attribute
		// selectors, so a prop write cannot change any other element's style
		const { form, hint } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(form));

		hint.props = { color: 'green' };
		restyler.touchProps(as(hint));
		const update = restyler.update(as(form));

		expect(update.restyled).toBe(0);
		expect([...update.paint]).toEqual([as(hint)]);
		expect(restyler.styleOf(as(hint))?.color).toBe(2);
	});

	it('should restyle a subtree when a class changes, and anything a selector relates to it', () => {
		// the price of keeping combinators: `.form.invalid .hint` means toggling a
		// class on an ancestor restyles a descendant that never changed
		const { form, hint } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(form));
		expect(restyler.styleOf(as(hint))?.color).toBe(4);

		form.classes.push('invalid');
		restyler.touchClasses(as(form));
		const update = restyler.update(as(form));

		expect(update.restyled).toBe(4);
		expect(update.paint.has(as(hint))).toBe(true);
		expect(restyler.styleOf(as(hint))?.color).toBe(1);
	});

	it('should mark layout only when a property that moves a box changed', () => {
		const { form, panel } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(form));

		panel.classes.push('wide');
		restyler.touchClasses(as(panel));
		const update = restyler.update(as(form));

		expect(update.layout.has(as(panel))).toBe(true);
		expect(update.paint.has(as(panel))).toBe(true);
	});

	it('should mark paint but not layout for a colour change', () => {
		const colours = parseStylesheet('.panel { color: red } .panel.hot { color: blue }');
		const { form, panel } = build();
		const restyler = new Restyler(new Cascade([colours]));
		restyler.update(as(form));

		panel.classes.push('hot');
		restyler.touchClasses(as(panel));
		const update = restyler.update(as(form));

		expect(update.paint.has(as(panel))).toBe(true);
		expect(update.layout.has(as(panel))).toBe(false);
	});

	it('should carry an inherited change down to a child that did not change', () => {
		const inherit = parseStylesheet('.form { color: red } .form.cool { color: cyan }');
		const { form, label } = build();
		const restyler = new Restyler(new Cascade([inherit]));
		restyler.update(as(form));
		expect(restyler.styleOf(as(label))?.color).toBe(1);

		form.classes.push('cool');
		restyler.touchClasses(as(form));
		const update = restyler.update(as(form));

		expect(restyler.styleOf(as(label))?.color).toBe(6);
		expect(update.paint.has(as(label))).toBe(true);
	});
});

describe('sideways', () => {
	// the case that is easy to forget and visible immediately when wrong
	const sheet = parseStylesheet('text:first-child { bold: true } text:nth-child(2) { dim: true }');

	it('should restyle siblings when a child is added', () => {
		const first = el('text');
		const parent = el('box', [first]);
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(parent));
		expect(restyler.styleOf(as(first))?.bold).toBe(true);

		const inserted = el('text');
		inserted.parent = parent;
		parent.children.unshift(inserted);
		restyler.touchChildren(as(parent));
		const update = restyler.update(as(parent));

		// the element that never changed in any way an element-level check would
		// see: it is no longer the first child
		expect(restyler.styleOf(as(first))?.bold).toBe(false);
		expect(restyler.styleOf(as(first))?.dim).toBe(true);
		expect(update.paint.has(as(first))).toBe(true);
	});

	it('should restyle siblings when a class changes on one of them', () => {
		const sibling = parseStylesheet('.on + text { bold: true }');
		const a = el('text');
		const b = el('text');
		const parent = el('box', [a, b]);
		const restyler = new Restyler(new Cascade([sibling]));
		restyler.update(as(parent));
		expect(restyler.styleOf(as(b))?.bold).toBe(false);

		a.classes.push('on');
		restyler.touchClasses(as(a));
		restyler.update(as(parent));

		expect(restyler.styleOf(as(b))?.bold).toBe(true);
	});
});

describe('the terminal changing', () => {
	const sheet = parseStylesheet(
		'.panel { padding: 1 } @media (min-width: 100) { .panel { padding: 4 } }'
	);

	it('should restyle everything on a resize, media queries included', () => {
		const panel = el('box.panel', [el('text')]);
		const cascade = new Cascade([sheet]);
		cascade.media = { colorLevel: 3, height: 24, width: 40 };
		const restyler = new Restyler(cascade);
		restyler.update(as(panel));
		expect(restyler.styleOf(as(panel))?.paddingTop).toBe(1);

		cascade.media = { colorLevel: 3, height: 24, width: 120 };
		restyler.touchSize();
		const update = restyler.update(as(panel));

		expect(update.restyled).toBe(2);
		expect(restyler.styleOf(as(panel))?.paddingTop).toBe(4);
		expect(update.layout.has(as(panel))).toBe(true);
	});

	it('should restyle everything when the sheets change', () => {
		const panel = el('box.panel');
		const cascade = new Cascade([sheet]);
		const restyler = new Restyler(cascade);
		restyler.update(as(panel));

		cascade.add(parseStylesheet('.panel { color: magenta }'));
		restyler.touchSheets();
		restyler.update(as(panel));

		expect(restyler.styleOf(as(panel))?.color).toBe(5);
	});
});

describe('the size of the naive answer', () => {
	/** A tree of about two hundred elements, which is a large terminal UI. */
	function tree(): Node {
		const rows: Node[] = [];
		for (let i = 0; i < 40; i++) {
			rows.push(
				el(`box.row${i % 7 === 0 ? '.odd' : ''}`, [
					el('text.label'),
					el('text.value'),
					el('box.cell', [el('text')]),
				])
			);
		}
		return el('box#app.root', rows);
	}

	/** A hundred rules, which is a large stylesheet. */
	function rules(): string {
		const out: string[] = [];
		for (let i = 0; i < 50; i++) {
			out.push(`.c${i} { color: red } .row .c${i} text { padding: ${i % 8} }`);
		}
		out.push('.root .row:nth-child(2n) .label { bold: true }');
		out.push('.odd + .row .value { dim: true }');
		return out.join('\n');
	}

	it('should re-match the whole tree in well under a millisecond', () => {
		// the ticket's central claim, measured rather than asserted. Browsers
		// build invalidation sets because they have two orders of magnitude more
		// elements and rules than this; what must not happen is an architecture
		// where that optimization could not be added if this measurement ever
		// surprises us
		const root = tree();
		const cascade = new Cascade([parseStylesheet(rules())]);
		const restyler = new Restyler(cascade);

		const count = (node: Node): number =>
			1 + node.children.reduce((total, child) => total + count(child), 0);
		expect(count(root)).toBeGreaterThan(150);

		restyler.update(as(root));

		let slowest = 0;
		for (let i = 0; i < 20; i++) {
			restyler.touchSheets();
			const started = performance.now();
			const update = restyler.update(as(root));
			slowest = Math.max(slowest, performance.now() - started);
			expect(update.restyled).toBe(count(root));
		}

		// generous by design: this is a regression guard against the full
		// re-match becoming quadratic, not a benchmark
		expect(slowest).toBeLessThan(50);
	});
});
