/**
 * An editor prompt: the answer is written in the person's own editor.
 *
 * `multiline()` is a few lines inside the prompt. A commit message or a config
 * blob wants vim, or VS Code, or whatever the person has spent years setting up,
 * so this writes a temporary file, opens `$VISUAL` or `$EDITOR` on it, and
 * answers with what was saved -- the shape Inquirer's `editor` and `git commit`
 * both have.
 *
 * ```js
 * const message = await editor({
 *   message: 'Commit message',
 *   default: 'Fix the thing\n\nBecause it was broken.',
 *   postfix: '.md',
 * });
 * ```
 *
 * The question is drawn first and Enter opens the editor, so nothing appears
 * over the screen before the person has asked for it. While the editor runs the
 * prompt holds nothing: the region is given up, stdin is paused with raw mode
 * off, and the cursor is shown -- the same teardown an answer gets, because it
 * *is* one. The question is drawn again afterwards, from scratch, which is what
 * makes giving the terminal up complete rather than mostly: nothing of the
 * prompt's is alive to repaint over the editor.
 */

import { box, text as textNode, toDisplayText } from '../element/index.js';
import { __ } from '../i18n/index.js';
import {
  CURSOR_HOME,
  cursorUp,
  ERASE_DOWN,
  type InputStream,
  terminal as defaultTerminal,
} from '../terminal/index.js';
import { which } from '../which.js';
import { stringWidth } from '../width/index.js';
import { wrap } from '../wrap/index.js';
import { mountLive } from './mount.js';
import {
  promptAnswered,
  PromptError,
  promptHeadLine,
  promptHeadWidths,
  promptNote,
  type PromptOptions,
  promptSummary,
  runPrompt,
  setPromptNote,
} from './prompt.js';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';

export interface EditorOptions extends Omit<PromptOptions, 'router'> {
  /**
   * What the file starts with, which the person then edits.
   *
   * Not a fallback for an empty answer the way `text()`'s is: an editor shows
   * what is in the file, so the default is *visible and editable* rather than
   * implied, and deleting it is how somebody says "nothing". Written as given.
   */
  default?: string;
  /**
   * The command to run, ahead of `$VISUAL` and `$EDITOR`.
   *
   * For an app that keeps its own setting -- git's `core.editor` is the shape.
   * It is a shell command like the variables are, so `code --wait` works and a
   * path with a space in it is quoted the way a shell would want it.
   */
  editor?: string;
  /**
   * Appended to the temporary file's name, so the editor picks a syntax mode:
   * `.md`, `.json`, `.yaml`. Defaults to `.txt`.
   *
   * A suffix rather than a whole name, and one with no path separator in it,
   * because the file lives in a directory made for it and must stay there.
   */
  postfix?: string;
  /**
   * Checks the answer. Return a string to reject it with that message, or
   * anything falsy to accept. A rejected answer is shown under the question, and
   * Enter opens the editor again on exactly what was saved.
   */
  validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
}

/** What the platform falls back to when neither variable names an editor. */
function fallbackEditor(): string {
  // POSIX requires `vi`, and it is git's default for that reason; Windows has no
  // terminal editor that is always there, and Notepad always is
  return process.platform === 'win32' ? 'notepad' : 'vi';
}

/**
 * Which editor to open: `$VISUAL`, then `$EDITOR`, then the platform's own.
 *
 * The two variables are **commands**, run as written through the shell, and are
 * not looked up here: `code --wait`, `vim -u NONE` and a quoted path with a
 * space in it are all ordinary values, and splitting one is the shell's job. The
 * platform default is different -- nobody asked for it, so it is only offered if
 * `which()` finds it, and a machine with neither variable and no `vi` gets
 * `undefined` rather than an editor that cannot start.
 *
 * A variable that is empty or blank is read as unset, which is the rule the
 * parser keeps for an environment value.
 *
 * @param env - The environment to read. `process.env` if omitted.
 * @returns The command, or `undefined` if there is no editor to open.
 */
export async function resolveEditor(
  env: Readonly<Record<string, string | undefined>> = process.env
): Promise<string | undefined> {
  for (const name of ['VISUAL', 'EDITOR']) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }

  const fallback = fallbackEditor();
  // the environment handed in decides where to look as well as what to run, so
  // a caller asking about another environment is not answered from this one's
  // `PATH`. `Path` because a plain object is case-sensitive and `process.env`
  // on Windows is not
  const path = env === process.env ? undefined : (env.PATH ?? env.Path ?? '');
  const found = await which(fallback, { path, pathExt: env.PATHEXT });
  return found === undefined ? undefined : fallback;
}

/** How the editor's process ended. */
interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * The exit codes that mean the editor was interrupted rather than that it failed.
 *
 * 130 is `128 + SIGINT`, which is how a shell reports a child that died of one --
 * and the shell is what is spawned, so it is the usual way the signal comes back.
 * `0xC000013A` is `STATUS_CONTROL_C_EXIT`, Windows' spelling of the same thing.
 */
