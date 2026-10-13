import type { DataType } from '../types.js';

/**
 * Trivia a document holds that **this store** could not carry through a write.
 *
 * Empty for a span store even over a comment-rich file, because it edits rather
 * than reprints; populated by a store that reprints what it parsed. What to do
 * about it is the config's, which is the lossless rule.
 */
export interface Loss {
	/**
	 * What kind of thing would go.
	 *
	 * Open rather than a closed union, because a format this package has never
	 * heard of has trivia this package cannot enumerate -- an XML processing
	 * instruction, a YAML anchor, a TOML table header. The four named here are
	 * the ones a reader can be expected to recognise.
	 */
	kind: 'comment' | 'anchor' | 'formatting' | 'declaration' | (string & {});
	/** Where it is, for a message that can point at it. */
	line?: number;
	/** What it is, for a message that can show it. */
	detail?: string;
}

/** What a store hands back, and what a layer is built from. */
export interface ConfigDocument {
	/**
	 * The parsed value.
	 *
	 * Already typed -- a JSON or YAML store resolves scalars, so this holds
	 * `true` and `8080` rather than `"true"` and `"8080"`. A format with no
	 * scalar kind but a string hands strings back and `checkValue()` coerces
	 * them, which is why there is no flag here saying which kind of store this
	 * came from.
	 */
	value: unknown;
	/** What this store could not carry through a write, if anything. */
	wouldLose?: readonly Loss[];
}

/**
 * A layer's backing store: a codec plus I/O, holding nothing but whatever
 * source text it needs in order to edit.
 *
 * **Public API** rather than an internal seam -- it is what a sibling package
 * implements and what an app writing its own store implements. Which is what
 * makes it worth drawing whole rather than letting it fall out of whichever
 * store was written first, for a reason about *variance* rather than about
 * version numbers: adding an optional parameter to a function **callers** use
 * is backwards-compatible, while adding a required method to an interface
 * **implementors** write is breaking for every one of them and cannot be
 * softened by a default. So the cost of being wrong is paid by somebody else's
 * package.
 *
 * ## Both halves are required
 *
 * `read()` and `readSync()` are **two real implementations** over one shared
 * parser rather than one wrapping the other:
 *
 * ```ts
 * async read() { return this.#parse(await readFile(this.#path, 'utf8')); }
 * readSync()   { return this.#parse(readFileSync(this.#path, 'utf8')); }
 * ```
 *
 * Two earlier shapes of this were wrong in opposite directions. Making `read()`
 * required and having a synchronous store write
 * `async read() { return this.readSync(); }` is a store lying about itself to
 * satisfy a signature. Making both optional, with the presence of `readSync()`
 * as the capability, moves the lie into a ternary at **every call site** --
 * `store.readSync ? store.readSync() : await store.read()` -- which is honest
 * and leaks into every caller that ever grows one. Both existed to accommodate
 * exactly one store kind, a `.js` layer, where `import()` leaves no choice; that
 * layer is gone and an object layer took its place, so every store can do both
 * and there is no optionality, no union, no ternary and no wrapper.
 *
 * A third-party store that genuinely cannot do sync -- a remote one -- throws
 * from `readSync()` with its own message saying so. That is strictly better than
 * the optional shape: the failure is localized to the store that has it and
 * worded by the author who knows why, and no caller branches.
 */
