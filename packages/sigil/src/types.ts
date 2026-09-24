import type { InferArgv } from './infer.js';
import { CommandRegistry } from './parser/command/command-registry.js';
import { OptionRegistry } from './parser/option/option-registry.js';

export type AppOptions = {
	argv?: string[];
	schema?: Schema;
	settings?: Settings;
};

/**
 * Replaces the generated help screen for one command.
 *
 * The generated screen is handed in, so a renderer that only wants to add to it
 * -- a note about configuration files, a link to the docs -- does not have to
 * rebuild the rest. Returning anything but a string leaves the generated screen
 * alone, which is how a renderer that only wants to look declines to replace it.
 */
export type HelpRenderer = (ctx: HelpRenderContext) => unknown | Promise<unknown>;

export interface HelpRenderContext {
	/** The command being described. */
	cmd: InternalCommand;
	/** The screen that would have been printed. */
	generated: string;
	/** The parse state. */
	state: ParseState;
}

/**
 * Why a parse produced no command run: argv asked what something does instead of
 * asking for it to be done.
 *
 * Set by `parse()` before anything is validated, because help has to win over a
 * missing required option -- `mycli build --help` is asking what `build` needs,
 * and answering "you did not say" is not an answer.
 */
export interface HelpRequest {
	/** The context chain to describe, innermost first. */
	contexts: InternalCommand[];
	/** Whether it was the `--help` flag or the `help` command. */
	via: 'command' | 'option';
}

export const Internal: unique symbol = Symbol();

/**
 * The key `parse()` stashes its in-flight `ParseState` under on any error it
 * throws once that state exists.
 *
 * The errors that most need a usage line -- a missing required option, an
 * unexpected argument -- are the ones that stop `parse()` from ever returning,
 * so the error is the only way the matched command gets back out. A symbol,
 * and non-enumerable, so nothing inspecting the error ever sees it.
 */
export const ErrorState: unique symbol = Symbol('sigil.errorState');

/**
 * How far along an `init*()` call got. Only `OK` is trusted: an object in any
 * other state is rebuilt from scratch the next time it is initialized.
 */
export enum InternalState {
	/** Fully built, and safe to hand straight back. */
	OK = 1,
	/**
	 * Built, but not finished — a command stays here until its init hooks have
	 * all resolved, so a hook that throws leaves nothing half built behind.
	 */
	Dirty = 2,
}

interface InternalBase {
	state: InternalState;
}

export type DataType = 'auto' | 'bool' | 'date' | 'int' | 'json' | 'number' | 'string' | 'yesno';

export type ArgDataType = DataType;

export type Transformer = <T>(value: T, state: ParseState) => Promise<T | unknown>;

export interface Argument {
	[key: string]: unknown; // custom data
	choices?: readonly unknown[];
	default?: unknown;
	/** What the argument is for, as help prints it. */
	desc?: string;
	env?: string | string[];
	multiple?: boolean;
	name: string;
	required?: boolean;
	transform?: Transformer;
	type?: ArgDataType | string;
}

export interface InternalArgument extends Argument {
	[Internal]: InternalArgumentBase;
	type: ArgDataType;
}

export interface InternalArgumentBase extends InternalBase {
	dest: string;
	envs: Set<string>;
}

export type CommandRunHandler<Argv = Record<string, unknown>> = (
	state: ParseState<Argv>
) => unknown | Promise<unknown>;

export interface CommandExample {
	label: string;
	text: string;
}

/**
 * Any instantiation of `Command`, for the places that hold a command without
 * caring what it declared -- a registry, a `commands` map, the internal side.
 * `any` rather than the wide defaults on purpose: a command whose `run` takes a
 * narrow `argv` is not assignable to one whose `run` takes a wide one, because a
 * function parameter is contravariant, and every `commands` map would reject its
 * own contents.
 */
export type AnyCommand = Command<any, any>;

/**
 * A command declaration.
 *
 * The two type parameters are what `command()` infers, and they exist so that
 * `run()` knows what `argv` holds. Left off, they are the wide types and `argv` is
 * `Record<string, unknown>` -- which is what it has always been, so every
 * declaration written without `command()` is unaffected.
 */
