import { type Ansi, ansi as defaultAnsi } from '../ansi/index.js';
import type { OptionRegistry } from '../parser/option/option-registry.js';
import {
	type CommandExample,
	type HelpRenderer,
	Internal,
	type InternalArgument,
	type InternalCommand,
	type InternalOption,
	type ParseState,
	type Schema,
} from '../types.js';
import { terminalWidth, wrap } from '../wrap/index.js';
import { type Definition, definitions, type LayoutOptions } from './layout.js';
import { type BuiltSection, byGroup, createSections, withoutTwins } from './sections.js';
import { basename } from 'node:path';

export { type Definition, definitions, pad } from './layout.js';
export { type BuiltSection, createSections } from './sections.js';

/**
 * What help needs to know, which is what `parse()` already built.
 *
 * `ParseState` satisfies this, so the state a parse produced -- or the state an
 * error carries -- can be handed straight to `renderHelp()`. Nothing else is
 * needed: the context chain is the command being described, its ancestors, and
 * the options it inherits from each of them.
 */
export interface HelpTarget {
	/** The command chain, innermost first, ending at the schema's root. */
	contexts: InternalCommand[];
	/** The schema, for the program's name. */
	schema?: Schema;
}

export interface HelpOptions {
	/** The styler to write with. Defaults to the one bound to `process.stdout`. */
	ansi?: Ansi;
	/** The columns between a label and its description. Defaults to 2. */
	gap?: number;
	/** How far the lists are indented. Defaults to 2. */
	indent?: number;
	/**
	 * The widest a label column may get before descriptions start on their own
	 * lines. Defaults to 28.
	 */
	maxLabel?: number;
	/** The program's name, for the usage line. Defaults to the schema's name. */
	name?: string;
	/**
	 * Titled sections to list after the command's own options and before the
	 * inherited ones. `resolveHelp()` fills these in from the command's `help`
	 * hooks; a caller rendering directly supplies its own or none.
	 */
	sections?: BuiltSection[];
	/** The column to wrap at. Defaults to `terminalWidth()`. */
	width?: number;
}

/**
 * Renders the help screen for whichever command the parser ended up in.
 *
 * Context sensitive means the chain, not the schema: `mycli build --help`
 * describes `build` -- its description, its subcommands, its arguments, its own
 * options -- and then the options it inherits from everything above it. That
 * chain is what `parse()` maintains as it walks argv, so help reads it rather
 * than rebuilding it.
 *
 * Nothing marked `hidden` appears, on either a command or an option.
 *
 * A command that has not been loaded yet appears by name alone, because its
 * description and its `hidden` live in a module nothing has read: hiding a lazily
 * loaded command is what the `!` name prefix is for, since the placeholder
 * carries it and the module never sees it. Loading every command module to render
 * one screen is a decision for whatever wires help up, not for the renderer.
 *
 * @param target - The parse state, or anything carrying a context chain.
 * @param opts - Where the columns are and what to write with.
 * @returns The help screen, with no trailing newline.
 */
