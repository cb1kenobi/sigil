/**
 * Markdown, drawn: a README, a changelog entry or a `sigil reference` page as
 * styled terminal text.
 *
 * ```js
 * import { markdown } from '@ttylabs/sigil/components/markdown';
 *
 * console.log(markdown('# Changes\n\n- **Fixed** the `--port` flag'));
 * ```
 *
 * The source is read by `parseMarkdown()` and the blocks are built into an
 * element tree like every other built-in: a paragraph is a wrapping row of words,
 * a list is a column of rows with a marker in front, a table is measured columns.
 * So it wraps at the width it is given by the layout engine rather than by
 * arithmetic of its own, and every colour in it is a theme's.
 */

import { supportsHyperlinks } from '../ansi/index.js';
import {
  box,
  cellStyle,
  type Element,
  raw,
  renderToString,
  text as textNode,
} from '../element/index.js';
import { __ } from '../i18n/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';
import { graphemes, graphemeWidth, stringWidth } from '../width/index.js';
import { terminalWidth } from '../wrap/index.js';
import { colorLevelOf } from './color-level.js';
import {
  type MarkdownAlign,
  type MarkdownBlock,
  type MarkdownInline,
  parseMarkdown,
  markdownText,
} from './markdown-parse.js';
import { unicodeSupported } from './note.js';
import { type HighlightSpan, TOKEN_ROLE, tokensOf } from './prompt.js';
import { ruleView } from './rule.js';
import { type Column, tableRowView, tableWidths } from './table.js';

export interface MarkdownOptions extends StyledOptions {
  /**
   * What a relative link is resolved against, such as the repository a README
   * came from. Without one a relative link is not a hyperlink -- a terminal has
   * nothing to resolve it against -- and its path is shown beside its words.
   */
  baseUrl?: string;
  /** The environment to read the terminal from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Says which stretches of a code block are which tokens, for syntax
   * highlighting -- the hook `diff()` and `multiline()` take, with the block's
   * language beside the code.
   *
   * Called once per fenced or indented code block, with the whole block and the
   * first word of its info string (`ts` for a fence opened with three backticks
   * and `ts`), or `undefined` where it names none. A token draws in its role where
   * it has one and carries `sigil-token-<token>` for an app's sheet; the rest of
   * a block it marked anything in is the plain foreground, since the accent it is
   * otherwise drawn in is the keyword's. A block it marks nothing in -- a language
   * it does not know -- is drawn as it would be without it. Inline code spans are
   * never handed to it: they have no language to say what they are in.
   */
  highlight?: (code: string, lang: string | undefined) => readonly HighlightSpan[];
  /**
   * Whether a link is an OSC 8 hyperlink, with its URL out of sight, or its words
   * with the URL after them. Defaults to `supportsHyperlinks()` for `stream`, and
   * is always the second at colour level 0, which writes no escape sequence.
   */
  hyperlinks?: boolean;
  /** The platform to detect for. Defaults to `process.platform`. */
  platform?: string;
  /** The stream the output is bound for. Defaults to `process.stdout`. */
  stream?: { columns?: number; isTTY?: boolean };
  /** The columns to wrap at. Defaults to `terminalWidth()`, never under 10. */
  width?: number;
}

/** The element tree for a document, and the room it was built for. */
export interface MarkdownView {
  readonly element: Element;
  readonly width: number;
}

/** The narrowest a document is laid out at; a list three deep needs this much. */
const MIN_WIDTH = 10;

/** The columns between one table column and the next, as `table()` has them. */
const TABLE_GAP = 2;

/** A bullet per depth, cycling, and what each is where box drawing is not safe. */
const BULLETS = ['•', '◦', '▪'];
const ASCII_BULLETS = ['*', '-', '+'];

/**
 * A task box, open and ticked, and what each is where box drawing is not safe --
 * which is what the author typed. `☒` rather than a tick because it is the same
 * thing: a box with an `x` in it. Neither is an emoji, so neither is drawn two
 * columns wide by a terminal that reads `☑` as one.
 */
const BOXES = { off: '☐', on: '☒' };
const ASCII_BOXES = { off: '[ ]', on: '[x]' };

