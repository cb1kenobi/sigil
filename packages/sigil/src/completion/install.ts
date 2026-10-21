/**
 * Where a completion script goes, and how a user puts it there.
 *
 * This is one module because the knowledge has three readers and they must not
 * come apart: each emitter prints it into its script's own header, the
 * `completion` command prints it as instructions when there is nobody to ask,
 * and the installer in `./installer.ts` *resolves* it and writes the file. A
 * second copy of "a zsh completion is a file called `_app` on `$fpath`" is a
 * copy that goes stale, and the one that goes stale is whichever a reader is
 * not looking at -- which is the rule `readRoutes()` already keeps for the two
 * route walks and `SEVERITY_ROLE` for the toolchain's severities.
 *
 * The third reader is the one with teeth: an installer that wrote somewhere the
 * printed instructions do not name would be two answers to one question, with
 * the user's home directory as the place they disagree. So `routesFor()` below
 * is the table, every route carries an `id`, and `installTargets()` resolves by
 * that id -- and `should name the path it writes in the route it came from` is
 * the differential, because no type can say that a string holds a path.
 *
 * ## It touches no file system, which is what keeps it on both sides
 *
 * The *shown* form of a route has to be machine-independent, because it goes
 * into a script's own header and a script is redirected to a file, checked in,
 * and generated on a build machine. The *resolved* form has to be this
 * machine's. So the shown form lives here, written as a shell spells it, and
 * the resolving lives in `./installer.ts`, which is the half that stats things.
 *
 * It imports the names and nothing else, so it stays on the deferred side: the
 * `choices` list is needed while the schema is built and none of this is, which
 * is the split `shells.ts` exists for.
 */

import type { ShellName } from './shells.js';

/**
 * Which route, so that a renderer and a resolver cannot drift apart.
 *
 * - `user` is a directory of our own with a line to add to a startup file. It
 *   is the one that works on every machine, which is why it is what the
 *   installer falls back to.
 * - `bash-completion` is `bash-completion`'s own user directory, which it loads
 *   with nothing added to a startup file -- so where it applies there is
 *   nothing left for the reader to do.
 * - `fpath` is `"${fpath[1]}"`, which only a shell can resolve and which is
 *   usually root-owned.
 * - `system` is `/etc/bash_completion.d`, which needs root.
 * - `eval` sources the command's own output and writes no file at all.
 *
 * The last three resolve to nothing, which is why `installTargets()` answers
 * with a list rather than one target per route: what this process can write
 * unprivileged is a subset of what a human in a shell can do, and those are two
 * questions rather than one answer given twice.
 */
export type RouteId = 'bash-completion' | 'eval' | 'fpath' | 'system' | 'user';

/**
 * A line the reader has to place themselves, because no append can put it where
 * it goes.
 *
 * `fpath=(dir $fpath)` has to run **above** `compinit`: that call is what scans
 * `$fpath` and builds the autoload table, so a directory added after it is one
 * nothing ever reads -- and `>>` lands at the end of the file, which is below
 * every `compinit` there is. Measured in zsh 5.9 against a `.zshrc` of the
 * ordinary shape, `autoload -Uz compinit && compinit` with the line appended
 * after it: `whence -w _mycli` is `none`. Moved one line above the `compinit`,
 * it is `function` and `$_comps[mycli]` names it. So the recipe that shipped
 * could not work for anybody who followed it -- while carrying `# above
 * compinit` as a comment on the very command that puts it below, which is the
 * broken-if-followed prose this repository calls the worst kind, in a header
 * every generated script repeats.
 *
 * It is the table saying what `installer.ts` already says -- it writes the file
 * and *prints* the rc line -- rather than a new rule. That module declines to
 * touch a startup file at all, because a `.zshrc` is under version control as
 * often as not and a line we appended cannot be told from a line the user wrote
 * when an uninstall comes to take it out; these recipes were the one place left
 * offering the append it refuses, and the one place the append does not even
 * work.
 *
 * **Which line it has to precede is not always a `compinit` line**, and this is
 * the machine-independent half, so it says the general thing. A framework runs
 * `compinit` for the reader: Oh My Zsh does it from `oh-my-zsh.sh`, so a
 * `.zshrc` that sources it holds no `compinit` at all -- measured -- and a
 * recipe naming "your compinit line" there names a line that is not in the
 * file. The *resolved* half can do better, because it reads the startup file
 * anyway: `installer.ts`'s `RcAnchor` is that, and it is the one place this
 * knowledge is allowed to be specific, because it is the one place it is known.
 *
 * Which is why it is not every append: what stays a command is every one that
 * **lands where it has to**, and both were measured rather than reasoned about.
 * `source <(app completion zsh)` must be below `compinit`, because the script's
 * sourced branch calls `compdef`, and the end of the file is exactly that --
 * `$_comps[sigil]` is `_sigil` after it. A bash `source` line has no ordering at
 * all, since it runs `complete -F`, and `complete -p sigil` reads it back in
 * bash 3.2. So an append is refused here only where no append can be right.
 */
