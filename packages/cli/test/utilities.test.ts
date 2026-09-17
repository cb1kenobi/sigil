import {
	expandApply,
	generateUtilities,
	utilities,
	VARIANT_NAMES,
} from '../src/utilities/index.js';
import { Cascade, parseStylesheet, PROPERTIES } from '@ttylabs/sigil/style';
import { describe, expect, it } from 'vitest';

const all = utilities();
const byName = new Map(all.map((utility) => [utility.name, utility]));
const sheet = parseStylesheet(generateUtilities());

/** Resolves a class string against the generated sheet. */
function resolve(classes: string[], width = 100, colorLevel = 3) {
	const cascade = new Cascade([sheet]);
	cascade.media = { colorLevel, height: 24, width };
	return cascade.resolve({ classes, type: 'box' });
}

describe('generated from the property table', () => {
	it('should give every keyword of a keyword family a utility', () => {
		// the point of putting the keyword lists on the table: a keyword added to
		// a property gets its utility for free rather than needing a second list
		// here to be remembered
		const declared = new Set(
			all.flatMap((utility) => utility.declarations.map(([property]) => property))
		);
		for (const property of ['justifyContent', 'alignItems', 'flexDirection', 'borderStyle']) {
			const keywords = PROPERTIES[property as 'display'].keywords;
			expect(keywords, property).toBeDefined();
			for (const keyword of keywords ?? []) {
				const found = all.some((utility) =>
					utility.declarations.some(([p, v]) => p === property && v === keyword)
				);
				expect(found, `no utility sets ${property}: ${keyword}`).toBe(true);
			}
		}
		expect(declared.size).toBeGreaterThan(20);
	});

	it('should refuse a utility whose value its own property would refuse', () => {
		// every declaration is parsed on the way out, which is what caught
		// `bright-black` -- a legal class name and not a colour the parser takes
		expect(() => generateUtilities()).not.toThrow();
	});

	it('should never generate two utilities of one name', () => {
		expect(new Set(all.map((utility) => utility.name)).size).toBe(all.length);
	});

	it('should keep hidden meaning display none', () => {
		expect(byName.get('hidden')?.declarations).toEqual([['display', 'none']]);
		expect(byName.get('invisible')?.declarations).toEqual([['visibility', 'hidden']]);
	});
});

describe('the vocabulary', () => {
	it('should spell the layout ones the way Tailwind does', () => {
		expect(byName.get('flex')?.declarations).toEqual([['display', 'flex']]);
		expect(byName.get('flex-col')?.declarations).toEqual([['flexDirection', 'column']]);
		expect(byName.get('justify-between')?.declarations).toEqual([
			['justifyContent', 'space-between'],
		]);
		expect(byName.get('items-center')?.declarations).toEqual([['alignItems', 'center']]);
	});

	it('should spell spacing with the edge suffixes', () => {
		expect(byName.get('p-2')?.declarations).toEqual([
			['padding-top', '2'],
			['padding-right', '2'],
			['padding-bottom', '2'],
			['padding-left', '2'],
		]);
		expect(byName.get('px-1')?.declarations).toEqual([
			['padding-left', '1'],
			['padding-right', '1'],
		]);
		expect(byName.get('mt-0')?.declarations).toEqual([['margin-top', '0']]);
		expect(byName.get('mx-auto')?.declarations).toEqual([
			['margin-left', 'auto'],
			['margin-right', 'auto'],
		]);
	});

	it('should give border a meaning a terminal can have', () => {
		// ours to define: a terminal border has exactly one width, so Tailwind's
		// `border-2` has nothing to mean here
		expect(byName.get('border')?.declarations).toEqual([['border-style', 'single']]);
		expect(byName.get('border-double')?.declarations).toEqual([['borderStyle', 'double']]);
		expect(byName.get('border-blue')?.declarations).toEqual([['border-color', 'blue']]);
	});

	it('should name the sixteen colours across the three colour properties', () => {
		for (const prefix of ['text', 'bg', 'border']) {
			expect(byName.has(`${prefix}-red`), prefix).toBe(true);
			expect(byName.has(`${prefix}-bright-black`), prefix).toBe(true);
		}
		// the class is hyphenated and the value is not
		expect(byName.get('text-bright-black')?.declarations).toEqual([['color', 'brightblack']]);
	});

	it('should give every attribute a utility and its opposite', () => {
		for (const name of ['bold', 'dim', 'italic', 'underline', 'strike', 'inverse']) {
			expect(byName.has(name), name).toBe(true);
			expect(byName.has(`not-${name}`), name).toBe(true);
		}
		expect(byName.get('strike')?.declarations).toEqual([['strikethrough', 'true']]);
	});

	it('should take a scale', () => {
		expect(utilities({ spacing: 2 }).some((u) => u.name === 'p-2')).toBe(true);
		expect(utilities({ spacing: 2 }).some((u) => u.name === 'p-3')).toBe(false);
		expect(utilities({ sizing: 4 }).some((u) => u.name === 'w-4')).toBe(true);
		expect(utilities({ sizing: 4 }).some((u) => u.name === 'w-5')).toBe(false);
	});
});

