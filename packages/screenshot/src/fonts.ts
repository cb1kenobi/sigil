import { type Font, parseFont } from './font/truetype.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The fonts a screenshot draws with, and where the default ones live.
 *
 * No escape sequence reports a terminal's font reliably, so the font is an
 * option, and the default is JetBrains Mono, bundled with this package in its
 * four faces under the SIL Open Font License -- `fonts/OFL.txt` is the licence,
 * shipped beside the files it covers as the licence requires.
 *
 * Behind every face sits DejaVu Sans, bundled for the symbols JetBrains Mono
 * lacks -- `✔`, `✖`, `ℹ`, `☐`, the spinners' shapes -- which a terminal would
 * borrow from a system font and a screenshot, reading none, has nowhere else to
 * find. Its licence is `fonts/DejaVu-LICENSE.txt`, beside it for the same reason.
 *
 * The files are read from `../fonts/` relative to this module, which is the same
 * directory from `src/` and from `dist/`: nothing copies them into a build, so a
 * build reads none of them and a cached `dist/` cannot hold a stale copy.
 */

/** A font: a path, a `file:` URL, the file's bytes, or one already loaded. */
export type FontSource = Font | string | Uint8Array | URL;

/**
 * The faces to draw with. A face left out is synthesized from the regular one:
 * a bold is the outline drawn twice a fraction of a pixel apart, an italic is it
 * sheared.
 */
export interface FontFaces {
  bold?: FontSource;
  boldItalic?: FontSource;
  /**
   * Fonts to look in, in order, for a character the faces above do not have.
   * The bundled symbol font is looked in after these, and a character none of
   * them has is drawn as a box.
   */
  fallback?: readonly FontSource[];
  italic?: FontSource;
  regular: FontSource;
}

/** The `font` option: one face, which is the regular, or several. */
export type FontOption = FontFaces | FontSource;

/** The faces, loaded. */
export interface LoadedFaces {
  bold: Font | undefined;
  boldItalic: Font | undefined;
  fallback: readonly Font[];
  italic: Font | undefined;
  regular: Font;
}

const bundled = (name: string): URL =>
  new URL(`../fonts/JetBrainsMono-${name}.ttf`, import.meta.url);

/** Where the bundled faces are, for a caller that wants to read them itself. */
export const DEFAULT_FONTS: Readonly<Record<'bold' | 'boldItalic' | 'italic' | 'regular', URL>> =
  Object.freeze({
    bold: bundled('Bold'),
    boldItalic: bundled('BoldItalic'),
    italic: bundled('Italic'),
    regular: bundled('Regular'),
  });

/**
 * Where the bundled symbol font is: DejaVu Sans, the last place a character is
 * looked for before it is drawn as a box. Behind every face and every
 * `fallback`, including a font set that names none of the bundled faces.
 */
export const SYMBOL_FONT: URL = new URL('../fonts/DejaVuSans.ttf', import.meta.url);

let symbols: Font | undefined;

/**
 * The bundled symbol font, read the first time a character is missing from
 * everything in front of it -- so an SVG, which never looks a glyph up, and a
 * frame the faces cover between them never read it.
 *
 * @returns The font.
 */
export function symbolFont(): Font {
  symbols ??= loadFont(SYMBOL_FONT);
  return symbols;
}

/** Fonts read from a path, so a second screenshot does not parse them again. */
const byPath = new Map<string, Font>();
/** And fonts handed over as bytes, keyed by the bytes. */
const byBytes = new WeakMap<Uint8Array, Font>();

function isFont(value: unknown): value is Font {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Font).glyphFor === 'function' &&
    typeof (value as Font).outline === 'function'
  );
}

/**
 * Loads a font, once.
 *
 * Synchronous, because a screenshot is: a font is read the first time it is
 * asked for and kept, so the cost is one read per path per process.
 *
 * @param source - A path, a `file:` URL, the bytes, or a font already loaded.
 * @returns The font.
 */
export function loadFont(source: FontSource): Font {
  if (isFont(source)) {
    return source;
  }
  if (source instanceof Uint8Array) {
    let font = byBytes.get(source);
    if (!font) {
      font = parseFont(source);
      byBytes.set(source, font);
    }
    return font;
  }
  if (typeof source !== 'string' && !(source instanceof URL)) {
    throw new TypeError(
      'Invalid font: expected a path, a file URL, a Uint8Array, or a loaded font'
    );
  }
  const path = typeof source === 'string' ? source : fileURLToPath(source);
  let font = byPath.get(path);
  if (!font) {
    font = parseFont(readFileSync(path));
    byPath.set(path, font);
  }
  return font;
}

/**
 * Loads every face the option names, or the bundled four when it names none.
 *
 * A single source is the regular face *only*: the bundled bold and italic are
 * a different design, and drawing one font's regular beside another's bold is
 * worse than synthesizing the bold from the font that was asked for.
 *
 * @param option - The `font` option.
 * @returns The faces.
 */
export function loadFaces(option?: FontOption): LoadedFaces {
  if (option === undefined) {
    return {
      bold: loadFont(DEFAULT_FONTS.bold),
      boldItalic: loadFont(DEFAULT_FONTS.boldItalic),
      fallback: [],
      italic: loadFont(DEFAULT_FONTS.italic),
      regular: loadFont(DEFAULT_FONTS.regular),
    };
  }
  if (
    typeof option === 'object' &&
    !(option instanceof Uint8Array) &&
    !(option instanceof URL) &&
    !isFont(option)
  ) {
    const faces = option;
    if (faces.regular === undefined) {
      throw new TypeError('Invalid font: a set of faces needs a regular one');
    }
    if (faces.fallback !== undefined && !Array.isArray(faces.fallback)) {
      throw new TypeError('Invalid font: fallback is a list of fonts');
    }
    return {
      bold: faces.bold === undefined ? undefined : loadFont(faces.bold),
      boldItalic: faces.boldItalic === undefined ? undefined : loadFont(faces.boldItalic),
      fallback: (faces.fallback ?? []).map((it) => loadFont(it)),
      italic: faces.italic === undefined ? undefined : loadFont(faces.italic),
      regular: loadFont(faces.regular),
    };
  }
  return {
    bold: undefined,
    boldItalic: undefined,
    fallback: [],
    italic: undefined,
    regular: loadFont(option),
  };
}
