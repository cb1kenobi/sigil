/**
 * Code as highlighted lines, with an optional gutter of line numbers: what a
 * pager, a preview and a fenced block in a document all draw.
 *
 * ```js
 * import { codeView } from '@ttylabs/sigil/components/code-view';
 * import { highlightCode } from '@ttylabs/sigil/components/highlight';
 *
 * const view = codeView(source, {
 *   gutter: true,
 *   highlight: highlightCode,
 *   lang: 'ts',
 *   width: 80,
 * });
 * ```
 *
 * A line is a row, and a row is a run of fixed-width texts, one per stretch of
 * cells that share a token -- because one element resolves one style, which is
 * what `diff()` draws a highlighted line with and `markdown()` a highlighted
 * block. This module is that, written once.
 */

import {
  box,
  type Element,
  type ElementProps,
  text as textNode,
  toDisplayText,
} from '../element/index.js';
import { TOKEN_ROLE } from '../theme/index.js';
import { graphemes, stringWidth } from '../width/index.js';
import { type Highlighter, tokensOf } from './prompt.js';

/** What `codeRun()` is told about the text it draws. */
export interface CodeRunOptions {
  /** The classes the run carries before its token's. */
  class?: string;
  /**
   * The role the run draws in. Defaults to the one the token has in `TOKEN_ROLE`,
   * if any: a diff gives a context line's own so that a keyword among lines that
   * did not change is not louder than the lines that did.
   */
  role?: string;
}

/**
 * One run of cells that share a token, as a fixed-width text.
 *
 * A token carries `sigil-token` and `sigil-token-<token>` for an app's sheet, and
 * its role beside them where it has one, so the cascade decides its colour: a
 * theme reaches it, and at colour level 0 it is plain text like everything else.
 * A token with no role -- an app's own -- is the plain foreground with its class.
 *
 * @param value - What is drawn.
 * @param token - The token the cells are, or `undefined` for none.
 * @param opts - The classes before the token's, and a role to put in place of its own.
 * @returns The text.
 */
export function codeRun(
  value: string,
  token: string | undefined,
  opts: CodeRunOptions = {}
): Element {
  const classes: string[] = opts.class ? [opts.class] : [];
  if (token !== undefined) {
    classes.push('sigil-token', `sigil-token-${token}`);
  }
  const role = opts.role ?? (token === undefined ? undefined : TOKEN_ROLE.get(token));
  if (role) {
    classes.push(role);
  }
  return textNode(value, {
    class: classes.join(' '),
    'flex-shrink': 0,
    'white-space': 'pre',
    width: stringWidth(value),
  });
}

export interface CodeViewOptions {
  /**
   * The class every part is named from: `<class>` on a run, `<class>-row` on a
   * row, `<class>-gutter` on a gutter and `<class>-view` on the whole.
   * Defaults to `sigil-code`.
   */
  class?: string;
  /**
   * The number of the first line, for an excerpt. Defaults to 1. Only read where
   * there is a gutter.
   */
  firstLine?: number;
  /**
   * Whether each line is numbered, in a gutter that is as wide as the last
   * number. Defaults to `false`.
   *
   * A width with no room for a gutter and a cell of code leaves the gutter out
   * rather than the code. A line that wraps is numbered on its first row, and the
   * rows after it have a blank gutter.
   */
  gutter?: boolean;
  /**
   * Says which stretches of the code are which tokens: `highlightCode()` from
   * `@ttylabs/sigil/components/highlight` is one. Called once, with the whole
   * text, so a block comment that begins on one line and ends on another is one
   * span. A hook that throws throws out of `codeView()`, a span out of range is
   * clipped, and a token no class can carry is refused with a `PromptError` --
   * `diff()`'s three answers.
   */
  highlight?: Highlighter;
  /** The language, handed to `highlight` as its second argument. */
  lang?: string;
  /**
   * The class a run with no token carries beside `class`, for an app that wants
   * the code it did not highlight drawn in a role. Defaults to none: the plain
   * foreground.
   */
  plain?: string;
  /** Properties for the box the rows are in. */
  props?: ElementProps;
  /**
   * How many columns a tab goes to the next multiple of. Defaults to 4. A tab is
   * drawn as spaces, since a terminal has no tab stops of its own to count on.
   */
  tabSize?: number;
  /**
   * The token of each code unit of the text, where the caller already has them.
   * Takes the place of `highlight`.
   */
  tokens?: readonly (string | undefined)[];
  /** The columns the view is drawn in, the gutter included. */
  width: number;
  /**
   * What a line too long for the width does. `'cut'` ends it at the edge, as a
   * pager shows code; `'fold'` carries it onto the next row at a grapheme
   * boundary. Defaults to `'cut'`.
   */
  wrap?: 'cut' | 'fold';
}