const INTERRUPTED = new Set([130, 0xc000013a]);

/** Each signal's name by its number, the first name where two share one. */
const SIGNAL_NAMES = new Map<number, NodeJS.Signals>();
for (const [name, number] of Object.entries(constants.signals)) {
  if (!SIGNAL_NAMES.has(number)) {
    SIGNAL_NAMES.set(number, name as NodeJS.Signals);
  }
}

/**
 * How the editor ended, read back through the shell that ran it.
 *
 * `/bin/sh` is bash on macOS, which execs the last command of a `-c` string, so a
 * signal that kills the editor reaches this process as a signal. On Debian and
 * Ubuntu it is dash, which waits for the editor instead and exits `128 + n` when
 * the editor dies of signal `n`. So an editor killed by SIGTERM came back as
 * `exited with code 143`. That is the convention 130 in `INTERRUPTED` already
 * reads, and here it is read the same way for every signal. Not on Windows, where
 * `cmd.exe` has no such convention and a code above 128 is just a code.
 */
function throughShell(exit: Exit): Exit {
  const name =
    exit.signal === null && exit.code !== null && exit.code > 128
      ? SIGNAL_NAMES.get(exit.code - 128)
      : undefined;
  return name === undefined ? exit : { code: null, signal: name };
}

/**
 * Runs the editor on a file and waits for it to exit.
 *
 * Through the shell, because `$EDITOR` is a shell command: that is what git does
 * with it, and it is the only reading under which `code --wait` and a quoted path
 * with spaces both work. On POSIX the file goes in as `$1` rather than being
 * spliced into the command, so it needs no quoting at all -- `sh -c '<editor>
 * "$@"' <editor> <file>` is git's own spelling. `cmd.exe` has no positional
 * parameters, so on Windows the file is quoted into the line; a Windows path
 * cannot hold a `"`, so double quotes are enough.
 *
 * `stdio: 'inherit'` hands the editor the process's own terminal. That is safe
 * only because the prompt has already let go of it: a stdin still flowing into a
 * listener here would take keys out from under the editor.
 *
 * @param command - The editor, as the user wrote it.
 * @param file - The file to edit.
 * @returns How it ended.
 */
function launch(command: string, file: string): Promise<Exit> {
  const child =
    process.platform === 'win32'
      ? spawn(`${command} "${file}"`, { shell: true, stdio: 'inherit' })
      : spawn('/bin/sh', ['-c', `${command} "$@"`, command, file], { stdio: 'inherit' });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      resolve(process.platform === 'win32' ? { code, signal } : throughShell({ code, signal }))
    );
  });
}

/** The signals that end the process while an editor is open, as well as SIGINT. */
const FATAL = ['SIGHUP', 'SIGTERM'] as const;

/**
 * Removes the temporary directory however the process ends, for as long as it
 * exists, and lets SIGINT through to the editor rather than to this process.
 *
 * SIGINT is **ignored** while the editor runs, which is git's rule and for git's
 * reason. Ctrl-C reaches every process in the foreground group, so a GUI editor's
 * terminal would otherwise kill this one and orphan the editor, with the temp file
 * left behind. The editor decides what Ctrl-C means; if it dies of it, that comes
 * back as its exit status and is read as a cancel.
 *
 * SIGHUP and SIGTERM end the process, so they remove the directory and then stand
 * down the way the terminal's own restore handler does: the listeners come off,
 * and if nothing else is listening the signal is raised again so that it lands
 * with its default action. A listener on a signal replaces that action, and a CLI
 * that stopped dying on SIGTERM because a prompt was open is a worse bug than a
 * file left in the temp directory. `exit` covers `process.exit()` from anywhere.
 *
 * @param dir - The directory to remove.
 * @returns Removes the directory and every listener. Safe to call twice.
 */
function hold(dir: string): () => void {
  let held = true;
  const remove = (): void => rmSync(dir, { force: true, recursive: true });
  const ignore = (): void => {};
  const fatal = FATAL.map((signal) => {
    const handler = (): void => {
      release();
      if (process.listenerCount(signal) === 0) {
        process.kill(process.pid, signal);
      }
    };
    return [signal, handler] as const;
  });

  function release(): void {
    if (!held) {
      return;
    }
    held = false;
    process.removeListener('exit', remove);
    process.removeListener('SIGINT', ignore);
    for (const [signal, handler] of fatal) {
      process.removeListener(signal, handler);
    }
    remove();
  }

  process.on('exit', remove);
  process.on('SIGINT', ignore);
  for (const [signal, handler] of fatal) {
    process.on(signal, handler);
  }

  return release;
}

