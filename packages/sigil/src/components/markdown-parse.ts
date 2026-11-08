/**
 * Reading markdown: the subset `markdown()` draws, parsed into blocks and runs.
 *
 * ```js
 * import { parseMarkdown } from '@ttylabs/sigil/components/markdown-parse';
 *
 * parseMarkdown('# Title\n\nSome *words*.');
 * // [{ type: 'heading', level: 1, children: [...] }, { type: 'paragraph', ... }]
 * ```
 *
 * Written here because the runtime takes no dependency, and so scoped on purpose:
 * CommonMark in full is not the target. What is read is what a README, a
 * changelog entry and `sigil reference`'s pages are made of -- ATX and setext
 * headings, paragraphs, emphasis and strong emphasis, code spans, fenced and
 * indented code, bulleted and numbered lists that nest, block quotes, thematic
 * breaks, inline, reference and autolinks, images, hard breaks, backslash
 * escapes and a handful of entities -- and four of GitHub's extensions, since
 * GitHub is where most of those documents are written: pipe tables, task list
 * items, `~~strikethrough~~` and footnotes.
 *
 * Everything else is **text, as written**. Raw HTML and a bare URL are not parsed
 * and are not dropped either: a construct this does not know is shown to the
 * reader the way its author typed it, which is what the source looks like and
 * loses nothing. The one thing taken out is a
 * YAML front matter block at the very top, which is data for a site generator
 * rather than prose -- and read as CommonMark it would be a thematic break and a
 * setext heading made of its own keys.
 *
 * Where the subset is simplified, it is simplified the same way every time: a
 * link reference definition is one line; a tab is expanded to the next stop of
 * four before anything is read; and a list is loose when a blank line sits
 * between its items or between the blocks of one item.
 */

import { __ } from '../i18n/index.js';

/** How a table column lines its cells up; `undefined` is the reader's default. */
export type MarkdownAlign = 'left' | 'center' | 'right' | undefined;

/** A run of inline content: what a paragraph, a heading and a cell are made of. */
export type MarkdownInline =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'code'; readonly text: string }
  | { readonly type: 'emphasis'; readonly children: readonly MarkdownInline[] }
  | { readonly type: 'strong'; readonly children: readonly MarkdownInline[] }
  | {
      readonly type: 'link';
      readonly href: string;
      readonly title?: string;
      readonly children: readonly MarkdownInline[];
    }
  | { readonly type: 'image'; readonly src: string; readonly alt: string; readonly title?: string }
  | { readonly type: 'strikethrough'; readonly children: readonly MarkdownInline[] }
  /** A footnote reference: its label, keyed as a link's is, and the number it is drawn as. */
  | { readonly type: 'footnote'; readonly label: string; readonly index: number }
  | { readonly type: 'break' };

/**
 * A footnote's definition, as the `footnotes` block at the end of a document
 * holds it. `index` is the number its references are drawn with, which is the
 * order the document first refers to each one in.
 */
export interface MarkdownFootnote {
  readonly children: readonly MarkdownBlock[];
  readonly index: number;
  readonly label: string;
}

/** A block: the things a document is a column of. */
export type MarkdownBlock =
  | {
      readonly type: 'heading';
      readonly level: 1 | 2 | 3 | 4 | 5 | 6;
      readonly children: readonly MarkdownInline[];
    }
  | { readonly type: 'paragraph'; readonly children: readonly MarkdownInline[] }
  | { readonly type: 'code'; readonly info: string; readonly text: string }
  | { readonly type: 'quote'; readonly children: readonly MarkdownBlock[] }
  | {
      readonly type: 'list';
      readonly ordered: boolean;
      readonly start: number;
      readonly tight: boolean;
      readonly items: readonly (readonly MarkdownBlock[])[];
      /**
       * Per item, whether its task box is ticked, and `undefined` for an item that
       * is not a task. Present only on a list with at least one task in it.
       */
      readonly checked?: readonly (boolean | undefined)[];
    }
  | {
      readonly type: 'table';
      readonly align: readonly MarkdownAlign[];
      readonly head: readonly (readonly MarkdownInline[])[];
      readonly rows: readonly (readonly (readonly MarkdownInline[])[])[];
    }
  | { readonly type: 'rule' }
  /** The document's footnotes, drawn at its end; never anywhere else. */
  | { readonly type: 'footnotes'; readonly notes: readonly MarkdownFootnote[] };

/** A link reference definition, as `[label]: url "title"` gives it. */
interface Definition {
  href: string;
  title?: string;
}

/**
 * What the block pass collects for the inline one: the link reference
 * definitions, the footnote definitions, and -- filled while inlines are read --
 * the number each footnote is drawn as.
 */
interface Collected {
  readonly links: Map<string, Definition>;
  readonly notes: Map<string, RawBlock[]>;
  readonly numbers: Map<string, number>;
}

/** A block before its inline content has been read. */
type RawBlock =
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; raw: string }
  | { type: 'paragraph'; raw: string }
  | { type: 'code'; info: string; text: string }
  | { type: 'quote'; children: RawBlock[] }
  | {
      type: 'list';
      ordered: boolean;
      start: number;
      tight: boolean;
      items: RawBlock[][];
      checked?: (boolean | undefined)[];
    }
  | { type: 'table'; align: MarkdownAlign[]; head: string[]; rows: string[][] }
  | { type: 'rule' };

