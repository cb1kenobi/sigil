import {
  box,
  type Element,
  renderToString,
  text as textNode,
  toDisplayText,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { graphemes, stringWidth } from '../width/index.js';
import { ELLIPSIS, isBreakSpace, terminalWidth } from '../wrap/index.js';
import { codeRun } from './code-view.js';
import { colorLevelOf } from './color-level.js';
import { unicodeSupported } from './note.js';
import { type Highlighter, TOKEN_ROLE, tokensOf } from './prompt.js';

/** What one step of an edit script does. */
export type DiffOp = 'add' | 'equal' | 'remove';

/** One step of an edit script: an item both sides have, or one only a side has. */
export interface DiffChange {
  op: DiffOp;
  value: string;
}

/** Whether a line of a hunk is on both sides, or only on one. */
export type DiffLineKind = 'add' | 'context' | 'remove';

/** A line of a hunk, and where it sits in the files it came from. */
export interface DiffLine {
  kind: DiffLineKind;
  /** The line number in the new file. Absent for a removed line. */
  newNumber?: number;
  /** The line number in the old file. Absent for an added line. */
  oldNumber?: number;
  /**
   * Whether the line ends its side of the file with no newline after it, which a
   * patch says with `\ No newline at end of file` under it. A context line that
   * has it is the last line of both sides. Set only where a patch said so.
   */
  noNewline?: boolean;
  /** The line, with no line ending. */
  text: string;
}

/** A run of changed lines and the context around them, as a patch writes it. */
export interface DiffHunk {
  /** What follows the closing `@@`, which a patch uses for the enclosing function. */
  heading?: string;
  lines: DiffLine[];
  newLines: number;
  newStart: number;
  oldLines: number;
  oldStart: number;
  /**
   * The hunk as its patch wrote it, the `@@` line first: each line without its
   * `\n` and exactly as it was otherwise, a `\r` and `\ No newline at end of
   * file` included. Set by `parsePatch()`, and what `hunkPatch()` writes back.
   */
  source?: string[];
}

/** The hunks of one file, and the names its patch gave the two sides. */
export interface DiffFile {
  /**
   * Whether git said the file is binary (`Binary files ... differ`, or a `GIT
   * binary patch`), which leaves it no hunks to show or apply.
   */
  binary?: boolean;
  /**
   * The lines before the file's first hunk, as its patch wrote them: from
   * `diff --git` where git began the file, through `index`, the mode, rename and
   * binary lines, to `---` and `+++` where there are any -- a binary file and a
   * pure rename have none. Set by `parsePatch()`, and what
   * `hunkPatch()` puts above a hunk -- `new file mode` and `--- /dev/null` are what
   * tell `git apply` to create the path rather than look for it.
   */
  header?: string[];
  hunks: DiffHunk[];
  newName?: string;
  oldName?: string;
}

/**
 * What `diffView()` is asked to show: two texts, a unified patch, or the files of
 * one that `parsePatch()` has already read.
 */
export type DiffInput =
  | { new: string; newName?: string; old: string; oldName?: string }
  | { patch: string }
  | { files: readonly DiffFile[] };

/** How the two sides are set out. */
export type DiffLayout = 'side-by-side' | 'unified';

/**
 * What a line too long for its room becomes.
 *
 * - `columns` folds it onto more rows at exactly the room's width, mid-word,
 *   every space kept: what `git diff` looks like through `less`.
 * - `words` folds it at a space where it has one, and drops the run of spaces a
 *   fold lands in, so a line padded out with spaces -- a Markdown table's row --
 *   does not fold into rows of nothing. A word longer than a row is folded by
 *   columns.
 * - `none` keeps it on one row, cut at the edge with `…` where it goes on, from
 *   `offset` columns in: a diff scrolled sideways.
 */
export type DiffWrap = 'columns' | 'none' | 'words';

export interface DiffOptions extends StyledOptions {
  /**
   * Lines of context kept around a change when the input is two texts. A patch
   * brings the context it was written with. Defaults to 3.
   */
  context?: number;
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Says which stretches of a text are which tokens, for syntax highlighting --
   * the same hook, with the same spans, as `multiline()`'s.
   *
   * Called with a whole side of the diff, line endings made `\n`: the old text
   * and the new text when the input is two texts, and the old and the new side of
   * each hunk when it is a patch, since a patch holds nothing between its hunks.
   * Its second argument is `lang`, or else the extension of the file's name where
   * the input gives one -- so `highlightCode()` from
   * `@ttylabs/sigil/components/highlight` colours each file of a `git diff` in its
   * own language. A token is drawn in its role on an added or removed line and
   * left muted on a context one.
   */
  highlight?: Highlighter;
  /**
   * Whether the changed stretch of a line that was edited is set apart from the
   * rest of it. Defaults to true.
   */
  intraline?: boolean;
  /**
   * The language the texts are in, handed to `highlight` as its second argument.
   * Defaults to the extension of each file's name, where the input names one:
   * `ts` for `src/diff.ts`.
   */
  lang?: string;
  /** Which arrangement to draw. Defaults to `unified`. */
  layout?: DiffLayout;
  /** Whether each line is numbered. Defaults to true. */
  lineNumbers?: boolean;
  /**
   * With `wrap: 'none'`, how many columns of every line's text are left out
   * before the first one drawn: how far the diff is scrolled sideways. The gutter
   * and the marker are not scrolled. Defaults to 0; a negative or fractional
   * value is brought to the whole number at or above zero below it.
   */
  offset?: number;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** How many columns the diff spans. Defaults to `terminalWidth()`. */
  width?: number;
  /** What a line too long for its room becomes. Defaults to `columns`. */
  wrap?: DiffWrap;
}

/**
 * The narrowest a diff may be and still be drawn side by side.
 *
 * Each half then has about 28 columns, of which a gutter takes six, the marker one
 * and the separator three between them -- twenty columns of code a side, which is
 * the least that shows a line well enough for two of them to be compared. Under it
 * the view is drawn unified, which is a layout that has the whole width for the
 * one line.
 */
export const DIFF_SIDE_BY_SIDE_MIN_WIDTH = 60;

/** The longest edit script that is searched for, rather than given up on. */
const MAX_EDITS = 2048;

/** How many columns a tab is drawn as. */
const TAB = 4;

/** The least of a line two lines must share, as a fraction, to be called edits of each other. */
const SIMILAR = 0.3;

/** Which role colours the lines of each kind, and the class that names the kind. */
const KINDS: Record<DiffLineKind, { class: string; marker: string; role: string }> = {
  add: { class: 'sigil-diff-add', marker: '+', role: 'sigil-success' },
  context: { class: 'sigil-diff-context', marker: ' ', role: 'sigil-muted' },
  remove: { class: 'sigil-diff-remove', marker: '-', role: 'sigil-error' },
};

/**
 * The shortest edit script from one list of strings to another.
 *
 * Myers' O(ND) algorithm, after trimming what the two share at either end -- the
 * overwhelmingly common case of a diff is a small change in the middle of a long
 * file, and the trim makes that cost nothing. Past `MAX_EDITS` the search is given
 * up on and the middle is a removal of the old followed by an addition of the new:
 * a correct script that is not the shortest, which is the right trade for two
 * files so different that the shortest one is not worth a quadratic table.
 *
 * @param a - The old items.
 * @param b - The new items.
 * @returns The script, in order, with `equal` for an item both have.
 */
export function diffSequence(a: readonly string[], b: readonly string[]): DiffChange[] {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) {
    head++;
  }
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }

  const middle = shortest(a.slice(head, a.length - tail), b.slice(head, b.length - tail));

  return [
    ...a.slice(0, head).map((value): DiffChange => ({ op: 'equal', value })),
    ...middle,
    ...a.slice(a.length - tail).map((value): DiffChange => ({ op: 'equal', value })),
  ];
}

/**
 * The search itself, over lists with nothing in common at either end.
 *
 * @param a - The old items.
 * @param b - The new items.
 * @returns The script.
 */
