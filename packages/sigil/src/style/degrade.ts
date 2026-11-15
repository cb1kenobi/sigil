/**
 * Colour degradation: one stylesheet, four colour depths.
 *
 * The problem CSS does not have. The same sheet has to render on a truecolor
 * terminal, a 256-colour one, a 16-colour one, and something with no colour at
 * all, and the author writes it once.
 *
 * ```js
 * import { degradeColor } from '@ttylabs/sigil/style';
 *
 * degradeColor(rgb(255, 95, 95), 2);  // the nearest xterm cube entry
 * degradeColor(rgb(255, 95, 95), 1);  // the nearest of the basic sixteen
 * degradeColor(rgb(255, 95, 95), 0);  // the terminal's own foreground
 * ```
 *
 * This runs at resolve time rather than at paint time, so the canvas only ever
 * holds colours the terminal can actually emit and the diff never compares a
 * colour against its own approximation. It is pure and memoized: the same
 * declared colour always degrades the same way at a given depth.
 */

import type { ColorLevel } from '../ansi/color-support.js';
import { nearestPaletteIndex, oklab, paletteRgb } from '../ansi/quantize.js';
import { type Color, DEFAULT_COLOR, palette, rgb, rgbChannels } from '../canvas/style.js';
import { ATTRIBUTE_PROPERTIES, COLOR_PROPERTIES, type Style } from './properties.js';

export { oklab, paletteRgb };

/** Where the 24-bit range starts, past the 256 palette. Mirrors `canvas/style.ts`. */
const RGB_BASE = 0x100;

/**
 * The RGB a colour stands for, whichever kind it is.
 *
 * A 24-bit colour is its own channels and a palette index is `paletteRgb()`'s
 * answer, with the basic sixteen read off the xterm defaults for the reason that
 * function gives. Exported for anything mixing a colour it was handed with one
 * of its own -- an image over a box's background is the case -- so the mix and
 * the degrader read a palette index the same way.
 *
 * @param color - The colour. Not `DEFAULT_COLOR`, which stands for no RGB at all.
 * @returns The channels.
 */
export function colorRgb(color: Color): readonly [number, number, number] {
  return rgbChannels(color) ?? paletteRgb(color);
}

/** Linear light back to one sRGB channel, 0-255, rounded and clamped. */
function encode(value: number): number {
  const v = value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
  return Math.min(255, Math.max(0, Math.round(v * 255)));
}

/**
 * Oklab back to sRGB.
 *
 * Here rather than beside the interpolator for one reason: the forward matrix is
 * ten lines above, with its own entry about the `b` row's last coefficient, and a
 * pair of matrices that are supposed to be each other's inverse belong in one
 * place. Clamped on the way out, because a mix of two in-gamut colours can leave
 * the cube by a rounding error and `rgb()` refuses a channel rather than
 * clamping it.
 *
 * @param lab - The Oklab coordinates.
 * @returns The sRGB channels, 0-255.
 */
export function rgbFromOklab(
  lab: readonly [number, number, number]
): readonly [number, number, number] {
  const [l, a, b] = lab;

  const lc = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mc = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const sc = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  return [
    encode(4.0767416621 * lc - 3.3077115913 * mc + 0.2309699292 * sc),
    encode(-1.2684380046 * lc + 2.6097574011 * mc - 0.3413193965 * sc),
    encode(-0.0041960863 * lc - 0.7034186147 * mc + 1.707614701 * sc),
  ];
}

/**
 * Mixes two colours in Oklab, or answers `undefined` where there is nothing to
 * mix through.
 *
 * **Only two 24-bit colours interpolate**, and the refusal is the decision.
 * AGENTS.md already records that a named colour stays a palette index because
 * the basic sixteen are whatever the user's terminal theme says they are -- so
 * easing from palette red to palette blue would have to invent a path through
 * the xterm defaults, which means both endpoints come out of a table rather
 * than out of the user's theme and the first frame is a different red from the
 * one the last frame left. `DEFAULT_COLOR` is worse: the terminal's own
 * foreground has no RGB at all. A caller that gets `undefined` snaps at the
 * midpoint, which is what CSS does with any value it cannot interpolate.
 *
 * Oklab rather than RGB for the reason the degrader gives, and it is the same
 * reason read forwards rather than backwards: a linear ramp through RGB passes
 * through muddy greys between complementary colours, and perceptual distance is
 * exactly what a mix is asking about.
 *
 * @param from - The colour at 0.
 * @param to - The colour at 1.
 * @param t - How far through.
 * @returns The mix, or `undefined` if either endpoint has no channels of its own.
 */
export function mixColors(from: Color, to: Color, t: number): Color | undefined {
  if (from < RGB_BASE || to < RGB_BASE) {
    return undefined;
  }
  if (from === to) {
    return from;
  }

  const a = oklab(colorRgb(from));
  const b = oklab(colorRgb(to));
  const [r, g, bl] = rgbFromOklab([
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ]);
  return rgb(r, g, bl);
}

/** One memo per lossy level. Level 3 is identity and level 0 has one answer. */
const MEMO: Map<number, Color>[] = [new Map(), new Map(), new Map(), new Map()];

