/**
 * The characters a terminal block draws that the latin subset of JetBrains Mono
 * does not carry.
 *
 * The latin file is what every page's copy needs, and it has no box drawing, no
 * block elements and no geometric shapes -- so a terminal's `╭─╮`, a progress
 * bar's `█░` and a half-block banner's `▀▄` fell through the font stack to
 * whatever came next. What came next was `next/font`'s metric fallback, which is
 * **Arial scaled to 131%**: a proportional face at the wrong size, so the rows of
 * a banner stopped lining up with each other, which is the whole of what a
 * banner is.
 *
 * `scripts/fetch-fonts.ts` asks Google Fonts for a JetBrains Mono holding these
 * ranges and nothing else (its `text=` parameter), and `layout.tsx` declares it
 * with this `unicode-range`, ahead of the latin face in `--font-mono`, so that it
 * draws these characters and nothing else.
 *
 * What JetBrains Mono does not have, it cannot supply. It has no `✔ ✖ ℹ` and no
 * Braille, upstream or on Google Fonts -- checked against both cmaps -- so a
 * status glyph and a spinner frame still come from the system's symbol font.
 * Those sit one to a line at its start, where a fallback's different advance
 * moves the rest of that one line a fraction; it is a run of rows that has to
 * share a grid, and every glyph such a run is drawn with is here.
 */
export const TERMINAL_GLYPHS: readonly (readonly [number, number])[] = [
  // Arrows: `↑↓ move`, `→`
  [0x2190, 0x21ff],
  // Box Drawing: borders, tables, trees
  [0x2500, 0x257f],
  // Block Elements: bars, banners, QR codes, large text
  [0x2580, 0x259f],
  // Geometric Shapes: `◆ ◇ ● ○ ▲ ▶ ◼ ◻`
  [0x25a0, 0x25ff],
  // `⚠`, the log's warning
  [0x26a0, 0x26a0],
  // `❯`, a prompt's pointer
  [0x276f, 0x276f],
];

/**
 * The ranges as a CSS `unicode-range`.
 *
 * `layout.tsx` cannot call this -- a `next/font` option has to be a literal the
 * compiler can read -- so it writes the value out, and `test/fonts.test.ts`
 * holds the two equal.
 *
 * @returns The descriptor's value.
 */
export function unicodeRange(): string {
  const hex = (n: number) => n.toString(16).toUpperCase();
  return TERMINAL_GLYPHS.map(([from, to]) =>
    from === to ? `U+${hex(from)}` : `U+${hex(from)}-${hex(to)}`
  ).join(', ');
}

/**
 * Every character in the ranges, which is what `fetch-fonts.ts` asks for.
 *
 * @returns The characters.
 */
export function terminalText(): string {
  return TERMINAL_GLYPHS.flatMap(([from, to]) =>
    Array.from({ length: to - from + 1 }, (_, at) => String.fromCodePoint(from + at))
  ).join('');
}
