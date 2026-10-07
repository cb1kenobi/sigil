/**
 * The command catalog: the parser's own registries, read as a list.
 *
 * This is the whole claim the palette rests on, and it is why only a framework
 * that owns an argument parser can have one cheaply. There is no second catalog
 * to declare and keep in agreement with the first -- names, aliases,
 * descriptions, `hidden`, arguments and required options are all things the app
 * already told the parser, and this reads them back exactly as help does. A
 * palette that read `cmd.desc` off a *declaration* instead would be a second
 * reader of one rule; everything here is read off the initialized command, at
 * `cmd[Internal]`, which is the shape the parser matches against.
 *
 * Pure, and it imports nothing but the `Internal` symbol and types: no element
 * tree, no renderer, no reactivity. That is the rule the layout engine and the
 * selector engine already keep, and it is what lets every assertion about what
 * is listed be written against a literal.
 */

import {
	Internal,
	type InternalArgument,
	type InternalCommand,
	type InternalOption,
	type OptionDataType,
	type Schema,
} from '../types.js';

/**
 * What the palette needs to know, which is what `parse()` already built.
 *
 * `ParseState` satisfies this, so the state a parse produced -- or the state an
 * error carries -- can be handed straight to `commandCatalog()`. The shape is
 * `HelpTarget`'s plus the environment, for the reason `slotsFor()` records: a
 * required option a variable already answers for is not a question to ask.
 */
export interface CatalogTarget {
	/** The command chain, innermost first, ending at the schema's root. */
	contexts: InternalCommand[];
	/** The environment, as the parse read it. */
	env?: Record<string, string | undefined>;
	/** The schema, for the program's name. */
	schema?: Schema;
}

export interface CatalogOptions {
	/** The environment, when the target does not carry one. */
	env?: Record<string, string | undefined>;
	/**
	 * Whether to list a command that holds other commands and has no `run` of
	 * its own. Defaults to `false`.
	 *
	 * A namespace -- a directory with no `index` module, or a command declared
	 * only to hold subcommands -- matches, lists what is under it, and has
	 * nothing to run. Selecting one is still a coherent thing to do, because
	 * `main()` prints its help, so this is an opt-in rather than a refusal; left
	 * off it is noise in a list whose whole job is to be short.
	 *
	 * What it does **not** leave out is a *leaf* with no `run`, and that is a
	 * correction rather than a nicety: `help` is exactly one -- the parser
	 * dispatches it by setting `state.help` rather than through a handler -- so a
	 * gate written as "has a `run`" left the one command every schema gets for
	 * free out of the list. A command is a namespace because it holds others, not
	 * because it has no handler.
	 *
	 * A command whose module has **not** been read is listed either way, since
	 * whether it has a `run` is in that module.
	 */
	namespaces?: boolean;
}

/**
 * A value the chosen command needs before it can be run.
 *
 * A projection rather than the declaration itself, and the two kinds are one
 * shape on purpose: an argument and a required option differ in how a value
 * reaches argv and in nothing else a prompt cares about, so there is one prompt
 * builder rather than two that have to agree about `choices` and `multiple`.
 * Plain data, so a test can write one.
 */
export interface PaletteSlot {
	/** The values it will accept, if the declaration named any. */
	readonly choices?: readonly unknown[];
	/** What it is for, as help prints it. */
	readonly desc?: string;
	/** What a prompt asks under: `<entry>` for an argument, `--port <n>` for an option. */
	readonly label: string;
	/** Whether it takes more than one value. */
	readonly multiple: boolean;
	/** Whether a value has to be given. */
	readonly required: boolean;
	/**
	 * The argv spelling a value is attached to, for an option.
	 *
	 * Absent for an argument, which is positional. Present and dashed for an
	 * option -- `--port`, or `-p` where that is the only spelling the registry
	 * answers to -- because `slotTokens()` attaches the value with an `=`.
	 */
	readonly spelling?: string;
	/**
	 * The data type a value is coerced with, which is what a prompt validates
	 * against.
	 *
	 * `OptionDataType` rather than `ArgDataType`, because it is the wider of the
	 * two: an option may be a `count` and an argument may not, and one slot shape
	 * for both is what keeps there being one prompt builder.
	 */
	readonly type: OptionDataType;
}