export function renderHelp(target: HelpTarget, opts: HelpOptions = {}): string {
	const contexts = target?.contexts;

	if (!Array.isArray(contexts) || contexts.length === 0) {
		throw new TypeError('Expected a context chain to render help for');
	}

	const ansi = opts.ansi ?? defaultAnsi;
	const width = opts.width ?? terminalWidth();
	const layout: LayoutOptions = {
		gap: opts.gap ?? 2,
		indent: opts.indent ?? 2,
		maxLabel: opts.maxLabel ?? 28,
		width,
	};

	// the visible options of each contributed section, read once: both the usage
	// line and the sections themselves need to know what is actually in them
	const contributed = (opts.sections ?? []).map((section_) => ({
		args: section_.args,
		options: optionsOf(section_.options),
		title: section_.title,
	}));
	const cmd = contexts[0]!;
	const internal = cmd[Internal];
	const commands = shown(internal.commands.values()).sort((a, b) => a.name.localeCompare(b.name));
	const options = optionsOf(internal.options);
	const { groups, ungrouped } = byGroup(options);

	// an option the command declares itself shadows the one above it -- the parser
	// resolves options across the chain innermost first -- so listing the outer one
	// under "Global options" would describe something that cannot be reached from
	// here.
	//
	// Shadowing is by spelling and not by name, because a spelling is what gets
	// typed: a command declaring a short-only `-x` does not shadow a root `--x`,
	// and `mycli build --x` still reaches the root's. An outer option is left out
	// only when every one of its spellings has been claimed by a nearer one.
	//
	// Every option claims, including a hidden one. Being hidden is about whether
	// help lists it, not about whether it resolves -- a command with a hidden
	// `--mode` is still the `--mode` that `mycli build --mode` reaches, so listing
	// the root's under "Global options" would describe the wrong one.
	const claimed = new Set([...internal.options.values()].flatMap(resolvable));
	const reachable: InternalOption[] = [];
	for (const ctx of contexts.slice(1)) {
		for (const opt of ctx[Internal].options.values()) {
			const spellings = resolvable(opt);
			if (!spellings.every((spelling) => claimed.has(spelling))) {
				reachable.push(opt);
			}
			for (const spelling of spellings) {
				claimed.add(spelling);
			}
		}
	}
	const inherited = withoutTwins(shown(reachable));
	const args = internal.args;
	// a name that is nothing but an alias -- `'@b'` -- is its own alias, and the
	// command is already named on the usage line
	const aliases = [...internal.aliases].filter((alias) => alias !== cmd.name);

	const blocks: string[][] = [
		usageLine(
			{
				args,
				ansi,
				commands: commands.length > 0,
				defaulted: internal.commands.default !== undefined,
				name: programName(target, opts),
				// a contributed section counts: options can follow, whether or not this
				// command's own registry is what ends up resolving them
				// a contributed section counts, but only when it has options in it: one
				// that contributes arguments alone is not a reason to promise options
				options:
					options.length > 0 ||
					inherited.length > 0 ||
					contributed.some((section_) => section_.options.length > 0),
				path: contexts
					.slice(0, -1)
					.reverse()
					.map((ctx) => ctx.name),
			},
			width
		).split('\n'),
	];

	if (cmd.desc?.trim()) {
		blocks.push(lines(cmd.desc, width));
	}

	// the root context is the schema, and its aliases are nobody's business: what
	// would be aliased is the program, and the program is not what it declares
	if (aliases.length > 0 && contexts.length > 1) {
		const title = aliases.length === 1 ? 'Alias:' : 'Aliases:';
		blocks.push(
			wrap(`${ansi.bold(title)} ${aliases.join(', ')}`, {
				hangingIndent: title.length + 1,
				width,
			}).split('\n')
		);
	}

	if (commands.length > 0) {
		blocks.push(section('Commands', commands.map(commandRow), layout, ansi));
	}

	if (args.length > 0) {
		blocks.push(
			section(
				'Arguments',
				args.map((arg) => argRow(arg, ansi)),
				layout,
				ansi
			)
		);
	}

	if (ungrouped.length > 0) {
		blocks.push(
			section(
				'Options',
				ungrouped.map((opt) => optionRow(opt, ansi)),
				layout,
				ansi
			)
		);
	}

	// the command's own groups, then the sections its hooks contributed: both are
	// the command's, and both come before what it inherited
	for (const group of groups) {
		blocks.push(
			section(
				`${group.title} options`,
				group.options.map((opt) => optionRow(opt, ansi)),
				layout,
				ansi
			)
		);
	}

	for (const section_ of contributed) {
		blocks.push(...contributedBlocks(section_, layout, ansi));
	}

	if (inherited.length > 0) {
		blocks.push(
			section(
				'Global options',
				inherited.map((opt) => optionRow(opt, ansi)),
				layout,
				ansi
			)
		);
	}

	const examples = exampleList(cmd.examples);
	if (examples.length > 0) {
		blocks.push(exampleSection(examples, layout, ansi, width));
	}

	return blocks
		.map((block) => block.join('\n'))
		.filter((block) => block !== '')
		.join('\n\n');
}

/**
 * The registry entries help shows, in registration order.
 *
 * @param values - The registry's values.
 * @returns Everything not marked `hidden`.
 */
function shown<T extends { hidden?: boolean }>(values: Iterable<T>): T[] {
	return [...values].filter((item) => !item.hidden);
}

/**
 * The options of one registry, in the order they were declared.
 *
 * Declaration order is kept rather than sorted, because an option list is
 * usually grouped on purpose -- the interesting ones first -- and the registry
 * adds them in the order the schema wrote them.
 *
 * A negated flag paired with a valued option is left out: the two share a
 * destination and the valued one owns the row, so `--no-cheese` is printed
 * beside `--cheese [type]` rather than on a line of its own saying nothing.
 *
 * @param registry - The registry to read.
 * @returns The options to show.
 */
