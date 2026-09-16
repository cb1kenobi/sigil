import debug from '../debug/index.js';
import { attachState, fireBeforeError } from '../error-hooks.js';
import {
	Internal,
	InternalArgument,
	InternalCommand,
	InternalOption,
	ParsedBase,
	ParsedOption,
	ParsedUnknownOption,
	ParsedValue,
	ParseOptions,
	ParseState,
	Schema,
} from '../types.js';
import { camelCase } from '../util/camel-case.js';
import { transformValue } from '../util/transform.js';
import { initCommand } from './command/init-command.js';
import { loadCommand } from './command/load-command.js';
import { detectHelp, registerHelp } from './help.js';

const { log } = debug('main2:parser');

const optionGroupRE = /^-(\w{2,})$/;
const optionLikeRE = /^--?\w/;
const optionNoSpaceRE = /^([^'"]*)(['"])(.*)\2$/;
const negatedRE = /^--no-/;
const unknownOptionRE = /^(?:--(\w[\w-]*)|-(\w))$/;

/**
 * Parses argv against a schema.
 *
 * Every throw site -- an invalid schema, a command module that will not load,
 * a missing required option, a bad data type, a hook or transform of the
 * caller's own -- leaves through the one catch below, which is where the
 * `beforeError` hooks fire and where the in-flight state is pinned to the
 * error. So a caller using `parse()` without `main2()` gets the same error
 * path.
 *
 * @param opts - The parse options.
 * @returns The resolved parse state.
 */
export async function parse(opts: ParseOptions = {}): Promise<ParseState> {
	let schema: Schema | undefined;
	let state: ParseState | undefined;

	try {
		if (opts !== undefined && (opts === null || typeof opts !== 'object')) {
			throw new TypeError('Expected parse options to be an object');
		}

		// the schema comes first because it is where the `beforeError` hooks
		// live: reading anything else off the options ahead of it would leave a
		// getter of the caller's own able to throw past its own hooks. Only an
		// absent schema gets the empty default; `null` is an error
		schema = opts.schema === undefined ? {} : opts.schema;

		const { argv, env = {} } = opts;

		if (!schema || typeof schema !== 'object') {
			throw new TypeError('Expected schema to be an object');
		}

		if (schema.name !== undefined && (!schema.name || typeof schema.name !== 'string')) {
			throw new TypeError('Expected schema name to be a non-empty string');
		}

		if (schema.hooks && typeof schema.hooks !== 'object') {
			throw new TypeError('Expected hooks to be an object of hook names and callbacks');
		}
		const hooks = {
			beforeParse: [],
			afterParse: [],
			beforeError: [],
			...schema.hooks,
		};
		for (const [name, hookList] of Object.entries(hooks)) {
			if (!Array.isArray(hookList) || hookList.some((h) => typeof h !== 'function')) {
				throw new TypeError(`Expected "${name}" hook to be an array of functions`);
			}
		}

		if (argv !== undefined && !Array.isArray(argv)) {
			throw new TypeError('Expected argv to be an array');
		}

		if (!env || typeof env !== 'object') {
			throw new TypeError('Expected environment option to be an object');
		}

		state = {
			$: [],
			$orig: argv || [],
			_: [],
			argv: {},
			cmd: undefined,
			// the root context is built from a copy of the schema, never by writing
			// a default name onto the caller's object
			contexts: [await initCommand({ ...schema, name: schema.name ?? 'global' })],
			env,
			schema,
			settings: opts.settings || {},
		};

		const handles = await registerHelp(state.contexts[0], schema);

		await initArgv(state);
		await parseArgv(state);

		// before anything is validated: help wins over a missing required option,
		// which is a parser-ordering concern and not a rendering one
		state.help = await detectHelp(state, handles);

		await processArgs(state);
		await processOptions(state);

		return state;
	} catch (err) {
		attachState(err, state);
		// a hook may replace the error, never swallow it, so this always throws
		throw await fireBeforeError(err, state, schema);
	}
}

export default parse;

async function initArgv(state: ParseState): Promise<void> {
	const argv = state.$orig;
	log(
		`Processing ${argv.length} argument${argv.length === 1 ? '' : 's'}${argv.length ? `: ${argv.join(', ')}` : ''}`
	);

	for (let arg of argv) {
		const inputs = [arg];

		if (optionLikeRE.test(arg)) {
			// check if we have --option=value
			const p = arg.indexOf('=');
			if (p > 0) {
				// only the name is trimmed. The value is taken exactly as it was
				// typed, because whitespace in a value is the caller's: `--name=`
				// with a single space said a space, and trimming made it `''` --
				// which for a `<value>` option then failed as a missing value. A
				// value in the following token was never trimmed, so the two
				// spellings of the same thing disagreed
				inputs[0] = arg.slice(0, p).trim();
				inputs.push(arg.slice(p + 1));
			} else {
				// check if we have --option"value"
				const m = arg.match(optionNoSpaceRE);
				if (m) {
					inputs[0] = m[1];
					inputs.push(m[3]);
				}
			}
		}

		state.$.push({
			inputs,
			orig: arg,
			type: 'Unknown',
		});
	}
}

/**
 * Finds an option by name across the entire context chain, innermost context
 * first, so that a subcommand can use the options its parents declared.
 *
 * @param contexts - The context chain, innermost first.
 * @param name - The option name to look for.
 * @returns The option, if any context declares it.
 */
function findOption(contexts: InternalCommand[], name?: string): InternalOption | undefined {
	for (const ctx of contexts) {
		const option = ctx[Internal].options.find(name);
		if (option) {
			return option;
		}
	}
}

/**
 * Expands a short option group such as `-abc` or `-n5`. This cannot happen
 * until the schema is known: whether the `5` in `-n5` is a value or another
 * flag depends entirely on how `-n` was declared.
 *
 * @param contexts - The context chain, innermost first.
 * @param entry - The unresolved argument to expand.
 * @returns The expanded entries, or `undefined` if the group did not resolve.
 */
function expandGroup(contexts: InternalCommand[], entry: ParsedBase): ParsedValue[] | undefined {
	const m = entry.inputs[0]?.match(optionGroupRE);
	if (!m) {
		return;
	}

	const chars = m[1];
	const explicit = entry.inputs[1];
	const expanded: ParsedValue[] = [];

	for (let i = 0; i < chars.length; i++) {
		const name = `-${chars[i]}`;
		const option = findOption(contexts, name);

		if (!option) {
			// nothing resolved at all, leave the token for a later context pass
			if (i === 0) {
				return;
			}

			// partially resolved, so defer whatever is left
			const rest: (string | undefined)[] = [`-${chars.slice(i)}`];
			if (explicit !== undefined) {
				rest.push(explicit);
			}
			expanded.push({ inputs: rest, type: 'Unknown' });
			return expanded;
		}

		if (option[Internal].isFlag) {
			expanded.push({ inputs: [name], type: 'Unknown' });
			continue;
		}

		// this option takes a value, so the rest of the group is that value
		const rest = chars.slice(i + 1);
		const inputs: (string | undefined)[] = [name];
		if (rest) {
			inputs.push(rest);
		} else if (explicit !== undefined) {
			inputs.push(explicit);
		}
		expanded.push({ inputs, type: 'Unknown' });
		return expanded;
	}

	// every character was a flag, so an explicit value belongs to the last one
	if (explicit !== undefined && expanded.length) {
		expanded[expanded.length - 1].inputs.push(explicit);
	}

	return expanded;
}

/**
 * Decides whether a flag token turns its destination off.
 *
 * A negated flag turns it off through every name it answers to — `-C` as much
 * as `--no-color` — except the positive spelling it registers for itself,
 * which is the one way to turn it on. An explicit `negate: false` opts out of
 * negation entirely, so a flag literally named `no-color` is just present.
 *
 * @param option - The declared option the token resolved to.
 * @param subject - The token as it was typed.
 * @returns `true` when the token means off.
 */
function isNegated(option: InternalOption, subject?: string): boolean {
	if (option.negate === false) {
		return false;
	}
	if (option.negate) {
		return subject !== `--${option.name}`;
	}
	return negatedRE.test(`${subject}`);
}

/**
 * Decides whether the next unresolved token may be taken as the value of a
 * declared option.
 *
 * A token that resolves to a known option is left alone, so `--name --verbose`
 * does not silently swallow `--verbose`. Anything else is fair game, including
 * an option-like token that nothing declared, because values legitimately
 * start with a dash and `--name=--verbose` is the way to force the issue.
 *
 * @param contexts - The context chain, innermost first.
 * @param entry - The next entry in the token stream, if there is one.
 * @returns `true` when the entry can be consumed as a value.
 */
function canBeValue(contexts: InternalCommand[], entry?: ParsedValue): boolean {
	if (entry?.type !== 'Unknown') {
		return false;
	}

	const subject = entry.inputs[0];

	// the terminator belongs to the argv stream, never to an option
	if (subject === '--') {
		return false;
	}

	// a plain value is always fair game; only an option-like token has to prove
	// it is not a declared option first
	if (!subject || !optionLikeRE.test(subject)) {
		return true;
	}

	return !findOption(contexts, subject) && !expandGroup(contexts, entry);
}

/**
 * Reads a resolved value without letting `Object.prototype` answer for it.
 * A destination such as `toString` — from `--to-string` — would otherwise
 * always look defined, silently suppressing its default, its environment
 * fallback, and its required check.
 *
 * @param state - The parse state.
 * @param dest - The destination key in `state.argv`.
 * @returns The value actually parsed, or `undefined`.
 */
function resolved(state: ParseState, dest: string): unknown {
	return Object.hasOwn(state.argv, dest) ? state.argv[dest] : undefined;
}

/**
 * Which declaration put the current value on each destination.
 *
 * A destination can have more than one writer: a valued option and its negated
 * twin share one, and an option and a positional argument of the same name do
 * too. Every one of them has its own `choices`, so the only value any of them can
 * validate is the value it produced -- `--cheese brie --no-cheese` ends with the
 * twin's `false` on the destination, and checking that against `--cheese`'s
 * choices rejected a command line that is perfectly legal.
 *
 * Kept beside the state rather than on it: this is bookkeeping for one parse, and
 * `ParseState` is what callers read.
 */
const producers = new WeakMap<ParseState, Map<string, InternalOption | InternalArgument>>();

/**
 * Records that a declaration wrote a destination.
 *
 * @param state - The parse state.
 * @param dest - The destination that was written.
 * @param by - The option or argument that wrote it.
 */
function produced(state: ParseState, dest: string, by: InternalOption | InternalArgument): void {
	let map = producers.get(state);
	if (!map) {
		producers.set(state, (map = new Map()));
	}
	map.set(dest, by);
}

/**
 * Whether this declaration is the one that wrote what is on its destination, which
 * is what accumulating onto a value requires: `multiple` extends its own array and
 * a counter increments its own number, never another declaration's.
 *
 * @param state - The parse state.
 * @param it - The option or argument asking.
 * @returns `true` when the value on the destination is this declaration's.
 */
function wrote(state: ParseState, it: InternalOption | InternalArgument): boolean {
	return producers.get(state)?.get(it[Internal].dest) === it;
}

/**
 * Every declaration that can validate something in this parse: the options of the
 * whole chain, since that is where options resolve from, and the arguments of the
 * innermost context, since those are the only ones read.
 *
 * It is also exactly the set of destinations the schema describes, which is what an
 * undeclared option may not write -- one set, so the two cannot drift.
 *
 * @param state - The parse state.
 * @returns The declarations.
 */
function liveDeclarations(state: ParseState): Set<InternalOption | InternalArgument> {
	const live = new Set<InternalOption | InternalArgument>();

	for (const context of state.contexts) {
		for (const opt of context[Internal].options.values()) {
			live.add(opt);
		}
	}

	for (const arg of state.contexts[0][Internal].args) {
		live.add(arg);
	}

	return live;
}

/**
 * Whether anything active describes a destination, which is what an undeclared
 * option may not write.
 *
 * Asked of the registries every time rather than answered from a set built up
 * front: a declaration can arrive in the middle of a parse -- an argument's
 * `transform` adding an option is the case that bit -- and a snapshot taken before
 * the walk would not have it. Unknown options are rare enough that walking the
 * chain for each one costs nothing worth measuring.
 *
 * @param state - The parse state.
 * @param dest - The destination in question.
 * @returns `true` when an option in the chain or an argument of this context owns it.
 */
function declares(state: ParseState, dest: string): boolean {
	for (const it of liveDeclarations(state)) {
		if (it[Internal].dest === dest) {
			return true;
		}
	}

	return false;
}

/**
 * Whether a value is this declaration's to validate.
 *
 * Its own, or nobody's -- where nobody covers two things. Nothing recorded means
 * the value did not come through the parser at all: a hook wrote `state.argv`
 * itself, and then every declaration that can reach the destination checks it,
 * which is what happened before writers were tracked. A writer that is recorded but
 * is no longer live means the same thing, and is how a hook replacing an option
 * after its value was read left a value nobody validated: the writer on record was
 * the object the replacement evicted, so every live declaration read it as somebody
 * else's. Either way, skipping is what would make a hook a way around `choices`.
 *
 * @param state - The parse state.
 * @param it - The option or argument asking.
 * @param live - The declarations this parse validates with.
 * @returns `true` when this declaration should validate what is on its destination.
 */
function validates(
	state: ParseState,
	it: InternalOption | InternalArgument,
	live: ReadonlySet<InternalOption | InternalArgument>
): boolean {
	const writer = producers.get(state)?.get(it[Internal].dest);
	return writer === undefined || writer === it || !live.has(writer);
}

/**
 * Reads the first environment variable of a list that is set.
 *
 * @param state - The parse state.
 * @param envs - Environment variable names to look for.
 * @returns The value of the first one that is defined, if any.
 */
function envValue(state: ParseState, envs: Set<string>): string | undefined {
	for (const env of envs) {
		// an empty variable is read as unset rather than as an empty value.
		// `PORT=` in a shell or a `.env` file is how a variable gets left blank,
		// and almost always means "not configured" -- while an empty value is one
		// most data types reject, so honoring it literally would fail the parse
		// over a variable nobody meant to set. `--port=` is still the way to give
		// an empty value deliberately, and that one is not second-guessed
		if (state.env[env]) {
			return state.env[env];
		}
	}
}

/**
 * Applies a fallback to a destination argv did not fill, coercing strings to
 * the declared data type exactly as a value parsed from argv would be.
 *
 * Precedence is argv, then environment, then default: callers apply every
 * environment fallback before any default, so that a declared default does not
 * make the variable unreachable — and so that a flag, which always has an
 * implicit default, can be set from the environment at all.
 *
 * The declaration is passed rather than its parts because filling a destination
 * makes this declaration the one that produced what is on it, and so the one whose
 * `choices` the value answers to.
 *
 * @param state - The parse state.
 * @param it - The option or argument being filled.
 * @param value - The fallback value, if there is one.
 */
function applyFallback(
	state: ParseState,
	it: InternalOption | InternalArgument,
	value: unknown
): void {
	const { dest } = it[Internal];
	const { multiple, type } = it;

	if (value === undefined || resolved(state, dest) !== undefined) {
		return;
	}

	// what arrived decides how many values it is, before coercion has a say: a string
	// is one value even when it parses to an array, so `ITEMS='[1,2]'` on a `json`
	// option is the one value `[1, 2]` -- the same as `--items '[1,2]'` -- rather than
	// two. An array `default` is the list itself and stays as it is.
	const one = !Array.isArray(value);

	if (typeof value === 'string') {
		value = transformValue(value, type);
	} else if (Array.isArray(value)) {
		// an array `default` belongs to the caller; handing it straight to
		// `argv` would let a consumer's `push` reach back into the schema and
		// change what the next parse defaults to
		value = [...value];
	}

	// a counter is never wrapped, whatever it says: `processArgs()` counts and does
	// not look at `multiple`, so wrapping here is what made the value's shape depend
	// on whether argv used the flag -- `2` used and `[0]` unused. `initOption()`
	// refuses the pair outright, and this is the invariant rather than the guard:
	// `multiple` stays editable after init, so a hook could otherwise put it back
	state.argv[dest] = multiple && type !== 'count' && one ? [value] : value;
	produced(state, dest, it);
}

/**
 * Validates a value against a list of allowed choices.
 *
 * @param choices - The allowed values, if the definition declared any.
 * @param value - The resolved value.
 * @param label - The option or argument label used in the error message.
 */
function assertChoices(
	choices: readonly unknown[] | undefined,
	value: unknown,
	label: string
): void {
	if (!Array.isArray(choices) || value === undefined) {
		return;
	}

	for (const v of Array.isArray(value) ? value : [value]) {
		if (!choices.includes(v)) {
			throw new Error(`Invalid value "${v}" for ${label}`);
		}
	}
}

/**
 * Takes the place of the command name that was never typed.
 *
 * A command marked `default` runs when argv did not name one, so the innermost
 * context is consulted for a default only once every context discovered so far
 * has had a pass -- by then argv is not going to name a command it has not
 * already named. The default joins the chain exactly as a matched command
 * does, which is the whole point: its options resolve on the pass that
 * follows, its arguments take the positional values, and `state.cmd` is the
 * command `main2()` runs. The one difference is that nothing is added to
 * `state.$`, because no token in argv named it.
 *
 * @param state - The parse state.
 * @param visited - The default commands already adopted, so that a schema that
 * points a command at itself cannot loop forever.
 * @returns `true` when a default command joined the chain.
 */
async function dispatchDefaultCommand(
	state: ParseState,
	visited: Set<InternalCommand>
): Promise<boolean> {
	const cmd = state.contexts[0][Internal].commands.default;

	if (!cmd || visited.has(cmd)) {
		return false;
	}
	visited.add(cmd);

	log(`Dispatching default command "${cmd.name}"`);

	// matched before loaded, same as a typed command: a module that will not
	// load is an error this command's own `beforeError` hooks should still see
	state.contexts.unshift(cmd);
	state.cmd = cmd;

	const loaded = await loadCommand(cmd);
	if (loaded !== cmd) {
		state.contexts[0] = loaded;
		state.cmd = loaded;
		visited.add(loaded);
	}

	if (loaded.hooks?.parse) {
		for (const hook of loaded.hooks.parse) {
			await hook({ cmd: loaded, ...loaded[Internal] });
		}
	}

	return true;
}

async function parseArgv(state: ParseState): Promise<void> {
	const { $, contexts } = state;
	const defaults = new Set<InternalCommand>();

	if (state.schema.hooks?.beforeParse) {
		for (const hook of state.schema.hooks.beforeParse) {
			await hook(state);
		}
	}

	// Options may appear before the command that declares them, so keep making
	// passes for as long as new command contexts keep turning up.
	for (let pass = 0; pass < contexts.length; pass++) {
		log(`Parsing argv with context "${contexts[0].name}"`);

		for (let j = 0; j < $.length; j++) {
			const arg = $[j];

			if (arg.type !== 'Unknown') {
				continue;
			}

			const subject = arg.inputs[0];

			if (subject === '--') {
				$[j] = {
					inputs: $.splice(j, $.length)
						.slice(1)
						// what follows the terminator is not argv's to read, so each
						// token goes through whole. `inputs` is the split form --
						// `--foo=bar` was taken apart into a name and a value before
						// anything knew a terminator preceded it -- and flattening that
						// turned one extra argument into two
						.flatMap((a) => (a.orig === undefined ? a.inputs : [a.orig])),
					type: 'Extra',
				};
				break;
			}

			// commands only resolve against the innermost context, otherwise a
			// token repeating a command name would match a second time
			const cmd = contexts[0][Internal].commands.find(subject);
			if (cmd) {
				log(`Found command "${cmd.name}"`);

				// the command has matched, so it joins the chain before the module
				// behind it is loaded -- a module that will not load is an error
				// this command's own `beforeError` hooks should still see
				contexts.unshift(cmd);
				state.cmd = cmd;

				const loaded = await loadCommand(cmd);
				if (loaded !== cmd) {
					// loading merged the module's exports into a new command object
					contexts[0] = loaded;
					state.cmd = loaded;
				}

				$[j] = {
					cmd: loaded,
					inputs: arg.inputs,
					type: 'Command',
				};

				if (loaded.hooks?.parse) {
					for (const hook of loaded.hooks.parse) {
						await hook({ cmd: loaded, ...loaded[Internal] });
					}
				}

				continue;
			}

			// options resolve against the whole chain so that a subcommand can
			// use its parents' options, but only option-like tokens get to look:
			// the registry also indexes bare names, so an unguarded lookup would
			// resolve the positional value `foo` as the option `--foo`
			const option = optionLikeRE.test(`${subject}`) ? findOption(contexts, subject) : undefined;

			if (!option) {
				const expanded = expandGroup(contexts, arg);
				if (expanded) {
					// reprocess starting at the first expanded entry
					$.splice(j--, 1, ...expanded);
				}
				continue;
			}

			const { inputs } = arg;
			const { type } = option;
			const { isFlag, label } = option[Internal];
			let value: unknown;

			log(`Found ${label}`);

			if (isFlag && type === 'count' && inputs.length > 1) {
				// a counter reached with a value takes that value, the same way an
				// explicit `--foo=false` beats the name a bool flag was reached by.
				// Read as a `bool` it was either rejected for saying a number --
				// `-v=2` threw `Invalid boolean: "2"` -- or accepted and then thrown
				// away, because the counting path increments and never looks at the
				// value, so `-v=false` counted up to 1
				value = transformValue(`${inputs[1]}`, 'count');
			} else if (isFlag) {
				// `--foo` is true and `--no-foo` is false, but an explicit
				// `--foo=false` beats the name it was reached by
				const bool = inputs.length > 1 ? transformValue(`${inputs[1]}`, 'bool') : true;
				value = isNegated(option, subject) ? !bool : bool;
			} else {
				const next = $[j + 1];

				if (inputs.length > 1) {
					value = inputs[1];
				} else if (next && canBeValue(contexts, next)) {
					value = next.orig ?? next.inputs[0];
					inputs.push(value as string);
					$.splice(j + 1, 1);
				} else {
					// an option that takes a value was given none. Required or not is a
					// question about the *option* -- `<value>` means the option itself
					// must appear, `[value]` means it need not -- and neither says the
					// value may be left out. `--port=` is the way to give an empty one,
					// and then the data type decides whether empty is a value it has
					throw new Error(`Missing value for option ${label}`);
				}
			}

			if (typeof option.transform === 'function') {
				const result = await option.transform(value, state);
				if (result !== undefined) {
					value = result;
				}
			}

			if (typeof value === 'string') {
				value = transformValue(value, type);
			}

			$[j] = {
				inputs,
				option,
				type: 'Option',
				value,
			};
		}

		// this pass turned up no new context, so argv has named every command it
		// is going to: whatever the innermost context calls its default command
		// now stands in for the name that was never typed. Adopting it grows the
		// chain, so the loop makes one more pass and resolves the options it
		// declares -- and then asks it for a default of its own
		if (pass === contexts.length - 1) {
			await dispatchDefaultCommand(state, defaults);
		}
	}

	parseUnknownOptions(state);

	if (state.schema.hooks?.afterParse) {
		for (const hook of state.schema.hooks.afterParse) {
			await hook(state);
		}
	}
}

/**
 * Resolves every option-like token that no context declared. This runs after
 * the context passes so that a token is only called unknown once every command
 * — and with it every option those commands declare — has been discovered.
 *
 * An undeclared option is not known to take a value, so it only takes one when
 * the next token could not be an option itself. That is the mirror image of a
 * declared option, which is known to want a value and so takes whatever
 * follows.
 *
 * @param state - The parse state.
 */
function parseUnknownOptions(state: ParseState): void {
	const { $ } = state;
	const allowed = state.settings?.allowUnknownOptions !== false;

	for (let j = 0; j < $.length; j++) {
		const arg = $[j];

		if (arg.type !== 'Unknown') {
			continue;
		}

		const subject = arg.inputs[0];
		const m = subject?.match(unknownOptionRE);
		if (!m) {
			continue;
		}

		if (!allowed) {
			throw new Error(`Unknown option "${subject}"`);
		}

		log(`Found unknown option "${subject}"`);

		const { inputs } = arg;
		let value: unknown = true;

		if (inputs.length > 1) {
			value = inputs[1];
		} else {
			const next = j + 1 < $.length ? $[j + 1] : undefined;
			const following = next?.inputs[0];
			if (next?.type === 'Unknown' && following !== '--' && !optionLikeRE.test(`${following}`)) {
				value = next.orig ?? following;
				inputs.push(value as string);
				$.splice(j + 1, 1);
			}
		}

		if (typeof value === 'string') {
			// nothing declared a data type for this, so guess at one
			value = transformValue(value, 'auto');
		}

		$[j] = {
			dest: camelCase(m[1] ?? m[2]),
			inputs,
			orig: arg.orig,
			type: 'UnknownOption',
			value,
		};
	}
}

/**
 * Populates the resulting parsed argument values from all unknown and extra
 * arguments while setting defaults, resolving environment variables, and
 * transforming values.
 *
 * @param state - The parse state.
 */
export async function processArgs(state: ParseState): Promise<void> {
	const ctx = state.contexts[0];
	const internal = ctx[Internal];

	let argIdx = 0;

	// loop through all parsed args and populate argv
	for (let i = 0; i < state.$.length; i++) {
		const parsed: ParsedBase = state.$[i];
		const parsedType = parsed.type;
		let inputs: unknown[] = parsed.inputs;

		if (parsedType === 'Unknown') {
			const arg = internal.args[argIdx++];

			if (!state.settings?.allowUnexpectedArguments && !arg) {
				throw new Error(`Unexpected argument "${inputs[0]}"`);
			}

			if (arg) {
				const { multiple, type } = arg;
				const { dest } = arg[Internal];
				if (multiple) {
					// gobble every remaining positional value, but with its own
					// index: advancing `i` here would run the outer loop off the
					// end and silently drop every option that follows
					for (let k = i + 1; k < state.$.length; k++) {
						const next: ParsedBase = state.$[k];
						if (next.type === 'Unknown') {
							inputs.push(...next.inputs);
							state.$.splice(k--, 1);
						}
					}
				}

				if (typeof arg.transform === 'function') {
					const result = await arg.transform(multiple ? inputs : inputs[0], state);
					if (result !== undefined) {
						inputs = multiple && Array.isArray(result) ? result : [result];
					}
				}

				for (let i = 0, len = inputs.length; i < len; i++) {
					if (typeof inputs[i] === 'string') {
						inputs[i] = transformValue(inputs[i] as string, type);
					}
				}

				state.argv[dest] = multiple || !Array.isArray(inputs) ? inputs : inputs[0];
				produced(state, dest, arg);
			}

			state._.push(...inputs);
		} else if (parsedType === 'Extra') {
			if (state.settings?.allowExtraArguments) {
				state._.push(...inputs);
			} else {
				throw new Error(`Extra arguments are not allowed: ${inputs.join(' ')}`);
			}
		} else if (parsedType === 'Option') {
			const { option, value } = parsed as ParsedOption;
			const { dest, isFlag, parserOwned } = option[Internal];

			if (parserOwned) {
				// the parser reads this one off `state.$`; it is not the app's value
				continue;
			}

			// accumulating reads the destination back, so it has to be this option's
			// own value it reads: a destination can be shared -- a positional argument
			// of the same name, a negated twin -- and the rule everywhere else is that
			// the last writer wins rather than extends. A counter that incremented a
			// positional's `10` made `-v` mean 11, and a `multiple` option that
			// appended to a variadic argument's array made one list out of two
			// declarations and then validated all of it against its own `choices`.
			const mine = wrote(state, option);

			if (isFlag && option.type === 'count') {
				// a counter reached with an explicit value was set by it rather than
				// incremented, so `-v -v=5 -v` is 6 and not 3
				if (typeof value === 'number') {
					state.argv[dest] = value;
				} else {
					const count = mine ? resolved(state, dest) : undefined;
					state.argv[dest] = typeof count !== 'number' ? 1 : count + 1;
				}
			} else if (option.multiple) {
				if (mine && Array.isArray(resolved(state, dest))) {
					(state.argv[dest] as unknown[]).push(value);
				} else {
					state.argv[dest] = [value];
				}
			} else {
				state.argv[dest] = value;
			}

			produced(state, dest, option);
		} else if (parsedType === 'UnknownOption') {
			const { dest, value } = parsed as ParsedUnknownOption;

			// an undeclared option never overwrites a destination a declared one owns.
			// Its value was guessed with `auto`, and it reached here without the
			// declared data type, `choices`, `multiple`, or `transform` -- so writing it
			// would replace a value the schema described with one nothing described.
			// What was typed is still on `state.$` for anything that wants it.
			// asked here rather than once before the loop: an argument's `transform`
			// runs inside it and may add an option, which the registries allow, and a
			// set built up front would not know about it -- so the destination it now
			// owns would take an undeclared write after all
			if (!declares(state, dest)) {
				state.argv[dest] = value;
			}
		}
	}

	// detect missing required args while populating optional args
	const missingArguments: string[] = [];

	for (let i = internal.args.length - 1; i >= argIdx; i--) {
		const arg = internal.args[i];
		const { name, required } = arg;

		const { dest, envs } = arg[Internal];

		applyFallback(state, arg, envValue(state, envs) ?? arg.default);

		if (missingArguments.length || (required && resolved(state, dest) === undefined)) {
			missingArguments.unshift(`<${name}>`);
		}
	}

	if (missingArguments.length && !state.help) {
		throw new Error(`Missing required arguments: ${missingArguments.join(' ')}`);
	}

	// only what this argument produced: an option can share the destination, and its
	// value answers to its own `choices` rather than to these
	const live = liveDeclarations(state);

	for (const arg of internal.args) {
		if (validates(state, arg, live)) {
			assertChoices(arg.choices, resolved(state, arg[Internal].dest), `argument <${arg.name}>`);
		}
	}
}

export async function processOptions(state: ParseState): Promise<void> {
	const missingOptions: string[] = [];
	const all = state.contexts.flatMap((ctx) => [...ctx[Internal].options.values()]);
	const live = liveDeclarations(state);

	// every environment fallback is applied before any default, and both before
	// anything is validated, so that a destination two options share — a valued
	// option and its negated twin — keeps the same argv, then environment, then
	// default precedence a lone option has, and is not reported missing just
	// because the option that fills it comes second
	for (const opt of all) {
		const { envs, parserOwned } = opt[Internal];
		if (!parserOwned) {
			applyFallback(state, opt, envValue(state, envs));
		}
	}

	for (const opt of all) {
		const { parserOwned, skipDefault } = opt[Internal];

		// the valued twin owns the default of the destination the two share
		if (!skipDefault && !parserOwned) {
			applyFallback(state, opt, opt.default);
		}
	}

	for (const opt of all) {
		const { choices, required } = opt;
		const { dest, label } = opt[Internal];
		const value = resolved(state, dest);
		const typed = state.$.some((parsed) => parsed.type === 'Option' && parsed.option === opt);

		if (required && !typed && value === undefined) {
			missingOptions.unshift(label);
		}

		// only what this option produced. A destination can have more than one
		// writer -- a negated twin, a positional argument of the same name, a
		// nearer context's option of the same destination -- and each of them has
		// its own `choices`, so a value belongs to whichever one wrote it
		if (validates(state, opt, live)) {
			assertChoices(choices, value, `option ${label}`);
		}
	}

	if (missingOptions.length && !state.help) {
		throw new Error(`Missing required options: ${missingOptions.join(' ')}`);
	}
}
