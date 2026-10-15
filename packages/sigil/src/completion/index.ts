/**
 * Shell completion, printed from the tree the parser already holds.
 *
 * A CLI with no tab completion is incomplete, and this is the cheapest of those
 * gaps to close because there is no data to invent: every name, alias,
 * description, `hidden` and `choices` a shell could offer is something the app
 * declared to the parser. So the work is a printer rather than an extractor,
 * which is what makes it a few hundred lines rather than a second reader of an
 * app's source.
 *
 * ## The script is static, and that was measured
 *
 * The alternative is a script that shells out -- `app --completions-for
 * "$COMP_LINE"` -- on every tab. Two things decided against it. Answering such
 * a query is a *parse*, not a `--version`: measured in this repository on node
 * 26, forty spawns per figure and three runs agreeing within a millisecond, a
 * bare `node -e 'process.exit(0)'` is 24-26ms, a `parse()` of a two-command
 * inline app is **32-33ms**, and a `parse()` of a three-level routed tree is
 * **36-38ms** -- one `readdir` and one `import` per level argv names. So a tab
 * costs eight milliseconds of work above a bare node start on the smallest app
 * there is and twelve on a small routed one, and it grows with the tree rather
 * than with what is being completed. And nothing in the data model declares a value completer at all:
 * `choices`, `bool` and `yesno` are the lists an app has already written down,
 * and a hook for "ask the command what the valid values are" would be a new
 * declaration surface rather than a printer. So what is built is the smaller
 * thing that is honestly complete, and what it cannot do -- a branch name, a
 * running container, a row in a database -- it does not pretend to.
 *
 * ## bash and zsh, because those are the two that can be run here
 *
 * oclif ships bash, zsh and PowerShell, and fish has the nicest model of the
 * four. What this ships is bash and zsh, and the reason is the rule a generated
 * script lives or dies by: it is quoted correctly or it is a shell injection.
 * `bash --version` here is 3.2.57 and `zsh` is 5.9, so both emitters are
 * checked by sourcing them in the shell they are for and driving a real
 * completion. Neither `fish` nor `pwsh` is installed where this was written, so
 * either one would ship as a program its own author had never executed -- which
 * is exactly what `scripts/terminal-probe.mjs` exists because tests cannot
 * substitute for, and the suite's own `bash -n` and `zsh -n` are skipped where
 * the shell is absent anyway. Neither is *hard*: fish's model is the nicest of
 * the four and its escaping is one rule. `SHELLS` is a map, so adding one is a
 * module and a run by somebody who has that shell.
 *
 * ## Reachable only through the command
 *
 * `main()` never imports this: `registerCompletion()` puts a `completion`
 * command on the root and the command's own `run` is what reaches the emitters,
 * through `await import()`. So the root entry's static import graph is the same
 * 7,553 bytes it was, which `test/dist.test.ts` holds to a ceiling, and the
 * emitters are one chunk of 15,943 bytes and nothing else -- measured as the
 * difference between that chunk's import graph and the parse chunk's, so every
 * module they need was already on the parse path.
 *
 * What a run that never asks for a script *does* pay is the registration, which
 * is on the parse path: 460 bytes of the parse chunk -- 18,685 against 19,145 --
 * and no measurable time. Sixty interleaved spawns of one binary with
 * `completion: false` as the only input removed: 48.86ms against 48.76ms, and
 * 49.08 against 48.55 on a second run.
 */

import { bashScript } from './bash.js';
import { SHELL_NAMES, type ShellName } from './shells.js';
import { completionSpec, type CompletionSpec, type CompletionTarget } from './spec.js';
import { zshScript } from './zsh.js';

export { bashQuote } from './bash.js';
export { SHELL_NAMES, type ShellName } from './shells.js';
export { completionSpec, oneLine } from './spec.js';
export type {
  CompletionCommand,
  CompletionOption,
  CompletionSpec,
  CompletionSubcommand,
  CompletionTarget,
} from './spec.js';
export { zshPair, zshQuote } from './zsh.js';

/**
 * The emitter for each shell.
 *
 * `Record<ShellName, …>` rather than a wider map, which is what makes
 * `SHELL_NAMES` the one source for the set: TypeScript refuses a missing key
 * and refuses an extra one, so a shell added to the list without an emitter and
 * an emitter with no name are both type errors rather than a name that offers
 * nothing.
 */
export const SHELLS: Readonly<Record<ShellName, (spec: CompletionSpec) => string>> = Object.freeze({
  bash: bashScript,
  zsh: zshScript,
});

/**
 * The completion script for one shell.
 *
 * @param target - A parse state, or anything carrying a context chain.
 * @param shell - Which shell, by one of `SHELL_NAMES`.
 * @returns The script, ending in a newline.
 * @throws If the shell is not one this knows, if the schema names no program,
 *   or whatever loading a command module threw.
 */
export async function completionScript(target: CompletionTarget, shell: string): Promise<string> {
  // `Object.hasOwn` rather than a truthiness test, which is this repository's
  // rule for every lookup table: the object is frozen but not null-prototype,
  // so `SHELLS['constructor']` reads back a function and would be called as an
  // emitter. The parse refuses an unknown shell first, through the argument's
  // own `choices`, so this is the guard for a caller reaching the function
  // directly
  if (!Object.hasOwn(SHELLS, shell)) {
    throw new Error(
      `Unknown shell "${shell}": sigil can generate completion for ${SHELL_NAMES.join(' and ')}.`
    );
  }

  return SHELLS[shell as ShellName](await completionSpec(target));
}