export interface ConfigStore {
	/**
	 * Whether a value this format cannot represent is refused where it was
	 * written rather than discovered at `save()`.
	 *
	 * **Synchronous on purpose**, because `set()` is: a format that cannot hold
	 * what it was handed should say so at the call that wrote it, naming the
	 * layer and the format. TOML is the case this exists for -- it has no `null`
	 * at all, in 1.0 or in 1.1, with the question deferred to 1.2 or later -- and
	 * it is what makes "I am read-only" and "I cannot hold that" two answers
	 * rather than one. An interface with only the first makes the second surface
	 * as a corrupt file.
	 *
	 * @param value - The value about to be written.
	 * @param path - The dotted path it is being written to, for the message.
	 * @returns `true`, or a sentence saying why not.
	 */
	canRepresent?(value: unknown, path: string): true | string;
	/** For diagnostics: `'json'`, `'jsonc'`, `'object'`, `'xml'`, `'yaml'`. */
	readonly format: string;
	/** Reads the document. */
	read(): Promise<ConfigDocument>;
	/** Reads the document without awaiting anything. */
	readSync(): ConfigDocument;
	/**
	 * Where this store reads from, for diagnostics: a path, a URL, or nothing
	 * where there is no such place.
	 *
	 * Here rather than left to the layer's name because the message a read-only
	 * `delete()` has to print names two paths -- the one to write instead and the
	 * one to edit by hand -- and a layer name is what the app chose to call it,
	 * which is not a file a user can open.
	 */
	readonly source?: string;
}

/**
 * A store that will write.
 *
 * The first of a store's two refusals is **a separate interface** rather than a
 * method that throws: a read-only store is not one, so read-only is something
 * TypeScript enforces and a type guard narrows.
 *
 * Both halves again, for the reason `read()` and `readSync()` are both
 * required: `Config.save()` is async because a remote store's write is, and
 * `Config.saveSync()` exists because an exit or signal handler cannot await --
 * which is "read the config on the way in and write it on the way out", the
 * shape `Terminal.syncRestore()` is already written for.
 *
 * A `write()` is handed the **whole** value the layer should hold rather than a
 * list of changes, which is what lets a store choose how to get there: the JSON
 * stores diff it against the bytes they already hold and splice, where a store
 * with no editing model reprints and says so through `wouldLose`.
 */
export interface WritableConfigStore extends ConfigStore {
	/** Persists a value. */
	write(value: unknown, opts?: WriteOptions): Promise<void>;
	/** Persists a value without awaiting anything. */
	writeSync(value: unknown, opts?: WriteOptions): void;
}

/**
 * How to write.
 *
 * `Config.save()` takes the same shape, because what it does with `lossy` is
 * decide whether to call `write()` at all and then hand it straight on -- so a
 * second type would be the same field under a second name.
 */
export interface WriteOptions {
	/**
	 * Whether to write even where this store reported it would lose something.
	 *
	 * The opt-in half of the lossless rule, which is
	 * `clipboardSequence()`'s one subsystem along: over the cap that refuses by
	 * default and truncates only when asked, because sending and hoping is the
	 * one answer that cannot be observed. A config file quietly stripped of its
	 * comments is the same failure with a slower fuse -- the user finds out next
	 * time they open the file -- so the refusal is visible and this is the
	 * deliberate other half, exactly as `truncate: true` is there.
	 *
	 * Read by `save()`, which asks it of the **document** rather than of the
	 * store: a store that reprints and a file with no trivia in it lose nothing
	 * between them, and refusing that write would be a guard firing on correct
	 * code.
	 */
	lossy?: boolean;
}

/**
 * How a key's values combine across layers.
 *
 * `replace` is the default and is the less surprising of the two: a user
 * writing `exclude: [...]` in their own file means "this is my list", not
 * "append mine to whatever shipped". `concat` has no ordering or
 * de-duplication story without further decisions, so defaulting to it would
 * import those decisions silently -- it is opt-in per key, and it concatenates
 * in stack order, bottom first, without de-duplicating.
 */
export type ConfigMerge = 'concat' | 'replace';

