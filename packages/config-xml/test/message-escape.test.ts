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

/**
 * What a read refuses over a document whose own text is what the message quotes
 * (SIG-570).
 *
 * The file path was escaped by SIG-551 and the key by SIG-558, and the names a
 * document holds were left. An XML name may hold U+200C and U+200D -- the `Name`
 * production allows them, and so does `xmldom`, which also takes U+FEFF, U+061C and
 * the tag characters -- so a name is the one value in these messages a file can
 * fill with something `escapeControls()` changes. A control
 * character cannot be in a name -- `xmldom` refuses it, or reads it as the end of
 * the name and the store refuses the document before that (SIG-581) -- so what a
 * name holds is an invisible character, never an escape sequence.
 */

/** The zero-width non-joiner, which a name may hold and which prints as nothing. */
const ZWNJ = '\u200C';

/** What `escapeControls()` makes of it, inside a message. */
const ZWNJ_ESCAPED = '\\u{200C}';

/** The message of what a read of `text` throws. */
function readSaid(text: string): string {
  return said(() => xml(file(text)).readSync());
}

describe('an xml read refused for a name with an invisible character in it', () => {
  // each case puts a different marker in the element and in the name, so that
  // removing the escape on either placeholder fails by itself
  it('should be escaped when an element has text beside its children', () => {
    const refused = readSaid(`<config><el${ZWNJ}>t<k>1</k></el${ZWNJ}></config>`);

    expect(refused).toContain(`<el${ZWNJ_ESCAPED}>`);
    expect(refused).not.toContain(ZWNJ);
  });

  it('should be escaped when two attributes share a name under different prefixes', () => {
    const refused = readSaid(
      `<config xmlns:n="u" xmlns:m="v"><el${ZWNJ} n:at${ZWNJ}="1" m:at${ZWNJ}="2"/></config>`
    );

    expect(refused).toContain(`<el${ZWNJ_ESCAPED}>`);
    expect(refused).toContain(`"at${ZWNJ_ESCAPED}"`);
    expect(refused).not.toContain(ZWNJ);
  });

  it('should be escaped when a name is both an attribute and a child element', () => {
    const refused = readSaid(
      `<config><el${ZWNJ} at${ZWNJ}="1"><at${ZWNJ}>2</at${ZWNJ}></el${ZWNJ}></config>`
    );

    expect(refused).toContain(`<el${ZWNJ_ESCAPED}>`);
    expect(refused).toContain(`"at${ZWNJ_ESCAPED}"`);
    expect(refused).not.toContain(ZWNJ);
  });

  it('should be escaped when children share a name under more than one prefix', () => {
    const refused = readSaid(
      `<config xmlns:n="u" xmlns:m="v"><el${ZWNJ}><n:at${ZWNJ}>1</n:at${ZWNJ}><m:at${ZWNJ}>2</m:at${ZWNJ}></el${ZWNJ}></config>`
    );

    expect(refused).toContain(`<el${ZWNJ_ESCAPED}>`);
    expect(refused).toContain(`"at${ZWNJ_ESCAPED}"`);
    expect(refused).not.toContain(ZWNJ);
  });
});

describe('an xml store refused for the root the app named', () => {
  it('should escape a root that is not a usable name', () => {
    const refused = said(() => xml(file('<config/>'), { root: HOSTILE }));

    expect(refused).toContain(ESCAPED);
    expect(refused.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    expect(refused.split('\n').some((line) => line.startsWith('forged: error'))).toBe(false);
  });
});

describe('an xml read of a declared encoding with a control character in it', () => {
  // the parser refuses a declaration whose encoding is not a name before the
  // store's own check reads it, so the `escapeControls()` on that message is a
  // defence that no document reaches today. What is pinned is the property, by
  // whichever of the two refuses
  it('should never reach the message raw', () => {
    for (const encoding of [HOSTILE, `x${ZWNJ}y`]) {
      const refused = readSaid(`<?xml version="1.0" encoding="${encoding}"?><config/>`);

      expect(refused.replaceAll('\n', '')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    }
  });
});
