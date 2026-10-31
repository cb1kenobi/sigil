/**
 * A file picker: browse a directory tree with the arrows.
 *
 * `path()` is a text field that completes, for someone who knows the name. This
 * is the other shape, for someone who does not: a list of what is in a directory,
 * Right or Enter to go into one, Left or Backspace to come back out, and the
 * answer is the entry you land on.
 *
 * ```js
 * const file = await filePicker({ message: 'Which config?', extensions: ['json', 'yaml'] });
 * ```
 *
 * It is a component of its own rather than a mode of `path()`, because the two
 * share a question and almost nothing else -- the field's state is a string and a
 * cursor, this one's is a directory and a highlight. What they do share is
 * imported from `path.ts`: what a directory holds, which of it is offered, and
 * the once-per-directory read, so the two agree about what a file is.
 */

import { box, type Element, text as textNode } from '../element/index.js';
import { __ } from '../i18n/index.js';
import { baseDir } from '../paths.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { truncate } from '../wrap/index.js';
import { typedText } from './editing.js';
import {
  candidatesOf,
  entryCache,
  type PathEntry,
  type PathFilter,
  type PathFlavour,
} from './path.js';
import {
  listWindow,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptHeadLine,
  promptHeadWidths,
  type PromptOptions,
  promptNote,
  promptRowCap,
  runPrompt,
  setPromptNote,
} from './prompt.js';
import nodePath from 'node:path';

export interface FilePickerOptions extends PromptOptions {
  /**
   * Pick a directory rather than a file. Defaults to `false`.
   *
   * Files are not listed, and the answer is a directory: Enter on a highlighted
   * one picks it and Right goes into it. The first row is `.`, which is the
   * directory being looked at, so a directory with nothing in it can still be the
   * answer.
   */
  directory?: boolean;
  /**
   * Which files are offered, by extension, with or without the dot. Directories
   * are always offered, because the way to a file is through one.
   *
   * Compared case-insensitively, and a multi-part extension such as `.tar.gz`
   * works because it is a suffix test. The same rule `path()` has.
   */
  extensions?: readonly string[];
  /**
   * Offer dotfiles from the start. Defaults to `false`; `.` shows or hides them
   * while the picker is open.
   */
  hidden?: boolean;
  /**
   * Keep the picker inside `root`: Left and Backspace stop there rather than
   * going to its parent. Defaults to `false`.
   *
   * A navigation rule and not a sandbox -- a link inside `root` that points
   * outside it is followed, so an app that must refuse a path outside a
   * directory checks the answer in `validate`.
   */
  confine?: boolean;
  /**
   * Whether the highlight wraps from one end of the list to the other. Defaults
   * to `true`, as `select()` does.
   */
  loop?: boolean;
  /**
   * The directory the picker starts in. Defaults to the working directory.
   *
   * With `confine`, also the one it cannot leave. A `~` is expanded.
   */
  root?: string;
  /** How many rows the list may take. Defaults to what the terminal has left. */
  rows?: number;
  /**
   * Checks the answer. Return a string to reject it with that message, or
   * anything falsy to accept. Receives the answer in the form it will be
   * returned in: an absolute path.
   */
  validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
}

/** The part of `node:path` the picker reads, so a test can hand it the other platform's. */
export type FilePickerFlavour = PathFlavour &
  Pick<typeof nodePath, 'basename' | 'dirname' | 'join'>;

/** Whether a flavour is Windows, for `path.ts`'s reason: the backslash is what says so. */
function caseless(flavour: PathFlavour): boolean {
  return flavour.sep === '\\';
}