function shortest(a: readonly string[], b: readonly string[]): DiffChange[] {
  const n = a.length;
  const m = b.length;
  const replaced = (): DiffChange[] => [
    ...a.map((value): DiffChange => ({ op: 'remove', value })),
    ...b.map((value): DiffChange => ({ op: 'add', value })),
  ];

  if (n === 0 || m === 0) {
    return replaced();
  }

  const limit = Math.min(n + m, MAX_EDITS);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  // the furthest-reaching row of every diagonal, as it stood before each round: the
  // walk back needs to ask which neighbour a diagonal was reached from
  const trace: Int32Array[] = [];

  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d, offset + d + 1));

    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)
          ? v[offset + k + 1]!
          : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;

      if (x >= n && y >= m) {
        return walkBack(a, b, trace);
      }
    }
  }

  return replaced();
}

/**
 * The script a search found, read back out of its trace.
 *
 * @param a - The old items.
 * @param b - The new items.
 * @param trace - The diagonals before each round.
 * @returns The script, in order.
 */
function walkBack(
  a: readonly string[],
  b: readonly string[],
  trace: readonly Int32Array[]
): DiffChange[] {
  const out: DiffChange[] = [];
  let x = a.length;
  let y = b.length;

  for (let d = trace.length - 1; d >= 0; d--) {
    const row = trace[d]!;
    const at = (k: number): number => row[k + d]!;
    const k = x - y;
    let prevX = 0;
    let prevY = 0;

    if (d > 0) {
      const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
      prevX = at(prevK);
      prevY = prevX - prevK;
    }

    while (x > prevX && y > prevY) {
      out.push({ op: 'equal', value: a[x - 1]! });
      x--;
      y--;
    }
    if (d > 0) {
      out.push(x === prevX ? { op: 'add', value: b[prevY]! } : { op: 'remove', value: a[prevX]! });
    }
    x = prevX;
    y = prevY;
  }

  return out.reverse();
}

/**
 * A text as its lines.
 *
 * A final line ending ends the last line rather than starting another, so
 * `'a\nb\n'` is two lines; an empty text has none.
 *
 * @param value - The text.
 * @returns Its lines, without their endings.
 */
function splitLines(value: string): string[] {
  if (value === '') {
    return [];
  }
  const lines = value.split(/\r?\n/);
  if (lines.at(-1) === '') {
    lines.pop();
  }
  return lines;
}

/**
 * The line-by-line edit script from one text to another.
 *
 * @param oldText - The old text.
 * @param newText - The new text.
 * @returns The script, one step per line.
 */
export function diffLines(oldText: string, newText: string): DiffChange[] {
  return diffSequence(splitLines(oldText), splitLines(newText));
}

/**
 * The hunks that show a change, with some lines of context around each.
 *
 * Two changes whose context would meet are one hunk, which is what a patch does:
 * the lines between them are shown rather than skipped over with a header that
 * hides two lines.
 *
 * @param oldText - The old text.
 * @param newText - The new text.
 * @param opts - How many lines of context. Defaults to 3.
 * @returns The hunks, none where the texts are the same.
 */
export function diffHunks(
  oldText: string,
  newText: string,
  opts: { context?: number } = {}
): DiffHunk[] {
  const asked = opts.context === undefined ? NaN : Math.floor(opts.context);
  const context = asked >= 0 ? asked : 3;

  const lines: DiffLine[] = [];
  let oldNumber = 1;
  let newNumber = 1;
  for (const change of diffLines(oldText, newText)) {
    if (change.op === 'equal') {
      lines.push({
        kind: 'context',
        newNumber: newNumber++,
        oldNumber: oldNumber++,
        text: change.value,
      });
    } else if (change.op === 'remove') {
      lines.push({ kind: 'remove', oldNumber: oldNumber++, text: change.value });
    } else {
      lines.push({ kind: 'add', newNumber: newNumber++, text: change.value });
    }
  }

  // the lines worth showing are the ones within `context` of a change
  const keep = Array.from<boolean>({ length: lines.length }).fill(false);
  for (const [index, line] of lines.entries()) {
    if (line.kind !== 'context') {
      for (
        let at = Math.max(0, index - context);
        at <= Math.min(lines.length - 1, index + context);
        at++
      ) {
        keep[at] = true;
      }
    }
  }

  const hunks: DiffHunk[] = [];
  let start = -1;
  for (let index = 0; index <= lines.length; index++) {
    if (index < lines.length && keep[index]) {
      if (start < 0) {
        start = index;
      }
    } else if (start >= 0) {
      hunks.push(hunkOf(lines.slice(start, index), lines, start));
      start = -1;
    }
  }

  return hunks;
}

/**
 * A hunk from the lines it holds.
 *
 * @param lines - The hunk's lines.
 * @param all - Every line of the diff, to count what came before.
 * @param start - Where the hunk's first line is in `all`.
 * @returns The hunk, with its header numbers.
 */
function hunkOf(lines: DiffLine[], all: readonly DiffLine[], start: number): DiffHunk {
  let before = 0;
  let after = 0;
  for (const line of all.slice(0, start)) {
    if (line.kind !== 'add') {
      before++;
    }
    if (line.kind !== 'remove') {
      after++;
    }
  }
  const oldLines = lines.filter((line) => line.kind !== 'add').length;
  const newLines = lines.filter((line) => line.kind !== 'remove').length;

  // an empty side starts at the line before, which is how a patch writes it
  return {
    lines,
    newLines,
    newStart: newLines === 0 ? after : after + 1,
    oldLines,
    oldStart: oldLines === 0 ? before : before + 1,
  };
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/**
 * A unified patch, read.
 *
 * The narrowest reading that covers `diff -u` and `git diff`: `---` and `+++`
 * name a file, `@@` opens a hunk, and the hunk's own line counts say where it
 * ends -- which is what lets a removed line that starts `-- ` be told from a file
 * header. A `diff --git` line also begins a file, since that is git's own
 * boundary, and a file git began is kept with no hunks at all: a binary file, a
 * rename with no change of content, a mode change and an empty new file are each
 * a file git said something about. Its names are the two on that line until a
 * `---` and `+++` give them. `\ No newline at end of file` is the
 * {@link DiffLine.noNewline} of the line above it.
 *
 * Every file keeps the lines before its first hunk as {@link DiffFile.header} and
 * every hunk its own lines as {@link DiffHunk.source}, each exactly as written but
 * for the `\n`, which is what lets `hunkPatch()` write one hunk back for
 * `git apply`. Everything else outside a hunk (a commit message, a signature) is
 * skipped. Not read: what a rename or a mode line says, a binary patch's data,
 * combined diffs, and the context format.
 *
 * @param patch - The patch.
 * @returns The files in it: none where it holds no hunk and no `diff --git`.
 */
export function parsePatch(patch: string): DiffFile[] {
  // split on `\n` alone, so a `\r` stays on the line it came on: it is a CRLF
  // file's content, and a hunk written back without it is a different hunk
  const raws = patch.split('\n');
  if (raws.at(-1) === '') {
    raws.pop();
  }

  const files: DiffFile[] = [];
  /** The files `diff --git` began, which are kept without a hunk. */
  const git = new Set<DiffFile>();
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  /** The line last read into `hunk`, which a `\` row under it is about. */
  let last: DiffLine | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNumber = 0;
  let newNumber = 0;

  for (let index = 0; index < raws.length; index++) {
    const raw = raws[index]!;
    const row = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    if (hunk && row.startsWith('\\') && (last || oldLeft > 0 || newLeft > 0)) {
      // `\ No newline at end of file`, about the line above it, which may be the
      // hunk's last: so it is read after the counts have run out as well
      if (last) {
        last.noNewline = true;
      }
      hunk.source!.push(raw);
      continue;
    }
    last = undefined;

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = row[0];
      const rest = row.slice(1);
      let line: DiffLine | undefined;
      if (sign === '+' && newLeft > 0) {
        line = { kind: 'add', newNumber: newNumber++, text: rest };
        newLeft--;
      } else if (sign === '-' && oldLeft > 0) {
        line = { kind: 'remove', oldNumber: oldNumber++, text: rest };
        oldLeft--;
      } else if ((sign === ' ' || row === '') && oldLeft > 0 && newLeft > 0) {
        // an editor strips the one space of a blank context line
        line = { kind: 'context', newNumber: newNumber++, oldNumber: oldNumber++, text: rest };
        oldLeft--;
        newLeft--;
      }
      if (line) {
        hunk.lines.push(line);
        hunk.source!.push(raw);
        last = line;
        continue;
      }
      // a hunk that stops short of its counts ends where the patch stops agreeing
      oldLeft = 0;
      newLeft = 0;
    }

    if (row.startsWith('diff --git ')) {
      // named once the header is read, which may say it is a rename
      file = { header: [raw], hunks: [] };
      files.push(file);
      git.add(file);
      hunk = undefined;
      continue;
    }

    if (row.startsWith('--- ') && raws[index + 1]?.replace(/\r$/, '').startsWith('+++ ')) {
      const next = raws[index + 1]!;
      const names = { newName: fileName(next.replace(/\r$/, '')), oldName: fileName(row) };
      // the `---` and `+++` of a file `diff --git` began are its own, until a hunk
      if (file && git.has(file) && !file.hunks.length) {
        Object.assign(file, names);
        file.header!.push(raw, next);
      } else {
        file = { header: [raw, next], hunks: [], ...names };
        files.push(file);
      }
      hunk = undefined;
      index++;
      continue;
    }

    const header = HUNK_HEADER.exec(row);
    if (header) {
      if (!file) {
        file = { header: [], hunks: [] };
        files.push(file);
      }
      const count = (value: string | undefined): number =>
        value === undefined ? 1 : Number(value);
      oldNumber = Number(header[1]);
      newNumber = Number(header[3]);
      oldLeft = count(header[2]);
      newLeft = count(header[4]);
      hunk = {
        heading: header[5] || undefined,
        lines: [],
        newLines: newLeft,
        newStart: newNumber,
        oldLines: oldLeft,
        oldStart: oldNumber,
        source: [raw],
      };
      file.hunks.push(hunk);
      continue;
    }

    // the extended header of a file git began: `index`, the modes, a rename, binary
    if (file && git.has(file) && !file.hunks.length) {
      file.header!.push(raw);
      if (row.startsWith('Binary files ') || row === 'GIT binary patch') {
        file.binary = true;
      }
    }
  }

  for (const entry of git) {
    // a file with no `---` and `+++` is named off its `diff --git` line
    if (entry.oldName === undefined && entry.newName === undefined) {
      const rows = entry.header!.map((line) => line.replace(/\r$/, ''));
      const names = gitNames(rows[0]!.slice('diff --git '.length), rows);
      if (names) {
        [entry.oldName, entry.newName] = names;
      }
    }
  }

  return files.filter((entry) => entry.hunks.length > 0 || git.has(entry));
}

