import type { Argument, Command, OptionDeclarations } from './types.js';

/**
 * Declares a command, deriving what `run()` sees in `argv` from what the command
 * declared.
 *
 * At runtime this hands back exactly what it was handed, the same way `options()`
 * does. It is a call rather than a plain object because of where TypeScript infers:
 * a nested object literal is checked against the declared type of the property it
 * sits on, and checking does not re-infer that type's parameters. So a command
 * written as a bare literal inside `commands` gets the wide `argv` -- the one it has
 * always had -- and a command written through here gets the narrow one. Only a
 * generic *call* infers.
 *
 * ```js
 * await main2({
 *   schema: {
 *     options: { '-v, --verbose': 'Say more' },
 *     commands: {
 *       build: command({
 *         options: { '--target [name]': { choices: ['node', 'browser'] } },
 *         args: ['<entry>', '[extras...]'],
 *         run({ argv }) {
 *           argv.entry;    // string
 *           argv.extras;   // string[] | undefined
 *           argv.target;   // 'node' | 'browser' | undefined
 *           argv.verbose;  // unknown -- the schema declares it, not this command
 *         },
 *       }),
 *     },
 *   },
 * });
 * ```
 *
 * What a command declares is typed; everything else in `argv` is `unknown`. The
 * options a command inherits from the commands above it resolve at runtime and are
 * not inferred, because nothing at this call knows where in the tree the command
 * will be mounted -- see `InferArgv`.
 *
 * Wrapping is optional and per command. One that does not need its `argv` typed --
 * because it has no `run`, or because it is loaded from a module, which inference
 * cannot see into at all -- can stay a plain object.
 *
 * @param decl - The command declaration.
 * @returns The same object.
 */
export function command<
	// the defaults are what an absent property contributes: nothing. Without them a
	// parameter with no inference candidate falls back to its constraint, which is
	// the wide type, and one wide part makes the whole `argv` wide again.
	const O extends OptionDeclarations = {},
	const A extends readonly (string | Argument)[] = [],
>(decl: Command<O, A>): Command<O, A> {
	return decl;
}
