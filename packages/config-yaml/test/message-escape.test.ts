import { yaml } from '../src/index.js';
import { file } from './helpers.js';
import { createConfigSync } from '@ttylabs/sigil/config';
import { describe, expect, it } from 'vitest';

/**
 * A key path in a message is escaped where the store builds it (SIG-558).
 *
 * The path of a write is what an app handed `config.set()`, which is often what a
 * user typed, so a refusal that names it must not carry a control character to the
 * terminal. The file here has an ordinary name: nothing in this file is about the
 * path of the file, which SIG-551 covered, so it runs on every platform.
 */

/** A window retitle, and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

/** Asserts a message names the path escaped and holds nothing a terminal acts on. */
function expectInert(message: string): void {
  expect(message).toContain(ESCAPED);
  expect(message.replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
  expect(message.split('\n').some((line) => line.startsWith('forged: error'))).toBe(false);
}

/** The message of whatever `work` throws. */
function said(work: () => unknown): string {
  try {
    work();
  } catch (error) {
    return (error as Error).message;
  }

  throw new Error('expected it to refuse');
}

/** A config over one yaml layer. */
function over(path: string): ReturnType<typeof createConfigSync> {
  return createConfigSync({ layers: [{ name: 'base', store: yaml(path), lossy: true }] });
}

/** A document whose key is the hostile one, spelled as a YAML double-quoted scalar. */
const KEY = JSON.stringify(HOSTILE);

describe('a yaml write refused for a key path with a control character in it', () => {
  it('should be escaped when the node carries an anchor another node aliases', () => {
    const store = yaml(file(`${KEY}:\n  host: &k example.com\nother: *k\n`));

    expectInert(said(() => store.writeSync({ [HOSTILE]: 5, other: 'example.com' })));
  });

  it('should be escaped when the key is the one carrying the anchor', () => {
    const store = yaml(file(`&k ${KEY}: 1\nother: *k\n`));

    expectInert(said(() => store.writeSync({ other: HOSTILE })));
  });

  it('should be escaped when it comes from a merge key', () => {
    const config = over(file(`base: &b\n  ${KEY}: 1\nc:\n  <<: *b\n  q: 2\n`));

    config.delete(`c.${HOSTILE}`);
    expectInert(said(() => config.saveSync()));
  });

  it('should be escaped when a remove would take a key that carries an anchor', () => {
    const config = over(file(`c:\n  &k ${KEY}: 1\nother: *k\n`));

    config.delete(`c.${HOSTILE}`);
    expectInert(said(() => config.saveSync()));
  });

  it('should be escaped when the value would not read back as itself', () => {
    const store = yaml(file(`${KEY}: !!str 5\n`));
    const refused = said(() => store.writeSync({ [HOSTILE]: 5 }));

    expectInert(refused);
  });
});

describe('a yaml write that cannot be held, for a key with a control character in it', () => {
  it('should be escaped when the document holds a function', () => {
    const store = yaml(file('a: 1\n'));

    expectInert(said(() => store.writeSync({ a: { [HOSTILE]: () => 1 } })));
  });
});

/**
 * What a read refuses over text the document itself holds (SIG-570).
 *
 * None of these can fail without the escape being removed, which is the finding
 * rather than an omission. A tag that survives resolution is one of the schema's
 * own, a plain integer's source is held to `[0-9]` or a `0x`/`0o` prefix by the
 * check that reaches the message, and a numeric key's source by `decimalOf()`'s
 * pattern; every other tag is `yaml`'s `Unresolved tag`, which `assertReadable()`
 * escapes where it throws it, whichever spelling reached it -- verbatim, through
 * a `%TAG` directive, or with a `%`-escape. So these pin the property over what
 * a file can put in each place, and the `escapeControls()` calls beside the
 * message sites are the defence for a `yaml` that one day resolves more.
 */

/** The zero-width non-joiner, which a tag may hold and which prints as nothing. */
const ZWNJ = '\u200C';

/** What a message may hold: no control character, and no invisible one. */
function expectPlain(message: string): void {
  expect(message.replaceAll('\n', '')).not.toMatch(/[\p{Cc}\p{Cf}]/u);
}

/** The message of what a read of `text` throws. */
function readSaid(text: string): string {
  return said(() => yaml(file(text)).readSync());
}

describe('a yaml read refused for text the document holds', () => {
  it('should hold no control character when a tag is outside the core schema', () => {
    for (const text of [
      `a: !<tag:x.com,2000:e${ZWNJ}x> 1\n`,
      `a: !<tag:x.com,2000:e${HOSTILE.replaceAll('\n', '')}x> 1\n`,
      `%TAG !e! tag:e${ZWNJ}.com,2000:\n---\na: !e!x 1\n`,
      'a: !e%E2%80%8Cx 1\n',
      'a: !e%1Bx 1\n',
    ]) {
      expectPlain(readSaid(text));
    }
  });

  it('should name a tag the schema resolves, and hold nothing else', () => {
    const refused = readSaid('a: !!set {x}\n');

    expect(refused).toContain('the tag tag:yaml.org,2002:set is outside');
    expectPlain(refused);
  });

  it('should hold no control character when an integer cannot be held', () => {
    expect(readSaid('a: 99999999999999999999\n')).toContain(
      'it would read back as 100000000000000000000'
    );
    expect(readSaid(`a: ${'9'.repeat(400)}\n`)).toContain('is larger than this runtime can hold');
    expect(readSaid('a: 9007199254740993\n')).toContain('the integer 9007199254740993 is not');
    expectPlain(readSaid('a: 9007199254740993\n'));
  });

  it('should hold no control character when a key is a different number or a collection', () => {
    expect(readSaid('9007199254740993.0: a\n')).toContain(
      'the mapping key 9007199254740993.0 names'
    );
    expect(readSaid('? [a]\n: 1\n')).toContain('a mapping key is a sequence');
    expectPlain(readSaid('9007199254740993.0: a\n'));
    expectPlain(readSaid('? [a]\n: 1\n'));
  });
});
