import {
  box,
  type Element,
  renderToString,
  text as textNode,
  toDisplayText,
} from '../element/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { graphemes, stringWidth } from '../width/index.js';
import { terminalWidth } from '../wrap/index.js';
import { colorLevelOf } from './color-level.js';
import { unicodeSupported } from './note.js';
import { type HighlightSpan, TOKEN_ROLE, tokensOf } from './prompt.js';

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
}

/** The hunks of one file, and the names its patch gave the two sides. */
export interface DiffFile {
  hunks: DiffHunk[];
  newName?: string;
  oldName?: string;
}

/** What `diffView()` is asked to show: two texts, or a unified patch. */
export type DiffInput =
  | { new: string; newName?: string; old: string; oldName?: string }
  | { patch: string };

/** How the two sides are set out. */
export type DiffLayout = 'side-by-side' | 'unified';

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
   * A token is drawn in its role on an added or removed line and left muted on a
   * context one. There is no grammar in here; this is the seam an app fills.
   */
  highlight?: (text: string) => readonly HighlightSpan[];
  /**
   * Whether the changed stretch of a line that was edited is set apart from the
   * rest of it. Defaults to true.
   */
  intraline?: boolean;
  /** Which arrangement to draw. Defaults to `unified`. */
  layout?: DiffLayout;
  /** Whether each line is numbered. Defaults to true. */
  lineNumbers?: boolean;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** How many columns the diff spans. Defaults to `terminalWidth()`. */
  width?: number;
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
 * header. Everything outside a hunk and a file header (`diff --git`, `index`,
 * mode lines, a commit message) is skipped, and `\ No newline at end of file` is
 * dropped. Not read: renames and binary markers as anything but skipped text,
 * combined diffs, and the context format.
 *
 * @param patch - The patch.
 * @returns The files in it, none where it holds no hunk.
 */
export function parsePatch(patch: string): DiffFile[] {
  const rows = patch.split(/\r?\n/);
  if (rows.at(-1) === '') {
    rows.pop();
  }

  const files: DiffFile[] = [];
  let file: DiffFile | undefined;
  let hunk: DiffHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;
  let oldNumber = 0;
  let newNumber = 0;

  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;

    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const sign = row[0];
      const rest = row.slice(1);
      if (sign === '\\') {
        continue;
      }
      if (sign === '+' && newLeft > 0) {
        hunk.lines.push({ kind: 'add', newNumber: newNumber++, text: rest });
        newLeft--;
        continue;
      }
      if (sign === '-' && oldLeft > 0) {
        hunk.lines.push({ kind: 'remove', oldNumber: oldNumber++, text: rest });
        oldLeft--;
        continue;
      }
      if ((sign === ' ' || row === '') && oldLeft > 0 && newLeft > 0) {
        // an editor strips the one space of a blank context line
        hunk.lines.push({
          kind: 'context',
          newNumber: newNumber++,
          oldNumber: oldNumber++,
          text: rest,
        });
        oldLeft--;
        newLeft--;
        continue;
      }
      // a hunk that stops short of its counts ends where the patch stops agreeing
      oldLeft = 0;
      newLeft = 0;
    }

    if (row.startsWith('--- ') && rows[index + 1]?.startsWith('+++ ')) {
      file = { hunks: [], newName: fileName(rows[index + 1]!), oldName: fileName(row) };
      files.push(file);
      hunk = undefined;
      index++;
      continue;
    }

    const header = HUNK_HEADER.exec(row);
    if (header) {
      if (!file) {
        file = { hunks: [] };
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
      };
      file.hunks.push(hunk);
    }
  }

  return files.filter((entry) => entry.hunks.length > 0);
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
 * A line cut into the rows it takes at a width.
 *
 * Cut by columns rather than at words, because it is code, and with the row
 * boundary falling wherever the width says the reader can count it. A wide
 * character that does not fit starts the next row; one that cannot fit anywhere
 * is put on its own row anyway and the box clips it.
 *
 * @param cells - The line's cells.
 * @param room - The columns a row holds.
 * @returns The rows, at least one.
 */
function fold(cells: readonly Cell[], room: number): Cell[][] {
  const rows: Cell[][] = [[]];
  let used = 0;
  for (const cell of cells) {
    if (used + cell.width > room && rows.at(-1)!.length > 0) {
      rows.push([]);
      used = 0;
    }
    rows.at(-1)!.push(cell);
    used += cell.width;
  }
  return rows;
}

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
 * @returns Each row's elements.
 */