/** One row of the palette. */
export interface PaletteEntry {
	/** The command, as the registry holds it. */
	readonly cmd: InternalCommand;
	/** What it is for. Absent until its module has been loaded, exactly as in help. */
	readonly desc?: string;
	/** The aliases it also answers to, sorted. */
	readonly aliases: readonly string[];
	/**
	 * Whether there is a module behind it that nothing has read.
	 *
	 * `true` for a lazily loaded command and for a route a directory walk found,
	 * and `false` for everything else -- including a command declared inline,
	 * which has no module to wait for. Such an entry has no description and no
	 * subcommands under it in the list, because both live in that module; see
	 * `commandCatalog()`.
	 *
	 * Not `cmd[Internal].loaded`, which is a different question and was the first
	 * answer: that flag says whether `loadCommand()` has *finished*, and it starts
	 * `false` and is only ever flipped by a dispatch -- so an ordinary inline
	 * command that argv never named reads as unloaded, and reading it that way
	 * stopped the walk at the first level and listed every namespace as a command
	 * that might have a `run`. What a palette has to know is whether anything is
	 * still outstanding, which is `loaded` *or* there never was a module.
	 */
	readonly deferred: boolean;
	/** What is shown: the argv path, spaced. */
	readonly label: string;
	/** The argv path from the root, which is what running it means. */
	readonly path: readonly string[];
	/**
	 * What the query is matched against: the label, then the aliases.
	 *
	 * Separate from `label` so that an alias hit ranks without being highlighted:
	 * `highlightRuns()` ignores an index past the end of what it is given, so a
	 * match inside the alias tail simply highlights nothing. The cost is the one
	 * `rankBy()` records -- a command with aliases loses a score tie to one
	 * without -- which decides nothing but the order of two equally good matches.
	 */
	readonly search: string;
	/** The values it needs before it can be run, in the order they are asked for. */
	readonly slots: readonly PaletteSlot[];
}

/**
 * The argv tokens a slot's answers come to.
 *
 * An argument's values are positional and go in as they are. An option's are
 * attached with an `=`, which is the one spelling that is safe for a value
 * beginning with a dash: the parser splits `--name=value` on the first `=` and
 * takes the value exactly as typed, where a value in the *following* token is
 * left alone only when it does not resolve to a declared option. A `multiple`
 * option repeats its spelling, which is how the parser collects repeated uses.
 *
 * @param slot - The slot.
 * @param values - What was answered, in order.
 * @returns The tokens, in order.
 */
export function slotTokens(slot: PaletteSlot, values: readonly string[]): string[] {
	return slot.spelling === undefined
		? [...values]
		: values.map((value) => `${slot.spelling}=${value}`);
}

/**
 * The dashed spelling the registry answers to, for an option.
 *
 * It has to be a spelling rather than the bare name, because `OptionRegistry`
 * keys its lookup on what gets typed: an option declared `'-p <n>'` is named
 * `p` and has no long spelling at all, so `--p=5` resolves to nothing while
 * `-p=5` resolves -- the parser splits either on the first `=` and then looks
 * the name half up.
 *
 * Preferring a long name that is not a `no-` form is a **preference with a
 * fallback**, and it was written as a filter -- which dropped a required option
 * on the floor. `initOption()` rewrites a `no-` name only for a *flag*, so a
 * valued `{ format: '--no-color <when>' }` keeps `--no-color` as its only
 * spelling: the filter answered `undefined`, `slotsFor()` skipped the slot, and
 * the palette emitted an argv the parse then refused with `Missing required
 * options`. Found by review. A *negated* flag never reaches any of this,
 * because a flag has an implied default and the default test already skips it.
 *
 * So what the preference decides is the label a prompt is asked under -- where
 * `--no-color <v>` reads as a negation it is not -- and the fallback is what
 * keeps it a label decision rather than a dropped value. Both spellings resolve
 * either way: `OptionRegistry` keys its lookup on every long name an option
 * declares.
 *
 * @param opt - The option.
 * @returns The spelling, or `undefined` for an option nothing can type.
 */
function spellingOf(opt: InternalOption): string | undefined {
	const { long, short } = opt[Internal];

	for (const name of long) {
		if (!name.startsWith('--no-')) {
			return name;
		}
	}
	for (const name of long) {
		return name;
	}
	for (const name of short) {
		return name;
	}
}

/**
 * Whether a command is still waiting for a module.
 *
 * `loaded` alone is the wrong question, for the reason `PaletteEntry.deferred`
 * records: it starts `false` and only a dispatch flips it, so an inline command
 * nothing has run reads as unloaded. What is outstanding is a module that
 * `loadCommand()` has not fetched -- a `path`, a `load`, or a directory to walk
 * -- and a command with none of those has nothing to wait for.
 *
 * @param cmd - The command.
 * @returns Whether its description and its subcommands are still unknown.
 */
