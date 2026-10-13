import { __ } from '../i18n/index.js';
import { isPlainObject, isUnsafeKey } from './dotted.js';

/**
 * Copies the structure of a value, and optionally refuses an unsafe key in it.
 *
 * Two jobs in one walk because they are the same walk, and one walk because two
 * would be two definitions of what "structure" is -- which is the thing the
 * merge and the freeze below both have to agree about.
 *
 * Only the **structure** is copied. A `Date`, a class instance, a `Map` and a
 * function are carried by reference, which is what makes an object layer able
 * to hold a plugin -- the thing a `.js` config was for, now that there is no
 * `.js` layer. `structuredClone()` is the obvious alternative and throws on a
 * function, which is exactly the case this has to serve.
 *
 * Copying at all is the rule `initCommand()` already keeps -- "copies, never
 * decorates" -- read for a value an app or a file handed in: without it, an app
 * that mutates the object it passed to `object()` would be reaching into a layer
 * afterwards, and a layer `set()` wrote to would be reaching back into the
 * app's object.
 *
 * ## It refuses an unsafe key, unconditionally
 *
 * `JSON.parse` puts `__proto__` on an object as an own property rather than
 * through the accessor, so a file holding one is read without incident -- and
 * then the first `Object.assign({}, config.get('x'))` an app writes triggers the
 * setter. A file that holds one is either a mistake or an attack, and in both
 * cases the app should not start quietly.
 *
 * The check used to be skipped where `where` was omitted, on the argument that
 * a value the merge copies has already been through this door. That argument was
 * **false**, and the review round that found it is why the parameter is required
 * now: `transformValue()` is a **third** door. A `type: 'json'` or `type: 'auto'`
 * setting whose value is the *string* `'{"__proto__":{"polluted":true}}'` enters
 * as a string, which has no keys to refuse, and becomes an object with an own
 * `__proto__` **after** the ingest copy -- so the merge's own unchecked copy did
 * `out['__proto__'] = ...` on a fresh `{}` and set its prototype. Measured:
 * `config.get('data').polluted` was `true`, the value was **not frozen**, because
 * `isPlainObject()` is false for an object whose prototype is neither
 * `Object.prototype` nor `null`, and a later layer at that path replaced rather
 * than merged. Reachable from a file, from an environment variable and from a
 * schema `default`.
 *
 * So there is one rule and one place: **every copy refuses.** The three
 * coercion sites pass a label of their own so that the message names where the
 * value came from, which is what makes the merge's own check a tripwire rather
 * than the thing that catches it -- and the tripwire stays, because "nothing can
 * reach here" is the claim that was just wrong.
 *
 * ## It drops a key whose value is `null`
 *
 * **A key absent and a key set to `null` are both "not configured"; a key set to
 * `""` is an empty string.** The file's own version of `envValue()`'s rule, and
 * it is here rather than per declared setting because a document says nothing
 * the same way whether or not a schema named the key -- which is what it was
 * before, so `{ "x": null }` with no schema answered `null` and `has('x')` was
 * `true`, contradicting this module's own rule.
 *
 * `null` **inside an array** is data rather than a format saying nothing, so an
 * element is kept. And a key whose object value is left empty by the drop is
 * kept as `{}`, because an empty object a user wrote and one a dropped `null`
 * left are the same thing and pruning one would prune both.
 *
 * @param value - The value.
 * @param where - Where it came from, for the message.
 * @returns A copy whose structure is this module's.
 * @throws If any key anywhere in it is unsafe.
 */
export function copyValue(value: unknown, where: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => copyValue(item, where));
	}

	if (!isPlainObject(value)) {
		return value;
	}

	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (isUnsafeKey(key)) {
			throw new Error(__`Unsafe config key "${key}" in ${where}`);
		}
		if (value[key] === null) {
			continue;
		}
		out[key] = copyValue(value[key], where);
	}
	return out;
}

/**
 * Merges one value over another, answering with structure this module owns.
 *
 * Plain objects merge key by key, and everything else replaces -- including an
 * array, unless the schema said `concat` for that path. `concat` is asked by
 * path rather than by value, which is what keeps the two array rules one
 * decision the schema makes rather than a guess at what the values look like.
 *
 * Everything that comes from `over` is **copied**, which is not tidiness: the
 * merged view is frozen on the way out, and a view that shared a layer's own
 * nested object would freeze the layer -- after which the next `set()` on that
 * layer throws. Found by a test rather than by reading, which is why it is
 * written down here. `base` needs no copy, because it is either this module's
 * own first copy or the result of a previous step.
 *
 * @param base - What is underneath, already owned.
 * @param over - What is on top, not owned.
 * @param path - The dotted path being merged, for the `concat` lookup.
 * @param concat - Whether this path's arrays concatenate.
 * @param where - What is being merged, for the tripwire's message.
 * @returns The merged value.
 */
function mergeInto(
	base: unknown,
	over: unknown,
	path: string,
	concat: (path: string) => boolean,
	where: string
): unknown {
	if (Array.isArray(base) && Array.isArray(over) && concat(path)) {
		return [...base, ...over.map((item) => copyValue(item, where))];
	}

	if (!isPlainObject(base) || !isPlainObject(over)) {
		return copyValue(over, where);
	}

	const out: Record<string, unknown> = { ...base };
	for (const key of Object.keys(over)) {
		const at = path ? `${path}.${key}` : key;
		out[key] = Object.hasOwn(base, key)
			? mergeInto(base[key], over[key], at, concat, where)
			: copyValue(over[key], where);
	}
	return out;
}

/** One thing to merge, with where it came from for the message. */
export interface MergeSource {
	/** Where it came from, for the tripwire's message. */
	label: string;
	/** What to merge. */
	value: unknown;
}

/**
 * Merges a stack of values into one, bottom first.
 *
 * @param sources - What to merge, bottom first.
 * @param concat - Whether a path's arrays concatenate.
 * @returns The merged view, not yet frozen.
 */
export function mergeLayers(
	sources: readonly MergeSource[],
	concat: (path: string) => boolean
): unknown {
	let merged: unknown;
	let first = true;

	for (const { label, value } of sources) {
		merged = first ? copyValue(value, label) : mergeInto(merged, value, '', concat, label);
		first = false;
	}

	return merged ?? {};
}

/**
 * Freezes the structure this module built, and nothing else.
 *
 * The merged view is handed out by `get()`, so an app holds a live reference to
 * it until something recomputes -- and mutating it would change what a later
 * `get()` answers while changing no layer, which is a value with no writer.
 * Freezing makes that mistake loud, which is the call every initial value in
 * the property table and every interned canvas style already gets. An app that
 * wants a mutable copy takes one: `structuredClone(config.get('x'))`.
 *
 * Only plain objects and arrays, because those are the ones this module made.
 * Freezing a `Date` an app handed in, or a function, would be freezing somebody
 * else's object on the way past.
 *
 * @param value - The merged view.
 * @returns The same value, deeply frozen.
 */
export function deepFreeze<T>(value: T): T {
	if (Array.isArray(value)) {
		for (const item of value) {
			deepFreeze(item);
		}
		return Object.freeze(value);
	}

	if (isPlainObject(value)) {
		for (const key of Object.keys(value)) {
			deepFreeze(value[key]);
		}
		return Object.freeze(value);
	}

	return value;
}
