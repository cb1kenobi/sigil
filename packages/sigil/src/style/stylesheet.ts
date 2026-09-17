/**
 * The stylesheet: its syntax, its layers, and its media queries.
 *
 * ```js
 * import { parseStylesheet } from '@ttylabs/sigil/style';
 *
 * const sheet = parseStylesheet(`
 *   @layer base {
 *     text { color: default }
 *   }
 *   .panel:focus > text { color: cyan; font-weight: bold }
 *   @media (min-width: 100) { .panel { padding: 1 2 } }
 * `);
 * ```
 *
 * A parser rather than a CSS parser: there is no cascade-level `@import`, no
 * custom properties, no nesting, no `@supports`, and no media types, because
 * there is one medium and it is a terminal. What is here is what a rule needs to
 * say where in the cascade it sits and when it applies.
 */

import { type Setting, readSettings } from './declaration.js';
import { type Selector, parseSelectorList } from './selector.js';
import { StyleError } from './value.js';

/**
 * Where a rule came from.
 *
 * Three of them, and the order is the familiar one: the framework's own sheet is
 * the user-agent stylesheet, the theme sits over it, and the app's own sheet
 * wins. `!important` inverts this, so an app sheet can reach past a component's
 * own props -- see the cascade.
 */
export type Origin = 'app' | 'framework' | 'theme';

/**
 * Which layer a rule sits in, within its origin.
 *
 * Origin, specificity, and source order are not enough, and the utility layer is
 * what proves it: `.button { padding: 4 }` and `.p-2 { padding: 2 }` are both
 * `(0,1,0)`, so which wins is whichever sheet happened to be concatenated last.
 * That is the problem cascade layers exist for, and it is why `@apply` works at
 * all in Tailwind -- a utility has to beat a component rule regardless of
 * specificity or order, or it cannot be used to override anything.
 *
 * The three are fixed and an author cannot declare more. Fixed is smaller, and
 * the case for a fourth has not turned up; the ordering axis itself is here now
 * rather than later because retrofitting one into a shipped cascade changes the
 * meaning of every stylesheet written against it.
 */
export type Layer = 'base' | 'components' | 'utilities';

/** The layers, in cascade order: later beats earlier, for normal declarations. */
export const LAYERS: readonly Layer[] = ['base', 'components', 'utilities'];

/** The origins, in cascade order: later beats earlier, for normal declarations. */
export const ORIGINS: readonly Origin[] = ['framework', 'theme', 'app'];

/**
 * A media feature, of which there are three.
 *
 * Width and height are the terminal's, in cells. `color-level` is how much
 * colour the destination can render, on the same 0-3 scale `ColorLevel` uses --
 * rather than CSS's `color`, which counts bits per component. A second, narrower
 * spelling of a scale the library already has is how two parts of one library
 * come to disagree about what `2` means.
 */
export type MediaFeature = 'color-level' | 'height' | 'width';

/** One feature test. `boolean` is the bare `(color-level)` form: not zero. */
export interface MediaCondition {
	readonly feature: MediaFeature;
	readonly kind: 'boolean' | 'exact' | 'max' | 'min';
	readonly value: number;
}

/** Conditions joined by `and`: all must hold. */
export type MediaQuery = readonly MediaCondition[];

/** Queries separated by a comma: any may hold. */
export type MediaQueryList = readonly MediaQuery[];

/** What the media queries are asked about. */
export interface MediaContext {
	/** How much colour the destination can render, on `ColorLevel`'s 0-3 scale. */
	readonly colorLevel: number;
	readonly height: number;
	readonly width: number;
}

/**
 * What a query is asked about when nobody said.
 *
 * 80 by 24 because it is the terminal's own historical default, so a query
 * written against it means something a reader recognises. A renderer replaces
 * this with the real terminal on the first frame and on every resize.
 */
export const DEFAULT_MEDIA: MediaContext = Object.freeze({
	colorLevel: 3,
	height: 24,
	width: 80,
});

/** One longhand a rule sets, and whether it was marked `!important`. */
export interface RuleDeclaration extends Setting {
	readonly important: boolean;
}

/** One style rule: what it matches, what it sets, and where it sits. */
export interface Rule {
	readonly declarations: readonly RuleDeclaration[];
	readonly layer: Layer;
	/**
	 * Every media query list enclosing the rule, outermost first. All must match,
	 * which is what nesting `@media` inside `@media` means; each list is itself a
	 * comma-separated set of alternatives.
	 */
	readonly media: readonly MediaQueryList[];
	/** Where the rule sits in its own sheet. Ties within a sheet break on it. */
	readonly order: number;
	readonly selectors: readonly Selector[];
}

