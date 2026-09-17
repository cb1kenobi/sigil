/**
 * Selectors: reading one, deciding what it is worth, and asking whether an
 * element matches it.
 *
 * Selectors are the reason to have a stylesheet at all -- styling through props
 * is the fallback, not the design -- and contextual styling is most of what
 * makes a cascade worth having. A focused container restyling its children is
 * the thing props styling cannot do cleanly.
 *
 * ```js
 * import { matches, parseSelectorList } from '@ttylabs/sigil/style';
 *
 * const [selector] = parseSelectorList('.panel:focus > text');
 * selector.specificity;  // [0, 2, 1]
 * matches(selector, node);
 * ```
 */

import { StyleError } from './value.js';

/**
 * The states an element can report being in, as pseudo-classes.
 *
 * `:focus` is the one that earns the whole feature. `:hover` is here because the
 * selector engine must not assume mouse tracking will never exist; nothing
 * reports it yet, so it matches nothing yet, which is the correct answer rather
 * than a missing one.
 */
export type StyleState = 'checked' | 'disabled' | 'focus' | 'hover';

/** Every state pseudo-class, for documentation and for tests that walk them. */
export const STATES: readonly StyleState[] = ['checked', 'disabled', 'focus', 'hover'];

/**
 * What the selector engine needs from an element, and nothing more.
 *
 * Deliberately not the element tree, for the reason `LayoutNode` is not: this is
 * the layer that can be tested with no terminal, no renderer, and no
 * reactivity, and it keeps that only by not knowing what an element is. The
 * element tree will satisfy this interface; so will a literal in a test.
 *
 * There is no bag of attributes here, and that is the point. Attribute selectors
 * were in the original sketch and are deliberately out: if a rule can match on a
 * prop, then writing a prop can change some *other* element's resolved style,
 * and the prop fast path the cascade is built around disappears. State that
 * would have been `[disabled]` goes through `states` or a class instead.
 */
export interface StyleNode {
	/** In document order. `:nth-child()` and the sibling combinators read it. */
	readonly children?: readonly StyleNode[];
	readonly classes?: readonly string[];
	readonly id?: string;
	readonly parent?: StyleNode;
	readonly states?: readonly StyleState[];
	/** What kind of element this is -- `text`, `box`. Matched by a type selector. */
	readonly type: string;
}

/** The usual triple: ids, then classes, then types. Compared left to right. */
export type Specificity = readonly [ids: number, classes: number, types: number];

/** One simple selector, the pieces a compound selector is built from. */
export type Simple =
	| { readonly kind: 'universal' }
	| { readonly kind: 'type'; readonly name: string }
	| { readonly kind: 'id'; readonly name: string }
	| { readonly kind: 'class'; readonly name: string }
	| { readonly kind: 'state'; readonly name: StyleState }
	| { readonly kind: 'first-child' }
	| { readonly kind: 'last-child' }
	| { readonly kind: 'nth-child'; readonly a: number; readonly b: number }
	| { readonly kind: 'not'; readonly selectors: readonly Compound[] };

/** Simple selectors with no combinator between them: all must match one element. */
export interface Compound {
	readonly simples: readonly Simple[];
}

export type Combinator = 'child' | 'descendant' | 'later-sibling' | 'next-sibling';

/** One compound, and how it relates to the compound on its left. */
export interface Step {
	/** `undefined` on the leftmost step, which has nothing to its left. */
	readonly combinator: Combinator | undefined;
	readonly compound: Compound;
}

export interface Selector {
	/**
	 * The bucket this selector is filed under, taken from its rightmost compound:
	 * an id, else a class, else a type, else `*`. An element only tests rules that
	 * could possibly match it.
	 */
	readonly key: string;
	/** The selector as written, for messages. */
	readonly source: string;
	readonly specificity: Specificity;
	/** Left to right, as written. Matching walks it backwards. */
	readonly steps: readonly Step[];
}

const IDENT = /[-_a-zA-Z][-_a-zA-Z0-9]*/y;

/**
 * A cursor over selector source.
 *
 * Hand-rolled rather than a tokenizer: the grammar is small enough that a
 * tokenizer would be a second representation to keep honest, and the error
 * messages are better when the parser can say what it was looking for at the
 * character it stopped on.
 */
class Cursor {
	at = 0;
	readonly text: string;

	constructor(text: string) {
		this.text = text;
	}

	get done(): boolean {
		return this.at >= this.text.length;
	}

	get peek(): string {
		return this.text[this.at] ?? '';
	}

