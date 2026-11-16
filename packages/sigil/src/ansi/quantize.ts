/**
 * The one quantizer: an RGB color to the nearest palette index a terminal can
 * emit.
 *
 * Two things degrade a color -- the styler, for `ansi.rgb()` and `ansi.hex()`,
 * and the style engine, for a declared color -- and for a while each had its own
 * palette and its own metric, so a value written once drew as two colors:
 * `rgb(0, 0, 255)` was bright blue through one and plain blue through the other,
 * and 2,499 of 4,096 sampled colors disagreed at 16 colors and 1,288 of 4,096 at
 * 256. There is one answer now, owned here because `src/ansi` is the lower layer
 * and both callers already import it.
 *
 * The palette is the xterm defaults and the metric is Oklab. The first because
 * it is what most terminals' default themes resemble; the second because it is
 * perceptual, where RGB distance picks visibly wrong answers.
 */

/**
 * The xterm default palette for the basic sixteen.
 *
 * Terminal themes make these unknowable -- somebody running Solarized has a
 * different red -- so this matches against the xterm defaults and accepts being
 * wrong for them. There is no way to ask a terminal what its palette is that is
 * worth the round trip, and being wrong about a color the user chose is a
 * smaller failure than refusing to degrade at all.
 */
const BASIC: readonly (readonly [number, number, number])[] = [
  [0x00, 0x00, 0x00], // 0  black
  [0xcd, 0x00, 0x00], // 1  red
  [0x00, 0xcd, 0x00], // 2  green
  [0xcd, 0xcd, 0x00], // 3  yellow
  [0x00, 0x00, 0xee], // 4  blue
  [0xcd, 0x00, 0xcd], // 5  magenta
  [0x00, 0xcd, 0xcd], // 6  cyan
  [0xe5, 0xe5, 0xe5], // 7  white
  [0x7f, 0x7f, 0x7f], // 8  bright black
  [0xff, 0x00, 0x00], // 9  bright red
  [0x00, 0xff, 0x00], // 10 bright green
  [0xff, 0xff, 0x00], // 11 bright yellow
  [0x5c, 0x5c, 0xff], // 12 bright blue
  [0xff, 0x00, 0xff], // 13 bright magenta
  [0x00, 0xff, 0xff], // 14 bright cyan
  [0xff, 0xff, 0xff], // 15 bright white
];

/** The six levels each axis of the xterm color cube takes. */
const CUBE_LEVELS: readonly number[] = [0, 95, 135, 175, 215, 255];

/**
 * The RGB an xterm palette index stands for.
 *
 * `16`-`231` are a 6x6x6 cube and `232`-`255` a 24-step grey ramp, both fixed by
 * the spec. `0`-`15` are the user's, and are answered from the xterm defaults
 * above for want of anything better.
 *
 * @param index - The palette index.
 * @returns The channels.
 */
export function paletteRgb(index: number): readonly [number, number, number] {
  if (index < 16) {
    return BASIC[index]!;
  }
  if (index < 232) {
    const n = index - 16;
    return [
      CUBE_LEVELS[Math.floor(n / 36) % 6]!,
      CUBE_LEVELS[Math.floor(n / 6) % 6]!,
      CUBE_LEVELS[n % 6]!,
    ];
  }
  const grey = 8 + (index - 232) * 10;
  return [grey, grey, grey];
}

/**
 * sRGB to Oklab.
 *
 * Oklab over CIELAB because it is simpler, newer, and better behaved around
 * blues; either beats Euclidean RGB, which is the thing actually worth avoiding.
 * The sixteen basic colors are perceptually scattered rather than evenly spaced,
 * so RGB distance picks visibly wrong answers -- a mid orange comes out green
 * because green happens to be numerically closer than red.
 *
 * @param channel - The sRGB channels, 0-255.
 * @returns The Oklab coordinates.
 */
export function oklab(
  channel: readonly [number, number, number]
): readonly [number, number, number] {
  const [r, g, b] = channel.map(linear) as [number, number, number];

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    // -0.8086758033 rather than Ottosson's published -0.808675766. For D65
    // white the LMS rows each sum to one, so l, m and s are all 1 and the a and
    // b rows have to sum to exactly zero or a grey acquires chroma. The a row
    // does; the published b row leaves a residue of 3.7e-8, which is small but
    // is a bias in one direction on every neutral color there is. This is the
    // value that makes the row sum zero, and `should give a grey no chroma`
    // pins the property rather than the digits
    0.0259040371 * l + 0.7827717662 * m - 0.8086758033 * s,
  ];
}

/** One sRGB channel, 0-255, to linear light. */
function linear(value: number): number {
  const v = value / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
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
 * `oklab()` above, with its own entry about the `b` row's last coefficient, and a
 * pair of matrices that are supposed to be each other's inverse belong in one
 * place. `style/degrade.ts` re-exports it. Clamped on the way out, because a mix
 * of two in-gamut colors can leave the cube by a rounding error and `rgb()`
 * refuses a channel rather than clamping it.
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

/** Every palette index's Oklab, worked out on first use rather than at import. */
let table: (readonly [number, number, number])[] | undefined;

/**
 * The nearest palette index to a color, measured in Oklab.
 *
 * At level 2 the candidates are `16`-`255`, the cube and the grey ramp, and at
 * level 1 they are `0`-`15`. Level 2 never lands on the sixteen because they are
 * whatever the user's theme says they are, so landing a fixed color on one would
 * make the answer depend on a setting nothing here can read; at level 1 there is
 * no choice. A tie goes to the lower index.
 *
 * @param red - The red channel, 0-255.
 * @param green - The green channel, 0-255.
 * @param blue - The blue channel, 0-255.
 * @param level - `1` for the basic sixteen, `2` for the 256-color palette.
 * @returns The palette index.
 */
export function nearestPaletteIndex(
  red: number,
  green: number,
  blue: number,
  level: 1 | 2
): number {
  table ??= Array.from({ length: 256 }, (_, i) => oklab(paletteRgb(i)));

  const [l, a, b] = oklab([red, green, blue]);
  const from = level === 2 ? 16 : 0;
  const to = level === 2 ? 256 : 16;
  let best = from;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (let i = from; i < to; i++) {
    const t = table[i]!;
    const d = (l - t[0]) ** 2 + (a - t[1]) ** 2 + (b - t[2]) ** 2;
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }

  return best;
}
