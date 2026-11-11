/**
 * A path prompt: a text field that completes against the file system.
 *
 * It is `text()` with one addition, and the addition is the whole of the
 * component. Tab fills in as much of the path as every candidate in the
 * directory being typed agrees on, a list of those candidates sits under the
 * field, and the arrow keys walk it. What is typed is still the answer; the list
 * is only ever a way of typing it faster.
 *
 * ```js
 * const file = await path({ message: 'Which config?', extensions: ['json', 'yaml'] });
 * ```
 *
 * This is the field. The picker that browses the tree -- arrows to descend, Enter
 * to choose -- is a different widget with a different shape, and is
 * `filePicker()` in `file-picker.ts`; what the two share is the half of this file
 * that is not the prompt: what a directory holds, which of it is offered, and the
 * once-per-directory read.
 */

import { box, type Element, text as textNode } from '../element/index.js';
import { __, __n, confirmKeys } from '../i18n/index.js';
import { baseDir } from '../paths.js';
import { terminal as defaultTerminal } from '../terminal/index.js';
import { byCodeUnit } from '../util/by-code-unit.js';
import { boundary, deleteAfter, deleteBefore, insertAt, pastedLine, typedText } from './editing.js';
import {
  type AccessibleOptions,
  promptAsLines,
  listWindow,
  PROMPT_SYMBOLS,
  promptAnswered,
  promptAnswerSlot,
  promptHeadLine,
  promptHeadWidths,
  type PromptOptions,
  promptListRows,
  promptNote,
  promptWindow,
  promptLineQuestion,
  type PromptLineKeyQuery,
  runLinePrompt,
  runPrompt,
  setPromptNote,
} from './prompt.js';
import { readdir, stat } from 'node:fs/promises';
import nodePath from 'node:path';

export interface PathOptions extends PromptOptions, AccessibleOptions {
  /**
   * Candidates and answers are directories only. Defaults to `false`.
   *
   * Narrows the list and nothing else: what is typed is still what is answered,
   * so a path that is not a directory can be typed and accepted. Checking what
   * the file system says about an answer is `validate`'s job, because whether a
   * path has to exist is the app's rule -- a prompt for where to *write* wants
   * the opposite.
   */
  directory?: boolean;
  /**
   * Which files are offered, by extension, with or without the dot. Directories
   * are always offered, because the way to a file is through one.
   *
   * Compared case-insensitively, and a multi-part extension such as `.tar.gz`
   * works because it is a suffix test.
   */
  extensions?: readonly string[];
  /** Offer dotfiles. Defaults to `false`; a segment that starts with `.` asks for them. */
  hidden?: boolean;
  /** What the field starts with. */
  initial?: string;
  /**
   * An answer to start from: the field opens holding it, as it does `initial`,
   * which it beats. An answer is absolute when `root` was given, and a field that
   * starts with an absolute path completes from there like any other.
   */
  value?: string;
  /** Shown dimmed when nothing has been typed. */
  placeholder?: string;
  /**
   * Where a relative path starts. Defaults to the working directory.
   *
   * Also changes the answer: given a `root`, a relative answer is resolved
   * against it and comes back absolute. Without one the answer is the path as it
   * was typed, so a caller that wants a relative path gets one.
   */
  root?: string;
  /** How many rows the list may take. Defaults to what the terminal has left. */
  rows?: number;
  /**
   * Checks the answer. Return a string to reject it with that message, or
   * anything falsy to accept. Receives the answer in the form it will be
   * returned in -- `~` expanded, resolved against `root` if one was given.
   */
  validate?: (value: string) => string | undefined | false | Promise<string | undefined | false>;
}

/** What the file system holds in a directory, as much of it as this needs. */
export interface PathEntry {
  /** Whether it is a directory, or a link to one. */
  readonly dir: boolean;
  /** The file name, with no separator. */
  readonly name: string;
}

/** The part of `node:path` this reads, so a test can hand it the other platform's. */
export type PathFlavour = Pick<typeof nodePath, 'isAbsolute' | 'resolve' | 'sep'>;

/** What is filtered out of a directory's entries. */
export interface PathFilter {
  readonly directory?: boolean;
  readonly extensions?: readonly string[];
  readonly hidden?: boolean;
}

/**
 * Whether a flavour's separator is the backslash, which is what makes it
 * Windows: the one place a drive letter and a second separator both exist.
 */
function isWindows(flavour: PathFlavour): boolean {
  return flavour.sep === '\\';
}