function optionsOf(registry: OptionRegistry): InternalOption[] {
	return withoutTwins(shown(registry.values()));
}

/**
 * The blocks one contributed section makes: its arguments, then its options.
 *
 * A section with nothing visible in it makes none, so a hook that contributed an
 * empty one -- a platform with no options of its own -- does not leave a heading
 * with nothing under it.
 *
 * @param section - The section.
 * @param layout - Where the columns are.
 * @param ansi - The styler.
 * @returns The blocks.
 */
function contributedBlocks(
	section_: { args: InternalArgument[]; options: InternalOption[]; title: string },
	layout: LayoutOptions,
	ansi: Ansi
): string[][] {
	const blocks: string[][] = [];
	const { args, options } = section_;

	if (args.length > 0) {
		blocks.push(
			section(
				`${section_.title} arguments`,
				args.map((arg) => argRow(arg, ansi)),
				layout,
				ansi
			)
		);
	}

	if (options.length > 0) {
		blocks.push(
			section(
				`${section_.title} options`,
				options.map((opt) => optionRow(opt, ansi)),
				layout,
				ansi
			)
		);
	}

	return blocks;
}

/**
 * The program's name, for the usage line.
 *
 * The root context is named from the schema, and `parse()` calls it `global`
 * when the schema did not say -- an internal placeholder, and not something to
 * print. The name of the running script is the better guess, because it is what
 * the user typed.
 *
 * @param target - The help target.
 * @param opts - The help options.
 * @returns The name to print.
 */
function programName(target: HelpTarget, opts: HelpOptions): string {
	const script = process.argv[1] ? basename(process.argv[1]) : undefined;
	return opts.name ?? target.schema?.name ?? script ?? 'cli';
}

interface UsageParts {
	ansi: Ansi;
	args: InternalArgument[];
	commands: boolean;
	defaulted: boolean;
	name: string;
	options: boolean;
	path: string[];
}

/**
 * The usage line: what to type, in the order it is typed.
 *
 * The command path is the context chain reversed, so a subcommand three deep
 * shows all three. A `[command]` is optional rather than required when one of
 * the subcommands is the default, because then leaving it out runs that one
 * instead of being an error.
 *
 * @param parts - What the line is made of.
 * @returns The usage line.
 */
function usageLine(parts: UsageParts, width: number): string {
	const line = [parts.name, ...parts.path];

	if (parts.options) {
		line.push('[options]');
	}

	if (parts.commands) {
		line.push(parts.defaulted ? '[command]' : '<command>');
	}

	for (const arg of parts.args) {
		line.push(argSpelling(arg));
	}

	const label = 'Usage:';

	// a usage line long enough to wrap hangs under the label rather than under
	// the left margin, so the continuation reads as part of the same line
	return wrap(`${parts.ansi.bold(label)} ${line.join(' ')}`, {
		hangingIndent: label.length + 1,
		width,
	});
}

/**
 * How an argument is spelled where it is typed: angle brackets when it is
 * required, square when it is not, and `...` when it takes more than one.
 *
 * @param arg - The argument.
 * @returns The spelling.
 */
function argSpelling(arg: InternalArgument): string {
	const name = arg.name + (arg.multiple ? '...' : '');
	return arg.required ? `<${name}>` : `[${name}]`;
}

/**
 * A command's row. Aliases share the row rather than taking one of their own,
 * because they are the same command.
 *
 * @param cmd - The command.
 * @returns The row.
 */
function commandRow(cmd: InternalCommand): Definition {
	// a name that is nothing but an alias -- `'@b'` -- is both the name and an
	// alias of itself, and printing it twice says nothing twice
	const names = new Set([cmd.name, ...cmd[Internal].aliases]);
	return { desc: cmd.desc, label: [...names].join(', ') };
}

/**
 * An argument's row.
 *
 * @param arg - The argument.
 * @param ansi - The styler.
 * @returns The row.
 */
function argRow(arg: InternalArgument, ansi: Ansi): Definition {
	return {
		desc: describe(arg.desc, arg.choices, arg.default, ansi),
		label: argSpelling(arg),
	};
}

/**
 * An option's row.
 *
 * The spellings come out shortest first, as `-w, --watch`, which is what lines
 * the long names up. A negated twin shares the row with the option it shares a
 * destination with, because one of them is the other one's off switch.
 *
 * @param opt - The option.
 * @param ansi - The styler.
 * @returns The row.
 */