export interface Stylesheet {
	readonly origin: Origin;
	readonly rules: readonly Rule[];
}

export interface StylesheetOptions {
	/**
	 * The layer for rules that are not inside an `@layer` block.
	 *
	 * `components` by default, which is where a hand-written app or component
	 * sheet belongs: it is what the utilities layer has to be able to beat. The
	 * framework's own sheet passes `base`, and the utility generator passes
	 * `utilities`.
	 */
	readonly layer?: Layer;
	/** Where the sheet came from. `app` by default. */
	readonly origin?: Origin;
}

/**
 * Whether every enclosing media query list holds.
 *
 * @param media - The lists, as a rule carries them.
 * @param context - The terminal to ask about.
 * @returns Whether the rule applies.
 */
export function matchesMedia(media: readonly MediaQueryList[], context: MediaContext): boolean {
	return media.every((list) =>
		list.some((query) => query.every((condition) => holds(condition, context)))
	);
}

function holds(condition: MediaCondition, context: MediaContext): boolean {
	const actual =
		condition.feature === 'width'
			? context.width
			: condition.feature === 'height'
				? context.height
				: context.colorLevel;

	switch (condition.kind) {
		case 'boolean':
			return actual !== 0;
		case 'min':
			return actual >= condition.value;
		case 'max':
			return actual <= condition.value;
		default:
			return actual === condition.value;
	}
}

const FEATURES: readonly MediaFeature[] = ['color-level', 'height', 'width'];

/**
 * Reads a stylesheet.
 *
 * @param source - The stylesheet text.
 * @param opts - The sheet's origin and its default layer.
 * @returns The parsed sheet.
 */
export function parseStylesheet(source: string, opts: StylesheetOptions = {}): Stylesheet {
	const parser = new Parser(source);
	const rules = parser.read(opts.layer ?? 'components', [], false);
	return Object.freeze({ origin: opts.origin ?? 'app', rules: Object.freeze(rules) });
}

/**
 * The stylesheet parser.
 *
 * Hand-rolled and recursive: an at-rule's body is read by the same function that
 * reads the top level, so `@media` inside `@layer` inside `@media` needs no
 * special case and a rule collects whichever layer and media it ended up inside.
 */
class Parser {
	#at = 0;
	#order = 0;
	readonly #text: string;

	constructor(text: string) {
		this.#text = text;
	}

	/**
	 * Reads rules until the end of the source, or until the `}` that closes the
	 * at-rule being read.
	 *
	 * @param layer - The layer rules here belong to.
	 * @param media - The media query lists enclosing them.
	 * @param nested - Whether a closing brace is expected.
	 * @returns The rules, in source order.
	 */
	read(layer: Layer, media: readonly MediaQueryList[], nested: boolean): Rule[] {
		const rules: Rule[] = [];

		for (;;) {
			this.#trivia();

			if (this.#done) {
				if (nested) {
					throw this.#fail('unclosed block');
				}
				return rules;
			}

			if (this.#peek === '}') {
				if (!nested) {
					throw this.#fail('unexpected "}"');
				}
				this.#at++;
				return rules;
			}

			if (this.#peek === '@') {
				rules.push(...this.#atRule(layer, media));
				continue;
			}

			rules.push(this.#styleRule(layer, media));
		}
	}

	get #done(): boolean {
		return this.#at >= this.#text.length;
	}

	get #peek(): string {
		return this.#text[this.#at] ?? '';
	}

