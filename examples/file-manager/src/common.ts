/**
 * What the two root components share besides the model: the sheet, and how a
 * name is drawn in a column.
 *
 * Its own module rather than exported from `root.tsx`, because the `ui` twin
 * runs unbuilt: Node strips types and does not compile JSX, so a `.tsx` import
 * anywhere in its graph is a module Node cannot load.
 */

import { type Entry, printable } from './files.ts';

/**
 * The layout, and the one colour the framework's roles do not give: the border
 * of the column that has the focus. Every other colour is a role class
 * (`sigil-info`, `sigil-muted`, ...), so a theme restyles the rest.
 *
 * The three columns share the width one to two to three, which is the Miller
 * column proportion: the directory above is context, the one the manager is in is
 * where the work is, and a preview wants the most room.
 */
export const stylesheet = `
  /* runApp() lets the root shrink to the screen */
  .app { flex-direction: column; flex-grow: 1 }
  .header { flex-direction: row; height: 1; padding: 0 1; column-gap: 2 }
  /* a long path is what gives way, from its end */
  .path { flex-shrink: 1; min-width: 0; white-space: nowrap; text-overflow: ellipsis }
  .spacer { flex-grow: 1 }
  .flags { flex-shrink: 0; white-space: nowrap }
  .columns { flex-direction: row; flex-grow: 1; min-height: 0 }
  .parent { flex-grow: 1; flex-basis: 0; min-width: 0 }
  .current { flex-grow: 2; flex-basis: 0; min-width: 0 }
  .preview { flex-grow: 3; flex-basis: 0; min-width: 0 }
  .list { flex-grow: 1; min-height: 0 }
  .row { flex-direction: row; column-gap: 1 }
  .name { flex-grow: 1; min-width: 0; white-space: nowrap; text-overflow: ellipsis }
  .size { flex-shrink: 0 }
  .filter-bar { flex-direction: row; height: 1; padding: 0 1; column-gap: 1 }
  .filter-label { flex-shrink: 0 }
  .footer { flex-direction: row; height: 1; padding-left: 1; column-gap: 2 }
  /* what just happened says more than the last key listed, so it keeps its width */
  .status { flex-shrink: 0 }
  /* the column with the focus, which a panel cannot see for itself: there is no
     :focus-within, so the model puts this class on it */
  .is-active { border-color: green }
`;

/**
 * The classes a name is drawn in, in a column and in a directory's preview: a
 * directory in the info role, a link in the accent role, anything that is neither
 * file nor directory in the warning role. A name a theme does not colour is the
 * plain foreground, and the `/` after a directory is what says it at colour level 0.
 *
 * @param entry - The entry.
 * @returns The classes.
 */
export function entryClass(entry: Entry): string {
  if (entry.link) {
    return 'entry-link sigil-accent';
  }
  if (entry.kind === 'directory') {
    return 'entry-dir sigil-info';
  }
  return entry.kind === 'other' ? 'entry-other sigil-warn' : 'entry-file';
}

/**
 * A name as a column draws it: safe to draw, and with a `/` after a directory,
 * which is what tells one from a file at colour level 0.
 *
 * @param entry - The entry.
 * @returns The label.
 */
export function entryLabel(entry: Entry): string {
  return `${printable(entry.name)}${entry.kind === 'directory' ? '/' : ''}`;
}