/**
 * A name as the file system compares it: lower case on Windows, where case does
 * not tell two names apart, and as it is everywhere else.
 *
 * Exported for the file picker, which asks the same question of an entry it
 * lands on and had its own `caseless()` saying what `isWindows()` says.
 *
 * @param text - The name, or part of one.
 * @param flavour - Whose file system this is.
 * @returns It, folded where the file system folds it.
 */
export function pathFoldCase(text: string, flavour: PathFlavour = nodePath): string {
  return isWindows(flavour) ? text.toLowerCase() : text;
}

/**
 * The index of the last separator in a typed path, or -1.
 *
 * Windows accepts both, so a person typing `C:/Users/` is not told they typed it
 * wrong; POSIX has one, and a backslash there is an ordinary file name character.
 */
function lastSeparator(value: string, flavour: PathFlavour): number {
  const slash = value.lastIndexOf('/');
  return isWindows(flavour) ? Math.max(slash, value.lastIndexOf('\\')) : slash;
}

/**
 * Splits what was typed at its last separator.
 *
 * @param value - The field.
 * @param flavour - Whose separators to split on.
 * @returns The directory part, separator included, and the segment being typed.
 */
export function splitTyped(
  value: string,
  flavour: PathFlavour = nodePath
): { dir: string; segment: string } {
  const at = lastSeparator(value, flavour);
  return { dir: value.slice(0, at + 1), segment: value.slice(at + 1) };
}

/**
 * The separator to complete a directory with: the one already in use.
 *
 * Someone who typed `C:/Users/` and is completed into `C:/Users/me\` has been
 * answered in a spelling they did not use, so the last separator in the typed
 * directory wins and the platform's own is only the fallback.
 */
export function separatorFor(dir: string, flavour: PathFlavour = nodePath): string {
  const at = lastSeparator(dir, flavour);
  return at === -1 ? flavour.sep : (dir[at] as string);
}

/**
 * A segment that is a root of its own, and so is a directory before it has a
 * separator: `~` is the home directory and `C:` is a drive.
 *
 * Neither is something `readdir` can list from where the prompt is, so without
 * this Tab on `~` would find nothing -- the one place a person would type a
 * path and be told there is nowhere to go.
 */
function rootName(segment: string, flavour: PathFlavour): string | undefined {
  if (segment === '~') {
    return segment;
  }
  return isWindows(flavour) && /^[A-Za-z]:$/.test(segment) ? segment : undefined;
}

/**
 * The directory a typed directory part names, as an absolute path to read.
 *
 * `~` goes through `paths.ts` so this prompt and the rest of the library agree
 * on what a home directory is -- including that a `~` with no home to put over
 * it, and `~user`, which `expand()` does not implement, name nothing.
 *
 * @param dir - The typed directory part, separator included.
 * @param base - Where a relative one starts.
 * @param flavour - Whose rules for absolute.
 * @returns The directory, or nothing when the part names none.
 */
export function directoryOf(
  dir: string,
  base: string,
  flavour: PathFlavour = nodePath
): string | undefined {
  if (dir === '') {
    return base;
  }
  if (dir.startsWith('~')) {
    return baseDir(dir);
  }
  return flavour.isAbsolute(dir) ? dir : flavour.resolve(base, dir);
}

/**
 * The entries of a directory that the typed segment, and the options, leave in.
 *
 * Directories first and then by code unit, rather than by `localeCompare()`:
 * the order a list is in should not depend on the machine's language, and
 * a prompt that answered differently under `tr-TR` would be the same defect the
 * parser's destinations were fixed for.
 *
 * @param entries - What the directory holds.
 * @param segment - What has been typed after the last separator.
 * @param filter - The options that narrow the list.
 * @param flavour - Whose file system this is, which decides whether case matters.
 * @returns The candidates, in the order they are listed.
 */
export function candidatesOf(
  entries: readonly PathEntry[],
  segment: string,
  filter: PathFilter = {},
  flavour: PathFlavour = nodePath
): PathEntry[] {
  // a segment that starts with a dot is asking for them, and is the only way to
  // reach one without turning them all on
  const dotted = filter.hidden === true || segment.startsWith('.');
  const wanted = pathFoldCase(segment, flavour);
  const suffixes = (filter.extensions ?? []).map((ext) =>
    (ext.startsWith('.') ? ext : `.${ext}`).toLowerCase()
  );

  const kept = entries.filter((entry) => {
    if (!dotted && entry.name.startsWith('.')) {
      return false;
    }
    if (!pathFoldCase(entry.name, flavour).startsWith(wanted)) {
      return false;
    }
    if (filter.directory) {
      return entry.dir;
    }
    if (entry.dir || suffixes.length === 0) {
      return true;
    }
    const name = entry.name.toLowerCase();
    return suffixes.some((suffix) => name.endsWith(suffix));
  });

  return kept.toSorted((a, b) => {
    if (a.dir !== b.dir) {
      return a.dir ? -1 : 1;
    }
    return byCodeUnit(a.name, b.name);
  });
}

