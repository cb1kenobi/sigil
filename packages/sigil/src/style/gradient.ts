/**
 * A colour ramp across a string, and across a box drawn around one.
 *
 * Lip Gloss blends colours and `ink-gradient` colours text with a ramp; this is
 * the same function over what the style system already has. The mix is
 * `mixColors()` (Oklab, the one the transitions use) and the depth is
 * `degradeColor()` (the one the cascade uses), so a gradient is a third caller
 * of two pure functions rather than a colour model of its own.
 *
 * ```js
 * import { gradient, gradientBox } from '@ttylabs/sigil/style';
 *
 * gradient('Hello, world', ['#ff5f6d', '#ffc371']);
 * gradient('Hello, world', ['#ff5f6d', '#ffc371'], { level: 1 }); // one colour
 * gradientBox('Deployed', ['#00c6ff', '#0072ff'], { border: 'round' });
 * ```
 *
 * It is a helper that returns a string and not a style property, on purpose: a
 * `color: linear-gradient(...)` would be a new value type the cascade, the
 * inheritance rule, the animator and the canvas would each have to learn about,
 * for an effect whose whole use is a banner. A string already carries its own
 * colours, so none of them needs to know.
 */

import { sgr } from '../ansi/codes.js';
import { assertColorLevel, type ColorLevel, getColorLevel } from '../ansi/color-support.js';
import { matcher } from '../ansi/strip.js';
import { type Color, colorParams, DEFAULT_COLOR } from '../canvas/style.js';
import { graphemes, graphemeWidth, stringWidth } from '../width/index.js';
import { degradeColor, mixColors } from './degrade.js';
import { parseColor } from './value.js';

/**
 * One stop of a ramp: a hex or `rgb()` colour as the stylesheet reads it, or a
 * colour already built with `rgb()`.
 */
export type GradientStop = Color | string;

export interface GradientOptions {
  /**
   * How much colour the destination can render. Defaults to the level detected
   * for `process.stdout`, which is what `ansi.level` answers; pass one to render
   * for another stream, or to make a test deterministic.
   */
  level?: ColorLevel;
}

/** The character sets a box may be drawn with, as `border-style` spells them. */
export type GradientBorder = 'ascii' | 'bold' | 'double' | 'round' | 'single';

export interface GradientBoxOptions extends GradientOptions {
  /** The border's character set. Defaults to `round`. */
  border?: GradientBorder;
  /** Columns of space between the border and the text, each side. Defaults to 1. */
  padding?: number;
}

/** Where the 24-bit range starts, past the palette. Mirrors `canvas/style.ts`. */
const RGB_BASE = 0x100;

/**
 * The characters each border set is drawn with, in `element/paint.ts`'s order:
 * top-left, top, top-right, right, bottom-right, bottom, bottom-left, left.
 *
 * A second spelling of that table, and `gradient.test.ts` renders a real
 * bordered box beside each of these to keep the two from drifting. The style
 * layer cannot import the element layer, which sits above it.
 */
const BORDERS: Record<GradientBorder, readonly string[]> = {
  ascii: ['+', '-', '+', '|', '+', '-', '+', '|'],
  bold: ['┏', '━', '┓', '┃', '┛', '━', '┗', '┃'],
  double: ['╔', '═', '╗', '║', '╝', '═', '╚', '║'],
  round: ['╭', '─', '╮', '│', '╯', '─', '╰', '│'],
  single: ['┌', '─', '┐', '│', '┘', '─', '└', '│'],
};

/** Turns the foreground back to the terminal's own, leaving every attribute alone. */
const FOREGROUND_OFF = sgr(39);

/**
 * Reads the stops into 24-bit colours.
 *
 * **A stop must have channels of its own.** `mixColors()` refuses a palette
 * index, because the basic sixteen are whatever the user's theme says they are,
 * and a ramp from `red` to `blue` would have to invent a path through the xterm
 * defaults. For a transition that refusal snaps at the midpoint, which is CSS;
 * for a ramp it would be two bands, which is the one thing a gradient is not.
 * So it is an error here, at every level -- a stop list that works on a
 * truecolor terminal and throws on a 16-colour one is the worse failure.
 *
 * @param stops - The stops as the caller wrote them.
 * @returns The colours.
 */
function readStops(stops: readonly GradientStop[]): Color[] {
  if (stops.length === 0) {
    throw new TypeError('A gradient needs at least one colour stop');
  }
  return stops.map((stop) => {
    const color = typeof stop === 'string' ? parseColor(stop) : stop;
    if (!Number.isInteger(color) || color < RGB_BASE) {
      throw new TypeError(
        `Invalid gradient stop ${String(stop)}: a stop must be a 24-bit colour such as '#ff8800', ` +
          `because a palette colour has no channels of its own to blend`
      );
    }
    return color;
  });
}

