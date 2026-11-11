/**
 * What the two root components share besides the browser itself: the stylesheet.
 *
 * Its own module rather than exported from `root.tsx`, because the `ui` twin
 * runs unbuilt: Node strips types and does not compile JSX, so a `.tsx` import
 * anywhere in its graph is a module Node cannot load.
 */

/**
 * The layout, and no colour: every colour is a role class (`sigil-error`,
 * `sigil-muted`, ...), so a theme restyles the whole screen.
 */
export const stylesheet = `
  .app { flex-direction: column; flex-grow: 1 }
  .header { flex-direction: row; height: 1; padding: 0 1; column-gap: 2 }
  .header text { white-space: nowrap; flex-shrink: 0 }
  .brand { font-weight: bold }
  /* a long file path is what gives way, from its end */
  .header .context { flex-shrink: 1; min-width: 0 }
  .spacer { flex-grow: 1 }
  .prompt { flex-direction: row; height: 1; padding: 0 1; column-gap: 1 }
  .prompt-label { flex-shrink: 0 }
  .hint { flex-shrink: 0 }
  .view { flex-direction: column; flex-grow: 1; min-height: 0 }
  .grow { flex-grow: 1; min-height: 0 }
  .log-line { flex-direction: row }
  .log-line text { white-space: nowrap; flex-shrink: 0 }
  .match { inverse: true }
  .footer { flex-direction: row; height: 1; padding-left: 1; column-gap: 2 }
  /* the status says what just happened, so it keeps its width and the key help
     beside it takes what is left */
  .status { flex-shrink: 0 }
`;