/** What a directory that has not been read offers: nothing, one array for every ask. */
const NOT_READ: readonly PathEntry[] = Object.freeze([]);

/**
 * `candidatesOf()` remembered for the last directory state it was asked about.
 *
 * A prompt asks for its list several times per key -- once to act on it and once
 * per draw, and a draw happens before and after the directory's read lands -- and
 * each ask is a filter and a sort over every entry. At 200,000 entries three of
 * them are about a quarter of a second, which is every arrow key (SIG-364). So
 * the answer is kept and handed back while nothing it depends on has moved: the
 * entries array, by identity, which is what changes when the directory is read or
 * a different one is asked about; the typed segment; and each field of the filter
 * that `candidatesOf()` reads, `extensions` by identity. A filter object built
 * afresh per ask is fine, and a fresh `extensions` array per ask is a miss every
 * time, which is correct and merely slow.
 *
 * One slot rather than one per directory: a state is asked about several times in
 * a row and then left, and the entries cache already keeps what a directory read.
 * What it hands back is shared between asks, so it is `readonly` and is not to be
 * changed.
 *
 * @param flavour - Whose file system this is, as `candidatesOf()` takes it.
 * @returns A function answering as `candidatesOf()` does, given a directory's
 *   entries or `undefined` for one not read yet.
 */
export function candidateCache(
  flavour: PathFlavour = nodePath
): (
  entries: readonly PathEntry[] | undefined,
  segment: string,
  filter?: PathFilter
) => readonly PathEntry[] {
  let last:
    | {
        directory: boolean;
        entries: readonly PathEntry[];
        extensions: readonly string[] | undefined;
        hidden: boolean;
        offered: readonly PathEntry[];
        segment: string;
      }
    | undefined;

  return (entries = NOT_READ, segment, filter = {}) => {
    const directory = Boolean(filter.directory);
    const hidden = filter.hidden === true;
    if (
      last !== undefined &&
      last.entries === entries &&
      last.segment === segment &&
      last.directory === directory &&
      last.hidden === hidden &&
      last.extensions === filter.extensions
    ) {
      return last.offered;
    }
    const offered = candidatesOf(entries, segment, filter, flavour);
    last = { directory, entries, extensions: filter.extensions, hidden, offered, segment };
    return offered;
  };
}

/**
 * The longest prefix every name shares, in the first name's spelling.
 *
 * Never splits a surrogate pair: backing up by one code unit would leave half an
 * astral character in the field, which no terminal can draw.
 *
 * @param names - The candidates.
 * @param flavour - Whose case rules.
 * @returns The prefix, which is empty for no names.
 */
export function commonPrefix(names: readonly string[], flavour: PathFlavour = nodePath): string {
  const [first, ...rest] = names;
  if (first === undefined) {
    return '';
  }

  const fold = (text: string): string => pathFoldCase(text, flavour);
  let end = first.length;
  for (const name of rest) {
    let i = 0;
    while (i < end && i < name.length && fold(first[i] as string) === fold(name[i] as string)) {
      i++;
    }
    end = i;
  }

  const last = first.charCodeAt(end - 1);
  if (end > 0 && end < first.length && last >= 0xd800 && last <= 0xdbff) {
    end--;
  }
  return first.slice(0, end);
}

/**
 * What Tab turns the typed segment into, or nothing when it has nothing to add.
 *
 * Only ever *longer*: on a caseless file system the candidates agree with the
 * segment but not necessarily in case, so a shared prefix of the same length
 * would rewrite the person's own characters for no gain.
 *
 * @param segment - What has been typed after the last separator.
 * @param names - The candidates' names.
 * @param flavour - Whose case rules.
 * @returns The longer segment, or nothing.
 */
export function extendSegment(
  segment: string,
  names: readonly string[],
  flavour: PathFlavour = nodePath
): string | undefined {
  const common = commonPrefix(names, flavour);
  return common.length > segment.length ? common : undefined;
}