/** What stands either side of a struck-out run whatever the terminal draws. */
const STRIKE_MARKER = '~~';

/** What the walk carries down: the room left, and what was settled at the top. */
interface Context {
  readonly baseUrl: string | undefined;
  readonly depth: number;
  readonly env: Record<string, string | undefined> | undefined;
  readonly highlight: MarkdownOptions['highlight'];
  readonly hyperlinks: boolean;
  readonly platform: string | undefined;
  readonly room: number;
  readonly unicode: boolean;
}

/** A piece of a word: one style and one link. */
interface Piece {
  classes: string;
  href: string;
  text: string;
}

/** A word: what sits between two spaces, which may be in several styles. */
type Word = Piece[];

/**
 * Builds the element tree for a document.
 *
 * @param source - The markdown, or blocks `parseMarkdown()` already read.
 * @param opts - The room, the links, and the theme.
 * @returns The tree, and the room it was built for.
 */
export function markdownView(
  source: string | readonly MarkdownBlock[],
  opts: MarkdownOptions = {}
): MarkdownView {
  if (typeof source !== 'string' && !Array.isArray(source)) {
    throw new TypeError(__`Expected markdown to be a string or parsed blocks`);
  }

  const document = typeof source === 'string' ? parseMarkdown(source) : source;
  const asked = opts.width === undefined ? NaN : Math.floor(opts.width);
  const width = Math.max(
    MIN_WIDTH,
    asked > 0 ? asked : terminalWidth({ env: opts.env, stream: opts.stream })
  );
  const level = colorLevelOf(opts);

  const ctx: Context = {
    baseUrl: opts.baseUrl,
    depth: 0,
    env: opts.env,
    highlight: opts.highlight,
    // level 0 is "write no escape sequences", and an OSC 8 is one -- so the URL
    // goes beside the words whatever the terminal could have done with it
    hyperlinks:
      level > 0 &&
      (opts.hyperlinks ??
        supportsHyperlinks({
          env: opts.env,
          stream: opts.stream ?? process.stdout,
        })),
    platform: opts.platform,
    room: width,
    unicode: unicodeSupported(opts.env, opts.platform),
  };

  return {
    element: column(document, ctx, true, 'sigil-markdown'),
    width,
  };
}

/**
 * Draws markdown as styled text.
 *
 * A facade over `markdownView()`, the way `note()` is over `noteView()`: the tree
 * is laid out and painted onto a grid of its own and what comes back is the grid
 * read as lines. It returns a string and the caller does the writing, which puts
 * it on the result side of `--quiet` with `table()` and `note()`.
 *
 * @param source - The markdown, or blocks `parseMarkdown()` already read.
 * @param opts - The room, the links, and the theme.
 * @returns The document, with no trailing newline.
 */
export function markdown(
  source: string | readonly MarkdownBlock[],
  opts: MarkdownOptions = {}
): string {
  const { element, width } = markdownView(source, opts);

  return renderToString(element, {
    cascade: themedCascade(opts),
    colorLevel: colorLevelOf(opts),
    colorScheme: opts.colorScheme,
    width,
  });
}

/**
 * A run of blocks, one under another.
 *
 * @param blocks - The blocks.
 * @param ctx - The room and the settings.
 * @param spaced - Whether a blank line goes between them, which a tight list
 *   item is the one thing to say no to.
 * @param classes - What the column carries.
 * @returns The column.
 */
function column(
  blocks: readonly MarkdownBlock[],
  ctx: Context,
  spaced: boolean,
  classes: string
): Element {
  return box(
    {
      class: classes,
      'flex-direction': 'column',
      'flex-grow': 1,
      'flex-shrink': 1,
      'min-width': 0,
      'row-gap': spaced ? 1 : 0,
    },
    ...blocks.map((block) => blockView(block, ctx))
  );
}

/**
 * One block.
 *
 * @param block - The block.
 * @param ctx - The room and the settings.
 * @returns Its tree.
 */