	/** Reads an identifier, or throws saying what was expected. */
	ident(what: string): string {
		IDENT.lastIndex = this.at;
		const match = IDENT.exec(this.text);
		if (!match) {
			throw this.fail(`expected ${what}`);
		}
		this.at = IDENT.lastIndex;
		return match[0];
	}

	/** Whether any whitespace was skipped, which is the descendant combinator. */
	space(): boolean {
		const start = this.at;
		while (!this.done && /\s/.test(this.peek)) {
			this.at++;
		}
		return this.at > start;
	}

	fail(why: string): StyleError {
		const where = this.done ? 'end of selector' : `"${this.text.slice(this.at, this.at + 12)}"`;
		return new StyleError(`Invalid selector "${this.text.trim()}": ${why} at ${where}`);
	}
}

/**
 * Reads a comma-separated list of selectors.
 *
 * @param source - The selector text, as written.
 * @returns One selector per comma-separated part, in source order.
 */
export function parseSelectorList(source: string): Selector[] {
	const cursor = new Cursor(source);
	const out: Selector[] = [];

	for (;;) {
		out.push(readComplex(cursor));
		cursor.space();
		if (cursor.done) {
			return out;
		}
		if (cursor.peek !== ',') {
			throw cursor.fail('expected a comma or the end of the selector');
		}
		cursor.at++;
	}
}

/**
 * Reads exactly one selector.
 *
 * @param source - The selector text, as written.
 * @returns The selector.
 */
export function parseSelector(source: string): Selector {
	const list = parseSelectorList(source);
	if (list.length !== 1) {
		throw new StyleError(`Expected one selector, got ${list.length}: "${source.trim()}"`);
	}
	return list[0];
}

/** Reads one complex selector: compounds joined by combinators. */
function readComplex(cursor: Cursor): Selector {
	cursor.space();
	const start = cursor.at;
	const steps: Step[] = [];
	let combinator: Combinator | undefined;

	for (;;) {
		steps.push({ combinator, compound: readCompound(cursor) });

		const spaced = cursor.space();
		const ch = cursor.peek;

		if (ch === '>' || ch === '+' || ch === '~') {
			cursor.at++;
			cursor.space();
			combinator = ch === '>' ? 'child' : ch === '+' ? 'next-sibling' : 'later-sibling';
			continue;
		}

		if (cursor.done || ch === ',') {
			const source = cursor.text.slice(start, cursor.at).trim();
			return {
				key: keyOf(steps[steps.length - 1].compound),
				source,
				specificity: specificityOf(steps),
				steps,
			};
		}

		if (!spaced) {
			throw cursor.fail('expected a combinator');
		}
		combinator = 'descendant';
	}
}

/** Reads one compound selector: simple selectors with nothing between them. */
function readCompound(cursor: Cursor): Compound {
	const simples: Simple[] = [];

	for (;;) {
		const ch = cursor.peek;

		if (ch === '*') {
			cursor.at++;
			simples.push({ kind: 'universal' });
		} else if (ch === '#') {
			cursor.at++;
			simples.push({ kind: 'id', name: cursor.ident('an id') });
		} else if (ch === '.') {
			cursor.at++;
			simples.push({ kind: 'class', name: cursor.ident('a class name') });
		} else if (ch === ':') {
			simples.push(readPseudo(cursor));
		} else if (ch === '[') {
			// named rather than left to the generic message, because it is a
			// deliberate omission and the reader is owed the reason
			throw cursor.fail(
				'attribute selectors are deliberately out -- a rule that can match on a prop makes a prop write restyle other elements; use a class or a state pseudo-class'
			);
		} else if (/[-_a-zA-Z]/.test(ch)) {
			simples.push({ kind: 'type', name: cursor.ident('an element type') });
		} else if (simples.length === 0) {
			throw cursor.fail('expected an element type, a class, an id, or *');
		} else {
			break;
		}

		if (cursor.done) {
			break;
		}
	}

	return { simples };
}

const NTH = /^([+-]?\d*)n\s*(?:([+-])\s*(\d+))?$/i;

/** Reads a pseudo-class, with its argument if it takes one. */
function readPseudo(cursor: Cursor): Simple {
	cursor.at++;
	if (cursor.peek === ':') {
		throw cursor.fail(
			'pseudo-elements do not exist here -- there is no box to generate content into'
		);
	}

	const name = cursor.ident('a pseudo-class').toLowerCase();

	if ((STATES as readonly string[]).includes(name)) {
		return { kind: 'state', name: name as StyleState };
	}
	if (name === 'first-child') {
		return { kind: 'first-child' };
	}
	if (name === 'last-child') {
		return { kind: 'last-child' };
	}
	if (name === 'nth-child') {
		return readNthChild(cursor);
	}
	if (name === 'not') {
		return readNot(cursor);
	}

	throw new StyleError(
		`Unknown pseudo-class ":${name}" in "${cursor.text.trim()}": there is ${[...STATES]
			.map((s) => `:${s}`)
			.join(', ')}, :first-child, :last-child, :nth-child(), and :not()`
	);
}

