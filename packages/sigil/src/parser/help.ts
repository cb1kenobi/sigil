import {
	type HelpRequest,
	Internal,
	type InternalCommand,
	type InternalOption,
	type ParsedCommand,
	type ParseState,
	type Schema,
} from '../types.js';
import { initCommand } from './command/init-command.js';
import { loadCommand } from './command/load-command.js';

/**
 * The `--help` flag and the `help` command a schema gets for free, so that
 * `parse()` can tell whether one of them was the thing that was asked for. A
 * schema that declares its own keeps it, and then neither is here.
 */
export interface HelpHandles {
	command?: InternalCommand;
	option?: InternalOption;
}

/**
 * Adds `--help` and `help` to the root context, unless the app already has them
 * or has turned them off.
 *
 * Both go on the root rather than on every command, because options resolve
 * across the whole context chain: one `--help` there answers everywhere, and a
 * command that declares its own shadows it for itself and nowhere else.
 *
 * Nothing is added over the top of what the app declared. A CLI whose `-h` means
 * `--host` keeps it and gets `--help` without the short form; one that declares
 * `--help` itself gets no flag from here at all, and is then responsible for what
 * `--help` does -- which is the only reading of a declaration that means anything.
 *
 * @param root - The root context, built from the schema.
 * @param schema - The schema, for `help: false`.
 * @returns What was added, so a parse can recognize it later.
 */
export async function registerHelp(root: InternalCommand, schema: Schema): Promise<HelpHandles> {
	if (schema.help === false) {
		return {};
	}

	const internal = root[Internal];
	const handles: HelpHandles = {};

	// `find()` answers about spellings and `has()` about the key the registry
	// stores an option under, which is its name. Both have to be free: an option
	// spelled `-x` and named `help` takes the key `help` without answering to
	// `--help`, and adding one there would replace it -- leaving `-x` pointing at
	// the option that replaced it.
	if (!internal.options.find('--help') && !internal.options.has('help')) {
		// the short form only when it is free: `-h` is a common spelling for
		// something else, and taking it from an app that wants it would be worse
		// than not having it
		const format = internal.options.find('-h') ? '--help' : '-h, --help';
		await internal.options.add({ desc: 'Show help for a command', format });
		handles.option = internal.options.find('--help');

		if (handles.option) {
			// a flag always has a value, and this one is not the app's: an app that
			// never declared `--help` should not find `help: false` in its argv
			handles.option[Internal].parserOwned = true;
		}
	}

	if (!internal.commands.find('help')) {
		internal.commands.add(
			await initCommand({
				args: [{ desc: 'The command to describe', name: '[command...]' }],
				desc: 'Show help for a command',
				name: 'help',
			})
		);
		handles.command = internal.commands.find('help');
	}

	return handles;
}

/**
 * Whether this parse was a request for help, and what it should describe.
 *
 * Called once argv has been walked and before anything is validated, because
 * help has to win over a missing required option: `mycli build --help` is asking
 * what `build` needs, and answering "you did not say" is not an answer.
 *
 * @param state - The parse state.
 * @param handles - What `registerHelp()` added.
 * @returns The request, or `undefined` when help was not what was asked for.
 */
export async function detectHelp(
	state: ParseState,
	handles: HelpHandles
): Promise<HelpRequest | undefined> {
	// the command form is asked first, because it is the more specific of the two
	// when both are present: somebody who typed `help build` named the command
	// they meant, and the `--help` after it adds nothing
	if (handles.command && state.cmd === handles.command) {
		return { contexts: await resolve(state, path(state, handles.command)), via: 'command' };
	}

	if (handles.option && used(state, handles.option)) {
		return { contexts: asked(state), via: 'option' };
	}

	return undefined;
}

/**
 * The chain argv actually asked about.
 *
 * Usually that is the chain the parse ended in, but not when a default command
 * was dispatched: `mycli --help`, on a CLI whose `serve` is the default, is asking
 * what `mycli` does, and answering with `serve`'s screen hides every other command
 * there is. So the chain is trimmed back to the commands argv named -- one
 * `ParsedCommand` each, and none for a default, which is exactly the difference.
 *
 * @param state - The parse state.
 * @returns The chain, innermost first.
 */
function asked(state: ParseState): InternalCommand[] {
	const named = state.$.filter((parsed) => parsed.type === 'Command').length;
	return state.contexts.slice(state.contexts.length - (named + 1));
}

/**
 * Whether argv asked for help with the flag.
 *
 * Typed and true: a default or an environment variable can give `--help` a value
 * without anybody asking a question, and `--help=false` is somebody typing it and
 * saying no.
 *
 * @param state - The parse state.
 * @param option - The option to look for.
 * @returns `true` when argv turned it on.
 */
function used(state: ParseState, option: InternalOption): boolean {
	return state.$.some(
		(parsed) => parsed.type === 'Option' && parsed.option === option && parsed.value === true
	);
}

/**
 * The command path `help` was given, which is every positional after it.
 *
 * After it, and not simply every positional there is: `mycli nope help build`
 * would otherwise start the walk at `nope` and report that as the unknown
 * command, when the question was about `build`.
 *
 * Read off `state.$` rather than `state.argv`, because nothing has processed the
 * arguments yet: help is detected before validation, which is the point of it.
 *
 * @param state - The parse state.
 * @param command - The help command, to find where its arguments start.
 * @returns The names, in order.
 */
function path(state: ParseState, command: InternalCommand): string[] {
	const names: string[] = [];
	let reached = false;

	for (const parsed of state.$) {
		if (!reached) {
			reached = parsed.type === 'Command' && (parsed as ParsedCommand).cmd === command;
			continue;
		}

		if (parsed.type === 'Unknown') {
			for (const input of parsed.inputs) {
				if (typeof input === 'string' && input) {
					names.push(input);
				}
			}
		}
	}

	return names;
}

/**
 * The context chain for a command named by path, innermost first.
 *
 * `help build targets` describes `targets`, and to describe it the way
 * `mycli build targets --help` would, the chain above it has to be the same
 * chain -- so this walks down from the root the way the parser does, loading a
 * lazily declared command when it reaches one, and hands back what it walked
 * through.
 *
 * @param state - The parse state.
 * @param names - The command path.
 * @returns The chain, innermost first.
 */
async function resolve(state: ParseState, names: string[]): Promise<InternalCommand[]> {
	// the root, which is the last element of any chain
	const chain = [state.contexts[state.contexts.length - 1]!];

	for (const name of names) {
		const found = chain[0]![Internal].commands.find(name);

		if (!found) {
			throw new Error(`Unknown command "${name}"`);
		}

		// a lazily declared command has its description and its own subcommands in
		// a module, and describing it means reading them
		chain.unshift(await loadCommand(found));
	}

	return chain;
}
