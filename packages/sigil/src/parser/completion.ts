/**
 * The `completion` command a schema gets for free, wired the way `help` is.
 *
 * ## Why the framework owns it
 *
 * The same argument `--version` settled, and it lands harder here. A completion
 * script is printed from the command tree, the options and the `choices` an app
 * declared -- all of which are the *parser's*, not the app's, so an app writing
 * its own completion command would be reimplementing the walk this one does.
 * And `sigil build` generates the executable and calls `main()`, so a command
 * an app wrapped around `main()` is not in the bundle: a completion command
 * that was the app's would work from source and vanish once built, which is the
 * divergence `--version` is already written down for.
 *
 * On the root, because that is where a command every invocation can reach
 * belongs, and nothing is added over the top of what the app declared: an app
 * with its own `completion` keeps it and gets nothing from here, which is the
 * only reading of a declaration that means anything.
 *
 * `schema.completion: false` turns it off, for an app that does not want the
 * name taken.
 *
 * ## The script goes to stdout, and nothing is installed
 *
 * `app completion bash > …` and the script's own header says where. An
 * `install` subcommand is friendlier and is a tool writing to a user's
 * dotfiles: it has to know which file, whether it is already in there, what to
 * do when the user has edited around it, and how to take it out again -- four
 * decisions that belong to the user. Printing is what `gh`, `kubectl`,
 * `rustup` and `deno` all do, and it is the conservative half of a choice this
 * repository takes conservatively everywhere else.
 *
 * ## The emitters are behind a dynamic import
 *
 * `run` reaches them with `await import()`, exactly as `main()` reaches the
 * parser and the help screen. So a CLI that answers `--version` pays for the
 * command *existing* -- a name in a registry and an argument -- and not for
 * anything that prints a script.
 */

// the names alone, and statically: a `choices` list has to exist while the
// schema is built, so this is on the parse path -- which is why it is its own
// module rather than the barrel. It imports nothing and holds two short
// strings, so a bundler folds it into the chunk the parse is already in,
// where a dynamic import would be a second module fetch on every run of
// every app. The *emitters* are the thing worth deferring, and `run` below is
// where that happens
import { SHELL_NAMES } from '../completion/shells.js';
import { __ } from '../i18n/index.js';
import { Internal, type InternalCommand, type ParseState, type Schema } from '../types.js';
import { initCommand } from './command/init-command.js';

/**
 * Adds `completion` to the root context, unless the app has its own or has
 * turned it off.
 *
 * @param root - The root context, built from the schema.
 * @param schema - The schema, for `completion: false`.
 */
export async function registerCompletion(root: InternalCommand, schema: Schema): Promise<void> {
	if (schema.completion === false) {
		return;
	}

	const internal = root[Internal];

	// `find()` answers about the aliases as well as the name, which is what has
	// to be free: an app whose `shell` command is aliased `completion` would
	// otherwise have that alias quietly repointed at this one
	if (internal.commands.find('completion')) {
		return;
	}

	internal.commands.add(
		await initCommand({
			args: [
				{
					choices: SHELL_NAMES,
					desc: __`The shell to generate for`,
					name: '<shell>',
				},
			],
			desc: __`Print a shell completion script`,
			name: 'completion',

			async run(state: ParseState) {
				const { completionScript } = await import('../completion/index.js');

				// the argument is required and carries `choices`, both of which the
				// parse has judged by the time any `run` is reached, so this is a
				// string and it is one of the shells
				process.stdout.write(await completionScript(state, String(state.argv.shell)));
			},
		})
	);
}
