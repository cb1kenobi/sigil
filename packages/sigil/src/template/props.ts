/**
 * What a host element accepts, derived from the property table rather than
 * listed beside it.
 *
 * The first version of this file did not exist: the
 * JSX frontend typed a host element as `{ [name: string]: unknown }`, which
 * caught an unknown *element* and let `<box padddding="1" />` through to be
 * refused by the cascade at runtime. That is the gap this closes, and the way
 * it closes it is the rule AGENTS.md already applies to `COLOR_PROPERTIES` and
 * `INHERITED`: a hand-written list is a second list to keep in agreement, and
 * the day it disagrees is the day a real property is rejected or a typo is not.
 *
 * So nothing here enumerates a property. `Style` is the single source of truth
 * for the longhands and carries each one's resolved type; the shorthands and
 * the aliases are read off their own tables as literal unions. A property added
 * to any of the three gets its prop, in both spellings, for free.
 *
 * ## Both spellings, because both are written
 *
 * `backgroundColor` in a props object and `background-color` in a stylesheet
 * are the same property, which `kebab()` already says at runtime. `Kebab<>` is
 * that function in the type system -- the mirror of `src/infer.ts`, which is
 * `camelCase()` written with `Capitalize`. Both spellings are offered and
 * neither is required.
 *
 * ## What an author may write is wider than what the cascade resolves to
 *
 * `Style['width']` is a `Length`, an object. Nobody writes one: they write
 * `10`, `'50%'` or `'auto'` and the parser makes the `Length`. `Authored<>` is
 * that widening, and it is the one piece of judgement in this file -- the
 * property table knows what a value parses *to* and not what spellings reach
 * it, because that is inside each parser's closure. A string is therefore
 * accepted wherever a value is not a keyword union, which is looser than the
 * parser and is the honest limit of what can be derived. It still catches every
 * misspelled *name*, which is the whole of what was missing.
 */

import type { AliasName, Length, ShorthandName, Style, StyleState } from '../style/index.js';

/** A prop may be a value or a thunk, and a thunk is what makes it reactive. */
export type Reactive<T> = T | (() => T);

/**
 * `camelCase` to `kebab-case`, in the type system.
 *
 * The mirror of `kebab()` in `style/properties.ts`, and the other direction of
 * what `src/infer.ts` does with `Capitalize`. Recursive over the characters,
 * which is what a template literal type can do.
 */
type Kebab<S extends string> = S extends `${infer Head}${infer Tail}`
	? Head extends Uppercase<Head>
		? Head extends Lowercase<Head>
			? `${Head}${Kebab<Tail>}`
			: `-${Lowercase<Head>}${Kebab<Tail>}`
		: `${Head}${Kebab<Tail>}`
	: S;

/**
 * The properties whose value is a colour.
 *
 * Written out, and it is the one list here that is: `Color` is `number`, so a
 * conditional type cannot tell a colour from a padding -- `T extends Color`
 * matched every numeric property and made `paddingTop={1}` a type error while
 * `color={39}` stayed legal, which is both answers backwards. A colour is
 * spelled, never counted: `parseColor()` refuses `"39"` and wants `red`,
 * `#ff8800` or `palette(39)`. `test/template/props.test.ts` asserts this
 * against `COLOR_PROPERTIES`, which is what keeps it from drifting.
 */
export const COLOR_PROP_NAMES = ['backgroundColor', 'borderColor', 'color'] as const;

type ColorPropertyName = (typeof COLOR_PROP_NAMES)[number];

/**
 * `kebab-case` to `camelCase`, the inverse of `Kebab<>`.
 *
 * The shorthand and alias tables are keyed in CSS spelling, and the runtime
 * takes either -- `isKnownProperty('flexFlow')` is true, and
 * `declare({ fontWeight: 'bold' })` works -- so offering only the kebab key
 * made `<box flexFlow="column" />` a type error and a runtime success.
 */
type Camel<S extends string> = S extends `${infer Head}-${infer Tail}`
	? `${Head}${Capitalize<Camel<Tail>>}`
	: S;

/**
 * What an author may write for property `K`.
 *
 * A keyword union stays itself, so `display="grid"` is an error and completion
 * offers `flex` and `none`. A colour is a string. Everything else widens to the
 * spellings a parser takes, which for a length or a count means a number as
 * well -- `padding={1}` is what everybody writes.
 */
type Authored<K extends keyof Style> = K extends ColorPropertyName
	? string
	: Style[K] extends string
		? Style[K]
		: Style[K] extends Length
			? number | string
			: Style[K] extends number
				? number | string
				: Style[K] extends boolean
					? boolean | string
					: never;

/** Every longhand, camelCase, as an author may write it. */
type LonghandProps = {
	[K in keyof Style]?: Reactive<Authored<K>>;
};

/** Every longhand again, kebab-case, which is the stylesheet spelling. */
type KebabProps = {
	[K in keyof Style as Kebab<K & string>]?: Reactive<Authored<K>>;
};

/**
 * The shorthands and the aliases.
 *
 * Both take source text a longhand parser then reads -- `padding="0 1"` is two
 * values for four longhands -- so there is no narrower type to give them than
 * the string the expander is handed. A number is allowed because `padding={1}`
 * is what everyone writes.
 */
type ShorthandProps = {
	[K in AliasName | Camel<AliasName | ShorthandName> | ShorthandName]?: Reactive<number | string>;
};

/**
 * The five props that are not style properties.
 *
 * Exactly what `Element.#apply()` branches on before it hands the rest to the
 * cascade, which is what makes this list the same list rather than one more of
 * them.
 */
export interface ReservedProps {
	class?: Reactive<readonly string[] | string>;
	/** Whether the focus ring stops here. A `tabindex` implies it. */
	focusable?: Reactive<boolean>;
	id?: Reactive<string>;
	/** Identity across renders, which is what a keyed list diff matches on. */
	key?: number | string;
	/** Where in the ring, for an element that should not be in document order. */
	tabindex?: Reactive<number>;
}

/** The style half of what a host element takes, in both spellings. */
export type StyleProps = KebabProps & LonghandProps & ShorthandProps;

/** Everything a host element accepts, and nothing else. */
export type HostProps = ReservedProps & StyleProps;

/**
 * A state a selector can match, for the tests that walk them.
 *
 * Re-exported so that a caller typing a component's props against the same
 * vocabulary does not have to reach into the style package for one name.
 */
export type { StyleState };
