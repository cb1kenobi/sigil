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