export interface InstallLine {
  /** The line, verbatim. */
  readonly line: string;
  /** Where it goes, as a sentence that names the file and ends in a colon. */
  readonly where: string;
}

/**
 * One way to install a completion script, as the commands to run.
 *
 * A list rather than a single answer because both shells have several, and
 * which one applies is a fact about the machine rather than about the shell:
 * whether `bash-completion` is installed, whether `${fpath[1]}` is writable.
 * Printing them all and letting the reader pick is what the headers already
 * did, and choosing among them is what the installer does.
 */
export interface InstallRoute {
  /**
   * A line to put in a startup file by hand, where no command can do it. Absent
   * on every route an append really can finish, which is the asymmetry
   * `InstallLine` is written about.
   */
  readonly add?: InstallLine;
  /** Which route this is, which is what `installTargets()` resolves. */
  readonly id: RouteId;
  /** What distinguishes this route from the others. */
  readonly label: string;
  /** The commands, in order, verbatim. */
  readonly commands: readonly string[];
}

/** Every way to install a completion script for one shell. */
export interface InstallHint {
  /** The routes, the ones the installer can take first. */
  readonly routes: readonly InstallRoute[];
  /** What the reader has to do afterwards for any of it to take effect. */
  readonly after: string;
}

/**
 * The base every directory of ours hangs off, as a shell spells it.
 *
 * `${XDG_DATA_HOME:-$HOME/.local/share}` on every platform, which is
 * deliberately **not** `paths.data()`: that one answers "where does this app
 * keep its data" and is `~/Library/Application Support` on macOS and
 * `%APPDATA%` on Windows. These are paths a **shell** reads, and the one shell
 * program that hard-codes a base hard-codes this one -- `bash-completion`'s own
 * user directory is `${XDG_DATA_HOME:-$HOME/.local/share}/bash-completion`, on
 * every platform. So a completion written to
 * `~/Library/Application Support/bash-completion/completions/app` is a file
 * `bash-completion` never looks in, and using one base for bash and another for
 * zsh would be two answers to "where does a completion script live".
 *
 * Written `~/.local/share` here rather than with the variable in it, because
 * this is a line a reader has to be able to follow and paste; `installTargets()`
 * is where `XDG_DATA_HOME` is read, and `baseDir()`'s rule is what reads it.
 */
const SHOWN_BASE = '~/.local/share';

/** The directory of ours that holds every sigil app's completions. */
const SHOWN_USER_DIR = `${SHOWN_BASE}/completions`;

/** `bash-completion`'s own user directory, by its own rule. */
const SHOWN_BC_DIR = `${SHOWN_BASE}/bash-completion/completions`;

/**
 * The marker a generated script carries, which is how the installer tells one
 * of ours from a file somebody wrote.
 *
 * Both emitters interpolate this into their own header, so there is one string
 * rather than a grep for a sentence that could be reworded in one emitter and
 * not the other -- which is the rule this module's own opening is about. What it
 * buys the installer is a distinction `sigil add` has to make with `--force`
 * alone: a file of ours is generated output and may be replaced freely, where a
 * file that is not is somebody's work and is refused.
 *
 * The shell is in it as well as the program, so a zsh script sitting at the
 * bash path is a foreign file by our own reckoning -- which is the right answer,
 * because replacing it would be replacing a file whose content we did not
 * predict.
 *
 * @param shell - The shell the script is for.
 * @param program - The program's name.
 * @returns The sentence, with no `#` and no newline.
 */
