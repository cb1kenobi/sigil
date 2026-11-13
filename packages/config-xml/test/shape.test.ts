import { shapeOf } from '../src/shape.js';
import { describe, expect, it } from 'vitest';

describe('the trailing run a file ends with', () => {
  it('should be the whole run, in whichever flavour it was written', () => {
    expect(shapeOf('<a/>\n').shape.trailing).toBe('\n');
    expect(shapeOf('<a/>\r\n\r\n').shape.trailing).toBe('\r\n\r\n');
    expect(shapeOf('<a/>\r\r').shape.trailing).toBe('\r\r');
    expect(shapeOf('<a>\n\n</a>\n').shape.trailing).toBe('\n');
    expect(shapeOf('<a/>').shape.trailing).toBeUndefined();
  });

  // SIG-342: `/[\n\r]+$/` is not anchored at its start, so an interior run of k
  // line ends is tried from each of its k positions -- k² steps for a run that
  // is not at the end at all. 200,000 is tens of seconds that way and well under
  // a millisecond with the lookbehind
  it('should not be quadratic in a run of blank lines inside the file', () => {
    const gap = '\n'.repeat(200_000);
    expect(shapeOf(`<a>${gap}</a>`).shape.trailing).toBeUndefined();
    expect(shapeOf(`<a>${gap}</a>\r\n`).shape.trailing).toBe('\r\n');
  });
});
