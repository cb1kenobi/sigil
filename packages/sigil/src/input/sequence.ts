/**
 * Key sequences: a spec grammar, a canonical spelling, and the trie behind both.
 *
 * The router dispatches one key at a time, so a binding was one key and `g g`,
 * `Ctrl-X Ctrl-S` and a leader key were all unexpressible. What makes them
 * expressible is a **trie** over compiled bindings plus a pending sequence: a
 * key that has a child in the trie is held rather than dispatched, and the keys
 * held so far are the pending state an app renders.
 *
 * Nothing here knows what a terminal is, which is the same precision
 * `element/hit.ts` takes: this is a grammar and a data structure, so it is
 * testable with a literal `Key` and no router at all.
 *
 * One canonical spelling does both jobs. `formatKey()` is what a spec parses
 * *to* and what a decoded key is looked up *by*, so the trie is a `Map` keyed by
 * a string rather than a list of patterns to scan -- and a spec and a live key
 * cannot come to disagree about what a key is called, because one function says.
 *
 * ```js
 * parseKeys('ctrl+x ctrl+s'); // two patterns
 * formatKeys(input.sequence.get()); // 'g' -- the pending state, for a status line
 * ```
 */

import { KEY_NAMES, type Key } from '../components/keys.js';

/**
 * What a sequence handler is handed: the keys that completed it.
 *
 * A value rather than a stoppable event, which is what `onResize()` and
 * `onEnd()` already take. There is nothing for a sequence handler to stop: the
 * key that completed the sequence was consumed by the sequence, so the tree
 * never sees it, and a second binding of the same sequence is a second thing the
 * app asked for rather than something to cancel.
 */
export type SequenceHandler = (keys: readonly Key[]) => void;

/**
 * One key of a binding, as the four things a decoded key can be matched on.
 *
 * `Key.sequence` is deliberately not here: it is the bytes the terminal happened
 * to send, and `ESC [ A` and `ESC O A` are the same Up. What a binding names is
 * the key, which is the other four fields.
 */
export interface KeyPattern {
	ctrl: boolean;
	/** Alt, which the wire calls meta and this grammar spells `alt`. */
	meta: boolean;
	name: string;
	shift: boolean;
}

/** Raised by `parseKeys()` for a spec that cannot be a key. */
export class KeySpecError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'KeySpecError';
	}
}

/** Which of a pattern's three boolean fields a modifier word sets. */
type Modifier = 'ctrl' | 'meta' | 'shift';

/**
 * The modifier words, and what each one sets.
 *
 * `alt`, `meta` and `option` are three names for the bit xterm reports in one
 * place, so all three parse and `alt` is what is printed -- that is the word on
 * the keyboard, where `meta` is what the wire calls it.
 *
 * Null-prototype, which is the rule this repository records for every lookup
 * table it has: on a plain object `constructor` reads back a truthy function, so
 * `constructor+a` would have been a spec with a modifier nobody declared,
 * writing `true` to a field called `[object Object]`. The prototype **alone**
 * rather than an `Object.hasOwn` beside it, for the reason `ARROWS` already
 * records: the second half of that convention is about the write side, which a
 * constant nobody writes to cannot have, and a sabotage found each of the two
 * covered by the other.
 */
const MODIFIERS: Record<string, Modifier> = {
	alt: 'meta',
	ctrl: 'ctrl',
	meta: 'meta',
	option: 'meta',
	shift: 'shift',
};
// set afterwards rather than written as a `__proto__` key in the literal, which
// is the rule the template's own tables record: that key makes TypeScript type
// the literal loosely, and the point is the runtime defense rather than the
// spelling
Object.setPrototypeOf(MODIFIERS, null);

/** The canonical order the modifiers are printed in. */
const ORDER: readonly Modifier[] = ['ctrl', 'meta', 'shift'];

/**
 * What each modifier is printed as, which is one spelling out of the three.
 *
 * No prototype hardening, and that is a fact about the keys rather than an
 * omission: this is only ever indexed by an entry of `ORDER`, which is a literal
 * tuple, so there is no untrusted name for one to defend against.
 */