/**
 * Degrades one colour to what a terminal at this depth can emit.
 *
 * The ladder: truecolor is the declared value; 256 quantizes to the xterm cube
 * and grey ramp; 16 matches the nearest basic colour in Oklab; 0 drops colour
 * entirely.
 *
 * Note what level 2 does *not* do: it never *lands* on `0`-`15`. Those sixteen
 * are whatever the user's theme says they are, so quantizing an ordinary colour
 * onto one makes the result depend on a setting nothing here can read. The cube
 * and the grey ramp are fixed by the spec, so at 256 colours there is always a
 * predictable answer; the unpredictable ones are a target only at level 1, where
 * there is no choice. A colour *declared* as one of the sixteen is a different
 * question and passes through untouched, for the reason AGENTS.md already gives.
 *
 * Memoized per level, and the memo is never evicted. What reaches this is a
 * *declared* colour -- what a stylesheet or a prop wrote -- of which an app has
 * a few dozen, so the table is small and stays small. A gradient painted cell by
 * cell does not come through here: it goes to the canvas directly. Neither does
 * an image, whose colours are `quantizeColor()`'s.
 *
 * @param color - The declared colour.
 * @param level - How much colour the destination can render.
 * @returns A colour the destination can emit.
 */
export function degradeColor(color: Color, level: ColorLevel): Color {
  if (color === DEFAULT_COLOR || level <= 0 || level >= 3) {
    return quantizeColor(color, level);
  }

  const memo = MEMO[level];
  const cached = memo.get(color);
  if (cached !== undefined) {
    return cached;
  }

  const answer = quantizeColor(color, level);
  memo.set(color, answer);
  return answer;
}

/**
 * `degradeColor()`'s answer, worked out every time rather than remembered.
 *
 * The memo is right for what a stylesheet declares and wrong for a picture: a
 * photograph resampled into a box is a few thousand colours nobody declared, a
 * different few thousand at every size it is drawn at, and a memo that is never
 * evicted would keep every one of them for the life of the process. So a caller
 * painting colours it computed -- an image is the one in this package -- asks
 * this, and remembers what it likes for as long as it likes. One function behind
 * both, so the two cannot come to disagree about a colour.
 *
 * @param color - The colour.
 * @param level - How much colour the destination can render.
 * @returns A colour the destination can emit.
 */
export function quantizeColor(color: Color, level: ColorLevel): Color {
  // the terminal's own foreground survives every level: it is not a colour we
  // chose, it is the absence of one
  if (color === DEFAULT_COLOR || level >= 3) {
    return color;
  }
  if (level <= 0) {
    return DEFAULT_COLOR;
  }

  // a palette colour the level can already emit is left exactly as declared.
  // At 256 that is every palette index, the basic sixteen included: AGENTS.md
  // records that a named colour stays a palette index, because those sixteen are
  // whatever the user's theme says they are -- so rewriting a declared `blue`
  // into the cube's #0000ff would override a choice they already made. Only a
  // colour the level *cannot* emit is matched, and only ever onto the fixed part
  // of the palette
  // the match is the one the styler asks for `ansi.rgb()`, which lives in
  // `ansi/quantize.ts` so that a declared color and a styled string cannot
  // draw as two different colors
  if (level === 2 ? color < RGB_BASE : color < 16) {
    return color;
  }
  const [r, g, b] = colorRgb(color);
  return palette(nearestPaletteIndex(r, g, b, level === 2 ? 2 : 1));
}

/**
 * Degrades every colour in a style, in place.
 *
 * In place because the caller is the cascade, which has just built the style and
 * is the only thing holding it. `degradeStyle()` is the copying version.
 *
 * @param style - The style to degrade.
 * @param level - How much colour the destination can render.
 * @returns The same style.
 */
export function degradeInto(style: Style, level: ColorLevel): Style {
  if (level >= 3) {
    return style;
  }
  // the table says which properties hold a colour, so the cast is a statement
  // about that rather than about any particular property
  const writable = style as unknown as Record<string, Color>;
  for (const property of COLOR_PROPERTIES) {
    writable[property] = degradeColor(writable[property], level);
  }

  // level 0 is plain text, attributes included, which is what the styler has
  // always meant by it: `ansi.bold()` at level 0 hands back the string it was
  // given. The two ways a process arrives at level 0 are a pipe and `NO_COLOR`,
  // and neither wants `ESC[1m` in the file it is writing -- so a bold heading
  // and a cyan one go together rather than the library deciding that one of
  // them was too important to turn off. It is also what makes a prompt asked
  // for plain text plain: the caret is `inverse`, and a caret drawn at level 0
  // would be the one sequence nothing could switch off
  if (level === 0) {
    const attrs = style as unknown as Record<string, boolean>;
    for (const property of ATTRIBUTE_PROPERTIES) {
      attrs[property] = false;
    }
  }

  return style;
}

/**
 * Degrades every colour in a style.
 *
 * Nothing but the colours changes. A palette that carried meaning -- an error is
 * red -- loses that meaning at level 0, and nothing here invents an attribute to
 * carry it: turning red into bold would make red and blue both bold, which
 * preserves the emphasis while destroying the distinction it is pretending to
 * keep. The rule that follows is a rule for components rather than for this
 * function: do not encode meaning in colour alone. That is an accessibility
 * argument as much as a compatibility one.
 *
 * @param style - The style.
 * @param level - How much colour the destination can render.
 * @returns A new style with its colours degraded.
 */
export function degradeStyle(style: Style, level: ColorLevel): Style {
  return level >= 3 ? style : degradeInto({ ...style }, level);
}