function isDeferred(cmd: InternalCommand): boolean {
	const { dir, load, loaded, path } = cmd[Internal];
	return !loaded && (path !== undefined || load !== undefined || dir !== undefined);
}

/** `<name>` or `[name...]`, which is how an argument is spelled where it is typed. */
function argLabel(arg: InternalArgument): string {
	const name = `${arg.name}${arg.multiple ? '...' : ''}`;
	return arg.required ? `<${name}>` : `[${name}]`;
}

/**
 * Whether the environment already answers for a declaration.
 *
 * The same rule `envValue()` keeps: an empty variable is read as unset, because
 * `PORT=` in a shell or a `.env` file is how a variable gets left blank and
 * almost always means "not configured". Without an environment to read, nothing
 * is answered for -- which asks a question that did not need asking, and never
 * skips one that did.
 *
 * @param envs - The variables the declaration names.
 * @param env - The environment, if there is one to read.
 * @returns Whether one of them has a value.
 */
function fromEnv(envs: Set<string>, env: Record<string, string | undefined> | undefined): boolean {
	if (!env) {
		return false;
	}
	for (const name of envs) {
		if (env[name]) {
			return true;
		}
	}
	return false;
}

/**
 * The values a command needs before it can be run.
 *
 * Every argument it declares, in declaration order, required or not -- an
 * optional one is a value somebody may want to give, and the palette's own
 * prompting stops at the first one left empty.
 *
 * Then every **required option** that nothing else answers for. That is not in
 * the ticket's scope and it closes a real divergence: a required option is a
 * value the command needs exactly as an argument is, so a palette that listed
 * such a command and did not ask for it would hand the parser an argv the parser
 * refuses -- `Missing required option`, from a list whose job is to offer things
 * that work. A required option with a `default`, or with an environment variable
 * that has a value, is already answered and is not asked for, which is the same
 * precedence the parse applies: argv, then the environment, then the default.
 *
 * A **negated** flag is never among them: a flag always has a value, so the
 * parser gives it an implied default and it is never required.
 *
 * @param cmd - The command.
 * @param env - The environment, if there is one to read.
 * @returns The slots, arguments first.
 */
export function slotsFor(
	cmd: InternalCommand,
	env?: Record<string, string | undefined>
): PaletteSlot[] {
	const internal = cmd[Internal];
	const slots: PaletteSlot[] = [];

	for (const arg of internal.args) {
		slots.push({
			choices: Array.isArray(arg.choices) ? arg.choices : undefined,
			desc: typeof arg.desc === 'string' ? arg.desc : undefined,
			label: argLabel(arg),
			multiple: !!arg.multiple,
			required: !!arg.required,
			type: arg.type,
		});
	}

	for (const opt of internal.options.values()) {
		const { envs } = opt[Internal];
		const spelling = spellingOf(opt);

		// `parserOwned` was a fourth condition here and is gone: `--help` is the
		// only option the parser adds, it is a flag, and a flag is never
		// `required` -- so the first condition already answered for it and a
		// sabotage of the fourth failed nothing.
		//
		// `spelling === undefined` is the narrowing rather than a guard: every
		// initialized option has at least one spelling, because `initOption()`
		// refuses a declaration that names none and gives a bare name a `--name`,
		// so this cannot fire. It is what lets the slot carry a `string` without a
		// cast -- and it used to be reachable, through the `no-` filter above,
		// which is what made this comment false rather than merely optimistic
		if (
			!opt.required ||
			opt.default !== undefined ||
			fromEnv(envs, env) ||
			spelling === undefined
		) {
			continue;
		}

		slots.push({
			choices: Array.isArray(opt.choices) ? opt.choices : undefined,
			desc: typeof opt.desc === 'string' ? opt.desc : undefined,
			label: `${spelling} <${opt.hint ?? opt.name}>`,
			multiple: !!opt.multiple,
			required: true,
			spelling,
			type: opt.type,
		});
	}

	return slots;
}