	/** Skips whitespace and comments, which may alternate any number of times. */
	#trivia(): void {
		for (;;) {
			while (!this.#done && /\s/.test(this.#peek)) {
				this.#at++;
			}
			if (this.#text.startsWith('/*', this.#at)) {
				const end = this.#text.indexOf('*/', this.#at + 2);
				if (end === -1) {
					throw this.#fail('unterminated comment');
				}
				this.#at = end + 2;
				continue;
			}
			return;
		}
	}

	/**
	 * Reads up to one of `stop`, at nesting depth zero, and returns what came
	 * before it along with the character it stopped on.
	 *
	 * Comments are removed from what comes back rather than only stepped over: a
	 * comment may sit anywhere, including in the middle of a selector, and every
	 * reader downstream would otherwise have to know that.
	 */
	#until(stop: string): { stopped: string; text: string } {
		const start = this.#at;
		let depth = 0;

		while (!this.#done) {
			const ch = this.#peek;
			if (this.#text.startsWith('/*', this.#at)) {
				const end = this.#text.indexOf('*/', this.#at + 2);
				if (end === -1) {
					throw this.#fail('unterminated comment');
				}
				this.#at = end + 2;
				continue;
			}
			if (ch === '(' || ch === '[') {
				depth++;
			} else if (ch === ')' || ch === ']') {
				depth--;
			} else if (depth === 0 && stop.includes(ch)) {
				const text = strip(this.#text.slice(start, this.#at));
				this.#at++;
				return { stopped: ch, text };
			}
			this.#at++;
		}

		return { stopped: '', text: strip(this.#text.slice(start, this.#at)) };
	}

	/** Reads one `selector { declarations }`. */
	#styleRule(layer: Layer, media: readonly MediaQueryList[]): Rule {
		const at = this.#at;
		const prelude = this.#until('{};');

		if (prelude.stopped !== '{') {
			throw this.#fail('expected "{" after a selector', at);
		}

		const selectors = this.#guard(at, () => parseSelectorList(prelude.text));
		const body = this.#until('}');
		if (body.stopped !== '}') {
			throw this.#fail('unclosed rule', at);
		}

		return Object.freeze({
			declarations: Object.freeze(this.#declarations(body.text, at)),
			layer,
			media,
			order: this.#order++,
			selectors: Object.freeze(selectors),
		});
	}

	/** Reads `@layer` or `@media`, and the rules inside it. */
	#atRule(layer: Layer, media: readonly MediaQueryList[]): Rule[] {
		const at = this.#at;
		this.#at++;
		AT_RULE_NAME.lastIndex = this.#at;
		const name = AT_RULE_NAME.exec(this.#text);
		if (!name) {
			throw this.#fail('expected the name of an at-rule after "@"', at);
		}
		this.#at = AT_RULE_NAME.lastIndex;

		const keyword = name[0].toLowerCase();
		const rest = this.#until('{;');
		const prelude = rest.text;
		const opened = rest.stopped === '{';
		if (!opened && rest.stopped !== ';') {
			throw this.#fail(`unclosed @${keyword}`, at);
		}

		if (keyword === 'layer') {
			if (!opened) {
				throw this.#fail(
					'the layer order is fixed -- base, then components, then utilities -- so there is nothing for a bare "@layer" to declare',
					at
				);
			}
			return this.read(this.#layer(prelude, at), media, true);
		}

		if (keyword === 'media') {
			if (!opened) {
				throw this.#fail('expected "{" after a media query', at);
			}
			const query = this.#guard(at, () => parseMediaQueryList(prelude));
			return this.read(layer, [...media, query], true);
		}

		throw this.#fail(`unknown at-rule "@${keyword}": there is @layer and @media`, at);
	}

	/** Reads the name of an `@layer` block, which must be one of the three. */
	#layer(prelude: string, at: number): Layer {
		const name = prelude.trim().toLowerCase();
		if ((LAYERS as readonly string[]).includes(name)) {
			return name as Layer;
		}
		throw this.#fail(
			`unknown layer "${prelude.trim()}": the layers are fixed, and they are ${LAYERS.join(', ')}`,
			at
		);
	}

	/** Reads a declaration block into the longhands it sets. */
	#declarations(body: string, at: number): RuleDeclaration[] {
		const out: RuleDeclaration[] = [];

		// `#until` has already removed the comments, which matters here beyond
		// tidiness: a semicolon inside one is not a declaration boundary
		for (const piece of split(body)) {
			const text = piece.trim();
			if (text === '') {
				continue;
			}

			const colon = indexOfTop(text, ':');
			if (colon === -1) {
				throw this.#fail(`expected "property: value" in "${text}"`, at);
			}

			const name = text.slice(0, colon).trim();
			let value = text.slice(colon + 1).trim();
			const important = IMPORTANT.test(value);
			if (important) {
				value = value.replace(IMPORTANT, '').trim();
			}

			if (value === '') {
				throw this.#fail(`no value for "${name}"`, at);
			}

			for (const setting of this.#guard(at, () => readSettings(name, value))) {
				out.push({ ...setting, important });
			}
		}

		return out;
	}

	/** Runs something that may throw a `StyleError`, and says which line it was on. */
	#guard<T>(at: number, read: () => T): T {
		try {
			return read();
		} catch (err) {
			if (err instanceof StyleError) {
				throw this.#fail(err.message, at);
			}
			throw err;
		}
	}

	// the index is carried around rather than the line, and counted only when
	// something actually fails: counting per rule makes parsing quadratic in the
	// length of a sheet that has nothing wrong with it
	#fail(why: string, at = this.#at): StyleError {
		return new StyleError(`Invalid stylesheet (line ${countLines(this.#text, at)}): ${why}`);
	}
}