/** A name as git writes one that needs quoting: in double quotes, with C escapes. */
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';

/**
 * The paths a rename or a copy names in its header, which git writes without a
 * prefix: `rename from x` and `rename to y`.
 *
 * @param header - The file's header, without line endings.
 * @returns The two paths, or nothing where the file is not moved or they are quoted.
 */
function moved(header: readonly string[]): [string, string] | undefined {
  const from = header.find((line) => /^(?:rename|copy) from /.test(line));
  const to = header.find((line) => /^(?:rename|copy) to /.test(line));
  if (from === undefined || to === undefined) {
    return undefined;
  }
  const paths: [string, string] = [from.replace(/^\w+ from /, ''), to.replace(/^\w+ to /, '')];
  return paths.some((path) => path.startsWith('"')) ? undefined : paths;
}

/**
 * The two names on a `diff --git` line, spelled as the line spells them -- a quoted
 * one still quoted, as it would be on a `---` line.
 *
 * Unquoted names may hold spaces, and a prefix may too or may not end in a `/`
 * (`--src-prefix`), so where the line splits is read from what else the header
 * says rather than from the line's own text, in this order:
 *
 * - A rename or a copy names its two paths, unprefixed, in `rename from` and
 *   `rename to`: the line splits where its halves end in them.
 * - A binary file repeats both names in `Binary files X and Y differ`, one of
 *   them `/dev/null` for a file added or deleted: the line splits where that
 *   sentence is the one its halves make. Two blobs or two files outside a
 *   repository are two paths with no rename lines, and are named this way.
 * - Anything else -- a mode change, an empty file added -- is one path on both
 *   sides, so the line splits where its halves share the longest tail, and only
 *   where that tail is at least half of each: two different binaries written
 *   with `--binary` say their names nowhere else, and are left unnamed.
 *
 * Where the rule that applies does not settle on one split, there are no names
 * rather than a guess.
 *
 * @param rest - The line after `diff --git `.
 * @param header - The file's header, without line endings.
 * @returns The old name and the new one, or nothing where the line does not say.
 */
function gitNames(rest: string, header: readonly string[]): [string, string] | undefined {
  const quoted =
    new RegExp(`^(${QUOTED}) (.+)$`).exec(rest) ?? new RegExp(`^([^"]+) (${QUOTED})$`).exec(rest);
  if (quoted) {
    return [quoted[1]!, quoted[2]!];
  }
  const splits = [...rest.matchAll(/ /g)].map((match): [string, string] => [
    rest.slice(0, match.index),
    rest.slice(match.index + 1),
  ]);
  const one = (found: [string, string][]): [string, string] | undefined =>
    found.length === 1 ? found[0] : undefined;

  const paths = moved(header);
  if (paths) {
    return one(splits.filter(([old, next]) => old.endsWith(paths[0]) && next.endsWith(paths[1])));
  }
  const binary = header.find((line) => line.startsWith('Binary files '));
  if (binary !== undefined) {
    const says = (old: string, next: string): boolean =>
      [old, '/dev/null'].some((a) =>
        [next, '/dev/null'].some((b) => binary === `Binary files ${a} and ${b} differ`)
      );
    return one(splits.filter(([old, next]) => says(old, next)));
  }
  const tail = ([old, next]: [string, string]): number => {
    let length = 0;
    while (
      length < Math.min(old.length, next.length) &&
      old.at(-1 - length) === next.at(-1 - length)
    ) {
      length++;
    }
    return length;
  };
  // the tail is the path and the rest the prefixes, so it is most of each half: a
  // tail of a letter or two is two different paths that happen to end alike, as
  // two binaries of `git diff --binary` do, which have no other line to go by
  const longest = Math.max(0, ...splits.map(tail));
  const found = splits.filter(
    (split) => tail(split) === longest && 2 * longest >= Math.max(split[0].length, split[1].length)
  );
  return longest > 0 ? one(found) : undefined;
}

/**
 * The name on a `---` or `+++` line, without the timestamp some tools add after a tab.
 *
 * @param row - The header line.
 * @returns The name.
 */
function fileName(row: string): string {
  return row.slice(4).split('\t')[0]!.trim();
}

/** The sign a patch puts in front of each kind of line. */
const SIGN: Record<DiffLineKind, string> = { add: '+', context: ' ', remove: '-' };

/**
 * One hunk as a patch of its own, under its file's header: what `git apply`
 * takes to apply that hunk and no other, which is how a hunk is staged
 * (`git apply --cached`) and unstaged (`--cached --reverse`), the way
 * `git add -p` does it.
 *
 * What `parsePatch()` kept is written back exactly: the file's
 * {@link DiffFile.header} -- a new file's `new file mode` and `--- /dev/null` are
 * what make git create the path rather than look for it -- and the hunk's
 * {@link DiffHunk.source}, its counts unchanged, since applying it alone is what
 * they describe, and its `\r` and `\ No newline at end of file` kept, since a
 * hunk without them is a different hunk. A file or a hunk that was not read from
 * a patch, such as one from `diffHunks()`, is written from what it holds: `---`
 * and `+++` from its names, and a line a sign and its text, with
 * {@link DiffLine.noNewline} written as the line git writes for it. So a hunk
 * whose `lines` an app has changed is written from them once its `source` is
 * deleted, and from the source while it is there.
 *
 * @param file - The file the hunk is in.
 * @param hunk - The hunk.
 * @returns The patch, ending in a newline as git's own do.
 */