/**
 * The colour a fraction of the way along the stops.
 *
 * Stops are evenly spaced. A cell that lands exactly on a stop is that stop as
 * written rather than a round trip through Oklab, and the far end is the one
 * place that is the mix: `mixColors()` at 1 came back exact for every pair of a
 * sweep of the cube (stride 17), so it gets no special case a test could not
 * fail.
 *
 * @param stops - The stops, as 24-bit colours.
 * @param t - 0 to 1.
 * @returns The colour.
 */
function colorAt(stops: readonly Color[], t: number): Color {
  if (stops.length === 1) {
    return stops[0];
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(Math.floor(scaled), stops.length - 2);
  const local = scaled - index;
  if (local === 0) {
    return stops[index];
  }
  // both are 24-bit by `readStops()`, which is the only thing `mixColors()`
  // answers `undefined` to
  return mixColors(stops[index], stops[index + 1], local)!;
}

/**
 * What colours the cells of a ramp, as a function of how far along it they are.
 *
 * This is where the depth is applied, and the three lossy cases differ:
 *
 * - **3** is the mix itself.
 * - **2** quantizes each cell through `degradeColor()`, so a long ramp is a
 *   run of cube entries and the nearest-match rule is the cascade's own.
 * - **1** is *one colour*, the first stop's nearest of the sixteen. Quantizing a
 *   ramp onto sixteen scattered colours gives bands of unrelated hues, which
 *   reads as a rendering fault rather than as a gradient; a single colour reads
 *   as a choice.
 * - **0** is the terminal's own foreground, which the callers turn into no
 *   sequence at all.
 */
function ramp(stops: readonly Color[], level: ColorLevel): (t: number) => Color {
  if (level <= 0) {
    return () => DEFAULT_COLOR;
  }
  if (level === 1) {
    const only = degradeColor(stops[0], 1);
    return () => only;
  }
  return (t) => degradeColor(colorAt(stops, t), level);
}

function levelOf(opts: GradientOptions): ColorLevel {
  assertColorLevel(opts.level);
  return opts.level ?? getColorLevel();
}

/**
 * The colours of a ramp across some cells.
 *
 * The pure half: what `gradient()` and `gradientBox()` colour with, exposed for
 * a caller painting its own cells (a canvas, a table column).
 *
 * @param stops - Two or more colours; one is a solid colour.
 * @param count - How many cells. The first is the first stop and the last is the
 * last, and a single cell is the first.
 * @param opts - The colour level.
 * @returns One colour per cell, each one the destination can emit.
 */
export function gradientColors(
  stops: readonly GradientStop[],
  count: number,
  opts: GradientOptions = {}
): Color[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new TypeError(`Invalid gradient length ${String(count)}: expected a whole number`);
  }
  const colors = readStops(stops);
  const at = ramp(colors, levelOf(opts));
  return Array.from({ length: count }, (_, i) => at(count > 1 ? i / (count - 1) : 0));
}

/**
 * Splits a line into the escape sequences in it and the text between them.
 *
 * @param line - One line of a string.
 * @returns The pieces, in order, each marked as a sequence or as text.
 */
function pieces(line: string): { sequence: boolean; value: string }[] {
  const out: { sequence: boolean; value: string }[] = [];
  let from = 0;
  for (const match of line.matchAll(matcher())) {
    if (match.index > from) {
      out.push({ sequence: false, value: line.slice(from, match.index) });
    }
    out.push({ sequence: true, value: match[0] });
    from = match.index + match[0].length;
  }
  if (from < line.length) {
    out.push({ sequence: false, value: line.slice(from) });
  }
  return out;
}

/**
 * Colours a string along a ramp, one grapheme cluster at a time.
 *
 * A cluster is the unit, so a flag, a family or a combining accent is never
 * split between two colours, and it is coloured by the **column** it starts in
 * rather than by its index -- a wide character takes two columns of the ramp, so
 * `日本語` and `abc` of the same width end at the same stop. The first column is
 * the first stop and the last is the last.
 *
 * A string of several lines is ramped by column across its widest line, so the
 * same column is the same colour on every row and a block of text reads as one
 * surface.
 *
 * **The ramp owns the foreground** of what it covers. Text that already holds
 * escape sequences keeps them -- bold stays bold, a hyperlink stays a link, and
 * none of them takes a column -- but a foreground colour inside is overridden by
 * the ramp, which is the thing that was asked for.
 *
 * At level 0 the string comes back unchanged, which is what a pipe and
 * `NO_COLOR` both arrive at. At level 1 the whole string is the first stop's
 * nearest basic colour. Neither reads the quiet axis: this returns a string and
 * the caller does the writing, which puts it on `table()`'s side of the line.
 *
 * @param text - The string.
 * @param stops - Two or more colours; one is a solid colour.
 * @param opts - The colour level.
 * @returns The coloured string.
 */
