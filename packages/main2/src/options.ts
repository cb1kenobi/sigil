import { type OptionDeclarations } from './types.js';

/**
 * Declares a reusable set of options, keeping the literal types of what it was
 * given.
 *
 * At runtime this hands back exactly what it was handed. It exists for the types,
 * and for one thing a bare object literal loses: `const g = { '--port <n>': {
 * type: 'int' } }` widens `type` to `string`, and once it is `string` nothing can
 * tell that `--port` produces a number. A `const` type parameter keeps it `'int'`,
 * so a group stays worth inferring from wherever it ends up.
 *
 * A group is a value, so it goes wherever options go -- on the schema, on a
 * command, or spread into a command's own list:
 *
 * ```js
 * const global = options({
 *   '-v, --verbose': 'Say more',
 *   '--port <n>': { type: 'int', default: 8080 },
 * });
 *
 * await main2({
 *   schema: {
 *     options: global,
 *     commands: {
 *       build: command({
 *         options: { '-w, --watch': 'Rebuild on change' },
 *         run({ argv }) {
 *           argv.watch;    // boolean
 *           argv.verbose;  // unknown -- declared above this command, not here
 *         },
 *       }),
 *     },
 *   },
 * });
 * ```
 *
 * Declaring a group on the schema is enough for every command to *resolve* those
 * options -- they resolve across the whole context chain -- but not for a command
 * to have their types, because a command is typed at its own `command()` call and
 * nothing there knows where in the tree it will be mounted. A command that wants
 * them typed declares them, by spreading the group into its own options:
 *
 * ```js
 * options: { ...global, '-w, --watch': 'Rebuild on change' }
 * ```
 *
 * which types `argv.verbose` as `boolean`, at the cost of the command owning a
 * declaration of its own: it shadows the one above it, and help lists it among the
 * command's options rather than under "Global options".
 *
 * @param decl - The options, keyed by format string.
 * @returns The same object.
 */
export function options<const T extends OptionDeclarations>(decl: T): T {
	return decl;
}