export function generatedBy(shell: ShellName, program: string): string {
  return `${shell} completion for \`${program}\`, generated by sigil.`;
}

/**
 * Whether a shell could register a completion for this name.
 *
 * One predicate because there are two readers and they must not come apart:
 * `completionSpec()` asks before printing a script, because a script says which
 * command it completes for in three places and zsh's `#compdef` first line is a
 * *comment* `compinit` reads, which cannot be quoted at all; and
 * `installTargets()` asks because an **uninstall** builds no spec, so that path
 * had the question asked nowhere. Each caller keeps its own sentence, because
 * each is about a different consequence -- which is the shape `isMissing()`
 * already has.
 *
 * Whitespace and a leading dash. The second is not a quoting problem either:
 * quote removal happens before a builtin reads its words, so
 * `complete -o default -F _x '-D'` is `complete: -D: invalid option` and the
 * name is never registered -- measured.
 *
 * It says nothing about whether the name is one *path* segment, which is a
 * different question with a different owner: a program called `a/b` can be
 * registered and invoked, and cannot be a file named after itself. That half is
 * `installTargets()`'s alone.
 *
 * A type predicate rather than a `boolean`, because `completionSpec()` reads a
 * `schema.name` that may be absent and the guard it replaces narrowed it: one
 * function answering both "is this usable" and "is this there" is what lets the
 * caller go on using the name afterwards.
 *
 * @param program - The program's name, or nothing where the schema names none.
 * @returns Whether a shell can register it.
 */
export function registerable(program: string | undefined): program is string {
  return (
    program !== undefined && program !== '' && !/\s/u.test(program) && !program.startsWith('-')
  );
}

/**
 * A string as one shell word, single-quoted.
 *
 * POSIX single-quoting, which is one rule rather than bash's and zsh's: a path
 * this interpolates into a startup file comes out of `homedir()` and may hold a
 * space -- `~/Library/Application Support` is the obvious one -- or a quote, and
 * an unquoted line is a shell injection into a file that runs on every login.
 * `bashQuote()` is this function, so the two cannot come to disagree about what
 * a quoted word is.
 *
 * @param text - What to quote.
 * @returns It, as one word.
 */
export function shQuote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/**
 * The routes for one shell, in the order the installer prefers them.
 *
 * The automatic ones first, which is the order the installer reads and is also
 * the useful order to print: `bash-completion`'s user directory needs nothing
 * added to a startup file, so where it applies there is nothing left to do.
 *
 * @param shell - The shell.
 * @param program - The program's name, as the user types it.
 * @returns The routes.
 */
function routesFor(shell: ShellName, program: string): readonly InstallRoute[] {
  if (shell === 'zsh') {
    return [
      {
        add: {
          line: `fpath=(${SHOWN_USER_DIR} $fpath)`,
          where:
            "then add this line to ~/.zshrc, above whatever runs compinit -- yours or your framework's:",
        },
        commands: [
          `mkdir -p ${SHOWN_USER_DIR}`,
          `${program} completion zsh > ${SHOWN_USER_DIR}/_${program}`,
        ],
        id: 'user',
        label: 'in a directory of your own on $fpath, which compinit autoloads',
      },
      {
        commands: [`${program} completion zsh > "\${fpath[1]}/_${program}"`],
        id: 'fpath',
        label: 'or straight onto your $fpath, where its first entry is writable',
      },
      {
        commands: [`echo 'source <(${program} completion zsh)' >> ~/.zshrc  # below compinit`],
        id: 'eval',
        label: 'or sourced from .zshrc with no file at all',
      },
    ];
  }

  return [
    {
      commands: [
        `mkdir -p ${SHOWN_BC_DIR}`,
        `${program} completion bash > ${SHOWN_BC_DIR}/${program}`,
      ],
      id: 'bash-completion',
      label: 'with bash-completion 2.8 or newer, which loads it with nothing added',
    },
    {
      commands: [
        `mkdir -p ${SHOWN_USER_DIR}`,
        `${program} completion bash > ${SHOWN_USER_DIR}/${program}.bash`,
        `echo 'source ${SHOWN_USER_DIR}/${program}.bash' >> ~/.bashrc`,
      ],
      id: 'user',
      label: 'or from your own .bashrc, on any bash',
    },
    {
      commands: [`${program} completion bash > /etc/bash_completion.d/${program}`],
      id: 'system',
      label: 'or system wide, which needs root',
    },
  ];
}

