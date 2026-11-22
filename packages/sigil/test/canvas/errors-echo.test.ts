import { DEFAULT_STYLE, palette, resampleImage, rgb, StyleTable } from '../../src/canvas/index.js';
import { describe, expect, it } from 'vitest';

// what a config file or a command line could hand a helper in place of a number
// or a colour: a window-title sequence, which a terminal would act on if the
// message that quotes it were printed raw
const RAW = 'x\u001B]0;PWNED\u0007y';
const SAFE = 'x\\x1B]0;PWNED\\x07y';

/** The message a call threw, which must hold the safe spelling and no control character. */
function refusal(call: () => unknown, prefix: string): string {
  let message = '';
  try {
    call();
  } catch (error) {
    message = (error as Error).message;
  }
  expect(message, 'the call should have thrown').not.toBe('');
  expect(message.startsWith(prefix), message).toBe(true);
  expect(message).toContain(SAFE);
  expect(message).not.toContain(RAW);
  expect(message).not.toMatch(/\p{Cc}/u);
  return message;
}

describe('a canvas style error', () => {
  // a caller that takes a value from a config file passes it straight in, so none
  // of these may print what it was given as it arrived
  const bad = RAW as unknown as number;

  it('should escape the palette index it refuses', () => {
    refusal(() => palette(bad), 'Invalid palette index');
  });

  it('should escape the colour channel it refuses, whichever channel it is', () => {
    refusal(() => rgb(bad, 0, 0), 'Invalid red channel');
    refusal(() => rgb(0, bad, 0), 'Invalid green channel');
    refusal(() => rgb(0, 0, bad), 'Invalid blue channel');
  });

  it('should escape the attrs it refuses', () => {
    refusal(() => new StyleTable().intern({ attrs: bad }), 'Invalid style attrs');
  });

  it('should escape a link that is not a string', () => {
    const link = { toString: () => RAW } as unknown as string;
    refusal(() => new StyleTable().intern({ link }), 'Invalid style link');
  });

  it('should escape the colour it refuses, foreground and background', () => {
    refusal(() => new StyleTable().intern({ fg: bad }), 'Invalid style fg');
    refusal(() => new StyleTable().intern({ bg: bad }), 'Invalid style bg');
  });

  it('should still name what was wrong', () => {
    expect(() => palette(300)).toThrow('Invalid palette index 300');
    expect(() => rgb(0, 256, 0)).toThrow('Invalid green channel 256');
    expect(() => new StyleTable().intern({ ...DEFAULT_STYLE, attrs: -1 })).toThrow(
      'Invalid style attrs -1'
    );
  });
});

describe('a resample error', () => {
  const image = { data: new Uint8Array(16), height: 2, width: 2 };
  const bad = RAW as unknown as number;

  it('should escape the size it refuses', () => {
    refusal(() => resampleImage(image, bad, 1), 'Invalid resample size');
    refusal(() => resampleImage(image, 1, bad), 'Invalid resample size');
  });

  it('should escape each number of the rectangle it refuses', () => {
    const rect = { height: 1, width: 1, x: 0, y: 0 };
    for (const key of ['x', 'y', 'width', 'height'] as const) {
      refusal(
        () => resampleImage(image, 1, 1, { ...rect, [key]: bad }),
        'Invalid resample rectangle'
      );
    }
  });
});
