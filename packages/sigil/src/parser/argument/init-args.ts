import { type Argument, type InternalArgument } from '../../types.js';
import { initArg } from './init-arg.js';

/**
 * Builds a list of arguments, and enforces the two rules that are about the list
 * rather than about any one of its members.
 *
 * Shared because a help section describes arguments too, and a section that
 * described an impossible signature -- or one whose optionality did not match
 * what the parser would actually require -- would be describing something that
 * cannot happen.
 *
 * @param decls - The argument declarations.
 * @param where - What is being built, for the error message.
 * @returns The initialized arguments.
 */
export function initArgs(
	decls: (string | Argument | InternalArgument)[],
	where: string
): InternalArgument[] {
	return normalizeArgs(
		decls.map((decl) => initArg(decl)),
		where
	);
}

/**
 * Applies the two list-wide rules to a list that is already built.
 *
 * Separate from `initArgs()` because a list can be assembled in more than one
 * step -- a help section merged with another of the same title -- and the rules
 * are about the list, so they have to be applied to the whole of it rather than
 * to each piece. Both are idempotent, so re-running them on a list that has
 * already been through them changes nothing.
 *
 * @param args - The arguments, in order.
 * @param where - What is being built, for the error message.
 * @returns The same list.
 */
export function normalizeArgs(args: InternalArgument[], where: string): InternalArgument[] {
	// a variadic argument takes every remaining value, so anything declared after
	// it could never be given one. this runs before the promotion below so a
	// rejected list is not left half promoted.
	for (let i = 0; i < args.length - 1; i++) {
		if (args[i]!.multiple) {
			throw new Error(
				`Only the last argument can be variadic: ${label(args[i]!)} is followed by ${label(args[i + 1]!)} in ${where}`
			);
		}
	}

	// an optional argument before a required one is promoted to required, since
	// there is no way to skip it. `args` holds copies, so this never reaches the
	// caller's argument objects.
	for (let i = args.length - 2; i >= 0; i--) {
		if (!args[i]!.required) {
			args[i]!.required = args[i + 1]!.required;
		}
	}

	return args;
}

/**
 * How an argument is spelled where it is typed, for an error message.
 *
 * @param arg - The argument.
 * @returns The spelling.
 */
function label(arg: InternalArgument): string {
	const name = `${arg.name}${arg.multiple ? '...' : ''}`;
	return arg.required ? `<${name}>` : `[${name}]`;
}
