/** Three or six hex digits, and nothing else: no `#`, no alpha, no whitespace. */
const HEX_DIGITS = /^(?:[\da-f]{3}|[\da-f]{6})$/i;

/**
 * Hex digits as channels: `abc` and `aabbcc` are both `[170, 187, 204]`.
 *
 * The digits only, and `undefined` rather than a throw for anything that is not
 * three or six of them. That is the whole of what the package's hex readers
 * share -- `ansi.hex()`, a stylesheet's `parseColor()` and the screenshot
 * package's colour options -- and everything else is each caller's own rule:
 * whether the `#` is optional or required, whether the text is trimmed first,
 * and which error says it was wrong. Taking the `#` here would decide the first
 * of those for all three, which is why it is left to them.
 *
 * Three digits are doubled, so `#abc` is `#aabbcc` and not `#0a0b0c`. Four and
 * eight digits -- CSS's alpha forms -- are not hex here, because no cell has an
 * alpha channel to put the fourth in and no caller has ever taken them.
 *
 * @param digits - The digits, with any `#` already taken off.
 * @returns The red, green and blue channels on 0-255, or `undefined`.
 */
export function hexChannels(digits: string): [number, number, number] | undefined {
  if (!HEX_DIGITS.test(digits)) {
    return undefined;
  }
  const full = digits.length === 3 ? digits.replaceAll(/./g, '$&$&') : digits;
  const int = Number.parseInt(full, 16);
  return [(int >> 16) & 0xff, (int >> 8) & 0xff, int & 0xff];
}
