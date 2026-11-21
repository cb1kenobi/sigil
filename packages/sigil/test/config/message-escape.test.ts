import {
  atPath,
  overlay,
  createConfigSync,
  object,
  segments,
  type Config,
  type ConfigLayer,
  type ConfigSchema,
  type ConfigStore,
} from '../../src/config/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A config error echoes a key path, a layer name or a setting path, and every one
 * of them can be what somebody typed (SIG-558).
 *
 * An app with `config set <path> <value>` hands argv straight to `set()`, so the
 * path in `"${path}" in ${layer.name} is not a list` is whatever the user wrote;
 * a layer named after its file path, or taken from argv, is the same. The rule is
 * the parser's -- a value an error echoes is escaped where it is thrown -- and
 * the thrower here is the merged view. SIG-551 did it for the file path a store
 * quotes; these are the other values a message holds.
 *
 * Pure unit tests with nothing on disk, so a control character in a fixture is
 * only a string and they run on every platform. Written with escapes and never
 * raw bytes, for the reason `sources.test.ts` exists.
 */

/** A window retitle, and a newline that would start a line the program never wrote. */
const HOSTILE = '\u001b]0;T\u0007\nforged: error';

/** What `escapeControls()` makes of it, inside a message. */
const ESCAPED = '\\x1B]0;T\\x07\\x0Aforged: error';

