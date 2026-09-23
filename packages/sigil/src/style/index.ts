/**
 * Style: the property set, the stylesheet, and the cascade.
 *
 * `properties.ts` is the table everything else reads -- every property a
 * terminal can express, what it starts as, and whether it inherits. The layout
 * engine, invalidation, and animation all ask it rather than carrying lists of
 * their own, so a property is added in one place. `selector.ts`,
 * `stylesheet.ts`, and `cascade.ts` are the rest: what a rule matches, where it
 * sits, and which declaration wins.
 *
 * ```js
 * import { Cascade, declare, parseStylesheet, PROPERTIES } from '@ttylabs/sigil/style';
 *
 * const style = declare({ padding: '1 2', color: 'red', 'flex-grow': '1' });
 * style.paddingLeft;  // 2
 * style.color;        // the palette index for red
 *
 * PROPERTIES.color.inherits;  // true
 * PROPERTIES.width.initial;   // { type: 'auto' }
 *
 * const cascade = new Cascade([parseStylesheet('.panel:focus > text { color: cyan }')]);
 * cascade.resolve(node, { parent: parentStyle, props: { padding: '1' } });
 * ```
 */

import { readSettings, resolveKeyword } from './declaration.js';
import {
	initialStyle,
	inheritFrom,
	isProperty,
	type PropertyName,
	type Style,
} from './properties.js';
import { isShorthand } from './shorthand.js';

export {
	type AliasName,
	type AlignContent,
	type AlignItems,
	type AlignSelf,
	type BoxSizing,
	type BorderStyle,
	type Display,
	type FlexDirection,
	type FlexWrap,
	COLOR_PROPERTIES,
	LAYOUT_PROPERTIES,
	inheritFrom,
	INHERITED,
	initialStyle,
	isProperty,
	type JustifyContent,
	kebab,
	type Overflow,
	parseDeclaration,
	type Position,
	PROPERTIES,
	PROPERTY_NAMES,
	type PropertyName,
	type Style,
	type TextAlign,
	type TextOverflow,
	type TextTransform,
	type Visibility,
	type WhiteSpace,
} from './properties.js';
export {
	Cascade,
	type CascadeResult,
	type Matched,
	type PropValues,
	type ResolveOptions,
	applyProps,
} from './cascade.js';
export { degradeColor, degradeInto, degradeStyle, oklab, paletteRgb } from './degrade.js';
export {
	type Dirty,
	DIRTY_ORDER,
	type StyleTarget,
	type Update,
	difference,
	Restyler,
} from './invalidate.js';
export {
	type Setting,
	type WideKeyword,
	longhandsFor,
	readSettings,
	resolveKeyword,
	wideKeyword,
} from './declaration.js';
export {
	type Combinator,
	type Compound,
	type Selector,
	type Simple,
	type Specificity,
	type Step,
	type StyleNode,
	type StyleState,
	compareSpecificity,
	keysFor,
	matches,
	parseSelector,
	parseSelectorList,
	STATES,
	UNIVERSAL_KEY,
} from './selector.js';
export {
	expandShorthand,
	isShorthand,
	SHORTHAND_NAMES,
	type ShorthandName,
	shorthandLonghands,
} from './shorthand.js';
export {
	type Layer,
	type MediaCondition,
	type MediaContext,
	type MediaFeature,
	type MediaQuery,
	type MediaQueryList,
	type Origin,
	type Rule,
	type RuleDeclaration,
	type Stylesheet,
	type StylesheetOptions,
	DEFAULT_MEDIA,
	LAYERS,
	matchesMedia,
	ORIGINS,
	parseMediaQueryList,
	parseStylesheet,
} from './stylesheet.js';
export {
	AUTO,
	cells,
	type Length,
	NONE,
	parseBoolean,
	parseColor,
	parseInteger,
	parseLength,
	percent,
	StyleError,
} from './value.js';
export { UTILITY_CSS } from './utilities.js';
import { parseStylesheet, type Stylesheet } from './stylesheet.js';
import { UTILITY_CSS } from './utilities.js';
import { StyleError } from './value.js';

