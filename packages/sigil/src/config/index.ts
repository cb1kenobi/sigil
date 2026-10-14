/**
 * `@ttylabs/sigil/config`: one merged view over an ordered stack of layers.
 *
 * Almost every CLI with settings needs a config file, and every one of them
 * writes the same boilerplate: find the path, read it, merge a user file over a
 * system file, coerce the values, write it back without truncating it.
 * `paths.ts` gives the directories and reads nothing.
 *
 * `set()` mutates a layer in memory and `save()` persists, which is forced
 * rather than chosen: every accessor is synchronous and a store's `write()` may
 * not be, so a synchronous `set()` could not report an asynchronous write
 * failure. The hazard that introduces is named rather than guarded -- an app
 * that sets and exits without saving loses the write, and `config.layers`
 * reports `dirty` so one that wants to warn can.
 *
 * A write **edits spans rather than reprinting**, so a comment, a trailing
 * comma, the user's indentation and their line endings survive a `set()` -- not
 * because each is handled but because the bytes holding them are never
 * rewritten. What a store cannot carry it reports as `wouldLose`, and a write
 * that would lose something refuses unless somebody said `lossy`.
 *
 * ## This is not oclif parity
 *
 * `this.config` in oclif is CLI *metadata* -- `configDir`, `cacheDir`,
 * `platform`, `plugins`. Its own documentation says oclif "does not provide
 * built-in mechanisms for loading, merging, or saving user configuration
 * files", and the feature request asking for precisely the layered merge below
 * is closed as not planned. The ecosystem answer is cosmiconfig, which is a
 * dependency. So this is a differentiator rather than a gap, and a better one
 * than the component runtime in one respect: every CLI with settings wants it,
 * where only some want a TUI.
 *
 * ## Core does not load config, and does not accept one either
 *
 * Nothing in `main()` or `parse()` calls any of this or takes one. **Options
 * and config settings are separate, and the app decides how to mix them** --
 * which reverses an earlier design in which config was a third source inside
 * the parser's own fallback chain.
 *
 * They are not the same kind of thing. An option is something a user types for
 * one run; a config setting is something that persists. Coupling them means
 * every option wants a config key and every config key wants an option, and
 * neither is true. The mixing an app actually wants is one line, in either of
 * two spellings, neither of which needs anything from core:
 *
 * ```js
 * // in run(), the explicit version
 * const port = argv.port ?? config.get('server.port');
 *
 * // or at schema-build time, which gives argv -> env -> config through the
 * // chain that already exists
 * options: { '--port [n]': { type: 'int', default: config.get('server.port') } }
 * ```
 *
 * The second works because core does not load config, so the app has one before
 * it builds its schema.
 *
 * What that deletes, none of it missed: discovering a config file, a `--config`
 * in every app's namespace, a naming convention nobody agrees on -- `--config`
 * in eslint, prettier, webpack, rollup and vite, `--config-file` in babel, a
 * *directory* in docker, a path **or** a JSON blob in jest -- deciding what a
 * `--config` does to the layer stack, and answering what happens when somebody
 * passes both a file and a blob, which once the app owns it is not a conflict at
 * all but two layers. This is the opposite call from `--help`, `--version` and
 * `completion`, and the distinction is sharp: those three the framework can
 * answer identically for every app, and this it cannot.
 *
 * What is given up, stated plainly: there is no automatic "this option falls
 * back to this config key."
 *
 * ## The one place the two systems must agree
 *
 * A setting may declare `env`, which means two things in this library read
 * environment variables. They have to agree, or `PORT=` means one thing to an
 * option and another to a setting. `envValue()` is that rule, in one module,
 * read by both.
 */

export { Config, createConfig, createConfigSync, isWritableStore } from './config.js';
export { object } from './stores/object.js';
export { json } from './stores/file.js';
export type {
	ConfigDocument,
	ConfigLayer,
	ConfigLayerInfo,
	ConfigMerge,
	ConfigOptions,
	ConfigSchema,
	ConfigSetting,
	ConfigStore,
	Loss,
	WritableConfigStore,
	WriteOptions,
} from './types.js';
