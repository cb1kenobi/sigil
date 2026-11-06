import { textOf } from './markdown-doc.ts';
import type { Root, RootContent, Table, TableRow } from 'mdast';

/**
 * The options of a command reference page, and the anchor each one is drawn with.
 *
 * `sigil reference` writes a command's options as a GFM table whose first
 * column is the option's format in a code span -- `` `--out [dir]` ``,
 * `` `-y, --yes` `` -- so the table is the one place on the page an option is
 * named. Search (SIG-254) indexes one record per option, and a record is
 * identified by its URL, so each option needs an address of its own: this gives
 * the row an `id`, and the indexer links to it. Both go through `optionRows()`,
 * so the indexer cannot name an anchor the page does not draw.
 *
 * The generated markdown is left as it is. The anchor is the site's concern,
 * and a reader of the file on GitHub gets the table it always had.
 */

/** One option, as its row of the table names it. */
export interface OptionRow {
  /**
   * The spelling the option is known by: its long name, else its short one.
   * `--out`. It is also the row's anchor, `/reference/build#--out`, which reads
   * as the option and cannot meet a heading's: a heading that slugs to `--out`
   * would have to be written `--out`, and a reference page's headings are Usage,
   * Arguments, Options and Subcommands.
   */
  readonly name: string;
  /** Any other spelling the format declares. `-y` beside `--yes`. */
  readonly aliases: readonly string[];
  /** The format exactly as the table gives it. `--out [dir]`. */
  readonly format: string;
  /** The type column, `string` or `bool`. */
  readonly type: string;
  /** The description column, as plain text. */
  readonly description: string;
  /** The row in the tree, for anything that decorates it. */
  readonly node: TableRow;
}

/**
 * The spellings a format declares: every comma or space separated part that
 * starts with a dash. `[dir]` and `<value>` are what it takes, not names.
 *
 * @param format - `--out [dir]`, `-y, --yes`.
 * @returns The name it is known by and the rest.
 */
export function optionNames(format: string): { name: string; aliases: string[] } | undefined {
  const spellings = format.split(/[\s,]+/u).filter((part) => /^-{1,2}[^-\s]/u.test(part));
  const name = spellings.find((part) => part.startsWith('--')) ?? spellings[0];

  return name === undefined
    ? undefined
    : { name, aliases: spellings.filter((part) => part !== name) };
}

/** Whether a table is a list of options: its first header cell says `Option`. */
function isOptionTable(table: Table): boolean {
  const head = table.children[0]?.children[0];
  return head !== undefined && textOf(head).trim() === 'Option';
}

/** The tables of a tree, wherever they sit. */
export function tables(node: Root | RootContent, found: Table[] = []): Table[] {
  if (node.type === 'table') {
    found.push(node);
  } else if ('children' in node) {
    for (const child of node.children) {
      tables(child, found);
    }
  }
  return found;
}

/**
 * Every option a page lists, in the order it lists them.
 *
 * A row whose first cell is not a code span holding a dash is skipped rather
 * than guessed at: that is a table this did not expect, and an anchor made from
 * prose would be one nobody links to.
 *
 * @param tree - A parsed reference page.
 * @returns The options.
 */
export function optionRows(tree: Root): OptionRow[] {
  const rows: OptionRow[] = [];

  for (const table of tables(tree).filter(isOptionTable)) {
    for (const row of table.children.slice(1)) {
      const [first, type, description] = row.children;
      const code = first?.children[0];

      if (code?.type !== 'inlineCode') {
        continue;
      }

      const names = optionNames(code.value);
      if (!names) {
        continue;
      }

      rows.push({
        ...names,
        format: code.value,
        type: type ? textOf(type).trim() : '',
        description: description ? textOf(description).replace(/\s+/gu, ' ').trim() : '',
        node: row,
      });
    }
  }

  return rows;
}

/**
 * Gives every option row its anchor, as `id`.
 *
 * A remark plugin for the reason `remarkDocPage()` is one: the id is settled
 * from the source before anything is drawn. `scroll-mt-24` is the room a jump
 * leaves under the sticky header, as the headings have, and `target:` marks
 * the row a search result landed on.
 *
 * @returns The transform.
 */
export function remarkOptionAnchors() {
  return (tree: Root) => {
    for (const row of optionRows(tree)) {
      row.node.data = {
        ...row.node.data,
        hProperties: {
          ...row.node.data?.hProperties,
          id: row.name,
          className: ['scroll-mt-24', 'target:bg-brand/15'],
        },
      };
    }
  };
}