function blockView(block: MarkdownBlock, ctx: Context): Element {
  switch (block.type) {
    case 'heading': {
      // a terminal has one size of type, so the level is said by the roles: the
      // first level is the accent as well as bold, every other one is bold, and
      // a `.sigil-markdown-hN` per level is there for a theme that wants six
      const accent = block.level === 1 ? ' sigil-accent' : '';
      return flow(
        words(block.children, ctx),
        `sigil-markdown-heading sigil-markdown-h${block.level} sigil-heading${accent}`,
        undefined,
        ctx.room
      );
    }
    case 'paragraph': {
      return flow(words(block.children, ctx), 'sigil-markdown-paragraph', undefined, ctx.room);
    }
    case 'code': {
      return codeBlock(block.text, block.info, ctx);
    }
    case 'quote': {
      return quote(block.children, ctx);
    }
    case 'list': {
      return list(block, ctx);
    }
    case 'table': {
      return tableBlock(block, ctx);
    }
    case 'rule': {
      return ruleView({ env: ctx.env, platform: ctx.platform, width: ctx.room }).element;
    }
    case 'footnotes': {
      return footnotes(block, ctx);
    }
  }
}

/**
 * A code block: its lines kept as they are, two columns in.
 *
 * A line wider than the room is folded onto the row below by columns rather than
 * wrapped at a space, because a wrap moves characters and code is the one place
 * a reader may copy what they see. Folded here rather than left to run off the
 * edge: a string is laid out as wide as its widest line, and a terminal wrapping
 * it instead would start the rest of the line at column zero, outside the block.
 *
 * Highlighted, the hook is asked about the whole block and its spans are cut with
 * the lines and then with the folds, so a block comment over three lines is one
 * span and a token a fold breaks is drawn in its own style on both rows. Each row
 * is then a row of fixed-width `pre` texts, one per run of cells with one token,
 * which is how `diff()` draws a highlighted line: one element resolves one style.
 *
 * @param code - The code.
 * @param info - The language, as the fence named it, or `''`.
 * @param ctx - The room, and the app's highlighter.
 * @returns Its tree.
 */
function codeBlock(code: string, info: string, ctx: Context): Element {
  const room = Math.max(1, ctx.room - 2);
  const source = code.split('\n');
  const outer = {
    class: 'sigil-markdown-code-block',
    'flex-direction': 'column',
    'padding-left': 2,
  };
  // a hook that throws is the caller's code failing, and is left to reach the
  // caller -- the answer `diff()` and `multiline()` give -- and a span out of range
  // is clipped and a bad token name refused by the validator all three share
  const tokens = ctx.highlight
    ? tokensOf(code, ctx.highlight(code, info === '' ? undefined : info))
    : undefined;

  if (!tokens?.some((token) => token !== undefined)) {
    const lines = source.flatMap((line) => fold(line, room));
    return box(
      outer,
      textNode(lines.join('\n'), {
        class: 'sigil-markdown-code sigil-accent',
        'white-space': 'pre',
      })
    );
  }

  const rows: Element[] = [];
  let at = 0;
  for (const line of source) {
    for (const part of fold(line, room)) {
      rows.push(codeRow(part, tokens, at));
      at += part.length;
    }
    // the line break the split took out
    at++;
  }
  return box(outer, ...rows);
}

/**
 * One row of a highlighted code block, as runs of cells that share a token.
 *
 * A cluster takes the token of the code unit it starts at, which is `diff()`'s
 * rule: a span that ends inside a cluster cannot colour half of one cell.
 *
 * @param part - The row's text.
 * @param tokens - The token of every code unit of the block.
 * @param at - Where the row starts in the block.
 * @returns The row.
 */
