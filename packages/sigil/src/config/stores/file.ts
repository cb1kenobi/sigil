import { __ } from '../../i18n/index.js';
import { expand } from '../../paths.js';
import { parseJsonc } from '../jsonc.js';
import type { ConfigDocument, ConfigStore } from '../types.js';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';

/**
 * Whether a failed read means the file is simply not there.
 *
 * A missing config file is the ordinary state of one -- an app ships defaults
 * and the user has written nothing yet -- so it is an empty document rather
 * than a throw, which is the call `readSigilConfig()` already made for the same
 * question. Every *other* reason a read can fail is reported: a directory where
 * a file was named, a permission error, a device that went away. Those are
 * things somebody can act on, and swallowing them would make a config nobody
 * can read look like one nobody wrote.
 *
 * `EISDIR` is deliberately not in here. A path that names a directory is an app
 * pointing at the wrong thing, and answering "there is no config" for it is the
 * silence that costs an afternoon.
 *
 * @param e - What the read threw.
 * @returns Whether to read it as an empty document.
 */
function isMissing(e: unknown): boolean {
	return (e as { code?: string }).code === 'ENOENT';
}

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
function fileStore(path: string, jsonc: boolean): ConfigStore {
	// refused here rather than at the read, because what the read says about it
	// names the wrong thing: `expand('')` is `'.'`, so an empty path reported
	// `Failed to read .: EISDIR` -- a message about a directory nobody named --
	// and a path that is not a string threw out of `expand()` itself. Not
	// translated: a store's path is the app's own
	if (typeof path !== 'string' || !path) {
		throw new Error('A config file store needs a path');
	}

	const source = expand(path);
	const format = jsonc ? 'jsonc' : 'json';

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

		// `wouldLose` is empty even over a comment-rich file, and that is the
		// contract rather than an omission: this is the store SIG-154 gives a span
		// writer to, so comments survive a write because it edits rather than
		// reprints. A store that reprints -- YAML, XML -- reports what it would
		// drop, and the field is published for those
		return { value };
	};

	return {
		format,
		async read(): Promise<ConfigDocument> {
			let text: string | undefined;
			try {
				text = await readFile(source, 'utf8');
			} catch (e: unknown) {
				if (!isMissing(e)) {
					throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
				}
			}
			return parse(text);
		},
		readSync(): ConfigDocument {
			let text: string | undefined;
			try {
				text = readFileSync(source, 'utf8');
			} catch (e: unknown) {
				if (!isMissing(e)) {
					throw new Error(__`Failed to read ${source}: ${(e as Error).message}`);
				}
			}
			return parse(text);
		},
		source,
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
 * @param path - The file.
 * @returns The store.
 */
export function json(path: string): ConfigStore {
	return fileStore(path, false);
}

/**
 * A `.jsonc` file: JSON plus comments and trailing commas.
 *
 * The flavour `tsconfig.json` and VS Code's settings are written in, which is
 * what people mean by a `.jsonc`. Not JSON5 -- see `jsonc.ts` for what is
 * deliberately not in it.
 *
 * @param path - The file.
 * @returns The store.
 */
export function jsonc(path: string): ConfigStore {
	return fileStore(path, true);
}