/**
 * What a typed path is answered as.
 *
 * `~` is expanded, because it is a shell's convention that nothing downstream
 * will honour, and a returned `~/x` is a path `readFile()` cannot open. A
 * relative path is resolved only when the caller gave a `root`: without one the
 * answer is what was typed, and with one a relative answer would be meaningless
 * to anything that does not know the root.
 *
 * @param typed - The field.
 * @param root - The caller's `root`, if one was given.
 * @param base - Where a relative path starts.
 * @param flavour - Whose rules for absolute.
 * @returns The answer.
 */
export function answerOf(
  typed: string,
  root: string | undefined,
  base: string,
  flavour: PathFlavour = nodePath
): string {
  if (typed === '') {
    return typed;
  }

  let answer = typed;
  if (/^~([\\/]|$)/.test(answer)) {
    answer = baseDir(answer) ?? answer;
  }

  return root !== undefined && !flavour.isAbsolute(answer) ? flavour.resolve(base, answer) : answer;
}

/**
 * The keys that do something with the list, and so wait for it to exist.
 *
 * Everything else edits the field or moves the caret in it, which needs no
 * directory at all. A key waits only for the directory its own value names, so
 * `b`, Down, Down, Tab typed ahead of the first read still ends on the second
 * candidate rather than on an empty list.
 */
const ACTS_ON_LIST = new Set(['down', 'enter', 'tab', 'up']);

/** Reads a directory. Anything it cannot read has nothing in it. */
async function readEntries(dir: string): Promise<PathEntry[]> {
  let found;
  try {
    found = await readdir(dir, { withFileTypes: true });
  } catch {
    // ENOENT, ENOTDIR, EACCES and the rest all come to one answer for a
    // completion list: nothing to offer. A prompt that crashed because the
    // person typed a directory that is not there would be the wrong way round
    return [];
  }

  return Promise.all(
    found.map(async (entry) => {
      let isDir = entry.isDirectory();
      if (!isDir && entry.isSymbolicLink()) {
        // a link is a directory if what it points at is, which only a `stat`
        // knows; a dangling one is a file that cannot be opened, so a file
        try {
          isDir = (await stat(nodePath.join(dir, entry.name))).isDirectory();
        } catch {
          isDir = false;
        }
      }
      return { dir: isDir, name: entry.name };
    })
  );
}

/**
 * A directory's entries, read once and kept for the life of whoever asked.
 *
 * What `path()` and `filePicker()` both stand on: the first read of a directory
 * is the only one, however many keystrokes land in it, and a read that fails is
 * cached as empty rather than raised. A directory created after it was read is
 * not seen, which is the price.
 *
 * `get()` answers from what has landed and never waits, which is what lets a key
 * that only edits draw at once; `load()` is the one that waits, and only the keys
 * that act on the list are meant to await it.
 */
export interface EntryCache {
  /** The entries of a directory that has been read, or `undefined` before then. */
  get(dir: string): PathEntry[] | undefined;
  /** Whether the directory has been read. */
  has(dir: string): boolean;
  /** Reads the directory unless it already has been, and resolves when it has. */
  load(dir: string): Promise<void>;
}

/** Makes a cache with nothing read. One per prompt. */
export function entryCache(): EntryCache {
  const reads = new Map<string, Promise<PathEntry[]>>();
  const loaded = new Map<string, PathEntry[]>();

  return {
    get: (dir) => loaded.get(dir),
    has: (dir) => loaded.has(dir),
    async load(dir) {
      if (loaded.has(dir)) {
        return;
      }
      let read = reads.get(dir);
      if (!read) {
        read = readEntries(dir);
        reads.set(dir, read);
      }
      loaded.set(dir, await read);
    },
  };
}

/**
 * What a typed path completes against: the directory it is in, what of that is
 * offered, and what Tab makes of it.
 *
 * The drawn field and the line form both stand on this, one per prompt, so the
 * two forms of one question cannot offer different candidates: the same read,
 * the same `root`, the same `~`, the same filter, and the same Tab.
 */
interface Completer {
  /** What completing to an entry makes the typed path. */
  completion(value: string, entry: PathEntry): string;
  /** The candidates for a typed path, from what has been read so far. */
  candidates(value: string): readonly PathEntry[];
  /** Whether the directory a typed path is in has been read. */
  known(value: string): boolean;
  /** Reads the directory a typed path is in, unless it has been. */
  load(value: string): Promise<void>;
  /**
   * What Tab makes a typed path, with nothing highlighted: the one candidate in
   * full, separator and all for a directory, or as much as several share -- or
   * nothing when they share no more than has been typed.
   */
  tab(value: string, shown: readonly PathEntry[]): string | undefined;
  /** The directory a typed path is in, if it names one. */
  target(value: string): string | undefined;
}

