import {
	expandApply,
	generateUtilities,
	utilities,
	VARIANT_NAMES,
} from '../src/utilities/index.js';
import {
	Cascade,
	parseStylesheet,
	PROPERTIES,
	PROPERTY_NAMES,
	readDeclarations,
} from '@ttylabs/sigil/style';
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
	it('should give every keyword of every keyword property a utility', () => {
		// walks the table rather than a sample of it: the point of putting the
		// keyword lists there is that a keyword added to a property gets its
		// utility for free, and a family dropped from the generator should fail
		// here rather than only when somebody notices the class is missing
		let checked = 0;
		for (const property of PROPERTY_NAMES) {
			const keywords = PROPERTIES[property].keywords;
			if (!keywords) {
				continue;
			}
			for (const keyword of keywords) {
				const found = all.some((utility) =>
					utility.declarations.some(([p, v]) => p === property && v === keyword)
				);
				expect(found, `no utility sets ${property}: ${keyword}`).toBe(true);
				checked++;
			}
		}
		expect(checked).toBeGreaterThan(50);
	});

	it('should only ever emit a declaration the property would accept', () => {
		// asserted over the declarations themselves rather than by watching
		// `generateUtilities()` not throw: the generator checks this on the way
		// out, and a test that only calls it would pass with the check deleted
		for (const utility of all) {
			for (const [property, value] of utility.declarations) {
				expect(() => readDeclarations({ [property]: value }), `${utility.name}`).not.toThrow();
			}
		}
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

	it('should let border and a border colour be worn together', () => {
		// `border` emits the border-style longhand rather than the `border`
		// shorthand, which would reset the colour: `class="border border-blue"` is
		// the documented combination and the shorthand would silently undo half of
		// it depending on which rule came last
		const style = resolve(['border', 'border-blue']);
		expect(style.borderStyle).toBe('single');
		expect(style.borderColor).toBe(4);
		expect(resolve(['border-blue', 'border']).borderColor).toBe(4);
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

	it('should leave an @apply inside a comment alone', () => {
		// a stylesheet full of commented-out rules is the ordinary case, and an
		// @apply inside a comment is a note about @apply
		const source = '/* .old { @apply p-9 nonsense; } */ .a { @apply p-1; }';
		const expanded = expandApply(source);
		expect(expanded).toContain('/* .old { @apply p-9 nonsense; } */');
		expect(expanded).toContain('padding-top: 1');
	});

	it('should stop at the end of its own statement', () => {
		// `[^;}]+` also matched `{`, so the name list ran on into whatever
		// followed: a missing semicolon ate the next declaration and a brace ate
		// the next block
		expect(expandApply('.a { @apply p-1 }')).toBe(
			'.a { padding-top: 1; padding-right: 1; padding-bottom: 1; padding-left: 1 }'
		);
		expect(expandApply('.a { @apply p-1; color: red }')).toContain('color: red');
		// the brace is left where it is rather than being read as a utility name;
		// a nested block is the stylesheet parser's to refuse, not this one's
		expect(expandApply('.a { @apply p-1 { color: red } }')).toContain('{ color: red }');
	});

	it('should refuse an @apply that names nothing', () => {
		expect(() => expandApply('.a { @apply ; }')).toThrow(/names no utilities/);
	});

	it('should treat a comment inside the name list as whitespace', () => {
		// a comment is trivia everywhere else in a stylesheet, and treating it as
		// a statement boundary expanded only half of an @apply and left the rest
		// behind as a declaration the parser then choked on
		const expanded = expandApply('.a { @apply p-1 /* and */ mt-2; }');
		expect(expanded).toContain('padding-top: 1');
		expect(expanded).toContain('margin-top: 2');
		expect(() => parseStylesheet(expanded)).not.toThrow();

		expect(expandApply('.a { @apply /* first */ p-1; }')).toContain('padding-top: 1');
	});

	it('should refuse an unterminated comment rather than walking through it', () => {
		expect(() => expandApply('.a { /* @apply p-1; }')).toThrow(/Unterminated comment/);
	});

	it('should not read @applysomething as @apply', () => {
		expect(expandApply('.a { @applyx p-1; }')).toBe('.a { @applyx p-1; }');
	});
});

describe('the committed sheet', () => {
	it('matches what the generator produces', async () => {
		// `packages/sigil/src/style/utilities.ts` is generated by
		// `scripts/generate-utilities.mjs` and committed, the way the Unicode
		// tables are. A generated file that has quietly stopped matching its
		// generator looks exactly like one that has not, so this is the half that
		// says so: regenerate with the script, then `pnpm fmt`.
		const { UTILITY_CSS } = await import('@ttylabs/sigil/style');
		expect(UTILITY_CSS).toBe(generateUtilities({ variants: false }));
	});

	it('is parsed once and kept', async () => {
		const { utilitySheet } = await import('@ttylabs/sigil/style');
		expect(utilitySheet()).toBe(utilitySheet());
	});

	it('carries the base set and none of the variants', async () => {
		const { UTILITY_CSS } = await import('@ttylabs/sigil/style');
		// the line the generator's own comment rests on: variants are 13x the
		// base set and a fifth of a CLI's startup, so they stay the generator's
		expect(UTILITY_CSS).toContain('.p-2 {');
		expect(UTILITY_CSS).not.toContain('md\\:');
	});

	it('spells its properties the way a stylesheet does', () => {
		// the table's keys are camelCase and both spellings resolve, which is what
		// let `@apply` emit `padding-top` while the sheet emitted `flexDirection`
		const css = generateUtilities({ variants: false });
		expect(css).toContain('flex-direction: column');
		expect(css).not.toContain('flexDirection');
		expect(expandApply('.a { @apply flex-col; }')).toContain('flex-direction: column');
	});
});
