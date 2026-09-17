/**
 * Reading one declaration into the longhands it sets.
 *
 * Shared by `declare()`, by the stylesheet parser, and by the cascade's props
 * path, because all three read the same syntax and none of them should carry its
 * own copy of "expand the shorthand, then let the longhand parsers do the
 * reading".
 */

import {
	INHERITED,
	parseDeclaration,
	propertyLonghands,
	PROPERTIES,
	type PropertyName,
	type Style,
} from './properties.js';
import { expandShorthand, isShorthand, shorthandLonghands } from './shorthand.js';
import { StyleError } from './value.js';

/**
 * The keywords that mean something to the cascade and nothing to a value parser.
 *
 * `value.ts` already notes that `inherit` is not a colour; the same is true of
 * every other property, so they are recognised once, here, rather than added to
 * fourteen grammars. `currentcolor` is deliberately not among them: it needs a
 * resolution order of its own -- a value that depends on another property of the
 * same element, resolved after the cascade has picked winners -- and nothing
 * needs it yet.
 */
export type WideKeyword = 'inherit' | 'initial' | 'unset';

const KEYWORDS: readonly string[] = ['inherit', 'initial', 'unset'];

/**
 * One longhand a declaration sets: a parsed value, or a keyword the cascade
 * resolves later.
 */
export interface Setting {
	readonly keyword?: WideKeyword;
	readonly property: PropertyName;
	readonly value?: unknown;
}

/**
 * The keyword a value is, if it is one.
 *
 * @param value - The value, as written.
 * @returns The keyword, or `undefined` for an ordinary value.
 */
export function wideKeyword(value: string): WideKeyword | undefined {
	const text = value.trim().toLowerCase();
	return KEYWORDS.includes(text) ? (text as WideKeyword) : undefined;
}

/**
 * The longhands a name sets, whatever value it is given: one for a property,
 * several for a shorthand or a multi-longhand alias.
 *
 * The cascade asks this to expand `padding: inherit`, which has to reach all
 * four edges with no value for any parser to read.
 *
 * @param name - A property or shorthand, in either spelling and any case.
 * @returns The longhands it covers.
 */
export function longhandsFor(name: string): readonly PropertyName[] {
	const longhands = shorthandLonghands(name) ?? propertyLonghands(name);
	if (!longhands) {
		throw new StyleError(`Unknown property "${name}"`);
	}
	return longhands;
}

/**
 * Reads one declaration into the longhands it sets.
 *
 * @param name - A property or shorthand, in either spelling and any case.
 * @param value - The value, as written.
 * @returns One setting per longhand, in the order the expansion produced them.
 */
export function readSettings(name: string, value: string): Setting[] {
	const keyword = wideKeyword(value);
	if (keyword) {
		// a wide keyword covers every longhand the name covers, including the ones
		// an ordinary use of the shorthand would have left to a default -- it is
		// the shorthand's own rule, asked before there is a value to expand
		return longhandsFor(name).map((property) => ({ keyword, property }));
	}

	if (isShorthand(name)) {
		return expandShorthand(name, value).map(([property, raw]) => ({
			property,
			value: PROPERTIES[property].parse(raw),
		}));
	}

	return parseDeclaration(name, value).map(([property, parsed]) => ({
		property,
		value: parsed,
	}));
}

/**
 * What a wide keyword resolves to for one property.
 *
 * `inherit` is the parent's value whether or not the property inherits on its
 * own; `initial` is the table's; `unset` is whichever of the two the table says
 * the property does by default. With no parent there is nothing to inherit
 * from, so `inherit` is the initial value -- which is what the root gets.
 *
 * @param keyword - The keyword.
 * @param property - The property it was written on.
 * @param parent - The parent's resolved style, if there is a parent.
 * @returns The value.
 */
export function resolveKeyword(
	keyword: WideKeyword,
	property: PropertyName,
	parent: Style | undefined
): unknown {
	const inherits = keyword === 'inherit' || (keyword === 'unset' && INHERITED.includes(property));
	if (!inherits) {
		return PROPERTIES[property].initial;
	}
	return parent ? parent[property] : PROPERTIES[property].initial;
}
