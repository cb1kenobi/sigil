import { palette } from '../../src/canvas/index.js';
import {
	AUTO,
	cells,
	DEFAULT_MEDIA,
	LAYERS,
	matchesMedia,
	ORIGINS,
	parseMediaQueryList,
	parseStylesheet,
	StyleError,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

describe('reading a stylesheet', () => {
	it('should read a rule into selectors and longhands', () => {
		const sheet = parseStylesheet('.panel, text#a { color: red; padding: 1 2 }');
		expect(sheet.rules).toHaveLength(1);

		const [rule] = sheet.rules;
		expect(rule.selectors.map((s) => s.source)).toEqual(['.panel', 'text#a']);
		expect(rule.declarations).toEqual([
			{ important: false, property: 'color', value: palette(1) },
			{ important: false, property: 'paddingTop', value: 1 },
			{ important: false, property: 'paddingRight', value: 2 },
			{ important: false, property: 'paddingBottom', value: 1 },
			{ important: false, property: 'paddingLeft', value: 2 },
		]);
	});

	it('should default a sheet to the app origin and the components layer', () => {
		const [rule] = parseStylesheet('.a { color: red }').rules;
		expect(parseStylesheet('.a { color: red }').origin).toBe('app');
		// where a hand-written sheet belongs: it is what the utilities layer has to
		// be able to beat
		expect(rule.layer).toBe('components');
	});

	it('should take an origin and a default layer', () => {
		const sheet = parseStylesheet('.a { color: red }', { layer: 'base', origin: 'framework' });
		expect(sheet.origin).toBe('framework');
		expect(sheet.rules[0].layer).toBe('base');
	});

	it('should number rules in source order', () => {
		const sheet = parseStylesheet('.a { color: red } .b { color: blue } .c { color: green }');
		expect(sheet.rules.map((rule) => rule.order)).toEqual([0, 1, 2]);
	});

	it('should read !important, in any spelling', () => {
		const sheet = parseStylesheet('.a { color: red !important; padding: 1 ! IMPORTANT }');
		expect(sheet.rules[0].declarations.every((d) => d.important)).toBe(true);
	});

	it('should read an alias that covers more than one longhand', () => {
		const [rule] = parseStylesheet('.a { font-weight: bold }').rules;
		expect(rule.declarations).toEqual([
			{ important: false, property: 'bold', value: true },
			{ important: false, property: 'dim', value: false },
		]);
	});

	it('should skip comments wherever they sit', () => {
		const sheet = parseStylesheet(`
			/* a leading comment */
			.a /* between */ .b {
				color: /* inside */ red;
				/* whole */
				padding: 1
			}
			/* trailing */
		`);
		expect(sheet.rules).toHaveLength(1);
		expect(sheet.rules[0].selectors[0].source).toBe('.a   .b');
		expect(sheet.rules[0].declarations).toHaveLength(5);
	});

	it('should not split a declaration on a semicolon inside a comment', () => {
		const [rule] = parseStylesheet('.a { color: red /* ; padding: 9 */ }').rules;
		expect(rule.declarations).toEqual([{ important: false, property: 'color', value: palette(1) }]);
	});

	it('should take an empty rule and a trailing semicolon', () => {
		expect(parseStylesheet('.a { }').rules[0].declarations).toEqual([]);
		expect(parseStylesheet('.a { color: red; }').rules[0].declarations).toHaveLength(1);
	});

	it('should say which line an error was on', () => {
		expect(() => parseStylesheet('.a { color: red }\n\n.b { colour: red }')).toThrow(
			/line 3.*Unknown property "colour"/
		);
		expect(() => parseStylesheet('\n\n.a { padding: 1 nonsense }')).toThrow(
			// the longhand that could not take the value, not the shorthand, which
			// could not have said which part was wrong
			/line 3.*padding-right/
		);
	});

	it('should refuse what it cannot read', () => {
		expect(() => parseStylesheet('.a { color red }')).toThrow(/expected "property: value"/);
		expect(() => parseStylesheet('.a { color: }')).toThrow(/no value for "color"/);
		expect(() => parseStylesheet('.a { color: red')).toThrow(/unclosed rule/);
		expect(() => parseStylesheet('.a color: red }')).toThrow(StyleError);
		expect(() => parseStylesheet('}')).toThrow(/unexpected "}"/);
		expect(() => parseStylesheet('.a { color: red /* }')).toThrow(/unterminated comment/);
		expect(() => parseStylesheet('@nonsense { }')).toThrow(/unknown at-rule "@nonsense"/);
	});
});

describe('the wide keywords', () => {
	it('should reach every longhand a shorthand covers', () => {
		// asked before there is a value to expand, which is why the shorthand table
		// carries its longhands rather than deriving them from a use
		const [rule] = parseStylesheet('.a { padding: inherit }').rules;
		expect(rule.declarations).toEqual([
			{ important: false, keyword: 'inherit', property: 'paddingTop' },
			{ important: false, keyword: 'inherit', property: 'paddingRight' },
			{ important: false, keyword: 'inherit', property: 'paddingBottom' },
			{ important: false, keyword: 'inherit', property: 'paddingLeft' },
		]);
	});

	it('should reach every longhand an alias covers', () => {
		const [rule] = parseStylesheet('.a { font-weight: unset }').rules;
		expect(rule.declarations.map((d) => d.property)).toEqual(['bold', 'dim']);
	});

	it('should read all three, in any case', () => {
		const [rule] = parseStylesheet('.a { color: INHERIT; width: initial; height: Unset }').rules;
		expect(rule.declarations.map((d) => d.keyword)).toEqual(['inherit', 'initial', 'unset']);
	});

	it('should not be reachable through a value parser', () => {
		// `inherit` is not a colour, and a value parser has no parent to ask
		expect(() => parseStylesheet('.a { border: inherit red }')).toThrow(StyleError);
	});
});

describe('layers', () => {
	it('should put a rule in the layer that encloses it', () => {
		const sheet = parseStylesheet(`
			@layer base { text { color: default } }
			@layer utilities { .p-2 { padding: 2 } }
			.button { padding: 4 }
		`);
		expect(sheet.rules.map((rule) => rule.layer)).toEqual(['base', 'utilities', 'components']);
	});

	it('should keep the three fixed', () => {
		expect(LAYERS).toEqual(['base', 'components', 'utilities']);
		expect(ORIGINS).toEqual(['framework', 'theme', 'app']);
		expect(() => parseStylesheet('@layer mine { .a { color: red } }')).toThrow(
			/the layers are fixed/
		);
		expect(() => parseStylesheet('@layer base, utilities;')).toThrow(/layer order is fixed/);
	});

	it('should number rules across layers in source order', () => {
		const sheet = parseStylesheet('@layer utilities { .a { color: red } } .b { color: blue }');
		expect(sheet.rules.map((rule) => rule.order)).toEqual([0, 1]);
	});
});

describe('media queries', () => {
	const wide = { colorLevel: 3, height: 50, width: 120 };

	it('should read a feature test', () => {
		expect(parseMediaQueryList('(min-width: 100)')).toEqual([
			[{ feature: 'width', kind: 'min', value: 100 }],
		]);
		expect(parseMediaQueryList('(max-height: 20)')).toEqual([
			[{ feature: 'height', kind: 'max', value: 20 }],
		]);
		expect(parseMediaQueryList('(width: 80)')).toEqual([
			[{ feature: 'width', kind: 'exact', value: 80 }],
		]);
		// the bare form: not zero, which for a colour level means "any colour"
		expect(parseMediaQueryList('(color-level)')).toEqual([
			[{ feature: 'color-level', kind: 'boolean', value: 0 }],
		]);
	});

	it('should join with and, and separate with a comma', () => {
		expect(
			parseMediaQueryList('(min-width: 100) and (min-height: 20), (color-level: 0)')
		).toHaveLength(2);
	});

	it('should refuse a feature it does not have', () => {
		expect(() => parseMediaQueryList('(orientation: landscape)')).toThrow(
			/Unknown media feature "orientation"/
		);
		// CSS's `color` counts bits per component; this has one scale for colour
		// and it is ColorLevel's
		expect(() => parseMediaQueryList('(min-color: 8)')).toThrow(/Unknown media feature/);
		expect(() => parseMediaQueryList('screen and (min-width: 10)')).toThrow(
			/expected a parenthesised feature test/
		);
		expect(() => parseMediaQueryList('(min-width: 10) (max-width: 20)')).toThrow(/expected "and"/);
		expect(() => parseMediaQueryList('(min-width: wide)')).toThrow(/expected a whole number/);
		expect(() => parseMediaQueryList('(min-width)')).toThrow(/needs a value/);
		expect(() => parseMediaQueryList('')).toThrow(/asks nothing/);
	});

	it('should match a context against a query', () => {
		const query = (source: string) => [parseMediaQueryList(source)];
		expect(matchesMedia(query('(min-width: 100)'), wide)).toBe(true);
		expect(matchesMedia(query('(min-width: 200)'), wide)).toBe(false);
		expect(matchesMedia(query('(max-width: 200) and (min-height: 10)'), wide)).toBe(true);
		expect(matchesMedia(query('(max-width: 200) and (min-height: 80)'), wide)).toBe(false);
		expect(matchesMedia(query('(width: 500), (width: 120)'), wide)).toBe(true);
		expect(matchesMedia(query('(color-level)'), { ...wide, colorLevel: 0 })).toBe(false);
		expect(matchesMedia([], wide)).toBe(true);
	});

	it('should require every enclosing query when they nest', () => {
		const sheet = parseStylesheet(`
			@media (min-width: 100) {
				@media (min-height: 20) {
					.a { color: red }
				}
			}
		`);
		expect(sheet.rules[0].media).toHaveLength(2);
		expect(matchesMedia(sheet.rules[0].media, wide)).toBe(true);
		expect(matchesMedia(sheet.rules[0].media, { ...wide, height: 10 })).toBe(false);
	});

	it('should carry the layer through a media block and the media through a layer', () => {
		const sheet = parseStylesheet(`
			@layer utilities {
				@media (min-width: 100) { .p-2 { padding: 2 } }
			}
			@media (min-width: 100) {
				@layer base { text { color: red } }
			}
		`);
		expect(sheet.rules.map((rule) => rule.layer)).toEqual(['utilities', 'base']);
		expect(sheet.rules.map((rule) => rule.media.length)).toEqual([1, 1]);
	});

	it('should ask 80 by 24 truecolor when nobody said', () => {
		expect(DEFAULT_MEDIA).toEqual({ colorLevel: 3, height: 24, width: 80 });
		expect(Object.isFrozen(DEFAULT_MEDIA)).toBe(true);
	});

	it('should refuse an unclosed or empty at-rule', () => {
		expect(() => parseStylesheet('@media (min-width: 10) { .a { color: red }')).toThrow(
			/unclosed block/
		);
		expect(() => parseStylesheet('@media { .a { color: red } }')).toThrow(/asks nothing/);
		expect(() => parseStylesheet('@media (min-width: 10);')).toThrow(/expected "\{"/);
	});
});

describe('what a parsed sheet is', () => {
	it('should be frozen, and so should its rules', () => {
		const sheet = parseStylesheet('.a { color: red }');
		expect(Object.isFrozen(sheet)).toBe(true);
		expect(Object.isFrozen(sheet.rules)).toBe(true);
		expect(Object.isFrozen(sheet.rules[0])).toBe(true);
	});

	it('should hold parsed values rather than source text', () => {
		const [rule] = parseStylesheet('.a { width: auto; height: 3 }').rules;
		expect(rule.declarations[0].value).toBe(AUTO);
		expect(rule.declarations[1].value).toEqual(cells(3));
	});
});
