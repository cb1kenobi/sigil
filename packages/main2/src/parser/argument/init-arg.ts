import { Argument, InternalState, Internal, InternalArgument } from '../../types.js';
import { camelCase } from '../../util/camel-case.js';
import { copyDeclaration } from '../../util/copy-declaration.js';
import { lockDerived } from '../../util/lock-derived.js';

// foo         optional
// <foo>       required
// [foo]       optional
// foo...      optional, multiple
// <foo...>    required, multiple
// [foo...]    optional, multiple
// [foo]...    optional, multiple

const argRequiredRE = /^(?:<([\w-]+)(\.\.\.)?>|\[([\w-]+)(\.\.\.)?\]|([\w-]+?))\s*(\.\.\.)?$/;
// anchored as a group, for the reason `optionTypesRE` spells out: the
// alternation bound looser than the anchors, so `integer` passed the guard and
// then coerced as nothing at all
const argTypesRE = /^(?:auto|bool|date|int|json|number|string|yesno)$/;

/**
 * Builds an internal argument from a declaration. The declaration is only ever
 * read: the normalized name, the `multiple` and `required` flags, the data
 * type, and the `Internal` state all land on a new object this library owns, so
 * the same declaration can be initialized again and see exactly what it saw the
 * first time.
 *
 * @param it - The argument declaration, or an already initialized argument.
 * @returns A new internal argument.
 */
export function initArg(it: string | Argument | InternalArgument): InternalArgument {
	if (it && typeof it === 'object' && Internal in it && it[Internal]?.state === InternalState.OK) {
		return it;
	}

	if (typeof it !== 'string' && (!it || typeof it !== 'object')) {
		throw new TypeError(`Invalid argument definition: ${it}`);
	}

	// copy the declaration instead of decorating it so the caller's object is
	// never written to
	const arg: Argument = typeof it === 'string' ? { name: it } : copyDeclaration(it);

	let { name } = arg;

	if (!name || typeof name !== 'string') {
		if (typeof name === 'number') {
			name = String(name);
		} else {
			throw new Error('Expected argument to have a name');
		}
	}

	const m = name.match(argRequiredRE);
	if (!m) {
		throw new Error(`Invalid argument name: ${JSON.stringify(arg.name)}`);
	}

	const envs = new Set<string>();
	if (arg.env !== undefined) {
		const env = typeof arg.env === 'string' ? [arg.env] : arg.env;

		if (!Array.isArray(env)) {
			throw new TypeError(
				'Expected argument environment variable to be a string or array of strings'
			);
		}

		for (const e of env) {
			if (e && typeof e === 'string') {
				envs.add(e);
			}
		}
	}

	if (arg.type !== undefined && !argTypesRE.test(arg.type)) {
		throw new Error(`Argument "${arg.name}" has unsupported data type "${arg.type}"`);
	}

	if (arg.transform && typeof arg.transform !== 'function') {
		throw new TypeError('Expected argument transform function to be a function');
	}

	arg.multiple ||= !!(m[2] || m[4] || m[6]);
	arg.name = (m[1] || m[3] || m[5]).trim();
	arg.required ||= !!m[1];
	arg.type ||= 'string';

	// the argument is a plain object: `required`, `type`, and the rest are read
	// on every parse, so changing one of those changes what the parser reads
	const internal = Object.defineProperty(arg, Internal, {
		configurable: true,
		value: {
			dest: camelCase(arg.name),
			envs,
			state: InternalState.OK,
		},
	}) as InternalArgument;

	// ...but the name and the environment list were just read to build the
	// destination and the fallbacks, so they cannot move afterwards
	lockDerived(
		internal,
		['env', 'name'],
		(prop) =>
			`Cannot set "${prop}" on the initialized "${arg.name}" argument: it built the argument's destination and environment fallbacks, so declare another argument and replace this one in cmd[Internal].args instead`
	);

	return internal;
}
