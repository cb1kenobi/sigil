/**
 * The interactive half of `app completion`: ask, show the plan, write.
 *
 * Its own module, and the reason is the parse path. `registerCompletion()` is
 * on it -- a `choices` list has to exist while the schema is built -- so every
 * line of the command's body is in the chunk every `parse()` loads, whether or
 * not anything ever asks for a completion. The flow below is a hundred lines
 * that only ever run on a terminal, so it lives behind the `await import()` the
 * command already had for the emitters, and what is left on the parse path is a
 * dispatcher.
 *
 * Measured rather than assumed, and the answer is better than "small": the body
 * written inline took the parse chunk from 21,291 bytes to 22,527, and moving
 * it here leaves **21,176** -- 115 bytes *below* where it started, because the
 * no-TTY fallback text that used to be inline came with it. So the installer
 * costs the parse path nothing at all, and the interactive graph it hangs off
 * is 256,906 bytes over 36 modules against the printer's 62,319 over 12: the
 * prompts are +194,587, paid by `app completion` on a terminal and by nothing
 * else.
 *
 * The three modules are one job each, which is also what makes the middle one
 * testable: `./install.ts` is the table of where a completion goes and touches
 * no file system, `./installer.ts` resolves it and writes, and this asks the
 * questions. A test of the plan and the idempotency needs no prompts at all.
 */

import { confirm, PromptError, select } from '../components/prompt.js';
import { __ } from '../i18n/index.js';
import { createTerminal, type Terminal } from '../terminal/index.js';
import type { ParseState } from '../types.js';
import { completionScript } from './index.js';
import { detectShell, instructions } from './install.js';
import {
  applyInstall,
  applyUninstall,
  installTargets,
  planInstall,
  planLines,
  planUninstall,
  resultLines,
  type Action,
  type InstallPlan,
  type InstallTarget,
} from './installer.js';
import { SHELL_NAMES, type ShellName } from './shells.js';

/** What the command read off argv. */
export interface InstallRequest {
  /** The shell argv named, or nothing where it named none. */
  readonly shell?: ShellName;
  /** Whether to take it back out rather than put it in. */
  readonly uninstall: boolean;
}

/**
 * Says how to do it by hand, which is what there is to say with nobody to ask.
 *
 * The same block the command printed before an installer existed. It names the
 * shell argv gave or the one `$SHELL` did, and where neither says, it names the
 * shells there are -- because "which shell are you in" is the one question this
 * cannot answer for the reader.
 *
 * @param program - The program's name.
 * @param shell - The shell, where one is known.
 * @returns The block, with a trailing newline.
 */
function byHand(program: string, shell: ShellName | undefined): string {
  if (shell !== undefined) {
    return `${__`Set up completion for ${program}, detected ${shell}:`}\n\n${instructions(
      shell,
      program
    )}`;
  }

  return `${__`Name a shell to set up completion for ${program}:`}\n\n${SHELL_NAMES.map(
    (name) => `    ${program} completion ${name}\n`
  ).join('')}\n`;
}

/**
 * Which shell to act on, asked rather than guessed.
 *
 * A `select()` with what `$SHELL` named already highlighted, which is where it
 * earns its place over a `confirm()`: the detected answer is one Enter away and
 * the override is an arrow key, where a confirm would need a second prompt to
 * offer the other one. Detection that found nothing is not a failure here --
 * the list is two long, and asking is a better answer than refusing.
 *
 * @param env - The environment to detect from.
 * @returns The shell.
 * @throws `PromptError` where there is nobody to ask.
 */
async function askShell(
  env: Record<string, string | undefined>,
  terminal: Terminal
): Promise<ShellName> {
  const detected = detectShell(env);

  return await select<ShellName>({
    choices: SHELL_NAMES.map((name) => ({
      hint: name === detected ? __`from $SHELL` : undefined,
      label: name,
      value: name,
    })),
    // highlighted rather than chosen, which is the whole of the override.
    // `indexOf` of a name that is not in the list is `-1`, which `select()`
    // would read as no row at all, so a detection that found nothing falls
    // back to the first
    initial: detected === undefined ? 0 : SHELL_NAMES.indexOf(detected),
    message: __`Which shell?`,
    terminal,
  });
}

/**
 * What to ask before touching anything.
 *
 * A file that is not ours gets its own question and its own default, which is
 * the half of `sigil add`'s refusal that survives being asked rather than
 * flagged: Enter on a question about replacing somebody's work must not replace
 * it. That is also why there is no `--force` -- a flag whose whole job is to
 * answer a question somebody is being asked anyway is one more thing to
 * document, and `add` needs one only because it has nobody to ask.
 *
 * @param plan - What would happen.
 * @param action - Which way round.
 * @param program - The program's name.
 * @returns The message and what Enter alone means.
 */