function codeRow(part: string, tokens: readonly (string | undefined)[], at: number): Element {
  const runs: { text: string; token: string | undefined }[] = [];
  let offset = at;
  for (const cluster of graphemes(part)) {
    const token = tokens[offset];
    const last = runs.at(-1);
    if (last && last.token === token) {
      last.text += cluster;
    } else {
      runs.push({ text: cluster, token });
    }
    offset += cluster.length;
  }
  if (runs.length === 0) {
    // an empty text, so an empty line keeps its row
    runs.push({ text: '', token: undefined });
  }

  return box(
    { class: 'sigil-markdown-code-row', 'flex-direction': 'row', 'flex-shrink': 0 },
    ...runs.map(({ text, token }) => {
      // a token with no role, an app's own, is the plain foreground with a class
      // for the app's sheet; a role replaces nothing, since nothing else is set
      const role = token === undefined ? undefined : TOKEN_ROLE.get(token);
      const classes = ['sigil-markdown-code'];
      if (token !== undefined) {
        classes.push('sigil-token', `sigil-token-${token}`);
      }
      if (role !== undefined) {
        classes.push(role);
      }
      return textNode(text, {
        class: classes.join(' '),
        'flex-shrink': 0,
        'white-space': 'pre',
        width: stringWidth(text),
      });
    })
  );
}

/**
 * A line cut into pieces no wider than the room, at grapheme boundaries.
 *
 * @param line - The line.
 * @param room - The columns.
 * @returns The pieces, at least one.
 */
function fold(line: string, room: number): string[] {
  if (stringWidth(line) <= room) {
    return [line];
  }
  const out: string[] = [];
  let current = '';
  let used = 0;
  for (const cluster of graphemes(line)) {
    const w = graphemeWidth(cluster);
    if (used + w > room && current !== '') {
      out.push(current);
      current = '';
      used = 0;
    }
    current += cluster;
    used += w;
  }
  out.push(current);
  return out;
}

/**
 * A block quote: a bar down the left, and the blocks beside it.
 *
 * The bar is a `raw` that paints its character down however many rows the quote
 * came to, which is the one thing a text cannot do: it would have to know the
 * height before the layout had worked it out.
 *
 * @param blocks - What is quoted.
 * @param ctx - The room.
 * @returns Its tree.
 */
function quote(blocks: readonly MarkdownBlock[], ctx: Context): Element {
  const glyph = ctx.unicode ? '│' : '|';
  const bar = raw(
    {
      drawsText: false,
      measure: () => ({ height: 1, minWidth: 1, width: 1 }),
      paint: (painter, area, element) => {
        const cell = cellStyle(element.style);
        for (let row = 0; row < area.height; row++) {
          painter.text(area.x, area.y + row, glyph, cell);
        }
      },
    },
    { class: 'sigil-markdown-quote-bar sigil-muted', 'flex-shrink': 0, width: 1 }
  );

  return box(
    { class: 'sigil-markdown-quote', 'column-gap': 1, 'flex-direction': 'row' },
    bar,
    column(blocks, { ...ctx, room: Math.max(1, ctx.room - 2) }, true, 'sigil-markdown-quote-body')
  );
}

/**
 * A list: a column of items, each a marker and the blocks beside it.
 *
 * The marker column is as wide as the widest marker, so the numbers of a list
 * that reaches ten line up on their right and every item's text starts in the
 * same column -- the hanging indent a wrapped item needs, from the layout rather
 * than from arithmetic.
 *
 * A task's box stands where a bulleted item's bullet would, and after the number
 * of a numbered one, since the number may be what the steps are referred to by.
 * In a numbered list holding a task, an item that is not one keeps the box's
 * column empty, so every item's text still starts in one column.
 *
 * @param block - The list.
 * @param ctx - The room and the depth.
 * @returns Its tree.
 */