const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?/;
const ITEM = /^( {0,3})([*+-]|(\d{1,9})([.)]))(?=[ \t]|$)( *)(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const DELIMITER_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const FOOTNOTE = /^ {0,3}\[\^([^\s[\]]+)\]: *(.*)$/;
const TASK = /^\[([ xX])\]\s+(?=\S)/;
const DEFINITION =
  /^ {0,3}\[((?:[^\]\\[]|\\.){1,999})\]:[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;

/** The punctuation a backslash may escape, which is ASCII's and nothing else. */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** The entities read by name. A numeric one is read whatever it names. */
const ENTITIES: Record<string, string> = {
  amp: '&',
  apos: "'",
  copy: '©',
  gt: '>',
  hellip: '…',
  lt: '<',
  mdash: '—',
  nbsp: ' ',
  ndash: '–',
  quot: '"',
  reg: '®',
};

/**
 * Reads markdown into blocks.
 *
 * Never throws on what it is given: there is no malformed markdown, only
 * markdown that means less than its author hoped, and a construct that does not
 * close -- an `*` with no partner, a fence nobody ended -- is read the way
 * CommonMark reads it, as the literal characters or as running to the end.
 *
 * @param source - The document.
 * @returns Its blocks, in order.
 */
export function parseMarkdown(source: string): MarkdownBlock[] {
  if (typeof source !== 'string') {
    throw new TypeError(__`Expected markdown source to be a string`);
  }

  const lines = source.replaceAll(/\r\n?/g, '\n').split('\n').map(detab);
  const collected: Collected = { links: new Map(), notes: new Map(), numbers: new Map() };
  const raw = blocks(withoutFrontMatter(lines), collected).blocks;

  const document = raw.map((block) => resolve(block, collected));
  const notes = footnotes(collected);
  return notes.length === 0 ? document : [...document, { notes, type: 'footnotes' }];
}

/**
 * The footnotes, numbered and read, once the document's own blocks have been.
 *
 * A footnote is numbered by where the document first refers to it, which is
 * GitHub's rule, and a note may refer to another -- so the notes are read in
 * number order until reading them numbers nothing new. A definition nothing
 * refers to is still drawn, numbered after the rest: it is words the author
 * wrote, and dropping them is the one thing this parser does not do.
 *
 * @param collected - What the block pass collected; the numbering is filled in.
 * @returns The notes, in number order.
 */
function footnotes(collected: Collected): MarkdownFootnote[] {
  const out: MarkdownFootnote[] = [];
  const read = (label: string): void => {
    const children = collected.notes.get(label)!.map((block) => resolve(block, collected));
    out.push({ children, index: collected.numbers.get(label)!, label });
  };

  let done = 0;
  for (;;) {
    const order = [...collected.numbers.keys()];
    if (done < order.length) {
      read(order[done++]);
      continue;
    }
    const unreferenced = [...collected.notes.keys()].find((it) => !collected.numbers.has(it));
    if (unreferenced === undefined) {
      return out;
    }
    collected.numbers.set(unreferenced, collected.numbers.size + 1);
  }
}

/**
 * A line with its tabs expanded to the next stop of four.
 *
 * Everywhere rather than only in the indentation, which is a simplification
 * CommonMark does not make and is worth it: what decides a list item's content
 * or an indented code block is a column, and a tab that counted as one character
 * in one place and four columns in another is how two readers of one line come
 * to disagree. Inside prose a tab was going to be a space anyway.
 *
 * @param line - The line.
 * @returns It, with no tabs.
 */
function detab(line: string): string {
  if (!line.includes('\t')) {
    return line;
  }
  let out = '';
  for (const char of line) {
    out += char === '\t' ? ' '.repeat(4 - (out.length % 4)) : char;
  }
  return out;
}

/**
 * The lines with a front matter block taken off the top, where there is one.
 *
 * @param lines - The document's lines.
 * @returns What follows the block, or the lines as they were.
 */
function withoutFrontMatter(lines: string[]): string[] {
  if (lines[0]?.trimEnd() !== '---') {
    return lines;
  }
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trimEnd();
    if (line === '---' || line === '...') {
      return lines.slice(i + 1);
    }
  }
  return lines;
}

/** Whether a line holds nothing but whitespace. */
function isBlank(line: string): boolean {
  return line.trim() === '';
}

/** How many columns of spaces a line starts with. */
function indentOf(line: string): number {
  return line.length - line.replace(/^ +/, '').length;
}

/**
 * Whether a line starts a block that ends a paragraph above it.
 *
 * The same question a list item's lazy continuation and a quote's ask, so it is
 * asked once. A list item interrupts only when it has content and, if it is
 * numbered, starts at one -- which is CommonMark's rule for not turning a
 * sentence that happens to begin `2015. was` into a list.
 *
 * @param line - The line.
 * @param next - The line after it, which a table header needs.
 * @returns Whether it interrupts.
 */
function interrupts(line: string, next: string | undefined): boolean {
  if (
    ATX.test(line) ||
    FENCE.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    FOOTNOTE.test(line)
  ) {
    return true;
  }
  const item = ITEM.exec(line);
  if (item && item[6].trim() !== '' && (item[3] === undefined || item[3] === '1')) {
    return true;
  }
  return isTableStart(line, next);
}

/**
 * Whether two lines are a table's header and delimiter row.
 *
 * @param line - The candidate header.
 * @param next - The candidate delimiter row.
 * @returns Whether they open a table.
 */
function isTableStart(line: string, next: string | undefined): boolean {
  return (
    next !== undefined &&
    line.includes('|') &&
    DELIMITER_ROW.test(next) &&
    splitRow(line).length === splitRow(next).length
  );
}

/**
 * A table row's cells, split on the bars that are not escaped.
 *
 * `\|` is a bar inside a cell, including inside a code span -- which is GFM's
 * rule, and the one `sigil reference` writes its tables for -- so it is turned
 * into a bar here, before the cell's inline content is read.
 *
 * @param line - The row.
 * @returns Its cells, trimmed.
 */
function splitRow(line: string): string[] {
  let row = line.trim();
  if (row.startsWith('|')) {
    row = row.slice(1);
  }
  if (row.endsWith('|') && !escapedAt(row, row.length - 1)) {
    row = row.slice(0, -1);
  }

  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '|' && !escapedAt(row, i)) {
      cells.push(cell);
      cell = '';
    } else {
      cell += row[i];
    }
  }
  cells.push(cell);

  return cells.map((it) => it.trim().replaceAll('\\|', '|'));
}

