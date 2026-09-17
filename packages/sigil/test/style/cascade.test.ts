import { palette } from '../../src/canvas/index.js';
import {
	applyProps,
	Cascade,
	cells,
	declare,
	initialStyle,
	parseStylesheet,
	type Style,
	type StyleNode,
	StyleError,
	type Stylesheet,
	type StylesheetOptions,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

const sheet = (source: string, opts?: StylesheetOptions): Stylesheet =>
	parseStylesheet(source, opts);

const node = (spec: Partial<StyleNode> & { type: string }): StyleNode => spec;

/** The one element most of these are about. */
const button = node({ classes: ['button', 'p-2'], id: 'go', type: 'box' });

const resolve = (source: string | Stylesheet[], target = button, props?: Record<string, string>) =>
	new Cascade(typeof source === 'string' ? [sheet(source)] : source).resolve(target, { props });

describe('the cascade', () => {
	it('should start from the initial values and set only what matched', () => {
		const style = resolve('.button { color: red }');
		expect(style.color).toEqual(palette(1));
		expect(style).toEqual({ ...initialStyle(), color: palette(1) });
	});

	it('should ignore a rule that does not match', () => {
		expect(resolve('.other { color: red }').color).toEqual(initialStyle().color);
	});

	it('should let the more specific selector win, whatever the order', () => {
		expect(resolve('#go { color: red } .button { color: blue }').color).toEqual(palette(1));
		expect(resolve('.button { color: blue } #go { color: red }').color).toEqual(palette(1));
	});

	it('should break a specificity tie on source order', () => {
		expect(resolve('.button { color: red } .p-2 { color: blue }').color).toEqual(palette(4));
	});

	it('should break a tie across sheets on the order they were added', () => {
		const style = resolve([sheet('.button { color: red }'), sheet('.button { color: blue }')]);
		expect(style.color).toEqual(palette(4));
	});

	it('should take the highest specificity among a rule’s matching selectors', () => {
		// a selector list behaves as though the rule were written once per selector
		expect(resolve('#go, box { color: red } .button { color: blue }').color).toEqual(palette(1));
	});

	it('should resolve each property on its own', () => {
		const style = resolve('#go { color: red } .button { padding: 2; color: blue }');
		expect(style.color).toEqual(palette(1));
		expect(style.paddingTop).toBe(2);
	});
});

describe('origin', () => {
	const sheets = (...origins: ('app' | 'framework' | 'theme')[]) =>
		origins.map((origin) => sheet(`.button { color: ${COLORS[origin]} }`, { origin }));

	const COLORS = { app: 'green', framework: 'red', theme: 'blue' } as const;

	it('should let the app beat the theme and the theme beat the framework', () => {
		expect(resolve(sheets('app', 'theme', 'framework')).color).toEqual(palette(2));
		expect(resolve(sheets('theme', 'framework')).color).toEqual(palette(4));
	});

	it('should beat specificity, because origin is asked first', () => {
		const style = resolve([
			sheet('#go.button { color: red }', { origin: 'framework' }),
			sheet('box { color: blue }', { origin: 'app' }),
		]);
		expect(style.color).toEqual(palette(4));
	});
});

describe('layers', () => {
	// the example from the ticket, and the reason the axis exists: a component
	// class and a utility class have identical specificity, so without layers it
	// comes down to which sheet was concatenated last
	const components = '.button { padding: 4 }';
	const utilities = '@layer utilities { .p-2 { padding: 2 } }';

	it('should let a utility beat a component rule whatever the order', () => {
		expect(resolve(`${components} ${utilities}`).paddingTop).toBe(2);
		expect(resolve(`${utilities} ${components}`).paddingTop).toBe(2);
	});

	it('should let a component rule beat the base layer whatever the specificity', () => {
		const style = resolve('@layer base { #go { padding: 4 } } .button { padding: 2 }');
		expect(style.paddingTop).toBe(2);
	});

	it('should be asked after origin, not before', () => {
		// the layer order happens *within* an origin: your components lose to your
		// utilities, deliberately -- but nothing in the framework's sheet gets to
		// beat the app's on the strength of its layer
		const style = resolve([
			sheet('@layer utilities { .p-2 { padding: 4 } }', { origin: 'framework' }),
			sheet('@layer base { .button { padding: 2 } }', { origin: 'app' }),
		]);
		expect(style.paddingTop).toBe(2);
	});
});

describe('!important', () => {
	it('should beat a normal declaration of any specificity', () => {
		expect(resolve('#go { color: red } .button { color: blue !important }').color).toEqual(
			palette(4)
		);
	});

	it('should invert the origin, so an app sheet can reach past a component', () => {
		const style = resolve([
			sheet('.button { color: red !important }', { origin: 'framework' }),
			sheet('.button { color: blue !important }', { origin: 'app' }),
		]);
		expect(style.color).toEqual(palette(1));
	});

	it('should invert the layer order too, which is what CSS does', () => {
		const style = resolve(
			'@layer base { .button { padding: 4 !important } } @layer utilities { .p-2 { padding: 2 !important } }'
		);
		expect(style.paddingTop).toBe(4);
	});

	it('should not invert specificity or source order', () => {
		expect(
			resolve('.button { color: red !important } #go { color: blue !important }').color
		).toEqual(palette(4));
		expect(
			resolve('.button { color: red !important } .p-2 { color: blue !important }').color
		).toEqual(palette(4));
	});
});

describe('props', () => {
	it('should beat every normal declaration', () => {
		expect(resolve('#go { color: red }', button, { color: 'blue' }).color).toEqual(palette(4));
	});

	it('should apply per property, leaving the rest of the sheet alone', () => {
		// a sheet setting color and a prop setting padding both apply, which is
		// where `style=""` sits in a browser
		const style = resolve('.button { color: red; padding: 1 }', button, { padding: '3' });
		expect(style.color).toEqual(palette(1));
		expect(style.paddingTop).toBe(3);
	});

	it('should lose to !important, which is the point of retaining it', () => {
		// a component that bakes color="red" into its template would otherwise be
		// unthemeable, with no recourse
		const style = resolve('.button { color: red !important }', button, { color: 'blue' });
		expect(style.color).toEqual(palette(1));
	});

	it('should read a shorthand, an alias, and either spelling', () => {
		const style = resolve('', button, {
			backgroundColor: 'blue',
			'font-weight': 'bold',
			padding: '1 2',
		});
		expect(style.backgroundColor).toEqual(palette(4));
		expect(style.bold).toBe(true);
		expect(style.paddingRight).toBe(2);
	});

	it('should take a number or a boolean as what it would have been written as', () => {
		const cascade = new Cascade();
		const style = cascade.resolve(button, { props: { bold: true, width: 10 } });
		expect(style.width).toEqual(cells(10));
		expect(style.bold).toBe(true);
	});

	it('should skip a prop the template did not set', () => {
		const style = new Cascade().resolve(button, { props: { color: undefined } });
		expect(style.color).toEqual(initialStyle().color);
	});

	it('should still refuse a value it cannot read', () => {
		expect(() => resolve('', button, { color: 'chartreuse' })).toThrow(StyleError);
	});
});

describe('the prop fast path', () => {
	// a prop write never affects any other element's resolved style, so it skips
	// the cascade entirely: re-applying props over a kept result is the whole of
	// the work, with no selector matched
	const cascade = new Cascade([
		sheet('.button { color: red; padding: 1 } .button { width: 4 !important }'),
	]);

	it('should give the same answer as resolving the whole thing', () => {
		const result = cascade.resolveSheets(button);
		expect(applyProps(result, { padding: '3' })).toEqual(
			cascade.resolve(button, { props: { padding: '3' } })
		);
	});

	it('should leave the kept result alone, so it answers again', () => {
		const result = cascade.resolveSheets(button);
		const before = { ...result.style };
		applyProps(result, { color: 'blue', padding: '3' });
		expect(result.style).toEqual(before);
		expect(applyProps(result, {}).color).toEqual(palette(1));
	});

	it('should report what an important declaration locked', () => {
		const result = cascade.resolveSheets(button);
		expect([...result.locked]).toEqual(['width']);
		expect(applyProps(result, { width: '9' }).width).toEqual(cells(4));
		expect(applyProps(result, { padding: '9' }).paddingTop).toBe(9);
	});
});

describe('inheritance', () => {
	const parent = declare({ color: 'red', padding: '2' });

	it('should carry an inherited property down and leave the rest at its initial', () => {
		const style = new Cascade().resolve(button, { parent });
		expect(style.color).toEqual(palette(1));
		expect(style.paddingTop).toBe(0);
	});

	it('should let a matching rule beat what was inherited', () => {
		const cascade = new Cascade([sheet('.button { color: blue }')]);
		expect(cascade.resolve(button, { parent }).color).toEqual(palette(4));
	});

	it('should read inherit, initial, and unset', () => {
		const cascade = new Cascade([
			sheet('.button { color: blue; padding: inherit } .button { color: inherit }'),
		]);
		const style = cascade.resolve(button, { parent });
		// `inherit` is the parent's value whether or not the property inherits on
		// its own, which is what makes it worth writing on padding
		expect(style.color).toEqual(palette(1));
		expect(style.paddingTop).toBe(2);

		const reset = new Cascade([
			sheet('.button { color: initial; width: unset } .button:not(.p-2) { color: blue }'),
		]).resolve(button, { parent });
		expect(reset.color).toEqual(initialStyle().color);
		expect(reset.width).toEqual(initialStyle().width);
	});

	it('should read unset as inherit for a property that inherits', () => {
		const cascade = new Cascade([sheet('.button { color: unset; padding: unset }')]);
		const style = cascade.resolve(button, { parent });
		expect(style.color).toEqual(palette(1));
		expect(style.paddingTop).toBe(0);
	});

	it('should read inherit at the root as the initial value', () => {
		expect(new Cascade([sheet('.button { color: inherit }')]).resolve(button).color).toEqual(
			initialStyle().color
		);
	});

	it('should take a wide keyword in a prop', () => {
		const cascade = new Cascade([sheet('.button { color: blue }')]);
		expect(cascade.resolve(button, { parent, props: { color: 'inherit' } }).color).toEqual(
			palette(1)
		);
	});

	it('should take a wide keyword in declare(), which has a parent to ask', () => {
		expect(declare({ color: 'inherit' }, parent).color).toEqual(palette(1));
		expect(declare({ color: 'initial' }, parent).color).toEqual(initialStyle().color);
	});
});

describe('media queries', () => {
	const cascade = new Cascade([
		sheet('.button { padding: 1 } @media (min-width: 100) { .button { padding: 4 } }'),
	]);

	it('should apply a rule only when its query holds', () => {
		cascade.media = { colorLevel: 3, height: 24, width: 120 };
		expect(cascade.resolve(button).paddingTop).toBe(4);

		cascade.media = { colorLevel: 3, height: 24, width: 40 };
		expect(cascade.resolve(button).paddingTop).toBe(1);
	});

	it('should ask the default context when nobody set one', () => {
		expect(
			new Cascade([sheet('@media (width: 80) { .button { padding: 4 } }')]).resolve(button)
				.paddingTop
		).toBe(4);
	});
});

describe('matching', () => {
	const cascade = new Cascade([
		sheet('.button { color: red } #go { color: blue } text { color: green } :focus { padding: 1 }'),
	]);

	it('should report each matched rule once, with the specificity that matched', () => {
		const matched = cascade.match(button);
		expect(matched).toHaveLength(2);
		expect(matched.map((m) => m.specificity)).toEqual(
			expect.arrayContaining([
				[0, 1, 0],
				[1, 0, 0],
			])
		);
	});

	it('should not report a rule whose bucket the element is not in', () => {
		// bucketed by the rightmost simple selector, so a `text` rule is never even
		// looked at for a box
		expect(cascade.match(node({ type: 'text' })).map((m) => m.rule.selectors[0].source)).toEqual([
			'text',
		]);
	});

	it('should always test the universal bucket', () => {
		expect(
			cascade.match(node({ states: ['focus'], type: 'text' })).map((m) => m.rule.order)
		).toEqual([3, 2]);
	});

	it('should rebuild the index when a sheet is added', () => {
		const growing = new Cascade();
		expect(growing.resolve(button).color).toEqual(initialStyle().color);
		growing.add(sheet('.button { color: red }'));
		expect(growing.sheets).toHaveLength(1);
		expect(growing.resolve(button).color).toEqual(palette(1));
	});
});

describe('what resolve hands back', () => {
	it('should be a complete style, every time', () => {
		const style: Style = resolve('.button { color: red }');
		expect(Object.keys(style).sort()).toEqual(Object.keys(initialStyle()).sort());
	});

	it('should be a new object per call, so nothing is shared', () => {
		const cascade = new Cascade([sheet('.button { color: red }')]);
		const first = cascade.resolve(button);
		const second = cascade.resolve(button);
		expect(first).not.toBe(second);
		expect(first).toEqual(second);
	});
});
