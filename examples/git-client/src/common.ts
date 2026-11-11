/**
 * What the two root components share besides the model: the sheet, and the
 * classes a row's letters are drawn in.
 *
 * Its own module rather than exported from `root.tsx`, because the `ui` twin
 * runs unbuilt: Node strips types and does not compile JSX, so a `.tsx` import
 * anywhere in its graph is a module Node cannot load.
 */

import type { FileChange } from './parse.ts';

/**
 * The layout, and the one colour the framework's roles do not give: the border
 * of the pane that has the focus. Every other colour is a role class
 * (`sigil-success`, `sigil-muted`, ...), so a theme restyles the rest.
 */
export const stylesheet = `
  /* runApp() lets the root shrink to the screen */
  .app { flex-direction: column; flex-grow: 1 }
  .main { flex-direction: row; flex-grow: 1; min-height: 0 }
  .side { flex-direction: column; flex-grow: 1; min-width: 0 }
  .files { flex-grow: 2; flex-basis: 0; min-height: 4 }
  .branches, .commits { flex-grow: 1; flex-basis: 0; min-height: 4 }
  .diff { flex-grow: 1; min-width: 0 }
  .list { flex-grow: 1; min-height: 0 }
  .row { flex-direction: row; column-gap: 1 }
  .letters { flex-direction: row; flex-shrink: 0 }
  .letter { width: 1; white-space: pre }
  .grow { flex-grow: 1; min-width: 0; white-space: nowrap; text-overflow: ellipsis }
  .fixed { flex-shrink: 0 }
  .footer { flex-direction: row; height: 1; padding-left: 1; column-gap: 2 }
  /* where HEAD is says more than the last key listed, so it keeps its width */
  .status { flex-shrink: 0 }
  /* the pane with the focus, which a panel cannot see for itself: there is no
     :focus-within, so the model puts this class on it */
  .is-active { border-color: green }
`;

/**
 * The classes a file's two letters are drawn in, as `git status` colours them:
 * what is staged in the success role, what is not in the error role.
 *
 * @param file - The file.
 * @returns A class for the index letter and one for the working tree's.
 */
export function letterClasses(file: FileChange): { index: string; worktree: string } {
  if (file.conflicted) {
    return { index: 'letter sigil-warn', worktree: 'letter sigil-warn' };
  }
  if (file.untracked) {
    return { index: 'letter sigil-error', worktree: 'letter sigil-error' };
  }
  return { index: 'letter sigil-success', worktree: 'letter sigil-error' };
}
