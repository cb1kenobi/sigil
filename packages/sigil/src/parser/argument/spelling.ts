import type { InternalArgument } from '../../types.js';

/**
 * How an argument is spelled where it is typed: angle brackets when it is
 * required, square when it is not, and `...` when it takes more than one.
 *
 * One function for the three places that write it -- help's usage line and
 * argument rows, the palette's catalog, and the variadic error `initArgs()`
 * raises -- which each spelled it out. A module of its own with nothing but a
 * type import, so the catalog can ask it without the parser coming along.
 *
 * @param arg - The argument.
 * @returns The spelling.
 */
export function argSpelling(arg: InternalArgument): string {
  const name = `${arg.name}${arg.multiple ? '...' : ''}`;
  return arg.required ? `<${name}>` : `[${name}]`;
}
