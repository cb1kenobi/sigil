import { type Color, DEFAULT_COLOR } from '../canvas/style.js';
import {
	AUTO,
	cells,
	type Length,
	NONE,
	parseBoolean,
	parseColor,
	parseCount,
	parseFactor,
	parseInteger,
	parseKeyword,
	parseLength,
	StyleError,
} from './value.js';

/**
 * The property set: every property, what it means, what it starts as, and
 * whether it inherits.
 *
 * "Watered down" means dropping what a grid of character cells cannot express.
 * It does not mean dropping the model. Out permanently, because there is no way
 * to draw them: `font-family` and `font-size` (the cell size is the user's),
 * `border-radius`, `box-shadow`, transforms, and any fractional length.
 *
 * The nearest analogues survive under their own names -- weight is `bold`, and
 * its opposite is `dim`, which is a terminal attribute rather than a point on a
 * weight axis. VT100 double-width and double-height lines are the one real font
 * size a terminal has, and almost nothing implements them; noted and skipped.
 *
 * This table is the single source of truth. Everything downstream in Phase 3 --
 * the cascade, inheritance, invalidation, animation -- reads it rather than
 * carrying its own list, so a property is added in one place.
 */

export type Display = 'flex' | 'none';
export type FlexDirection = 'row' | 'row-reverse' | 'column' | 'column-reverse';
export type FlexWrap = 'nowrap' | 'wrap' | 'wrap-reverse';
export type JustifyContent =
	| 'flex-start'
	| 'flex-end'
	| 'center'
	| 'space-between'
	| 'space-around'
	| 'space-evenly';
export type AlignItems = 'flex-start' | 'flex-end' | 'center' | 'stretch';
export type AlignContent =
	| 'flex-start'
	| 'flex-end'
	| 'center'
	| 'stretch'
	| 'space-between'
	| 'space-around';
export type BoxSizing = 'border-box' | 'content-box';
export type Visibility = 'visible' | 'hidden';
export type AlignSelf = AlignItems | 'auto';
export type Position = 'static' | 'relative' | 'absolute';
export type Overflow = 'visible' | 'hidden' | 'scroll' | 'auto';
export type TextAlign = 'left' | 'center' | 'right';
export type TextTransform = 'none' | 'uppercase' | 'lowercase' | 'capitalize';
export type WhiteSpace = 'normal' | 'pre' | 'nowrap';
export type TextOverflow = 'clip' | 'ellipsis' | 'ellipsis-start' | 'ellipsis-middle';

/**
 * A border's character set, rather than a rendering mode.
 *
 * This is the one place the property set is terminal-shaped rather than
 * CSS-shaped: `solid` and `dashed` mean nothing here, and which box-drawing
 * characters to use means everything. `ascii` is the fallback for a terminal
 * that cannot be trusted with anything else.
 */
export type BorderStyle = 'none' | 'single' | 'double' | 'round' | 'bold' | 'ascii';

/** Every property, in the order they are documented. */
export interface Style {
	// layout
	display: Display;
	flexDirection: FlexDirection;
	flexGrow: number;
	flexShrink: number;
	flexBasis: Length;
	flexWrap: FlexWrap;
	justifyContent: JustifyContent;
	alignItems: AlignItems;
	alignSelf: AlignSelf;
	alignContent: AlignContent;
	order: number;
	rowGap: number;
	columnGap: number;

	// box
	boxSizing: BoxSizing;
	width: Length;
	height: Length;
	minWidth: Length;
	minHeight: Length;
	maxWidth: Length;
	maxHeight: Length;
	paddingTop: number;
	paddingRight: number;
	paddingBottom: number;
	paddingLeft: number;
	marginTop: Length;
	marginRight: Length;
	marginBottom: Length;
	marginLeft: Length;
	borderStyle: BorderStyle;
	borderColor: Color;

	// position
	position: Position;
	top: Length;
	right: Length;
	bottom: Length;
	left: Length;
	zIndex: number;
	overflow: Overflow;
	visibility: Visibility;

	// text
	color: Color;
	backgroundColor: Color;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	strikethrough: boolean;
	overline: boolean;
	inverse: boolean;
	textAlign: TextAlign;
	textTransform: TextTransform;
	textOverflow: TextOverflow;
	whiteSpace: WhiteSpace;
}