/** Two names for one thing, by the file system's rule for case. */
function sameName(a: string, b: string, flavour: PathFlavour): boolean {
  return caseless(flavour) ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * The directory Left goes to, or nothing when there is nowhere to go.
 *
 * `dirname()` of a root is the root, which is the whole of how this knows it has
 * run out: `/` on POSIX and `C:\` on Windows are both fixed points, so there is
 * no drive list to offer and no platform branch to write. A Windows drive letter
 * is a place you start in and not a place you go up to.
 *
 * @param dir - Where the picker is.
 * @param limit - The directory it may not leave, if it may not leave one.
 * @param flavour - Whose paths these are.
 * @returns The parent, or nothing at the top.
 */
export function parentOf(
  dir: string,
  limit?: string,
  flavour: FilePickerFlavour = nodePath
): string | undefined {
  if (limit !== undefined && sameName(flavour.resolve(dir), flavour.resolve(limit), flavour)) {
    return undefined;
  }
  const up = flavour.dirname(dir);
  return up === dir ? undefined : up;
}

/**
 * The answer for an entry in a directory, absolute because the directory is.
 *
 * @param dir - Where the picker is.
 * @param entry - What is highlighted.
 * @param flavour - Whose separators to join with.
 * @returns The path.
 */
export function entryPath(
  dir: string,
  entry: PathEntry,
  flavour: FilePickerFlavour = nodePath
): string {
  return flavour.join(dir, entry.name);
}

/** The row that means "the directory I am in", in `directory` mode. */
const HERE: PathEntry = Object.freeze({ dir: true, name: '.' });

/**
 * Asks for a file by browsing to it.
 *
 * Up and Down move the highlight and wrap; Home, End, Page Up and Page Down go
 * further. **Right goes into a directory and Left comes back out**, landing on
 * the one that was left; Enter goes into a directory too, and chooses a file.
 * Backspace is Left. `.` shows or hides dotfiles. With `directory`, Enter chooses
 * the highlighted directory instead of entering it, and Right is what goes in.
 *
 * Nothing is typed, so there is no field: what is shown beside the question is
 * the directory being looked at, and the answer is an absolute path.
 *
 * @param opts - What to ask, what to offer, and how to check the answer.
 * @returns The path.
 */
export function filePicker(opts: FilePickerOptions): Promise<string> {
  const terminal = opts.terminal ?? defaultTerminal;
  const flavour = nodePath;
  const base = baseDir(opts.root) ?? flavour.resolve(opts.root ?? process.cwd());
  const loop = opts.loop ?? true;
  const filter: PathFilter = { directory: opts.directory, extensions: opts.extensions };
  const cache = entryCache();

  let dir = base;
  let active = 0;
  let top = 0;
  let showHidden = opts.hidden ?? false;
  // a name to land on once the directory has been read, which is how Left comes
  // back out onto the directory it left without waiting for the read to say so
  let want: string | undefined;
  let error: string | undefined;
  let finished = false;

  /** What the directory being looked at offers, from what has been read. */
  function listing(): PathEntry[] {
    const found = candidatesOf(
      cache.get(dir) ?? [],
      '',
      { ...filter, hidden: showHidden },
      flavour
    );
    return opts.directory ? [HERE, ...found] : found;
  }

  /** Puts the highlight where it was asked to be, once there is a list to be on. */
  function place(): void {
    if (want === undefined || !cache.has(dir)) {
      return;
    }
    const name = want;
    want = undefined;
    active = Math.max(
      0,
      listing().findIndex((entry) => sameName(entry.name, name, flavour))
    );
  }

  return runPrompt<string>(opts, () => {
    const dirText = textNode('', {
      class: 'sigil-filepicker-dir sigil-muted',
      'white-space': 'nowrap',
    });
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const { line, mark } = promptHeadLine(opts.message, head.message, dirText);
    const complaint = promptNote('sigil-prompt-error sigil-error');
    const empty = textNode(__`No matches`, {
      class: 'sigil-filepicker-empty sigil-muted',
      display: 'none',
      'padding-left': 2,
    });
    const list = box({
      class: 'sigil-filepicker-list',
      'flex-direction': 'column',
      'padding-left': 2,
    });
    const view = box(
      { class: 'sigil-filepicker', 'flex-direction': 'column' },
      line,
      box({ 'padding-left': 2 }, complaint),
      list,
      empty
    );

    /** The rows the list has once the question and the complaint have taken theirs. */
    const room = (): number => {
      const avail = Math.max(1, Math.max(1, terminal.height) - head.lines - (error ? 1 : 0));
      return Math.max(1, Math.min(promptRowCap(opts.rows, avail), avail));
    };

    /**
     * A row for one entry.
     *
     * Built per draw for the rows on screen, as `sort()` does: what changes is
     * which directory the list is of, so no row stays attached to an entry.
     */
    function row(entry: PathEntry, current: boolean): Element {
      const pointer = textNode(PROMPT_SYMBOLS.cursor, {
        class: 'sigil-filepicker-pointer',
        'margin-right': 1,
        visibility: current ? 'visible' : 'hidden',
        'white-space': 'nowrap',
      });
      const label = textNode(entry.name + (entry.dir ? flavour.sep : ''), {
        class: entry.dir ? 'sigil-filepicker-label is-dir' : 'sigil-filepicker-label',
        'white-space': 'nowrap',
      });
      return box(
        {
          class: current ? 'sigil-filepicker-row is-active sigil-accent' : 'sigil-filepicker-row',
        },
        pointer,
        label
      );
    }

    function draw(): void {
      place();
      const rows = listing();
      active = Math.min(active, Math.max(0, rows.length - 1));

      setPromptNote(complaint, error);
      dirText.setText(truncate(dir, head.rest, 'ellipsis-start'));

      const visible = Math.max(1, Math.min(room(), rows.length));
      top = listWindow(rows.length, active, room(), top);

      while (list.children.length > 0) {
        list.removeChild(list.children[0] as Element);
      }
      for (const [at, entry] of rows.entries()) {
        if (at >= top && at < top + visible) {
          list.append(row(entry, at === active));
        }
      }

      // only once the directory has been read: before then there is no answer,
      // and "no matches" would be a claim about a list nobody has seen
      empty.setProps({
        display: cache.has(dir) && rows.length === (opts.directory ? 1 : 0) ? 'flex' : 'none',
      });
    }

    /** Draws what has been read, and draws again when the directory lands. */
    function redraw(): void {
      draw();
      void cache.load(dir).then(() => {
        if (!finished) {
          draw();
        }
      });
    }

    redraw();

    /** Submits an answer, or says why it cannot be. */
    async function choose(answer: string): Promise<{ value: string } | void> {
      const failed = await opts.validate?.(answer);
      if (typeof failed === 'string' && failed) {
        error = failed;
        redraw();
        return;
      }
      return { value: answer };
    }

    return {
      async key(k) {
        error = undefined;

        // Left leaves a directory without reading it. A key that acts on the
        // list waits for the list, but this is the one that gets away from a
        // directory that is slow to read -- a network mount, a stalled disk --
        // and holding it behind that read is `path()`'s freeze again
        if (k.name === 'left' || k.name === 'backspace') {
          const up = parentOf(dir, opts.confine ? base : undefined, flavour);
          if (up !== undefined) {
            want = flavour.basename(dir);
            dir = up;
            active = 0;
            top = 0;
          }
          redraw();
          return;
        }

        await cache.load(dir);
        place();
        const rows = listing();
        const current = rows[active];
        const page = Math.max(1, room() - 1);
        const go = (to: number): void => {
          active = Math.min(Math.max(0, to), Math.max(0, rows.length - 1));
        };

        const enter = (entry: PathEntry): void => {
          dir = entryPath(dir, entry, flavour);
          active = 0;
          top = 0;
        };

        if (k.name === 'enter') {
          if (current === undefined) {
            return;
          }
          if (current === HERE) {
            return choose(dir);
          }
          if (current.dir && !opts.directory) {
            enter(current);
          } else {
            return choose(entryPath(dir, current, flavour));
          }
        } else if (k.name === 'right') {
          if (current?.dir && current !== HERE) {
            enter(current);
          }
        } else if (k.name === 'up' || k.name === 'down') {
          const next = active + (k.name === 'up' ? -1 : 1);
          if (rows.length > 0) {
            go(loop ? (next + rows.length) % rows.length : next);
          }
        } else if (k.name === 'home') {
          go(0);
        } else if (k.name === 'end') {
          go(rows.length - 1);
        } else if (k.name === 'pageup') {
          go(active - page);
        } else if (k.name === 'pagedown') {
          go(active + page);
        } else if (typedText(k) === '.') {
          // keeps the highlight on the same name, which is what hiding the one
          // it is on would otherwise lose
          want = current?.name;
          showHidden = !showHidden;
        }

        redraw();
      },

      settle(answer: string): void {
        finished = true;
        promptAnswered(mark);
        dirText.setText(answer);
        dirText.setProps({ class: 'sigil-prompt-answer sigil-muted' });
        setPromptNote(complaint, undefined);
        // what is left is the question and its answer, the one line worth
        // keeping in a log
        list.setProps({ display: 'none' });
        empty.setProps({ display: 'none' });
      },

      view,
    };
  });
}
