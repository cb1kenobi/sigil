# @ttylabs/screenshot

Screenshots of a [sigil](https://github.com/cb1kenobi/sigil) canvas, as SVG or
PNG — for a README, the docs, a bug report, or a visual regression test.

```sh
npm install @ttylabs/screenshot
```

```js
import { screenshot } from '@ttylabs/screenshot';
import { writeFileSync } from 'node:fs';

canvas.present();
writeFileSync('frame.svg', screenshot(canvas.snapshot()));
writeFileSync('frame.png', screenshot(canvas.snapshot(), { format: 'png', scale: 2 }));
```

`screenshot()` is synchronous and returns a string for SVG and the bytes for a
PNG. `await` on it is harmless.

## Why a package of its own

The fonts and the rasterizer are about two megabytes together, and an app that
never takes a screenshot should pay nothing for them — the reasoning
[`@ttylabs/config-xml`](../config-xml) and [`@ttylabs/config-yaml`](../config-yaml)
follow, for the same constraint. It depends on `@ttylabs/sigil` and nothing else:
the TrueType parser and the rasterizer are written here, and the PNG encoder is
`@ttylabs/sigil/png`.

## What it takes

- **`canvas.snapshot()`** — the frame that is on screen. A snapshot is bound to
  the style table that painted it, so every cell says what it looks like and
  nothing else has to be passed.
- **A testing `Screen`** from `@ttylabs/sigil/testing`, so a test can save the
  frame it asserted on. The screen model keeps characters and no styling, so it
  is drawn in the default colours.
- **Any other `CellBuffer`**, with the `StyleTable` it was painted through as
  `styles`. A grid that cannot say what its styles are is refused, rather than
  drawn in somebody else's colours.

A snapshot is of what was **presented**. A canvas behind a backend with no
terminal — a pipe, CI — never presents, so its snapshot is blank. Take the
screenshot of a canvas you presented yourself (a canvas built just to be
photographed can call `present()` and throw the bytes away), or of the testing
screen.

## Options

| Option        | Default           | What it does                                                                       |
| ------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `format`      | `'svg'`           | `'svg'` or `'png'`                                                                 |
| `fg`, `bg`    | see below         | The default foreground and background: `'#rrggbb'`, `'#rgb'` or `{ r, g, b }`      |
| `palette`     | see below         | Palette entries 0–15; a hole falls through                                         |
| `terminal`    | none              | What the terminal reported — `view.detect()`'s result                              |
| `colorScheme` | resolved          | Which built-in palette fills what nothing else answered                            |
| `font`        | JetBrains Mono    | A path, a `file:` URL, bytes, or `{ regular, bold, italic, boldItalic, fallback }` |
| `fontSize`    | `14`              | CSS pixels                                                                         |
| `lineHeight`  | the font's        | The cell height, as a multiple of the font size                                    |
| `scale`       | `1`               | Device pixels per CSS pixel: `2` is a high-DPI image                               |
| `padding`     | `0`               | Space around the grid, in CSS pixels, in the background colour                     |
| `fontFamily`  | a monospace stack | SVG only: the CSS font stack the text is set in                                    |
| `styles`      | none              | The `StyleTable` for a grid `canvas.snapshot()` did not make                       |
| `env`         | `process.env`     | Where `SIGIL_COLOR_SCHEME` and `COLORFGBG` are read                                |

## Colours

The theme sets no root foreground or background, and every colour a stylesheet
gives an element is already baked into the cells. So a screenshot supplies only
what the terminal would decide: the default foreground and background, and what
palette entries 0–15 look like. Entries 16–255 are the xterm cube and grey ramp,
fixed by the spec.

Each of those is decided on its own, highest first:

1. **The options**: `fg`, `bg`, `palette`.
2. **What the terminal reported**, passed as `terminal`.
3. **A built-in palette** for the resolved colour scheme, dark or light.

The scheme is resolved the way a renderer resolves it: `colorScheme`, then
`SIGIL_COLOR_SCHEME`, then the terminal's report, then `COLORFGBG`, then dark. So
a frame themed light is drawn over the light defaults.

To make a screenshot look like the terminal it was taken in, ask it:

```js
const terminal = await view.detect(input, { background: true, foreground: true, palette: true });
const png = screenshot(canvas.snapshot(), { format: 'png', terminal });
```

`foreground` asks with OSC 10, `background` with OSC 11, and `palette` with one
OSC 4 query per entry — all in the one batched round trip `detect()` already
makes. Leave `terminal` out, and pass `env: {}`, and a screenshot taken in CI is
the same every time.

## SVG

No rasterizer: the text is `<text>` in a monospace font stack, and the viewer's
font draws it. That keeps an SVG crisp at every zoom, selectable, searchable and a
few kilobytes. Backgrounds are rectangles merged into runs, and each run of text
carries a `textLength` so a viewer whose font has a different advance still puts
it in the right columns. A symbol or a fullwidth letter the monospace font lacks
is the viewer's to find, as it is a terminal's: every browser falls back per
character to a font that has it, so the bundled symbol font is a PNG matter and
an SVG does not carry it.

Box drawing, block elements and braille are drawn as rectangles and paths rather
than as text, so a box meets itself whatever font the reader has. OSC 8 links are
kept as `<a>`, for `http`, `https`, `mailto`, `ftp` and `file` only: an SVG
opened in a browser follows what it is handed, and a `javascript:` link from a
terminal is not something to hand it.

## PNG

A TrueType parser and a coverage rasterizer, written here: `cmap` formats 4 and
12, `glyf` outlines with composites, and exact anti-aliasing by area. The
default font is **JetBrains Mono**, bundled in four faces under the SIL Open Font
License — the licence is [`fonts/OFL.txt`](fonts/OFL.txt). No escape sequence
reports a terminal's font reliably, so a different one is an option; CFF fonts
(`.otf` with `OTTO`) are not read.

- **Box drawing, block elements and braille are drawn as geometry**, as real
  terminals do, so lines meet with no gaps between cells and a `▀` over a `▄`
  splits a cell exactly.
- **Symbols come from a bundled fallback.** JetBrains Mono lacks some of what
  sigil's own components draw — `✔`, `✖`, `ℹ`, `☐`, `☒`, `◐` and most of the
  spinners' shapes — which a terminal would borrow from a system font. A
  screenshot reads no system fonts, so that one frame is one image on every
  machine, and bundles **DejaVu Sans** for them instead, under its own licence,
  [`fonts/DejaVu-LICENSE.txt`](fonts/DejaVu-LICENSE.txt). It is looked in after
  the faces and after any `fallback` you give, whatever `font` is, and a symbol
  from it is drawn at its own size and centred in its cell, overhanging the
  cells beside it a little as a terminal's fallback does. A test in this package
  fails if anything `@ttylabs/sigil`'s components can draw would come out as a
  box.
- **Fullwidth ASCII** — `Ａ`, `０`, `！`, the decrypt effect's alphabet — is drawn
  from the ASCII glyph, centred across the two cells, unless a font has the real
  one.
- **Wide characters span two cells.** A character no font has is drawn as a box.
  None of the bundled fonts has CJK, so give a `fallback` font for it, which is
  looked in before the bundled one:

  ```js
  screenshot(frame, {
    font: {
      regular: DEFAULT_FONTS.regular,
      bold: DEFAULT_FONTS.bold,
      italic: DEFAULT_FONTS.italic,
      boldItalic: DEFAULT_FONTS.boldItalic,
      fallback: ['/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf'],
    },
    format: 'png',
  });
  ```

- **Attributes**: bold and italic use their faces, and are synthesized when a
  face is missing — a single font given as `font` is the regular face only. Dim
  is drawn at half strength, inverse swaps the colours, underline, strikethrough
  and overline are lines, blink is ignored, and hidden draws its background only.

`rasterize()` is the PNG path short of the encoding, returning
`{ width, height, data }` as 8-bit RGBA — for a test that wants to assert on
pixels.

## Deterministic

The same frame and options produce the same SVG string and the same pixels on
every machine: the rasterizer uses only arithmetic and `Math.sqrt()`, all of which
IEEE 754 requires to be correctly rounded, and
nothing reads the clock, the locale or the system's fonts. The one thing read from
the environment is the colour scheme, so a golden-file test passes `env: {}` (or
a `colorScheme`) and is then the same everywhere.
