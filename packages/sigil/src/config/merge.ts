import { __ } from '../i18n/index.js';
import { deletePath, isPlainObject, isUnsafeKey, readPath, segments, writePath } from './dotted.js';

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
 * ## It drops a key whose value is `null` or `undefined`
 *
 * **A key absent and a key set to `null` are both "not configured"; a key set to
 * `""` is an empty string.** `undefined` is beside `null` because neither is a
 * value, and a key holding one is a key `Object.keys()` reports while `has()`
 * answers `false` for it. The file's own version of `envValue()`'s rule, and
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
	return copyInto(value, where, new WeakSet<object>(), false);
}

/**
 * The same copy, with a `null` **kept**.
 *
 * The one difference between the two, and the write path is what it is for.
 * `copyValue()` drops a `null` because *this module* reads one as a format
 * saying nothing, which is right for a layer; a file that says `"theme": null`
 * is a file whose `null` the write was not asked to change, so dropping it on
 * the way to the writer would delete the line -- and with it whatever comment
 * sits above it. The lossless rule said in one parameter.
 *
 * `undefined` is still dropped, and that is not an inconsistency: `null` is a
 * value in every text format and `undefined` is a value in none, so a key
 * holding one cannot have come from a document and cannot be written back into
 * one. Which is also what keeps `JSON.stringify` from meeting one.
 *
 * @param value - The value, as a store read it.
 * @param where - Where it came from, for the message.
 * @returns A copy whose structure is this module's.
 * @throws If any key anywhere in it is unsafe, or it refers back to itself.
 */
export function copyDocument(value: unknown, where: string): unknown {
	return copyInto(value, where, new WeakSet<object>(), true);
}

/**
 * The walk, with the objects it is inside so that a cycle is refused rather
 * than recursed into.
 *
 * A cyclic value is `Maximum call stack size exceeded` out of here, out of
 * `mergeInto()` and out of `deepFreeze()`, and it is reachable from exactly the
 * thing an object layer is *for*: a value an app built in code, where a plugin
 * holding a reference back to its own registry is ordinary. No text format can
 * produce one, so this is the object layer's own edge.
 *
 * Refused rather than carried, because neither the merge nor the freeze has an
 * answer for one -- what would the merged view be? Not translated, because a
 * cycle is a fact about an object the **app** built.
 *
 * Added and removed around the recursion rather than only added, so that a
 * value referenced twice is copied twice and only a genuine cycle is refused.
 *
 * @param value - The value.
 * @param where - Where it came from, for the message.
 * @param seen - The objects this walk is inside.
 * @param nulls - Whether a key holding `null` is kept, which is the write
 * path's reading and not a layer's. See `copyDocument()`.
 * @returns A copy whose structure is this module's.
 */
function copyInto(value: unknown, where: string, seen: WeakSet<object>, nulls: boolean): unknown {
	const structure = Array.isArray(value) || isPlainObject(value);

	if (structure) {
		if (seen.has(value as object)) {
			throw new Error(`A config value in ${where} refers back to itself`);
		}
		seen.add(value as object);
	}

	try {
		if (Array.isArray(value)) {
			// a `null` **inside** an array is data rather than a format saying
			// nothing, so an element is kept. So is an `undefined`, which no text
			// format can produce and which a JSON round trip turns into `null` --
			// the format's business rather than this module's
			return value.map((item) => copyInto(item, where, seen, nulls));
		}

		if (!isPlainObject(value)) {
			return value;
		}

		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			if (isUnsafeKey(key)) {
				throw new Error(__`Unsafe config key "${key}" in ${where}`);
			}
			// `undefined` beside `null`, because neither is a value: left in, a key
			// whose value is `undefined` is one `Object.keys()` reports and `has()`
			// answers `false` for -- a phantom key, which is what
			// `config.set('x', argv.x)` with no `--x` used to make
			if (value[key] === undefined || (value[key] === null && !nulls)) {
				continue;
			}
			out[key] = copyInto(value[key], where, seen, nulls);
		}
		return out;
	} finally {
		if (structure) {
			seen.delete(value as object);
		}
	}
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

