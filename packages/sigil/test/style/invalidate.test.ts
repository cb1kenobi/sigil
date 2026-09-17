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

	it('should classify the ones people get wrong', () => {
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

	it('should carry an inherited prop down to descendants', () => {
		// the claim that broke: props cannot change what another element *matches*,
		// which is not the same as cannot change another element. `color` inherits,
		// so a prop on the parent is a different resolved style on every child
		const { form, hint, label, panel } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(form));
		expect(restyler.styleOf(as(label))?.color).toBe(4);

		panel.props = { color: 'magenta' };
		restyler.touchProps(as(panel));
		const update = restyler.update(as(form));

		expect(restyler.styleOf(as(panel))?.color).toBe(5);
		// text { color: blue } still wins over what it inherits, because a
		// matching rule beats inheritance -- but the hint has no rule of its own
		expect(restyler.styleOf(as(label))?.color).toBe(4);
		expect(update.paint.has(as(panel))).toBe(true);
		expect(update.restyled).toBeGreaterThan(0);
		expect(restyler.styleOf(as(hint))?.color).toBe(4);
	});

	it('should carry an inherited prop to a child with no rule of its own', () => {
		const bare = parseStylesheet('.panel { color: red }');
		const child = el('box');
		const panel = el('box.panel', [child]);
		const restyler = new Restyler(new Cascade([bare]));
		restyler.update(as(panel));
		expect(restyler.styleOf(as(child))?.color).toBe(1);

		panel.props = { color: 'cyan' };
		restyler.touchProps(as(panel));
		const update = restyler.update(as(panel));

		expect(restyler.styleOf(as(child))?.color).toBe(6);
		expect(update.paint.has(as(child))).toBe(true);
	});

	it('should mark layout when a prop sets a property that moves a box', () => {
		// a renderer that trusts Update.layout would paint the new style into the
		// old box
		const { form, panel } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(form));

		panel.props = { width: '40' };
		restyler.touchProps(as(panel));
		const update = restyler.update(as(form));

		expect(update.layout.has(as(panel))).toBe(true);
		expect(update.paint.has(as(panel))).toBe(true);
	});

	it('should not paint an element whose prop write changed nothing', () => {
		const { form, panel } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		panel.props = { color: 'red' };
		restyler.update(as(form));

		restyler.touchProps(as(panel));
		const update = restyler.update(as(form));
		expect(update.paint.has(as(panel))).toBe(false);
	});

	it('should settle a prop on a parent and a child in one update', () => {
		const bare = parseStylesheet('.panel { color: red }');
		const child = el('box');
		const panel = el('box.panel', [child]);
		const restyler = new Restyler(new Cascade([bare]));
		restyler.update(as(panel));

		panel.props = { color: 'cyan' };
		child.props = { bold: 'true' };
		restyler.touchProps(as(panel));
		restyler.touchProps(as(child));
		restyler.update(as(panel));

		// the child is restyled because its parent's inherited value changed, and
		// its own prop still applies on top
		expect(restyler.styleOf(as(child))?.color).toBe(6);
		expect(restyler.styleOf(as(child))?.bold).toBe(true);
	});

	it('should not paint an element that was restyled to the same answer', () => {
		const { form, panel } = build();
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(form));

		panel.classes.push('irrelevant');
		restyler.touchClasses(as(panel));
		const update = restyler.update(as(form));

		expect(update.restyled).toBeGreaterThan(0);
		expect(update.paint.has(as(panel))).toBe(false);
		expect(update.layout.size).toBe(0);
	});

	it('should put everything in layout on the first resolution', () => {
		const { form, panel } = build();
		const update = new Restyler(new Cascade([sheet])).update(as(form));
		expect(update.layout.has(as(form))).toBe(true);
		expect(update.layout.has(as(panel))).toBe(true);
	});

	it('should restyle for a state change the way it does for a class', () => {
		const focus = parseStylesheet('.panel:focus text { bold: true }');
		const { form, label, panel } = build();
		const restyler = new Restyler(new Cascade([focus]));
		restyler.update(as(form));
		expect(restyler.styleOf(as(label))?.bold).toBe(false);

		panel.states.push('focus');
		restyler.touchClasses(as(panel));
		restyler.update(as(form));

		expect(restyler.styleOf(as(label))?.bold).toBe(true);
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

	it('should restyle who is left when a child is removed', () => {
		const a = el('text');
		const b = el('text');
		const parent = el('box', [a, b]);
		const restyler = new Restyler(new Cascade([sheet]));
		restyler.update(as(parent));
		expect(restyler.styleOf(as(b))?.dim).toBe(true);

		parent.children.shift();
		restyler.forget(as(a));
		restyler.touchChildren(as(parent));
		restyler.update(as(parent));

		expect(restyler.styleOf(as(b))?.bold).toBe(true);
		expect(restyler.styleOf(as(b))?.dim).toBe(false);
		// and the removed element is gone rather than held for the life of the
		// Restyler, which in a long-running TUI is a leak
		expect(restyler.styleOf(as(a))).toBeUndefined();
	});

	it('should resolve a reinserted element against where it is now', () => {
		// the "never resolved" branch is the safety net and it does not fire for
		// an element object that was detached and put back somewhere else
		const moving = el('text');
		const here = el('box.here', [moving]);
		const there = el('box.there');
		const root = el('box', [here, there]);
		const sheets = parseStylesheet('.here text { bold: true } .there text { dim: true }');
		const restyler = new Restyler(new Cascade([sheets]));
		restyler.update(as(root));
		expect(restyler.styleOf(as(moving))?.bold).toBe(true);

		here.children.pop();
		restyler.forget(as(moving));
		there.children.push(moving);
		moving.parent = there;
		restyler.touchChildren(as(here));
		restyler.touchChildren(as(there));
		restyler.update(as(root));

		expect(restyler.styleOf(as(moving))?.bold).toBe(false);
		expect(restyler.styleOf(as(moving))?.dim).toBe(true);
	});

	it('should restyle a later sibling for a ~ combinator', () => {
		const later = parseStylesheet('.on ~ text { bold: true }');
		const a = el('text');
		const b = el('text');
		const c = el('text');
		const parent = el('box', [a, b, c]);
		const restyler = new Restyler(new Cascade([later]));
		restyler.update(as(parent));

		a.classes.push('on');
		restyler.touchClasses(as(a));
		restyler.update(as(parent));

		expect(restyler.styleOf(as(b))?.bold).toBe(true);
		expect(restyler.styleOf(as(c))?.bold).toBe(true);
	});

	it('should restyle a descendant of a sibling', () => {
		const deep = parseStylesheet('.on + box text { bold: true }');
		const inner = el('text');
		const a = el('box');
		const b = el('box', [inner]);
		const parent = el('box', [a, b]);
		const restyler = new Restyler(new Cascade([deep]));
		restyler.update(as(parent));
		expect(restyler.styleOf(as(inner))?.bold).toBe(false);

		a.classes.push('on');
		restyler.touchClasses(as(a));
		restyler.update(as(parent));

		expect(restyler.styleOf(as(inner))?.bold).toBe(true);
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

describe('the inherit keyword', () => {
	// `inherit` works on a property that does not inherit by default -- that is
	// the whole reason to write it -- so "force children when an INHERITED
	// property changed" is not the same question as "can a child read this"
	const sheet = parseStylesheet('.child { width: inherit }');

	it('should reach a child that inherits a property which does not inherit', () => {
		const child = el('box.child');
		const parent = el('box.parent', [child]);
		const restyler = new Restyler(new Cascade([sheet]));
		parent.props = { width: '10' };
		restyler.update(as(parent));
		expect(restyler.styleOf(as(child))?.width).toEqual({ type: 'cells', value: 10 });

		parent.props = { width: '20' };
		restyler.touchProps(as(parent));
		const update = restyler.update(as(parent));

		expect(restyler.styleOf(as(child))?.width).toEqual({ type: 'cells', value: 20 });
		expect(update.layout.has(as(child))).toBe(true);
	});

	it('should still cost nothing when a prop write changed nothing', () => {
		const child = el('box.child');
		const parent = el('box.parent', [child]);
		const restyler = new Restyler(new Cascade([sheet]));
		parent.props = { width: '10' };
		restyler.update(as(parent));

		restyler.touchProps(as(parent));
		const update = restyler.update(as(parent));
		expect(update.restyled).toBe(0);
		expect(update.paint.size).toBe(0);
	});

	it('should cost nothing on a leaf, which is where a prop write usually lands', () => {
		const leaf = el('text');
		const parent = el('box', [leaf]);
		const restyler = new Restyler(new Cascade([parseStylesheet('text { color: red }')]));
		restyler.update(as(parent));

		leaf.props = { color: 'blue' };
		restyler.touchProps(as(leaf));
		const update = restyler.update(as(parent));

		expect(update.restyled).toBe(0);
		expect([...update.paint]).toEqual([as(leaf)]);
	});
});

describe('an inherit chain', () => {
	// the fix that was one level too shallow: a node restyled because its parent
	// forced it decided about its own children with the narrow rule, so the
	// second link of the chain never moved
	const sheet = parseStylesheet('.mid { width: inherit } .leaf { width: inherit }');

	const chain = () => {
		const leaf = el('box.leaf');
		const mid = el('box.mid', [leaf]);
		const grand = el('box.grand', [mid]);
		return { grand, leaf, mid };
	};

	it('should reach every level of the chain', () => {
		const { grand, leaf, mid } = chain();
		const restyler = new Restyler(new Cascade([sheet]));
		grand.props = { width: '10' };
		restyler.update(as(grand));
		expect(restyler.styleOf(as(leaf))?.width).toEqual({ type: 'cells', value: 10 });

		grand.props = { width: '20' };
		restyler.touchProps(as(grand));
		restyler.update(as(grand));

		expect(restyler.styleOf(as(mid))?.width).toEqual({ type: 'cells', value: 20 });
		expect(restyler.styleOf(as(leaf))?.width).toEqual({ type: 'cells', value: 20 });
	});

	it('should agree with a Restyler that has never seen the tree', () => {
		// the property worth pinning rather than any particular rule: after any
		// sequence of marks, a cached style is what a fresh resolve would produce
		const { grand, leaf, mid } = chain();
		const cascade = new Cascade([sheet]);
		const restyler = new Restyler(cascade);

		grand.props = { width: '10' };
		restyler.update(as(grand));
		grand.props = { width: '20' };
		restyler.touchProps(as(grand));
		restyler.update(as(grand));
		mid.classes.push('extra');
		restyler.touchClasses(as(mid));
		restyler.update(as(grand));

		const fresh = new Restyler(cascade);
		fresh.update(as(grand));

		for (const node of [grand, mid, leaf]) {
			expect(restyler.styleOf(as(node)), node.classes.join('.')).toEqual(fresh.styleOf(as(node)));
		}
	});
});
