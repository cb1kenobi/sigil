/**
 * A `raw` element's measure, for one that takes no room of its own.
 *
 * What the scroll box's track and thumb and the pane's edge are: `position:
 * absolute` with its rectangle given by its insets, so what it would measure to
 * is never asked for a size. Both had written it (SIG-366). A leaf, so that a
 * pane does not load the scroll box for it; it is published from
 * `@ttylabs/sigil/components/scroll-box`.
 *
 * @returns No width and no height.
 */
export function noSize(): { height: number; width: number } {
  return { height: 0, width: 0 };
}