/**
 * Writes the values at a set of dotted paths from one document into another.
 *
 * The three-way merge, said as the only thing it needs to be: the paths are
 * what this process claimed, `from` is what it holds at them, and `into` is
 * whatever the file turned out to hold -- so every key neither names is left
 * exactly as the file has it. A path that is absent in `from` is a deletion,
 * which is what `delete()` recorded and what `undefined` means everywhere else
 * in this module.
 *
 * One implementation because there are two callers and they are the two halves
 * of one save: `Config` overlays this process's changes onto what it read, and
 * the store overlays them again onto what it reads at write time. Two copies of
 * this loop is how the two come to disagree about what a claimed path means.
 *
 * An empty path is skipped because `segments('')` is no segments, which is the
 * whole document and not a path into it -- `Config.#staged` really does hand
 * `''` over, since `apply()` puts it in `touched`, and what stops that reaching
 * a write is `#staged` claiming **no** paths rather than anything here. The
 * consequence for a caller is that `write(value, { paths: [''] })` claims
 * nothing at all; `save()` never passes it.
 *
 * A claimed path whose ancestor in `into` is there and is **not** an object is
 * refused, which is `Config.#assertWritable`'s rule at the second door **with
 * one exemption it does not have**. One
 * direct call -- `write({ items: { 0: 9 } }, { paths: ['items.0'] })` over
 * `{ "items": [1, 2, 3] }` -- replaced the array with `{ "0": 9 }` and lost three
 * elements, which is the input `set()` already refuses, reaching a file through a
 * door that answered differently for no reason. Found by review.
 *
 * Refusing rather than replacing, even where the ancestor is a scalar **another
 * process** wrote in the save window: the save throws before anything is written,
 * the user is told which path changed shape, and a re-run reads the new shape and
 * refuses at `set()` with the same message. The two alternatives both lose
 * something -- replacing destroys a structure nobody claimed, and dropping the
 * claim loses this process's write in silence.
 *
 * An ancestor that is **absent** is created, which is what makes a claim on a key
 * the file says nothing about work at all. And a **`null`** one is created too,
 * which is the exemption and is where this parts from `set()`:
 * `#assertWritable()` asks `at !== undefined && !isPlainObject(at)` and has no
 * null case, so the two conditions really are different and saying they are the
 * same was wrong. What makes that right rather than inconsistent is **which
 * document each one walks**. A layer's own value went through `copyValue()`,
 * which drops a key holding `null`, so `set()` can never meet one; a *document*
 * goes through `copyDocument()`, which **keeps** them, so the overlay can and
 * does -- and `null` means "not configured", so a claim on `a.b` over a file
 * that says `"a": null` has to create rather than refuse.
 *
 * Which is also the one way the replace in `writePath()` is reachable at all:
 * the exemption lets a present `null` through and that function then puts `{}`
 * in its place. Every other caller either refuses first or cannot produce one.
 *
 * Both halves of this were written down backwards for a commit, and a review
 * round caught them: that `copyDocument()` had "its nulls already dropped",
 * which is `copyValue()`, and that the condition is the one `set()` asks, which
 * it is not.
 *
 * @param into - The document to write into, which is modified.
 * @param from - The document to read the claimed values out of.
 * @param paths - The dotted paths that are the caller's.
 * @param where - The layer or file, for a message.
 * @throws If a path cannot mean anything, or a value cannot be copied.
 */
export function overlay(
	into: Record<string, unknown>,
	from: unknown,
	paths: Iterable<string>,
	where: string
): void {
	for (const path of paths) {
		const parts = segments(path);

		if (parts.length === 0) {
			continue;
		}

		const mine = readPath(from, parts);

		if (mine === undefined) {
			// a claimed **delete** whose ancestor is not an object is a no-op rather
			// than the refusal a claimed set gets, which is an asymmetry and is the
			// right way round: `deletePath()` has nothing to destroy, so it answers
			// `false` and the file keeps what it had. A set in the same place would
			// have to replace the ancestor to proceed, which is what it refuses for.
			// So `write({}, { paths: ['items.0'] })` over `{ "items": [1,2,3] }`
			// leaves the array alone while `write({ items: { 0: 9 } }, ...)` throws,
			// and that is the dotted-paths-address-object-keys rule said twice rather
			// than two answers to one question. `Config.delete()` is the same no-op
			// for the same reason. Found by review, which offered throwing as the
			// other option: it is refused because a delete that has nothing to delete
			// is a no-op everywhere else here
			deletePath(into, parts);
			continue;
		}

		// the ancestors, before anything is written: `writePath()` replaces a
		// non-object on the way down, which for an array is three elements gone
		let at: unknown = into;

		for (const [i, part] of parts.slice(0, -1).entries()) {
			at = isPlainObject(at) && Object.hasOwn(at, part) ? at[part] : undefined;

			// `null` is absent, because that is what it means everywhere in this
			// module -- and **both** callers can see one: `#staged` overlays a
			// `copyDocument()`, which keeps a key holding `null`, and the store
			// overlays the parsed file, where one survives too. So this is the rule
			// rather than a patch over a disagreement between them, which is what the
			// comment here claimed for a commit. Dropping them in the store is not
			// the answer either: it would drop a `null` the file holds for a key
			// nobody claimed, and `editJsonc` would then remove it
			if (at !== undefined && at !== null && !isPlainObject(at)) {
				throw new Error(__`"${parts.slice(0, i + 1).join('.')}" in ${where} is not an object`);
			}
		}

		writePath(into, parts, copyDocument(mine, where));
	}
}
