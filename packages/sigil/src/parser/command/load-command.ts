import debug from '../../debug/index.js';
import { Command, Internal, InternalCommand } from '../../types.js';
import { initCommand, loadCommandDir } from './init-command.js';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { log } = debug('sigil:parser:load-command');

/**
 * Fetches the module a command's declaration named, however it named it.
 *
 * `path` is a file to read and `load` is a function to call, and they are the
 * same statement: the module *is* the command. Everything after this point --
 * the validation, the merge, the aliases, the label -- is identical, which is
 * why the two sources part company here and nowhere else. A bundled app is the
 * whole reason there are two: it has no file to read, because its command
 * modules are chunks a bundler named, so `sigil build` emits the loader and the
 * deferral survives bundling.
 *
 * @param internal - The command's internal state.
 * @returns The module's default export and the file it came from, or
 *   `undefined` when the command declared no module at all.
 */
async function fetchModule(
	internal: InternalCommand[typeof Internal]
): Promise<{ def: unknown; entryFile?: string } | undefined> {
	if (internal.load) {
		log('Loading command from its loader');

		let mod;
		try {
			mod = await internal.load();
		} catch (e: unknown) {
			throw new Error(`Failed to load command module: ${(<Error>e).message}`);
		}

		// read for a `default` the way an imported module is, so that
		// `() => import('./build.js')` is the whole of the ordinary use -- and so
		// that a loader handing back the command object itself is not silently a
		// different contract
		const def = mod && typeof mod === 'object' && 'default' in mod ? mod.default : mod;

		// no `entryFile`: there is no file, so there is nothing for a path the
		// module declares to be relative to. A bundled module declaring a `path`
		// is already asking for a file that is not there, and resolving it from
		// the working directory -- which is wherever the user was standing -- is
		// the answer a schema written inline already gets
		return { def };
	}

	if (internal.path) {
		log(`Loading command: ${internal.path}`);

		if (!existsSync(internal.path)) {
			throw new Error(`Command module not found: ${internal.path}`);
		}

		try {
			// the URL is for the loader and goes no further: everything else here
			// answers questions about the file system -- where the module sits, and
			// so what the paths it declares are relative to -- and `file:///a/b.js`
			// is not a directory anything can be resolved against
			const def = (await import(pathToFileURL(internal.path).href)).default;
			return { def, entryFile: internal.path };
		} catch (e: unknown) {
			throw new Error(`Failed to load command module: ${(<Error>e).message}`);
		}
	}

	return undefined;
}

export async function loadCommand(cmd: InternalCommand): Promise<InternalCommand> {
	const internal = cmd[Internal];

	if (internal.loaded) {
		return cmd;
	}

	// a directory command reads its own level first: its entries become its
	// subcommands and an `index` module beside them becomes the `path` the fetch
	// below reads. Both halves of one `readdir`, which is why the walk is here
	// rather than beside the discovery that made the placeholder
	if (internal.dir) {
		await loadCommandDir(cmd);
	}

	const fetched = await fetchModule(internal);

	if (fetched) {
		const { def, entryFile } = fetched;
		const source = entryFile ?? `the "${cmd.name}" command's loader`;

		// `typeof null` is `'object'` and so is an array, so a bare `typeof` check
		// let both through: `null` fell past the merge below and marked the
		// placeholder loaded, and an array merged into an empty command. Either way
		// the parse succeeded with a command that has no `run`, and the load was
		// recorded as done so it was never retried -- `main()` then did nothing at
		// all, which is a worse answer than the error a string export already gets
		if (!def || typeof def !== 'object' || Array.isArray(def)) {
			throw new TypeError(`Command module default export is not a valid command object: ${source}`);
		}

		const decl = def as Command;

		// the module's own name string, if it has one, wins over the
		// placeholder's
		const renamed = decl.name !== undefined;

		// the ESM loader caches the module and hands the same object to every
		// importer, so the placeholder is merged into a copy — mutating `def`
		// would leak the placeholder's name and aliases into the next parse
		const merged: Command = { ...decl };

		// the placeholder's subcommands come across as the commands they already
		// are rather than as the paths they were declared as: those paths are
		// relative to the file that declared the placeholder, and this module is a
		// different file, so reading them again here would read them against the
		// wrong directory. `initCommand()` hands an initialized command straight
		// back, which is what makes registering them again cost nothing
		if (internal.dir) {
			// a directory's subcommands were discovered rather than declared, so an
			// `index` module declaring some of its own adds to them rather than
			// replacing them -- losing `db/migrate.js` because `db/index.js`
			// mentioned one inline command is not something anybody means. What it
			// declares still wins the name it names, since that is the specific
			// statement and the walk is the general one
			merged.commands =
				decl.commands && typeof decl.commands === 'object' && !Array.isArray(decl.commands)
					? { ...Object.fromEntries(internal.commands), ...decl.commands }
					: (decl.commands ?? Object.fromEntries(internal.commands));
		} else if (decl.commands === undefined && internal.commands.size) {
			merged.commands = Object.fromEntries(internal.commands);
		}

		// every other key but `path` and `load`: those are how this module was
		// found rather than something the command it declares still needs, and
		// either one carried across would be read a second time -- a `path`
		// against this module rather than against the file that declared the
		// placeholder, which is a different directory, and a `load` as a module to
		// fetch all over again
		for (const [key, value] of Object.entries(cmd)) {
			if (key !== 'path' && key !== 'load' && merged[key] === undefined) {
				merged[key] = value;
			}
		}

		// `hidden` is additive, but only the placeholder saw the `!` name
		// prefix, so a module that declares itself visible must not un-hide it
		if (cmd.hidden === true) {
			merged.hidden = true;
		}

		// the module never saw the placeholder's name string either, so the
		// aliases parsed from it have to come across as an explicit list
		if (
			internal.aliases.size &&
			(merged.alias === undefined ||
				typeof merged.alias === 'string' ||
				Array.isArray(merged.alias))
		) {
			merged.alias = [
				...internal.aliases,
				...(merged.alias === undefined
					? []
					: typeof merged.alias === 'string'
						? [merged.alias]
						: merged.alias),
			];
		}

		// every path still left in `merged` is the module's own, so the module is
		// what they are relative to -- which is also the base a hook of the
		// module's reads off the command it is handed
		const loaded = await initCommand(merged, entryFile);

		// ...and the same goes for the help label, unless the module renamed
		// the command and brought its own labels
		if (!renamed) {
			loaded[Internal].label = internal.label;
		}

		// only mark the load done once it actually succeeded: a module that
		// throws must throw again the next time the command is matched
		// instead of quietly resolving to the placeholder
		internal.loaded = true;

		// the command this built *is* the module, so loading it again would
		// re-import the same file and run its init hooks a second time
		loaded[Internal].loaded = true;

		return loaded;
	}

	internal.loaded = true;

	return cmd;
}