/** Makes the completer for one prompt, with nothing read. */
function completer(base: string, filter: PathFilter, flavour: PathFlavour): Completer {
  const cache = entryCache();
  const offer = candidateCache(flavour);

  function target(value: string): string | undefined {
    return directoryOf(splitTyped(value, flavour).dir, base, flavour);
  }

  function completion(value: string, entry: PathEntry): string {
    const { dir } = splitTyped(value, flavour);
    return dir + entry.name + (entry.dir ? separatorFor(dir, flavour) : '');
  }

  return {
    candidates(value) {
      const { dir, segment } = splitTyped(value, flavour);
      const rooted = dir === '' ? rootName(segment, flavour) : undefined;
      const where = target(value);
      const found = where === undefined ? [] : offer(cache.get(where), segment, filter);

      // a root names a directory the working directory has no entry for, so it
      // goes in front of whatever happens to start with the same characters
      return rooted === undefined || found.some((entry) => entry.name === rooted)
        ? found
        : [{ dir: true, name: rooted }, ...found];
    },
    completion,
    known(value) {
      const where = target(value);
      return where !== undefined && cache.has(where);
    },
    async load(value) {
      const where = target(value);
      if (where !== undefined) {
        await cache.load(where);
      }
    },
    tab(value, shown) {
      if (shown.length === 1) {
        return completion(value, shown[0] as PathEntry);
      }
      if (shown.length === 0) {
        return undefined;
      }
      const { dir, segment } = splitTyped(value, flavour);
      const extended = extendSegment(
        segment,
        shown.map((entry) => entry.name),
        flavour
      );
      return extended === undefined ? undefined : dir + extended;
    },
    target,
  };
}

/** A candidate as it is listed: its name, and a separator after a directory. */
function labelOf(entry: PathEntry, flavour: PathFlavour): string {
  return entry.name + (entry.dir ? separatorFor('', flavour) : '');
}

/** One row of the list. */
interface PathRow {
  readonly label: Element;
  readonly pointer: Element;
  readonly row: Element;
}

/**
 * Asks for a path, completing it against the file system as it is typed.
 *
 * Tab completes to the longest prefix the directory's candidates share, and to
 * the whole name when there is only one -- with a separator on the end of a
 * directory, so typing carries on into it. Up and Down walk the list, through a
 * position with nothing highlighted, which is how Enter goes back to meaning
 * "what I typed". Enter on a highlighted file takes it; on a highlighted
 * directory it fills it in and goes on, since a directory is a place to go on
 * from more often than an answer.
 *
 * @param opts - What to ask, what to offer, and how to check the answer.
 * @returns The path.
 */