export interface Command<
	O extends OptionDeclarations = OptionDeclarations,
	A extends readonly (string | Argument)[] = readonly (string | Argument)[],
> {
	[key: string]: unknown; // custom data
	alias?: string | string[];
	args?: A;
	choices?: readonly unknown[];
	commands?: Record<string, AnyCommand>;
	default?: boolean;
	desc?: string;
	/**
	 * Descriptions a build lifted out of the modules this command's own
	 * directory holds, so help can name them without importing them. Only
	 * meaningful on a command whose subcommands come from a path. See
	 * `RouteInfo`.
	 */
	routeInfo?: Record<string, RouteInfo>;
	examples?: CommandExample | CommandExample[];
	help?: string | HelpRenderer;
	hidden?: boolean;
	/**
	 * The command's module, as a function that imports it.
	 *
	 * `path` said the same thing as a file to read, and a bundled app has no
	 * file to read: its command modules are chunks a bundler named, reached by a
	 * dynamic `import()` the bundler rewrote. So `sigil build` emits
	 * `load: () => import('./commands/build.js')` where the unbundled tree had a
	 * `path`, and the deferral survives bundling -- which is most of the
	 * startup-time argument for having a tree at all.
	 *
	 * Otherwise it is `path` exactly: the module it resolves to *is* the command,
	 * its default export is merged over what the declaration left `undefined`,
	 * and it is not called until the command is matched or help describes it.
	 * Which is why it cannot be combined with either of the other two answers to
	 * "what is this command" -- see the refusal in `initCommand()`.
	 */
	load?: CommandLoader;
	hooks?: {
		beforeError?: BeforeErrorHook;
		/**
		 * Fires when this command's help is about to be rendered, to contribute
		 * titled sections. See `HelpHook`.
		 */
		help?: HelpHook;
		init?: CommandHook;
		parse?: CommandHook;
	};
	name?: string;
	options?: O;
	path?: string;
	run?: CommandRunHandler<InferArgv<O, A>> | null;
}

export interface InternalCommand extends AnyCommand {
	[Internal]: InternalCommandBase;
	name: string;
}

export interface InternalCommandBase extends InternalBase {
	aliases: Set<string>;
	args: InternalArgument[];
	/**
	 * The directory this command's declaration gave its paths relative to: the
	 * directory of the module that declared it, which for a lazily loaded
	 * command is not the directory its own `path` resolved to. `undefined` for a
	 * schema the app wrote inline, which has no file to be relative to and
	 * leaves a relative path to the process's working directory.
	 */
	baseDir?: string;
	commands: CommandRegistry;
	/**
	 * The directory this command discovers its subcommands in, walked one level
	 * by `loadCommand()`. Set only for a command that *is* a directory, which is
	 * a different thing from `baseDir`: that one says what a declaration's
	 * relative paths are resolved against and is set for every command that came
	 * from a file.
	 */
	dir?: string;
	label: string;
	/**
	 * What a build lifted out of the modules in `dir`, consulted by the walk.
	 * Carried rather than looked up, because a nested directory's own entries
	 * live under its parent's and the walk is the only thing that knows where
	 * in that tree it is.
	 */
	routeInfo?: Record<string, RouteInfo>;
	/**
	 * Whether `loadCommand()` has finished with this command. Always set: it
	 * starts `false` and flips once there is nothing left to fetch — either the
	 * module came in, or the command never had one. A load that throws leaves it
	 * `false` so the next match tries again.
	 */
	loaded: boolean;
	/** The command's module as a function, for a tree a bundler generated. */
	load?: CommandLoader;
	options: OptionRegistry;
	path?: string;
}

/**
 * Fetches a command's module.
 *
 * Whatever it resolves with is read for a `default` the way an imported module
 * is, so `() => import('./build.js')` is the whole of the ordinary use.
 */
export type CommandLoader = () => Promise<unknown>;

export type CommandHook =
	| (() => Promise<void> | void)
	| ((state: CommandHookData) => Promise<void> | void);

export type CommandHookData = InternalCommandBase & {
	cmd: Command;
};