/** One setting, declared by dotted path. */
export interface ConfigSetting {
	/** The values this setting accepts, if it is not open. */
	choices?: readonly unknown[];
	/**
	 * What `get()` answers when no layer and no environment variable did.
	 *
	 * Materialized into the bottom of the merged view rather than consulted on a
	 * miss, so that `get('server')` holds a defaulted `server.port` and there is
	 * one merged object rather than a merge plus a fallback chain beside it.
	 */
	default?: unknown;
	/** A one-line description, for an app that lists its own settings. */
	desc?: string;
	/**
	 * Environment variables that fill this setting, tried in order.
	 *
	 * Read by `envValue()`, which is the parser's own rule from the parser's own
	 * module: `PORT=` is unset, while `PORT=0` and `PORT=' '` are values. Two
	 * readers of one question, which is why there is one function.
	 */
	env?: readonly string[] | string;
	/** How this key's values combine across layers. */
	merge?: ConfigMerge;
	/** Whether this setting holds a list. */
	multiple?: boolean;
	/** The data type, in the parser's own vocabulary. `string` when omitted. */
	type?: DataType;
}

/**
 * A config schema: settings keyed by dotted path.
 *
 * Config's own schema rather than the CLI schema -- the parser declares options
 * and arguments, config declares settings, and both mean the same thing by
 * `int`, by `bool` and by a `choices` list because both go through
 * `transformValue()` and `assertChoices()`.
 *
 * What it does not give is nested object shapes, whole-subtree requiredness or
 * `oneOf`. For CLI config that is probably not missed, and saying so is better
 * than a half-built JSON Schema.
 */
export type ConfigSchema = Record<string, ConfigSetting>;

/** One layer of the stack. */
export interface ConfigLayer {
	/** What to call it, in messages and in `set(path, value, layer)`. */
	name: string;
	/**
	 * Whether this layer may be written even though its store could be.
	 *
	 * The second of the two read-only statements, and a different one from the
	 * store's: a store that is not a `WritableConfigStore` says "this format
	 * cannot be written", and this says "this one is not mine to write" -- an
	 * `/etc` file an app reads and must not touch. Both are real, so both are
	 * expressible.
	 */
	readOnly?: boolean;
	/**
	 * Whether a write to this layer may lose what its store cannot carry.
	 *
	 * The per-**layer** half of the lossless rule, for the legitimate case: this
	 * file is generated, so clobber it freely. Per **call** is
	 * `save(name, { lossy: true })`, which is the escape hatch and is where
	 * `truncate` already sits on the clipboard rather than on a config object.
	 *
	 * There is deliberately no global setting, because a global "allow
	 * clobbering" is set once in a scaffold and never thought about again, which
	 * defeats it.
	 */
	lossy?: boolean;
	/** The backing store. */
	store: ConfigStore;
}

/** What a layer looks like from outside, for diagnostics. */
export interface ConfigLayerInfo {
	/**
	 * Whether this layer has changes `save()` has not written.
	 *
	 * The set-then-exit hazard made observable rather than only documented: a
	 * `set()` mutates its layer in memory and `save()` persists, so an app that
	 * sets and exits loses the write -- and an app that wants to warn about one,
	 * or to ask before discarding, needs this to ask. It is also what makes the
	 * tracking testable without reaching into a private field, which is the
	 * decider: a mechanism with no observable is one a test cannot pin.
	 */
	readonly dirty: boolean;
	/** The store's format. */
	readonly format: string;
	/** The layer's name. */
	readonly name: string;
	/** Whether `set()` may target it. */
	readonly readOnly: boolean;
	/** Where the store reads from, if anywhere. */
	readonly source?: string;
	/** What the store said it could not carry through a write. */
	readonly wouldLose?: readonly Loss[];
}

/** What `createConfig()` takes. */
export interface ConfigOptions {
	/**
	 * The environment to read a setting's `env` from.
	 *
	 * `process.env` when omitted. An option rather than a constant for the reason
	 * `ParseState.env` is one: it is the only way a test can ask what a variable
	 * does without setting one on the process every other test in the worker
	 * shares.
	 */
	env?: Record<string, string | undefined>;
	/**
	 * The layers, bottom first.
	 *
	 * Later layers win, which is array order read the way document order is paint
	 * order everywhere else here: the last entry is on top.
	 */
	layers?: readonly ConfigLayer[];
	/** The settings, by dotted path. */
	schema?: ConfigSchema;
}
