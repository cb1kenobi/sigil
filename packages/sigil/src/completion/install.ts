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
 * The block that goes in a startup file, with the two comments that mark it.
 *
 * SIG-151 printed a line for the reader to place and SIG-155 appends it, which
 * is the one decision this module's shape turned on: the whole reason the line
 * was printed rather than written is that `fpath=(dir $fpath)` has to run
 * **above** `compinit` -- that call is what scans `$fpath` and builds the
 * autoload table, so a directory added after it is one nothing ever reads, and
 * `>>` lands at the end of the file, which is below every `compinit` there is.
 * Measured in zsh 5.9 against a `.zshrc` of the ordinary shape: appended after
 * the `compinit`, `whence -w _mycli` is `none`; moved one line above it,
 * `function`.
 *
 * So the route that is **installed** is the one whose line an append can place,
 * which is the other one zsh has: the script is `source`d rather than
 * autoloaded, it registers with `compdef`, and the end of the file is exactly
 * where that has to be. One file serves both modes already -- see the
 * `$funcstack[1]` test in `../zsh.ts` -- so nothing about the script or its path
 * moved. What was given up is lazy autoloading, and it was measured before it
 * was given up: sourcing sigil's own 11.5 kB script is **0.20 ms** and a 115 kB
 * one **1.88 ms**, in zsh 5.9 over 200 iterations with three runs agreeing. A
 * shell startup does not notice either.
 *
 * ## Both marker comments, because removal needs an extent
 *
 * A `.zshrc` is under version control as often as not, which is a reason to
 * **ask** rather than a reason never to -- and the other half of SIG-151's
 * refusal, that "a line we added and a line they added look identical
 * afterwards", is what the markers answer. They are the same distinction
 * `generatedBy()` draws one file along: a block carrying ours is ours and comes
 * back out, and anything else is somebody's and is described instead.
 *
 * The **end** marker is what makes that a fact rather than a guess. Without it
 * the extent of a block is "as many lines as the block we would write today",
 * which is a claim about a *past* version of this function -- so a block whose
 * shape changed between releases would be removed by the line count of the new
 * one. With it, an uninstall either finds both markers and knows exactly what to
 * cut or finds one and refuses, which is the direction every other guess in this
 * area is resolved in.
 */