const PRINTED: Record<Modifier, string> = {
	ctrl: 'ctrl',
	meta: 'alt',
	shift: 'shift',
};

/**
 * Spells a key the one way, so that a spec and a live key land on one string.
 *
 * This is the trie's key as well as what an app prints, which is the whole
 * reason there is one function: a status line showing `ctrl+x` and a lookup
 * asking for `ctrl-x` is two vocabularies, and the day they part is the day a
 * binding that reads correctly matches nothing.
 *
 * @param key - A decoded key, or a pattern a spec parsed to.
 * @returns The canonical spelling, modifiers first in a fixed order.
 */
export function formatKey(key: Key | KeyPattern): string {
	let out = '';
	for (const flag of ORDER) {
		if (key[flag]) {
			out += `${PRINTED[flag]}+`;
		}
	}
	return out + key.name;
}

/**
 * Spells a sequence, which is what a pending state looks like in a status line.
 *
 * @param keys - The keys, in the order they were pressed.
 * @returns One space between each, which is the separator a spec uses.
 */
export function formatKeys(keys: readonly (Key | KeyPattern)[]): string {
	return keys.map((key) => formatKey(key)).join(' ');
}

/**
 * Reads one key out of a spec token.
 *
 * The modifiers are stripped as prefixes rather than by splitting on `+`, which
 * is what makes `ctrl++` the `+` key held with Ctrl rather than an empty name:
 * `'ctrl++'.split('+')` is three pieces and two of them are blank, so a splitter
 * has to decide which blank is the key. Stripping has nothing to decide --
 * whatever is left after the known prefixes is the name, `+` and `-` included.
 */
function parseKey(token: string): KeyPattern {
	const pattern: KeyPattern = { ctrl: false, meta: false, name: '', shift: false };
	const seen = new Set<Modifier>();
	let rest = token;

	for (;;) {
		const plus = rest.indexOf('+');
		// and this really is about `-1` rather than about `plus < 1`: with no `+`
		// left, `slice(0, -1)` would ask whether the token minus its last character
		// is a modifier, and for `ctrlX` it is -- which strips nothing and loops for
		// ever. A `+` at position zero needs no test of its own, because the lookup
		// below answers for the empty string
		if (plus === -1) {
			break;
		}
		// a keyword, so it is read in any case -- the rule a property name and
		// `inherit` already follow, where a class is matched case-sensitively
		// because it is a name somebody chose
		const flag = MODIFIERS[rest.slice(0, plus).toLowerCase()];
		if (flag === undefined) {
			break;
		}
		if (seen.has(flag)) {
			// a repeat is a typo, and `alt+meta+a` is the same typo spelled twice.
			// Stripping it silently is the reading that says nothing
			throw new KeySpecError(`Repeated modifier in key spec: "${token}"`);
		}
		seen.add(flag);
		pattern[flag] = true;
		rest = rest.slice(plus + 1);
	}

	if (rest === '') {
		throw new KeySpecError(`Missing key name in key spec: "${token}"`);
	}

	const lower = rest.toLowerCase();
	if (KEY_NAMES.has(lower)) {
		pattern.name = lower;
	} else if ([...rest].length === 1) {
		// by code point rather than by code unit, so an emoji is one character and
		// not two halves of one -- the rule `readOne()` already keeps where it reads
		// `codePointAt` rather than `input[start]`
		pattern.name = rest;
	} else {
		throw new KeySpecError(
			`Unknown key name "${rest}" in key spec: "${token}". A name of more than one character has to be one the decoder produces: ${[
				...KEY_NAMES,
			]
				.sort()
				.join(', ')}`
		);
	}

	if (pattern.shift && [...pattern.name].length === 1) {
		// the legacy encoding never reports shift for a plain character: Shift-A
		// arrives as `A` with the flag clear, so `shift+a` is a binding that can
		// never fire. Refused where it is written, which is what `initOption()`
		// does with a `...` hint on an option
		throw new KeySpecError(
			`A terminal does not report shift with a character: write "${pattern.name.toUpperCase()}" rather than "${token}"`
		);
	}

	if (pattern.ctrl && [...pattern.name].length === 1) {
		// and it cannot tell Ctrl-X from Ctrl-Shift-X either -- the byte is the same
		// one and `readOne()` names it from `code + 0x60`, which is always lower
		// case. So the two spellings are one key press and normalizing is what they
		// mean rather than a rewrite of what was asked for
		pattern.name = pattern.name.toLowerCase();
	}

	// and `unknown` -- what the decoder calls a sequence it has no key for -- needs
	// no guard of its own, which was written and deleted again for being
	// unreachable: it is produced inline rather than out of either table, so it is
	// not in `KEY_NAMES`, and the check above refuses it as a name of more than one
	// character. The property is asserted rather than the branch, so that a name
	// added to a table is still refused if it ever becomes reachable

	return pattern;
}