export function hunkPatch(file: DiffFile, hunk: DiffHunk): string {
  const oldName = file.oldName ?? file.newName;
  const newName = file.newName ?? file.oldName;
  const header =
    file.header ??
    (oldName === undefined || newName === undefined ? [] : [`--- ${oldName}`, `+++ ${newName}`]);
  const body = hunk.source ?? [
    hunkHeader(hunk),
    ...hunk.lines.flatMap((line) => {
      const row = `${SIGN[line.kind]}${line.text}`;
      return line.noNewline ? [row, '\\ No newline at end of file'] : [row];
    }),
  ];
  return `${[...header, ...body].join('\n')}\n`;
}

/** What {@link hunkLinesPatch} is told beyond the lines. */
export interface HunkLinesOptions {
  /**
   * Whether the patch is for `git apply --reverse`, which is how a staged change
   * is unstaged. Then the file the patch is applied to is the hunk's new side, so
   * the lines left out are the other kind: an unselected added line stays as it
   * is -- it is context -- and an unselected removed line is dropped.
   */
  reverse?: boolean;
}

/** One row of a patch being written: its sign, the line as written and what follows it. */
interface PatchRow {
  /** The row, sign included. */
  row: string;
  sign: ' ' | '+' | '-';
  /** What follows the row where its side ends there with no newline. */
  trailer?: string;
}

/** The sentence a patch says a line has no newline after it with. */
const NO_NEWLINE = '\\ No newline at end of file';

/**
 * The rows of a hunk's lines as its patch wrote them, one for each of `lines`:
 * `\r` kept, and the `\` row under a line with it. Nothing where the hunk was not
 * read from a patch, or its `lines` no longer agree with its `source`.
 *
 * @param hunk - The hunk.
 * @returns The rows without their `\`, and each one's `\` row.
 */
function sourceRows(hunk: DiffHunk): { row: string; trailer?: string }[] | undefined {
  if (hunk.source === undefined) {
    return undefined;
  }
  const rows: { row: string; trailer?: string }[] = [];
  for (const raw of hunk.source.slice(1)) {
    if (raw.startsWith('\\')) {
      if (rows.length > 0) {
        rows.at(-1)!.trailer = raw;
      }
    } else {
      rows.push({ row: raw });
    }
  }
  return rows.length === hunk.lines.length ? rows : undefined;
}

/**
 * Some of one hunk's lines as a patch of their own: what `git apply --cached`
 * takes to stage those lines and leave the rest of the hunk where it is, which is
 * what `git add -p` does after `e`, and `--reverse` takes to unstage them.
 *
 * `selected` names lines of `hunk.lines` by their position. A selected added or
 * removed line is written as it is. A line that is not selected is left as the
 * file the patch is applied to has it -- the index, when staging: an added line
 * is not written at all, and a removed line is written as context, since it is
 * still there. With `reverse` it is the other way round, for the new side is the
 * one applied to. A selected context line changes nothing and is ignored.
 *
 * The hunk's counts are written again from the rows, and the position they are
 * anchored at is the side that is applied to. The file's {@link DiffFile.header}
 * and the hunk's {@link DiffHunk.source} are used as {@link hunkPatch} does, so a
 * `\r` and `\ No newline at end of file` survive.
 *
 * A patch cannot say everything a selection might ask for, and two are refused
 * with an `Error` rather than written as something else:
 *
 * - A line with no newline ends its side of the file, so nothing can follow it
 *   there. Selecting a line added after one that is not selected -- `-a`, `+a`
 *   and `+b` over a file that lacked its last newline, with only `+b` chosen --
 *   would write one, and the selection has to take the line that ends it too.
 * - A file the patch creates or deletes is staged whole or not at all where the
 *   header says so: a deleted file with some lines left in it is not a deletion,
 *   and the rewritten header it would need is not something to guess at. That is
 *   `deleted file mode` when staging, and `new file mode` with `reverse`.
 *
 * No context is added, so a hunk read with none (`-U0`) is written with none,
 * as `hunkPatch()` writes it, and what `git apply` makes of that is the same
 * either way.
 *
 * @param file - The file the hunk is in.
 * @param hunk - The hunk.
 * @param selected - The positions in `hunk.lines` of the lines to apply.
 * @param opts - Whether the patch is for unstaging.
 * @returns The patch, ending in a newline, or nothing where no added or removed
 *   line is selected.
 * @throws A `RangeError` for a position that is not one of the hunk's lines, and
 *   an `Error` for a selection the patch cannot write, as above.
 */
export function hunkLinesPatch(
  file: DiffFile,
  hunk: DiffHunk,
  selected: Iterable<number>,
  opts: HunkLinesOptions = {}
): string | undefined {
  const reverse = opts.reverse === true;
  const chosen = new Set<number>();
  for (const at of selected) {
    if (!Number.isInteger(at) || at < 0 || at >= hunk.lines.length) {
      throw new RangeError(__`Expected a selected line to be a position in the hunk's lines`);
    }
    if (hunk.lines[at]!.kind !== 'context') {
      chosen.add(at);
    }
  }
  if (chosen.size === 0) {
    return undefined;
  }

  // the kind of line that is applied to is left as it is when it is not selected,
  // and the other is not there at all
  const kept: DiffLineKind = reverse ? 'add' : 'remove';
  const header =
    file.header ??
    (() => {
      const oldName = file.oldName ?? file.newName;
      const newName = file.newName ?? file.oldName;
      return oldName === undefined || newName === undefined
        ? []
        : [`--- ${oldName}`, `+++ ${newName}`];
    })();
  const whole = reverse ? 'new file mode ' : 'deleted file mode ';
  if (
    header.some((row) => row.startsWith(whole)) &&
    hunk.lines.some((line, at) => line.kind === kept && !chosen.has(at))
  ) {
    throw new Error(
      reverse
        ? __`Cannot unstage part of a new file: unstage all of it or none`
        : __`Cannot stage part of a deleted file: stage all of it or none`
    );
  }

  const written = sourceRows(hunk);
  const rows: PatchRow[] = [];
  for (const [at, line] of hunk.lines.entries()) {
    const source = written?.[at];
    // a blank context line may have lost its one space, and then it is all text
    const text =
      source === undefined
        ? line.text
        : line.kind === 'context' && !source.row.startsWith(' ')
          ? source.row
          : source.row.slice(1);
    const trailer = line.noNewline ? (source?.trailer ?? NO_NEWLINE) : undefined;
    if (line.kind === 'context') {
      rows.push({ row: ` ${text}`, sign: ' ', trailer });
    } else if (chosen.has(at)) {
      const sign = SIGN[line.kind] as '+' | '-';
      rows.push({ row: `${sign}${text}`, sign, trailer });
    } else if (line.kind === kept) {
      rows.push({ row: ` ${text}`, sign: ' ', trailer });
    }
  }

  // a line with no newline is the last of its side, so nothing may follow it there
  let closedOld = false;
  let closedNew = false;
  for (const { sign, trailer } of rows) {
    if ((sign !== '+' && closedOld) || (sign !== '-' && closedNew)) {
      throw new Error(
        __`Cannot write a line after one with no newline: select the line that ends the file too`
      );
    }
    if (trailer !== undefined) {
      closedOld ||= sign !== '+';
      closedNew ||= sign !== '-';
    }
  }

  const oldLines = rows.filter(({ sign }) => sign !== '+').length;
  const newLines = rows.filter(({ sign }) => sign !== '-').length;
  // the file applied to keeps its place and the other is found from it, where an
  // empty side is the line before
  const other = (start: number, length: number, otherLength: number): number =>
    length === 0 ? start + 1 : otherLength === 0 ? start - 1 : start;
  const oldStart = reverse ? other(hunk.newStart, hunk.newLines, oldLines) : hunk.oldStart;
  const newStart = reverse ? hunk.newStart : other(hunk.oldStart, hunk.oldLines, newLines);
  const top = hunkHeader({ ...hunk, newLines, newStart, oldLines, oldStart });
  const body = rows.flatMap(({ row, trailer }) => (trailer === undefined ? [row] : [row, trailer]));
  const end = hunk.source?.[0]?.endsWith('\r') ? '\r' : '';
  return `${[...header, `${top}${end}`, ...body].join('\n')}\n`;
}

