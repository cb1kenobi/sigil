import * as errorHandlerEntry from '../src/error-handler.js';
import { errorExitCode, errorHandler, main, UsageError } from '../src/index.js';
import { parse } from '../src/parser/parse.js';
import { runCommand } from '../src/testing/index.js';
import type { Schema } from '../src/types.js';
import { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
});

/** What a parse threw, which is the `UsageError` or whatever else it was. */
async function thrown(argv: string[], schema: Schema, settings = {}): Promise<unknown> {
  try {
    await parse({ argv, env: process.env, schema, settings });
  } catch (err) {
    return err;
  }
  throw new Error('expected the parse to throw');
}

const app: Schema = {
  commands: {
    build: {
      args: ['<entry>', '[extra]'],
      options: {
        '--mode [name]': { choices: ['dev', 'prod'] },
        '--port [n]': { env: 'APP_PORT', type: 'int' },
        '--target <name>': {},
      },
      run: () => 'built',
    },
  },
  name: 'mycli',
};

describe('a usage error, which is what the user got wrong', () => {
  it.each([
    ['unknown-option', ['build', 'a', '--target', 't', '--nope'], { allowUnknownOptions: false }],
    ['unexpected-argument', ['bogus'], {}],
    ['missing-argument', ['build', '--target', 't'], {}],
    ['missing-option', ['build', 'a'], {}],
    ['missing-value', ['build', 'a', '--target'], {}],
    ['invalid-value', ['build', 'a', '--target', 't', '--port', 'eight'], {}],
    ['invalid-value', ['build', 'a', '--target', 't', '--mode', 'staging'], {}],
    [
      'extra-arguments',
      ['build', 'a', '--target', 't', '--', 'more'],
      { allowExtraArguments: false },
    ],
  ])('should be a UsageError of kind %s', async (code, argv, settings) => {
    const err = await thrown(argv, app, settings);

    expect(err).toBeInstanceOf(UsageError);
    expect(err).toBeInstanceOf(Error);
    expect((err as UsageError).code).toBe(code);
    expect((err as UsageError).name).toBe('UsageError');
    expect(errorExitCode(err)).toBe(2);
  });

  it('should say a value from the environment is a usage error and a default is not', async () => {
    vi.stubEnv('APP_PORT', 'eight');
    const env = await thrown(['build', 'a', '--target', 't'], app);

    expect(env).toBeInstanceOf(UsageError);
    expect((env as UsageError).code).toBe('invalid-value');

    // a default the type rejects is the schema's own mistake: nobody typed it
    vi.unstubAllEnvs();
    const bad = await thrown(['x'], {
      commands: { x: { options: { '--n [n]': { default: 'eight', type: 'int' } }, run() {} } },
      name: 'mycli',
    });

    expect(bad).not.toBeInstanceOf(UsageError);
    expect((bad as Error).message).toBe('Invalid integer: eight');
  });

  it('should keep what a coercion said, and hand it on as the cause', async () => {
    const err = (await thrown(['build', 'a', '--target', 't', '--port', 'eight'], app)) as Error;

    expect(err.message).toBe('Invalid integer: eight');
    expect((err.cause as Error).message).toBe('Invalid integer: eight');
  });

  it('should be what `help` raises for a command that is not there', async () => {
    const err = await thrown(['help', 'buidl'], app);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe('unknown-command');
  });

  it('should be what a format the command does not present raises', async () => {
    const err = await thrown(['list', '--format', 'yaml'], {
      commands: { list: { format: true, run: () => ({}) } },
      name: 'mycli',
    } as never);

    expect(err).toBeInstanceOf(UsageError);
    expect((err as UsageError).code).toBe('unsupported-format');
  });
});

