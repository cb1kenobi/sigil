import { DEFAULT_COLOR, palette, rgb } from '../../src/canvas/index.js';
import {
	AUTO,
	cells,
	declare,
	expandShorthand,
	INHERITED,
	inheritFrom,
	initialStyle,
	isKnownProperty,
	isShorthand,
	kebab,
	NONE,
	parseColor,
	parseDeclaration,
	parseLength,
	percent,
	PROPERTIES,
	PROPERTY_NAMES,
	type PropertyName,
	readDeclarations,
	SHORTHAND_NAMES,
	StyleError,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

describe('the property table', () => {
	it('should give every property an initial value and an inheritance answer', () => {
		for (const name of PROPERTY_NAMES) {
			const definition = PROPERTIES[name];
			expect(definition, name).toBeDefined();
			expect(typeof definition.inherits, name).toBe('boolean');
			expect(definition.initial, name).toBeDefined();
			expect(typeof definition.parse, name).toBe('function');
		}
	});

	it('should round-trip every initial value through its own parser', () => {
		// a table whose initial value its own parser would reject is a table that
		// disagrees with itself, and nothing else would catch it
		for (const name of PROPERTY_NAMES) {
			const { initial, parse } = PROPERTIES[name];
			// no skipping: a value this helper cannot write is a property the
			// self-check quietly stops covering, and the two it stopped covering
			// were the two the last commit changed
			const written = writeValue(initial);
			expect(written, `${name} has an initial value the test cannot write`).toBeDefined();
			expect(parse(written!), `${name} does not round-trip through "${written}"`).toEqual(initial);
		}
	});

	it('should inherit exactly what CSS inherits', () => {
		// checked against CSS rather than against a transcription of the table --
		// the previous version of this test asserted the table equalled itself, so
		// it passed with `background-color` and `text-overflow` wrongly inheriting
		const cssInherits: PropertyName[] = [
			'color',
			'visibility',
			// the text attributes. CSS reaches the same result for decorations
			// through line propagation rather than inheritance, which a cell grid
			// has no box structure to do -- so they inherit here, deliberately
			'bold',
			'dim',
			'italic',
			'inverse',
			'underline',
			'strikethrough',
			'overline',
			'textAlign',
			'textTransform',
			'whiteSpace',
		];

		expect([...INHERITED].sort()).toEqual([...cssInherits].sort());
	});

	it('should not inherit background-color or text-overflow', () => {
		// both are famously non-inherited in CSS. A container's background showing
		// through its children is paint order; pushing the value down would make
		// every descendant *own* that colour, which is a different thing
		expect(PROPERTIES.backgroundColor.inherits).toBe(false);
		expect(PROPERTIES.textOverflow.inherits).toBe(false);
	});

	it('should not inherit anything that decides a box', () => {
		for (const name of ['width', 'height', 'paddingTop', 'flexGrow', 'position', 'borderStyle']) {
			expect(PROPERTIES[name as PropertyName].inherits, name).toBe(false);
		}
	});

	it('should have no property a terminal cannot draw', () => {
		for (const gone of ['fontFamily', 'fontSize', 'borderRadius', 'boxShadow', 'opacity']) {
			expect(PROPERTY_NAMES).not.toContain(gone);
		}
	});

	it('should convert names back to their CSS spelling', () => {
		expect(kebab('backgroundColor')).toBe('background-color');
		expect(kebab('flexDirection')).toBe('flex-direction');
		expect(kebab('color')).toBe('color');
	});
});

/** A value written the way somebody would write it, or `undefined` if it cannot be. */
function writeValue(value: unknown): string | undefined {
	if (typeof value === 'boolean') {
		return String(value);
	}
	if (typeof value === 'number') {
		return value === DEFAULT_COLOR ? 'default' : String(value);
	}
	if (typeof value === 'string') {
		return value;
	}
	if (value && typeof value === 'object' && 'type' in value) {
		const length = value as { type: string; value?: number };
		if (length.type === 'auto') {
			return 'auto';
		}
		if (length.type === 'none') {
			return 'none';
		}
		if (length.type === 'cells') {
			return String(length.value);
		}
		if (length.type === 'percent') {
			return `${length.value}%`;
		}
	}
	return undefined;
}

describe('lengths are frozen', () => {
	it('should refuse to be mutated in place', () => {
		const style = declare();
		expect(() => {
			(style.width as { value?: number }).value = 999;
		}).toThrow();
	});

	it('should not let one style corrupt another', () => {
		// every `auto` initial was one shared object, so a single in-place write
		// rewrote `width`, `height`, every min and max, `flex-basis`, and all four
		// insets, on every style in the process
		const a = declare();
		const b = declare();

		try {
			(a.width as { value?: number }).value = 999;
		} catch {
			/* frozen, which is the point */
		}

		expect(b.width).toEqual(AUTO);
		expect(a.height).toEqual(AUTO);
	});

	it('should freeze what the builders return', () => {
		expect(Object.isFrozen(cells(3))).toBe(true);
		expect(Object.isFrozen(percent(50))).toBe(true);
		expect(Object.isFrozen(AUTO)).toBe(true);
	});
});

describe('numbers', () => {
	it('should refuse an integer it cannot represent', () => {
		// past 2^53-1 a decimal integer comes back as a different integer, which is
		// the one failure a caller cannot detect. The parser's data types already
		// carry an entry about this
		expect(() => parseLength('9007199254740993')).toThrow(StyleError);
		expect(() => parseDeclaration('padding-top', '9007199254740993')).toThrow(StyleError);
		expect(() => parseDeclaration('z-index', '9007199254740993')).toThrow(StyleError);
		expect(() => parseDeclaration('flex-grow', '9007199254740993')).toThrow(StyleError);
	});

	it('should refuse a hex literal, which is not CSS', () => {
		// `Number('0x10')` is 16. The parser's own `int` takes hex deliberately,
		// for CLI arguments; it should not leak in here by accident of reaching for
		// the same function
		expect(() => parseLength('0x10')).toThrow(StyleError);
		expect(() => parseDeclaration('row-gap', '0x5')).toThrow(StyleError);
		expect(() => parseDeclaration('z-index', '0x10')).toThrow(StyleError);
	});

	it('should accept the number syntax CSS actually has', () => {
		expect(parseLength('1e3')).toEqual(cells(1000));
		expect(parseLength('+5')).toEqual(cells(5));
	});
});

describe('booleans', () => {
	it('should read what the parser reads', () => {
		// the same vocabulary `transformValue()`'s `bool` uses. A second, narrower
		// spelling of the same idea is how two parts of one library come to
		// disagree about what `on` means
		for (const yes of ['true', 'yes', 'y', 'on', '1', 'TRUE']) {
			expect(declare({ bold: yes }).bold, yes).toBe(true);
		}
		for (const no of ['false', 'no', 'n', 'off', '0', '']) {
			expect(declare({ bold: no }).bold, no).toBe(false);
		}
	});

	it('should refuse anything else', () => {
		expect(() => declare({ bold: 'sort of' })).toThrow(StyleError);
	});
});

describe('lengths', () => {
	it('should read a bare number as cells', () => {
		expect(parseLength('3')).toEqual(cells(3));
		expect(parseLength(' 12 ')).toEqual(cells(12));
	});

	it('should accept ch as a synonym', () => {
		expect(parseLength('4ch')).toEqual(cells(4));
	});

	it('should read a percentage', () => {
		expect(parseLength('50%')).toEqual(percent(50));
	});

	it('should read auto', () => {
		expect(parseLength('auto')).toEqual(AUTO);
	});

	it('should accept a negative length, because a margin may be one', () => {
		expect(parseLength('-2')).toEqual(cells(-2));
	});

	it('should refuse a fractional length', () => {
		// a terminal cannot draw half a cell, and rounding silently is how a layout
		// ends up a column out with nobody able to say which declaration did it
		expect(() => parseLength('1.5')).toThrow(/whole number of cells/);
	});

	it('should refuse nonsense', () => {
		expect(() => parseLength('')).toThrow(StyleError);
		expect(() => parseLength('wide')).toThrow(/Invalid length/);
		expect(() => parseLength('%')).toThrow(/Invalid percentage/);
		// Number('') is 0 and Number(' ') is 0, which is how an empty value turns
		// into a real-looking length. The parser's data types learned this too
		expect(() => parseLength('  ')).toThrow(StyleError);
		expect(() => parseLength('ch')).toThrow(StyleError);
	});
});

describe('colours', () => {
	it('should read the sixteen by name', () => {
		expect(parseColor('red')).toBe(palette(1));
		expect(parseColor('BrightBlue')).toBe(palette(12));
		expect(parseColor('grey')).toBe(parseColor('gray'));
	});

	it('should read hex in both lengths', () => {
		expect(parseColor('#ff8800')).toBe(rgb(255, 136, 0));
		expect(parseColor('#f80')).toBe(rgb(255, 136, 0));
	});

	it('should read rgb()', () => {
		expect(parseColor('rgb(1, 2, 3)')).toBe(rgb(1, 2, 3));
		expect(parseColor('rgb(1 2 3)')).toBe(rgb(1, 2, 3));
	});

	it('should read a palette index', () => {
		expect(parseColor('ansi(200)')).toBe(palette(200));
		expect(parseColor('palette(0)')).toBe(palette(0));
	});

	it('should read the terminal default', () => {
		expect(parseColor('default')).toBe(DEFAULT_COLOR);
		expect(parseColor('transparent')).toBe(DEFAULT_COLOR);
	});

	it('should keep a named colour as a palette index rather than an rgb value', () => {
		// the basic sixteen are whatever the user's terminal theme says they are,
		// and resolving `red` to a specific rgb overrides a choice already made
		expect(parseColor('red')).toBeLessThan(16);
	});

	it('should refuse an out-of-range channel or index', () => {
		expect(() => parseColor('rgb(0, 0, 300)')).toThrow(/out of range/);
		expect(() => parseColor('ansi(256)')).toThrow(/out of range/);
	});

	it('should refuse nonsense', () => {
		expect(() => parseColor('reddish')).toThrow(/Invalid colour/);
		expect(() => parseColor('#gg0000')).toThrow(/Invalid colour/);
	});
});

describe('declarations', () => {
	it('should accept both spellings of a name, in any case', () => {
		for (const spelling of ['background-color', 'backgroundColor', 'Background-Color', 'COLOR']) {
			const expected = spelling.toLowerCase().includes('background') ? 'backgroundColor' : 'color';
			expect(parseDeclaration(spelling, 'red')[0][0], spelling).toBe(expected);
		}
	});

	it('should recognise a name whatever its case', () => {
		// lowercasing is what a case-insensitive kebab lookup needs and exactly
		// what destroys the camelCase one, so both are tried
		for (const spelling of ['Color', 'COLOR', 'backgroundColor', 'Padding', 'Font-Weight']) {
			expect(isKnownProperty(spelling), spelling).toBe(true);
		}
	});

	it('should refuse an empty value rather than reading it as zero', () => {
		for (const [name, value] of [
			['padding-top', ''],
			['flex-grow', ''],
			['z-index', ''],
			['width', ''],
			['row-gap', '   '],
		] as const) {
			expect(() => parseDeclaration(name, value), `${name}: "${value}"`).toThrow(StyleError);
		}
	});

	it('should refuse an unknown property by name', () => {
		expect(() => parseDeclaration('font-family', 'monospace')).toThrow(/Unknown property/);
	});

	it('should map font-weight onto the attributes a terminal has', () => {
		// one CSS property over two longhands, so every value resets the other --
		// the same rule `border` and `flex-flow` follow. `normal` did and `bold`
		// did not, so `font-weight: bold` left a `dim` from an earlier declaration
		// standing
		expect(parseDeclaration('font-weight', 'bold')).toEqual([
			['bold', true],
			['dim', false],
		]);
		expect(parseDeclaration('font-weight', 'dim')).toEqual([
			['bold', false],
			['dim', true],
		]);
		expect(parseDeclaration('font-weight', 'normal')).toEqual([
			['bold', false],
			['dim', false],
		]);
		expect(declare({ dim: 'true', 'font-weight': 'bold' }).dim).toBe(false);
	});

	it('should refuse a numeric font-weight', () => {
		// there is no axis between bold and normal to put 600 on
		expect(() => parseDeclaration('font-weight', '600')).toThrow(/bold, dim, and normal/);
	});

	it('should map font-style and text-decoration', () => {
		expect(parseDeclaration('font-style', 'italic')).toEqual([['italic', true]]);
		expect(parseDeclaration('text-decoration', 'underline line-through')).toEqual([
			['underline', true],
			['strikethrough', true],
			['overline', false],
		]);
	});

	it('should report the property that could not take the value', () => {
		expect(() => parseDeclaration('width', 'wide')).toThrow(/Invalid length/);
		expect(() => parseDeclaration('display', 'block')).toThrow(/expected one of flex, none/);
	});
});

describe('shorthands', () => {
	it('should name every shorthand it expands', () => {
		for (const name of SHORTHAND_NAMES) {
			expect(isShorthand(name), name).toBe(true);
		}
		expect(isShorthand('color')).toBe(false);
	});

	it('should fill padding the way CSS fills it', () => {
		expect(expandShorthand('padding', '1')).toEqual([
			['paddingTop', '1'],
			['paddingRight', '1'],
			['paddingBottom', '1'],
			['paddingLeft', '1'],
		]);
		expect(expandShorthand('padding', '1 2')).toEqual([
			['paddingTop', '1'],
			['paddingRight', '2'],
			['paddingBottom', '1'],
			['paddingLeft', '2'],
		]);
		expect(expandShorthand('padding', '1 2 3')).toEqual([
			['paddingTop', '1'],
			['paddingRight', '2'],
			['paddingBottom', '3'],
			['paddingLeft', '2'],
		]);
		expect(expandShorthand('padding', '1 2 3 4')).toEqual([
			['paddingTop', '1'],
			['paddingRight', '2'],
			['paddingBottom', '3'],
			['paddingLeft', '4'],
		]);
	});

	it('should refuse more than four edges', () => {
		expect(() => expandShorthand('padding', '1 2 3 4 5')).toThrow(/one to four/);
	});

	it('should split gap into rows and columns', () => {
		expect(expandShorthand('gap', '2')).toEqual([
			['rowGap', '2'],
			['columnGap', '2'],
		]);
		expect(expandShorthand('gap', '1 3')).toEqual([
			['rowGap', '1'],
			['columnGap', '3'],
		]);
	});

	it('should read a border in either order', () => {
		expect(declare({ border: 'double red' }).borderStyle).toBe('double');
		expect(declare({ border: 'red double' }).borderColor).toBe(palette(1));
	});

	it('should draw a border given only a colour', () => {
		// CSS gets this wrong: `border-color` alone draws nothing
		const style = declare({ border: 'red' });
		expect(style.borderStyle).toBe('single');
		expect(style.borderColor).toBe(palette(1));
	});

	it('should give flex the defaults everyone expects', () => {
		const style = declare({ flex: '1' });
		expect(style.flexGrow).toBe(1);
		expect(style.flexShrink).toBe(1);
		// basis 0, not auto -- which surprises people every time and is what their
		// muscle memory expects
		expect(style.flexBasis).toEqual(cells(0));
	});

	it('should read flex: none', () => {
		const style = declare({ flex: 'none' });
		expect([style.flexGrow, style.flexShrink, style.flexBasis]).toEqual([0, 0, AUTO]);
	});

	it('should keep a bracketed value together when splitting', () => {
		const style = declare({ border: 'single rgb(1, 2, 3)' });
		expect(style.borderColor).toBe(rgb(1, 2, 3));
	});

	it('should report against the longhand that could not take the value', () => {
		// `padding: 1 nonsense` is wrong at padding-right, and saying so is more
		// use than saying the shorthand failed
		expect(() => declare({ padding: '1 nonsense' })).toThrow(/Invalid padding/);
	});
});

describe('a shorthand resets what it omits', () => {
	it('should reset the border colour it was not given', () => {
		// CSS shorthands reset every longhand they cover, which is exactly why
		// `border: red` famously draws nothing there
		const style = declare({ 'border-color': 'red', border: 'single' });
		expect(style.borderStyle).toBe('single');
		expect(style.borderColor).toBe(DEFAULT_COLOR);
	});

	it('should reset the wrap flex-flow was not given', () => {
		const style = declare({ 'flex-wrap': 'wrap', 'flex-flow': 'row' });
		expect(style.flexDirection).toBe('row');
		expect(style.flexWrap).toBe('nowrap');
	});

	it('should reset everything flex covers', () => {
		const style = declare({ 'flex-basis': '20', flex: 'none' });
		expect(style.flexBasis).toEqual(AUTO);
	});
});

describe('initial values against CSS', () => {
	it('should have no maximum by default, which auto cannot say', () => {
		// `max-width: none` is an ordinary declaration and was unwritable when
		// `auto` stood for both "size to content" and "no limit"
		expect(PROPERTIES.maxWidth.initial).toEqual(NONE);
		expect(declare({ 'max-width': 'none' }).maxWidth).toEqual(NONE);
	});

	it('should start position at static', () => {
		// only a *positioned* ancestor is a containing block. Defaulting to
		// `relative` makes every box an anchor an `absolute` descendant stops at
		expect(declare().position).toBe('static');
	});

	it('should size the border box by default', () => {
		// `width: 20` meaning twenty columns on screen is what everybody means in
		// a terminal, even though CSS says content-box
		expect(declare().boxSizing).toBe('border-box');
	});
});

describe('declare', () => {
	it('should start from the initial values', () => {
		const style = declare();
		expect(style).toEqual(initialStyle());
		expect(style.display).toBe('flex');
		expect(style.width).toEqual(AUTO);
		expect(style.color).toBe(DEFAULT_COLOR);
		expect(style.flexShrink).toBe(1);
	});

	it('should apply declarations over them', () => {
		const style = declare({ color: 'red', padding: '1 2', 'flex-grow': '2' });
		expect(style.color).toBe(palette(1));
		expect(style.paddingLeft).toBe(2);
		expect(style.paddingTop).toBe(1);
		expect(style.flexGrow).toBe(2);
		// everything else is untouched
		expect(style.display).toBe('flex');
	});

	it('should let a later declaration win over an earlier one', () => {
		const style = declare({ padding: '1', 'padding-left': '5' });
		expect(style.paddingLeft).toBe(5);
		expect(style.paddingRight).toBe(1);
	});

	it('should carry the inherited properties down from a parent', () => {
		const parent = declare({ color: 'red', padding: '4', bold: 'true' });
		const child = declare({}, parent);

		expect(child.color).toBe(palette(1));
		expect(child.bold).toBe(true);
		// a box is not inherited
		expect(child.paddingTop).toBe(0);
	});

	it('should let a child override what it inherited', () => {
		const parent = declare({ color: 'red' });
		const child = declare({ color: 'blue' }, parent);
		expect(child.color).toBe(palette(4));
		expect(parent.color).toBe(palette(1));
	});
});

describe('inheritFrom', () => {
	it('should take only the inherited properties', () => {
		const parent = declare({ color: 'green', width: '10', italic: 'true' });
		const child = inheritFrom(parent);

		expect(child.color).toBe(palette(2));
		expect(child.italic).toBe(true);
		expect(child.width).toEqual(AUTO);
	});

	it('should give a child the initial value for what it does not inherit', () => {
		// this used to claim it proved no object was shared. It did not: the parent
		// was `cells(10)` and the child `AUTO`, so they differ because `width` is
		// not inherited, not because anything was copied. Sharing a frozen `AUTO`
		// is fine and is what actually happens
		const parent = declare({ width: '10' });
		const child = inheritFrom(parent);
		expect(child.width).toEqual(AUTO);
		expect(inheritFrom(declare()).width).toBe(AUTO);
	});
});

describe('isKnownProperty', () => {
	it('should recognise longhands, shorthands, and aliases', () => {
		expect(isKnownProperty('color')).toBe(true);
		expect(isKnownProperty('background-color')).toBe(true);
		expect(isKnownProperty('padding')).toBe(true);
		expect(isKnownProperty('font-weight')).toBe(true);
	});

	it('should not recognise what a terminal cannot draw', () => {
		expect(isKnownProperty('font-size')).toBe(false);
		expect(isKnownProperty('border-radius')).toBe(false);
		expect(isKnownProperty('nonsense')).toBe(false);
	});
});

describe('readDeclarations', () => {
	it('should return only what was declared', () => {
		const read = readDeclarations({ color: 'red', gap: '1 2' });
		expect(Object.keys(read).sort()).toEqual(['color', 'columnGap', 'rowGap']);
	});
});

describe('prototype-named properties', () => {
	it('should not recognise a name that only exists on Object.prototype', () => {
		// AGENTS.md has an entry about exactly this for the parser's registries:
		// on a plain object `constructor` and `toString` read back truthy and answer
		// a lookup nothing declared
		for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
			expect(isKnownProperty(name), name).toBe(false);
			expect(isShorthand(name), name).toBe(false);
		}
	});

	it('should refuse to declare one, with an error rather than a crash', () => {
		for (const name of ['constructor', 'toString', '__proto__']) {
			expect(() => declare({ [name]: 'red' }), name).toThrow(StyleError);
		}
	});

	it('should not read a prototype member as a colour or a weight', () => {
		expect(() => parseColor('constructor')).toThrow(StyleError);
		expect(() => parseDeclaration('font-weight', 'constructor')).toThrow(StyleError);
	});
});