export type PropertyName = keyof Style;

interface Definition<K extends PropertyName = PropertyName> {
	/**
	 * Whether a child gets this from its parent when nothing else says
	 * otherwise. Follows CSS: text properties inherit, box and layout properties
	 * do not. It is the rule people already know, and it is most of why a cascade
	 * beats props -- setting `color` on a container and having the text inside
	 * pick it up is the single most common thing anyone wants.
	 */
	readonly inherits: boolean;
	readonly initial: Style[K];
	/** Reads the property's value from source. Throws `StyleError` on nonsense. */
	readonly parse: (input: string) => Style[K];
}

/**
 * A boolean property, read with the same vocabulary the parser's `bool` type
 * uses -- `yes`, `on`, `1`, and an empty string all mean what they mean there.
 * A second, narrower spelling of the same idea is how two parts of one library
 * come to disagree about what `on` means.
 */
const flag = (name: string) => (input: string) => parseBoolean(input, name);

/** The table. */
export const PROPERTIES: { readonly [K in PropertyName]: Definition<K> } = {
	display: {
		inherits: false,
		initial: 'flex',
		parse: (v) => parseKeyword(v, ['flex', 'none'] as const, 'display'),
	},
	flexDirection: {
		inherits: false,
		initial: 'row',
		parse: (v) =>
			parseKeyword(
				v,
				['row', 'row-reverse', 'column', 'column-reverse'] as const,
				'flex-direction'
			),
	},
	flexGrow: { inherits: false, initial: 0, parse: (v) => parseFactor(v, 'flex-grow') },
	flexShrink: { inherits: false, initial: 1, parse: (v) => parseFactor(v, 'flex-shrink') },
	flexBasis: { inherits: false, initial: AUTO, parse: parseLength },
	flexWrap: {
		inherits: false,
		initial: 'nowrap',
		parse: (v) => parseKeyword(v, ['nowrap', 'wrap', 'wrap-reverse'] as const, 'flex-wrap'),
	},
	justifyContent: {
		inherits: false,
		initial: 'flex-start',
		parse: (v) =>
			parseKeyword(
				v,
				[
					'flex-start',
					'flex-end',
					'center',
					'space-between',
					'space-around',
					'space-evenly',
				] as const,
				'justify-content'
			),
	},
	alignItems: {
		inherits: false,
		initial: 'stretch',
		parse: (v) =>
			parseKeyword(v, ['flex-start', 'flex-end', 'center', 'stretch'] as const, 'align-items'),
	},
	alignSelf: {
		inherits: false,
		initial: 'auto',
		parse: (v) =>
			parseKeyword(
				v,
				['auto', 'flex-start', 'flex-end', 'center', 'stretch'] as const,
				'align-self'
			),
	},
	alignContent: {
		inherits: false,
		initial: 'stretch',
		parse: (v) =>
			parseKeyword(
				v,
				['flex-start', 'flex-end', 'center', 'stretch', 'space-between', 'space-around'] as const,
				'align-content'
			),
	},
	order: { inherits: false, initial: 0, parse: (v) => parseInteger(v, 'order') },
	rowGap: { inherits: false, initial: 0, parse: (v) => parseCount(v, 'row-gap') },
	columnGap: { inherits: false, initial: 0, parse: (v) => parseCount(v, 'column-gap') },

	// `border-box` rather than CSS's `content-box`. In a terminal, `width: 20`
	// meaning "twenty columns on screen" is what everybody means; having a border
	// silently make the box twenty-two wide is the surprise, not the convenience
	boxSizing: {
		inherits: false,
		initial: 'border-box',
		parse: (v) => parseKeyword(v, ['border-box', 'content-box'] as const, 'box-sizing'),
	},
	width: { inherits: false, initial: AUTO, parse: parseLength },
	height: { inherits: false, initial: AUTO, parse: parseLength },
	// `auto` rather than CSS 2.1's `0`, matching CSS Sizing 3: a flex item's
	// automatic minimum size is its min-content size, which is what stops text
	// shrinking past its longest word
	minWidth: { inherits: false, initial: AUTO, parse: parseLength },
	minHeight: { inherits: false, initial: AUTO, parse: parseLength },
	// `none`, not `auto`. "No maximum" and "size to content" are different
	// questions, and one sentinel for both makes `max-width: none` unwritable
	maxWidth: { inherits: false, initial: NONE, parse: (v) => parseLength(v, { none: true }) },
	maxHeight: { inherits: false, initial: NONE, parse: (v) => parseLength(v, { none: true }) },
	paddingTop: { inherits: false, initial: 0, parse: (v) => parseCount(v, 'padding-top') },
	paddingRight: { inherits: false, initial: 0, parse: (v) => parseCount(v, 'padding-right') },
	paddingBottom: { inherits: false, initial: 0, parse: (v) => parseCount(v, 'padding-bottom') },
	paddingLeft: { inherits: false, initial: 0, parse: (v) => parseCount(v, 'padding-left') },
	// margins take a length rather than a count, because `auto` is how a box is
	// centred and how it is pushed to one end -- the one place a negative or
	// automatic value earns itself
	marginTop: { inherits: false, initial: cells(0), parse: parseLength },
	marginRight: { inherits: false, initial: cells(0), parse: parseLength },
	marginBottom: { inherits: false, initial: cells(0), parse: parseLength },
	marginLeft: { inherits: false, initial: cells(0), parse: parseLength },
	borderStyle: {
		inherits: false,
		initial: 'none',
		parse: (v) =>
			parseKeyword(
				v,
				['none', 'single', 'double', 'round', 'bold', 'ascii'] as const,
				'border-style'
			),
	},
	borderColor: { inherits: false, initial: DEFAULT_COLOR, parse: parseColor },

	// `static` rather than `relative`, and the difference is not cosmetic: only a
	// positioned ancestor is a containing block, so defaulting to `relative` would
	// make every box in the tree an anchor an `absolute` descendant stops at
	position: {
		inherits: false,
		initial: 'static',
		parse: (v) => parseKeyword(v, ['static', 'relative', 'absolute'] as const, 'position'),
	},
	top: { inherits: false, initial: AUTO, parse: parseLength },
	right: { inherits: false, initial: AUTO, parse: parseLength },
	bottom: { inherits: false, initial: AUTO, parse: parseLength },
	left: { inherits: false, initial: AUTO, parse: parseLength },
	zIndex: {
		inherits: false,
		initial: 0,
		// `0` rather than CSS's `auto`. `auto` means "do not establish a stacking
		// context", which matters when contexts nest; the paint order here is flat
		// enough that the distinction has nothing to bite on yet
		parse: (v) => parseInteger(v, 'z-index'),
	},
	overflow: {
		inherits: false,
		initial: 'visible',
		parse: (v) => parseKeyword(v, ['visible', 'hidden', 'scroll', 'auto'] as const, 'overflow'),
	},
	// different from `display: none`: this one still takes its space
	visibility: {
		inherits: true,
		initial: 'visible',
		parse: (v) => parseKeyword(v, ['visible', 'hidden'] as const, 'visibility'),
	},

	color: { inherits: true, initial: DEFAULT_COLOR, parse: parseColor },
	// not inherited, as in CSS. A container's background showing through its
	// children is paint order, not the cascade -- pushing the value down would make
	// every descendant *own* that colour, which is a different thing entirely
	backgroundColor: { inherits: false, initial: DEFAULT_COLOR, parse: parseColor },
	bold: { inherits: true, initial: false, parse: flag('bold') },
	dim: { inherits: true, initial: false, parse: flag('dim') },
	italic: { inherits: true, initial: false, parse: flag('italic') },
	underline: { inherits: true, initial: false, parse: flag('underline') },
	strikethrough: { inherits: true, initial: false, parse: flag('strikethrough') },
	overline: { inherits: true, initial: false, parse: flag('overline') },
	inverse: { inherits: true, initial: false, parse: flag('inverse') },
	textAlign: {
		inherits: true,
		initial: 'left',
		parse: (v) => parseKeyword(v, ['left', 'center', 'right'] as const, 'text-align'),
	},
	textTransform: {
		inherits: true,
		initial: 'none',
		parse: (v) =>
			parseKeyword(v, ['none', 'uppercase', 'lowercase', 'capitalize'] as const, 'text-transform'),
	},
	// not inherited, as in CSS: it only means anything on the box doing the
	// clipping
	textOverflow: {
		inherits: false,
		initial: 'clip',
		parse: (v) =>
			parseKeyword(
				v,
				['clip', 'ellipsis', 'ellipsis-start', 'ellipsis-middle'] as const,
				'text-overflow'
			),
	},
	whiteSpace: {
		inherits: true,
		initial: 'normal',
		parse: (v) => parseKeyword(v, ['normal', 'pre', 'nowrap'] as const, 'white-space'),
	},
};