function list(block: Extract<MarkdownBlock, { type: 'list' }>, ctx: Context): Element {
  const bullets = ctx.unicode ? BULLETS : ASCII_BULLETS;
  const boxes = ctx.unicode ? BOXES : ASCII_BOXES;
  const task = (index: number): boolean | undefined => block.checked?.[index];
  const glyph = (index: number): string => (task(index) ? boxes.on : boxes.off);
  const markers = block.items.map((_, index) =>
    block.ordered
      ? `${block.start + index}.`
      : task(index) === undefined
        ? bullets[ctx.depth % bullets.length]
        : glyph(index)
  );
  const markerWidth = Math.max(...markers.map((marker) => stringWidth(marker)), 1);
  // a numbered list's boxes are a column of their own, after the numbers
  const boxed = block.ordered && block.checked !== undefined;
  const boxWidth = stringWidth(boxes.off);
  const inner: Context = {
    ...ctx,
    depth: ctx.depth + 1,
    room: Math.max(1, ctx.room - markerWidth - 1 - (boxed ? boxWidth + 1 : 0)),
  };
  const fixed = { 'flex-shrink': 0, 'white-space': 'pre' } as const;

  return box(
    {
      class: `sigil-markdown-list ${block.ordered ? 'sigil-markdown-ol' : 'sigil-markdown-ul'}`,
      'flex-direction': 'column',
      'row-gap': block.tight ? 0 : 1,
    },
    ...block.items.map((item, index) => {
      const state = task(index);
      const marker =
        state === undefined || block.ordered
          ? 'sigil-markdown-marker sigil-muted'
          : `sigil-markdown-marker ${taskClasses(state)}`;
      return box(
        { class: 'sigil-markdown-item', 'column-gap': 1, 'flex-direction': 'row' },
        // numbers line up on their right; a bullet and a box on their left, which
        // only differs where an ASCII box is three columns and a bullet one
        textNode(markers[index], {
          ...fixed,
          class: marker,
          'text-align': block.ordered ? 'right' : 'left',
          width: markerWidth,
        }),
        ...(boxed
          ? [
              state === undefined
                ? textNode('', { ...fixed, width: boxWidth })
                : textNode(glyph(index), { ...fixed, class: taskClasses(state), width: boxWidth }),
            ]
          : []),
        column(item, inner, !block.tight, 'sigil-markdown-item-body')
      );
    })
  );
}

/**
 * What a task's box carries: muted while it is open, and the success role once
 * it is ticked. The glyph says which as well, so neither depends on the colour.
 */
function taskClasses(done: boolean): string {
  return done
    ? 'sigil-markdown-task sigil-markdown-task-done sigil-success'
    : 'sigil-markdown-task sigil-muted';
}

/**
 * The footnotes, at the end of the document: a rule, then each note's number and
 * its blocks beside it, the way a numbered list's items are drawn.
 *
 * A reference is drawn `[1]` in the text and its note `[1]` here, the same in
 * every terminal. Superscript digits were the other choice and are worse at the
 * one thing a reference is for, which is being seen: a terminal draws them a
 * third the height of a digit, in a cell the same width.
 *
 * @param block - The notes.
 * @param ctx - The room.
 * @returns Its tree.
 */
function footnotes(block: Extract<MarkdownBlock, { type: 'footnotes' }>, ctx: Context): Element {
  const markers = block.notes.map((note) => `[${note.index}]`);
  const markerWidth = Math.max(...markers.map((marker) => stringWidth(marker)), 1);
  const inner: Context = { ...ctx, room: Math.max(1, ctx.room - markerWidth - 1) };
  // spaced as a list is: a blank line between notes once any note is more than
  // one block, or a two-paragraph note would read as two notes
  const loose = block.notes.some((note) => note.children.length > 1);

  return box(
    { class: 'sigil-markdown-footnotes', 'flex-direction': 'column' },
    ruleView({ env: ctx.env, platform: ctx.platform, width: ctx.room }).element,
    box(
      { 'flex-direction': 'column', 'row-gap': loose ? 1 : 0 },
      ...block.notes.map((note, index) =>
        box(
          { class: 'sigil-markdown-footnote', 'column-gap': 1, 'flex-direction': 'row' },
          textNode(markers[index], {
            class: 'sigil-markdown-footnote-marker sigil-muted',
            'flex-shrink': 0,
            'text-align': 'right',
            'white-space': 'pre',
            width: markerWidth,
          }),
          column(note.children, inner, true, 'sigil-markdown-footnote-body')
        )
      )
    )
  );
}

/** Where a cell's words sit in a column wider than they are. */
const JUSTIFY: Record<NonNullable<MarkdownAlign>, string> = {
  center: 'center',
  left: 'flex-start',
  right: 'flex-end',
};