const WORD = /[\p{L}\p{N}\p{M}_]+|\s+|[^\p{L}\p{N}\p{M}_\s]/gu;

/**
 * The stretches of two lines that are not the same, found by words.
 *
 * Words rather than characters because a character diff of two edited lines
 * matches the letters the words happen to share, and the result is confetti. A
 * run of letters, a run of space and a single mark are each a token. Two lines
 * that share less than a third of their text are not edits of one another, and
 * nothing is marked: a whole line set apart is no emphasis at all. A gap of
 * nothing but whitespace between two changed stretches is part of the change.
 *
 * @param oldLine - The old line.
 * @param newLine - The new line.
 * @returns The `[start, end)` code unit ranges changed on each side.
 */
export function diffInline(
  oldLine: string,
  newLine: string
): { new: [number, number][]; old: [number, number][] } {
  const a = oldLine.match(WORD) ?? [];
  const b = newLine.match(WORD) ?? [];
  const script = diffSequence(a, b);

  let shared = 0;
  for (const change of script) {
    if (change.op === 'equal') {
      shared += change.value.trim().length;
    }
  }
  const longest = Math.max(oldLine.trim().length, newLine.trim().length);
  if (longest === 0 || shared / longest < SIMILAR) {
    return { new: [], old: [] };
  }

  const ranges = { new: [] as [number, number][], old: [] as [number, number][] };
  let at = { new: 0, old: 0 };
  for (const change of script) {
    const length = change.value.length;
    if (change.op === 'equal') {
      at = { new: at.new + length, old: at.old + length };
    } else if (change.op === 'remove') {
      ranges.old.push([at.old, at.old + length]);
      at.old += length;
    } else {
      ranges.new.push([at.new, at.new + length]);
      at.new += length;
    }
  }

  return { new: joinRanges(ranges.new, newLine), old: joinRanges(ranges.old, oldLine) };
}

/**
 * Ranges with the touching ones, and the ones with only whitespace between them, made one.
 *
 * @param ranges - The ranges, in order.
 * @param line - The line they are in.
 * @returns The merged ranges.
 */
function joinRanges(ranges: [number, number][], line: string): [number, number][] {
  const out: [number, number][] = [];
  for (const [start, end] of ranges) {
    const last = out.at(-1);
    if (last && line.slice(last[1], start).trim() === '') {
      last[1] = end;
    } else {
      out.push([start, end]);
    }
  }
  return out;
}

/** A grapheme of a line, as it will be drawn. */
interface Cell {
  changed: boolean;
  text: string;
  token: string | undefined;
  width: number;
}

/**
 * A line as the cells it is drawn in.
 *
 * @param line - The line.
 * @param tokens - The token of each code unit, if the app highlighted.
 * @param changed - The `[start, end)` ranges that were edited.
 * @returns One cell per grapheme.
 */
function cellsOf(
  line: string,
  tokens: readonly (string | undefined)[] | undefined,
  changed: readonly [number, number][]
): Cell[] {
  const cells: Cell[] = [];
  let at = 0;
  for (const grapheme of graphemes(line)) {
    // a tab is a fixed run of spaces: the grid has no tab stops, and a column the
    // reader cannot predict is worse than one that is the same everywhere
    const shown = grapheme === '\t' ? ' '.repeat(TAB) : toDisplayText(grapheme);
    cells.push({
      changed: changed.some(([start, end]) => at >= start && at < end),
      text: shown,
      token: tokens?.[at],
      width: stringWidth(shown),
    });
    at += grapheme.length;
  }
  return cells;
}

/**
 * A line cut into the rows it takes at a width, by columns: `wrap: 'columns'`.
 *
 * The row boundary falls wherever the width says, so the reader can count it. A
 * wide character that does not fit starts the next row; one that cannot fit
 * anywhere is put on a row with nothing else of any width, and the box clips it.
 *
 * @param cells - The line's cells.
 * @param room - The columns a row holds.
 * @returns The rows, at least one.
 */
function fold(cells: readonly Cell[], room: number): Cell[][] {
  const rows: Cell[][] = [[]];
  let used = 0;
  for (const cell of cells) {
    // a row holding only cells with no width is still empty: they take no room
    if (used + cell.width > room && used > 0) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)!.push(cell);
    used += cell.width;
  }
  return rows;
}

/**
 * Whether a cell is a space or a tab, which a fold at words may land in: the
 * spaces `wrap()` breaks at and no others, so a no-break space stays inside its
 * word. A tab is a cell of four spaces by now.
 */
function blank(cell: Cell): boolean {
  return cell.text !== '' && [...cell.text].every((char) => isBreakSpace(char));
}

/**
 * A line cut into the rows it takes at a width, at words: `wrap: 'words'`.
 *
 * A run of spaces that fits on the row is kept, and one the fold lands in is
 * dropped whole, so the next word starts the next row and a line padded with a
 * thousand spaces is two rows rather than ten of nothing. The indentation that
 * starts a line is kept however wide it is, folded by columns where it is wider
 * than a row, since it is what says where the line sits. A word that does not
 * fit on the row is moved to the next, and one longer than a whole row is folded
 * by columns from where it is, the way `columns` folds everything.
 *
 * @param cells - The line's cells.
 * @param room - The columns a row holds.
 * @returns The rows, at least one.
 */
function foldWords(cells: readonly Cell[], room: number): Cell[][] {
  const rows: Cell[][] = [[]];
  let used = 0;
  // a fold landed in a run of spaces: the row is done, but a row is opened only
  // for a word after it, so spaces that end the line add no row of nothing
  let broken = false;
  const byColumns = (run: readonly Cell[]): void => {
    for (const cell of run) {
      // a row holding only cells with no width is still empty: they take no room
      if (used + cell.width > room && used > 0) {
        rows.push([]);
        used = 0;
      }
      rows.at(-1)!.push(cell);
      used += cell.width;
    }
  };
  for (let at = 0; at < cells.length;) {
    const spaces = blank(cells[at]!);
    let end = at;
    let width = 0;
    while (end < cells.length && blank(cells[end]!) === spaces) {
      width += cells[end]!.width;
      end++;
    }
    const run = cells.slice(at, end);
    at = end;
    if (spaces) {
      // nothing with a width before it, which a byte order mark is not
      if (rows.length === 1 && used === 0) {
        byColumns(run);
      } else if (!broken && used + width <= room) {
        rows.at(-1)!.push(...run);
        used += width;
      } else {
        broken = true;
      }
      continue;
    }
    // a word is moved to the next row where it would fit there; one longer than a
    // row is folded from where it is, since moving it would only leave a row short
    if (broken || (used > 0 && used + width > room && width <= room)) {
      rows.push([]);
      used = 0;
      broken = false;
    }
    if (width <= room - used) {
      rows.at(-1)!.push(...run);
      used += width;
    } else {
      byColumns(run);
    }
  }
  return rows;
}

/**
 * A line on one row, scrolled sideways and cut at the edge: `wrap: 'none'`.
 *
 * A wide character the offset falls inside is drawn as the spaces of its half
 * that is in view, so every row starts in the same column, and one the edge falls
 * inside is left off. Where the line goes on past the edge, its last column is
 * the ellipsis.
 *
 * @param cells - The line's cells.
 * @param room - The columns the row holds.
 * @param offset - The columns left out at the start.
 * @returns The cells to draw, and whether the line went on past them.
 */
