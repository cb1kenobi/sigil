/**
 * The brand's colours, for the places CSS cannot reach: an `ImageResponse`
 * (satori has no cascade and no `var()`), a PNG, a standalone SVG.
 *
 * `globals.css` is where a colour is declared. These are copies of five of its
 * tokens, named for the token they copy, and `test/brand-assets.test.ts` reads
 * the stylesheet and fails if one of them has moved on its own.
 */

/** `--color-bg`: the page, and the social card. */
export const BG = '#131218';

/** `--color-terminal`: the ground under the avatar and the app icons. */
export const ICON_GROUND = '#0c0b10';

/** `--color-brand`: the seal. */
export const BRAND = '#7656db';

/** `--color-fg-strong`: the wordmark on a dark ground. */
export const FG_STRONG = '#f4f2f8';

/** `--color-fg`: the social cards' dots, at an alpha. */
export const FG = '#edebf3';

/** `--color-muted`: secondary text on the card. */
export const MUTED = '#a19eac';

/**
 * The wordmark on a light ground (GitHub's light README, `#f6f5f9`). The site
 * has no light theme, so this is not a token; it is SIG-102's value for it.
 */
export const INK = '#17161d';
