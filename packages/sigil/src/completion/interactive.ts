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
 * Measured rather than assumed, and the answer is better than "small". The
 * before-and-after that decided the split is SIG-151's and is left as it was
 * taken, because it is evidence for the decision rather than a description of
 * the tree: the body written inline took the parse chunk from 21,291 bytes to
 * 22,527, and moving it here left **21,176** -- 115 bytes *below* where it
 * started, because the no-TTY fallback text that used to be inline came with
 * it.
 *
 * As of SIG-155, re-derived with `staticGraph()` from `test/dist.test.ts`
 * against a `main` worktree built beside this branch, so each figure is a
 * difference between two builds rather than a figure carried forward. The
 * interactive graph is **270,334 B over 41 modules** against the printer's
 * **71,253 over 16**: the prompts are **+199,081**, paid by `app completion` on
 * a terminal and by nothing else. Editing the startup file cost the printer
 * **+497 B** -- `rcBlock()` and the two markers, which `install.ts` holds
 * because the emitters' headers print them -- and the interactive graph
 * **+1,145**, with the module count unchanged on both.
 *
 * And it cost the two graphs anybody else pays for **nothing at all**, byte for
 * byte: `index.mjs` is 12,009 B over 7 modules and the parse chunk 50,566 over
 * 14, identical on both builds. Which is the whole packaging argument holding
 * after the feature grew a second writer.
 *
 * Read it again rather than quoting it, which is this repository's own rule and
 * is why the figures above are stated as of a ticket. The first version of this
 * paragraph said 256,906 and +194,587, right when they were taken and 1,218
 * bytes stale by the end of SIG-151's first review round; the version after it
 * said 258,740 and 62,371, which were two tickets stale by the time this one
 * re-ran them -- the printer had grown 8,385 B and the interactive graph 10,449
 * since, none of it this feature's.
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
import { completionScript, programOf } from './index.js';
import { detectShell, instructions, shQuote } from './install.js';
import {
  applyInstall,
  applyRc,
  applyUninstall,
  installTarget,
  planInstall,
  planLines,
  planUninstall,
  removeRc,
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
 * Neither file touched, which is what both early returns report.
 *
 * Named rather than written out twice, because it is the same claim in two
 * places: there was nothing outstanding, or there was and nothing was allowed to
 * write it.
 */
const NOTHING = { file: false, rc: false } as const;

/**
 * Says how to do it by hand, which is what there is to say with nobody to ask.
 *
 * The same block the command printed before an installer existed. It names the
 * shell argv gave or the one `$SHELL` did, and where neither says, it names the
 * shells there are -- because "which shell are you in" is the one question this
 * cannot answer for the reader.
 *
 * It takes the **direction**, which it did not for one commit: `app completion
 * zsh --uninstall` in a pipe printed the plan and then the whole *install*
 * recipe, which is the opposite of what was asked for. There is nothing to
 * recite for an uninstall -- the plan has already named the file -- so what it
 * prints is the `rm`, and the block to take out is `resultLines()`'s. Found by
 * review.
 *
 * @param program - The program's name.
 * @param shell - The shell, where one is known.
 * @param action - Which way round.
 * @param target - Where the script is, where a target was resolved before the
 *   question failed.
 * @returns The block, with a trailing newline.
 */
function byHand(
  program: string,
  shell: ShellName | undefined,
  action: Action,
  target: InstallTarget | undefined
): string {
  if (action === 'uninstall') {
    if (target !== undefined) {
      return `${__`Remove it yourself:`}\n\n    rm ${shQuote(target.file)}\n\n`;
    }

    // no target, which means `askShell()` is what failed: nobody to ask and no
    // shell on argv. Its own key rather than the install one, which said "set
    // up" for a removal -- and it names the shell `$SHELL` found where it found
    // one, which the first version computed and then did not use. Found by
    // review, and nothing reached this branch because every test named a shell
    return shell === undefined
      ? `${__`Name a shell to remove completion for ${program} from:`}\n\n${SHELL_NAMES.map(
          (name) => `    ${program} completion ${name} --uninstall\n`
        ).join('')}\n`
      : `${__`Name the shell to remove completion for ${program} from:`}\n\n    ${program} completion ${shell} --uninstall\n\n`;
  }

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
  // not the statement. It is an **install's** question, and the condition says
  // so rather than relying on an uninstall not reaching it: that reasoning held
  // while a foreign file was nothing to write, and the block changed it -- a
  // foreign script with a block of ours is `writes: true`, so a reader
  // uninstalling was asked "Replace it?" about a removal, defaulting to no, and
  // the block stayed unless they typed y. It also hid the crash below behind
  // that default. Found by driving the command, which is how this file's
  // sibling defects were each found
  if (action === 'install' && plan.file === 'foreign') {
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
  // through `programOf()`, which is the one reader of what a schema's `name`
  // comes to: the printer flattened it and this did not, so one app had two
  // names and the installer's own marker never matched the header it wrote.
  // `''` rather than a fallback, because `installTargets()` already refuses it
  // with the sentence an app author needs -- and a nameless app reaching the
  // **uninstall** direction, which builds no script and so met no other guard,
  // was looking for a file called `_app`. Found by review round 3
  const program = programOf(state.schema.name) ?? '';
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
  // kept so that a question which failed can still say which file it was about,
  // which is what the uninstall fallback needs
  let target: InstallTarget | undefined;

  try {
    shell ??= await askShell(process.env, terminal);

    // a search rather than an index, and the search is `installer.ts`'s because
    // it reads the file system and asks the marker question: the install that
    // is already there wins, and the route table decides only where a new one
    // goes. It was `installTargets(...)[0]` for one commit, which for bash is
    // `bash-completion`'s user directory the moment that directory appears --
    // so a machine installed through the other route got a second copy written
    // beside the first, with nothing printed about it and an `--uninstall` that
    // left it. Found by review
    target = installTarget(shell, program, process.env);
    const script = request.uninstall ? '' : await completionScript(state, shell);
    const plan = request.uninstall
      ? planUninstall(target, program)
      : planInstall(target, script, program);

    process.stderr.write(`${planLines(plan, action).join('\n')}\n\n`);

    if (!plan.changes) {
      // a re-run, which has to say so rather than looking like it did something
      process.stderr.write(`${resultLines(plan, action, NOTHING).join('\n')}\n`);
      return 0;
    }

    // asked where there is anything to write or remove in **either** file,
    // which is what `writes` counts now that the block is written rather than
    // printed. Under SIG-151 a plan whose only outstanding item was the rc line
    // did not ask, because asking permission to print is asking permission to do
    // nothing -- and it said "nothing to do" to a yes for one commit before
    // that gate existed. There is something to do now, so it asks, and the
    // question covers both files because the plan above named both
    if (plan.writes && !(await confirm({ ...question(plan, action, program), terminal }))) {
      process.stderr.write(`${__`Cancelled`}\n`);
      return 1;
    }

    // gated on `writes` for the same reason the question is, and what that gate
    // is load bearing for is still the **uninstall**: a plan with something
    // outstanding and nothing to write used to reach the writer anyway, and for a
    // **foreign uninstall** -- whose `changes` counts a line this does not edit
    // and whose `writes` is false by design -- the writer's own refusal threw out
    // to the generic error handler. Found by review of SIG-151, and the state it
    // was about is `theirs` now, which is still exactly that: nothing to write
    // and something to say
    // two files and one answer, which is what the one confirm above bought: the
    // plan named both before the question, so a yes is an answer about both and
    // there is no second prompt for the half the user does not own. Each writer
    // re-reads and may decline on its own, which is why what is reported is what
    // they *did* rather than what the plan said they would
    const did = plan.writes
      ? request.uninstall
        ? {
            // gated on the plan's reading of the **file** rather than on
            // `plan.writes`, which now counts the block as well: a foreign
            // script with a block of ours in the startup file is `writes: true`,
            // and `applyUninstall()` throws for a foreign plan. An object
            // literal evaluates its properties in order, so that throw reached
            // the generic error handler as a crash and `removeRc()` never ran --
            // the block stayed. Which is SIG-151's round-2 shape exactly,
            // reintroduced by the premise that `writes` changed. Reported on
            // PR #191, and the unit test for the pair could not see it because
            // it called the two in the opposite order.
            //
            // The writer's own refusal stays where it is: this is the caller's
            // discipline and that is the module's rule, which is the division
            // `applyInstall()` already records
            file: plan.file === 'update' ? applyUninstall(plan) : false,
            rc: await removeRc(plan),
          }
        : {
            // `replace` is the answer carried into the writer, which refuses a
            // `foreign` plan without it: the refusal is the module's own rather
            // than this function's discipline
            file: await applyInstall(plan, script, { replace: plan.file === 'foreign' }),
            rc: await applyRc(plan),
          }
      : NOTHING;

    process.stderr.write(`${resultLines(plan, action, did).join('\n')}\n`);
    return 0;
  } catch (e: unknown) {
    if (!(e instanceof PromptError)) {
      throw e;
    }

    // Ctrl-C is not "nobody to ask", and `PromptError` carries `aborted`
    // precisely to say which it was -- its own doc calls the two "different in
    // kind". Read as one, an interrupt printed the longest output this command
    // has: the whole set-up recipe, in answer to somebody asking it to stop.
    // Found by review
    if (e.aborted) {
      process.stderr.write(`${__`Cancelled`}\n`);
      return 1;
    }

    // nobody to ask, which is the answer the command gave before an installer
    // existed: say how to do it by hand and exit non-zero. One mechanism rather
    // than a second reading of "is there a terminal" -- `run()` in
    // `components/prompt.ts` reads the output *and* stdin, where a check of our
    // own would read one of them and disagree about `app completion < /dev/null`
    // from a terminal
    process.stderr.write(byHand(program, shell ?? detectShell(process.env), action, target));
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
