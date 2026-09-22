/**
 * `sigil check`: read an app and say what is wrong with it.
 *
 * Everything `sigil build` has to know before it can bundle anything -- does
 * the app type-check, does its command tree resolve, and can every description
 * be read statically -- asked on its own and reported. It is the fast inner
 * loop `tsc --noEmit` and `astro check` are, and it stays that now that
 * building exists rather than being a placeholder for it: `build` runs the same
 * pass through `_inspect.ts`, so a failure here is a failure there and the two
 * cannot come to disagree about what a valid app is.
 *
 * ## It reports rather than refuses
 *
 * A description nobody could read is a `warning`: the command keeps exactly the
 * help it would have had unbundled, which is none until its module loads. A
 * type error, a module with no default export, a directory two routes both
 * claim -- those are errors, because each is an app that would be wrong once
 * built. `isFatal()` is what decides, in one place, so `check` and `build`
 * cannot disagree about what stops a build either.
 *
 * ## Why the module is loaded rather than declared inline
 *
 * The schema declares `check` with a `desc` and a `load`, which is the same
 * shape `sigil build` generates for an app's own commands -- and the reason is
 * the one the build exists for. This module pulls in `oxc-parser`, which is a
 * native binary; leaving it on the startup path would make `sigil --version`
 * pay for a parser it never uses. The `desc` sits on the placeholder so that
 * `sigil --help` can describe the command without loading any of that, which is
 * precisely the problem the static `desc` lift solves for an app.
 */

import {
	countCommands,
	describeApp,
	failure,
	inspect,
	printTree,
	reportDiagnostics,
} from './_inspect.ts';
import { command, type AnyCommand } from '@ttylabs/sigil';

/**
 * Annotated rather than inferred, which `--isolatedDeclarations` requires of a
 * default export. Nothing is lost by it: `command()` has already typed this
 * literal's own `run`, and a command loaded from a module is one whose `argv`
 * inference the schema above could not have seen into anyway.
 *
 * `AnyCommand` rather than `Command`, for the reason that type exists: a
 * command whose `run` takes a narrow `argv` is not assignable to one whose
 * `run` takes the wide default, because a function parameter is contravariant.
 */
const check: AnyCommand = command({
	args: [{ desc: "The app's root, defaulting to the working directory", name: '[dir]' }],
	options: {
		'--commands [dir]': {
			desc: "The app's command directory, when its entry does not say",
		},
		'--entry [file]': {
			desc: "The module declaring the app's schema, when the conventions find the wrong one",
		},
		'--tree': {
			desc: 'Print the command tree as it resolved',
			type: 'bool',
		},
	},

	run({ argv }) {
		const found = inspect({
			commands: argv.commands as string | undefined,
			cwd: String(argv.dir ?? '.'),
			entry: argv.entry as string | undefined,
		});

		if (argv.tree) {
			printTree(found.commands, found.app.root);
		}

		const counts = reportDiagnostics(found);

		if (counts.fatal) {
			throw failure(found, counts);
		}

		const total = countCommands(found.commands);
		const counted = `${total} command${total === 1 ? '' : 's'}`;
		const warned = counts.warnings
			? `${counts.warnings} warning${counts.warnings === 1 ? '' : 's'}`
			: 'no problems found';

		process.stderr.write(`\n${describeApp(found.app)}: ${counted}, ${warned}\n`);
	},
});

export default check;