describe('the generated sheet', () => {
	it('should parse, and sit in the utilities layer', () => {
		expect(sheet.rules.length).toBeGreaterThan(all.length);
		expect(sheet.rules.every((rule) => rule.layer === 'utilities')).toBe(true);
	});

	it('should escape a class name the selector grammar would read as something else', () => {
		// `md:flex-row` and `w-1/2` are the spellings people have muscle memory
		// for, and the colon and the slash mean something else to a selector
		const source = generateUtilities();
		expect(source).toContain('.w-1\\/2');
		expect(source).toContain('.md\\:flex-row');
	});

	it('should resolve a class string through the ordinary cascade', () => {
		const style = resolve(['flex', 'flex-col', 'gap-1', 'p-2', 'text-red', 'w-1/2']);
		expect(style.flexDirection).toBe('column');
		expect(style.rowGap).toBe(1);
		expect(style.paddingTop).toBe(2);
		expect(style.width).toEqual({ type: 'percent', value: 50 });
	});

	it('should let a utility beat a component rule whatever the order', () => {
		// the invariant the layer exists for, checked through the real cascade
		// rather than asserted about the generator
		const component = parseStylesheet('.button { padding: 4 }');
		for (const sheets of [
			[component, sheet],
			[sheet, component],
		]) {
			const cascade = new Cascade(sheets);
			expect(cascade.resolve({ classes: ['button', 'p-2'], type: 'box' }).paddingTop).toBe(2);
		}
	});

	it('should add nothing to the runtime', () => {
		// a utility is a generated stylesheet rule and nothing in the runtime knows
		// the difference: the same class selector, the same specificity
		const rule = sheet.rules.find((r) => r.selectors[0].source === '.p-2');
		expect(rule?.selectors[0].specificity).toEqual([0, 1, 0]);
		expect(rule?.selectors[0].key).toBe('.p-2');
	});
});

describe('variants', () => {
	it('should put a width breakpoint under a media query', () => {
		expect(resolve(['flex-col', 'md:flex-row'], 100).flexDirection).toBe('row');
		expect(resolve(['flex-col', 'md:flex-row'], 40).flexDirection).toBe('column');
	});

	it('should let an author say what a colour means at a depth', () => {
		// SIG-61's "give the author control", in a shape people already know
		expect(resolve(['text-red', 'c16:text-magenta'], 100, 1).color).toBe(5);
		expect(resolve(['text-red', 'c16:text-magenta'], 100, 3).color).toBe(1);
	});

	it('should put a state variant behind a pseudo-class', () => {
		const cascade = new Cascade([sheet]);
		const classes = ['text-red', 'focus:text-blue'];
		expect(cascade.resolve({ classes, type: 'box' }).color).toBe(1);
		expect(cascade.resolve({ classes, states: ['focus'], type: 'box' }).color).toBe(4);
	});

	it('should have the ones a terminal can have and not the ones it cannot', () => {
		expect(VARIANT_NAMES).toContain('focus');
		expect(VARIANT_NAMES).toContain('md');
		expect(VARIANT_NAMES).toContain('c16');
		// not until mouse tracking exists, and a terminal has no dark mode
		expect(VARIANT_NAMES).not.toContain('hover');
		expect(VARIANT_NAMES).not.toContain('dark');
	});

	it('should be skippable', () => {
		expect(generateUtilities({ variants: false })).not.toContain('md\\:');
	});
});

describe('@apply', () => {
	it('should expand into the declarations the utilities stand for', () => {
		const expanded = expandApply('.button { @apply px-2 bold; }');
		expect(expanded).toBe('.button { padding-left: 2; padding-right: 2; bold: true; }');
		expect(parseStylesheet(expanded).rules[0].declarations).toHaveLength(3);
	});

	it('should land in the components layer, which is what makes it overridable', () => {
		const component = parseStylesheet(expandApply('.button { @apply p-4; }'));
		expect(component.rules[0].layer).toBe('components');
		const cascade = new Cascade([component, sheet]);
		expect(cascade.resolve({ classes: ['button', 'p-2'], type: 'box' }).paddingTop).toBe(2);
	});

	it('should leave a sheet with no @apply alone', () => {
		const source = '.button { padding: 2 }';
		expect(expandApply(source)).toBe(source);
	});

	it('should refuse a name that is not a utility', () => {
		expect(() => expandApply('.a { @apply nonsense; }')).toThrow(/not a utility/);
	});

	it('should refuse a variant, which is a rule rather than a set of declarations', () => {
		expect(() => expandApply('.a { @apply md:flex-row; }')).toThrow(/not a utility/);
	});
});
