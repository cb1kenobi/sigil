import { cellWidth } from '../../src/canvas/buffer.js';
import { graphemes, graphemeWidth, stringWidth } from '../../src/width/index.js';
import { truncate, wrap } from '../../src/wrap/index.js';
import { describe, expect, it } from 'vitest';

// SIG-359. A text-default base turned into an emoji by a skin tone, or joined
// to another pictograph by a ZWJ without any VS16, was summed per code point
// -- 1 + 2 = 3 -- while the canvas clamped the same cluster to 2, so layout,
// wrap() and truncate() budgeted a column the canvas never painted.

const TONE = '\u{1F3FD}'; // emoji modifier fitzpatrick type-4

// the nine Emoji_Modifier_Base characters that are text by default, each with
// a tone: every one is a fully-qualified RGI sequence
const TONED: Record<string, string> = {
  'U+261D': `\u{261D}${TONE}`, // index pointing up
  'U+26F9': `\u{26F9}${TONE}`, // person bouncing ball
  'U+270C': `\u{270C}${TONE}`, // victory hand
  'U+270D': `\u{270D}${TONE}`, // writing hand
  'U+1F3CB': `\u{1F3CB}${TONE}`, // person lifting weights
  'U+1F3CC': `\u{1F3CC}${TONE}`, // person golfing
  'U+1F574': `\u{1F574}${TONE}`, // person in suit levitating
  'U+1F575': `\u{1F575}${TONE}`, // detective
  'U+1F590': `\u{1F590}${TONE}`, // hand with fingers splayed
};

// ZWJ sequences written without the VS16 their fully-qualified forms carry
const JOINED: Record<string, string> = {
  'rainbow flag': '\u{1F3F3}\u{200D}\u{1F308}',
  'heart on fire': '\u{2764}\u{200D}\u{1F525}',
  'mending heart': '\u{2764}\u{200D}\u{1FA79}',
  'broken chain': '\u{26D3}\u{200D}\u{1F4A5}',
  // two of them fully qualified, which were already right
  'rainbow flag with VS16': '\u{1F3F3}\u{FE0F}\u{200D}\u{1F308}',
  'heart on fire with VS16': '\u{2764}\u{FE0F}\u{200D}\u{1F525}',
  // a prepended character keeps the pair in one cluster (GB9b), and the
  // pictograph it comes ahead of is still joined
  'heart on fire after U+0600': '\u{0600}\u{2764}\u{200D}\u{1F525}',
};

// what must keep the width it had before SIG-359
const UNCHANGED: Record<string, [string, number]> = {
  digit: ['1', 1],
  'number sign': ['#', 1],
  asterisk: ['*', 1],
  'digit then a mark': ['1\u{0301}', 1],
  'digit then a ZWJ': ['1\u{200D}', 1],
  'number sign then a ZWJ': ['#\u{200D}', 1],
  'asterisk then text': ['*a', 2],
  'keycap without VS16': ['1\u{20E3}', 1],
  'keycap with VS16': ['1\u{FE0F}\u{20E3}', 2],
  'lone skin tone': [TONE, 2],
  'lone ZWJ': ['\u{200D}', 0],
  'lone VS16': ['\u{FE0F}', 0],
  'text-default pointing finger': ['\u{261D}', 1],
  'text-default heart': ['\u{2764}', 1],
  'text-default copyright': ['\u{A9}', 1],
  'text-default heart with VS15': ['\u{2764}\u{FE0E}', 1],
  'text-default heart then a mark': ['\u{2764}\u{0301}', 1],
  // a joiner with nothing after it joins nothing
  'copyright then a trailing ZWJ': ['\u{A9}\u{200D}', 1],
  'white flag then a trailing ZWJ': ['\u{1F3F3}\u{200D}', 1],
  // a tone after a mark is not next to the base
  'pointing finger, mark, tone': ['\u{261D}\u{0301}\u{1F3FD}', 3],
  'presentation emoji with a tone': ['\u{1F44D}\u{1F3FD}', 2],
};

// a tone after something it cannot modify is drawn as a swatch beside it, so
// the cluster is still the sum -- and the canvas still clamps it to two, which
// is the clamp `cellWidth()` documents for every cluster wider than a cell pair
const SWATCH: Record<string, string> = {
  'digit then a tone': `1${TONE}`,
  'number sign then a tone': `#${TONE}`,
  'letter then a tone': `a${TONE}`,
  'trade mark then a tone': `\u{2122}${TONE}`,
};

describe('a text-default emoji with a skin tone', () => {
  it.each(Object.entries(TONED))('should measure %s with a tone as two columns', (_, toned) => {
    expect(graphemes(toned)).toEqual([toned]);
    expect(stringWidth(toned)).toBe(2);
    expect(graphemeWidth(toned)).toBe(2);
    expect(cellWidth(toned)).toBe(2);
  });

  it('should measure it as wide as an emoji-presentation base with the same tone', () => {
    expect(stringWidth(`\u{1F44D}${TONE}`)).toBe(2);
    expect(stringWidth(`\u{270C}${TONE}`)).toBe(stringWidth(`\u{1F44D}${TONE}`));
  });

  it('should measure every tone, not only the one the ticket used', () => {
    for (let tone = 0x1f3fb; tone <= 0x1f3ff; tone++) {
      expect(stringWidth(`\u{261D}${String.fromCodePoint(tone)}`)).toBe(2);
    }
  });

  it('should wrap it as it wraps an emoji-presentation base', () => {
    expect(wrap(`ok ${`\u{1F44D}${TONE}`.repeat(3)}`, 9)).toBe(
      `ok ${`\u{1F44D}${TONE}`.repeat(3)}`
    );
    expect(wrap(`ok ${`\u{270C}${TONE}`.repeat(3)}`, 9)).toBe(`ok ${`\u{270C}${TONE}`.repeat(3)}`);
  });

  it('should truncate it as it truncates an emoji-presentation base', () => {
    const toned = `\u{270C}${TONE}`.repeat(3);
    expect(truncate(toned, 6)).toBe(toned);
    expect(truncate(toned, 5, 'clip')).toBe(`\u{270C}${TONE}`.repeat(2));
  });
});

describe('an unqualified ZWJ emoji', () => {
  it.each(Object.entries(JOINED))('should measure the %s as two columns', (_, joined) => {
    expect(graphemes(joined)).toEqual([joined]);
    expect(stringWidth(joined)).toBe(2);
    expect(cellWidth(joined)).toBe(2);
  });
});

describe('what the skin tone and ZWJ rules must not widen', () => {
  it.each(Object.entries(UNCHANGED))('should measure %s as it did', (_, [text, width]) => {
    expect(stringWidth(text)).toBe(width);
  });

  it.each(Object.entries(SWATCH))('should measure a %s as the sum', (_, text) => {
    expect(graphemes(text)).toEqual([text]);
    expect(stringWidth(text)).toBe(3);
    expect(cellWidth(text)).toBe(2);
  });
});

describe('stringWidth() and cellWidth()', () => {
  // every single-cluster case above that fits a cell pair
  const clusters = [
    ...Object.values(TONED),
    ...Object.values(JOINED),
    ...Object.values(UNCHANGED)
      .map(([text]) => text)
      .filter((text) => graphemes(text).length === 1 && stringWidth(text) <= 2),
  ];

  it('should agree on every cluster the canvas can hold whole', () => {
    expect(clusters.length).toBeGreaterThan(25);
    for (const cluster of clusters) {
      expect(cellWidth(cluster), cluster).toBe(stringWidth(cluster));
    }
  });
});
