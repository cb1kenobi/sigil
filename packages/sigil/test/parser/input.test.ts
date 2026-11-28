/**
 * Values given as data rather than as argv, which is how a tool call reaches a
 * command (SIG-721): keyed by destination, judged as a typed value is, and never
 * turned back into tokens.
 */

import { main } from '../../src/index.js';
import { parse } from '../../src/parser/parse.js';
import type { Schema } from '../../src/types.js';
import { UsageError } from '../../src/util/usage-error.js';
import { describe, expect, it } from 'vitest';

const schema: Schema = {
  commands: {
    go: {
      args: [{ name: '[n]', type: 'int' }, { name: '[word]' }],
      options: {
        '--mode [mode]': { choices: ['fast', 'slow'] },
        '--no-color': {},
        '--port [port]': { default: 80, env: 'PORT', type: 'int' },
        '--tag [tag]': { multiple: true },
        '--token <token>': {},
      },
      run() {},
    },
  },
  name: 'mycli',
};

/** The argv `go` gets for these values. */
async function argvOf(input: Record<string, unknown>, env: Record<string, string> = {}) {
  return (await parse({ argv: ['go'], env, input: { token: 't', ...input }, schema })).argv;
}

/** What a parse with these values rejects with. */
async function refusal(input: Record<string, unknown>): Promise<UsageError> {
  try {
    await parse({ argv: ['go'], env: {}, input: { token: 't', ...input }, schema });
  } catch (err) {
    return err as UsageError;
  }
  throw new Error('expected a refusal');
}

describe('input given as data', () => {
  it('should put a positional that starts with a dash on its argument, which argv cannot', async () => {
    // `mycli go -5` reads `-5` as an option; there is no way to type it as the
    // argument, and that is the whole reason input is not rebuilt as argv
    const argv = await argvOf({ n: -5, word: '--not-an-option' });
    expect(argv.n).toBe(-5);
    expect(argv.word).toBe('--not-an-option');
  });

  it('should judge a value by checkValue(), so a string still coerces', async () => {
    expect((await argvOf({ port: 8080 })).port).toBe(8080);
    expect((await argvOf({ port: '8080' })).port).toBe(8080);

    const err = await refusal({ port: 1.5 });
    expect(err).toBeInstanceOf(UsageError);
    expect(err.code).toBe('invalid-value');
  });

  it("should hold a value to the declaration's choices", async () => {
    expect((await argvOf({ mode: 'fast' })).mode).toBe('fast');
    expect((await refusal({ mode: 'warp' })).code).toBe('invalid-value');
  });

  it('should satisfy a required option, and refuse a key nothing declares', async () => {
    // `token` is required and is given by every call here
    expect((await argvOf({})).token).toBe('t');
    const err = await refusal({ nope: 1 });
    expect(err.code).toBe('unknown-option');
    expect(err.message).toBe('Unknown option "nope"');
  });

  it('should outrank the environment and a default, as a typed value does', async () => {
    expect((await argvOf({}, { PORT: '9000' })).port).toBe(9000);
    expect((await argvOf({ port: 1234 }, { PORT: '9000' })).port).toBe(1234);
    expect((await argvOf({})).port).toBe(80);
  });

  it('should collect a repeatable option as a list, a single value included', async () => {
    expect((await argvOf({ tag: ['a', 'b'] })).tag).toEqual(['a', 'b']);
    expect((await argvOf({ tag: 'a' })).tag).toEqual(['a']);
  });

  it('should write a negated flag through the destination it shares', async () => {
    expect((await argvOf({})).color).toBe(true);
    expect((await argvOf({ color: false })).color).toBe(false);
    expect((await refusal({ color: 'nope' })).code).toBe('invalid-value');
  });

  it('should reach the command through main(), with its run() seeing the values', async () => {
    let seen: Record<string, unknown> | undefined;
    await main({
      argv: ['go'],
      input: { n: -1, token: 'x' },
      schema: {
        ...schema,
        commands: {
          go: {
            ...(schema.commands as Record<string, object>).go,
            run({ argv }: { argv: Record<string, unknown> }) {
              seen = argv;
            },
          },
        },
      },
      settings: { errorHandler: false },
    });
    expect(seen).toMatchObject({ n: -1, token: 'x' });
  });
});
