import { __ } from '../../i18n/index.js';
import { expand } from '../../paths.js';
import { isMissing, writeAtomic, writeAtomicSync } from '../atomic.js';
import { DEFAULT_STEP, editJsonc } from '../jsonc-write.js';
import { parseJsonc } from '../jsonc.js';
import { overlay } from '../merge.js';
import { jsonCanHold } from '../represent.js';
import type { ConfigDocument, WritableConfigStore, WriteOptions } from '../types.js';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * A store over a file, in one of the two JSON flavours.
 *
 * `read()` and `readSync()` are two real implementations over one shared parse
 * rather than one wrapping the other, which is what the interface asks for and
 * is why there is no optionality anywhere in it:
 *
 * ```ts
 * async read() { return parse(await readFile(path, 'utf8')); }
 * readSync()   { return parse(readFileSync(path, 'utf8')); }
 * ```
 *
 * That is the shape rather than the lines: each half really does its own I/O
 * call and both go through one `parse()`, and what the lines below add around it
 * is the `ENOENT` reading -- which is the same reading twice because a `catch`
 * cannot be shared between an `await` and a synchronous call.
 *
 * The path is expanded through `paths.expand()` rather than taken literally. A
 * `~` is the single most likely thing an app writes by hand, and `readFileSync`
 * of one is an `ENOENT` naming a path with a `~` still in it -- which reads as
 * "the file is missing" rather than "the `~` was not expanded". One
 * implementation of that rule, which is the one `paths.ts` already holds; on
 * Windows it expands `%VAR%` too, for the same reason.
 *
 * @param path - The file.
 * @param jsonc - Whether comments and trailing commas are allowed.
 * @returns The store.
 */