describe('names in both spellings', () => {
	it('should resolve an alias written either way', () => {
		for (const name of ['font-weight', 'fontWeight', 'font-style', 'fontStyle']) {
			expect(isKnownProperty(name), name).toBe(true);
		}
		expect(declare({ fontWeight: 'bold' }).bold).toBe(true);
	});

	it('should resolve a shorthand written either way', () => {
		expect(isShorthand('flexFlow')).toBe(true);
		expect(declare({ flexFlow: 'column' }).flexDirection).toBe('column');
	});
});

describe('flex-flow', () => {
	it('should take a wrap on its own, which its own error message promised', () => {
		expect(declare({ 'flex-flow': 'wrap' })).toMatchObject({
			flexDirection: 'row',
			flexWrap: 'wrap',
		});
	});

	it('should take them in either order', () => {
		expect(declare({ 'flex-flow': 'wrap column' })).toMatchObject({
			flexDirection: 'column',
			flexWrap: 'wrap',
		});
	});

	it('should still refuse nonsense', () => {
		expect(() => declare({ 'flex-flow': 'sideways' })).toThrow(StyleError);
	});
});

describe('flex keywords', () => {
	it('should read flex: auto', () => {
		// the second most typed value after `flex: 1`, and it used to throw as an
		// invalid grow factor
		expect(declare({ flex: 'auto' })).toMatchObject({
			flexBasis: AUTO,
			flexGrow: 1,
			flexShrink: 1,
		});
	});

	it('should read flex: initial', () => {
		expect(declare({ flex: 'initial' })).toMatchObject({
			flexBasis: AUTO,
			flexGrow: 0,
			flexShrink: 1,
		});
	});

	it('should read a basis given with a factor', () => {
		expect(declare({ flex: '2 auto' })).toMatchObject({ flexBasis: AUTO, flexGrow: 2 });
		expect(declare({ flex: '1 50%' })).toMatchObject({ flexBasis: percent(50), flexGrow: 1 });
	});
});

