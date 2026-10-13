import { __ } from '../i18n/index.js';
import { deletePath, isPlainObject, readPath, segments, writePath } from './dotted.js';
import { copyValue, deepFreeze, mergeLayers } from './merge.js';
import { coerceLayer, concatPaths, defaultsOf, envOf, readSchema, type Setting } from './schema.js';
import type {
	ConfigDocument,
	ConfigLayer,
	ConfigLayerInfo,
	ConfigOptions,
	ConfigStore,
	Loss,
	WritableConfigStore,
} from './types.js';

/**
 * What the schema's defaults and the environment are called in a message.
 *
 * They are merged like a layer and are not one, so they need a name for the
 * one message the merge can produce -- the unsafe-key tripwire. Angle brackets
 * because an app names its own layers and these are not its to name.
 */
const DEFAULTS = '<schema defaults>';
const ENVIRONMENT = '<environment>';

/**
 * Whether a store will write.
 *
 * The type guard the two-interface split exists for: read-only is a *type* here
 * rather than a method that throws, so this is the one place the question is
 * asked and the answer narrows.
 *
 * @param store - The store.
 * @returns Whether it is writable.
 */
export function isWritableStore(store: ConfigStore): store is WritableConfigStore {
	const it = store as Partial<WritableConfigStore>;
	return typeof it.write === 'function' && typeof it.writeSync === 'function';
}

/** One layer, as this module holds it. */
interface Layer {
	readonly declared: ConfigLayer;
	readonly name: string;
	readonly readOnly: boolean;
	/** The layer's own value, which `set()` mutates and the merge reads. */
	value: Record<string, unknown>;
	readonly wouldLose?: readonly Loss[];
}

/**
 * One merged view over an ordered stack of layers.
 *
 * `get()` reads the merged view; `set()` and `delete()` mutate **one** layer,
 * because a merged value has no single home to write to. That is also why the
 * array methods exist at all: `get('x')` hands back a merged array, so mutating
 * it in place would be writing to a computed value rather than to a store --
 * and the merged view is frozen, so the attempt is loud rather than silent.
 *
 * ## The one precedence chain
 *
 * Written out as a single chain, which is the form this repository keeps for
 * every precedence rule it has: **a setting's environment variable, then the
 * layers from last to first, then the setting's `default`.**
 *
 * The environment is on top because a variable is a statement about one run and
 * a file is a persistent one, which is the same reading argv gets against the
 * environment one layer up. The default is underneath everything because it is
 * what the app ships rather than what anybody configured. Both are materialized
 * into the merge rather than consulted on a miss, so that `get('server')` holds
 * a defaulted `server.port` and there is one object to read.
 */
export class Config {
	/** The layers, bottom first, including nothing synthetic. */
	readonly #layers: Layer[];
	/** The merged view, rebuilt whenever a layer changes. */
	#merged: unknown;
	/** The schema's defaults, which sit under every layer. */
	readonly #defaults: Record<string, unknown>;
	/** The environment's values, which sit over every layer. */
	readonly #env: Record<string, unknown>;
	/** Whether a path's arrays concatenate. */
	readonly #concat: (path: string) => boolean;
	/** The settings, in declaration order. */
	readonly #settings: readonly Setting[];