/**
 * A table: `table()`'s rows, the heading row bold, and a rule under it.
 *
 * Built from `table.ts`'s own pieces -- `tableWidths()` measures the columns and
 * `tableRowView()` draws each row, with every cell a `TableCellView` -- so a
 * markdown table and `table()` are one construction with one set of classes,
 * `.sigil-table`, `-row`, `-cell` and `-head`, and a theme that restyled one
 * restyles the other. What a document adds is two things. Its cells are inline
 * markup, so each is a view: a run of words that wraps, where `table()` has a
 * string on one line. And it is narrowed to the room it has: its widest columns
 * give up width first, and their cells wrap, since a document is read in a
 * terminal rather than kept in a log. The rule under the heading is what still
 * tells it from the rows at colour level 0, where bold is gone.
 *
 * @param block - The table.
 * @param ctx - The room.
 * @returns Its tree.
 */
function tableBlock(block: Extract<MarkdownBlock, { type: 'table' }>, ctx: Context): Element {
  const columns: Column[] = block.align.map((align) => ({ align: align ?? 'left' }));
  const lines = [block.head, ...block.rows].map((row) => row.map((cell) => words(cell, ctx)));
  const natural = tableWidths(
    [],
    lines.map((row) => row.map((cell) => ({ text: '', width: Math.max(1, lineWidth(cell)) }))),
    columns,
    false
  );
  const widths = fit(natural, ctx.room - TABLE_GAP * Math.max(0, natural.length - 1));
  const line = ctx.unicode ? '─' : '-';

  const row = (cells: Word[][][], classes: string): Element =>
    tableRowView(
      cells.map((cell, i) => ({
        text: '',
        view: {
          element: flow(cell, '', JUSTIFY[block.align[i] ?? 'left'], widths[i]),
          width: widths[i],
        },
        width: widths[i],
      })),
      widths,
      columns,
      TABLE_GAP,
      classes
    );

  return box(
    { class: 'sigil-table sigil-markdown-table', 'flex-direction': 'column' },
    row(lines[0], 'sigil-table-cell sigil-table-head sigil-heading'),
    box(
      { class: 'sigil-table-row', 'column-gap': TABLE_GAP, 'flex-shrink': 0 },
      ...widths.map((w) =>
        textNode(line.repeat(w), {
          class: 'sigil-markdown-table-rule sigil-muted',
          'flex-shrink': 0,
          'white-space': 'pre',
          width: w,
        })
      )
    ),
    ...lines.slice(1).map((cells) => row(cells, 'sigil-table-cell sigil-markdown-cell'))
  );
}

/**
 * Column widths narrowed to fit, widest first.
 *
 * One column at a time from whichever is widest, so a short column keeps its
 * width and a long description gives up what the table is over by. A column is
 * never narrowed below one; a table with more columns than the room has cells
 * for runs past it, which is the one case nothing here can fix.
 *
 * @param natural - What each column would take on one line.
 * @param room - What there is for them, the gaps already taken off.
 * @returns The widths.
 */
function fit(natural: readonly number[], room: number): number[] {
  const widths = [...natural];
  let over = widths.reduce((sum, w) => sum + w, 0) - room;
  while (over > 0) {
    let widest = 0;
    for (let i = 1; i < widths.length; i++) {
      if (widths[i] > widths[widest]) {
        widest = i;
      }
    }
    if (widths[widest] <= 1) {
      break;
    }
    widths[widest]--;
    over--;
  }
  return widths;
}

/** How wide a run of words is on one line: the words, and a space between each. */
function lineWidth(lines: Word[][]): number {
  return Math.max(
    0,
    ...lines.map(
      (line) =>
        line.reduce(
          (sum, word) => sum + word.reduce((w, piece) => w + stringWidth(piece.text), 0),
          0
        ) + Math.max(0, line.length - 1)
    )
  );
}

/**
 * Inline runs as lines of words.
 *
 * A word is what sits between two spaces, and it may be in more than one style:
 * `**bold**,` is the bold word and its comma with nothing between them, which a
 * flex item per run would have put a gap into. So the runs are cut at white space
 * rather than at their own edges, and a style change inside a word is a piece of
 * that word.
 *
 * @param runs - The runs.
 * @param ctx - How links are drawn.
 * @returns The lines, which a hard break is the only thing to start.
 */
