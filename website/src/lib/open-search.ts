/**
 * Opens the site search dialog.
 *
 * **A seam, and a no-op until SIG-254 lands.** The header and the phone menu
 * render the search trigger (SIG-257) and call this when it is pressed; the
 * dialog, its index and its keyboard shortcut are SIG-254's. That ticket
 * replaces this body with the call that shows its dialog and nothing else here
 * should need to change.
 */
export function openSearch(): void {
  // Intentionally empty.
}