/** Parsed on the first ask and kept, the way `frameworkSheet()` keeps its own. */
let utility: Stylesheet | undefined;

/**
 * The utility stylesheet, parsed once.
 *
 * ```js
 * import { utilitySheet } from '@ttylabs/sigil/style';
 *
 * render(tree, { sheets: [utilitySheet()] });
 * ```
 *
 * Opt-in rather than always on, which is the one decision here worth stating.
 * `FRAMEWORK_CSS` is parsed for every app because every app draws a built-in
 * eventually and the sheet is the vocabulary a theme restyles; this one is 383
 * rules an app may never name a single one of, and a CLI that answers
 * `--version` and exits should not pay 0.63ms to find that out. An app that
 * wants utilities says so once.
 *
 * It is an ordinary sheet at the ordinary origin, so nothing about it is a
 * special case: the `@layer utilities` it is written in is what puts a `p-2`
 * above an app's own `.panel { padding: 4 }`, and an app beats either with
 * `!important` exactly as it always could.
 *
 * @returns The utility sheet.
 */
export function utilitySheet(): Stylesheet {
	utility ??= parseStylesheet(UTILITY_CSS);
	return utility;
}

/** One declaration, as written: a property or shorthand, and its value. */
export type Declarations = Record<string, string>;

/**
 * Reads a set of declarations into the longhand properties they set.
 *
 * Shorthands are expanded first, and the longhand parsers do the reading -- so
 * a bad value inside `padding: 1 nonsense` is reported against `padding-right`,
 * which is the property that could not take it, rather than against the
 * shorthand, which could not say which part was wrong.
 *
 * A cascade keyword is refused here rather than guessed at: "what does this
 * declaration set" has no answer for `inherit` without a parent, and this
 * function has none. `declare()` does, and takes them.
 *
 * @param declarations - What was written.
 * @returns The properties and their parsed values.
 */
export function readDeclarations(
	declarations: Declarations
): Partial<Record<PropertyName, unknown>> {
	const out: Partial<Record<PropertyName, unknown>> = {};

	for (const [name, value] of Object.entries(declarations)) {
		for (const setting of readSettings(name, value)) {
			if (setting.keyword) {
				throw new StyleError(
					`"${setting.keyword}" is a cascade keyword: it means nothing without a cascade to resolve it against`
				);
			}
			out[setting.property] = setting.value;
		}
	}

	return out;
}

/**
 * A complete style: every property at its initial value, with these
 * declarations applied over the top.
 *
 * This is not the cascade -- there is no origin, no specificity, and no source
 * order here, and there is no parent to inherit from. It is what a single block
 * of declarations means on its own, which is what the cascade will be built out
 * of and what a test wants to write.
 *
 * @param declarations - What was written.
 * @param parent - A parent to inherit from. The initial values, if omitted.
 * @returns The resolved style.
 */
export function declare(declarations: Declarations = {}, parent?: Style): Style {
	const style = (parent ? inheritFrom(parent) : initialStyle()) as Record<PropertyName, unknown>;
	for (const [name, value] of Object.entries(declarations)) {
		for (const setting of readSettings(name, value)) {
			style[setting.property] = setting.keyword
				? resolveKeyword(setting.keyword, setting.property, parent)
				: setting.value;
		}
	}
	return style as Style;
}

/**
 * Whether a name is something this system knows, shorthand or longhand.
 *
 * @param name - The property name, in CSS spelling or camelCase.
 * @returns Whether a declaration of it would be read.
 */
export function isKnownProperty(name: string): boolean {
	// asked directly rather than by parsing an empty value and reading the error
	// message, which is what this used to do: that made the answer depend on the
	// exact wording of a string in another module, and on no property's parser
	// ever failing for a different reason that happened to read the same way
	return isShorthand(name) || isProperty(name);
}