describe('none is only where it means something', () => {
	it('should refuse it on a property that has no "no limit"', () => {
		for (const property of ['width', 'min-width', 'flex-basis', 'margin-top', 'top']) {
			expect(() => parseDeclaration(property, 'none'), property).toThrow(StyleError);
		}
	});

	it('should take it on max-width and max-height', () => {
		expect(declare({ 'max-width': 'none' }).maxWidth).toEqual(NONE);
		expect(declare({ 'max-height': 'none' }).maxHeight).toEqual(NONE);
	});
});

describe('the table itself is frozen', () => {
	it('should refuse an edit to a definition', () => {
		// the initial values were frozen and the slots holding them were not, which
		// is the same TypeScript fiction one level up
		expect(() => {
			(PROPERTIES.width as { initial: unknown }).initial = cells(7);
		}).toThrow();
		expect(declare().width).toEqual(AUTO);
	});
});

describe('number grammar edges', () => {
	it('should refuse a trailing dot, which CSS does not have', () => {
		expect(() => parseLength('5.')).toThrow(StyleError);
	});

	it('should refuse a space before the percent sign', () => {
		expect(() => parseLength('50 %')).toThrow(StyleError);
	});

	it('should normalise negative zero', () => {
		// it compares unequal to zero under Object.is, which is what a deep-equality
		// assertion uses
		const zero = parseLength('-0');
		expect(zero).toEqual(cells(0));
		expect(Object.is((zero as { value: number }).value, 0)).toBe(true);
	});
});
