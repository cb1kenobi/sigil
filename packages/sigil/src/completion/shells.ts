/**
 * Which shells there are, in a module of its own.
 *
 * The names are needed while the *schema* is built -- they are the `choices` on
 * the `completion` command's `shell` argument -- and the emitters are needed
 * only when a script is printed. Those are two different moments, and the first
 * one is every invocation of every app: a parse that reached `bash.ts` and
 * `zsh.ts` to learn two short strings would put the whole printer on the path
 * `--version` takes. So this file holds the names and nothing else, and imports
 * nothing at all.
 *
 * It is the one source for the set rather than half of two. `SHELLS` in
 * `./index.ts` is typed `Record<ShellName, …>`, which TypeScript makes
 * exhaustive both ways -- a name added here without an emitter is a type error,
 * and an emitter with no name is a type error -- so the list and the map cannot
 * come apart. That is the rule `SEVERITY_ROLE` already keeps in the toolchain.
 */

/**
 * One of the shells, by name.
 *
 * Written as a union rather than inferred from the array, because
 * `--isolatedDeclarations` refuses to infer the type of an exported `const` --
 * and a union the array is then annotated with is the stronger of the two
 * orders anyway: it is what makes `SHELLS` exhaustive.
 */
export type ShellName = 'bash' | 'zsh';

/**
 * The shells a completion script can be printed for, sorted, which is what a
 * user types and what help lists.
 *
 * bash and zsh, and the reason the set is this small is in `./index.ts`: a
 * generated script is quoted correctly or it is a shell injection, and these
 * are the two that can be sourced and driven on the machine this was written
 * on.
 */
export const SHELL_NAMES: readonly ShellName[] = Object.freeze(['bash', 'zsh']);