export function path(opts: PathOptions): Promise<string> {
  const terminal = opts.terminal ?? defaultTerminal;
  const flavour = nodePath;
  const base = baseDir(opts.root) ?? flavour.resolve(opts.root ?? process.cwd());
  const filter: PathFilter = {
    directory: opts.directory,
    extensions: opts.extensions,
    hidden: opts.hidden,
  };

  /**
   * Directories read so far, by absolute path, for the life of the prompt, and
   * what is offered from them -- one for the drawn field or the line, whichever
   * asks.
   *
   * A directory is read once however many keystrokes land in it, which is what
   * stands in for a debounce: the cost of typing is a `readdir` per directory
   * *level* rather than per character, and the characters in between are a
   * filter over what is already here.
   */
  const complete = completer(base, filter, flavour);
  let value = typeof opts.value === 'string' ? opts.value : (opts.initial ?? '');
  if (promptAsLines(opts)) {
    return linePath(opts, value, base, flavour, complete);
  }

  let cursor = value.length;
  let active = -1;
  let start = 0;
  let error: string | undefined;
  let finished = false;
  let shown: readonly PathEntry[] = [];

  /**
   * Reads the directory the field is in, unless it already has.
   *
   * Awaited only by a key that acts on the list (`ACTS_ON_LIST`), and never by
   * one that edits the field: keys are handled one at a time, so a slow `readdir`
   * -- a network mount, a stalled disk, a huge directory -- would otherwise hold
   * every key behind it, the Backspace that gets away from it included. What
   * keeps an answer to an earlier keystroke from landing on a later one is that
   * the list is always computed from the cache for the value as it is *now*: a
   * read that finishes late fills the cache and can only ever repaint the newer
   * answer.
   */
  function ensure(): Promise<void> {
    return complete.load(value);
  }

  /** The candidates for the field as it is now, from what has been read. */
  function candidates(): readonly PathEntry[] {
    return complete.candidates(value);
  }

  /** What completing to an entry makes the field. */
  function completion(entry: PathEntry): string {
    return complete.completion(value, entry);
  }

  function setValue(next: string): void {
    value = next;
    cursor = next.length;
    active = -1;
  }

  /** Reads the field's directory, then lists what it holds. */
  async function refresh(): Promise<void> {
    await ensure();
    shown = candidates();
  }

  /**
   * Draws the field from what has been read so far, and lists the rest when the
   * read lands.
   *
   * The two halves are the point: the keystroke is on screen at once and the
   * directory catches up, so typing never waits on the file system. `finished`
   * is asked because a read can outlive the prompt.
   */
  function redraw(draw: () => void): void {
    shown = candidates();
    draw();
    void refresh().then(() => {
      if (!finished) {
        draw();
      }
    });
  }

  return runPrompt<string>(opts, () => {
    const before = textNode('', { 'white-space': 'nowrap' });
    const caret = textNode('', { class: 'sigil-caret', 'white-space': 'nowrap' });
    const after = textNode('', { 'white-space': 'nowrap' });
    const field = box({ class: 'sigil-prompt-field' }, before, caret, after);
    const head = promptHeadWidths(opts.message, Math.max(1, terminal.width));
    const settled = promptAnswerSlot(head.rest);
    const { line, mark } = promptHeadLine(opts.message, head.message, field, settled.beside);
    const complaint = promptNote('sigil-prompt-error sigil-error');
    const empty = textNode(__`No matches`, {
      class: 'sigil-path-empty sigil-muted',
      display: 'none',
      'padding-left': 2,
    });
    const rows: PathRow[] = [];
    const list = box({ class: 'sigil-path-list', 'flex-direction': 'column', 'padding-left': 2 });
    const view = box(
      { class: 'sigil-path', 'flex-direction': 'column' },
      line,
      settled.under,
      box({ 'padding-left': 2 }, complaint),
      list,
      empty
    );

    /**
     * The rows the list has once the question and the complaint have taken theirs.
     *
     * The complaint's row is only reserved while there is one, so a list uses
     * the room it has; `promptListRows()` reads a caller's `rows` by the
     * multiline field's own rule, so a `NaN` or a fraction means what it means
     * there.
     */
    const room = (): number => {
      return promptListRows(opts.rows, terminal.height, head.lines + (error ? 1 : 0));
    };

    /** A row for each place the list may need, made when it first does. */
    function rowAt(i: number): PathRow {
      for (let n = rows.length; n <= i; n++) {
        const pointer = textNode(PROMPT_SYMBOLS.cursor, {
          class: 'sigil-path-pointer',
          'margin-right': 1,
          visibility: 'hidden',
          'white-space': 'nowrap',
        });
        const label = textNode('', { class: 'sigil-path-label', 'white-space': 'nowrap' });
        const row = box({ class: 'sigil-path-row', display: 'none' }, pointer, label);
        rows.push({ label, pointer, row });
        list.append(row);
      }
      return rows[i] as PathRow;
    }

    function draw(): void {
      setPromptNote(complaint, error);

      const visible = Math.max(1, Math.min(room(), shown.length));
      start = listWindow(shown.length, Math.max(0, active), room(), start);

      for (let i = 0; i < Math.max(rows.length, visible); i++) {
        const { label, pointer, row } = rowAt(i);
        const entry = shown[start + i];
        const on = entry !== undefined && i < visible;
        const current = on && start + i === active;

        if (on) {
          label.setText(labelOf(entry, flavour));
        }
        pointer.setProps({ visibility: current ? 'visible' : 'hidden' });
        label.setProps({
          class: entry?.dir ? 'sigil-path-label is-dir' : 'sigil-path-label',
        });
        row.setProps({
          class: current ? 'sigil-path-row is-active sigil-accent' : 'sigil-path-row',
          display: on ? 'flex' : 'none',
        });
      }

      // empty only once the directory has been read: before then there is no
      // answer yet, and "no matches" would be a claim about a list not seen
      const known = complete.known(value);
      empty.setProps({
        display:
          shown.length === 0 && (known || complete.target(value) === undefined) && value !== ''
            ? 'flex'
            : 'none',
      });

      if (value === '') {
        // the caret is on screen from the first frame, for `text()`'s reason
        const hint = opts.placeholder ?? '';
        const end = boundary(hint, 0, 1);
        before.setText('');
        caret.setText(hint.slice(0, end) || ' ');
        after.setText(hint.slice(end));
        after.setProps({ class: 'sigil-prompt-placeholder sigil-muted' });
        return;
      }

      const pane = promptWindow(value, cursor, head.rest);
      before.setText(pane.before);
      caret.setText(pane.under || ' ');
      after.setText(pane.after);
      after.setProps({ class: '' });
    }

    // the first listing arrives on its own, and draws the field as it is by
    // then rather than as it was: `draw()` reads the current state, so a read
    // that lands after a keystroke can only ever repaint the newer answer
    redraw(draw);

    /** Submits the field, or says why it cannot be. */
    async function submit(): Promise<{ value: string } | void> {
      const answer = answerOf(value, opts.root, base, flavour);
      const failed = await opts.validate?.(answer);
      if (typeof failed === 'string' && failed) {
        error = failed;
        redraw(draw);
        return;
      }
      return { value: answer };
    }

    return {
      async key(k) {
        error = undefined;
        // a key that acts on the list waits for the directory its own value names,
        // so keys typed ahead of the first read still land on the list they imply;
        // a key that only edits the field applies at once and draws from what has
        // been read, so a slow directory cannot hold typing
        if (ACTS_ON_LIST.has(k.name)) {
          await refresh();
        } else {
          shown = candidates();
        }

        if (k.name === 'enter') {
          const chosen = shown[active];
          if (!chosen) {
            return submit();
          }
          setValue(completion(chosen));
          if (chosen.dir) {
            redraw(draw);
            return;
          }
          return submit();
        }

        if (k.name === 'tab') {
          const chosen = shown[active];
          const next = chosen ? completion(chosen) : complete.tab(value, shown);
          if (next !== undefined) {
            setValue(next);
          }
        } else if (k.name === 'up' || k.name === 'down') {
          // through a position with nothing highlighted, so there is a way back
          // to "the field is what I typed" that is not typing: -1 is that place
          // and the walk wraps through it
          const span = shown.length + 1;
          const step = k.name === 'up' ? -1 : 1;
          active = ((active + 1 + step + span) % span) - 1;
          draw();
          return;
        } else if (k.name === 'backspace') {
          ({ cursor, value } = deleteBefore(value, cursor));
          active = -1;
        } else if (k.name === 'delete') {
          ({ cursor, value } = deleteAfter(value, cursor));
          active = -1;
        } else if (k.name === 'left') {
          cursor = boundary(value, cursor, -1);
        } else if (k.name === 'right') {
          cursor = boundary(value, cursor, 1);
        } else if (k.name === 'home' || (k.ctrl && k.name === 'a')) {
          cursor = 0;
        } else if (k.name === 'end' || (k.ctrl && k.name === 'e')) {
          cursor = value.length;
        } else if (k.ctrl && k.name === 'u') {
          value = value.slice(cursor);
          cursor = 0;
          active = -1;
        } else {
          const typed = typedText(k);
          if (typed !== undefined) {
            ({ cursor, value } = insertAt(value, cursor, typed));
            active = -1;
          }
        }

        redraw(draw);
      },

      paste(block: string): void {
        ({ cursor, value } = insertAt(value, cursor, pastedLine(block)));
        active = -1;
        redraw(draw);
      },

      settle(answer: string): void {
        finished = true;
        promptAnswered(mark);
        // the field is `nowrap` and was cut to what the head left it, so the
        // answer settles in the slot every prompt settles in, `text()`'s reason
        field.setProps({ display: 'none' });
        settled.show(answer);
        setPromptNote(complaint, undefined);
        // the list goes: what is left is the question and its answer, which is
        // the one line worth keeping in a log
        list.setProps({ display: 'none' });
        empty.setProps({ display: 'none' });
      },

      view,
    };
  });
}

