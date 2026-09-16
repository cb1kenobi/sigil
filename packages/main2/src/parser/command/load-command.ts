import debug from '../../debug/index.js';
import { Command, Internal, InternalCommand } from '../../types.js';
import { initCommand } from './init-command.js';
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const { log } = debug('main2:parser:load-command');

export async function loadCommand(cmd: InternalCommand): Promise<InternalCommand> {
	const internal = cmd[Internal];

	if (internal.loaded) {
		return cmd;
	}

	if (internal.path) {
		const file = pathToFileURL(internal.path).toString();
		log(`Loading command: ${file}`);

		if (!existsSync(internal.path)) {
			throw new Error(`Command module not found: ${internal.path}`);
		}

		let def;
		try {
			def = (await import(file)).default;
		} catch (e: unknown) {
			throw new Error(`Failed to load command module: ${(<Error>e).message}`);
		}

		// `typeof null` is `'object'` and so is an array, so a bare `typeof` check
		// let both through: `null` fell past the merge below and marked the
		// placeholder loaded, and an array merged into an empty command. Either way
		// the parse succeeded with a command that has no `run`, and the load was
		// recorded as done so it was never retried -- `main2()` then did nothing at
		// all, which is a worse answer than the error a string export already gets
		if (!def || typeof def !== 'object' || Array.isArray(def)) {
			throw new TypeError(
				`Command module default export is not a valid command object: ${internal.path}`
			);
		}

		// the module's own name string, if it has one, wins over the
		// placeholder's
		const renamed = def.name !== undefined;

		// the ESM loader caches the module and hands the same object to every
		// importer, so the placeholder is merged into a copy — mutating `def`
		// would leak the placeholder's name and aliases into the next parse
		const merged: Command = { ...def };

		for (const [key, value] of Object.entries(cmd)) {
			if (merged[key] === undefined) {
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

		const loaded = await initCommand(merged, file);

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