/** Whether the character at `i` has an odd run of backslashes before it. */
function escapedAt(text: string, i: number): boolean {
  let slashes = 0;
  for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) {
    slashes++;
  }
  return slashes % 2 === 1;
}

/**
 * The blocks in a run of lines.
 *
 * Containers -- a quote, a list item -- gather their lines, take their own
 * markers off, and hand what is left back to this, which is what makes them
 * nest: a list inside a quote inside a list item is three calls, each of which
 * knows only its own prefix.
 *
 * @param lines - The lines, with any container's prefix already taken off.
 * @param collected - Where link and footnote definitions are collected.
 * @returns The blocks, and whether a blank line sat between two of them.
 */
function blocks(lines: string[], collected: Collected): { blocks: RawBlock[]; spaced: boolean } {
  const out: RawBlock[] = [];
  let spaced = false;
  let blankSince = false;
  let i = 0;

  const emit = (block: RawBlock): void => {
    if (blankSince && out.length > 0) {
      spaced = true;
    }
    blankSince = false;
    out.push(block);
  };

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      blankSince = true;
      i++;
      continue;
    }

    // indented code: four columns in, where nothing is open that it could be
    // the continuation of -- which here is always true, since a paragraph eats
    // its own continuation lines before control comes back
    if (indentOf(line) >= 4) {
      const code: string[] = [];
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
        code.push(lines[i].slice(4));
        i++;
      }
      while (code.length > 0 && isBlank(code.at(-1)!)) {
        code.pop();
      }
      emit({ info: '', text: code.join('\n'), type: 'code' });
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2][0] === '`' && fence[3].includes('`'))) {
      const [, indent, marks, info] = fence;
      const code: string[] = [];
      i++;
      while (i < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (close && close[1][0] === marks[0] && close[1].length >= marks.length) {
          i++;
          break;
        }
        // the content keeps its own indentation, less as much as the opening
        // fence was indented by -- which is what lets a fence inside a list item
        // be written at the item's column without that column ending up in it
        const content = lines[i];
        code.push(content.slice(Math.min(indent.length, indentOf(content))));
        i++;
      }
      emit({
        info: unescape(info.trim()).split(/\s/)[0] ?? '',
        text: code.join('\n'),
        type: 'code',
      });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      // a closing run of `#` is taken off only where a space comes before it, so
      // `# C#` keeps the language's name
      const content = (atx[2] ?? '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      emit({ level: atx[1].length as 1, raw: content, type: 'heading' });
      i++;
      continue;
    }

    if (RULE.test(line)) {
      emit({ type: 'rule' });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const current = lines[i];
        if (QUOTE.test(current)) {
          inner.push(current.replace(QUOTE, ''));
        } else if (
          // lazy continuation: a line that does not say `>` still belongs to the
          // quote's paragraph, which is how a hard-wrapped quoted sentence reads
          !isBlank(current) &&
          inner.length > 0 &&
          !isBlank(inner.at(-1)!) &&
          !interrupts(current, lines[i + 1])
        ) {
          inner.push(current);
        } else {
          break;
        }
        i++;
      }
      emit({ children: blocks(inner, collected).blocks, type: 'quote' });
      continue;
    }

    if (ITEM.test(line)) {
      const list = readList(lines, i, collected);
      i = list.next;
      emit(list.block);
      continue;
    }

    if (isTableStart(line, lines[i + 1])) {
      const head = splitRow(line);
      const align = splitRow(lines[i + 1]).map(alignOf);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && !isBlank(lines[i]) && !interrupts(lines[i], lines[i + 1])) {
        const cells = splitRow(lines[i]);
        rows.push(head.map((_, column) => cells[column] ?? ''));
        i++;
      }
      emit({ align, head, rows, type: 'table' });
      continue;
    }

    // a footnote's definition: its first line, the lines indented four under it,
    // and the lazy lines that carry its paragraph on -- a list item's shape with
    // a column of four, which is GitHub's
    const note = FOOTNOTE.exec(line);
    if (note) {
      const body: string[] = [note[2]];
      i++;
      while (i < lines.length) {
        const current = lines[i];
        if (isBlank(current)) {
          body.push('');
        } else if (indentOf(current) >= 4) {
          body.push(current.slice(4));
        } else if (
          !isBlank(body.at(-1)!) &&
          !interrupts(current, lines[i + 1]) &&
          !ITEM.test(current) &&
          !SETEXT.test(current)
        ) {
          body.push(current.trimStart());
        } else {
          break;
        }
        i++;
      }
      while (body.length > 1 && isBlank(body.at(-1)!)) {
        body.pop();
        i--;
      }
      const label = normalizeLabel(note[1]);
      const parsed = blocks(body, collected).blocks;
      if (!collected.notes.has(label)) {
        collected.notes.set(label, parsed);
      }
      continue;
    }

    // a definition is read where a paragraph would start, and takes the line
    const definition = DEFINITION.exec(line);
    if (definition) {
      const label = normalizeLabel(definition[1]);
      // the first definition of a label wins, which is CommonMark's rule and the
      // one that makes a document's meaning not depend on what follows it
      if (label !== '' && !collected.links.has(label)) {
        const href = definition[2].startsWith('<') ? definition[2].slice(1, -1) : definition[2];
        const title = definition[3]?.slice(1, -1);
        collected.links.set(label, {
          href: unescape(href),
          ...(title === undefined ? {} : { title: unescape(title) }),
        });
      }
      i++;
      continue;
    }

    // a paragraph, or a setext heading once its underline turns up
    const text: string[] = [line.trimStart()];
    i++;
    let heading: 1 | 2 | undefined;
    while (i < lines.length && !isBlank(lines[i])) {
      const setext = SETEXT.exec(lines[i]);
      if (setext) {
        heading = setext[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (interrupts(lines[i], lines[i + 1])) {
        break;
      }
      text.push(lines[i].trimStart());
      i++;
    }

    const raw = text.join('\n').trimEnd();
    emit(heading ? { level: heading, raw, type: 'heading' } : { raw, type: 'paragraph' });
  }

  return { blocks: out, spaced };
}