function words(runs: readonly MarkdownInline[], ctx: Context): Word[][] {
  const lines: Word[][] = [[]];
  let word: Word = [];

  const end = (): void => {
    if (word.length > 0) {
      lines.at(-1)!.push(word);
      word = [];
    }
  };

  const emit = (content: string, classes: string, href: string): void => {
    for (const part of content.split(/(\s+)/)) {
      if (part === '') {
        continue;
      }
      if (/^\s+$/.test(part)) {
        end();
        continue;
      }
      const last = word.at(-1);
      if (last && last.classes === classes && last.href === href) {
        last.text += part;
      } else {
        word.push({ classes, href, text: part });
      }
    }
  };

  const walk = (items: readonly MarkdownInline[], classes: string, href: string): void => {
    for (const run of items) {
      switch (run.type) {
        case 'text': {
          emit(run.text, classes, href);
          break;
        }
        case 'code': {
          emit(run.text, join(classes, 'sigil-markdown-code sigil-accent'), href);
          break;
        }
        case 'emphasis': {
          walk(run.children, join(classes, 'sigil-markdown-em'), href);
          break;
        }
        case 'strong': {
          walk(run.children, join(classes, 'sigil-markdown-strong'), href);
          break;
        }
        case 'strikethrough': {
          // the tildes stay, on every terminal and at every colour level: the
          // line through the words is an attribute nothing can ask a terminal
          // whether it drew, and struck-out words with no mark on them say the
          // opposite of what their author wrote. Muted, so they read as markup:
          // a struck `--flag` puts the line through its dashes, and in the text's
          // own colour the tildes beside that read as a third pair. Not inside a
          // link, for the image's reason: muted and the accent both set a colour
          const marker = join(
            classes,
            classes.includes('sigil-markdown-link')
              ? 'sigil-markdown-strike-marker'
              : 'sigil-markdown-strike-marker sigil-muted'
          );
          emit(STRIKE_MARKER, marker, href);
          walk(run.children, join(classes, 'sigil-markdown-strike'), href);
          emit(STRIKE_MARKER, marker, href);
          break;
        }
        case 'footnote': {
          // its own classes only: it is not part of a link or an emphasis it
          // sits inside, and one element carries one role
          emit(`[${run.index}]`, 'sigil-markdown-footnote-ref sigil-muted', '');
          break;
        }
        case 'link': {
          const target = linkTarget(run.href, ctx);
          walk(run.children, join(classes, 'sigil-markdown-link sigil-accent'), target.href);
          const said = markdownText(run.children).trim();
          if (target.shown !== '' && target.shown !== said) {
            // its own word, after a space, so the URL breaks onto a line of its
            // own rather than taking the last word of the link with it
            end();
            emit(`(${target.shown})`, 'sigil-markdown-url sigil-muted', '');
          }
          break;
        }
        case 'image': {
          // a terminal cannot show the picture, so its description stands in
          // for it -- linked to the picture where a link can be drawn, and in the
          // link's own style where the image is what a link is made of, which is
          // how a README's row of badges reads
          const alt = run.alt.trim() === '' ? 'image' : run.alt;
          if (href !== '' || classes.includes('sigil-markdown-link')) {
            emit(alt, classes, href);
          } else {
            emit(
              alt,
              join(classes, 'sigil-markdown-image sigil-muted'),
              linkTarget(run.src, ctx).href
            );
          }
          break;
        }
        case 'break': {
          end();
          lines.push([]);
          break;
        }
      }
    }
  };

  walk(runs, '', '');
  end();
  return lines;
}

/** Two class lists as one. */
function join(classes: string, more: string): string {
  return classes === '' ? more : `${classes} ${more}`;
}

/**
 * Where a link goes, as the two things a drawing needs: the OSC 8 target, and
 * the URL to show beside the words when there is not one.
 *
 * A fragment points into the document being read, which is not on screen as a
 * document, so it is neither. A relative path is resolved against `baseUrl` where
 * there is one and is otherwise shown and not linked: a terminal has nothing to
 * resolve it against. A URL holding a control character is neither as well,
 * because one inside an OSC sequence ends it early -- the element would refuse it,
 * and showing it would put the character on screen.
 *
 * @param href - The destination as written.
 * @param ctx - Whether to link, and what to resolve against.
 * @returns The target, `''` for none, and what to show, `''` for nothing.
 */