/** What a run of the editor came to: how it exited, and what was saved if that was cleanly. */
interface Edited {
  exit: Exit;
  saved?: string;
}

/**
 * Writes `content` to a fresh temporary file, opens the editor on it, and reads
 * back what was saved.
 *
 * The file is in a directory of its own, made by `mkdtemp()`: that is private to
 * this user and cannot be raced the way a predictable name in the shared temp
 * directory can, and removing the *directory* takes the editor's own litter with
 * it -- vim's `.swp` and a `~` backup are written beside the file. It exists for
 * exactly the life of one run of the editor, so no path that does not open an
 * editor has anything to clean up.
 *
 * @param command - The editor.
 * @param content - What the file starts with.
 * @param postfix - The end of the file's name.
 * @returns How the editor exited, and what was saved if it exited cleanly.
 */
async function edit(command: string, content: string, postfix: string): Promise<Edited> {
  // `sigil.` rather than `sigil-`, because a `sigil-` token in a component's
  // source is read as a class it draws with -- by the theme test that holds the
  // framework sheet to every class a built-in uses, and by the registry's
  // `classes` list -- and a directory name is not one
  const dir = mkdtempSync(join(tmpdir(), 'sigil.editor-'));
  const release = hold(dir);
  try {
    const file = join(dir, `edit${postfix}`);
    // owner-only, since an answer may be a secret and the temp directory is shared
    writeFileSync(file, content, { mode: 0o600 });
    const exit = await launch(command, file);
    if (exit.code !== 0) {
      return { exit };
    }
    return { exit, saved: readFileSync(file, 'utf8') };
  } finally {
    release();
  }
}

/**
 * The answer in what was saved.
 *
 * A byte order mark and CRLF line breaks are how a platform's editor encodes a
 * file, not what the person wrote -- Notepad has written both -- so the same edit
 * answers the same string on every platform. One trailing line break goes for the
 * same reason: vim adds one to every file it saves and Notepad adds none, so
 * keeping it would make an untouched `default` come back changed on one platform
 * and not on the other. Any further blank lines were typed, and stay.
 *
 * @param saved - The file's contents.
 * @returns The answer.
 */