/** Reads the argument of `:nth-child()`, as an `an+b` pair. */
function readNthChild(cursor: Cursor): Simple {
	const argument = readArgument(cursor, 'nth-child').trim().toLowerCase();

	if (argument === 'odd') {
		return { kind: 'nth-child', a: 2, b: 1 };
	}
	if (argument === 'even') {
		return { kind: 'nth-child', a: 2, b: 0 };
	}

	if (/^[+-]?\d+$/.test(argument)) {
		return { kind: 'nth-child', a: 0, b: Number(argument) };
	}

	const match = NTH.exec(argument);
	if (!match) {
		throw new StyleError(`Invalid :nth-child("${argument}"): expected odd, even, or an+b`);
	}
	// `n` alone is 1n, `-n` is -1n; anything else is the number as written
	const coefficient = match[1];
	const a =
		coefficient === '' || coefficient === '+' ? 1 : coefficient === '-' ? -1 : Number(coefficient);
	const b = match[3] === undefined ? 0 : Number(`${match[2]}${match[3]}`);
	return { kind: 'nth-child', a, b };
}

/**
 * Reads the argument of `:not()`.
 *
 * A list of compound selectors, which is Selectors 3 plus the comma from
 * Selectors 4. No combinators inside: `:not(.a .b)` reads as a question about
 * an element's ancestors asked while matching that element, and the answer
 * depends on which end you start from.
 */
function readNot(cursor: Cursor): Simple {
	const argument = readArgument(cursor, 'not');
	const selectors = argument.split(',').map((part) => {
		const inner = new Cursor(part.trim());
		if (inner.done) {
			throw new StyleError(`Invalid :not("${argument}"): empty`);
		}
		const compound = readCompound(inner);
		inner.space();
		if (!inner.done) {
			throw new StyleError(
				`Invalid :not("${argument}"): combinators are not allowed inside :not()`
			);
		}
		return compound;
	});
	return { kind: 'not', selectors };
}

/** Reads a parenthesised argument, keeping nested parentheses together. */
function readArgument(cursor: Cursor, name: string): string {
	if (cursor.peek !== '(') {
		throw cursor.fail(`expected an argument for :${name}()`);
	}
	cursor.at++;
	const start = cursor.at;
	let depth = 1;

	while (!cursor.done) {
		const ch = cursor.peek;
		if (ch === '(') {
			depth++;
		} else if (ch === ')') {
			depth--;
			if (depth === 0) {
				const argument = cursor.text.slice(start, cursor.at);
				cursor.at++;
				return argument;
			}
		}
		cursor.at++;
	}

	throw cursor.fail(`expected a closing parenthesis for :${name}()`);
}

/**
 * The bucket a selector is filed under: the most selective thing its rightmost
 * compound says about an element.
 *
 * The last class rather than the first, which is what browsers do and what keeps
 * `.a.b` and `.b` in different buckets more often than not.
 */
function keyOf(compound: Compound): string {
	let klass: string | undefined;
	let type: string | undefined;

	for (const simple of compound.simples) {
		if (simple.kind === 'id') {
			return `#${simple.name}`;
		}
		if (simple.kind === 'class') {
			klass = simple.name;
		} else if (simple.kind === 'type') {
			type = simple.name;
		}
	}

	return klass !== undefined ? `.${klass}` : (type ?? '*');
}

/** The universal bucket, which every element tests whatever else it is. */
export const UNIVERSAL_KEY = '*';

/**
 * Every bucket an element could be filed under, most selective first.
 *
 * @param node - The element.
 * @returns The keys whose rules this element has to test.
 */
export function keysFor(node: StyleNode): string[] {
	const keys = [UNIVERSAL_KEY, node.type];
	if (node.id !== undefined) {
		keys.push(`#${node.id}`);
	}
	for (const name of node.classes ?? []) {
		keys.push(`.${name}`);
	}
	return keys;
}