function fileStore(path: string, jsonc: boolean): WritableConfigStore {
	// refused here rather than at the read, because what the read says about it
	// names the wrong thing: `expand('')` is `'.'`, so an empty path reported
	// `Failed to read .: EISDIR` -- a message about a directory nobody named --
	// and a path that is not a string threw out of `expand()` itself. Not
	// translated: a store's path is the app's own
	if (typeof path !== 'string' || !path) {
		throw new Error('A config file store needs a path');
	}

	// a format conversion that **cannot** preserve is refused where the layer is
	// built rather than at `save()`, which is the rule that what is decidable
	// statically fails the build rather than the frame. `.jsonc` is an extension
	// whose only purpose is to say "comments are allowed here", so the strict
	// store over one is a declaration that contradicts itself -- and the guard
	// cannot fire on code that is right, because `jsonc()` reads everything
	// `json()` reads and more, so there is no file for which `json('x.jsonc')` is
	// the better spelling.
	//
	// The reverse is **not** refused, and that asymmetry is the point:
	// `tsconfig.json` is JSONC under a `.json` name, so an extension that does
	// not claim comments says nothing about whether a file holds them
	if (!jsonc && /\.jsonc$/i.test(path)) {
		throw new Error(
			`json("${path}") cannot preserve what a .jsonc file is for: use jsonc() instead.`
		);
	}

	const source = expand(path);
	const format = jsonc ? 'jsonc' : 'json';

	/** What the file holds, or nothing where it is not there. */
	const text = async (): Promise<string | undefined> => {
		try {
			return await readFile(source, 'utf8');
		} catch (e: unknown) {
			if (!isMissing(e)) {
				throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
			}
			return undefined;
		}
	};

	/** The same, without awaiting. */
	const textSync = (): string | undefined => {
		try {
			return readFileSync(source, 'utf8');
		} catch (e: unknown) {
			if (!isMissing(e)) {
				throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
			}
			return undefined;
		}
	};

	const parse = (text: string | undefined): ConfigDocument => {
		// a file that is there and holds nothing but whitespace is a file somebody
		// created and has not written yet, which is the same state as one that is
		// not there -- `JSON.parse('')` is a syntax error, and reporting one over
		// `touch config.json` would be refusing to start over an empty file
		if (text === undefined || !text.trim()) {
			return { value: {} };
		}

		const { value } = parseJsonc(text, jsonc, source);

		// a document's root has to be something a layer can merge, which is an
		// object. A file holding `42` or `[1, 2]` is not a config, and merging it
		// would make every key of every layer below it vanish -- so it is refused
		// where it was read rather than discovered as a missing setting later
		if (typeof value !== 'object' || value === null || Array.isArray(value)) {
			throw new Error(__`${source} must hold an object`);
		}

		// `wouldLose` is **absent** even over a comment-rich file -- the field is
		// optional, so nothing lost is no field rather than `[]`, which is what
		// `layer.wouldLose?.length` is the way to read. That is the contract rather
		// than an omission: this store edits spans rather than reprinting, so a
		// comment survives a write because the bytes holding it are never rewritten.
		// A store that reprints -- YAML, XML -- reports what it would drop, and the
		// field is published for those
		return { value };
	};

	/**
	 * What the file should hold: whatever it holds now, with the claimed paths of
	 * `value` written over it.
	 *
	 * A write with no claim is total, which is the only thing `write(value)` can
	 * mean on its own and is what a caller reaching a store directly means. A
	 * write **with** one is the three-way merge `save()` exists to perform: the
	 * read it staged against may be stale by the time this runs, so the paths are
	 * applied to what is there now and every other key is left alone. Without it
	 * a key another process changed in that window is reverted -- any key, not
	 * only one this process touched -- which is the defect `WriteOptions.paths`
	 * is written for.
	 *
	 * @param theirs - What the file holds, which is modified.
	 * @param value - What the caller is writing.
	 * @param paths - The caller's own paths, or nothing for all of them.
	 * @returns The document to write.
	 */
	const claim = (
		theirs: Record<string, unknown>,
		value: unknown,
		paths: readonly string[] | undefined
	): unknown => {
		if (paths === undefined) {
			return value;
		}

		overlay(theirs, value, paths, source);
		return theirs;
	};

	/**
	 * The text the file should hold, given what it holds now.
	 *
	 * The edit is computed before anything is written, which is what makes a
	 * refusal cost nothing: a value JSON cannot hold, or a source that will not
	 * parse, throws with the file untouched.
	 */
	const render = (
		now: string | undefined,
		value: unknown,
		paths: readonly string[] | undefined
	): string => {
		// nothing to edit against, so there is nothing to preserve: a file that is
		// not there, or one somebody created and has not written yet, is serialized
		// from scratch with a final newline, which is what every other tool leaves
		// behind and what a POSIX text file is. A claimed set of paths over no file
		// is those paths and nothing else, which falls out of overlaying onto an
		// empty document rather than needing a case of its own
		const fresh = now === undefined || !now.trim();
		const held = claim(
			fresh ? {} : (parse(now as string).value as Record<string, unknown>),
			value,
			paths
		);

		// asked here as well as at `set()`, because this is public API and a
		// `write()` a caller made directly has had nothing checked. `set()`'s own
		// call is the *early* answer -- it names the one value and the one path at
		// the moment they were written -- and this one answers for the document.
		// Asked of the **merged** document rather than of `value`, or a part of
		// `value` this write is not claiming would refuse a write that never
		// touches it
		const ok = jsonCanHold(held, '');
		if (ok !== true) {
			throw new Error(`Cannot write ${source}: ${ok}`);
		}

		if (fresh) {
			return `${JSON.stringify(held, null, DEFAULT_STEP)}\n`;
		}

		return editJsonc(now as string, held, { allow: jsonc, what: source });
	};

	return {
		canRepresent(value: unknown, at: string): true | string {
			return jsonCanHold(value, at);
		},
		format,
		async read(): Promise<ConfigDocument> {
			return parse(await text());
		},
		readSync(): ConfigDocument {
			return parse(textSync());
		},
		source,
		async write(value: unknown, opts?: WriteOptions): Promise<void> {
			// the current bytes, read here rather than kept from the last `read()`.
			// A cache would be the faster shape and this is the correct one, and the
			// first reason written down for it was wrong: a stale cache does not
			// splice at the wrong offsets, because the edits are computed against
			// the same text they are applied to and the result is written whole. What
			// it does is overwrite blindly. Reading here is what makes this **the**
			// read the merge is against -- `claim()` applies the caller's paths to
			// what is there now, so the read and the merge cannot come apart -- and
			// it is what makes a `write()` reached directly work standalone, which is
			// what public API should do
			const now = await text();
			const next = render(now, value, opts?.paths);

			// a write that changes nothing touches no file, which is not tidiness:
			// it keeps the mtime, which is what SIG-153's watcher reads, and it is
			// what makes `apply()` of a freshly read value a no-op rather than a
			// rewrite of the same bytes
			if (next !== now) {
				await writeAtomic(source, next);
			}
		},
		writeSync(value: unknown, opts?: WriteOptions): void {
			const now = textSync();
			const next = render(now, value, opts?.paths);

			if (next !== now) {
				writeAtomicSync(source, next);
			}
		},
	};
}

/**
 * A `.json` file: strict JSON, with comments and trailing commas **reported**
 * rather than accepted.
 *
 * Reported rather than left to `JSON.parse`, which is the one thing this adds
 * over calling it directly: a `.json` holding a comment gets
 * `Comments are not allowed in ...` naming the line, where the engine's answer
 * is `Unexpected token /` and a reader has to work out what it meant.
 *
 * A path that ends `.jsonc` is **refused**, because that extension exists to
 * say comments are allowed and this store exists to say they are not.
 *
 * @param path - The file.
 * @returns The store.
 */
export function json(path: string): WritableConfigStore {
	return fileStore(path, false);
}

/**
 * A `.jsonc` file: JSON plus comments and trailing commas.
 *
 * The flavour `tsconfig.json` and VS Code's settings are written in, which is
 * what people mean by a `.jsonc`. Not JSON5 -- see `jsonc.ts` for what is
 * deliberately not in it.
 *
 * It writes by **editing spans** rather than reprinting, so a comment, a
 * trailing comma, the user's indentation, their key order, their line endings
 * and a missing final newline all survive a `set()` -- not because each is
 * handled but because the bytes holding them are never rewritten. A `.json`
 * path is accepted, for the reason `json()` refuses a `.jsonc` one in the other
 * direction: an extension that does not claim comments says nothing about
 * whether a file holds them.
 *
 * @param path - The file.
 * @returns The store.
 */
export function jsonc(path: string): WritableConfigStore {
	return fileStore(path, true);
}
