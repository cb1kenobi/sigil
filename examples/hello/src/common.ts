/**
 * What hello's two root components share, which is everything but the syntax.
 *
 * Its own module rather than exported from `root.tsx`, because the `ui` twin
 * runs unbuilt: Node strips types and does not compile JSX, so a `.tsx` import
 * anywhere in its graph is a module Node cannot load.
 */

/** The rows. */
export const ITEMS: readonly string[] = ['parser', 'canvas', 'layout'];

/** The app's own sheet, over the framework's. */
export const stylesheet = `
  .app { flex-direction: column; flex-grow: 1; border: round; border-color: gray; padding: 0 1 }
  .title { font-weight: bold }
  .hint { color: gray }
  .rows { flex-direction: column; flex-grow: 1; margin-top: 1 }
  .row { flex-direction: row; padding: 0 1 }
  .row:focus { background-color: blue; color: white }
  .name { flex-grow: 1 }
  .status { color: gray }
`;