/**
 * Contributes titled sections to a command's help screen.
 *
 * For options a command has but does not own: a `build` command whose
 * per-platform options are only in effect for the platform that was named still
 * has to describe all of them, and adding them to its registry would make every
 * platform's options parse for every platform. A section is shown and not
 * parsed. Options that should do both are added to the registry by a `parse`
 * hook, which is a different question with a different answer.
 *
 * The hook is handed the parse state, which is the reason this is a function
 * rather than a list of sections on the declaration: `mycli build --help` and
 * `mycli build --platform ios --help` may describe different things, and which
 * is a decision for the command rather than for the framework.
 */
export type HelpHook = (data: HelpHookData) => Promise<void> | void;

/**
 * Unlike `CommandHookData` this does not spread `InternalCommandBase`, because
 * that carries a `state` of its own -- the `InternalState` of the command -- and
 * what a help hook wants under that name is the parse state. The three registries
 * worth having are named instead.
 */
export interface HelpHookData {
	/** The command's arguments, as the parser reads them. */
	args: InternalArgument[];
	/** The command being described. */
	cmd: InternalCommand;
	/** The command's subcommands. */
	commands: CommandRegistry;
	/** The command's own options. */
	options: OptionRegistry;
	/** Where sections are added. */
	sections: HelpSections;
	/** What argv said, so a hook can describe only what is relevant to it. */
	state: ParseState;
}

/** A titled group of options and arguments, added to a help screen. */
export interface HelpSection {
	args?: (string | Argument)[];
	/**
	 * Read the same way `Command.options` is. A `group` on one of them is ignored:
	 * the section is already the group.
	 */
	options?: OptionDeclarations;
	/**
	 * The section's subject. Help appends the word, so `'Android'` reads as
	 * `Android options:`.
	 */
	title: string;
}

/**
 * Collects the sections a command's `help` hooks contribute, in the order they
 * are added.
 */
export interface HelpSections {
	/**
	 * Adds a section. The declarations go through the same initialization the
	 * schema's own do, so a contributed option is described exactly as a declared
	 * one is -- spellings, hint, default, `hidden`, and all.
	 */
	add(section: HelpSection): Promise<void>;
}

export type DataTransformer = (value: string) => unknown;

export type OptionDataType = DataType | 'count';

/**
 * A set of options, keyed by format string.
 *
 * `null` and `undefined` declare a format and nothing else; a string is the
 * description. The same shape wherever options are declared -- a schema, a
 * command, a help section, and an `options()` group.
 */
export type OptionDeclarations = Record<string, string | Option | undefined | null>;

/**
 * All properties are optional because most of them can be populated by the
 * format key of the `Command.options`.
 */
export interface Option {
	[key: string]: unknown; // custom data
	alias?: string | string[];
	choices?: readonly unknown[];
	default?: unknown;
	desc?: string;
	env?: string | string[];
	format?: string;
	/**
	 * The help section this option is listed under. Options that declare no group
	 * share one section; each group named here becomes one of its own, in the
	 * order the groups are first seen.
	 *
	 * The name is a noun and help appends the word, so `'Advanced'` reads as
	 * `Advanced options:`.
	 */
	group?: string;
	hidden?: boolean;
	hint?: string;
	multiple?: boolean;
	name?: string;
	negate?: boolean;
	required?: boolean;
	transform?: Transformer;
	type?: OptionDataType | string;
}

export interface InternalOption extends Option {
	[Internal]: InternalOptionBase;
	name: string;
	type: OptionDataType;
}

export interface InternalOptionBase extends InternalBase {
	dest: string;
	envs: Set<string>;
	/** The parser supplied the default, the declaration did not. */
	impliedDefault: boolean;
	isFlag: boolean;
	label: string;
	long: Set<string>;
	/** The negated flag declared alongside this option, sharing its destination. */
	negatedTwin?: InternalOption;
	/**
	 * The parser added this option, rather than the schema declaring it, so its
	 * value is the parser's business and never reaches `argv`. `--help` is the
	 * only one: a flag always has a value, and an app that never declared this one
	 * should not find `help: false` among its parsed values.
	 */
	parserOwned?: boolean;
	short: Set<string>;
	/** Another option owns the default for the destination they share. */
	skipDefault: boolean;
}

