/**
 * The style property set: every property a terminal can express, what it
 * starts as, and whether it inherits.
 *
 * This is the table everything in the style system reads. The cascade, the
 * layout engine, invalidation, and animation all ask it rather than carrying
 * lists of their own, so a property is added in one place.
 *
 * ```js
 * import { declare, initialStyle, PROPERTIES } from 'main2/style';
 *
 * const style = declare({ padding: '1 2', color: 'red', 'flex-grow': '1' });
 * style.paddingLeft;  // 2
 * style.color;        // the palette index for red
 *
 * PROPERTIES.color.inherits;  // true
 * PROPERTIES.width.initial;   // { type: 'auto' }
 * ```
 */

import {
	initialStyle,
	inheritFrom,
	isProperty,
	parseDeclaration,
	type PropertyName,
	PROPERTIES,
	type Style,
} from './properties.js';
import { expandShorthand, isShorthand } from './shorthand.js';

export {
	type AlignContent,
	type AlignItems,
	type AlignSelf,
	type BoxSizing,
	type BorderStyle,
	type Display,
	type FlexDirection,
	type FlexWrap,
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
export { expandShorthand, isShorthand, SHORTHAND_NAMES } from './shorthand.js';
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
 * @param declarations - What was written.
 * @returns The properties and their parsed values.
 */
export function readDeclarations(
	declarations: Declarations
): Partial<Record<PropertyName, unknown>> {
	const out: Partial<Record<PropertyName, unknown>> = {};

	for (const [name, value] of Object.entries(declarations)) {
		if (isShorthand(name)) {
			for (const [property, raw] of expandShorthand(name, value)) {
				out[property] = PROPERTIES[property].parse(raw);
			}
			continue;
		}

		for (const [property, parsed] of parseDeclaration(name, value)) {
			out[property] = parsed;
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
	for (const [name, value] of Object.entries(readDeclarations(declarations))) {
		style[name as PropertyName] = value;
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
