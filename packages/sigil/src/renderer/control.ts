/**
 * Control flow, as components.
 *
 * This is the tax a component body that runs once has to charge, and it should
 * be read as a deliberate decision rather than discovered. An `if` in a body
 * runs once and never again; a `.map()` builds the list it saw and nothing else.
 * So a conditional and a list are *components*, because a component is the only
 * thing that can own a branch and dispose it when the branch goes away.
 *
 * They are the runtime primitive rather than a convenience over one: a template
 * compiler (SIG-69) emits calls to these rather than growing a second way of
 * saying the same thing, so there is one implementation of what mounting and
 * unmounting a branch means.
 *
 * Both return a `box`, because a component produces exactly one node and this
 * layer has no fragment. That is a real cost in a flexbox world -- the wrapper is
 * a flex item and it lays out -- so both take `props`, and a `Show` inside a row
 * is usually written with `display: 'contents'`-shaped intent that does not exist
 * here: give the wrapper the layout the branch would have had.
 */

import { box, type Element, type ElementProps } from '../element/index.js';
import { State, untrack } from '../signals/index.js';
import { createBranch, createEffect, runWithOwner } from './owner.js';

/** Whatever `when` produced, where it counts as present. */
type Truthy<T> = Exclude<T, false | null | undefined>;

export interface ShowProps<T> {
	/** Built when `when` is absent. */
	fallback?: () => Element;
	/** The wrapper's own props. */
	props?: ElementProps;
	/** What to build, handed what `when` produced. */
	children: (value: Truthy<T>) => Element;
	/** Read reactively; `false`, `null` and `undefined` are absent. */
	when: () => T;
}

/**
 * Mounts a branch while `when` is present, and disposes it when it is not.
 *
 * Disposes rather than hides: a hidden branch is still a branch, its effects
 * still run, and a list of a thousand rows behind a closed disclosure still
 * costs a thousand rows of reactivity. Hiding is `visibility` and it is a
 * different question.
 *
 * The branch is rebuilt only when presence *changes*, not on every change to
 * what `when` returned -- a `when` that reads a counter would otherwise tear its
 * branch down and build it again on every tick, losing whatever state the branch
 * held. What the branch is handed is therefore read untracked at build time.
 *
 * @param props - The branch, the condition, and the wrapper's props.
 * @returns The wrapper element.
 */
export function Show<T>(props: ShowProps<T>): Element {
	const host = box(props.props ?? {});
	let dispose: (() => void) | undefined;
	let showing: boolean | undefined;

	createEffect(() => {
		const value = props.when();
		const present = value !== false && value !== null && value !== undefined;
		if (present === showing) {
			return;
		}
		showing = present;

		dispose?.();
		dispose = undefined;
		// one child by construction, since a component produces exactly one node.
		// Emptied by asking for the first one until there is none rather than by
		// walking `children`, which hands back the live array -- removing while
		// iterating that skips every other entry
		while (host.children[0]) {
			host.children[0].remove();
		}

		const build = present ? () => props.children(value as Truthy<T>) : props.fallback;
		if (!build) {
			return;
		}

		const branch = createBranch();
		dispose = branch.dispose;
		host.append(runWithOwner(branch.owner, () => untrack(build)));
	});

	return host;
}

export interface ForProps<T> {
	/** Read reactively. */
	each: () => readonly T[];
	/** Built while the list is empty. */
	fallback?: () => Element;
	/** The wrapper's own props. */
	props?: ElementProps;
	/**
	 * Builds one row.
	 *
	 * The index is an accessor rather than a number because a row that moved
	 * keeps its element: it is the same row, so rebuilding it to tell it where it
	 * now sits would throw away the thing keying exists to keep. Reading the
	 * accessor in an effect is how a row follows its own position.
	 */
	children: (item: T, index: () => number) => Element;
}

interface Row<T> {
	dispose: () => void;
	element: Element;
	index: State<number>;
	item: T;
}

/**
 * Mounts one branch per item, keyed by the item itself.
 *
 * Keyed by identity rather than by position, which is what makes a list that
 * reorders keep each row's element -- and with it the row's effects, its focus,
 * and anything else attached to that element. Position keying rebuilds every row
 * after the first change, which for a terminal means the focus ring moves under
 * whoever was typing.
 *
 * Identity means an item that appears twice is two rows, so the bookkeeping is a
 * queue per key rather than one entry: two equal primitives in a list are a list
 * with two entries in it, not a bug to refuse.
 *
 * @param props - The list, the row builder, and the wrapper's props.
 * @returns The wrapper element.
 */
export function For<T>(props: ForProps<T>): Element {
	const host = box(props.props ?? {});
	let rows: Row<T>[] = [];
	let fallback: { dispose: () => void; element: Element } | undefined;

	createEffect(() => {
		const items = props.each();

		const spare = new Map<T, Row<T>[]>();
		for (const row of rows) {
			const held = spare.get(row.item);
			if (held) {
				held.push(row);
			} else {
				spare.set(row.item, [row]);
			}
		}

		const next: Row<T>[] = [];
		for (const [at, item] of items.entries()) {
			const kept = spare.get(item)?.shift();
			if (kept) {
				// the same row, possibly somewhere else: tell it where, and leave
				// everything it built alone
				kept.index.set(at);
				next.push(kept);
				continue;
			}

			const branch = createBranch();
			const index = new State(at);
			const element = runWithOwner(branch.owner, () =>
				untrack(() => props.children(item, () => index.get()))
			);
			next.push({ dispose: branch.dispose, element, index, item });
		}

		for (const left of spare.values()) {
			for (const row of left) {
				row.element.remove();
				row.dispose();
			}
		}

		if (next.length > 0 && fallback) {
			fallback.element.remove();
			fallback.dispose();
			fallback = undefined;
		}

		// placed by walking the target order and moving only what is out of place,
		// because `insertBefore` marks the parent's children dirty and a list that
		// re-inserts every row restyles every sibling of every row
		for (const [at, row] of next.entries()) {
			if (host.children[at] !== row.element) {
				host.insertBefore(row.element, host.children[at]);
			}
		}

		rows = next;

		if (next.length === 0 && !fallback && props.fallback) {
			const branch = createBranch();
			const element = runWithOwner(branch.owner, () => untrack(props.fallback as () => Element));
			fallback = { dispose: branch.dispose, element };
			host.append(element);
		}
	});

	return host;
}