/**
 * How to install `program`'s completion for `shell`.
 *
 * @param shell - The shell.
 * @param program - The program's name, as the user types it.
 * @returns The routes and what follows them.
 */
export function installHint(shell: ShellName, program: string): InstallHint {
  return { after: 'Then restart your shell.', routes: routesFor(shell, program) };
}

/**
 * The hint as the comment block a generated script opens with.
 *
 * Rendered rather than written out, so that the script, the instructions the
 * command prints and the paths the installer writes cannot disagree about where
 * a completion goes.
 *
 * @param shell - The shell.
 * @param program - The program's name.
 * @returns Lines, each already `#`-prefixed, with no trailing newline.
 */
export function installComment(shell: ShellName, program: string): string {
  const hint = installHint(shell, program);
  const out: string[] = [];

  for (const route of hint.routes) {
    out.push('#', `#   # ${route.label}`);
    for (const command of route.commands) {
      out.push(`#   ${command}`);
    }
    if (route.add !== undefined) {
      // the sentence takes the inner `#` the label takes, because it is prose
      // rather than a command -- so what a reader copies out of the block is
      // the line beneath it and nothing else
      out.push(`#   # ${route.add.where}`, `#   ${route.add.line}`);
    }
  }

  out.push('#', `# ${hint.after}`);

  return out.join('\n');
}

/**
 * Which shell the user is in, read off the environment.
 *
 * `SHELL` is the login shell rather than the running one -- a user in `bash`
 * under a `zsh` login still reads `zsh` here -- which is the right answer
 * anyway, because what is being installed goes in a startup file that the
 * login shell is the one to read.
 *
 * Matched on the **basename**, because the value is a path: `/bin/zsh`,
 * `/usr/local/bin/bash` and `/opt/homebrew/bin/bash` are all one of two
 * answers. A version suffix is not read -- `bash5` is not `bash` -- because
 * guessing there is how `csh` comes back as something it is not.
 *
 * @param env - The environment to read, for a caller that has one.
 * @returns The shell, or nothing where the variable named none this knows.
 */
export function detectShell(env: Record<string, string | undefined>): ShellName | undefined {
  const path = env['SHELL'];
  if (!path) {
    return undefined;
  }

  // the last segment of either separator, so a value somebody set by hand on
  // Windows is read the same way
  const name = path.split(/[/\\]/).pop();

  return name === 'bash' || name === 'zsh' ? name : undefined;
}

/**
 * The hint as the block the `completion` command prints when there is nobody to
 * ask.
 *
 * The same routes the script's own header carries, rendered for a terminal
 * rather than as shell comments -- which is the whole reason `installHint()`
 * is data.
 *
 * @param shell - The shell.
 * @param program - The program's name.
 * @returns The block, with a trailing newline.
 */
export function instructions(shell: ShellName, program: string): string {
  const hint = installHint(shell, program);
  const out: string[] = [];

  for (const route of hint.routes) {
    out.push(`  ${route.label}`);
    for (const command of route.commands) {
      out.push(`    ${command}`);
    }
    if (route.add !== undefined) {
      // at the label's indent and the command's, so the sentence reads as the
      // route's own and the line reads as the thing to take away
      out.push(`  ${route.add.where}`, `    ${route.add.line}`);
    }
    out.push('');
  }

  out.push(hint.after, '');

  return out.join('\n');
}