function question(
  plan: InstallPlan,
  action: Action,
  program: string
): { default: boolean; message: string } {
  const { shell } = plan.target;

  // the plan has already said whose the file is, so this is the question and
  // not the statement -- which is also what keeps it to one key rather than one
  // per direction: an uninstall never reaches here, because `planUninstall()`
  // refuses a foreign file outright rather than offering to delete it
  if (plan.file === 'foreign') {
    return { default: false, message: __`Replace it?` };
  }

  return {
    default: true,
    message:
      action === 'uninstall'
        ? __`Remove ${shell} completion for ${program}?`
        : __`Install ${shell} completion for ${program}?`,
  };
}

/**
 * Installs or uninstalls `program`'s completion, asking first.
 *
 * @param state - The parse the command was reached through, which is what a
 *   script is printed from.
 * @param request - What argv asked for.
 * @returns The exit code: zero where something was done or there was nothing to
 *   do, and one where there was nobody to ask or the answer was no.
 */
export async function runInstaller(state: ParseState, request: InstallRequest): Promise<number> {
  const program = state.schema.name ?? 'app';
  const action: Action = request.uninstall ? 'uninstall' : 'install';
  let shell = request.shell;

  // drawn on **stderr**, because this command's stdout is the script. The
  // prompts default to a terminal over stdout, which would put a settled
  // `? Which shell? zsh` in whatever `app completion zsh > file` was redirected
  // into the moment the two forms met -- and it is the same call `report.ts`
  // makes about asking the stream it is going to.
  //
  // It also moves the gate, which is the half worth knowing: the prompts refuse
  // unless the terminal they draw on and stdin are both terminals, so a bare
  // `app completion > file` from a terminal now asks rather than refusing. That
  // is not a surprise, because asking is what it does: the question names the
  // path before anything is written. And it is still one mechanism -- `isTTY`
  // is an input to `run()`'s own check rather than a second copy of it
  const terminal = createTerminal({ stdout: process.stderr });

  try {
    shell ??= await askShell(process.env, terminal);

    // the first target is the installer's own preference, which is the route
    // table's order: for bash that is `bash-completion`'s user directory where
    // it is there, because it needs nothing added to a startup file. The list
    // is never empty -- the `user` route always resolves -- which is what makes
    // this an index rather than a search
    const target = installTargets(shell, program, process.env)[0] as InstallTarget;
    const script = request.uninstall ? '' : await completionScript(state, shell);
    const plan = request.uninstall
      ? planUninstall(target, program)
      : planInstall(target, script, program);

    process.stderr.write(`${planLines(plan, action).join('\n')}\n\n`);

    if (!plan.changes) {
      // a re-run, which has to say so rather than looking like it did
      // something. `resultLines()` still prints the rc line where one is
      // outstanding, because a script that is current and a startup file that
      // never got its line is not "nothing to do"
      process.stderr.write(`${resultLines(plan, action, false).join('\n')}\n`);
      return 0;
    }

    // asked only where there is a file to write or remove. Where the only thing
    // outstanding is the line this *prints*, a confirm would be asking
    // permission to do nothing -- and then saying "nothing to do" to a yes,
    // which is what it did until the command was driven by hand
    if (plan.writes && !(await confirm({ ...question(plan, action, program), terminal }))) {
      process.stderr.write(`${__`Cancelled`}\n`);
      return 1;
    }

    const did = request.uninstall ? applyUninstall(plan) : await applyInstall(plan, script);

    process.stderr.write(`${resultLines(plan, action, did).join('\n')}\n`);
    return 0;
  } catch (e: unknown) {
    if (!(e instanceof PromptError)) {
      throw e;
    }

    // nobody to ask, which is the answer the command gave before an installer
    // existed: say how to do it by hand and exit non-zero. One mechanism rather
    // than a second reading of "is there a terminal" -- `run()` in
    // `components/prompt.ts` reads the output *and* stdin, where a check of our
    // own would read one of them and disagree about `app completion < /dev/null`
    // from a terminal
    process.stderr.write(byHand(program, shell ?? detectShell(process.env)));
    return 1;
  } finally {
    // put back what was attached: `createTerminal()` installs `exit` and signal
    // handlers lazily and an `EPIPE` guard per stream written to, and a
    // terminal this built is this function's to give back -- the prompts hand
    // back only the raw mode and the live region, because a terminal handed to
    // them is not theirs
    terminal.restore();
  }
}
