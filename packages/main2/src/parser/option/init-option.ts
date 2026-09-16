import { Internal, InternalOption, InternalState, Option } from '../../types.js';
import { assertSectionTitle } from '../../util/assert-label.js';
import { camelCase } from '../../util/camel-case.js';
import { copyDeclaration } from '../../util/copy-declaration.js';
import { lockDerived } from '../../util/lock-derived.js';

/**
 * "all"
 * "-a"
 * "-a, --all"
 * "-a --all"
 * "-p, --path <hint>"
 * "--opt <value>"
 * "--opt [value]"
 */

const optionAliasSplitRE = /[ ,|]+/;
const optionHintRE = /^(\[(?=.+\]$)|<(?=.+>$))(.+?)[\]>]$/;
const optionLongLikeRE = /^--(.*)$/;
export const optionLongRE: RegExp = /^--(\w[\w-]*)$/;
const optionLongMaybeDashesRE = /^(?:--)?(\w[\w-]*)$/;
const optionNameRE = /^\w[\w-]*$/;
const optionNegateRE = /^no-(\w[\w-]*)$/;
const optionShortRE = /^-\w$/;
const optionSplitRE = /[ ,|=]+/;
// anchored as a group. Written as `/^auto|bool|...|yesno$/` the alternation
// bound looser than the anchors, so this read as `^auto` OR `bool` OR ... OR
// `yesno$` -- any string merely containing one of the middle names passed, and
// `integer` and `boolean` are the two somebody actually types. Past the guard
// `transformValue()` does not know that name, so it returned the raw string and
// `--port 8080` on a `type: 'integer'` option was `'8080'`
const optionTypesRE = /^(?:auto|bool|count|date|int|json|number|string|yesno)$/;

/**
 * Builds an internal option from a declaration. Everything the format string
 * implies — the name, hint, requiredness, negation, data type, and default —
 * is written to a new object this library owns, never back onto the caller's
 * declaration, so the same declaration always parses the same way.
 *
 * @param it - The option declaration, or an already initialized option.
 * @returns A new internal option.
 */