function optionRow(opt: InternalOption, ansi: Ansi): Definition {
	const internal = opt[Internal];
	let label = spellingsOf(opt).join(', ');

	// the hint belongs to the option that takes the value, so it goes before the
	// negated twin rather than after it: `--cheese [type], --no-cheese`, because
	// it is not `--no-cheese` that takes a type
	if (!internal.isFlag && opt.hint) {
		label += opt.required ? ` <${opt.hint}>` : ` [${opt.hint}]`;
	}

	if (internal.negatedTwin && !internal.negatedTwin.hidden) {
		label += `, ${spellingsOf(internal.negatedTwin).join(', ')}`;
	}

	// a default the parser supplied is not worth printing: every flag has one, and
	// "(default: false)" on each of them is noise rather than information
	const dflt = internal.impliedDefault ? undefined : opt.default;

	return { desc: describe(opt.desc, opt.choices, dflt, ansi), label };
}

/**
 * Every spelling an option answers to, which is what shadowing is decided on.
 *
 * Unlike the spellings help prints, this includes the positive form a negated
 * flag also accepts: it does not belong on the row, but it does get typed, so a
 * nearer option claiming it does shadow it.
 *
 * @param opt - The option.
 * @returns The spellings.
 */
function resolvable(opt: InternalOption): string[] {
	const internal = opt[Internal];
	const twin = internal.negatedTwin;
	return [
		...internal.short,
		...internal.long,
		...(twin ? [...twin[Internal].short, ...twin[Internal].long] : []),
	];
}

/**
 * How an option is spelled, shortest first.
 *
 * A negated flag answers to the positive spelling as well -- `--no-color` also
 * accepts `--color` -- but printing both on one row reads as two options that
 * mean opposite things. The spelling that is written is the one that does what
 * the description says.
 *
 * @param opt - The option.
 * @returns The spellings.
 */
function spellingsOf(opt: InternalOption): string[] {
	const internal = opt[Internal];
	const positive = `--${opt.name}`;
	const long = [...internal.long].filter((name) => !(opt.negate && name === positive));
	return [...internal.short, ...long];
}

/**
 * A description with whatever else is worth knowing after it.
 *
 * The parentheticals are dim, because they are there to be skipped over until
 * they are wanted.
 *
 * @param desc - The description, if there is one.
 * @param choices - The accepted values, if they are constrained.
 * @param dflt - The default, if there is one worth printing.
 * @param ansi - The styler.
 * @returns The description.
 */
function describe(
	desc: string | undefined,
	choices: readonly unknown[] | undefined,
	dflt: unknown,
	ansi: Ansi
): string {
	const parts = desc ? [desc] : [];

	if (Array.isArray(choices) && choices.length > 0) {
		parts.push(ansi.dim(`(choices: ${choices.map(format).join(', ')})`));
	}

	if (dflt !== undefined) {
		parts.push(ansi.dim(`(default: ${format(dflt)})`));
	}

	return parts.join(' ');
}

/**
 * A value as it should read in help. A string is printed as it is rather than
 * quoted -- this is prose, not JSON -- and everything else is written the way it
 * would be typed.
 *
 * @param value - The value.
 * @returns The text.
 */