/** Asserts a message names the value escaped and holds nothing a terminal acts on. */
function expectInert(message: string): void {
  expect(message).toContain(ESCAPED);
  // every control character but the newline a message may be made of, and no line
  // that is the hostile one's forged second line
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

/** A config of one in-memory layer with the given name and value. */
function one(name: string, value: unknown = {}, extra: Partial<ConfigLayer> = {}): Config {
  return createConfigSync({ layers: [{ name, store: object(value), ...extra }] });
}

describe('a key path with a control character in it', () => {
  const path = `x.${HOSTILE}`;

  it('should be escaped when a segment is empty', () => {
    expectInert(said(() => segments(`a..${HOSTILE}`)));
    expectInert(said(() => one('base').set(`${HOSTILE}..b`, 1)));
  });

  it('should be escaped when a segment is not a safe key', () => {
    expectInert(said(() => segments(`${HOSTILE}.__proto__`)));
  });

  it('should be escaped when set() runs through a value that is not an object', () => {
    const config = one('base', { [HOSTILE]: 1 });

    expectInert(said(() => config.set(`${HOSTILE}.z`, 1)));
  });

  it('should be escaped when set() would reach into a list', () => {
    // the list is in another layer than the one written, so it is the second
    // refusal rather than the first
    const layered = createConfigSync({
      layers: [
        { name: 'lower', store: object({ [HOSTILE]: [1] }) },
        { name: 'upper', store: object({}) },
      ],
    });

    expectInert(said(() => layered.set(`${HOSTILE}.0`, 1)));
  });

  it('should be escaped when push() meets a value that is not a list', () => {
    const config = one('base', { [HOSTILE]: 'text' });

    expectInert(said(() => config.push(HOSTILE, 1)));
  });

  it('should be escaped when unshift() meets a value that is not a list', () => {
    const config = one('base', { [HOSTILE]: 'text' });

    expectInert(said(() => config.unshift(HOSTILE, 1)));
  });

  it('should be escaped when pop() and shift() meet a value that is not a list', () => {
    const config = one('base', { [HOSTILE]: 'text' });

    expectInert(said(() => config.pop(HOSTILE)));
    expectInert(said(() => config.shift(HOSTILE)));
  });

  it('should be escaped when push() is given nothing to add', () => {
    expectInert(said(() => one('base').push(path, undefined)));
  });

  it('should be escaped when a write to a named read-only layer is refused', () => {
    const config = one('base', {}, { readOnly: true });

    expectInert(said(() => config.set(path, 1, 'base')));
  });

  it('should be escaped when the store cannot hold the value', () => {
    const store: ConfigStore = { ...object({}), canRepresent: () => 'no' };
    const config = createConfigSync({ layers: [{ name: 'base', store }] });

    expectInert(said(() => config.set(HOSTILE, 1)));
  });

  it('should be escaped when a list of paths is a string', () => {
    expectInert(said(() => overlay({}, {}, HOSTILE, 'file')));
  });

  it('should be escaped in the path atPath() names', () => {
    expectInert(atPath('JSON has no bigint', HOSTILE));
  });
});

describe('a layer name with a control character in it', () => {
  it('should be escaped when a layer is declared twice', () => {
    const layer = { name: HOSTILE, store: object({}) };

    expectInert(said(() => createConfigSync({ layers: [layer, { ...layer }] })));
  });

  it('should be escaped when a layer has no readable store', () => {
    const store = { format: 'x' } as unknown as ConfigStore;

    expectInert(said(() => createConfigSync({ layers: [{ name: HOSTILE, store }] })));
  });

  it('should be escaped, and so should the names beside it, when a layer is unknown', () => {
    const config = createConfigSync({
      layers: [
        { name: HOSTILE, store: object({}) },
        { name: 'plain', store: object({}) },
      ],
    });

    const asked = said(() => config.set('a', 1, `${HOSTILE}2`));
    expectInert(asked);
    expect(asked).toContain(`"${ESCAPED}", "plain"`);
    expectInert(said(() => config.apply(`${HOSTILE}2`, {})));
    expectInert(said(() => config.saveSync(`${HOSTILE}2`)));
  });

  it('should be escaped when apply() is given something that is not an object', () => {
    expectInert(said(() => one(HOSTILE).apply(HOSTILE, 'text')));
  });

  it('should be escaped when a write is refused for a read-only layer', () => {
    expectInert(said(() => one(HOSTILE, {}, { readOnly: true }).set('a', 1, HOSTILE)));
  });

  it('should be escaped when save() names a layer that is read-only or cannot write', () => {
    expectInert(said(() => one(HOSTILE, {}, { readOnly: true }).saveSync(HOSTILE)));

    const store: ConfigStore = {
      format: `x${String.fromCodePoint(0x202e)}y`,
      read: object().read,
      readSync: object().readSync,
    };
    const config = createConfigSync({ layers: [{ name: HOSTILE, store }] });
    const refused = said(() => config.saveSync(HOSTILE));

    expectInert(refused);
    expect(refused).toContain('x\\u{202E}y');
  });

  it('should be escaped when the path is not an object in it', () => {
    expectInert(said(() => one(HOSTILE, { x: 1 }).set('x.y', 1)));
  });

  it('should be escaped when a list is not a list in it', () => {
    expectInert(said(() => one(HOSTILE, { x: 1 }).push('x', 1)));
  });

  it('should be escaped when its store answers with something that is not an object', () => {
    expectInert(said(() => one(HOSTILE, [1, 2])));
  });

  it('should be escaped when its store cannot hold a value', () => {
    const store: ConfigStore = { ...object({}), canRepresent: () => 'no' };
    const config = createConfigSync({ layers: [{ name: HOSTILE, store }] });

    expectInert(said(() => config.set('a', 1)));
  });

  it('should be escaped when a write would lose what its store cannot carry', () => {
    const inner = object({});
    const store: ConfigStore = {
      ...inner,
      readSync: () => ({ value: {}, wouldLose: [{ kind: HOSTILE, detail: HOSTILE, line: 3 }] }),
    };
    const config = createConfigSync({ layers: [{ name: HOSTILE, store }] });

    config.set('a', 1);
    const refused = said(() => config.saveSync());

    // the layer, the kind and the detail are three echoes of one rule
    expectInert(refused);
    expect(refused.split(ESCAPED).length).toBeGreaterThanOrEqual(4);
  });

  it('should be escaped when a read-only layer is the one a delete would need', () => {
    const config = createConfigSync({
      layers: [
        { name: HOSTILE, store: object({ a: 1 }), readOnly: true },
        { name: 'top', store: object({}) },
      ],
    });

    expectInert(said(() => config.delete('a')));
  });

  it('should be escaped when a source is not a file path', () => {
    const errors: string[] = [];
    const store: ConfigStore = { ...object({}), source: 'https://example.com/x' };
    const config = createConfigSync({
      layers: [{ name: HOSTILE, store }],
      watch: { onError: (e) => errors.push((e as Error).message) },
    });

    const stop = config.watch(() => {});
    stop();

    expect(errors).toHaveLength(1);
    expectInert(errors[0] as string);
  });
});

describe('a setting path with a control character in it', () => {
  const declare = (schema: unknown): ConfigSchema => schema as ConfigSchema;
  const build = (schema: unknown, value: unknown = {}): Config =>
    createConfigSync({ layers: [{ name: 'base', store: object(value) }], schema: declare(schema) });

  it('should be escaped when the setting is not an object', () => {
    expectInert(said(() => build({ [HOSTILE]: 'text' })));
  });

  it('should be escaped when it is not a usable path', () => {
    expectInert(said(() => build({ [`${HOSTILE}..x`]: {} })));
  });

  it('should be escaped when its data type is unsupported, and so should the type', () => {
    const refused = said(() => build({ [HOSTILE]: { type: HOSTILE } }));

    expect(refused.split(ESCAPED).length).toBe(3);
    expectInert(refused);
  });

  it('should be escaped when its choices are not an array', () => {
    expectInert(said(() => build({ [HOSTILE]: { choices: 'a' } })));
  });

  it('should be escaped when its merge is not one the schema knows', () => {
    expectInert(said(() => build({ [HOSTILE]: { merge: 'x' } })));
  });

  it('should be escaped when its env is not a variable name', () => {
    expectInert(said(() => build({ [HOSTILE]: { env: 3 } })));
  });

  it('should be escaped when one setting is inside another', () => {
    const refused = said(() => build({ [HOSTILE]: {}, [`${HOSTILE}.inner`]: {} }));

    expect(refused.split(ESCAPED).length).toBe(3);
    expectInert(refused);
  });

  it('should be escaped when a layer holds a value the setting refuses', () => {
    expectInert(said(() => build({ [HOSTILE]: { type: 'int' } }, { [HOSTILE]: 'text' })));
  });

  it('should be escaped when a value is not one of the setting choices', () => {
    const refused = said(() => build({ [HOSTILE]: { choices: ['a'] } }, { [HOSTILE]: 'b' }));

    expectInert(refused);
  });

  it('should be escaped when a list was declared and a scalar was written', () => {
    expectInert(said(() => build({ [HOSTILE]: { multiple: true } }, { [HOSTILE]: 'b' })));
  });
});
