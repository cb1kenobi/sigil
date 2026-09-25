import debug from './debug/index.js';
import { errorHandler } from './error-handler.js';
import { fireBeforeError, stateFromError } from './error-hooks.js';
import { type AppOptions, type ParseState, type Schema, type Settings } from './types.js';

export * from './types.js';
export { command } from './command.js';
export { options } from './options.js';
export { errorExitCode, errorHandler, renderError } from './error-handler.js';

const { log } = debug('sigil');

/*
get cwd(): string {
    return process.cwd();
  }

  set cwd(v: string) {
    process.chdir(v);
	}
*/

/**
 * Parses argv against the schema and runs the command that wins.
 *
 * Errors thrown by `parse()` or by the command's `run()` are rendered by
 * `errorHandler()` -- the message, no stack trace -- and turned into a
 * non-zero `process.exitCode`; `main()` then resolves with `undefined`. A
 * bin script is the expected caller, so failing loudly through an unhandled
 * rejection is the wrong default. Set `settings.errorHandler` to `false` to
 * have the error rethrown instead, or to a function to render it yourself.
 *
 * @param opts - The app options.
 * @returns The command's return value, the parse state when the command
 * returned nothing or no command ran, or `undefined` when an error was
 * handled.
 */
export async function main(opts: AppOptions = {}): Promise<ParseState | unknown> {
	let state: ParseState | undefined;
	let hooksFired = false;

	try {
		if (opts?.settings?.assertCwd !== false) {
			assertCwd();
		}

		const { parse } = await import('./parser/parse.js');

		// read the app options before the catch below, which speaks only for
		// `parse()`: a property of the caller's own that throws on the way in
		// has not been through the hooks yet
		const parseOpts = {
			argv: opts.argv || process.argv.slice(2),
			env: process.env,
			schema: opts.schema,
			settings: opts.settings,
		};

		try {
			state = await parse(parseOpts);
		} catch (err) {
			// `parse()` owns its own error path and has already fired the hooks
			// on whatever it throws -- firing them again here would double up
			hooksFired = true;
			throw err;
		}

		if (state.help) {
			await printHelp(state);
			return state;
		}

		// after help, which outranks it, and before the command runs: `--version`
		// is a question about the program rather than work to do
		if (state.version !== undefined) {
			process.stdout.write(`${state.version}\n`);
			return state;
		}

		const { cmd } = state;
		if (cmd?.run) {
			log(`Executing command "${cmd.name}"`);
			return (await cmd.run(state)) ?? state;
		}

		// nothing ran and there was nothing to run: a CLI that is all subcommands
		// has nothing to do without one, and printing nothing at all tells the
		// reader neither what went wrong nor what is available. It goes to stdout
		// and exits zero like `--help`, because being asked what the program does
		// and answering is not a failure.
		//
		// In `main()` rather than in the app's own bin, which is where the
		// toolchain used to do it: `sigil build` generates the executable and
		// calls `main()`, so anything an app wrapped around it is not in the
		// bundle -- and a built CLI printed nothing at all where the same source
		// printed help.
		//
		// Three things have to be true, and each was a test saying so. The app
		// declared `commands`, because a schema that declares none is one being
		// used as a parser and a help screen is not what its caller asked for --
		// the `help` command this adds to every schema means the *registry* is
		// never empty, so the declaration is what has to be asked about. Help is
		// not turned off, since `help: false` means this app answers for what
		// help means. And nothing already answered: a command with a `run`, a
		// `default` command, `--help` and `--version` all leave before here.
		const declaredCommands = state.schema.commands !== undefined;

		if (declaredCommands && state.schema.help !== false && state.version === undefined) {
			await printHelp({ ...state, help: { contexts: state.contexts, via: 'empty' } });
		}

		return state;
	} catch (err) {
		// a parse error never got to return a state, but it carries the one it
		// died with, which is where the matched command comes from
		return await handleError(err, state ?? stateFromError(err), opts, hooksFired);
	}
}

/**
 * Writes the help screen and sets the exit code.
 *
 * The help module is imported here rather than at the top, the same way the
 * parser is: a bin script that never prints help should not pay to load the
 * renderer, the wrapper, and the width tables to find that out.
 *
 * @param state - The parse state, carrying the request.
 */
async function printHelp(state: ParseState): Promise<void> {
	const { resolveHelp } = await import('./help/index.js');
	log(`Printing help for "${state.help?.contexts[0]?.name}"`);
	process.stdout.write(`${await resolveHelp(state)}\n`);
	process.exitCode = exitCode(state.settings.helpExitCode);
}

/**
 * The exit code to set after printing help.
 *
 * Zero unless the app said otherwise: being asked what a command does and
 * answering is not a failure. A value that is not an exit code is not an
 * instruction, and assigning it would turn printing help into a crash.
 *
 * @param code - The configured code.
 * @returns The code to set.
 */
function exitCode(code: number | undefined): number {
	return Number.isInteger(code) && code! >= 0 && code! < 256 ? code! : 0;
}

/**
 * The single error path for `main()`. Everything thrown between the working
 * directory check and the command's `run()` resolving arrives here.
 *
 * @param err - The thrown value.
 * @param state - The parse state, if parsing got far enough to produce one.
 * @param opts - The app options.
 * @param hooksFired - Set when the `beforeError` hooks have already run, which
 * is every error `parse()` threw.
 */
async function handleError(
	err: unknown,
	state: ParseState | undefined,
	opts: AppOptions,
	hooksFired = false
): Promise<undefined> {
	// the hooks fire before anything is rendered and before the opt-out below,
	// so the error a hook replaced is the one that gets rendered, handed to a
	// custom handler, or rethrown -- the same error whichever way it leaves
	const reported = hooksFired ? err : await fireBeforeError(err, state, appSchema(opts));

	const handler = errorHandlerSetting(opts);

	if (handler === false) {
		throw reported;
	}

	if (typeof handler === 'function') {
		await handler(reported, { state });
		return;
	}

	errorHandler(reported, { state });
}

/**
 * Reads the error handler setting without letting a throwing getter escape.
 * Falling back to the built-in handler reports the original error; letting the
 * read throw would report neither it nor the bad getter.
 *
 * @param opts - The app options.
 * @returns The configured handler, or `undefined` for the built-in one.
 */
function errorHandlerSetting(opts: AppOptions): Settings['errorHandler'] {
	try {
		return opts?.settings?.errorHandler;
	} catch {
		return undefined;
	}
}

/**
 * Reads the schema off the app options without letting a throwing getter
 * escape. This runs on the error path, where the only thing worse than a bad
 * schema is a second error hiding the first.
 *
 * @param opts - The app options.
 * @returns The schema, if the options carry a readable one.
 */
function appSchema(opts: AppOptions): Schema | undefined {
	try {
		return opts?.schema;
	} catch {
		return undefined;
	}
}

function assertCwd() {
	try {
		process.cwd();
	} catch (err) {
		if (err instanceof Error && err.message.includes('uv_cwd')) {
			throw new Error('Current working directory does not exist');
		}
	}
}

export default main;
