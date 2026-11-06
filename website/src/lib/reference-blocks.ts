import { textOf } from './markdown-doc.ts';
import { tables } from './reference-options.ts';
import type { Root } from 'mdast';

/**
 * How a command reference page's blocks are drawn, decided from the generated
 * markdown on the way through.
 *
 * `sigil reference` writes plain markdown that reads well on GitHub: the usage
 * line is an untagged fence and the argument and option lists are GFM tables.
 * The site draws them in its own blocks without the generator knowing about
 * the site, which is what keeps the committed pages, and the drift test in
 * `packages/cli/test/command-surface.test.ts` over them, as they are.
 */

/**
 * Makes the usage line a terminal block with no working directory.
 *
 * The fence directly under `## Usage` with no language becomes ```` ```sh
 * cwd="" ````, which `readFence()` reads as a script with an empty title bar:
 * a usage line is something to type, and it was typed in no directory in
 * particular, so a `~` over it would say something untrue. A fence that already
 * names a language is the author's and is left alone.
 *
 * @returns The transform.
 */
export function remarkUsageTerminal() {
  return (tree: Root) => {
    tree.children.forEach((node, at) => {
      const before = tree.children[at - 1];

      if (
        node.type === 'code' &&
        !node.lang &&
        before?.type === 'heading' &&
        before.depth === 2 &&
        textOf(before).trim() === 'Usage'
      ) {
        node.lang = 'sh';
        node.meta = 'cwd=""';
      }
    });
  };
}

/** The headers of a column that names things: an argument, an option, a command. */
const NAME_COLUMNS = new Set(['Argument', 'Command', 'Option']);

/** The class a body cell of each kind of column is given. */
export const NAME_CELL = 'ref-name';
export const TYPE_CELL = 'ref-type';

/**
 * Marks the columns of a reference table that are names and types.
 *
 * The table's own header row says which is which -- `Argument`, `Option` or
 * `Command` for the first, `Type` for the second -- so a table the generator
 * grows a column in is still read right, and a table that is none of these is
 * left as a plain docs table. The classes are what `globals.css` draws: a name
 * in the mono face and a type in `syn-keyword`, both without the inline-code
 * chip, which on every row of a table is a column of boxes.
 *
 * @returns The transform.
 */
export function remarkReferenceTables() {
  return (tree: Root) => {
    for (const table of tables(tree)) {
      const columns = (table.children[0]?.children ?? []).map((cell) => {
        const header = textOf(cell).trim();
        return NAME_COLUMNS.has(header) ? NAME_CELL : header === 'Type' ? TYPE_CELL : undefined;
      });

      for (const row of table.children.slice(1)) {
        row.children.forEach((cell, at) => {
          const name = columns[at];

          if (name) {
            cell.data = {
              ...cell.data,
              hProperties: { ...cell.data?.hProperties, className: [name] },
            };
          }
        });
      }
    }
  };
}