function cutRow(
  cells: readonly Cell[],
  room: number,
  offset: number
): { cells: Cell[]; more: boolean } {
  const total = cells.reduce((sum, cell) => sum + cell.width, 0);
  const more = total - offset > room;
  const limit = more ? room - 1 : room;
  const out: Cell[] = [];
  let column = 0;
  let used = 0;
  for (const cell of cells) {
    const start = column;
    column += cell.width;
    if (column <= offset) {
      continue;
    }
    // the half of a wide character the offset left in view
    const shown: Cell =
      start < offset
        ? { ...cell, text: ' '.repeat(column - offset), width: column - offset }
        : cell;
    if (used + shown.width > limit) {
      break;
    }
    out.push(shown);
    used += shown.width;
  }
  return { cells: out, more };
}

/** How the rows of a line are cut: the fold, or one row from an offset. */
type Cutting = { wrap: 'columns' | 'words' } | { offset: number; wrap: 'none' };

/** A fixed-width text: the whole of what the view is made of. */
function piece(value: string, className: string): Element {
  return textNode(value, {
    class: className,
    'flex-shrink': 0,
    width: stringWidth(value),
    'white-space': 'pre',
  });
}

/** What the view needs to draw one line, however it is arranged. */
interface Drawing {
  changes: Map<DiffLine, [number, number][]>;
  tokens: Map<DiffLine, (string | undefined)[]>;
}

/**
 * The rows one line of a hunk takes on one side.
 *
 * @param line - The line.
 * @param drawing - The edits and tokens found for the hunk.
 * @param gutter - What leads the first row, and its width.
 * @param room - The columns for the code.
 * @param cutting - How a line too long for the room is cut.
 * @returns Each row's elements, how wide the line is, and how far it runs past
 *   the room.
 */
function lineRows(
  line: DiffLine,
  drawing: Drawing,
  gutter: string,
  room: number,
  cutting: Cutting
): { overflow: number; rows: Element[][]; width: number } {
  const kind = KINDS[line.kind];
  const cells = cellsOf(line.text, drawing.tokens.get(line), drawing.changes.get(line) ?? []);
  const width = cells.reduce((sum, cell) => sum + cell.width, 0);
  let overflow = 0;
  let more = false;
  let rows: Cell[][];
  if (cutting.wrap === 'none') {
    overflow = Math.max(0, width - room);
    const cut = cutRow(cells, room, cutting.offset);
    rows = [cut.cells];
    more = cut.more;
  } else {
    rows = cutting.wrap === 'words' ? foldWords(cells, room) : fold(cells, room);
  }

  const drawn = rows.map((row, index) => {
    const out: Element[] = [];
    if (gutter !== '') {
      out.push(
        piece(
          index === 0 ? gutter : ' '.repeat(stringWidth(gutter)),
          'sigil-diff-number sigil-muted'
        )
      );
    }
    out.push(
      piece(index === 0 ? kind.marker : ' ', `sigil-diff-marker ${kind.class} ${kind.role}`)
    );

    // runs of cells that look alike are one text
    let run: Cell[] = [];
    const flush = (): void => {
      if (run.length === 0) {
        return;
      }
      const { changed, token } = run[0]!;
      // a token is drawn in its own role where the line is a change, and left to
      // the line's where it is context: context is the background of a diff, and a
      // keyword in full colour among it is louder than the lines that changed
      const role = (line.kind !== 'context' && token && TOKEN_ROLE.get(token)) || kind.role;
      // bold on an edited stretch, from the heading role: it needs an attribute
      // beyond the line's colour, and the sheet already has one that no role of
      // colour contradicts
      const classes = `sigil-diff-text ${kind.class}${changed ? ' sigil-diff-change sigil-heading' : ''}`;
      out.push(codeRun(run.map((cell) => cell.text).join(''), token, { class: classes, role }));
      run = [];
    };
    for (const cell of row) {
      const last = run.at(-1);
      if (last && (last.changed !== cell.changed || last.token !== cell.token)) {
        flush();
      }
      run.push(cell);
    }
    flush();

    return out;
  });
  if (more) {
    drawn[0]!.push(piece(ELLIPSIS, 'sigil-diff-more sigil-muted'));
  }
  return { overflow, rows: drawn, width };
}

/**
 * The token of every code unit of every line of a side.
 *
 * @param lines - The lines of the side.
 * @param highlight - The app's hook.
 * @param lang - What the side is written in, where anything says.
 * @returns A token array per line.
 */
function tokenLines(
  lines: readonly string[],
  highlight: Highlighter,
  lang: string | undefined
): (string | undefined)[][] {
  const joined = lines.join('\n');
  const tokens = tokensOf(joined, highlight(joined, lang));
  const out: (string | undefined)[][] = [];
  let at = 0;
  for (const line of lines) {
    out.push(tokens.slice(at, at + line.length));
    at += line.length + 1;
  }
  return out;
}

/**
 * The language a side of a file is in, for the highlighter: `lang` where the app
 * gave one, and otherwise the extension of the side's name -- or of the other
 * side's, where this one is absent or `/dev/null`, as a new or deleted file's is.
 *
 * An extension and not a guess at a language, for the reason a code block's fence
 * word is handed over as written: the highlighter knows which names it reads, and
 * `highlightCode()` takes `ts`, `json` and `yml` as the names they are.
 *
 * @param opts - The options, for `lang`.
 * @param name - This side's name.
 * @param other - The other side's.
 * @returns The language, or `undefined` where nothing says.
 */
function sideLanguage(
  opts: DiffOptions,
  name: string | undefined,
  other: string | undefined
): string | undefined {
  if (opts.lang !== undefined) {
    return opts.lang;
  }
  const named = [name, other].find((it) => it !== undefined && it !== '/dev/null');
  if (named === undefined) {
    return undefined;
  }
  const base = named.slice(Math.max(named.lastIndexOf('/'), named.lastIndexOf('\\')) + 1);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : undefined;
}

/**
 * What the view needs to know about one hunk before it draws it.
 *
 * Runs of changed lines are paired removed-with-added, in order, and each pair is
 * compared; a surplus on either side has nothing to be compared with and is drawn
 * whole.
 *
 * @param hunk - The hunk.
 * @param opts - Whether to compare, and the highlighter.
 * @param whole - The tokens of the whole texts, where the input was two texts: asked
 *   once for the view and not once per hunk, since a span may run across the lines
 *   between two hunks.
 * @param file - The file the hunk is from, whose names say its language.
 * @returns The edits and tokens, keyed by line.
 */
function drawingOf(
  hunk: DiffHunk,
  opts: DiffOptions,
  whole: { new: (string | undefined)[][]; old: (string | undefined)[][] } | undefined,
  file: DiffFile
): Drawing {
  const drawing: Drawing = { changes: new Map(), tokens: new Map() };

  if (opts.intraline !== false) {
    for (const [removed, added] of changedRuns(hunk.lines)) {
      for (let i = 0; i < Math.min(removed.length, added.length); i++) {
        const found = diffInline(removed[i]!.text, added[i]!.text);
        drawing.changes.set(removed[i]!, found.old);
        drawing.changes.set(added[i]!, found.new);
      }
    }
  }

  if (opts.highlight) {
    const sides = whole ?? {
      old: tokenLines(
        hunk.lines.filter((line) => line.kind !== 'add').map((line) => line.text),
        opts.highlight,
        sideLanguage(opts, file.oldName, file.newName)
      ),
      new: tokenLines(
        hunk.lines.filter((line) => line.kind !== 'remove').map((line) => line.text),
        opts.highlight,
        sideLanguage(opts, file.newName, file.oldName)
      ),
    };
    let oldAt = 0;
    let newAt = 0;
    for (const line of hunk.lines) {
      const fromOld = line.kind === 'remove';
      const index = whole
        ? (fromOld ? line.oldNumber! : line.newNumber!) - 1
        : fromOld
          ? oldAt
          : newAt;
      drawing.tokens.set(line, (fromOld ? sides.old : sides.new)[index] ?? []);
      if (line.kind !== 'add') {
        oldAt++;
      }
      if (line.kind !== 'remove') {
        newAt++;
      }
    }
  }

  return drawing;
}

