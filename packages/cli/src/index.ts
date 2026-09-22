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
 * Runs the toolchain.
 *
 * `--version` is answered from the returned state rather than from an
 * `afterParse` hook: that hook fires at the end of the argv walk, before
 * `processOptions()` writes anything, so `state.argv` is still empty inside it.
 *
 * @param argv - Arguments, defaulting to the process's.
 * @returns Whatever `main()` resolves with.
 */
export async function run(argv?: string[]): Promise<ParseState | unknown> {
	const result = await main({ argv, schema: schema() });

	// help already answered, and it outranks `--version` for the same reason it
	// outranks everything else: being asked what the program does and answering
	// something else is not an answer
	if (isParseState(result) && !result.help && result.argv.version) {
		process.stdout.write(`${version()}\n`);
	}

	return result;
}
