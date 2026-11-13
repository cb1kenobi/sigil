import { hexChannels } from '@ttylabs/sigil/ansi';
import { ATTR, type Color, DEFAULT_COLOR, rgbChannels, type Style } from '@ttylabs/sigil/canvas';
import {
  type ColorScheme,
  forcedScheme,
  paletteRgb,
  schemeFromTerminalEnv,
} from '@ttylabs/sigil/style';

/**
 * The colours a terminal decides and a canvas does not.
 *
 * A cell holds `DEFAULT_COLOR`, a palette index, or 24-bit -- and only the first
 * two mean something that is not in the cell. Everything a stylesheet set is
 * already baked in: the theme gives no root foreground or background and every
 * colour it does give is a palette index or a channel triple. So a screenshot
 * supplies exactly three things: the default foreground, the default
 * background, and what palette entries `0`-`15` look like. `16`-`255` are the
 * xterm cube and grey ramp, fixed by the spec, and come from `paletteRgb()` --
 * the degrader's own table -- rather than a second copy of it.
 */

/** A colour on 0-255 per channel, which is also what the terminal reports. */
export interface Rgb {
  readonly b: number;
  readonly g: number;
  readonly r: number;
}

/** A colour as an option: `#rgb`, `#rrggbb`, or channels. */
export type ColorInput = Rgb | string;

/**
 * What a terminal said about itself, which `detect()` on a renderer returns.
 *
 * Structural rather than `Capabilities` itself, so that a caller holding the
 * three colours from somewhere else -- a config file, a theme export -- passes
 * them in the same shape.
 */
export interface TerminalColors {
  readonly background?: Rgb;
  readonly colorScheme?: ColorScheme;
  readonly foreground?: Rgb;
  readonly palette?: readonly (Rgb | undefined)[];
}

/** The options that decide a screenshot's colours. */
export interface ColorOptions {
  /** The default background, over everything else. */
  bg?: ColorInput;
  /**
   * Which built-in palette fills what nothing else answered. Defaults to what a
   * renderer would resolve: `SIGIL_COLOR_SCHEME`, then the terminal's report,
   * then `COLORFGBG`, then dark.
   */
  colorScheme?: ColorScheme;
  /** The environment `SIGIL_COLOR_SCHEME` and `COLORFGBG` are read from. */
  env?: Record<string, string | undefined>;
  /** The default foreground, over everything else. */
  fg?: ColorInput;
  /** Palette entries `0`-`15`; a hole falls through to the terminal, then the built-in. */
  palette?: readonly (ColorInput | undefined)[];
  /** What the terminal reported, as `Renderer.detect()` returns it. */
  terminal?: TerminalColors;
}

/** The colours a screenshot is drawn with, every one of them decided. */
export interface ResolvedColors {
  readonly background: Rgb;
  readonly colorScheme: ColorScheme;
  readonly foreground: Rgb;
  /** All sixteen. */
  readonly palette: readonly Rgb[];
}

const hex = (value: string): Rgb => parseColor(value);

/**
 * The built-in palettes, for the scheme a screenshot resolves to.
 *
 * Chosen to be legible and to keep the two promises sigil's own sheet relies
 * on: index `0` is a background-ish colour and `8` a grey that text can sit in
 * on a dark terminal, and on a light one `7` is a pale grey a pane can use as a
 * background while `8` is dark enough to read. Not any one terminal's defaults,
 * because a README image is better served by a palette than by an accident of
 * whose machine it was taken on -- and the terminal's own answer, when there is
 * one, outranks these anyway.
 */
export const BUILTIN_PALETTES: Readonly<Record<ColorScheme, ResolvedColors>> = Object.freeze({
  dark: Object.freeze({
    background: hex('#1e1e1e'),
    colorScheme: 'dark',
    foreground: hex('#d4d4d4'),
    palette: Object.freeze(
      [
        '#000000',
        '#cd3131',
        '#0dbc79',
        '#e5e510',
        '#2472c8',
        '#bc3fbc',
        '#11a8cd',
        '#e5e5e5',
        '#666666',
        '#f14c4c',
        '#23d18b',
        '#f5f543',
        '#3b8eea',
        '#d670d6',
        '#29b8db',
        '#ffffff',
      ].map(hex)
    ),
  }),
  light: Object.freeze({
    background: hex('#ffffff'),
    colorScheme: 'light',
    foreground: hex('#1f1f1f'),
    palette: Object.freeze(
      [
        '#000000',
        '#c91b00',
        '#00a600',
        '#a68b00',
        '#0037da',
        '#b200b2',
        '#00a6b2',
        '#d6d6d6',
        '#5e5e5e',
        '#e50000',
        '#00b600',
        '#bfa700',
        '#3b78ff',
        '#e500e5',
        '#00b6c2',
        '#f2f2f2',
      ].map(hex)
    ),
  }),
});

/**
 * Reads a colour option.
 *
 * `#rgb` and `#rrggbb`, or `{ r, g, b }` on 0-255. Refused rather than clamped
 * when it is anything else, for the reason `rgb()` refuses a bad channel:
 * rendering as something near what was asked is worse than saying it was wrong.
 *
 * @param value - The option.
 * @returns The channels.
 */