	/**
	 * Builds a config from declarations and the documents their stores read.
	 *
	 * Every parameter is a **public** type, which is the whole reason the reading
	 * happens outside and the building happens here rather than the other way
	 * round. The first version took the built `Layer[]` and the read
	 * `Setting[]` -- both of them this module's own, neither exported -- so the
	 * published declaration held a constructor nobody could call, over two
	 * interfaces nobody could name. Found by reading the emitted `.d.mts` rather
	 * than the source, which is the only place it is visible.
	 *
	 * What that costs is that `readSchema()` and `assertLayers()` run twice: once
	 * in the entry point, so that a declaration which cannot mean anything is
	 * refused **before** any store is read -- which for a remote store is a
	 * network call -- and once here, because this has to be correct when called
	 * directly. Both are pure.
	 *
	 * @param opts - The schema, the layers, and the environment to read.
	 * @param docs - What each layer's store read, in the layers' own order.
	 */
	constructor(opts: ConfigOptions, docs: readonly (ConfigDocument | undefined)[]) {
		const declared = opts.layers ?? [];
		const settings = readSchema(opts.schema);
		assertLayers(declared);

		this.#layers = declared.map((layer, i) => layerOf(layer, docs[i], settings));
		this.#settings = settings;
		this.#concat = concatPaths(settings);
		this.#defaults = defaultsOf(settings);
		this.#env = envOf(settings, opts.env ?? process.env);
		this.#merged = undefined;
		this.#recompute();
	}