export async function initOption(it: Option | InternalOption): Promise<InternalOption> {
	if (typeof it === 'object' && Internal in it && it[Internal].state === InternalState.OK) {
		return it as InternalOption;
	}

	// copy the declaration instead of decorating it so the caller's object is
	// never written to
	const opt: Option = copyDeclaration(it);

	const long = new Set<string>();
	const short = new Set<string>();
	let isFlag = !opt.hint && !Array.isArray(opt.choices);

	if (opt.format !== undefined) {
		const parts =
			opt.format && typeof opt.format === 'string' && new Set(opt.format.split(optionSplitRE));
		if (!parts) {
			throw new TypeError('Expected option format to be a non-empty string');
		}

		for (const p of parts) {
			let m = p.match(optionLongLikeRE);
			if (m) {
				m = p.match(optionLongRE);
				if (!m) {
					throw new TypeError(`Invalid option format: ${p}`);
				}
				long.add(p);
				opt.name ??= m[1];
				continue;
			}

			m = p.match(optionShortRE);
			if (m) {
				short.add(m[0]);
			} else {
				m = p.match(optionHintRE);
				if (m) {
					// we have an option, not a flag
					opt.hint ??= m[2];
					isFlag = false;
					if (m[1] === '<') {
						opt.required ??= true;
					}
				} else if (!optionNameRE.test(p)) {
					// not a long name, a short name, or a hint, so the only thing
					// left it can be is a bare name; anything else is malformed
					// and would otherwise become an untypable option
					throw new TypeError(`Invalid option format: ${p}`);
				} else if (!opt.name) {
					opt.name = p;
					long.add(`--${opt.negate ? 'no-' : ''}${opt.name}`);
				}
			}
		}

		opt.name ??= short[Symbol.iterator]().next().value?.slice(1);
	} else if (opt.name) {
		long.add(`--${opt.name}`);
	}

	if (!opt.name) {
		throw new TypeError('Expected option name to be a non-empty string');
	}

	if (opt.hint?.endsWith('...')) {
		// a variadic hint promises `--tag a b c`, which an option never does;
		// only a positional argument can consume consecutive values
		throw new TypeError(
			`Option "${opt.name}" hint cannot be variadic; use \`multiple: true\` to collect repeated uses into an array`
		);
	}

	if (opt.type && !optionTypesRE.test(opt.type)) {
		throw new Error(`Option "${opt.name}" has unsupported data type "${opt.type}"`);
	}

	// parse negate
	const m = opt.name.match(optionNegateRE);
	if (m && isFlag && opt.negate !== false) {
		opt.negate = true;
		opt.name = m[1];
		long.add(`--${opt.name}`); // add non-negated value
	}

	opt.type ||= isFlag ? 'bool' : 'string';

	// a default the parser supplied is weaker than one the schema declared: it
	// gives way to the twin that shares its destination, if there is one
	let impliedDefault = false;

	if (isFlag) {
		if (opt.type === 'auto' || opt.type === 'yesno') {
			opt.type = 'bool';
		} else if (opt.type !== 'bool' && opt.type !== 'count') {
			throw new Error("Option flags must have type of 'auto', 'bool', 'count', or 'yesno'");
		}
		if (opt.type === 'count' && opt.multiple) {
			// a counter already collects repeated uses -- into a number rather than an
			// array -- so `multiple` asks for nothing it does not do, and the two are
			// read by different code paths that disagree: the counting path ignores
			// `multiple` when the flag is used, and the fallback wraps the default in
			// an array when it is not, so the value changes shape depending on argv
			throw new TypeError(
				`Option "${opt.name}" cannot be a counter and collect; \`type: 'count'\` already counts repeated uses`
			);
		}
		if (opt.default === undefined) {
			opt.default = opt.type === 'count' ? 0 : !!opt.negate;
			impliedDefault = true;
		}
	} else if (opt.type === 'count') {
		throw new Error('Only flags can be of type "count"');
	}

	if (opt.alias !== undefined) {
		let aliases;
		if (typeof opt.alias === 'string') {
			aliases = new Set(opt.alias.split(optionAliasSplitRE));
		} else if (Array.isArray(opt.alias)) {
			aliases = new Set(
				opt.alias.flatMap((a) => {
					if (typeof a !== 'string') {
						throw new TypeError('Expected option alias to be a string or list of strings');
					}
					return a.split(optionAliasSplitRE);
				})
			);
		} else {
			throw new TypeError('Expected option alias to be a string or list of strings');
		}

		for (const alias of aliases) {
			let m = alias.match(optionShortRE);
			if (m) {
				short.add(m[0]);
				continue;
			}

			m = alias.match(optionLongMaybeDashesRE);
			if (m) {
				long.add(`--${m[1]}`);
				continue;
			}

			throw new TypeError(`Invalid option alias "${alias}"`);
		}
	}

	const envs = new Set<string>();
	if (opt.env !== undefined) {
		const env = typeof opt.env === 'string' ? [opt.env] : opt.env;

		if (!Array.isArray(env)) {
			throw new TypeError(
				'Expected option environment variable to be a string or array of strings'
			);
		}

		for (const e of env) {
			if (e && typeof e === 'string') {
				envs.add(e);
			}
		}
	}

	if (opt.choices !== undefined) {
		if (!Array.isArray(opt.choices)) {
			throw new TypeError('Expected option choices to be an array');
		}
		opt.hint ??= 'value';
	}

	if (opt.transform && typeof opt.transform !== 'function') {
		throw new TypeError('Expected option transform function to be a function');
	}

	// the group becomes a heading of its own, so it is checked here rather than
	// where it is printed: a bad declaration is worth rejecting while the schema is
	// being built, not when somebody asks for help
	if (opt.group !== undefined) {
		opt.group = assertSectionTitle(opt.group, `option "${opt.name}" group`);
	}

	const label = long[Symbol.iterator]().next().value || short[Symbol.iterator]().next().value;

	// the option is a plain object: `choices`, `default`, `multiple`,
	// `required`, `transform`, and `type` are read on every parse, so changing
	// one of those changes what the parser reads
	const internal = Object.defineProperty(opt, Internal, {
		configurable: true,
		value: {
			dest: camelCase(opt.name),
			envs,
			impliedDefault,
			isFlag,
			label,
			format: label + (isFlag ? '' : opt.required ? `=<${opt.hint}>` : `=[${opt.hint}]`),
			long,
			short,
			skipDefault: false,
			state: InternalState.OK,
		},
	}) as InternalOption;

	// ...but everything above was read out of the format string and the alias
	// and environment lists to build the spellings the registry indexes and the
	// destination the value lands on, so none of those can move afterwards
	lockDerived(
		internal,
		['alias', 'env', 'format', 'name', 'negate'],
		(prop) =>
			`Cannot set "${prop}" on the initialized "${label}" option: it built the option's spellings, destination, and environment fallbacks, so declare another option and add it to the registry instead`
	);

	return internal;
}