const AT_RULE_NAME = /[-a-zA-Z]+/y;

const IMPORTANT = /!\s*important\s*$/i;

/** Which line an index falls on, one-based. */
function countLines(text: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < text.length; i++) {
		if (text[i] === '\n') {
			line++;
		}
	}
	return line;
}

/** Splits a declaration block on its top-level semicolons. */
function split(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let start = 0;

	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === '(' || ch === '[') {
			depth++;
		} else if (ch === ')' || ch === ']') {
			depth--;
		} else if (ch === ';' && depth === 0) {
			out.push(body.slice(start, i));
			start = i + 1;
		}
	}

	out.push(body.slice(start));
	return out;
}

/** The first occurrence of a character outside any brackets. */
function indexOfTop(text: string, wanted: string): number {
	let depth = 0;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (ch === '(' || ch === '[') {
			depth++;
		} else if (ch === ')' || ch === ']') {
			depth--;
		} else if (ch === wanted && depth === 0) {
			return i;
		}
	}
	return -1;
}

/** Removes comments, which may sit anywhere, including mid-selector. */
function strip(text: string): string {
	return text.replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const CONDITION = /^(min-|max-)?([-a-z]+)(?:\s*:\s*(.+))?$/i;

/**
 * Reads a media query list: comma-separated alternatives, each a set of
 * parenthesised feature tests joined by `and`.
 *
 * No media types, because there is one medium. No `not` and no `only`, which
 * exist in CSS to hide queries from parsers that predate them.
 *
 * @param source - The query text, as written after `@media`.
 * @returns The alternatives.
 */
export function parseMediaQueryList(source: string): MediaQueryList {
	const list = source
		.split(',')
		.map((part) => parseMediaQuery(part))
		.filter((query) => query.length > 0);

	if (list.length === 0) {
		throw new StyleError(`Invalid media query "${source.trim()}": it asks nothing`);
	}
	return Object.freeze(list);
}

function parseMediaQuery(source: string): MediaQuery {
	const text = source.trim();
	if (text === '') {
		return [];
	}

	const conditions: MediaCondition[] = [];
	let at = 0;

	for (;;) {
		while (at < text.length && /\s/.test(text[at])) {
			at++;
		}
		if (at >= text.length) {
			break;
		}
		if (text[at] !== '(') {
			throw new StyleError(
				`Invalid media query "${text}": expected a parenthesised feature test at "${text.slice(at, at + 12)}"`
			);
		}

		const end = text.indexOf(')', at);
		if (end === -1) {
			throw new StyleError(`Invalid media query "${text}": unclosed feature test`);
		}
		conditions.push(parseCondition(text.slice(at + 1, end), text));
		at = end + 1;

		while (at < text.length && /\s/.test(text[at])) {
			at++;
		}
		if (at >= text.length) {
			break;
		}
		if (!/^and\b/i.test(text.slice(at))) {
			throw new StyleError(
				`Invalid media query "${text}": expected "and" at "${text.slice(at, at + 12)}"`
			);
		}
		at += 3;
	}

	return Object.freeze(conditions);
}

function parseCondition(source: string, whole: string): MediaCondition {
	const match = CONDITION.exec(source.trim());
	if (!match) {
		throw new StyleError(`Invalid media feature "${source.trim()}" in "${whole}"`);
	}

	const prefix = match[1]?.toLowerCase();
	const feature = match[2].toLowerCase();
	const raw = match[3];

	if (!(FEATURES as readonly string[]).includes(feature)) {
		throw new StyleError(
			`Unknown media feature "${feature}" in "${whole}": there is ${FEATURES.join(', ')}`
		);
	}

	if (raw === undefined) {
		if (prefix) {
			throw new StyleError(`Media feature "${prefix}${feature}" in "${whole}" needs a value`);
		}
		return Object.freeze({ feature: feature as MediaFeature, kind: 'boolean', value: 0 });
	}

	const value = Number(raw.trim());
	if (!/^\d+$/.test(raw.trim()) || !Number.isSafeInteger(value)) {
		throw new StyleError(
			`Invalid value "${raw.trim()}" for media feature "${feature}": expected a whole number of 0 or more`
		);
	}

	return Object.freeze({
		feature: feature as MediaFeature,
		kind: prefix === 'min-' ? 'min' : prefix === 'max-' ? 'max' : 'exact',
		value,
	});
}
