/**
 * Opens the site search dialog.
 *
 * The header, the phone menu and the 404 render the search trigger (SIG-257)
 * and call this when it is pressed; the dialog (SIG-254, `site-search.tsx`) is
 * mounted once in the root layout and registers how to open itself here when it
 * mounts. A module-level slot rather than a context, so a caller needs nothing
 * but this import and can sit anywhere in the tree, the 404 included.
 *
 * Before the dialog has mounted -- a press during hydration -- this does
 * nothing, which is what the button did before it was wired up at all.
 */

let opener: (() => void) | undefined;

export function openSearch(): void {
  opener?.();
}

/**
 * Says how to open the dialog. Only the dialog calls it.
 *
 * @param open - Shows the dialog.
 * @returns What takes it back off again, for the effect's cleanup.
 */
export function registerSearch(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) {
      opener = undefined;
    }
  };
}