// the definitions and the table are frozen too. The initial values already were,
// and leaving the slots holding them writable is the same TypeScript fiction one
// level up: `PROPERTIES.width.initial = cells(7)` changed what `declare()`
// returns for every style in the process
for (const definition of Object.values(PROPERTIES)) {
	Object.freeze(definition);
}
Object.freeze(PROPERTIES);

/** Every property name, for anything that has to walk the whole set. */
export const PROPERTY_NAMES: readonly PropertyName[] = Object.keys(PROPERTIES) as PropertyName[];

/** The properties a child takes from its parent when nothing else says otherwise. */
export const INHERITED: readonly PropertyName[] = PROPERTY_NAMES.filter(
	(name) => PROPERTIES[name].inherits
);

/**
 * `font-weight: bold` is the spelling people reach for, and `bold: true` is the
 * property. Rather than refuse the familiar one, these map onto it.
 */
const WEIGHT_TO_FLAG: Record<string, PropertyName> = {
	__proto__: null,
	bold: 'bold',
	dim: 'dim',
} as unknown as Record<string, PropertyName>;

/**
 * Properties whose CSS name is not a simple kebab-case of the property, or that
 * are spelled differently here because the terminal version is a different idea.
 */
const ALIASES = {
	// null-prototype, for the reason AGENTS.md gives under Conventions: on a plain
	// object `constructor` and `toString` read back truthy and answer a lookup
	// nothing declared, so `isKnownProperty('constructor')` was true and
	// `declare({ constructor: 'red' })` was a TypeError rather than an error
	// anybody could act on
	__proto__: null,
	'font-weight': (value: string) => {
		const key = value.trim().toLowerCase();
		if (key === 'normal') {
			return [
				['bold', 'false'],
				['dim', 'false'],
			];
		}
		const flagName = Object.hasOwn(WEIGHT_TO_FLAG, key) ? WEIGHT_TO_FLAG[key] : undefined;
		if (!flagName) {
			throw new StyleError(
				`Invalid font-weight "${value}": a terminal has bold, dim, and normal, and no axis between them`
			);
		}
		// one CSS property over two longhands, so it has to reset the other -- the
		// same rule `border` and `flex-flow` follow. `font-weight: normal` did and
		// `font-weight: bold` did not
		return flagName === 'bold'
			? [
					['bold', 'true'],
					['dim', 'false'],
				]
			: [
					['bold', 'false'],
					['dim', 'true'],
				];
	},
	'font-style': (value: string) => {
		const key = value.trim().toLowerCase();
		if (key === 'normal') {
			return [['italic', 'false']];
		}
		if (key === 'italic' || key === 'oblique') {
			return [['italic', 'true']];
		}
		throw new StyleError(`Invalid font-style "${value}": expected normal or italic`);
	},
	'text-decoration': (value: string) => {
		const wanted = new Set(value.trim().toLowerCase().split(/\s+/));
		const known: [PropertyName, string][] = [
			['underline', String(wanted.has('underline'))],
			['strikethrough', String(wanted.has('line-through') || wanted.has('strikethrough'))],
			['overline', String(wanted.has('overline'))],
		];
		for (const word of wanted) {
			if (!['none', 'underline', 'line-through', 'strikethrough', 'overline'].includes(word)) {
				throw new StyleError(`Invalid text-decoration "${value}"`);
			}
		}
		return known;
	},
} as unknown as Record<string, PropertyName | ((value: string) => [PropertyName, string][])>;