/**
 * A delimiter row's cell, as an alignment.
 *
 * @param cell - The cell, `---`, `:--`, `--:` or `:-:`.
 * @returns The alignment.
 */
function alignOf(cell: string): MarkdownAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : undefined;
}

/**
 * A list, starting at a line that opens an item.
 *
 * An item's lines are those indented to its content column, which is where the
 * first character after the marker sits, plus the lazy lines that carry on its
 * paragraph without being indented at all. The next item is a line with a marker
 * of the same kind -- the same bullet, or a number with the same `.` or `)` --
 * and a different bullet starts a different list, which is CommonMark's rule and
 * how two lists can sit next to each other.
 *
 * @param lines - The lines.
 * A task box, `[ ]` or `[x]`, is read off the front of an item's first paragraph
 * and nowhere else -- which is GitHub's rule, and what keeps a `[x]` in the middle
 * of a sentence, or at the start of a paragraph that is not in a list, the text it
 * is. Read off the paragraph rather than the line, so an item that opens with a
 * heading, a quote or indented code is not a task whatever that block starts with.
 *
 * @param lines - The lines.
 * @param start - The line the first item is on.
 * @param collected - Where link and footnote definitions are collected.
 * @returns The list and the line after it.
 */
function readList(
  lines: string[],
  start: number,
  collected: Collected
): { block: RawBlock; next: number } {
  const first = ITEM.exec(lines[start])!;
  const ordered = first[3] !== undefined;
  const kind = ordered ? first[4] : first[2];
  const items: RawBlock[][] = [];
  const checked: (boolean | undefined)[] = [];
  let tight = true;
  let i = start;

  while (i < lines.length) {
    const m = ITEM.exec(lines[i]);
    if (!m || (ordered ? m[4] : m[2]) !== kind || (m[3] !== undefined) !== ordered) {
      break;
    }

    const [, indent, marker, , , spaces, rest] = m;
    // the content column is where the first character after the marker sits --
    // unless that is five or more spaces on, which is an indented code block
    // inside the item, or nothing at all, which is an item whose content starts
    // on the next line
    const gap = rest === '' || spaces.length > 4 ? 1 : spaces.length;
    const column = indent.length + marker.length + gap;
    const body: string[] = [rest === '' ? '' : ' '.repeat(spaces.length - gap) + rest];
    i++;

    while (i < lines.length) {
      const current = lines[i];
      if (isBlank(current)) {
        // an item may start with one blank line and no more: an empty one is
        // over at the first blank after it
        if (body.length === 1 && body[0] === '') {
          break;
        }
        body.push('');
      } else if (indentOf(current) >= column) {
        body.push(current.slice(column));
      } else if (
        !isBlank(body.at(-1)!) &&
        !interrupts(current, lines[i + 1]) &&
        !ITEM.test(current) &&
        !SETEXT.test(current)
      ) {
        body.push(current.trimStart());
      } else {
        break;
      }
      i++;
    }

    // the blank lines at the end of an item are between it and whatever comes
    // next, so they are given back: to the next item they make the list loose,
    // and to the document they are just the space after the list
    let trailing = 0;
    while (body.length > 1 && isBlank(body.at(-1)!)) {
      body.pop();
      trailing++;
    }
    i -= trailing;

    const parsed = blocks(body, collected);
    if (parsed.spaced) {
      tight = false;
    }
    const lead = parsed.blocks[0];
    const task = lead?.type === 'paragraph' ? TASK.exec(lead.raw) : null;
    if (task && lead?.type === 'paragraph') {
      parsed.blocks[0] = { raw: lead.raw.slice(task[0].length), type: 'paragraph' };
    }
    checked.push(task ? task[1] !== ' ' : undefined);
    items.push(parsed.blocks);

    // a blank line before the next item of this list is what makes it loose; a
    // blank line before anything else is the end of it
    let ahead = i;
    while (ahead < lines.length && isBlank(lines[ahead])) {
      ahead++;
    }
    const next = ahead < lines.length ? ITEM.exec(lines[ahead]) : null;
    const same =
      next !== null &&
      (ordered ? next[4] : next[2]) === kind &&
      (next[3] !== undefined) === ordered;
    if (!same) {
      break;
    }
    if (ahead > i) {
      tight = false;
    }
    i = ahead;
  }

  return {
    block: {
      items,
      ordered,
      start: ordered ? Number(first[3]) : 1,
      tight,
      type: 'list',
      ...(checked.some((it) => it !== undefined) ? { checked } : {}),
    },
    next: i,
  };
}