describe('a crash, which is not', () => {
  it('should stay a plain error and exit 1 when run() throws', async () => {
    const ran = await runCommand({
      argv: ['go'],
      schema: {
        commands: {
          go: {
            run() {
              const missing = null as unknown as { x: { y: number } };
              return missing.x.y;
            },
          },
        },
        name: 'mycli',
      },
    });

    expect(ran.error).toBeInstanceOf(TypeError);
    expect(ran.error).not.toBeInstanceOf(UsageError);
    expect(ran.code).toBe(1);
  });

  it('should stay a plain error and exit 1 when the schema is invalid', async () => {
    const err = await thrown([], { commands: { x: { alias: 3 as never, run() {} } } });

    expect(err).not.toBeInstanceOf(UsageError);
    expect(errorExitCode(err)).toBe(1);
  });

  it('should not be guessed at when a transform throws a plain Error', async () => {
    const ran = await runCommand({
      argv: ['--n', '3'],
      schema: {
        name: 'mycli',
        options: {
          '--n <n>': {
            transform() {
              throw new Error('refused');
            },
          },
        },
      },
    });

    expect(ran.error).not.toBeInstanceOf(UsageError);
    expect(ran.code).toBe(1);
  });
});

describe('what an app and a hook can do with one', () => {
  it('should be thrown by an app for its own bad invocation, and exit 2 without a stack', async () => {
    const ran = await runCommand({
      argv: ['--n', '3'],
      schema: {
        name: 'mycli',
        options: {
          '--n <n>': {
            transform() {
              throw new UsageError('Port 3 is reserved', 'invalid-value');
            },
          },
        },
      },
    });

    expect(ran.err).toBe('Error: Port 3 is reserved\n');
    expect(ran.code).toBe(2);
  });

  it('should reach a beforeError hook as an instance a hook can ask', async () => {
    const seen: unknown[] = [];
    const ran = await runCommand({
      argv: ['build'],
      schema: {
        ...app,
        hooks: {
          beforeError(err) {
            seen.push(err instanceof UsageError ? (err as UsageError).code : 'crash');
          },
        },
      },
    });

    expect(seen).toEqual(['missing-argument']);
    expect(ran.code).toBe(2);
  });

  it('should let a hook change the exit code of one error', async () => {
    const ran = await runCommand({
      argv: ['build'],
      schema: {
        ...app,
        hooks: {
          beforeError(err) {
            (err as UsageError).exitCode = 64;
          },
        },
      },
    });

    expect(ran.code).toBe(64);
  });

  it('should serialize its code beside its name, and a crash without one', async () => {
    const schema = {
      commands: {
        crash: {
          format: true,
          run() {
            throw new TypeError('boom');
          },
        },
        list: { format: true, options: { '--req <r>': {} }, run: () => 1 },
      },
      name: 'mycli',
    } as never;

    const usage = await runCommand({ argv: ['list', '--json'], schema });
    expect(JSON.parse(usage.err)).toEqual({
      error: {
        code: 'missing-option',
        message: 'Missing required options: --req',
        name: 'UsageError',
      },
    });
    expect(usage.code).toBe(2);

    const crash = await runCommand({ argv: ['crash', '--json'], schema });
    expect(JSON.parse(crash.err)).toEqual({ error: { message: 'boom', name: 'TypeError' } });
    expect(crash.code).toBe(1);
  });
});

describe('where it is published', () => {
  it('should be the same class from the root and from the error handler entry', () => {
    expect(errorHandlerEntry.UsageError).toBe(UsageError);
    expect(typeof main).toBe('function');
  });

  it('should render as its message, with no stack, through the built-in handler', () => {
    const chunks: string[] = [];
    const stderr = new Writable({
      write(chunk, _enc, cb) {
        chunks.push(String(chunk));
        cb();
      },
    }) as unknown as NodeJS.WritableStream;
    const before = process.exitCode;

    errorHandler(new UsageError('Missing required options: --x', 'missing-option'), { stderr });

    expect(chunks.join('')).toBe('Error: Missing required options: --x\n');
    expect(process.exitCode).toBe(2);
    process.exitCode = before;
  });
});