/**
 * Reads a sequence spec.
 *
 * Keys are separated by whitespace and modifiers by `+`: `g g`,
 * `ctrl+x ctrl+s`, `space f`. A spec that cannot be a key throws where it is
 * written rather than becoming a binding that never fires, which is the rule a
 * `...` hint on an option and a keyword the layout engine ignores already
 * follow.
 *
 * What it cannot check is whether a terminal can *send* the combination it
 * names. `ctrl+space` is NUL on most terminals, which the decoder reads as
 * Ctrl-backtick, and the legacy encoding has no spelling at all for a great many
 * pairs -- that is the limit the Kitty keyboard protocol exists to lift rather
 * than something this grammar can enumerate.
 *
 * @param spec - The sequence.
 * @returns One pattern per key, in order.
 */
export function parseKeys(spec: string): KeyPattern[] {
	const tokens = spec.split(/\s+/).filter((token) => token !== '');
	if (tokens.length === 0) {
		throw new KeySpecError('An empty key spec names no key');
	}
	return tokens.map((token) => parseKey(token));
}

/**
 * A node of the binding trie.
 *
 * `handlers` is the bindings that end here and `children` is the keys that carry
 * on, and a node may have both -- which is the whole of the disambiguation: `g`
 * bound and `g g` bound is one node with a handler and a child, and a lone `g`
 * has to wait to find out which.
 */
export interface SequenceNode {
	readonly children: Map<string, SequenceNode>;
	readonly handlers: Set<SequenceHandler>;
	readonly parent: SequenceNode | undefined;
	/** The canonical spelling this node hangs off its parent by, for pruning. */
	readonly spec: string;
}

/**
 * Builds an empty trie.
 *
 * @returns The root, which is the node a sequence starts from.
 */
export function createTrie(): SequenceNode {
	return { children: new Map(), handlers: new Set(), parent: undefined, spec: '' };
}

/**
 * Adds a binding, and hands back the way to take it off again.
 *
 * The disposer **prunes**, which is not tidiness: a node left behind with no
 * handler and no children is still a child of its parent, so it is still a
 * prefix -- and a prefix is what holds a key back. Without the prune, unbinding
 * `g g` would leave `g` waiting for a second key for the life of the process.
 *
 * @param root - The trie.
 * @param patterns - The keys, in order.
 * @param handler - What to run when they are all pressed.
 * @returns Removes the binding.
 */
export function addBinding(
	root: SequenceNode,
	patterns: readonly KeyPattern[],
	handler: SequenceHandler
): () => void {
	let at = root;
	for (const pattern of patterns) {
		const spec = formatKey(pattern);
		let next = at.children.get(spec);
		if (!next) {
			next = { children: new Map(), handlers: new Set(), parent: at, spec };
			at.children.set(spec, next);
		}
		at = next;
	}

	const node = at;
	node.handlers.add(handler);

	let removed = false;
	return () => {
		if (removed) {
			return;
		}
		removed = true;
		node.handlers.delete(handler);
		for (
			let it: SequenceNode | undefined = node;
			it?.parent && it.handlers.size === 0 && it.children.size === 0;
			it = it.parent
		) {
			it.parent.children.delete(it.spec);
		}
	};
}