export function gradient(
  text: string,
  stops: readonly GradientStop[],
  opts: GradientOptions = {}
): string {
  const colors = readStops(stops);
  const level = levelOf(opts);

  if (level === 0 || text === '') {
    return text;
  }

  const lines = text.split('\n');
  const span = Math.max(...lines.map((line) => stringWidth(line)));
  const at = ramp(colors, level);

  return lines.map((line) => rampLine(line, span, at)).join('\n');
}

/**
 * One line of a ramp that is `span` columns wide.
 *
 * @param line - The line.
 * @param span - Columns the whole ramp covers.
 * @param at - The colour for a fraction of the way along.
 * @returns The line with its colours.
 */
function rampLine(line: string, span: number, at: (t: number) => Color): string {
  let out = '';
  let column = 0;
  // the colour in effect, forgotten whenever a sequence of the text's own might
  // have changed it
  let current: Color | undefined;
  let opened = false;

  for (const piece of pieces(line)) {
    if (piece.sequence) {
      out += piece.value;
      current = undefined;
      continue;
    }
    for (const cluster of graphemes(piece.value)) {
      const width = graphemeWidth(cluster);
      if (width === 0) {
        out += cluster;
        continue;
      }
      // the middle of the cluster, so a wide character at the end is as near the
      // last stop as a cell can be, and a narrow one is exactly its column
      const t = span > 1 ? (column + (width - 1) / 2) / (span - 1) : 0;
      const color = at(t);
      if (color !== current) {
        out += sgr(colorParams(color, false));
        current = color;
        opened = true;
      }
      out += cluster;
      column += width;
    }
  }

  return opened ? out + FOREGROUND_OFF : out;
}

/**
 * Draws a border around some text with the border coloured along a ramp.
 *
 * The narrowest cut at "gradient borders" that needs no style property: the
 * same glyph sets `border-style` draws, each cell of the border coloured by its
 * **column** across the full width of the box. The top and bottom edges ramp
 * from the first stop to the last, the left edge is the first stop all the way
 * down and the right edge the last. The text inside is left exactly as it came.
 *
 * The box is as wide as the widest line plus the padding and the border; it does
 * not wrap, so wrap to the width wanted first. At level 0 it is a plain box.
 *
 * @param text - The content, one or more lines.
 * @param stops - Two or more colours; one is a solid colour.
 * @param opts - The border set, the padding and the colour level.
 * @returns The lines of the box, joined with newlines.
 */
export function gradientBox(
  text: string,
  stops: readonly GradientStop[],
  opts: GradientBoxOptions = {}
): string {
  const colors = readStops(stops);
  const level = levelOf(opts);
  const padding = opts.padding ?? 1;
  const set = BORDERS[opts.border ?? 'round'];

  if (set === undefined) {
    throw new TypeError(`Unknown border "${String(opts.border)}"`);
  }
  if (!Number.isInteger(padding) || padding < 0) {
    throw new TypeError(`Invalid padding ${String(padding)}: expected a whole number`);
  }

  const [topLeft, top, topRight, right, bottomRight, bottom, bottomLeft, left] = set;
  const lines = text.split('\n');
  const inner = Math.max(...lines.map((line) => stringWidth(line))) + padding * 2;
  const total = inner + 2;
  const at = ramp(colors, level);

  // a border cell is one column, so it is coloured by the column it is in
  const cell = (glyph: string, column: number): string => {
    if (level === 0) {
      return glyph;
    }
    const color = at(total > 1 ? column / (total - 1) : 0);
    return sgr(colorParams(color, false)) + glyph + FOREGROUND_OFF;
  };
  const edge = (corner: [string, string], fill: string): string => {
    let row = cell(corner[0], 0);
    for (let column = 1; column <= inner; column++) {
      row += cell(fill, column);
    }
    return row + cell(corner[1], total - 1);
  };

  const pad = ' '.repeat(padding);
  const rows = lines.map((line) => {
    const fill = ' '.repeat(inner - padding * 2 - stringWidth(line));
    return cell(left, 0) + pad + line + fill + pad + cell(right, total - 1);
  });

  return [edge([topLeft, topRight], top), ...rows, edge([bottomLeft, bottomRight], bottom)].join(
    '\n'
  );
}
