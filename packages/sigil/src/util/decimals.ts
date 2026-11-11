/**
 * How many digits follow the point when a number is written out, so that a sum
 * of steps can be rounded back to what the steps could add up to.
 *
 * Read off `String(value)`, which is how JavaScript writes a number, and the
 * exponent form counts: `1e-7` is seven places and `1.5e-7` eight, while
 * `1e+21` is none. A value with no digits to count -- `NaN` and either
 * infinity -- is none too.
 *
 * `number()` and `Slider` both asked this, one with a regex and one by
 * splitting, and the two agreed on every input tried (SIG-366), so this is the
 * one of them. It is a leaf rather than either module's, so that a slider does
 * not load a prompt stack to count digits; it is published from
 * `@ttylabs/sigil/components/slider`.
 *
 * @param value - The number.
 * @returns How many decimal places it is written with.
 */
export function decimalPlaces(value: number): number {
  const [mantissa = '', exponent] = String(value).split('e');
  const places = mantissa.split('.')[1]?.length ?? 0;
  return Math.max(0, places - Number(exponent ?? 0));
}