export interface ParseOptions {
	argv?: string[];
	env?: Record<string, string | undefined>;
	cwd?: string;
	schema?: Schema;
	settings?: Settings;
}

export type ParsedType = 'Command' | 'Extra' | 'Option' | 'Unknown' | 'UnknownOption';

export interface ParsedBase {
	inputs: (string | undefined)[];
	/**
	 * The token exactly as it appeared in argv, before `--opt=value` was split
	 * into separate inputs. An option that consumes this token as its value
	 * needs the original spelling back, otherwise the part after the `=` is
	 * silently lost.
	 */
	orig?: string;
	type: ParsedType;
}

export interface ParsedCommand extends ParsedBase {
	cmd: InternalCommand;
	type: 'Command';
}

export interface ParsedExtra extends ParsedBase {
	type: 'Extra';
}

export interface ParsedOption extends ParsedBase {
	option: InternalOption;
	type: 'Option';
	value?: unknown;
}

export interface ParsedUnknown extends ParsedBase {
	type: 'Unknown';
}

/**
 * An option-like token that no context declared. It still produces a value on
 * `argv` unless `settings.allowUnknownOptions` is `false`.
 */
export interface ParsedUnknownOption extends ParsedBase {
	dest: string;
	type: 'UnknownOption';
	value: unknown;
}

export type ParsedValue =
	| ParsedCommand
	| ParsedExtra
	| ParsedOption
	| ParsedUnknown
	| ParsedUnknownOption;

export interface ParseState<Argv = Record<string, unknown>> {
	$orig: string[];
	$: ParsedValue[];
	_: unknown[];
	argv: Argv;
	cmd?: InternalCommand;
	contexts: InternalCommand[];
	env: Record<string, string | undefined>;
	/**
	 * Set when argv asked for help rather than for work. `main()` prints it and
	 * runs nothing; a caller using `parse()` on its own decides for itself.
	 */
	help?: HelpRequest;
	schema: Schema;
	settings: Settings;
}

export interface Schema {
	args?: (string | Argument)[];
	/**
	 * The directory this schema's relative paths resolve against.
	 *
	 * A schema an app wrote inline has no file to be relative to, so without
	 * this a relative `commands` resolves from the process's working directory
	 * -- which for an installed CLI is wherever the user was standing and has
	 * nothing to do with where the command modules live.
	 *
	 * `sigil build` resolves the same declaration against the *entry module's*
	 * directory, so leaving this unset is how one `commands: './commands'` comes
	 * to mean two different things: the tree the build bakes in, and the tree the
	 * runtime cannot find. `import.meta.dirname` is what closes that, and it
	 * keeps `commands` a string literal the build can still read statically:
	 *
	 * ```js
	 * export default {
	 *   name: 'mycli',
	 *   baseDir: import.meta.dirname,
	 *   commands: './commands',
	 * };
	 * ```
	 *
	 * A command *loaded from a module* never needs this -- it already resolves
	 * against the file that declared it. This is for the one declaration that
	 * has no file, which is the one the app hands to `main()`.
	 */
	baseDir?: string;
	commands?: string | (string | AnyCommand)[] | Record<string, string | AnyCommand>;
	/**
	 * Whether to add `--help` and a `help` command. On unless set to `false`; an
	 * app that declares either of them keeps its own either way.
	 */
	help?: boolean;
	/**
	 * Descriptions a build lifted out of the modules `commands` points at, so
	 * that help can name them without importing anything. See `RouteInfo`.
	 */
	routeInfo?: Record<string, RouteInfo>;
	hooks?: {
		beforeParse?: SchemaHook;
		afterParse?: SchemaHook;
		/**
		 * Fires on the way out of any error. Commands in the context chain
		 * declare their own, and those run first; see `BeforeErrorHook`.
		 */
		beforeError?: BeforeErrorHook;
	};
	name?: string;
	options?: OptionDeclarations;
}