function format(value: unknown): string {
	if (typeof value === 'string') {
		// a string is printed as it is -- this is prose, not JSON -- unless printing
		// it as it is would show nothing, or would not show where it begins and
		// ends
		return value === value.trim() && value !== '' ? value : JSON.stringify(value);
	}

	try {
		// a default can be anything a schema put there, and a circular object or a
		// BigInt makes `JSON.stringify` throw. Nothing in help is worth failing the
		// whole screen over, so what cannot be written as JSON is written as itself.
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/**
 * The examples a command declares, however it declared them.
 *
 * @param examples - One example, several, or none.
 * @returns The examples worth printing.
 */
function exampleList(examples: CommandExample | CommandExample[] | undefined): CommandExample[] {
	if (!examples) {
		return [];
	}

	return (Array.isArray(examples) ? examples : [examples]).filter(
		(example) => example && typeof example === 'object' && example.text
	);
}

/**
 * The examples section.
 *
 * A label and a command line do not belong in two columns. The command is the
 * part worth reading and the part that gets copied, so squeezing it into the
 * right half of the screen is how it ends up wrapped for no reason. The label
 * takes a line and the command is indented under it.
 *
 * @param examples - The examples.
 * @param layout - Where the columns are.
 * @param ansi - The styler.
 * @param width - The column to wrap at.
 * @returns The lines.
 */
function exampleSection(
	examples: CommandExample[],
	layout: LayoutOptions,
	ansi: Ansi,
	width: number
): string[] {
	const out = [ansi.bold('Examples:')];

	for (const [index, example] of examples.entries()) {
		if (index > 0) {
			out.push('');
		}
		if (example.label) {
			out.push(...lines(example.label, width, layout.indent));
		}
		out.push(...lines(example.text, width, layout.indent * (example.label ? 2 : 1)));
	}

	return out;
}

/**
 * A titled list.
 *
 * @param title - The heading.
 * @param items - The rows.
 * @param layout - Where the columns are.
 * @param ansi - The styler.
 * @returns The lines.
 */
function section(title: string, items: Definition[], layout: LayoutOptions, ansi: Ansi): string[] {
	// a heading is wrapped like anything else. A title long enough to need it is
	// one somebody wrote, so it breaks at a space, unlike an option's label
	const heading = wrap(ansi.bold(`${title}:`), { width: layout.width }).split('\n');
	return [...heading, ...definitions(items, layout)];
}

/**
 * Text wrapped to the width, as lines.
 *
 * @param text - The text.
 * @param width - The column to wrap at.
 * @param indent - How far to indent every line.
 * @returns The lines.
 */
function lines(text: string, width: number, indent = 0): string[] {
	return wrap(text, { indent, width }).split('\n');
}

/**
 * The help screen for a parse, with a command's own help in place of the
 * generated one if it declares any.
 *
 * `Command.help` is either the text to print instead, or something that produces
 * it. A renderer is handed the screen that would have been printed, so one that
 * only wants to add a note does not have to rebuild the rest, and one that
 * returns nothing at all leaves the generated screen alone.
 *
 * @param state - The parse state. Its `help` request says what to describe; a
 * state without one is described as it stands.
 * @param opts - Where the columns are and what to write with.
 * @returns The screen.
 */
export async function resolveHelp(state: ParseState, opts: HelpOptions = {}): Promise<string> {
	const target: HelpTarget = state.help
		? { contexts: state.help.contexts, schema: state.schema }
		: state;
	const cmd = target.contexts[0]!;
	const custom = cmd.help as string | HelpRenderer | undefined;

	// a string replaces the screen outright, so there is no screen to build and no
	// hook to fire: a command that writes its own help should not be able to fail
	// on the way to not using the generated one
	if (typeof custom === 'string') {
		return custom;
	}

	const generated = renderHelp(target, {
		...opts,
		sections: opts.sections ?? (await contributedSections(cmd, state)),
	});
	if (typeof custom === 'function') {
		const replacement = await custom({ cmd, generated, state });
		return typeof replacement === 'string' ? replacement : generated;
	}

	return generated;
}

/**
 * The sections a command's `help` hooks contribute.
 *
 * Only the command being described is asked. An ancestor's sections would appear
 * under a command that has nothing to do with them, and a command that wants to
 * describe something about its subcommands can say so in its own screen.
 *
 * @param cmd - The command being described.
 * @param state - The parse state, handed to each hook.
 * @returns The sections, or `undefined` when there are no hooks.
 */
async function contributedSections(
	cmd: InternalCommand,
	state: ParseState
): Promise<BuiltSection[] | undefined> {
	const hooks = cmd.hooks?.help;

	if (!Array.isArray(hooks) || hooks.length === 0) {
		return undefined;
	}

	// a hook is handed the state, which is everything `resolveHelp()` needs, so
	// calling it from inside one is an easy mistake to make and a stack overflow is
	// a poor way to find out. What a hook wanting the generated screen is looking
	// for is `Command.help`, which is handed it.
	if (rendering.has(cmd)) {
		throw new Error(
			`A help hook for "${cmd.name}" asked for the help it is contributing to; use Command.help to read the generated screen`
		);
	}

	const internal = cmd[Internal];
	const sections = createSections();
	rendering.add(cmd);

	try {
		// a copy: a hook that adds to the list it is being read from would otherwise
		// extend the run it is already in
		for (const hook of hooks.slice()) {
			await hook({
				args: internal.args,
				cmd,
				commands: internal.commands,
				options: internal.options,
				sections,
				state,
			});
		}
	} finally {
		rendering.delete(cmd);
	}

	return sections.list;
}

/**
 * The commands whose `help` hooks are running, so that one asking for the screen
 * it is building gets told rather than filling the stack.
 */
const rendering = new WeakSet<InternalCommand>();