function answerOf(saved: string): string {
  const text = saved.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n');
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

/** Names an option that cannot be used, the way `toggle()` does. */
function refuse(message: string, what: string): Promise<never> {
  return Promise.reject(new PromptError(`"${message}" cannot be asked: ${what}`));
}

/**
 * How many rows a line takes once wrapped to a width, through the wrapper the
 * text element draws with.
 */
function rowsOf(text: string, width: number): number {
  return wrap(toDisplayText(text), { width }).split('\n').length;
}

/**
 * Asks once: the question, Enter to open the editor, and the line left on
 * screen while it is open.
 *
 * Resolves with the number of rows that line takes, which is what the caller
 * erases once the editor has closed. Worked out from the same widths the head is
 * drawn at -- the message's own and what is left beside it -- so the count and
 * the frame cannot disagree.
 *
 * @param opts - The prompt.
 * @param error - Why the last answer was rejected, if it was.
 * @returns The rows left on screen.
 */
function ask(opts: EditorOptions, error: string | undefined): Promise<number> {
  const terminal = opts.terminal ?? defaultTerminal;

  return runPrompt<number>(opts, () => {
    // "your editor" rather than the command: a command is a path and its flags,
    // which is half a line of noise beside a question, and the one place naming
    // it helps -- an editor that would not start -- is an error that does name it
    const hint = __`Press Enter to open your editor`;
    const waiting = __`Waiting for your editor to close the file…`;
    // the wider of the two is reserved, so the message is the same width in both
    // states and swapping one for the other cannot reflow the question
    const head = promptHeadWidths(
      opts.message,
      Math.max(1, terminal.width),
      stringWidth(waiting) > stringWidth(hint) ? waiting : hint
    );
    const tail = textNode(hint, { class: 'sigil-prompt-hint sigil-muted' });
    const { line } = promptHeadLine(opts.message, head.message, tail);
    const complaint = promptNote('sigil-prompt-error sigil-error');
    setPromptNote(complaint, error);
    const view = box(
      { class: 'sigil-prompt', 'flex-direction': 'column' },
      line,
      box({ 'padding-left': 2 }, complaint)
    );

    return {
      key(k) {
        // a modifier makes it a different key, the rule `confirm()` keeps
        if (k.name === 'enter' && !k.ctrl && !k.meta && !k.shift) {
          return {
            value: Math.max(rowsOf(opts.message, head.message), rowsOf(waiting, head.rest)),
          };
        }
      },

      settle(): void {
        // what is left on screen while the editor is open, which matters for one
        // that opens a window and leaves this terminal showing: without it, the
        // question has gone and the program looks hung
        tail.setText(waiting);
        setPromptNote(complaint, undefined);
      },

      view,
    };
  });
}

/**
 * Leaves the answered line: the question, marked done, and the first line of the
 * answer.
 *
 * Drawn once and given up, since nothing about it changes. `quiet: false` for the
 * reason every prompt writes it: the answer is a dialogue's, not progress.
 */
function answered(opts: EditorOptions, value: string): void {
  const terminal = opts.terminal ?? defaultTerminal;
  const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
  const answer = textNode(promptSummary(value), { class: 'sigil-prompt-answer sigil-muted' });
  const { line, mark } = promptHeadLine(opts.message, head.message, answer);
  promptAnswered(mark);

  const mounted = mountLive(() => line, { ...opts, quiet: false, terminal });
  try {
    mounted.frame();
  } finally {
    mounted.done();
  }
}

/**
 * Asks for text written in the person's own editor.
 *
 * @param opts - What to ask, what the file starts with, and what it is called.
 * @returns What was saved, with the platform's encoding taken off it.
 */
export async function editor(opts: EditorOptions): Promise<string> {
  // the type takes `router` away; this is for a caller the type is not checking.
  // A router handed in is the app's and stays running, and a running router reads
  // stdin -- so the editor would be fighting it for every key. Giving the
  // terminal up completely is the whole of what this prompt needs, and a borrowed
  // router is the one thing it cannot give up
  if ((opts as PromptOptions).router !== undefined) {
    return refuse(opts.message, 'it opens an editor, which cannot share stdin with a router');
  }
  if (opts.default !== undefined && typeof opts.default !== 'string') {
    return refuse(opts.message, `\`default\` is ${JSON.stringify(opts.default)}, not a string`);
  }
  if (opts.editor !== undefined && (typeof opts.editor !== 'string' || opts.editor.trim() === '')) {
    return refuse(opts.message, '`editor` is empty, and an empty command opens nothing');
  }
  const postfix = opts.postfix ?? '.txt';
  if (typeof postfix !== 'string' || /[/\\]|\p{Cc}/u.test(postfix)) {
    return refuse(
      opts.message,
      `\`postfix\` ${JSON.stringify(postfix)} would put the file outside its own directory`
    );
  }

  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);

  // the editor is looked for only where somebody could use one: with nobody to
  // answer, the first `ask()` rejects with the sentence every prompt rejects with,
  // and that says more than "no editor" about why nothing happened
  let command: string | undefined;
  if (terminal.isTTY && stdin?.isTTY) {
    command = opts.editor?.trim() ?? (await resolveEditor());
    if (command === undefined) {
      throw new PromptError(
        __`Cannot open an editor for "${opts.message}": set $VISUAL or $EDITOR`
      );
    }
  }

  let content = opts.default ?? '';
  let error: string | undefined;

  for (;;) {
    const rows = await ask(opts, error);

    // the line left on screen is erased once the editor closes, which is right
    // only if the screen is the one it was drawn on. A resize rewraps it to a
    // height there is no way to recover, so it is left -- the rule the live
    // region keeps for a stale frame: rows above may linger rather than an
    // erase taking a guess at them
    let resized = false;
    const offResize = terminal.onResize(() => {
      resized = true;
    });

    let edited: Edited;
    try {
      edited = await edit(command as string, content, postfix);
    } catch (cause) {
      offResize();
      throw new PromptError(
        __`Could not open ${command as string}: ${(cause as Error).message ?? String(cause)}`
      );
    }
    offResize();

    const { exit } = edited;
    const interrupted = exit.signal === 'SIGINT' || INTERRUPTED.has(exit.code as number);

    // erased after a clean exit and after a cancel, and left after a failure: an
    // editor that failed has usually said why under the line, and the screen is
    // the only record of it
    if (!resized && (edited.saved !== undefined || interrupted)) {
      terminal.write(cursorUp(rows) + CURSOR_HOME + ERASE_DOWN);
    }

    // the program gave up while the editor was open. It could not take the
    // terminal back from another program, so it waited; what was saved is dropped
    if (opts.signal?.aborted) {
      throw opts.signal.reason;
    }

    if (interrupted) {
      throw new PromptError(__`Cancelled`, true);
    }
    if (edited.saved === undefined) {
      throw new PromptError(
        exit.signal === null
          ? __`${command as string} exited with code ${String(exit.code)}`
          : __`${command as string} was stopped by ${exit.signal}`
      );
    }

    const value = answerOf(edited.saved);
    const failed = await opts.validate?.(value);
    if (opts.signal?.aborted) {
      throw opts.signal.reason;
    }
    if (typeof failed === 'string' && failed) {
      // the next run starts from what was saved, byte for byte, so a rejected
      // answer is corrected rather than retyped
      content = edited.saved;
      error = failed;
      continue;
    }

    answered(opts, value);
    return value;
  }
}
