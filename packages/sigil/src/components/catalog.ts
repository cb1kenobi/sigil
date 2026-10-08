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
	type ParsedValue,
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
	/**
	 * What the parse matched, which is where the name argv reached each context
	 * by comes from. Optional, because a caller may hand over a chain and
	 * nothing else; without it a context contributes its own `name`, which is
	 * right for every command but one whose module renamed it.
	 */
	$?: readonly ParsedValue[];
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
/**
 * The name argv reached a command by, which is not always the command's own.
 *
 * A loaded module's `name` wins over the placeholder's, and the registry is
 * keyed by the placeholder's -- so a `{ path }` whose module declares a
 * different `name` is matched as one thing and calls itself another, and only
 * the placeholder's name routes. Measured: such a command in the chain made the
 * catalog emit a path the parser refuses with `Unexpected argument`, which is a
 * palette offering something it cannot run.
 *
 * Matched by identity against what the parse recorded rather than by walking the
 * chain's registries, because the loaded command is a *copy* -- the registry
 * still holds the placeholder, so an identity lookup there finds nothing, and
 * nothing on the loaded command remembers the name it was reached by: its own
 * `name`, its internal `label` and its aliases are all the module's.
 *
 * A command argv never named has no entry, which is exactly a `default` one, and
 * its own `name` is both the fallback and the right answer -- there is no token
 * to prefer, and a default is dispatched by being the only one marked so.
 *
 * @param cmd - A context.
 * @param named - What the parse matched, by command.
 * @returns The token that reaches it.
 */
function matchedName(cmd: InternalCommand, named: Map<InternalCommand, string>): string {
	return named.get(cmd) ?? cmd.name;
}

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
 * Every argument the command itself declares, in declaration order, required or
 * not -- an optional one is a value somebody may want to give, and the palette's
 * own prompting stops at the first one left empty. Its own arguments and no
 * ancestor's, because `processArgs()` reads the positional values against
 * `contexts[0]` alone: an ancestor's arguments are never read once a subcommand
 * is dispatched, which this file records from the other side.
 *
 * Then every **required option** across the **chain** that nothing else answers
 * for. That is not in the ticket's scope and it closes a real divergence: a
 * required option is a value the command needs exactly as an argument is, so a
 * palette that listed such a command and did not ask for it would hand the
 * parser an argv the parser refuses -- `Missing required options`, from a list
 * whose job is to offer things that work.
 *
 * The chain and not the command, which is the half the first version got wrong:
 * `validateOptions()` flattens **every** context's options and reports a required
 * one with no value, so a root-level `'--config <file>'` with no default is
 * enforced when a subcommand runs -- and the palette asked for none of it. Found
 * by a review round pointed at `parse.ts` rather than at the diff.
 *
 * What counts as answered is `processOptions()`'s own precedence read back: an
 * option answers for its destination when it has an environment value, or a
 * `default` the parser will apply -- which is not the same as having one, because
 * `skipDefault` is how a negated twin gives the destination up to its valued
 * twin, and `parserOwned` suppresses both. A destination a nearer declaration
 * already fills is not asked for twice, because what `validateOptions()` reads is
 * the **destination** rather than the option.
 *
 * A **negated** flag is never among the questions: a flag always has a value, so
 * the parser gives it an implied default and it is never required.
 *
 * @param chain - The command, then its ancestors, ending at the schema's root --
 *   which is the shape `ParseState.contexts` has.
 * @param env - The environment, if there is one to read.
 * @returns The slots, arguments first and then the options innermost first.
 */