	/** What each layer is, for diagnostics. */
	get layers(): readonly ConfigLayerInfo[] {
		return this.#layers.map((layer) => ({
			format: layer.declared.store.format,
			name: layer.name,
			readOnly: layer.readOnly,
			source: layer.declared.store.source,
			wouldLose: layer.wouldLose,
		}));
	}

	/**
	 * Replaces a layer's content and recomputes the merged view.
	 *
	 * The same mechanism as construction, after construction -- which is what a
	 * reload is. An app that re-reads its own config, or that was handed a blob
	 * on the command line, hands the new object in.
	 *
	 * **Replace, not merge**, and that is the decision rather than a default. A
	 * merge *inside* a layer would be a second merge semantics sitting beside the
	 * cross-layer one, and the two would then have to agree about depth and about
	 * arrays -- where the cross-layer merge already has an answer. And it is
	 * unnecessary, which is the better half of the argument: **two objects that
	 * should merge are two layers.** The stack *is* the merge, it already works,
	 * and it already has the array rule.
	 *
	 * @param name - The layer.
	 * @param value - Its new content.
	 * @throws If there is no such layer, or the value is not an object, or a
	 * setting in it is not one the schema can hold.
	 */
	apply(name: string, value: unknown): void {
		const layer = this.#layer(name);

		if (!isPlainObject(value)) {
			// not translated: `apply()` is handed a value by the app
			throw new Error(`Cannot apply a value that is not an object to layer "${name}"`);
		}

		// copied and validated **before** anything is assigned, which is the order
		// `Show` keeps: build first and touch nothing until there is something to
		// put there. Which is also why there is no rollback around the recompute
		// below -- a `copyValue()` the coercion already ran cannot find an unsafe
		// key a second time, so nothing it could roll back for can happen, and a
		// guard that cannot fire is one this repository deletes
		const next = copyValue(value, name) as Record<string, unknown>;
		coerceLayer(next, this.#settings, name);
		layer.value = next;
		this.#recompute();
	}

	/**
	 * Removes a path from one layer.
	 *
	 * One layer, like every mutator, so `false` means *this* layer had nothing at
	 * that path -- and `get()` may still answer, from a layer underneath. Where
	 * that layer is **read-only** this throws instead, because there is nothing
	 * the caller can do about it from here; where it is writable they can name it,
	 * so the `false` is the signal rather than an error.
	 *
	 * @param path - The dotted path.
	 * @param name - The layer, or the topmost writable one.
	 * @returns Whether anything was removed from that layer.
	 * @throws If the path is not one a layer can hold, if there is no writable
	 * layer, or if the value lives in a read-only layer instead.
	 */
	delete(path: string, name?: string): boolean {
		const parts = this.#mutablePath(path, 'delete');
		const layer = this.#writable(name, path);

		if (readPath(layer.value, parts) === undefined) {
			// nothing here to remove, and the value is somewhere a delete cannot
			// reach -- which is worth saying rather than answering `false` and
			// leaving `get()` to contradict it
			const owner = this.#readOnlyOwner(parts);
			if (owner) {
				throw new Error(this.#cannotDelete(path, owner, layer));
			}
			return false;
		}

		// unconditionally, because `readPath()` said something is there and the two
		// agree by construction: both walk with `isPlainObject()` and `Object.hasOwn`
		// at every level, so a path one finds is one the other removes. An `if`
		// here was a guard that cannot be false
		deletePath(layer.value, parts);
		this.#recompute();
		return true;
	}

	/**
	 * Reads the merged view.
	 *
	 * The result is **deeply frozen**, because it is a computed value an app
	 * holds a live reference to: mutating it would change what a later `get()`
	 * answers while changing no layer, which is a value with no writer. An app
	 * that wants a mutable copy takes one with `structuredClone()`.
	 *
	 * @param path - The dotted path, or nothing for the whole view.
	 * @returns What is there, or `undefined`.
	 */
	get(path?: string): unknown {
		return readPath(this.#merged, segments(path));
	}

	/**
	 * Whether anything answers at a path.
	 *
	 * Exactly `get(path) !== undefined`, which is the one definition nobody has
	 * to remember two versions of -- and it is what makes the configured rule
	 * observable: a key absent and a key written `null` are both *not*
	 * configured, while a key written `""` is an empty string somebody chose, so
	 * this is `false`, `false` and `true`.
	 *
	 * It answers `true` for a key whose only source is a `default`, because
	 * `get()` does: what the app ships is configured as far as anything reading
	 * it is concerned.
	 *
	 * @param path - The dotted path.
	 * @returns Whether `get()` would answer.
	 */
	has(path: string): boolean {
		return this.get(path) !== undefined;
	}

	/**
	 * Removes the last value of an array in one layer.
	 *
	 * @param path - The dotted path.
	 * @param name - The layer, or the topmost writable one.
	 * @returns The value removed, or `undefined`.
	 */
	pop(path: string, name?: string): unknown {
		return this.#spliceEnd(path, name, 'pop');
	}

	/**
	 * Appends to an array in one layer.
	 *
	 * It appends to **that layer's** array rather than to the merged one, and
	 * that is the array rule said once rather than twice: with
	 * `merge: 'concat'` the result reads as appending to the merged list, and
	 * with the default `replace` it appends to this layer's own list, which then
	 * replaces what is underneath. Seeding from the merged value instead would
	 * copy a lower layer's values into this one -- after which a change to the
	 * defaults never reaches the user again.
	 *
	 * One value per call rather than a variadic list, so that every mutator has
	 * one shape: a path, maybe a value, maybe a layer. A trailing layer name and
	 * a trailing string value cannot be told apart.
	 *
	 * @param path - The dotted path.
	 * @param value - The value to append.
	 * @param name - The layer, or the topmost writable one.
	 * @returns The new length of that layer's array.
	 */
	push(path: string, value: unknown, name?: string): number {
		return this.#spliceAdd(path, value, name, 'push');
	}

	/**
	 * Writes a value into one layer.
	 *
	 * @param path - The dotted path.
	 * @param value - The value.
	 * @param name - The layer, or the topmost writable one.
	 * @throws If the path is not one a layer can hold, if there is no writable
	 * layer, if the store cannot represent the value, or if the schema cannot.
	 */
	set(path: string, value: unknown, name?: string): void {
		const parts = this.#mutablePath(path, 'set');
		const layer = this.#writable(name, path);

		this.#assertRepresentable(layer, path, value);

		// `null` is "not configured", which is the rule `copyValue()` keeps for a key
		// inside a document -- so writing one is `delete()` said another way rather
		// than a value, and the alternative is a `set()` whose result a re-read of
		// the same file would not reproduce
		if (value === null) {
			this.delete(path, name);
			return;
		}

		const before = readPath(layer.value, parts);
		this.#assertWritable(layer, parts);
		const next = copyValue(value, layer.name);
		writePath(layer.value, parts, next);

		this.#settle(layer, parts, before);
	}

	/**
	 * Removes the first value of an array in one layer.
	 *
	 * @param path - The dotted path.
	 * @param name - The layer, or the topmost writable one.
	 * @returns The value removed, or `undefined`.
	 */
	shift(path: string, name?: string): unknown {
		return this.#spliceEnd(path, name, 'shift');
	}

	/**
	 * Prepends to an array in one layer.
	 *
	 * @param path - The dotted path.
	 * @param value - The value to prepend.
	 * @param name - The layer, or the topmost writable one.
	 * @returns The new length of that layer's array.
	 */
	unshift(path: string, value: unknown, name?: string): number {
		return this.#spliceAdd(path, value, name, 'unshift');
	}

	/** Refuses a value the layer's store says its format cannot hold. */
	#assertRepresentable(layer: Layer, path: string, value: unknown): void {
		const { store } = layer.declared;
		const answer = store.canRepresent?.(value, path);

		if (answer !== undefined && answer !== true) {
			throw new Error(__`${layer.name} cannot hold the value at "${path}": ${answer}`);
		}
	}

	/** The message a read-only `delete()` prints, which names both ways out. */
	#cannotDelete(path: string, owner: Layer, target: Layer): string {
		const where = owner.declared.store.source ?? owner.name;
		const here = target.declared.store.source ?? target.name;

		// one key rather than three, because the shape is the translator's: a
		// sentence per line would hand them three fragments and no way to reorder
		// them, which is what the i18n work already refuses for a suggestion
		return __`Cannot delete "${path}": it is set in ${owner.name}, which is read-only.
  Set it in ${here} to override the value, or
  remove it from ${where}.`;
	}

	/** The layer of a name, or a throw naming what there is. */
	#layer(name: string): Layer {
		const layer = this.#layers.find((it) => it.name === name);

		if (!layer) {
			// not translated: a layer name is the app's own, so naming one that is
			// not there is a bug in the app rather than anything a user did
			throw new Error(
				`Unknown config layer "${name}". There is ${
					this.#layers.length === 0
						? 'no layer at all'
						: `${this.#layers.map((it) => `"${it.name}"`).join(', ')}`
				}.`
			);
		}

		return layer;
	}

	/** A path a mutator may use, refusing the one `apply()` is for. */
	#mutablePath(path: string, what: string): string[] {
		const parts = segments(path);

		if (parts.length === 0) {
			// not translated: calling a mutator with no path is the app's mistake
			throw new Error(`Cannot ${what} without a path; use apply() to replace a layer.`);
		}

		return parts;
	}

	/**
	 * Refuses a write whose way down runs through something that is not an
	 * object.
	 *
	 * `writePath()` **replaces** such a thing, which for a scalar is defensible
	 * -- a layer whose `server` is `"off"` has no `server.port` to set -- and for
	 * an array is silent data loss: `set('items.0', 9)` over `[1, 2, 3]` left
	 * `{ "0": 9 }` and the list was gone. Measured, and found by review.
	 *
	 * Refused rather than special-cased for arrays, because one rule is easier to
	 * be sure of than two and because the two halves disagree either way:
	 * `readPath()` does not walk an array, so `get('items.0')` is `undefined`
	 * until a `set()` has already destroyed the list, and `push`/`pop` treat the
	 * same path as a list. A dotted path addresses object keys, and the array
	 * methods are how a list is changed.
	 *
	 * @param layer - The layer being written.
	 * @param parts - The path.
	 * @throws If an ancestor of the path is not an object.
	 */
	#assertWritable(layer: Layer, parts: readonly string[]): void {
		let at: unknown = layer.value;

		for (const [i, part] of parts.slice(0, -1).entries()) {
			at = isPlainObject(at) && Object.hasOwn(at, part) ? at[part] : undefined;
			if (at !== undefined && !isPlainObject(at)) {
				throw new Error(__`"${parts.slice(0, i + 1).join('.')}" in ${layer.name} is not an object`);
			}
		}
	}

	/**
	 * Validates the **whole** layer after a mutation and recomputes, putting the
	 * one path back if either is refused.
	 *
	 * The whole layer rather than the setting at the written path, and that is a
	 * hole rather than a cost: a path can be *inside* a declared setting or
	 * *outside* one that is declared under it, and a mutation that looked at its
	 * own path alone missed both. Measured, with a schema of
	 * `{ server: { type: 'string' } }`, `set('server.port', 1)` left
	 * `{ server: { port: 1 } }` on the layer -- which `createConfig()` would have
	 * refused outright -- and with `{ 'a.b': { type: 'int' } }`,
	 * `set('a', { b: 'nope' })` put the string on an `int` setting. Either way a
	 * `set()` could leave a layer in a state the load path says is impossible,
	 * which is the worst shape a validation hole has: the next run of the same app
	 * over the same file refuses to start.
	 *
	 * So there is one validation pass and `apply()` already ran it, which is what
	 * makes this hole-free by construction rather than by a rule about which
	 * settings a path touches. What it costs is a path read per declared setting
	 * per mutation, which for a config is a handful of lookups.
	 *
	 * Restoring one path is enough even though the pass rewrites every setting it
	 * validates, because `coerceSetting()` is idempotent: a coerced value coerces
	 * to itself, and a `null` that was dropped is absent on the second pass. So a
	 * run that threw part way through has changed nothing but the path being put
	 * back.
	 *
	 * @param layer - The layer that was mutated.
	 * @param parts - The path that was written.
	 * @param before - What that path held, for the rollback.
	 * @throws If the layer is no longer one the schema or the merge can hold.
	 */
	#settle(layer: Layer, parts: readonly string[], before: unknown): void {
		try {
			coerceLayer(layer.value, this.#settings, layer.name);
			// the recompute is inside the guard rather than after it, and this is
			// one statement's placement rather than any code -- which is why it is
			// here although nothing can currently reach it. `copyValue()`'s
			// unsafe-key refusal is a tripwire the coercion sites above reach first,
			// so the merge cannot throw today; the day a fourth door is added and it
			// can, a throw with the recompute outside leaves the layer holding what
			// it had just written, after which every later mutation throws again
			// over a value nobody can see. A declared survivor of the sabotage pass,
			// kept for the reason `clipboardSequence()`'s own tripwire is: it costs
			// nothing and the failure it is for is unrecoverable
			this.#recompute();
		} catch (e: unknown) {
			// the layer is put back before the throw escapes, because a mutation that
			// failed must not leave half of itself behind -- the rule `Show` and
			// `For` already keep about a branch that threw. Back to what was there
			// rather than to nothing: a refused `set()` over an existing value must
			// not be a `delete()`
			this.#restore(layer, parts, before);
			throw e;
		}
	}

	/**
	 * Puts a path back to what it held, which is what a refused mutation owes.
	 *
	 * Deleting rather than writing `undefined` where there was nothing, because
	 * `deletePath()` prunes the objects the write made on its way down -- without
	 * which a refused `set('a.b.c', ...)` leaves `{ a: { b: {} } }` behind, and an
	 * empty object is a difference the merged view can see.
	 */
	#restore(layer: Layer, parts: readonly string[], before: unknown): void {
		if (before === undefined) {
			deletePath(layer.value, parts);
		} else {
			writePath(layer.value, parts, before);
		}
	}

	/** Rebuilds the merged view from the layers, the defaults and the environment. */
	#recompute(): void {
		this.#merged = deepFreeze(
			mergeLayers(
				[
					{ label: DEFAULTS, value: this.#defaults },
					...this.#layers.map((layer) => ({ label: layer.name, value: layer.value })),
					{ label: ENVIRONMENT, value: this.#env },
				],
				this.#concat
			)
		);
	}

	/** The topmost read-only layer that holds a path, if one does. */
	#readOnlyOwner(parts: readonly string[]): Layer | undefined {
		for (let i = this.#layers.length - 1; i >= 0; i--) {
			const layer = this.#layers[i] as Layer;
			if (layer.readOnly && readPath(layer.value, parts) !== undefined) {
				return layer;
			}
		}
		return undefined;
	}

	/** `push` and `unshift`, which differ by one method name. */
	#spliceAdd(
		path: string,
		value: unknown,
		name: string | undefined,
		what: 'push' | 'unshift'
	): number {
		const parts = this.#mutablePath(path, what);
		const layer = this.#writable(name, path);

		this.#assertRepresentable(layer, path, value);

		const at = readPath(layer.value, parts);
		// a path this layer has nothing at becomes a list, which is what makes a
		// first `push` work on a layer that has never held one. A path holding
		// something that is not an array is refused rather than replaced: that is a
		// value somebody set, and turning it into a one-element list is not what
		// either method means
		if (at !== undefined && !Array.isArray(at)) {
			throw new Error(__`"${path}" in ${layer.name} is not a list`);
		}

		this.#assertWritable(layer, parts);

		const list = at === undefined ? [] : [...(at as unknown[])];
		const next = copyValue(value, layer.name);
		if (what === 'push') {
			list.push(next);
		} else {
			list.unshift(next);
		}

		writePath(layer.value, parts, list);

		this.#settle(layer, parts, at);
		return (readPath(layer.value, parts) as unknown[]).length;
	}

	/** `pop` and `shift`, which differ by one method name. */
	#spliceEnd(path: string, name: string | undefined, what: 'pop' | 'shift'): unknown {
		const parts = this.#mutablePath(path, what);
		const layer = this.#writable(name, path);
		const at = readPath(layer.value, parts);

		if (at === undefined) {
			return undefined;
		}

		if (!Array.isArray(at)) {
			throw new Error(__`"${path}" in ${layer.name} is not a list`);
		}

		const list = [...(at as unknown[])];
		const removed = what === 'pop' ? list.pop() : list.shift();
		writePath(layer.value, parts, list);
		this.#recompute();
		return removed;
	}

	/** The layer a mutator writes to, or a throw saying there is none. */
	#writable(name: string | undefined, path: string): Layer {
		if (name !== undefined) {
			const layer = this.#layer(name);
			if (layer.readOnly) {
				// not translated: naming a layer is the app's own call, so naming a
				// read-only one is a bug in its source rather than anything a user did
				throw new Error(`Cannot write "${path}": layer "${layer.name}" is read-only.`);
			}
			return layer;
		}

		// the topmost writable layer, because the stack is ordered and the top is
		// what wins: writing to a lower one means `get()` does not change, which is
		// a mutation that looks like it did nothing
		for (let i = this.#layers.length - 1; i >= 0; i--) {
			const layer = this.#layers[i] as Layer;
			if (!layer.readOnly) {
				return layer;
			}
		}

		// not translated: a config with no writable layer is one the app built that
		// way, and the fix is in its own source -- an `object()` layer on top is
		// the in-memory override every other answer to this reduces to
		throw new Error(
			'No writable config layer. Add one with `{ name, store: object() }`, which is the in-memory override layer.'
		);
	}
}

/**
 * Turns one store's document into a layer, which is the half both entry points
 * share.
 *
 * The reads themselves are two real implementations and this is the one thing
 * between them, which is the shape `ConfigStore` asks of every store it
 * describes: two different I/O calls over one shared parse, with nothing
 * pretending to be anything.
 *
 * @param layer - The declared layer.
 * @param doc - What its store read.
 * @param settings - The schema.
 * @returns The layer.
 * @throws If the document is not something a layer can hold, or a setting in it
 * is not one the schema can hold.
 */
function layerOf(
	layer: ConfigLayer,
	doc: ConfigDocument | undefined,
	settings: readonly Setting[]
): Layer {
	// `null` is the other way a format says nothing, which is the same reading a
	// `null` at a setting's own path gets
	const read = doc?.value ?? {};

	if (!isPlainObject(read)) {
		// not translated: a store that answers with something a layer cannot hold is
		// a bug in that store's own source
		throw new Error(`Layer "${layer.name}" read a value that is not an object`);
	}

	const value = copyValue(read, layer.name) as Record<string, unknown>;
	coerceLayer(value, settings, layer.name);

	return {
		declared: layer,
		name: layer.name,
		readOnly: layer.readOnly === true || !isWritableStore(layer.store),
		value,
		wouldLose: doc?.wouldLose,
	};
}

/**
 * Refuses a layer declaration that cannot mean anything, before its store is
 * asked for anything.
 *
 * Not translated: a layer is the app's own declaration, so a bad one is a bug
 * report rather than something a user did.
 *
 * @param declared - The declared layers.
 * @throws If a declaration cannot mean anything.
 */
function assertLayers(declared: readonly ConfigLayer[]): void {
	const names = new Set<string>();

	for (const layer of declared) {
		if (!layer || typeof layer !== 'object') {
			throw new Error('A config layer must be an object');
		}
		if (typeof layer.name !== 'string' || !layer.name) {
			throw new Error('A config layer must have a name');
		}
		if (names.has(layer.name)) {
			// two layers of one name makes `set(path, value, name)` ambiguous and
			// makes every message about one of them wrong about the other
			throw new Error(`Duplicate config layer "${layer.name}"`);
		}
		names.add(layer.name);

		const { store } = layer;
		if (!store || typeof store.read !== 'function' || typeof store.readSync !== 'function') {
			throw new Error(`Config layer "${layer.name}" needs a store with read() and readSync()`);
		}
	}
}

/**
 * Builds a config from an ordered stack of layers.
 *
 * Async at load, synchronous at every accessor. What could force an async
 * accessor was enumerated rather than assumed, and the answer is a store's own
 * `read()` -- for a remote store somebody else writes -- which happens **once,
 * here**, rather than per `get()`: an async `get()` would be a promise per read
 * of data already in memory.
 *
 * Lazy layer creation is the one thing an async `set()` would buy and it is
 * refused: a `set()` targets a layer that is already registered, and
 * registration is this function's. The *file* need not exist -- `save()`, which
 * is SIG-154's and is not in this ticket, creates it -- so the reason config-kit
 * forces async does not arise here.
 *
 * @param opts - The schema, the layers, and the environment to read.
 * @returns The config.
 */
export async function createConfig(opts: ConfigOptions = {}): Promise<Config> {
	const declared = opts.layers ?? [];

	// refused before any store is read, which for a remote one is a network call.
	// The constructor asks again, because it has to be right when called directly
	readSchema(opts.schema);
	assertLayers(declared);

	const docs: ConfigDocument[] = [];
	for (const layer of declared) {
		docs.push(await layer.store.read());
	}

	return new Config(opts, docs);
}

/**
 * Builds a config without awaiting anything.
 *
 * Beside the async one rather than instead of it, and it has the stronger case
 * of the two: an exit or signal handler **cannot await**, which is the same
 * reason `Terminal.syncRestore()` exists, and "read the config on the way in
 * and write it on the way out" is that shape exactly. Every core store
 * implements both halves, so both entry points work and nothing branches.
 *
 * The two are two real implementations of one loop rather than this one
 * wrapping the other, for the reason the store interface gives for its own two
 * halves: a synchronous entry point that awaited an already-resolved promise
 * would not be synchronous -- `then()` runs on a later microtask whatever the
 * promise holds -- so there is no shape where one of these can be written in
 * terms of the other.
 *
 * @param opts - The schema, the layers, and the environment to read.
 * @returns The config.
 */
export function createConfigSync(opts: ConfigOptions = {}): Config {
	const declared = opts.layers ?? [];

	readSchema(opts.schema);
	assertLayers(declared);

	return new Config(
		opts,
		declared.map((layer) => layer.store.readSync())
	);
}