/** Adds two specificities. */
function add(a: Specificity, b: Specificity): Specificity {
	return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/**
 * Compares two specificities.
 *
 * @param a - One specificity.
 * @param b - The other.
 * @returns Negative when `a` is less specific, positive when more, zero when equal.
 */
export function compareSpecificity(a: Specificity, b: Specificity): number {
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

const NOTHING: Specificity = [0, 0, 0];

/** What one simple selector is worth. */
function specificityOfSimple(simple: Simple): Specificity {
	switch (simple.kind) {
		case 'id':
			return [1, 0, 0];
		case 'type':
			return [0, 0, 1];
		case 'universal':
			return NOTHING;
		case 'not':
			// the most specific of its arguments, which is what CSS says: `:not()`
			// itself is worth nothing and what is inside it is worth what it says
			return simple.selectors.reduce<Specificity>((most, compound) => {
				const here = specificityOfCompound(compound);
				return compareSpecificity(here, most) > 0 ? here : most;
			}, NOTHING);
		default:
			// classes, states, and the structural pseudo-classes are all worth a class
			return [0, 1, 0];
	}
}

function specificityOfCompound(compound: Compound): Specificity {
	return compound.simples.reduce<Specificity>(
		(total, simple) => add(total, specificityOfSimple(simple)),
		NOTHING
	);
}

function specificityOf(steps: readonly Step[]): Specificity {
	return steps.reduce<Specificity>(
		(total, step) => add(total, specificityOfCompound(step.compound)),
		NOTHING
	);
}

/** The children of a node's parent, which is the list it is positioned within. */
function siblings(node: StyleNode): readonly StyleNode[] {
	return node.parent?.children ?? [];
}

/**
 * Where a node sits among its siblings, one-based, and how many there are.
 *
 * A node with no parent is the only child of nothing, which is what browsers
 * answer for the root: `:first-child` matches it.
 */
function position(node: StyleNode): { index: number; count: number } {
	if (!node.parent) {
		return { count: 1, index: 1 };
	}
	const list = siblings(node);
	return { count: list.length, index: list.indexOf(node) + 1 };
}

function previousSibling(node: StyleNode): StyleNode | undefined {
	const { index } = position(node);
	return index > 1 ? siblings(node)[index - 2] : undefined;
}

/** Whether a one-based position satisfies `an+b` for some whole `n` of 0 or more. */
function matchesNth(index: number, a: number, b: number): boolean {
	if (a === 0) {
		return index === b;
	}
	const n = (index - b) / a;
	return Number.isInteger(n) && n >= 0;
}

/**
 * Whether an element matches one simple selector.
 *
 * @param simple - The simple selector.
 * @param node - The element.
 * @returns Whether it matches.
 */
function matchesSimple(simple: Simple, node: StyleNode): boolean {
	switch (simple.kind) {
		case 'universal':
			return true;
		case 'type':
			return node.type === simple.name;
		case 'id':
			return node.id === simple.name;
		case 'class':
			return node.classes?.includes(simple.name) ?? false;
		case 'state':
			return node.states?.includes(simple.name) ?? false;
		case 'first-child': {
			const { index } = position(node);
			return index === 1;
		}
		case 'last-child': {
			const { count, index } = position(node);
			return index > 0 && index === count;
		}
		case 'nth-child': {
			const { index } = position(node);
			return index > 0 && matchesNth(index, simple.a, simple.b);
		}
		case 'not':
			return !simple.selectors.some((compound) => matchesCompound(compound, node));
	}
}

function matchesCompound(compound: Compound, node: StyleNode): boolean {
	return compound.simples.every((simple) => matchesSimple(simple, node));
}

/**
 * Whether an element matches a selector.
 *
 * Right to left, like every browser: the rightmost compound is tested against
 * the element itself, and only if it matches does anything walk the tree. A
 * descendant or a later-sibling combinator backtracks, because more than one
 * ancestor or sibling can be the one that matches.
 *
 * @param selector - The selector.
 * @param node - The element.
 * @returns Whether it matches.
 */
export function matches(selector: Selector, node: StyleNode): boolean {
	return matchFrom(selector.steps, selector.steps.length - 1, node);
}

function matchFrom(steps: readonly Step[], i: number, node: StyleNode): boolean {
	if (!matchesCompound(steps[i].compound, node)) {
		return false;
	}
	if (i === 0) {
		return true;
	}

	switch (steps[i].combinator) {
		case 'child':
			return node.parent ? matchFrom(steps, i - 1, node.parent) : false;
		case 'next-sibling': {
			const previous = previousSibling(node);
			return previous ? matchFrom(steps, i - 1, previous) : false;
		}
		case 'later-sibling':
			for (let s = previousSibling(node); s; s = previousSibling(s)) {
				if (matchFrom(steps, i - 1, s)) {
					return true;
				}
			}
			return false;
		default:
			for (let p = node.parent; p; p = p.parent) {
				if (matchFrom(steps, i - 1, p)) {
					return true;
				}
			}
			return false;
	}
}