/**
 * A label as definitions are keyed: trimmed, its white space collapsed, and in
 * one case. `toLowerCase()` rather than the locale's, for the reason a
 * destination is cased with `toUpperCase()`: a label is an identifier, not prose.
 */
function normalizeLabel(label: string): string {
  return label.trim().replaceAll(/\s+/g, ' ').toLowerCase();
}

/**
 * Text with its backslash escapes and entities read.
 *
 * @param text - What the source says.
 * @returns What it means.
 */
function unescape(text: string): string {
  return text.replaceAll(
    /\\([!-/:-@[-`{-~])|&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/g,
    (whole, escaped: string | undefined, entity: string | undefined) =>
      escaped ?? decodeEntity(entity!) ?? whole
  );
}

/**
 * An entity's character, or `undefined` for one this does not know.
 *
 * @param name - What is between the `&` and the `;`.
 * @returns The character.
 */
function decodeEntity(name: string): string | undefined {
  if (name.startsWith('#')) {
    const code =
      name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    // zero and the surrogates are not characters, and CommonMark puts the
    // replacement character where one is asked for
    return code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)
      ? '�'
      : String.fromCodePoint(code);
  }
  return ENTITIES[name];
}

/**
 * A block with its inline content read.
 *
 * @param block - The block.
 * @param collected - The definitions the whole document made.
 * @returns The block.
 */
function resolve(block: RawBlock, collected: Collected): MarkdownBlock {
  switch (block.type) {
    case 'heading': {
      return { children: inlines(block.raw, collected), level: block.level, type: 'heading' };
    }
    case 'paragraph': {
      return { children: inlines(block.raw, collected), type: 'paragraph' };
    }
    case 'quote': {
      return { children: block.children.map((it) => resolve(it, collected)), type: 'quote' };
    }
    case 'list': {
      return {
        items: block.items.map((item) => item.map((it) => resolve(it, collected))),
        ordered: block.ordered,
        start: block.start,
        tight: block.tight,
        type: 'list',
        ...(block.checked === undefined ? {} : { checked: block.checked }),
      };
    }
    case 'table': {
      return {
        align: block.align,
        head: block.head.map((cell) => inlines(cell, collected)),
        rows: block.rows.map((row) => row.map((cell) => inlines(cell, collected))),
        type: 'table',
      };
    }
    default: {
      return block;
    }
  }
}

/** A run of `*` or `_` that may open or close emphasis, or a `~~` strikethrough. */
interface Delimiter {
  canClose: boolean;
  canOpen: boolean;
  char: '*' | '_' | '~';
  count: number;
  kind: 'delimiter';
  /** How long the run was before any of it was used, which the rule of three reads. */
  length: number;
}

/** A `[` or `![` that may turn out to open a link or an image. */
interface Bracket {
  active: boolean;
  image: boolean;
  kind: 'bracket';
  /** Where the bracket's content starts in the source, for a reference label. */
  start: number;
}

type Token = Bracket | Delimiter | MarkdownInline;

/**
 * Whether a character is white space, for the flanking rules. The start and the
 * end of the text count as white space, which `undefined` stands for.
 */
function isSpace(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char);
}

/** Whether a character is punctuation, for the flanking rules: Unicode's P and S. */
function isPunctuation(char: string | undefined): boolean {
  return char !== undefined && /[\p{P}\p{S}]/u.test(char);
}

/**
 * A paragraph's text, read into inline runs.
 *
 * CommonMark's own algorithm, which is the only way unterminated and overlapping
 * emphasis comes out the same as everywhere else: a run of `*` or `_` is a
 * delimiter whose flanking says whether it may open or close, a `]` looks back
 * for its `[`, and emphasis is matched closer by closer against the nearest
 * opener that may take it. Whatever is left unmatched is the characters it was.
 *
 * A strikethrough is GitHub's, and is matched by the same algorithm with the
 * same flanking rules: a `~~` run opens and closes like a `**` run, and only
 * against another of exactly two. One tilde is not one, though GitHub takes it:
 * in what a CLI prints, `~5s` is "about" and `~/.config` is a home directory, and
 * a pair of them in one paragraph would strike out everything between.
 *
 * @param text - The text, its lines joined by `\n`.
 * @param collected - The link and footnote definitions.
 * @returns The runs.
 */
function inlines(text: string, collected: Collected): MarkdownInline[] {
  const tokens: Token[] = [];
  let plain = '';
  let i = 0;

  const flush = (): void => {
    if (plain !== '') {
      tokens.push({ text: plain, type: 'text' });
      plain = '';
    }
  };

  while (i < text.length) {
    const char = text[i];

    if (char === '\\') {
      const next = text[i + 1];
      if (next === '\n') {
        flush();
        tokens.push({ type: 'break' });
        i += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.test(next)) {
        plain += next;
        i += 2;
        continue;
      }
      plain += char;
      i++;
      continue;
    }

    if (char === '`') {
      const run = /^`+/.exec(text.slice(i))![0];
      const close = findCodeClose(text, i + run.length, run.length);
      if (close === -1) {
        plain += run;
        i += run.length;
        continue;
      }
      flush();
      let code = text.slice(i + run.length, close).replaceAll('\n', ' ');
      // one space each side is taken off when both are there and the span is
      // not all spaces, which is what lets a span hold a backtick at its edge
      if (code.length > 1 && code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '') {
        code = code.slice(1, -1);
      }
      tokens.push({ text: code, type: 'code' });
      i = close + run.length;
      continue;
    }

    if (char === '~') {
      const run = /^~+/.exec(text.slice(i))![0];
      if (run.length !== 2) {
        plain += run;
        i += run.length;
        continue;
      }
    }

    if (char === '*' || char === '_' || char === '~') {
      const run = (char === '*' ? /^\*+/ : char === '_' ? /^_+/ : /^~+/).exec(text.slice(i))![0];
      const before = i > 0 ? previousChar(text, i) : undefined;
      const after = nextChar(text, i + run.length);
      const left =
        !isSpace(after) && (!isPunctuation(after) || isSpace(before) || isPunctuation(before));
      const right =
        !isSpace(before) && (!isPunctuation(before) || isSpace(after) || isPunctuation(after));
      flush();
      tokens.push({
        // an underscore inside a word is not emphasis, so `snake_case_name`
        // stays one word -- which is the half of the rule an asterisk does not
        // have, because `**` inside a word is how a word is half bolded
        canClose: char === '_' ? right && (!left || isPunctuation(after)) : right,
        canOpen: char === '_' ? left && (!right || isPunctuation(before)) : left,
        char,
        count: run.length,
        kind: 'delimiter',
        length: run.length,
      });
      i += run.length;
      continue;
    }

    if (char === '!' && text[i + 1] === '[') {
      flush();
      tokens.push({ active: true, image: true, kind: 'bracket', start: i + 2 });
      i += 2;
      continue;
    }

    if (char === '[') {
      flush();
      tokens.push({ active: true, image: false, kind: 'bracket', start: i + 1 });
      i++;
      continue;
    }

    if (char === ']') {
      flush();
      i = closeBracket(text, i, tokens, collected);
      continue;
    }

    if (char === '<') {
      const auto = autolink(text, i);
      if (auto) {
        flush();
        tokens.push({
          children: [{ text: auto.text, type: 'text' }],
          href: auto.href,
          type: 'link',
        });
        i = auto.end;
        continue;
      }
    }

    if (char === '&') {
      const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z]{2,8});/.exec(text.slice(i, i + 12));
      const decoded = m ? decodeEntity(m[1]) : undefined;
      if (m && decoded !== undefined) {
        plain += decoded;
        i += m[0].length;
        continue;
      }
    }

    if (char === '\n') {
      // two spaces before a line end are a hard break; anything less is a soft
      // one, which is a space -- and the spaces themselves are never kept
      const hard = / {2,}$/.test(plain);
      plain = plain.replace(/ +$/, '');
      flush();
      if (hard) {
        tokens.push({ type: 'break' });
      } else {
        plain = ' ';
      }
      i++;
      continue;
    }

    plain += char;
    i++;
  }

  flush();
  emphasis(tokens, 0);
  return finish(tokens);
}

/** The character before `i`, which may be one half of a surrogate pair. */
function previousChar(text: string, i: number): string | undefined {
  const code = text.codePointAt(i - 1);
  if (code !== undefined && code >= 0xdc00 && code <= 0xdfff && i >= 2) {
    return String.fromCodePoint(text.codePointAt(i - 2)!);
  }
  return text[i - 1];
}

/** The character at `i`, a whole code point. */
function nextChar(text: string, i: number): string | undefined {
  const code = text.codePointAt(i);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/**
 * Where the backtick run that closes a code span starts.
 *
 * @param text - The text.
 * @param from - Where to start looking.
 * @param length - How long the opening run was; the closing one has to match it.
 * @returns The index, or `-1` where nothing closes it.
 */
function findCodeClose(text: string, from: number, length: number): number {
  const pattern = /`+/g;
  pattern.lastIndex = from;
  for (let m = pattern.exec(text); m; m = pattern.exec(text)) {
    if (m[0].length === length) {
      return m.index;
    }
  }
  return -1;
}

/**
 * An autolink at `i`: `<https://...>` or `<someone@example.com>`.
 *
 * @param text - The text.
 * @param i - Where the `<` is.
 * @returns What it links, or `undefined` where it is not one.
 */
function autolink(
  text: string,
  i: number
): { end: number; href: string; text: string } | undefined {
  const rest = text.slice(i);
  const uri = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
  if (uri) {
    return { end: i + uri[0].length, href: uri[1], text: uri[1] };
  }
  const email =
    /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(
      rest
    );
  if (email) {
    return { end: i + email[0].length, href: `mailto:${email[1]}`, text: email[1] };
  }
  return undefined;
}

/**
 * A `]`, which closes the nearest bracket into a link or an image where what
 * follows says where it goes, and is a `]` where it does not.
 *
 * @param text - The text.
 * @param i - Where the `]` is.
 * A `[^label]` naming a footnote the document defines is a reference to it, and
 * is numbered the first time it is met. One naming nothing is read like any
 * other bracket -- which, with no link definition of that label, is the
 * characters it was: what a reference to a missing link already does.
 *
 * @param text - The text.
 * @param i - Where the `]` is.
 * @param tokens - What has been read so far, which this rewrites.
 * @param collected - The link and footnote definitions.
 * @returns Where to carry on reading.
 */
function closeBracket(text: string, i: number, tokens: Token[], collected: Collected): number {
  let at = tokens.length - 1;
  while (at >= 0 && !isBracket(tokens[at])) {
    at--;
  }
  if (at < 0) {
    tokens.push({ text: ']', type: 'text' });
    return i + 1;
  }

  const opener = tokens[at] as Bracket;
  if (!opener.active) {
    // a bracket inside a link that has already closed: no link in a link, so it
    // is the character it was
    tokens[at] = { text: '[', type: 'text' };
    tokens.push({ text: ']', type: 'text' });
    return i + 1;
  }

  const label = text.slice(opener.start, i);
  let target: Definition | undefined;
  let end = i + 1;

  const inline = linkTail(text, i + 1);
  const note = /^\^([^\s[\]]+)$/.exec(label);
  const noteLabel = note ? normalizeLabel(note[1]) : '';
  if (!inline && !opener.image && note && collected.notes.has(noteLabel)) {
    if (!collected.numbers.has(noteLabel)) {
      collected.numbers.set(noteLabel, collected.numbers.size + 1);
    }
    tokens.splice(at);
    tokens.push({ index: collected.numbers.get(noteLabel)!, label: noteLabel, type: 'footnote' });
    return i + 1;
  }

  if (inline) {
    target = inline;
    end = inline.end;
  } else {
    // a full reference, `[text][label]`; a collapsed one, `[text][]`; and a
    // shortcut, `[text]` alone -- the last two both keyed on the text itself
    const ref = /^\[((?:[^\]\\[]|\\.){0,999})\]/.exec(text.slice(i + 1));
    const key = normalizeLabel(ref && ref[1] !== '' ? ref[1] : label);
    target = collected.links.get(key);
    if (target && ref) {
      end = i + 1 + ref[0].length;
    }
  }

  if (!target) {
    tokens[at] = { text: opener.image ? '![' : '[', type: 'text' };
    tokens.push({ text: ']', type: 'text' });
    return i + 1;
  }

  const inside = tokens.splice(at + 1);
  tokens.pop();
  emphasis(inside, 0);
  const children = finish(inside);

  if (opener.image) {
    tokens.push({
      alt: markdownText(children),
      src: target.href,
      ...(target.title === undefined ? {} : { title: target.title }),
      type: 'image',
    });
  } else {
    tokens.push({
      children,
      href: target.href,
      ...(target.title === undefined ? {} : { title: target.title }),
      type: 'link',
    });
    // no link inside a link: every bracket still open before this one is now
    // only a bracket
    for (const token of tokens) {
      if (isBracket(token) && !token.image) {
        token.active = false;
      }
    }
  }

  return end;
}

/** Whether a token is a bracket. */
function isBracket(token: Token): token is Bracket {
  return 'kind' in token && token.kind === 'bracket';
}

/** Whether a token is a delimiter run. */
function isDelimiter(token: Token): token is Delimiter {
  return 'kind' in token && token.kind === 'delimiter';
}

/**
 * The `(destination "title")` after a link's `]`.
 *
 * @param text - The text.
 * @param i - Where the `(` should be.
 * @returns The target and where it ends, or `undefined` where there is none.
 */
function linkTail(text: string, i: number): (Definition & { end: number }) | undefined {
  if (text[i] !== '(') {
    return undefined;
  }
  let at = skipSpace(text, i + 1);
  let href = '';

  if (text[at] === '<') {
    const close = /^<((?:[^<>\n\\]|\\.)*)>/.exec(text.slice(at));
    if (!close) {
      return undefined;
    }
    href = close[1];
    at += close[0].length;
  } else {
    let depth = 0;
    const start = at;
    while (at < text.length) {
      const c = text[at];
      if (c === '\\' && text[at + 1] !== undefined && ESCAPABLE.test(text[at + 1])) {
        at += 2;
        continue;
      }
      if (/[\s\p{Cc}]/u.test(c)) {
        break;
      }
      if (c === '(') {
        depth++;
      } else if (c === ')') {
        if (depth === 0) {
          break;
        }
        depth--;
      }
      at++;
    }
    if (depth !== 0) {
      return undefined;
    }
    href = text.slice(start, at);
  }

  const beforeTitle = at;
  at = skipSpace(text, at);
  let title: string | undefined;
  const opening = text[at];
  if (at > beforeTitle && (opening === '"' || opening === "'" || opening === '(')) {
    const closing = opening === '(' ? ')' : opening;
    let j = at + 1;
    while (j < text.length && text[j] !== closing) {
      j += text[j] === '\\' ? 2 : 1;
    }
    if (j >= text.length) {
      return undefined;
    }
    title = unescape(text.slice(at + 1, j));
    at = skipSpace(text, j + 1);
  }

  if (text[at] !== ')') {
    return undefined;
  }

  return { end: at + 1, href: unescape(href), ...(title === undefined ? {} : { title }) };
}

/** Where the spaces, tabs and at most one line break starting at `i` end. */
function skipSpace(text: string, i: number): number {
  let at = i;
  let breaks = 0;
  while (at < text.length && (text[at] === ' ' || (text[at] === '\n' && breaks++ === 0))) {
    at++;
  }
  return at;
}

/**
 * Matches emphasis delimiters into emphasis and strong emphasis, in place.
 *
 * Closer by closer, each against the nearest opener of the same character that
 * may take it. Two characters from each where both have two, which is what makes
 * `***both***` strong emphasis inside emphasis; and the rule of three, which
 * stops `*foo**bar*` reading as an emphasis that closes in the middle of `**`.
 * The openers a closer has already failed against are remembered by the token
 * below which it stopped, so a long run of unmatched delimiters is not searched
 * once per closer.
 *
 * @param tokens - The tokens, which are rewritten.
 * @param bottom - The index below which nothing is an opener for these closers.
 */
function emphasis(tokens: Token[], bottom: number): void {
  const floors = new Map<string, Token>();
  let c = bottom;

  while (c < tokens.length) {
    const closer = tokens[c];
    if (!isDelimiter(closer) || !closer.canClose) {
      c++;
      continue;
    }

    const key = `${closer.char}${closer.canOpen}${closer.length % 3}`;
    const floor = floors.get(key);
    let o = c - 1;
    let found = -1;
    for (; o >= bottom; o--) {
      const opener = tokens[o];
      if (opener === floor) {
        break;
      }
      if (!isDelimiter(opener) || opener.char !== closer.char || !opener.canOpen) {
        continue;
      }
      // a strikethrough's runs are always two, and two and two is never three
      const odd =
        (opener.canClose || closer.canOpen) &&
        (opener.length + closer.length) % 3 === 0 &&
        !(opener.length % 3 === 0 && closer.length % 3 === 0);
      if (!odd) {
        found = o;
        break;
      }
    }

    if (found === -1) {
      floors.set(key, tokens[c - 1]);
      if (!closer.canOpen) {
        tokens[c] = { text: closer.char.repeat(closer.count), type: 'text' };
      }
      c++;
      continue;
    }

    const opener = tokens[found] as Delimiter;
    const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    const inside = tokens.slice(found + 1, c);
    const node: MarkdownInline = {
      children: finish(inside),
      type: closer.char === '~' ? 'strikethrough' : use === 2 ? 'strong' : 'emphasis',
    };
    opener.count -= use;
    closer.count -= use;

    // the opener and the closer stay where they are, with what is left of
    // them, and the run between them becomes one node
    tokens.splice(found + 1, c - found - 1, node);
    c = found + 2;

    if (opener.count === 0) {
      tokens.splice(found, 1);
      c--;
    }
    if (closer.count === 0) {
      tokens.splice(c, 1);
    }
  }
}

/**
 * Tokens as the runs they finally are: an unmatched delimiter or bracket is its
 * characters, and neighbouring text is one run.
 *
 * @param tokens - The tokens.
 * @returns The runs.
 */
function finish(tokens: readonly Token[]): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  for (const token of tokens) {
    const node: MarkdownInline = isDelimiter(token)
      ? { text: token.char.repeat(token.count), type: 'text' }
      : isBracket(token)
        ? { text: token.image ? '![' : '[', type: 'text' }
        : token;
    const last = out.at(-1);
    if (node.type === 'text' && last?.type === 'text') {
      out[out.length - 1] = { text: last.text + node.text, type: 'text' };
    } else if (node.type !== 'text' || node.text !== '') {
      out.push(node);
    }
  }
  return out;
}

/**
 * What a run of inline content says, without its formatting.
 *
 * An image's description is this, because there is nowhere to put formatting in
 * text that stands in for a picture. A strikethrough keeps its tildes, because
 * they are meaning rather than formatting: without them the words read as said.
 *
 * @param runs - The runs.
 * @returns The text.
 */
export function markdownText(runs: readonly MarkdownInline[]): string {
  return runs
    .map((run) => {
      switch (run.type) {
        case 'text':
        case 'code': {
          return run.text;
        }
        case 'image': {
          return run.alt;
        }
        case 'break': {
          return ' ';
        }
        case 'footnote': {
          return `[${run.index}]`;
        }
        case 'strikethrough': {
          // what was typed: the tildes are the only mark the words are struck,
          // and struck words with nothing round them say the opposite
          return `~~${markdownText(run.children)}~~`;
        }
        default: {
          return markdownText(run.children);
        }
      }
    })
    .join('');
}