/**
 * Every command reachable from where the parse ended up, as a list.
 *
 * Scoped to the context chain, which is what the parser already walks: the
 * innermost command's subtree first, then each ancestor's, ending at the root's.
 * Nearer first is help's own rule for the options it lists under `Global
 * options`, and within one context the commands are sorted by name, which is
 * also help's -- a registry's order is the order its initialization resolved in,
 * which for a directory of modules is whatever the file system felt like.
 *
 * The path is from the **root**, so an ancestor's command is listed with the path
 * that reaches it. That matters because commands resolve against the innermost
 * context only -- `mycli db build` does not reach the root's `build` -- while
 * running a palette selection is dispatching an argv from the start, where
 * `['build']` does.
 *
 * **Nothing is imported.** A command whose module has not been loaded is listed
 * by name alone with no description and no subcommands under it, which is
 * exactly what help does and is the whole of what the deferral buys: a routed
 * tree of sixty commands costs one `readdir` per level argv named, and a palette
 * that imported every module to fill in a list would spend the saving to draw
 * one frame. Such an entry still **runs**, because `parse()` loads the command
 * when argv names it.
 *
 * A `hidden` command takes its subtree with it. `hidden` means "not listed", and
 * a list that named a hidden command's children would have named the branch
 * anyway -- one `!` prefix hiding a subtree is what somebody writing one means.
 * A hidden command that is itself **in the chain** is the one exception, and it
 * falls out rather than being arranged: a context is in the chain because argv
 * named it, so its subcommands are listed from there. A command you are already
 * running is not hidden from you, and the alternative is an empty palette at the
 * level you are standing on.
 *
 * @param target - The parse state, or anything carrying a context chain.
 * @param opts - What to leave out.
 * @returns The entries, nearest context first.
 */
export function commandCatalog(target: CatalogTarget, opts: CatalogOptions = {}): PaletteEntry[] {
	const contexts = target?.contexts;

	if (!Array.isArray(contexts) || contexts.length === 0) {
		throw new TypeError('Expected a context chain to build a catalog from');
	}

	const env = opts.env ?? target.env;
	const entries: PaletteEntry[] = [];
	/**
	 * The commands whose registries have been read.
	 *
	 * It bounds a cycle, which is reachable: a registry holds initialized commands
	 * and `initCommand()` hands one straight back, so a declaration that names a
	 * command already in its own subtree builds a cycle rather than a copy.
	 * Nothing in this repository writes one, and a palette that overflowed the
	 * stack over it would be a worse answer than a list that stops.
	 *
	 * It is also what makes a second, path-keyed dedup unnecessary -- there was
	 * one, and a sabotage said it could never fire. Every parent is walked at most
	 * once, so a path and a child name cannot be produced twice. What that costs
	 * is that the guard is path-*insensitive*: one command registered under two
	 * parents is listed under both, and its own subtree is listed under whichever
	 * path the walk reached first. Written down rather than fixed, because a
	 * path-keyed guard would be unbounded on a cycle again.
	 */
	const seen = new Set<InternalCommand>();

	/**
	 * Lists one command's subcommands, then theirs.
	 *
	 * @param cmd - The command whose registry to read.
	 * @param path - The argv path that reaches it, from the root.
	 */
	function walk(cmd: InternalCommand, path: string[]): void {
		if (seen.has(cmd)) {
			return;
		}
		seen.add(cmd);

		const children = [...cmd[Internal].commands.values()].sort((a, b) =>
			a.name.localeCompare(b.name)
		);

		for (const child of children) {
			if (child.hidden) {
				continue;
			}

			const here = [...path, child.name];
			const key = here.join(' ');
			const internal = child[Internal];
			const deferred = isDeferred(child);

			// a namespace is a command that holds others and runs nothing, which is
			// noise in a list whose job is to be short. Whether a *deferred* command
			// has a `run` is unknowable until its module is read, so one is listed on
			// the chance that it has -- which is what help does with the same
			// question, and which is reachable: a placeholder may declare subcommands
			// inline, so it holds others and has no `run` and is not a namespace
			const namespace = !deferred && typeof child.run !== 'function' && internal.commands.size > 0;

			if (opts.namespaces || !namespace) {
				const aliases = [...internal.aliases].sort();
				entries.push({
					aliases,
					cmd: child,
					deferred,
					desc: typeof child.desc === 'string' ? child.desc : undefined,
					label: key,
					path: here,
					search: aliases.length > 0 ? `${key} ${aliases.join(' ')}` : key,
					slots: slotsFor(child, env),
				});
			}

			// whatever its registry holds, which for a placeholder is either nothing
			// -- a directory nobody has walked -- or the subcommands it declared
			// inline, and those are real. There was a `!deferred` guard here and a
			// sabotage said it could not change an answer in the first case and hid
			// real commands in the second
			walk(child, here);
		}
	}

	for (const [depth, ctx] of contexts.entries()) {
		// the path to this context: the chain is innermost-first and ends at the
		// root, whose name is the schema's and is not part of argv
		walk(
			ctx,
			contexts
				.slice(depth, -1)
				.map((c) => c.name)
				.reverse()
		);
	}

	return entries;
}