export function parseColor(value: ColorInput): Rgb {
  if (typeof value === 'string') {
    // trimmed, and the `#` required, which are this caller's own rules; the
    // digits are `hexChannels()`'s, the one reader the styler and a
    // stylesheet's `parseColor()` share
    const text = value.trim();
    const channels = text.startsWith('#') ? hexChannels(text.slice(1)) : undefined;
    if (!channels) {
      throw new TypeError(`Invalid colour ${JSON.stringify(value)}: expected #rgb or #rrggbb`);
    }
    const [r, g, b] = channels;
    return Object.freeze({ b, g, r });
  }
  if (value === null || typeof value !== 'object') {
    throw new TypeError(`Invalid colour ${String(value)}: expected #rrggbb or { r, g, b }`);
  }
  for (const channel of ['r', 'g', 'b'] as const) {
    const v = value[channel];
    if (!Number.isInteger(v) || v < 0 || v > 255) {
      throw new TypeError(`Invalid colour: ${channel} is ${String(v)}, expected 0-255`);
    }
  }
  return Object.freeze({ b: value.b, g: value.g, r: value.r });
}

/**
 * Decides the colours, highest first: the options, what the terminal reported,
 * then the built-in palette for the resolved scheme.
 *
 * Per colour rather than per source, so a terminal that answered OSC 11 and not
 * OSC 4 keeps its own background and borrows the built-in reds. The scheme is
 * the renderer's chain with the reply in it -- an explicit option, then
 * `SIGIL_COLOR_SCHEME`, then the terminal, then `COLORFGBG`, then dark -- so a
 * screenshot of a frame themed light is drawn over the light defaults.
 *
 * @param opts - The colour options.
 * @returns Every colour, decided.
 */
export function resolveColors(opts: ColorOptions = {}): ResolvedColors {
  const env = opts.env ?? process.env;
  const terminal = opts.terminal;
  const colorScheme =
    opts.colorScheme ??
    forcedScheme(env) ??
    terminal?.colorScheme ??
    schemeFromTerminalEnv(env) ??
    'dark';
  if (colorScheme !== 'dark' && colorScheme !== 'light') {
    throw new TypeError(`Invalid colorScheme ${String(colorScheme)}: expected dark or light`);
  }
  const builtin = BUILTIN_PALETTES[colorScheme];

  const pick = (given: ColorInput | undefined, reported: Rgb | undefined, fallback: Rgb): Rgb =>
    given === undefined ? (reported ? parseColor(reported) : fallback) : parseColor(given);

  if (opts.palette !== undefined && !Array.isArray(opts.palette)) {
    throw new TypeError('Invalid palette: expected an array of up to sixteen colours');
  }
  if (opts.palette && opts.palette.length > 16) {
    throw new TypeError(`Invalid palette: ${opts.palette.length} entries, expected at most 16`);
  }

  return Object.freeze({
    background: pick(opts.bg, terminal?.background, builtin.background),
    colorScheme,
    foreground: pick(opts.fg, terminal?.foreground, builtin.foreground),
    palette: Object.freeze(
      builtin.palette.map((fallback, i) =>
        pick(opts.palette?.[i], terminal?.palette?.[i], fallback)
      )
    ),
  });
}

/**
 * What a cell's colour looks like, under the resolved colours.
 *
 * @param color - The cell's colour.
 * @param colors - The resolved colours.
 * @param role - Which default a `DEFAULT_COLOR` stands for.
 * @returns The channels.
 */
export function colorOf(color: Color, colors: ResolvedColors, role: 'bg' | 'fg'): Rgb {
  if (color === DEFAULT_COLOR) {
    return role === 'fg' ? colors.foreground : colors.background;
  }
  const channels = rgbChannels(color);
  if (channels) {
    return { b: channels[2], g: channels[1], r: channels[0] };
  }
  if (color < 16) {
    return colors.palette[color];
  }
  const [r, g, b] = paletteRgb(color);
  return { b, g, r };
}

/**
 * The colours a cell is drawn in, inverse applied.
 *
 * Each default is resolved in its own role before the swap, so an inverse cell
 * in the terminal's colours is the default background on the default foreground
 * -- which is what reverse video on a terminal is.
 *
 * @param style - The cell's style.
 * @param colors - The resolved colours.
 * @returns The foreground and background.
 */
export function cellColors(style: Style, colors: ResolvedColors): { bg: Rgb; fg: Rgb } {
  const fg = colorOf(style.fg, colors, 'fg');
  const bg = colorOf(style.bg, colors, 'bg');
  return style.attrs & ATTR.inverse ? { bg: fg, fg: bg } : { bg, fg };
}

/** `#rrggbb`, which is how SVG is told a colour. */
export function toHex(color: Rgb): string {
  const byte = (v: number): string => v.toString(16).padStart(2, '0');
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}`;
}

/** Whether two colours are the same colour. */
export function sameColor(a: Rgb, b: Rgb): boolean {
  return a.r === b.r && a.g === b.g && a.b === b.b;
}