/**
 * The runs of changed lines in a hunk, each as its removed lines and its added.
 *
 * @param lines - The hunk's lines.
 * @returns A pair of lists per run.
 */
function changedRuns(lines: readonly DiffLine[]): [DiffLine[], DiffLine[]][] {
  const runs: [DiffLine[], DiffLine[]][] = [];
  let current: [DiffLine[], DiffLine[]] | undefined;
  for (const line of lines) {
    if (line.kind === 'context') {
      current = undefined;
    } else {
      if (!current) {
        current = [[], []];
        runs.push(current);
      }
      current[line.kind === 'remove' ? 0 : 1].push(line);
    }
  }
  return runs;
}

/**
 * A hunk's lines laid beside each other: a removed line against the added line
 * that replaces it, and a context line against itself.
 *
 * @param lines - The hunk's lines.
 * @returns The pairs, either side absent where the other has a surplus.
 */
function pairLines(lines: readonly DiffLine[]): { left?: DiffLine; right?: DiffLine }[] {
  const out: { left?: DiffLine; right?: DiffLine }[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.kind === 'context') {
      out.push({ left: line, right: line });
      index++;
      continue;
    }
    const removed: DiffLine[] = [];
    const added: DiffLine[] = [];
    while (index < lines.length && lines[index]!.kind !== 'context') {
      (lines[index]!.kind === 'remove' ? removed : added).push(lines[index]!);
      index++;
    }
    for (let i = 0; i < Math.max(removed.length, added.length); i++) {
      out.push({ left: removed[i], right: added[i] });
    }
  }
  return out;
}

/** Where one hunk was drawn in a {@link DiffTree}. */
export interface DiffTreeHunk {
  /** Where its rows end in the tree's `element.children`: one past its last. */
  end: number;
  file: DiffFile;
  /** Its `@@` row, in the tree's `element.children`. */
  first: number;
  hunk: DiffHunk;
  /**
   * The rows of each of the hunk's `lines`, in the same order and in the tree's
   * `element.children`: `first` is its first row and `end` one past its last, and
   * a line folded onto more rows has all of them. Side by side a removed line and
   * the added line it is paired with share their rows, so the ranges overlap there.
   */
  lines: { end: number; first: number }[];
}

/** The tree for a diff, the room it was built for, and the arrangement it ended up with. */
export interface DiffTree {
  element: Element;
  /**
   * Each hunk drawn, in order, and which of the element's rows are its own -- the
   * `@@` row and every row of its lines -- so that a view built on the tree knows
   * where a hunk is without reading the rows' classes.
   */
  hunks: DiffTreeHunk[];
  /** What was drawn: `side-by-side` only if there was the width for it. */
  layout: DiffLayout;
  /**
   * With `wrap: 'none'`, how far the widest line runs past the room its side
   * gives it, in columns: the largest `offset` that still brings more of a line
   * into view. 0 where every line fits, and whenever lines are folded.
   */
  overflow: number;
  /**
   * `overflow` row by row, one for each of `element.children`: how far that
   * row's line runs past its room, the wider of the two halves side by side, and
   * 0 for a header. So a view scrolled sideways can stop at the widest line it is
   * showing rather than the widest in the whole diff.
   */
  rowOverflow: number[];
  /**
   * How wide each row's line is, in columns, whole, one for each of
   * `element.children`: the wider of the two halves side by side, every row of a
   * folded line its whole line's, and 0 for a header. Unlike `rowOverflow` it
   * does not depend on the room, so it is what to show a reader as a line's width.
   */
  rowWidth: number[];
  width: number;
}

/**
 * A one-line header spanning the whole width.
 *
 * @param value - The header.
 * @param className - Its classes.
 * @param width - The columns.
 * @returns The row.
 */
function headerRow(value: string, className: string, width: number): Element {
  return textNode(value, {
    class: className,
    'flex-shrink': 0,
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    width,
  });
}

/**
 * The files a diff input holds, as the view draws them: the one file of two
 * texts, or the files of a patch that have a hunk -- a file a patch holds with
 * none (binary, renamed, a mode changed) has nothing for the view to draw, not
 * even its names. One function for `diffView()` and `diffStops()`, so the hunks
 * one draws are the hunks the other counts.
 *
 * @param input - Two texts, a patch, or files already read.
 * @param context - The context kept around a change in two texts.
 * @returns The files.
 */
function filesOf(input: DiffInput, context: number | undefined): readonly DiffFile[] {
  if ('patch' in input) {
    return parsePatch(input.patch).filter((file) => file.hunks.length > 0);
  }
  if ('files' in input) {
    return input.files.filter((file) => file.hunks.length > 0);
  }
  return [
    {
      hunks: diffHunks(input.old, input.new, { context }),
      newName: input.newName,
      oldName: input.oldName,
    },
  ];
}

/**
 * `@@ -1,3 +1,4 @@ heading`, as a patch writes it.
 *
 * @param hunk - The hunk.
 * @returns The header.
 */
function hunkHeader(hunk: DiffHunk): string {
  const span = (start: number, length: number): string =>
    length === 1 ? `${start}` : `${start},${length}`;
  const heading = hunk.heading ? ` ${hunk.heading}` : '';
  return `@@ -${span(hunk.oldStart, hunk.oldLines)} +${span(hunk.newStart, hunk.newLines)} @@${heading}`;
}

/**
 * Builds the element tree for a diff.
 *
 * Each visual row is a row of fixed-width texts, the way a rule is: there is no
 * inline layout, so the pieces of one line -- the gutter, the marker, and a run for
 * each stretch of a different look -- are siblings that have already been fitted,
 * and a line too long for the width is folded into more rows before it is built --
 * by columns, by words or not at all, as `wrap` says. Fixed width and `white-space: pre`, so the indentation of a line of code
 * survives, which a `normal` text would not keep at the end of a run.
 *
 * @param input - Two texts, or a unified patch.
 * @param opts - The arrangement, the room, and the highlighter.
 * @returns The tree, the room it was built for, and the arrangement used.
 */