function lineRows(line: DiffLine, drawing: Drawing, gutter: string, room: number): Element[][] {
  const kind = KINDS[line.kind];
  const cells = cellsOf(line.text, drawing.tokens.get(line), drawing.changes.get(line) ?? []);

  return fold(cells, room).map((row, index) => {
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
      const classes = ['sigil-diff-text', kind.class, role];
      if (token) {
        classes.push('sigil-token', `sigil-token-${token}`);
      }
      if (changed) {
        // bold, from the heading role: an edited stretch needs an attribute beyond
        // the line's colour, and the sheet already has one that no role of colour
        // contradicts
        classes.push('sigil-diff-change', 'sigil-heading');
      }
      out.push(piece(run.map((cell) => cell.text).join(''), classes.join(' ')));
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
}

/**
 * The token of every code unit of every line of a side.
 *
 * @param lines - The lines of the side.
 * @param highlight - The app's hook.
 * @returns A token array per line.
 */
function tokenLines(
  lines: readonly string[],
  highlight: (text: string) => readonly HighlightSpan[]
): (string | undefined)[][] {
  const joined = lines.join('\n');
  const tokens = tokensOf(joined, highlight(joined));
  const out: (string | undefined)[][] = [];
  let at = 0;
  for (const line of lines) {
    out.push(tokens.slice(at, at + line.length));
    at += line.length + 1;
  }
  return out;
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
 * @returns The edits and tokens, keyed by line.
 */
function drawingOf(
  hunk: DiffHunk,
  opts: DiffOptions,
  whole: { new: (string | undefined)[][]; old: (string | undefined)[][] } | undefined
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
        opts.highlight
      ),
      new: tokenLines(
        hunk.lines.filter((line) => line.kind !== 'remove').map((line) => line.text),
        opts.highlight
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

/** The tree for a diff, the room it was built for, and the arrangement it ended up with. */
export interface DiffView {
  element: Element;
  /** What was drawn: `side-by-side` only if there was the width for it. */
  layout: DiffLayout;
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
 * and a line too long for the width is folded into more rows by columns before it
 * is built. Fixed width and `white-space: pre`, so the indentation of a line of code
 * survives, which a `normal` text would not keep at the end of a run.
 *
 * @param input - Two texts, or a unified patch.
 * @param opts - The arrangement, the room, and the highlighter.
 * @returns The tree, the room it was built for, and the arrangement used.
 */
export function diffView(input: DiffInput, opts: DiffOptions = {}): DiffView {
  const asked = opts.width === undefined ? NaN : Math.floor(opts.width);
  const width = asked >= 1 ? asked : Math.max(1, terminalWidth({ env: opts.env }));
  const layout: DiffLayout =
    opts.layout === 'side-by-side' && width >= DIFF_SIDE_BY_SIDE_MIN_WIDTH
      ? 'side-by-side'
      : 'unified';
  const numbered = opts.lineNumbers !== false;

  const twoTexts = 'patch' in input ? undefined : input;
  const files: DiffFile[] = twoTexts
    ? [
        {
          hunks: diffHunks(twoTexts.old, twoTexts.new, { context: opts.context }),
          newName: twoTexts.newName,
          oldName: twoTexts.oldName,
        },
      ]
    : parsePatch((input as { patch: string }).patch);

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
          old: tokenLines(splitLines(twoTexts.old), opts.highlight),
          new: tokenLines(splitLines(twoTexts.new), opts.highlight),
        }
      : undefined;

  const sep = unicodeSupported(opts.env, opts.platform) ? ' │ ' : ' | ';
  const half = Math.floor((width - sep.length) / 2);
  const sides = [half, width - sep.length - half] as const;
  const rows: Element[] = [];

  for (const file of files) {
    if (file.oldName !== undefined || file.newName !== undefined) {
      rows.push(headerRow(`--- ${file.oldName ?? ''}`, 'sigil-diff-file sigil-heading', width));
      rows.push(headerRow(`+++ ${file.newName ?? ''}`, 'sigil-diff-file sigil-heading', width));
    }

    for (const hunk of file.hunks) {
      rows.push(headerRow(hunkHeader(hunk), 'sigil-diff-hunk sigil-info', width));
      const drawing = drawingOf(hunk, opts, whole);

      if (layout === 'unified') {
        const gutter = numbered ? digits * 2 + 2 : 0;
        const room = Math.max(1, width - gutter - 1);
        for (const line of hunk.lines) {
          const lead = numbered
            ? `${String(line.oldNumber ?? '').padStart(digits)} ${String(line.newNumber ?? '').padStart(digits)} `
            : '';
          for (const children of lineRows(line, drawing, lead, room)) {
            rows.push(box({ class: 'sigil-diff-row', 'flex-shrink': 0 }, ...children));
          }
        }
        continue;
      }

      const gutter = numbered ? digits + 1 : 0;
      for (const pair of pairLines(hunk.lines)) {
        const drawn = [pair.left, pair.right].map((line, side) =>
          line
            ? lineRows(
                line,
                drawing,
                numbered
                  ? `${String((side === 0 ? line.oldNumber : line.newNumber) ?? '').padStart(digits)} `
                  : '',
                Math.max(1, sides[side]! - gutter - 1)
              )
            : []
        );
        for (let at = 0; at < Math.max(drawn[0]!.length, drawn[1]!.length); at++) {
          rows.push(
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
            )
          );
        }
      }
    }
  }

  return {
    element: box({ class: 'sigil-diff', 'flex-direction': 'column' }, ...rows),
    layout,
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