/**
 * How many candidates a second Tab has to find before it asks whether to list
 * them: at this many or more it asks, and below it lists.
 *
 * Readline's `completion-query-items`, its default of 100 and its comparison, so
 * a directory that makes bash ask makes this ask too. It is not an option on
 * `path()`, because it is a statement about how much a person is willing to hear
 * read out, which is theirs rather than the app's -- readline keeps it in the
 * user's `inputrc`, not in the program -- and an app has nothing to choose it
 * with that the default does not already know.
 */
const ASK_AT = 100;

/**
 * The question a second Tab asks before listing `count` candidates, and how the
 * key that answers it is read.
 *
 * `(y/N)` is `confirm()`'s catalog entry and `confirmKeys()`'s reading of it, so
 * the keys are the ones the hint names, translated, with English beside them.
 * `y` and Space list, as in readline; `n`, Backspace (readline's Delete), the
 * Delete key, Escape and Enter list nothing. Enter is the default and is no,
 * because it is the key pressed by habit, and the answer it gives should be the
 * one that does not read out thousands of lines -- which the capital in the hint
 * says. Any other key is refused with `confirm()`'s own `Answer y or n` and the
 * question is asked again: readline rings the bell and waits, and a bell is the
 * thing a screen reader does not reliably announce, which is `No matches`'s
 * reason. Refused rather than read as no, because a letter typed by someone who
 * had not yet heard the question is not an answer to it, and refused rather than
 * typed into the reply, because Enter and Tab are keys too.
 *
 * @param count - How many there are.
 * @param listed - The lines a yes writes.
 * @returns The question.
 */
