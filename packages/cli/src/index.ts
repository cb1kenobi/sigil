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
		options: {
			'-v, --version': {
				desc: "Print the toolchain's version",
				type: 'bool',
			},
		},
		// `build`, `add`, and `new` land in SIG-73 and SIG-75. Nothing is stubbed
		// here: a command that exists and refuses is worse than one that does not
		// exist yet, because only the second is honest in `--help`. `check` is not
		// a stub -- it is the whole of what it claims to be, and `build` will run
		// it rather than replace it.
		commands: {
			check: {
				// declared here rather than in the module, so `sigil --help` can
				// describe the command without loading it. That is the same shape
				// `sigil build` generates for an app -- a `desc` lifted out of the
				// module and a `load` beside it -- and it is worth more than it looks:
				// the module behind this one pulls in `oxc-parser`, a native binary
				// that `sigil --version` has no use for
				desc: 'Check an app without building it',
				load: () => import('./commands/check.js'),
			},
		},
	};
}

/**
 * Whether `main()` handed back a parse state rather than a command's return
 * value or the `undefined` it resolves with after handling an error.
 *
 * @param value - Whatever `main()` resolved with.
 * @returns Whether it is a state worth reading.
 */
function isParseState(value: unknown): value is ParseState {
	return !!value && typeof value === 'object' && 'argv' in value && '$' in value;
}

/**
 * Writes the help screen for a parse that never asked for one.
 *
 * The help module is imported here rather than at the top, the same way
 * `main()` imports the parser and the renderer: a run that answers with a
 * version string should not pay to load the renderer, the wrapper and the width
 * tables to find that out.
 *
 * `resolveHelp()` takes a state with no help request and describes it as it
 * stands, which is exactly the root screen -- so this is the same screen
 * `--help` prints rather than a second one built another way.
 *
 * @param state - The parse state.
 */
async function printHelp(state: ParseState): Promise<void> {
	const { resolveHelp } = await import('@ttylabs/sigil/help');
	process.stdout.write(`${await resolveHelp(state)}\n`);
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
	const result = await main({ argv, schema: schema() });

	// help already answered, and it outranks `--version` for the same reason it
	// outranks everything else: being asked what the program does and answering
	// something else is not an answer
	if (!isParseState(result) || result.help) {
		return result;
	}

	if (result.argv.version) {
		process.stdout.write(`${version()}\n`);
	} else if (!result.cmd) {
		// `cmd` is set whenever one was dispatched, including one whose `run`
		// returned nothing -- `main()` hands back the state in that case, so this
		// is the difference between "nothing was named" and "something ran
		// quietly"
		await printHelp(result);
	}

	return result;
}