export function diffView(input: DiffInput, opts: DiffOptions = {}): DiffTree {
  const asked = opts.width === undefined ? NaN : Math.floor(opts.width);
  const width = asked >= 1 ? asked : Math.max(1, terminalWidth({ env: opts.env }));
  const layout: DiffLayout =
    opts.layout === 'side-by-side' && width >= DIFF_SIDE_BY_SIDE_MIN_WIDTH
      ? 'side-by-side'
      : 'unified';
  const numbered = opts.lineNumbers !== false;
  const wrap = opts.wrap ?? 'columns';
  if (wrap !== 'columns' && wrap !== 'words' && wrap !== 'none') {
    throw new TypeError(__`Expected diff wrap to be columns, words or none`);
  }
  const cutting: Cutting =
    wrap === 'none'
      ? { offset: Number.isFinite(opts.offset) ? Math.max(0, Math.floor(opts.offset!)) : 0, wrap }
      : { wrap };
  let overflow = 0;

  const twoTexts = 'patch' in input || 'files' in input ? undefined : input;
  const files = filesOf(input, opts.context);

  let largest = 0;
  for (const file of files) {
    for (const hunk of file.hunks) {
      for (const line of hunk.lines) {
        largest = Math.max(largest, line.oldNumber ?? 0, line.newNumber ?? 0);
      }
    }
  }
  const digits = String(largest).length;

  // a text is highlighted whole, and once: a block comment may begin above a hunk
  // and end inside it. A patch has no whole text, so each hunk is highlighted alone
  const whole =
    twoTexts && opts.highlight && files.some((file) => file.hunks.length > 0)
      ? {
          old: tokenLines(
            splitLines(twoTexts.old),
            opts.highlight,
            sideLanguage(opts, twoTexts.oldName, twoTexts.newName)
          ),
          new: tokenLines(
            splitLines(twoTexts.new),
            opts.highlight,
            sideLanguage(opts, twoTexts.newName, twoTexts.oldName)
          ),
        }
      : undefined;

  const sep = unicodeSupported(opts.env, opts.platform) ? ' │ ' : ' | ';
  const half = Math.floor((width - sep.length) / 2);
  const sides = [half, width - sep.length - half] as const;
  const rows: Element[] = [];
  const rowOverflow: number[] = [];
  const rowWidth: number[] = [];
  const hunks: DiffTreeHunk[] = [];
  const add = (row: Element, runs = 0, wide = 0): void => {
    rows.push(row);
    rowOverflow.push(runs);
    rowWidth.push(wide);
  };

  for (const file of files) {
    if (file.oldName !== undefined || file.newName !== undefined) {
      add(headerRow(`--- ${file.oldName ?? ''}`, 'sigil-diff-file sigil-heading', width));
      add(headerRow(`+++ ${file.newName ?? ''}`, 'sigil-diff-file sigil-heading', width));
    }

    for (const hunk of file.hunks) {
      const placed: DiffTreeHunk = { end: 0, file, first: rows.length, hunk, lines: [] };
      hunks.push(placed);
      add(headerRow(hunkHeader(hunk), 'sigil-diff-hunk sigil-info', width));
      const drawing = drawingOf(hunk, opts, whole, file);

      if (layout === 'unified') {
        const gutter = numbered ? digits * 2 + 2 : 0;
        const room = Math.max(1, width - gutter - 1);
        for (const line of hunk.lines) {
          const lead = numbered
            ? `${String(line.oldNumber ?? '').padStart(digits)} ${String(line.newNumber ?? '').padStart(digits)} `
            : '';
          const drawn = lineRows(line, drawing, lead, room, cutting);
          overflow = Math.max(overflow, drawn.overflow);
          const first = rows.length;
          for (const children of drawn.rows) {
            add(
              box({ class: 'sigil-diff-row', 'flex-shrink': 0 }, ...children),
              drawn.overflow,
              drawn.width
            );
          }
          placed.lines.push({ end: rows.length, first });
        }
        placed.end = rows.length;
        continue;
      }

      const gutter = numbered ? digits + 1 : 0;
      /** Each line's row range, filled in as its pair is placed. */
      const spans = new Map<DiffLine, { end: number; first: number }>();
      for (const pair of pairLines(hunk.lines)) {
        const pairFirst = rows.length;
        let runs = 0;
        let wide = 0;
        const drawn = [pair.left, pair.right].map((line, side) => {
          if (!line) {
            return [];
          }
          const half = lineRows(
            line,
            drawing,
            numbered
              ? `${String((side === 0 ? line.oldNumber : line.newNumber) ?? '').padStart(digits)} `
              : '',
            Math.max(1, sides[side]! - gutter - 1),
            cutting
          );
          runs = Math.max(runs, half.overflow);
          wide = Math.max(wide, half.width);
          const had = spans.get(line);
          spans.set(line, {
            end: Math.max(had?.end ?? 0, pairFirst + half.rows.length),
            first: pairFirst,
          });
          return half.rows;
        });
        overflow = Math.max(overflow, runs);
        for (let at = 0; at < Math.max(drawn[0]!.length, drawn[1]!.length); at++) {
          add(
            box(
              { class: 'sigil-diff-row', 'flex-shrink': 0 },
              box(
                { 'flex-shrink': 0, overflow: 'hidden', width: sides[0] },
                ...(drawn[0]![at] ?? [])
              ),
              piece(sep, 'sigil-diff-separator sigil-muted'),
              box(
                { 'flex-shrink': 0, overflow: 'hidden', width: sides[1] },
                ...(drawn[1]![at] ?? [])
              )
            ),
            runs,
            wide
          );
        }
      }
      placed.lines = hunk.lines.map(
        (line) => spans.get(line) ?? { end: rows.length, first: rows.length }
      );
      placed.end = rows.length;
    }
  }

  return {
    element: box({ class: 'sigil-diff', 'flex-direction': 'column' }, ...rows),
    hunks,
    layout,
    overflow,
    rowOverflow,
    rowWidth,
    width,
  };
}

/**
 * A diff, drawn: removed lines in the error role, added lines in the success role,
 * context muted, and the words that changed inside an edited line in bold.
 *
 * A facade over `diffView()`, the way `rule()` is over `ruleView()`: it returns a
 * string and the caller does the writing, which is also why it ignores `--quiet`.
 * At colour level 0 the colours and the bold are gone and the `+` and `-` markers
 * are what is left to say which side a line is on.
 *
 * @param input - Two texts, or a unified patch.
 * @param opts - The arrangement, the room, and the highlighter.
 * @returns The diff, with no trailing newline, and nothing where nothing changed.
 */
export function diff(input: DiffInput, opts: DiffOptions = {}): string {
  const { element, width } = diffView(input, opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: colorLevelOf(opts),
    colorScheme: opts.colorScheme,
    width,
  });
}

/**
 * One part of what a `DiffView` draws: a diff, or lines of prose -- a heading, a
 * commit message, a note that a file is binary -- between diffs.
 *
 * `data` is the app's, carried through to the {@link DiffStop} a block's hunks or
 * prose make, so the app learns which of its own things the cursor is on.
 */
export type DiffBlock<T = unknown> =
  | { readonly data?: T; readonly diff: DiffInput }
  | {
      /** The classes of each line: `sigil-muted`, `sigil-heading`, an app's own. */
      readonly class?: string;
      readonly data?: T;
      /** Whether the cursor stops on the lines, as it does on a hunk. Defaults to `false`. */
      readonly stop?: boolean;
      /** The prose, a line a row, each cut rather than wrapped. */
      readonly text: string;
    };

/** What a `DiffView` draws: one diff, or a list of blocks. */
export type DiffViewContent<T = unknown> = DiffInput | readonly DiffBlock<T>[];

/**
 * A place a `DiffView`'s cursor stops: a hunk, or a block of prose marked `stop`.
 *
 * A hunk's stop carries the file and the hunk, which is what `hunkPatch()` takes
 * to write it as a patch of its own -- so the hunk under the cursor is one call
 * from being staged.
 */
export interface DiffStop<T = unknown> {
  /** The block the stop is in, as it was handed over. */
  readonly block: DiffBlock<T>;
  /** The file the hunk is in, for a hunk. */
  readonly file?: DiffFile;
  /** The hunk, for a hunk. */
  readonly hunk?: DiffHunk;
}

/**
 * The blocks of what a `DiffView` draws: a single diff is one block.
 *
 * @param content - One diff, or blocks.
 * @returns The blocks.
 */
export function diffBlocks<T>(content: DiffViewContent<T>): readonly DiffBlock<T>[] {
  return Array.isArray(content) ? content : [{ diff: content as DiffInput }];
}

/**
 * Every place a `DiffView`'s cursor stops, in the order it draws them: each hunk
 * of each diff, and each block of prose marked `stop`.
 *
 * The view takes each diff's hunks from the same function this does, with nothing
 * else that could change them -- two texts are diffed with the default context in
 * both -- so an app that keeps the cursor as a position and asks what is at it
 * gets the stop the view marks: there is one count, not one per party. A file of
 * a patch with no hunk (binary, renamed, a mode changed) is not a stop, since the
 * view draws nothing for it; an app that wants the cursor there says so with a
 * block of prose.
 *
 * @param content - What the view draws.
 * @returns The stops.
 */
export function diffStops<T>(content: DiffViewContent<T>): DiffStop<T>[] {
  return diffBlocks(content).flatMap((block): DiffStop<T>[] => {
    if ('text' in block) {
      return block.stop ? [{ block }] : [];
    }
    return filesOf(block.diff, undefined).flatMap((file) =>
      file.hunks.map((hunk) => ({ block, file, hunk }))
    );
  });
}