export function slotsFor(
	chain: readonly InternalCommand[],
	env?: Record<string, string | undefined>
): PaletteSlot[] {
	const cmd = chain[0];

	if (!cmd) {
		throw new TypeError('Expected a command chain to read slots from');
	}

	const slots: PaletteSlot[] = [];
	/** Destinations something will fill without being asked. */
	const answered = new Set<string>();
	/** Destinations a slot above will fill. */
	const asked = new Set<string>();

	for (const arg of cmd[Internal].args) {
		const { dest, envs } = arg[Internal];

		slots.push({
			choices: Array.isArray(arg.choices) ? arg.choices : undefined,
			desc: typeof arg.desc === 'string' ? arg.desc : undefined,
			label: argLabel(arg),
			multiple: !!arg.multiple,
			required: !!arg.required,
			type: arg.type,
		});

		// a *required* argument always comes back with a value, and an optional one
		// only where its own fallback fills the slot it was skipped at. An optional
		// argument with neither is deliberately not counted, because over-skipping
		// is the direction that puts the defect back
		if (arg.required || arg.default !== undefined || fromEnv(envs, env)) {
			answered.add(dest);
		}
	}

	const options = chain.flatMap((ctx) => [...ctx[Internal].options.values()]);

	// what the parse will fill on its own, read before anything is asked: a
	// nearer option's default answers for an outer option of the same destination
	// whichever order the two are seen in
	for (const opt of options) {
		const { dest, envs, parserOwned, skipDefault } = opt[Internal];

		// the parser's own flags answer for nothing, and this is a declared
		// statement rather than a guard a test can see: deleting it passes all
		// 5,264 of them. It is kept because what makes it safe to delete is two
		// steps rather than an impossibility -- a flag carries a `false` default,
		// so without this their destinations would join `answered`, which is then
		// harmless only because the ask pass below skips a flag for not being
		// `required`. There are two of them, `--help` and `--version`
		if (parserOwned) {
			continue;
		}
		if (fromEnv(envs, env) || (!skipDefault && opt.default !== undefined)) {
			answered.add(dest);
		}
	}

	for (const opt of options) {
		const { dest } = opt[Internal];
		const spelling = spellingOf(opt);

		// `spelling === undefined` is the narrowing rather than a guard: every
		// initialized option has at least one spelling, because `initOption()`
		// refuses a declaration that names none and gives a bare name a `--name`,
		// so this cannot fire. It is what lets the slot carry a `string` without a
		// cast -- and it used to be reachable, through the `no-` filter above,
		// which is what made this comment false rather than merely optimistic
		if (!opt.required || answered.has(dest) || asked.has(dest) || spelling === undefined) {
			continue;
		}

		asked.add(dest);
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

	// the token argv reached each matched command by, which is what routes
	const named = new Map<InternalCommand, string>();
	for (const value of target.$ ?? []) {
		if (value.type === 'Command' && typeof value.inputs[0] === 'string') {
			named.set(value.cmd, value.inputs[0]);
		}
	}

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
	 * @param above - `cmd`'s own ancestors, innermost first, so that a child's
	 *   chain is the one `parse()` would build for it -- which is what
	 *   `slotsFor()` has to read, since a required option on an ancestor is
	 *   enforced when a subcommand runs.
	 */
	function walk(
		cmd: InternalCommand,
		path: string[],
		argv: string[],
		above: InternalCommand[]
	): void {
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
			// what is *shown* is the canonical name and what is *dispatched* is the
			// name argv reaches the command by, and the two part company above a
			// renamed context -- see `matchedName()`. For a child they agree, since
			// a registry is keyed by `cmd.name` and nothing has renamed one yet
			const reach = [...argv, child.name];
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
					path: reach,
					search: aliases.length > 0 ? `${key} ${aliases.join(' ')}` : key,
					slots: slotsFor([child, cmd, ...above], env),
				});
			}

			// whatever its registry holds, which for a placeholder is either nothing
			// -- a directory nobody has walked -- or the subcommands it declared
			// inline, and those are real. There was a `!deferred` guard here and a
			// sabotage said it could not change an answer in the first case and hid
			// real commands in the second
			walk(child, here, reach, [cmd, ...above]);
		}
	}

	for (const [depth, ctx] of contexts.entries()) {
		// the path to this context: the chain is innermost-first and ends at the
		// root, whose name is the schema's and is not part of argv
		const chain = contexts.slice(depth, -1).reverse();

		walk(
			ctx,
			chain.map((c) => c.name),
			chain.map((c) => matchedName(c, named)),
			contexts.slice(depth + 1)
		);
	}

	return entries;
}
