/**
 * Verifies every text/background token pairing in globals.css against WCAG AA.
 * Parses the shipped CSS rather than a duplicate table, so it cannot drift from
 * what is actually deployed.
 *
 * The site is dark only, so there is one palette to check and not two.
 *
 *   node scripts/check-contrast.ts
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CSS = fileURLToPath(new URL('../src/app/globals.css', import.meta.url));

type Rgb = [number, number, number];
type Tokens = Record<string, Rgb | { rgb: Rgb; alpha: number }>;

/** Reads every `--color-name: #hex;` and `--color-name: rgb(r g b / a);` out of the CSS. */
function colors(css: string): Tokens {
  const tokens: Tokens = {};
  for (const [, k, hex] of css.matchAll(/--color-([\w-]+):\s*#([0-9A-Fa-f]{6});/g)) {
    tokens[k] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
  }
  for (const [, k, r, g, b, a] of css.matchAll(
    /--color-([\w-]+):\s*rgb\((\d+) (\d+) (\d+) \/ ([\d.]+)\);/g
  )) {
    tokens[k] = { rgb: [+r, +g, +b], alpha: +a };
  }
  return tokens;
}

/** Composites a translucent token over an opaque one, as the browser paints it. */
function over(top: Tokens[string], under: Rgb): Rgb {
  if (Array.isArray(top)) return top;
  return top.rgb.map((c, i) => c * top.alpha + under[i] * (1 - top.alpha)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const ch = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const TEXT = 4.5;
/** Large text (WCAG 1.4.3) and the parts of a control that identify it (1.4.11). */
const LARGE_OR_UI = 3;

/**
 * Every pair a token is meant for, as [foreground, background, minimum ratio].
 *
 * A token can be written as `name` or as `name@under`, for a translucent token
 * that is composited over another one before it is measured: the "Accessible"
 * badge is text on a fill that is 14% green over whatever it sits on.
 */
const PAIRS: [string, string, number][] = [
  // Default text, on every surface a page is built from.
  ...['bg', 'band', 'surface', 'surface-2', 'footer'].map((bg): [string, string, number] => [
    'fg',
    bg,
    TEXT,
  ]),
  ['fg-strong', 'bg', TEXT],
  ['fg-strong', 'surface', TEXT],
  // Bold terminal text.
  ['fg-strong', 'terminal', TEXT],
  // Body copy.
  ['fg-body', 'bg', TEXT],
  ['fg-body', 'band', TEXT],
  ['fg-body', 'surface', TEXT],
  ['fg-body', 'footer', TEXT],
  // Source code, and inline code on `surface-2`.
  ['fg-code', 'surface', TEXT],
  ['fg-code', 'surface-2', TEXT],
  ['fg-term', 'terminal', TEXT],
  // Secondary text, eyebrows and captions.
  ['muted', 'bg', TEXT],
  ['muted', 'band', TEXT],
  ['muted', 'surface', TEXT],
  ['muted', 'surface-2', TEXT],
  ['muted', 'table-head', TEXT],
  ['muted', 'chip', TEXT],
  ['muted', 'footer', TEXT],
  // Terminal dim text, sidebar section labels.
  ['dim', 'terminal', TEXT],
  ['dim', 'bg', TEXT],
  ['dim', 'band', TEXT],
  // Links, active nav, tag markers.
  ['link', 'bg', TEXT],
  ['link', 'band', TEXT],
  ['link', 'surface', TEXT],
  ['link', 'surface-2', TEXT],
  ['link', 'footer', TEXT],
  ['link', 'chip', TEXT],
  // Primary buttons and the active segment.
  ['brand-fg', 'brand', TEXT],
  // Terminal glyphs and statuses.
  ['term-accent', 'terminal', TEXT],
  ['term-green', 'terminal', TEXT],
  ['term-yellow', 'terminal', TEXT],
  ['term-red', 'terminal', TEXT],
  ['term-blue', 'terminal', TEXT],
  ['term-select-fg', 'term-select', TEXT],
  // A terminal colour used as a fill, with the terminal's own background as the
  // text: what \`src/lib/sgr.ts\` draws for an inverted blue and for a background
  // colour a program set with no foreground of its own.
  ...[
    'term-blue',
    'term-red',
    'term-green',
    'term-yellow',
    'term-accent',
    'fg-term',
    'fg-strong',
  ].map((fill): [string, string, number] => ['terminal', fill, TEXT]),
  // Syntax, on the source-code panel.
  ['syn-keyword', 'surface', TEXT],
  ['syn-string', 'surface', TEXT],
  ['syn-function', 'surface', TEXT],
  ['syn-number', 'surface', TEXT],
  ['syn-comment', 'surface', TEXT],
  // ... and in a terminal.
  ['syn-keyword', 'terminal', TEXT],
  ['syn-string', 'terminal', TEXT],
  ['syn-function', 'terminal', TEXT],
  ['syn-number', 'terminal', TEXT],
  ['syn-comment', 'terminal', TEXT],
  // Badges: bold white text on each fill.
  ['brand-fg', 'badge-pass', TEXT],
  ['brand-fg', 'badge-fail', TEXT],
  ['brand-fg', 'badge-beta', TEXT],
  ['badge-a11y-fg', 'badge-a11y@bg', TEXT],
  ['badge-a11y-fg', 'badge-a11y@surface', TEXT],
  // Non-text (WCAG 1.4.11): the focus ring, and the fill of a primary button.
  ['link', 'bg', LARGE_OR_UI],
  ['link', 'surface', LARGE_OR_UI],
  ['brand', 'bg', LARGE_OR_UI],
];

/**
 * Control borders, which are the other half of 1.4.11 and are **advisory**.
 *
 * The criterion asks for 3:1 from a component's boundary only where the
 * boundary is what identifies it. A button or a tag carries a text label that
 * does the identifying, and an input without a visible boundary is the case
 * the criterion exists for, so which of these is binding is a call about each
 * use and not about the token. These values are the design's, so a miss is
 * printed and is not a failure: the numbers are here so that the call is made
 * with them in front of somebody.
 */
const BORDERS: [string, string, number][] = [
  ['line-input', 'bg', LARGE_OR_UI],
  ['line-strong', 'bg', LARGE_OR_UI],
  ['line-strong', 'surface', LARGE_OR_UI],
  ['line-tag', 'chip', LARGE_OR_UI],
];

const tokens = colors(readFileSync(CSS, 'utf8'));

/** Resolves `name` or `name@under` to a colour the browser would paint. */
function resolve(spec: string, over_?: string): Rgb | undefined {
  const [name, under] = spec.split('@');
  const token = tokens[name];
  if (!token) return undefined;
  if (Array.isArray(token)) return token;
  const base = tokens[under ?? over_ ?? ''];
  return Array.isArray(base) ? over(token, base) : undefined;
}

let failed = 0;
let advised = 0;
for (const [fg, bg, min, advisory] of [
  ...PAIRS.map((p) => [...p, false] as const),
  ...BORDERS.map((p) => [...p, true] as const),
]) {
  const label = `${fg} on ${bg}`.padEnd(38);
  const b = resolve(bg);
  const f = b && resolve(fg);
  if (!b || !f) {
    console.log(`  MISSING  ${label}`);
    failed++;
    continue;
  }
  const ratio = contrast(f, b);
  const ok = ratio >= min;
  if (!ok && advisory) advised++;
  if (!ok && !advisory) failed++;
  const verdict = ok ? 'pass' : advisory ? 'warn' : 'FAIL';
  console.log(`  ${verdict}  ${label} ${ratio.toFixed(2)}:1  (min ${min})`);
}

if (advised) {
  console.log(`\n${advised} advisory border pairing(s) below 3:1; see BORDERS.`);
}
console.log(
  failed === 0
    ? '\nAll pairings meet their contrast target.'
    : `\n${failed} pairing(s) below target.`
);
process.exit(failed === 0 ? 0 : 1);