function askToList(count: number, listed: readonly string[]): PromptLineKeyQuery {
  const keys = confirmKeys(__`y/n`, false);
  return {
    ask: promptLineQuestion(
      __n(count, 'Display {0} possibility?', 'Display all {0} possibilities?'),
      keys.hint
    ),
    answer(k) {
      // a modifier makes it a different key, the rule `confirm()` keeps
      if (!k.ctrl && !k.meta) {
        if (k.name === 'space' || keys.yes.includes(k.name.toLowerCase())) {
          return listed;
        }
        if (
          ['backspace', 'delete', 'enter', 'escape'].includes(k.name) ||
          keys.no.includes(k.name.toLowerCase())
        ) {
          return [];
        }
      }
      return __`Answer ${keys.yes[0]} or ${keys.no[0]}`;
    },
  };
}

/**
 * `path()` as a line: `text()`'s, answered the way the drawn field answers, and
 * completed on Tab the way a shell completes.
 *
 * The drawn field's list changes under it with every keystroke, which is the
 * redraw this form has none of, so what stands in for it is readline's: Tab adds
 * what every candidate shares beyond what has been typed, and echoes only that --
 * the one candidate in full, with a separator if it is a directory. A second Tab
 * with nothing more to add writes the candidates on lines of their own under the
 * reply and asks again holding it -- or, with 100 or more of them, asks first,
 * as readline does: `Display all 2000 possibilities? (y/N)`, answered by one key
 * (`askToList()`). Tab with no candidates says `No matches`, the
 * drawn field's own words, because a screen-reader user cannot see that nothing
 * happened, and a second Tab would only be nothing again.
 *
 * Only ever by adding at the end. On a caseless file system a candidate can agree
 * with what was typed in all but case, and the drawn field would rewrite it; here
 * what was typed was echoed, so it stays as typed and only what comes after is the
 * candidate's spelling.
 *
 * The candidates are the drawn field's, from the same `completer()`. A Tab waits
 * for its directory to be read and the keys typed after it wait behind it, so
 * they land after what it adds, in the order they were typed; Ctrl-C and Escape
 * never wait.
 *
 * What the answer is stays the drawn field's too: `~` expanded, a relative path
 * resolved against `root` when there is one, and `validate` handed it in that
 * form, so the two forms of one question cannot answer it differently.
 *
 * @param opts - What to ask.
 * @param start - The reply the field opens holding.
 * @param base - Where a relative path starts.
 * @param flavour - Whose path rules.
 * @param complete - What a typed path completes against.
 * @returns The path.
 */
function linePath(
  opts: PathOptions,
  start: string,
  base: string,
  flavour: PathFlavour,
  complete: Completer
): Promise<string> {
  return runLinePrompt<string>(opts, {
    ask: promptLineQuestion(opts.message),
    echo: true,
    async key(k, { repeated, reply }) {
      if (k.name !== 'tab') {
        return;
      }
      await complete.load(reply);
      const shown = complete.candidates(reply);
      if (shown.length === 0) {
        return { lines: [__`No matches`] };
      }
      const insert = complete.tab(reply, shown)?.slice(reply.length) ?? '';
      if (insert !== '') {
        return { insert };
      }
      // the first Tab that adds nothing is silent, as a shell's is, and asking
      // again is how the list is asked for
      if (!repeated) {
        return {};
      }
      const listed = shown.map((entry) => `  ${labelOf(entry, flavour)}`);
      return shown.length < ASK_AT ? { lines: listed } : { query: askToList(shown.length, listed) };
    },
    keep: true,
    async read(reply) {
      const answer = answerOf(reply, opts.root, base, flavour);
      const failed = await opts.validate?.(answer);
      return typeof failed === 'string' && failed ? failed : { value: answer };
    },
    start,
  });
}
