/**
 * Nothing in here is translated, and that is the line the i18n work already
 * drew: a dotted path is what the **app** hands a mutator, so a path that
 * cannot mean anything is a bug report rather than something a user did -- and
 * a translated one is a bug report in a language the maintainer cannot read.
 * Everything a user's *file* can provoke is translated, which is `merge.ts`'s
 * unsafe-key refusal and every message in `jsonc.ts`.
 */

/**
 * The three keys a dotted path may not name.
 *
 * This is where prototype pollution lives, and it is the sharpest form of a
 * hazard this repository already has three entries about -- the parser's
 * registries, the style property tables, the palette's two lookups. `set()`
 * takes a dotted *string*, and a dotted string can arrive from a file in a
 * repository somebody cloned: `set('__proto__.x', 1)` on a plain object goes
 * through `Object.prototype`'s own accessor and changes the target's prototype
 * rather than writing a property, and `set('constructor.prototype.x', 1)` is
 * the same attack two steps along.
 *
 * `prototype` is in the set as well, which on its own is harmless -- a plain
 * object has no such accessor -- and is refused anyway, because the set is
 * easier to be sure of than the reasoning about which two of the three are the
 * live ones.
 *
 * A mutator refuses a path segment and `copyValue()` refuses a key in a value,
 * which are the two halves of the guard. The second is where it is because a
 * *key* can arrive from a file; the first because a *path* can. `copyValue()`
 * runs on every copy rather than only at the ingest, which is a review round's
 * finding rather than caution -- `transformValue()` is a third door, and its
 * entry has the measurement.
 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Whether a key is one of the three. */
export function isUnsafeKey(key: string): boolean {
	return UNSAFE_KEYS.has(key);
}

/**
 * Splits a dotted path into its segments, refusing one that names an unsafe
 * key or that has an empty segment in it.
 *
 * An empty or absent path is no segments, which is the whole merged view --
 * `get()` with nothing answers with everything. An *inner* empty segment is a
 * different thing: `a..b` is a path somebody got wrong rather than a key called
 * `''`, so it is refused where it was written.
 *
 * @param path - The dotted path.
 * @returns The segments.
 * @throws If a segment is unsafe or empty.
 */
export function segments(path: string | undefined): string[] {
	if (!path) {
		return [];
	}

	const parts = path.split('.');

	for (const part of parts) {
		if (!part) {
			throw new Error(`Invalid config path "${path}": it has an empty segment`);
		}
		if (isUnsafeKey(part)) {
			throw new Error(`Invalid config path "${path}": "${part}" is not a safe key`);
		}
	}

	return parts;
}

/**
 * Whether a value is a plain object: one this module may merge into and walk
 * through rather than treat as a leaf.
 *
 * A class instance, a `Date`, a `Map` and a function are all leaves, because
 * merging into one makes no sense -- what would the result be an instance of?
 * So the structure this module owns is plain objects and arrays, and everything
 * else is a value it carries by reference.
 *
 * @param value - The value.
 * @returns Whether it is a plain object.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const proto = Object.getPrototypeOf(value) as object | null;
	return proto === Object.prototype || proto === null;
}

/**
 * Reads a path out of a value, answering `undefined` where it does not reach.
 *
 * @param root - The value to read from.
 * @param parts - The path segments.
 * @returns What is there, or `undefined`.
 */
export function readPath(root: unknown, parts: readonly string[]): unknown {
	let at = root;

	for (const part of parts) {
		if (!isPlainObject(at) || !Object.hasOwn(at, part)) {
			return undefined;
		}
		at = at[part];
	}

	return at;
}

/**
 * Writes a value at a path, making the objects along the way.
 *
 * A non-object in the way is **replaced** rather than written through, and that
 * is this function's own answer rather than the module's: both of its callers
 * refuse one before they get here. `Config.#assertWritable` does it for `set()`,
 * where the caller is present and can fix it, and `overlay()` does it for a
 * claimed path, where the file turned out to hold a shape the claim cannot go
 * into -- so the replace below is unreachable from either, and is what the
 * function means on its own.
 *
 * The sentence here used to give refusing as the alternative, on the ground that
 * it "would make a `set()` fail over what some other layer happens to hold" --
 * which was false of `set()` by the time it was written, since
 * `#assertWritable()` already refused, and was the leftover rationale for a
 * replace that then reached a file through `overlay()`. Found by review, twice:
 * once at `set()` and once at the overlay.
 *
 * @param root - The object to write into.
 * @param parts - The path segments, at least one.
 * @param value - The value.
 */
export function writePath(
	root: Record<string, unknown>,
	parts: readonly string[],
	value: unknown
): void {
	let at = root;

	for (const part of parts.slice(0, -1)) {
		const next = Object.hasOwn(at, part) ? at[part] : undefined;
		if (!isPlainObject(next)) {
			at[part] = {};
		}
		at = at[part] as Record<string, unknown>;
	}

	at[parts[parts.length - 1] as string] = value;
}

/**
 * Removes a path, and every object it leaves empty behind it.
 *
 * Pruning rather than leaving `{ server: {} }` behind, because an empty object
 * is a difference the merged view can see: it is what `get('server')` would
 * then answer with where it should answer with nothing, and it is what a
 * `save()` would write out as a key nobody set.
 *
 * @param root - The object to delete from.
 * @param parts - The path segments, at least one.
 * @returns Whether anything was removed.
 */
export function deletePath(root: Record<string, unknown>, parts: readonly string[]): boolean {
	// the chain of objects on the way down, so that the walk back up can prune
	// each one that the delete emptied
	const chain: Record<string, unknown>[] = [root];
	let at: Record<string, unknown> = root;

	for (const part of parts.slice(0, -1)) {
		const next = Object.hasOwn(at, part) ? at[part] : undefined;
		if (!isPlainObject(next)) {
			return false;
		}
		at = next;
		chain.push(next);
	}

	const last = parts[parts.length - 1] as string;
	if (!Object.hasOwn(at, last)) {
		return false;
	}
	delete at[last];

	for (let i = chain.length - 1; i > 0; i--) {
		const node = chain[i] as Record<string, unknown>;
		if (Object.keys(node).length > 0) {
			break;
		}
		delete (chain[i - 1] as Record<string, unknown>)[parts[i - 1] as string];
	}

	return true;
}