function linkTarget(href: string, ctx: Context): { href: string; shown: string } {
  const written = href.trim();
  if (written === '' || written.startsWith('#') || /\p{Cc}/u.test(written)) {
    return { href: '', shown: '' };
  }

  let absolute: string | undefined;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(written)) {
    absolute = written;
  } else if (ctx.baseUrl !== undefined) {
    try {
      absolute = new URL(written, ctx.baseUrl).href;
    } catch {
      absolute = undefined;
    }
  }

  if (absolute === undefined) {
    return { href: '', shown: written };
  }
  if (ctx.hyperlinks) {
    // OSC 8 carries a URI, which is printable ASCII: anything else is
    // percent-encoded, the way a browser would before it sent it
    return { href: absolute.replaceAll(/[^\x21-\x7E]+/gu, (it) => encodeURI(it)), shown: '' };
  }
  return { href: '', shown: absolute.replace(/^mailto:/i, '') };
}

/**
 * Lines of words as a block that wraps.
 *
 * Each line is a wrapping row with a column between words, which is word
 * wrapping done by the layout engine -- the same construction `paragraph()` is,
 * with words in several styles where it has a style per run.
 *
 * @param lines - The lines.
 * @param classes - What the block carries; its roles reach every word.
 * @param justify - Where a short line sits, for a table's aligned column.
 * @param room - The columns the block has, which decides whether a word fits.
 * @returns The block.
 */
function flow(
  lines: Word[][],
  classes: string,
  justify: string | undefined,
  room: number
): Element {
  const rows = lines.map((line) =>
    box(
      {
        'column-gap': 1,
        'flex-direction': 'row',
        'flex-wrap': 'wrap',
        ...(justify === undefined ? {} : { 'justify-content': justify }),
      },
      ...line.map((word) => wordView(word, room))
    )
  );

  return box({ class: classes, 'flex-direction': 'column', 'min-width': 0 }, ...rows);
}

/**
 * One word, as a text where it is in one style and a row of texts where not.
 *
 * `min-width: 0` on the text, for the reason `paragraph()` gives: a word too long
 * for the line it is alone on is broken rather than left to run off the edge.
 *
 * A word in several styles that is too long for a line wraps between its pieces,
 * which is every sentence of Chinese or Japanese: words are split at whitespace,
 * so a run with none in it is one word however long it is. Only a piece that is
 * itself wider than the line cannot wrap that way, because a row of texts breaks
 * only between them and there is no inline layout -- so the full stop after a URL
 * folded over three lines went onto a fourth line of its own. That word is made
 * **one** text, in the style of its longest piece, and only where every piece
 * links to the same place: merging a word holding a link with words that do not
 * dropped the link, and with hyperlinks on the URL is not written out either, so
 * the address was gone. It is the URL in parentheses with punctuation after it
 * that reaches the merge, and that is muted either way.
 *
 * @param word - The word.
 * @param room - The columns the line has.
 * @returns Its tree.
 */
function wordView(word: Word, room: number): Element {
  const piece = (it: Piece): Element =>
    textNode(it.text, {
      'min-width': 0,
      ...(it.classes === '' ? {} : { class: it.classes }),
      ...(it.href === '' ? {} : { href: it.href }),
    });

  if (word.length === 1) {
    return piece(word[0]);
  }

  const widths = word.map((it) => stringWidth(it.text));
  if (widths.reduce((sum, w) => sum + w, 0) <= room) {
    return box({ 'flex-direction': 'row', 'flex-shrink': 0 }, ...word.map(piece));
  }

  const widest = Math.max(...widths);
  if (widest > room && word.every((it) => it.href === word[0].href)) {
    const longest = word[widths.indexOf(widest)];
    return piece({ ...longest, text: word.map((it) => it.text).join('') });
  }
  return box({ 'flex-direction': 'row', 'flex-wrap': 'wrap', 'min-width': 0 }, ...word.map(piece));
}