/**
 * Whether a name is a property this table holds, in either spelling and in any
 * case.
 *
 * @param name - The property name.
 * @returns Whether it is known.
 */
export function isProperty(name: string): boolean {
	return aliasFor(name) !== undefined || resolveName(name) !== undefined;
}

/**
 * The alias entry for a name, in either spelling.
 *
 * `fontWeight` is how a props object spells it and `font-weight` is how a
 * stylesheet does; both are written, so both resolve. `Object.hasOwn` rather
 * than `in`, for the reason the registries give.
 *
 * @param name - The property name.
 * @returns The alias, if there is one.
 */
function aliasFor(
	name: string
): PropertyName | ((value: string) => [PropertyName, string][]) | undefined {
	const trimmed = name.trim();
	for (const candidate of [trimmed.toLowerCase(), kebabOf(trimmed).toLowerCase()]) {
		if (Object.hasOwn(ALIASES, candidate)) {
			return ALIASES[candidate];
		}
	}
	return undefined;
}

/** `fontWeight` -> `font-weight`, leaving an already-kebab name alone. */
function kebabOf(name: string): string {
	return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * The property a name refers to, in either spelling and any case.
 *
 * Both spellings, because both are written: `background-color` in a stylesheet
 * and `backgroundColor` in a props object. Lowercasing first is what a
 * case-insensitive kebab lookup needs and is exactly what destroys the camelCase
 * one, so the two are tried separately rather than funnelled through one
 * normalization that cannot serve both.
 *
 * @param name - The property name.
 * @returns The property, or `undefined` if there is no such thing.
 */
function resolveName(name: string): PropertyName | undefined {
	const trimmed = name.trim();

	// as written first, which is what keeps `backgroundColor` working; then
	// lowercased, which is what a case-insensitive kebab lookup needs and exactly
	// what would destroy the camelCase one. `Object.hasOwn` rather than `in`,
	// because `constructor` and `toString` are truthy on a plain object
	for (const candidate of [camel(trimmed), camel(trimmed.toLowerCase())] as PropertyName[]) {
		if (Object.hasOwn(PROPERTIES, candidate)) {
			return candidate;
		}
	}
	return undefined;
}

/** `background-color` -> `backgroundColor`. */
function camel(name: string): string {
	return name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** `backgroundColor` -> `background-color`, for messages and for the reverse map. */
export function kebab(name: PropertyName): string {
	return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/**
 * Turns one declaration into the longhand properties it sets.
 *
 * Shorthands are expanded by `expandShorthand()` before this is reached; what
 * arrives here is either a longhand or one of the aliases above.
 *
 * @param name - The property, in CSS spelling or camelCase.
 * @param value - The value, as written.
 * @returns The longhand properties and their parsed values.
 */
export function parseDeclaration(name: string, value: string): [PropertyName, unknown][] {
	const alias = aliasFor(name);
	if (alias) {
		const pairs: [PropertyName, string][] =
			typeof alias === 'function' ? alias(value) : [[alias, value]];
		return pairs.map(([prop, raw]) => [prop, PROPERTIES[prop].parse(raw)]);
	}

	// case-insensitive like every other lookup here. This was the one path that
	// was not, so `Color` was an unknown property while `Padding` and
	// `Font-Weight` were both fine
	const key = resolveName(name);
	if (!key) {
		throw new StyleError(`Unknown property "${name}"`);
	}

	return [[key, PROPERTIES[key].parse(value)]];
}

/**
 * A style with every property at its initial value.
 *
 * @returns The style.
 */
export function initialStyle(): Style {
	const style = {} as Record<PropertyName, unknown>;
	for (const name of PROPERTY_NAMES) {
		style[name] = PROPERTIES[name].initial;
	}
	return style as Style;
}

/**
 * A style for a child, given its parent's: inherited properties carried down,
 * everything else at its initial value.
 *
 * @param parent - The parent's resolved style.
 * @returns The starting point for the child, before anything is cascaded onto it.
 */
export function inheritFrom(parent: Style): Style {
	const style = initialStyle() as Record<PropertyName, unknown>;
	for (const name of INHERITED) {
		style[name] = parent[name];
	}
	return style as Style;
}
