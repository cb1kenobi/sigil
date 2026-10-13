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
 * The key refusal is the other door of the prototype guard, and it is asked
 * only where a value **enters**. `JSON.parse` puts `__proto__` on an object as
 * an own property rather than through the accessor, so a file holding one is
 * read without incident -- and then the first `Object.assign({}, config.get(
 * 'x'))` an app writes triggers the setter. A file that holds one is either a
 * mistake or an attack, and in both cases the app should not start quietly.
 *
 * @param value - The value.
 * @param where - The layer, for the message. Omitted where the value has
 * already been through this door, which is every copy the merge takes.
 * @returns A copy whose structure is this module's.
 * @throws If `where` was given and any key anywhere in it is unsafe.
 */
export function copyValue(value: unknown, where?: string): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => copyValue(item, where));
	}

	if (!isPlainObject(value)) {
		return value;
	}

	const out: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (where !== undefined && isUnsafeKey(key)) {
			throw new Error(__`Unsafe config key "${key}" in ${where}`);
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
 * @returns The merged value.
 */
function mergeInto(
	base: unknown,
	over: unknown,
	path: string,
	concat: (path: string) => boolean
): unknown {
	if (Array.isArray(base) && Array.isArray(over) && concat(path)) {
		return [...base, ...over.map((item) => copyValue(item))];
	}

	if (!isPlainObject(base) || !isPlainObject(over)) {
		return copyValue(over);
	}

	const out: Record<string, unknown> = { ...base };
	for (const key of Object.keys(over)) {
		const at = path ? `${path}.${key}` : key;
		out[key] = Object.hasOwn(base, key)
			? mergeInto(base[key], over[key], at, concat)
			: copyValue(over[key]);
	}
	return out;
}

/**
 * Merges a stack of layer values into one, bottom first.
 *
 * @param values - The layer values, bottom first.
 * @param concat - Whether a path's arrays concatenate.
 * @returns The merged view, not yet frozen.
 */
export function mergeLayers(
	values: readonly unknown[],
	concat: (path: string) => boolean
): unknown {
	let merged: unknown;
	let first = true;

	for (const value of values) {
		merged = first ? copyValue(value) : mergeInto(merged, value, '', concat);
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
