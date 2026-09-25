import { main, type ParseState, type Schema } from '@ttylabs/sigil';
import { readFileSync } from 'node:fs';

/**
 * The toolchain's version, read from its own manifest.
 *
 * Read rather than inlined at build time so a globally linked checkout reports
 * what is actually on disk. Read rather than `require`d because the manifest is
 * wanted once and the module cache would hold it for the life of the process.
 *
 * `../package.json` resolves from both `src/index.ts` and the built
 * `dist/index.mjs` because both sit exactly one directory below the package
 * root. That symmetry is load-bearing: moving either entry a level deeper
 * breaks this for one of them and not the other, which is the kind of thing
 * only the published package would notice.
 */
export function version(): string {
	const manifest = new URL('../package.json', import.meta.url);
	return JSON.parse(readFileSync(manifest, 'utf-8')).version as string;
}

/**
 * The toolchain's command schema.
 *
 * Declared here rather than inside `run()` so tests can parse against it
 * without going through a process, and so the filesystem router (M2-74) has
 * something to replace rather than something to invent.
 */
export function schema(): Schema {
	return {
		name: 'sigil',
		// the function rather than the string: reading the manifest eagerly is a
		// file read on every run, and `sigil build` replaces this with the literal
		// it read at build time anyway
		version,
		// The commands are the files in `src/commands/`, which is what SIG-74 is
		// for and what `sigil build` reads out of an app. `baseDir` is what makes
		// './commands' mean *this* directory rather than the one the user was
		// standing in.
		//
		// No `routeInfo`: `sigil build` lifts the descriptions out of those
		// modules and bakes them into the tree it generates, which is the same
		// lift a hand-run script used to do here. Running from source lists by
		// name alone until a module is loaded, which is what an unbuilt
		// filesystem tree has always done.
		baseDir: import.meta.dirname,
		commands: './commands',
	};
}

/**
 * Whether argv is nothing but a request for the version.
 *
 * `sigil --version` has no use for the command tree, and since the toolchain
 * started routing its own commands off the filesystem it was paying for one:
 * building the schema reads `src/commands/` and pulls the route reader onto the
 * startup path, which is about 4ms to answer a question that needs neither.
 * Answered before the schema is built rather than after the parse, which is
 * where `run()` used to ask.
 *
 * Deliberately narrow: the *whole* of argv, rather than the flag appearing
 * anywhere in it. Every other spelling is a question with a second half, and
 * the parser already answers those in ways a scan here would have to reproduce
 * to avoid changing -- `--help --version` is help, because help outranks
 * everything; `check --version` runs `check`; `--version extra` is an error
 * about `extra`. Reproducing that is writing a second parser, and a second
 * parser that disagrees with the first is worse than four milliseconds.
 *
 * @param argv - The arguments.
 * @returns Whether to answer with the version and nothing else.
 */
function isVersionOnly(argv: readonly string[]): boolean {
	return argv.length === 1 && (argv[0] === '-v' || argv[0] === '--version');
}

/**
 * Runs the toolchain.
 *
 * `--version` is answered from the returned state rather than from an
 * `afterParse` hook: that hook fires at the end of the argv walk, before
 * `processOptions()` writes anything, so `state.argv` is still empty inside it.
 *
 * A run that named no command gets the help screen. A CLI that is all
 * subcommands has nothing to do without one, and printing nothing at all is the
 * one answer that tells the reader neither what went wrong nor what is
 * available. It exits zero and writes to stdout, the same as `--help`: being
 * asked what the program does and answering is not a failure, and the two
 * spellings of that question should not differ in where the answer goes.
 *
 * @param argv - Arguments, defaulting to the process's.
 * @returns Whatever `main()` resolves with.
 */
export async function run(argv?: string[]): Promise<ParseState | unknown> {
	if (isVersionOnly(argv ?? process.argv.slice(2))) {
		process.stdout.write(`${version()}\n`);
		return undefined;
	}

	// everything else is the schema's: `--version`, and the help screen a run
	// that named no command gets, are both `main()`'s now rather than this
	// wrapper's. That is what makes `node src/sigil.ts` and `node dist/sigil.mjs`
	// the same program -- `sigil build` generates the executable and calls
	// `main()` itself, so whatever a bin did around it was not in the bundle
	return main({ argv, schema: schema() });
}