/**
 * What a build lifted out of the command modules a directory holds.
 *
 * `Route.desc` says why this exists: a package describes itself in its
 * `package.json`, which is a file read, while every other kind keeps its
 * description *inside the module* -- so a filesystem tree lists by name alone
 * until each module has been imported, and importing them is the one thing the
 * deferral exists to avoid. `sigil build` reads those descriptions statically;
 * this is where it puts them.
 *
 * It is a cache over the walk rather than a replacement for it. The directory
 * is still read, every route it finds is still a command, and a route with no
 * entry here behaves exactly as it did before -- which is what keeps a command
 * dropped in after the build from being invisible.
 *
 * So the filesystem always wins where it has an answer: a package's own
 * manifest beats this, because that read is free and cannot go stale. This
 * fills only what the filesystem cannot say.
 */
export interface RouteInfo {
	/** What the build lifted from a directory route's own children. */
	readonly commands?: Record<string, RouteInfo>;
	/** What the command does. */
	readonly desc?: string;
	/** Whether it is hidden, which the build lifts alongside the description. */
	readonly hidden?: boolean;
}

/**
 * Fires for every error on its way out of `parse()` or `main()`, before the
 * error is rendered, handed to a custom handler, or rethrown.
 *
 * A hook may observe the error, mutate it, or return a replacement -- it may
 * never suppress it. Returning `undefined`, which is what a hook that only
 * looks returns, keeps the error as it is; returning anything else makes that
 * value the error from there on. A hook that throws is logged under
 * `DEBUG=sigil:error` and skipped, leaving the error it was given in flight.
 *
 * Neither argument can be narrower than this: anything at all can be thrown,
 * and an error raised before there was a parse state -- an invalid schema, an
 * option format that will not parse -- arrives without one.
 *
 * @param err - The thrown value.
 * @param state - The parse state, when parsing got far enough to produce one.
 * @returns A replacement error, or `undefined` to keep the current one.
 */
export type BeforeErrorHook = (
	err: unknown,
	state: ParseState | undefined
) => unknown | Promise<unknown>;

export type SchemaHook =
	| (() => Promise<void> | void)
	| ((state: ParseState) => Promise<void> | void);

export interface Settings {
	allowExtraArguments?: boolean;
	allowUnexpectedArguments?: boolean;
	allowUnknownOptions?: boolean;
	assertCwd?: boolean;
	/**
	 * How `main()` deals with an error thrown by `parse()` or by the matched
	 * command's `run()`.
	 *
	 * Unset, the built-in `errorHandler()` renders the message to stderr, sets
	 * `process.exitCode`, and `main()` resolves with `undefined`. Set it to
	 * `false` to have `main()` rethrow instead and handle the error yourself,
	 * or to a function to replace the built-in handler entirely.
	 */
	errorHandler?: ErrorHandler | false;
	/**
	 * The exit code `main()` sets after printing help. Defaults to `0`: being
	 * asked what a command does and answering is not a failure.
	 */
	helpExitCode?: number;
}

/**
 * What the error path knows beyond the error itself. Phase 3's help rendering
 * reads the matched command off `state` to print the relevant usage line.
 */
export interface ErrorContext {
	/** The parse state, when parsing got far enough to produce one. */
	state?: ParseState;
}

/**
 * Turns a thrown value into the text written to stderr. Replacing this is how
 * richer rendering -- usage lines, ANSI color -- plugs in.
 */
export type ErrorRenderer = (err: unknown, ctx: ErrorContext) => string;

/**
 * A complete replacement for the built-in error handler, set via
 * `Settings.errorHandler`. It owns the output and the exit code. A handler
 * that throws rejects `main()` -- that is a bug in the handler, and hiding
 * it would leave nothing at all reporting the original error.
 */
export type ErrorHandler = (err: unknown, ctx: ErrorContext) => Promise<void> | void;

export interface ErrorHandlerOptions extends ErrorContext {
	/** Replaces the default renderer. */
	render?: ErrorRenderer;
	/** Where the rendered error is written. Defaults to `process.stderr`. */
	stderr?: NodeJS.WritableStream;
}
