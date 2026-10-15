import type { ConfigDocument, WritableConfigStore, WriteOptions } from '../types.js';

/**
 * A store over a plain value the app already has.
 *
 * ## This is what replaces a `.js` layer
 *
 * A `.js` config is the popular shape -- `vite.config.js`, `eslint.config.js`
 * -- and reading one is the only thing in this design that **cannot** be done
 * synchronously, because `import()` is async and there is no synchronous ESM
 * loader. One store kind was forcing the whole interface to carry optional
 * methods and every caller to branch on which half a store spoke, so it is
 * dropped and this takes its place:
 *
 * ```js
 * const mod = await import('./app.config.js');
 *
 * const config = await createConfig({
 * 	schema,
 * 	layers: [
 * 		{ name: 'defaults', store: object(mod.default) },
 * 		{ name: 'user',     store: jsonc(paths.configHome('myapp', 'config.jsonc')) },
 * 	],
 * });
 * ```
 *
 * **Nothing is lost in capability**, only in convenience -- and what the app
 * gains in exchange is control over *how* its module is loaded: TypeScript,
 * with arguments, conditionally, or not at all. It also moves the ESM
 * module-cache problem to the app, which is the only party that knows whether
 * it cares: a `.js` layer could never be reloaded, because the loader caches a
 * module for the life of the process and a cache-busting query string leaks one
 * per reload. An app that wants to re-import with a buster may; that is its leak
 * and its decision.
 *
 * ## It is also the in-memory layer
 *
 * With nothing handed in it holds `{}`, which is the runtime override layer: a
 * run that overrides a setting for its own duration and persists nothing. One
 * store rather than an `object()` and a `memory()` that are the same thing
 * under two names.
 *
 * ## Writable, and what that means here
 *
 * It is a `WritableConfigStore` because it can be one -- `write()` replaces the
 * value it holds -- and that value is in memory, so **nothing persists**. A
 * `save()` of a layer over one therefore succeeds and writes no file, which is
 * what the runtime override layer means: the file stores beside it are the ones
 * that reach a disk.
 *
 * It reports no `wouldLose`, and that is not an omission either: it holds the
 * value rather than a serialization of it, so there is no trivia for a write to
 * drop.
 *
 * @param value - The value, or nothing for an empty override layer.
 * @returns The store.
 */
export function object(value: unknown = {}): WritableConfigStore {
	let held = value;

	return {
		format: 'object',
		read(): Promise<ConfigDocument> {
			return Promise.resolve({ value: held });
		},
		readSync(): ConfigDocument {
			return { value: held };
		},
		write(next: unknown, _opts?: WriteOptions): Promise<void> {
			held = next;
			return Promise.resolve();
		},
		writeSync(next: unknown, _opts?: WriteOptions): void {
			held = next;
		},
	};
}