export interface InstallBlock {
  /** The block, one string per line, markers included. */
  readonly lines: readonly string[];
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
   * The block that goes in a startup file, where the route needs one. Absent on
   * `bash-completion`'s own user directory, which loads a completion with
   * nothing added anywhere -- which is why that route is offered first for bash
   * and is the one route an install finishes outright.
   */
  readonly add?: InstallBlock;
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

/**
 * The same base as `$HOME`, for the one place a `~` cannot be written.
 *
 * `rcBlock()` **quotes** the path it is given, because a path out of
 * `homedir()` may hold a space -- `~/Library/Application Support` is the obvious
 * one -- and an unquoted line in a file that runs on every login is a shell
 * injection. A `~` does not expand inside quotes of either kind, so the shown
 * block cannot spell its path the way the shown *commands* do: `mkdir -p
 * ~/.local/share/completions` is a command whose tilde must stay bare, and
 * `source '~/.local/share/completions/_mycli'` is a line that names a directory
 * called `~`. Which is this file's own rule about prose that breaks if followed,
 * met in the one place where the two spellings of one path genuinely differ.
 *
 * Which also fixes the quote **style** rather than only the spelling, and the
 * first version of this got it half right: the shown block is written with
 * **double** quotes, because `$HOME` no more expands inside single quotes than a
 * `~` does, so `'$HOME/.local/share/completions/_mycli'` is a path with a dollar
 * sign in it and the block would have been exactly as unfollowable as the tilde
 * it replaced. Double quotes expand the variable and still hold a path with a
 * space in it, which is the whole of what the quoting is for. `installer.ts`
 * quotes with `shQuote()` instead, because what it writes is an absolute path
 * with nothing in it to expand -- so the two callers of `rcBlock()` really do
 * spell the path differently, which is why that function takes it already
 * quoted rather than quoting it itself.
 *
 * `$HOME` rather than `${HOME}` because it is followed by a `/`, and both are in
 * the spellings `installer.ts` recognises anyway.
 */
const SHOWN_HOME_BASE = '$HOME/.local/share';

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
 * The comment that opens a block of ours in a startup file.
 *
 * `generatedBy()` with one word changed, deliberately: the two markers are
 * siblings and answer the same question about two different files, so a reader
 * who has met one recognises the other. The shell is in it for that function's
 * own reason -- a zsh block in a `.bashrc` is not a block we would have written,
 * and the right answer to a file we did not predict is to leave it alone.
 *
 * @param shell - The shell the block is for.
 * @param program - The program's name.
 * @returns The sentence, with no `#` and no newline.
 */
export function addedBy(shell: ShellName, program: string): string {
  return `${shell} completion for \`${program}\`, added by sigil.`;
}

/**
 * The comment that closes it, which is what gives the block an extent.
 *
 * See `InstallBlock` for why an end marker rather than a line count: the count
 * is a claim about the version of `rcBlock()` that wrote the block, and an
 * uninstall is reading one written by some other version of it.
 *
 * @param shell - The shell the block is for.
 * @param program - The program's name.
 * @returns The sentence, with no `#` and no newline.
 */
export function blockEnd(shell: ShellName, program: string): string {
  return `end of ${shell} completion for \`${program}\`.`;
}

/**
 * The block to put in a startup file, built once for both readers.
 *
 * Two callers spell the path differently and neither spells the block: this
 * table passes `$HOME/...` because what it renders goes into a generated
 * script's header and into the instructions, where it has to be
 * machine-independent, and `installer.ts` passes an absolute path because what
 * it writes has to be this machine's. The *shape* has one author, which is the
 * rule this module opens with -- a block the installer wrote and a block the
 * instructions told somebody to paste must be the same block, or an uninstall
 * finds a hand-pasted one it does not recognise.
 *
 * ## What each line is for, because none of them is decoration
 *
 * The `-s` test is Bun's, and it is what keeps a removed script from being an
 * error on every shell startup: `npm rm -g mycli` takes the program away and
 * leaves the block, and an unguarded `source` of a file that is not there
 * writes a line to the terminal every time a shell opens. It tests for a
 * non-empty file rather than for existence, because a half-written one is the
 * other thing a shell cannot source -- and `writeAtomic()` is what makes that
 * case not ours.
 *
 * `(( $+functions[compdef] ))` is the zsh half and it replaces a static read
 * that could not be right. The sourced script calls `compdef`, which exists
 * only after `compinit` has run, and whether anything runs one is the question
 * `installer.ts` used to answer by grepping the startup file for the word --
 * which conflates three states a framework puts a reader in. Oh My Zsh runs
 * `compinit` from `oh-my-zsh.sh`, so such a `.zshrc` holds no `compinit` at all
 * while the completion system is fully set up, and a table of what runs one was
 * built and refused for having exactly one measurable entry. The parameter
 * subscript asks the shell instead, at the moment it matters. Verified in all
 * three shapes with a counter on the guarded branch, because a redundant
 * `compinit` is ~12 ms of someone's shell startup rather than nothing: a bare
 * `.zshrc` runs it and registers, a `.zshrc` with its own `compinit` above skips
 * it and registers, and the Oh My Zsh shape skips it and registers.
 *
 * bash gets neither of those and two of its own. There is no ordering to
 * respect -- the script runs `complete -F`, which `complete -p mycli` reads back
 * in bash 3.2 -- so the block is the guard and the source. It is written in
 * POSIX `sh` with `[` and `.` rather than `[[` and `source`, and it tests
 * `BASH_VERSION`, because `firstExisting()` can land it in `.profile`: that file
 * is read by `/bin/sh` as well as by bash, where `[[` is a syntax error and a
 * bash completion script is not something to source at all. The two
 * conventional targets cannot see the difference, so the cost is nothing and
 * the third one stops being a hole.
 *
 * @param shell - The shell.
 * @param program - The program's name.
 * @param quoted - The script's path, **already quoted** as one shell word.
 * @returns The lines, markers included, with no trailing newline.
 */
export function rcBlock(shell: ShellName, program: string, quoted: string): readonly string[] {
  const open = `# ${addedBy(shell, program)}`;
  const close = `# ${blockEnd(shell, program)}`;

  if (shell === 'zsh') {
    return [
      open,
      `if [[ -s ${quoted} ]]; then`,
      '  (( $+functions[compdef] )) || { autoload -Uz compinit && compinit }',
      `  source ${quoted}`,
      'fi',
      close,
    ];
  }

  return [
    open,
    `if [ -n "\${BASH_VERSION-}" ] && [ -s ${quoted} ]; then`,
    `  . ${quoted}`,
    'fi',
    close,
  ];
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
          lines: rcBlock('zsh', program, `"${SHOWN_HOME_BASE}/completions/_${program}"`),
          where: 'then add this block to the end of ~/.zshrc:',
        },
        commands: [
          `mkdir -p ${SHOWN_USER_DIR}`,
          `${program} completion zsh > ${SHOWN_USER_DIR}/_${program}`,
        ],
        id: 'user',
        label: 'in a directory of your own, sourced from .zshrc',
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
      add: {
        lines: rcBlock('bash', program, `"${SHOWN_HOME_BASE}/completions/${program}.bash"`),
        where: 'then add this block to the end of ~/.bashrc:',
      },
      // the `echo ... >>` that used to be the third command is the block now, and
      // that is the one place this table changed shape rather than wording: an
      // append the installer performs and an append the instructions recite have
      // to be the same bytes, or an uninstall meets a hand-pasted line it does not
      // recognise. So there is one author for it and `add` is where it lives --
      // which is also what makes the bash and the zsh recipe read the same way,
      // where before one of them ended in a command and the other in a sentence
      commands: [
        `mkdir -p ${SHOWN_USER_DIR}`,
        `${program} completion bash > ${SHOWN_USER_DIR}/${program}.bash`,
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
      // the lines beneath it and nothing else. Which now includes the block's
      // own `#` comments, so a line of it reads `#   # zsh completion for ...`:
      // two levels of comment, and that is correct rather than untidy, because
      // the outer one is this header and the inner one is what gets pasted
      out.push(`#   # ${route.add.where}`, ...route.add.lines.map((line) => `#   ${line}`));
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
      // route's own and the block reads as the thing to take away
      out.push(`  ${route.add.where}`, ...route.add.lines.map((line) => `    ${line}`));
    }
    out.push('');
  }

  out.push(hint.after, '');

  return out.join('\n');
}