/** A stretch of one row that is the same token. */
interface Run {
  text: string;
  token: string | undefined;
}

/**
 * Highlighted code as rows, a row for each line the text has.
 *
 * Lines are split at `\n`, and a cluster takes the token of the code unit it
 * starts at, which is `diff()`'s rule: a span that ends inside a cluster cannot
 * colour half of one cell. A control character is drawn as `toDisplayText()` says
 * a `text` would, so what is measured is what is drawn. An empty line keeps its
 * row, with an empty text in it, since a row with nothing in it has no height.
 *
 * A cluster wider than the room is dropped when cutting and alone on a row when
 * folding, since a character that cannot fit anywhere is better drawn clipped
 * than not at all.
 *
 * @param code - The code.
 * @param opts - The room, the tokens, and the gutter.
 * @returns The tree: a column of rows.
 * @throws {PromptError} When `highlight` names a token no class can carry.
 */
export function codeView(code: string, opts: CodeViewOptions): Element {
  const base = opts.class ?? 'sigil-code';
  const tokens =
    opts.tokens ?? (opts.highlight ? tokensOf(code, opts.highlight(code, opts.lang)) : undefined);
  const tab = Math.max(1, Math.floor(opts.tabSize ?? 4) || 4);
  const fold = opts.wrap === 'fold';
  const width = Math.max(1, Math.floor(opts.width) || 1);
  const lines = code.split('\n');
  const first = Math.floor(opts.firstLine ?? 1) || 1;
  const digits = String(first + lines.length - 1).length;
  const gutter = opts.gutter && width > digits + 1 ? digits : 0;
  const room = Math.max(1, width - (gutter > 0 ? gutter + 1 : 0));

  const rows: Element[] = [];
  let offset = 0;
  lines.forEach((line, n) => {
    const lineRows: Run[][] = [[]];
    let column = 0;
    let at = offset;
    for (const cluster of graphemes(line)) {
      const token = tokens?.[at];
      at += cluster.length;
      const drawn = (): string =>
        cluster === '\t' ? ' '.repeat(tab - (column % tab)) : toDisplayText(cluster);
      let shown = drawn();
      if (column + stringWidth(shown) > room) {
        if (!fold) {
          break;
        }
        if (column > 0) {
          lineRows.push([]);
          column = 0;
          shown = drawn();
        }
      }
      column += stringWidth(shown);
      const row = lineRows.at(-1)!;
      const last = row.at(-1);
      if (last && last.token === token) {
        last.text += shown;
      } else {
        row.push({ text: shown, token });
      }
    }
    offset += line.length + 1;

    lineRows.forEach((runs, index) => {
      if (runs.length === 0) {
        // an empty text, so an empty line keeps its row
        runs.push({ text: '', token: undefined });
      }
      rows.push(
        box(
          { class: `${base}-row`, 'flex-direction': 'row', 'flex-shrink': 0 },
          ...(gutter > 0
            ? [
                textNode(index === 0 ? String(first + n).padStart(gutter) : ' '.repeat(gutter), {
                  class: `${base}-gutter sigil-muted`,
                  'flex-shrink': 0,
                  'margin-right': 1,
                  'white-space': 'pre',
                  width: gutter,
                }),
              ]
            : []),
          ...runs.map(({ text, token }) =>
            codeRun(text, token, {
              class: token === undefined && opts.plain ? `${base} ${opts.plain}` : base,
            })
          )
        )
      );
    });
  });

  return box({ class: `${base}-view`, 'flex-direction': 'column', ...opts.props }, ...rows);
}
