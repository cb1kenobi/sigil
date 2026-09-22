/**
 * `sigil check`: read an app and say what is wrong with it.
 *
 * Everything `sigil build` has to know before it can bundle anything --
 * does the app type-check, does its `commands/` tree resolve, and can every
 * description be read statically -- asked on its own and reported. It is the
 * fast inner loop `tsc --noEmit` and `astro check` are, and it stays that once
 * building exists rather than being a placeholder for it: `build` will run this
 * and then compile, so a failure here is a failure there and the two cannot
 * come to disagree about what a valid app is.
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
	formatDiagnostic,
	isFatal,
	resolveCommandTree,
	typeCheck,
	walkTree,
	type Diagnostic,
	type ResolvedCommand,
} from '../build/index.js';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { table } from '@ttylabs/sigil/components';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';

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
			default: 'commands',
			desc: "The app's command directory, relative to its root",
		},
		'--tree': {
			desc: 'Print the command tree as it resolved',
			type: 'bool',
		},
	},

	run({ argv }) {
		const root = resolve(String(argv.dir ?? '.'));
		const commandsDir = resolve(root, String(argv.commands));
		const diagnostics: Diagnostic[] = [];

		// the type check first, because it is the one that answers for the whole
		// app rather than for the routes -- an app whose modules do not type-check
		// is one whose tree is not worth reporting on in detail
		const types = typeCheck({ cwd: root });
		diagnostics.push(...types.diagnostics);

		let commands: readonly ResolvedCommand[] = [];

		if (existsSync(commandsDir)) {
			// a throw here is a tree that cannot exist at all -- two routes claiming
			// one name, a directory that is really a package -- rather than a fault
			// in one file, so it becomes a diagnostic rather than taking the process
			// down with a stack
			try {
				const tree = resolveCommandTree(commandsDir);
				commands = tree.commands;
				diagnostics.push(...tree.diagnostics);
			} catch (e: unknown) {
				diagnostics.push({
					file: commandsDir,
					message: (<Error>e).message,
					severity: 'error',
				});
			}
		} else {
			diagnostics.push({
				file: commandsDir,
				message: `no command directory here; pass --commands to name one, or check the app root`,
				severity: 'error',
			});
		}

		if (argv.tree) {
			printTree(commands, root);
		}

		return report({ commands, diagnostics, root, types });
	},
});

export default check;

/**
 * Writes the resolved tree, so that "why is my command not showing up" has an
 * answer that is not a guess.
 *
 * Through the framework's own `table()`, which is the toolchain being its own
 * acceptance test: a framework whose toolchain is not written in it has not
 * been tested by anyone who had to live with it. It also gets the column
 * arithmetic right for free, which is the whole reason that component exists.
 *
 * On stdout rather than stderr, because it is data somebody asked for -- the
 * diagnostics go the other way, so `sigil check --tree` can be piped without
 * losing the problems.
 *
 * @param commands - The tree.
 * @param root - What to write paths relative to.
 */
function printTree(commands: readonly ResolvedCommand[], root: string): void {
	const rows = [...walkTree(commands)].map(({ command: cmd, path }) => [
		`${'  '.repeat(path.length - 1)}${cmd.name}${cmd.hidden ? ' (hidden)' : ''}`,
		// a namespace has no module and nothing to run, which is a thing to say
		// rather than a blank: it is the answer to half the questions this is for
		cmd.module ? relative(root, cmd.module) : `(${cmd.kind}, nothing to run)`,
		cmd.desc ?? '',
	]);

	if (rows.length) {
		process.stdout.write(`${table(rows, { columns: ['Command', 'Module', 'Description'] })}\n`);
	}
}

/**
 * Writes everything that was found, and says whether it was fatal.
 *
 * @param found - The tree, the diagnostics, the root, and the type check.
 * @returns Nothing; it throws when the app does not check out.
 * @throws If anything fatal was found. `main()` renders the message and sets a
 *   non-zero exit code, which is what makes this usable in CI.
 */
function report(found: {
	commands: readonly ResolvedCommand[];
	diagnostics: readonly Diagnostic[];
	root: string;
	types: { checked: boolean; skipped?: string };
}): void {
	const { commands, diagnostics, root, types } = found;

	// relative to the app, because an absolute path per line is mostly the same
	// prefix repeated and the interesting part is at the end of it
	for (const diagnostic of diagnostics) {
		process.stderr.write(
			`${formatDiagnostic({ ...diagnostic, file: relative(root, diagnostic.file) || '.' })}\n`
		);
	}

	const errors = diagnostics.filter((d) => d.severity === 'error').length;
	const warnings = diagnostics.length - errors;
	const total = [...walkTree(commands)].length;

	if (!types.checked && types.skipped) {
		process.stderr.write(`\nNot type-checked: ${types.skipped}\n`);
	}

	if (isFatal(diagnostics)) {
		// thrown rather than written, so the exit code and the rendering are
		// `main()`'s the way they are for every other command
		throw new Error(
			`${errors} error${errors === 1 ? '' : 's'}${warnings ? ` and ${warnings} warning${warnings === 1 ? '' : 's'}` : ''} in ${root}`
		);
	}

	const counted = `${total} command${total === 1 ? '' : 's'}`;
	process.stderr.write(
		warnings
			? `\n${counted}, ${warnings} warning${warnings === 1 ? '' : 's'}\n`
			: `\n${counted}, no problems found\n`
	);
}
