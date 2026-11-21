import { xml } from '../src/index.js';
import { file } from './helpers.js';
import { describe, expect, it } from 'vitest';

/**
 * A key in a message is escaped where the store builds it (SIG-558).
 *
 * `apply()` then `save()` reaches the store with a whole document and no early
 * `canRepresent()` answer in front of it, so the refusal the store builds names a
 * key an app or a user supplied. The file has an ordinary name, so this runs on
 * every platform.
 */

/** A window retitle, and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

/** The message of whatever `work` throws. */
function said(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

describe('an xml write refused for a key with a control character in it', () => {
  it('should be escaped when the key is not an element name', () => {
    const refused = said(() => xml(file('<config><a>1</a></config>')).writeSync({ [HOSTILE]: 1 }));

    expect(refused).toContain(ESCAPED);
    expect(refused.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    expect(refused.split('\n').some((line) => line.startsWith('forged: error'))).toBe(false);
  });
});
