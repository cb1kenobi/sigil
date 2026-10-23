import { command } from '../../src/command.js';
import { runCommand } from '../../src/testing/command.js';
import type { AnyCommand, ParseState } from '../../src/types.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * `runCommand()`, which is `main()` with the three things it writes to the
 * process read back instead.
 *
 * What is asserted here is mostly *that it is `main()`*: help outranking a
 * missing required argument, `--version` answering before the command runs, and
 * a schema with commands and nothing named printing help are all decisions
 * `main()` took, and a helper that reimplemented any of them would be a second
 * answer to them. So those are the tests -- they would fail for a
 * reimplementation and they pass for free over the real thing, which is the
 * point.
 */

/** The exit code the worker had, so that a failing run never leaves one behind. */
afterEach(() => {
  expect(process.exitCode, 'a run left an exit code on the worker').toBeUndefined();
});

/**
 * A schema with one command, which is the shape `main()` dispatches.
 *
 * A **command** rather than a `run` on the schema itself, which was once the
 * only shape that worked: `main()` ran the command that *matched* and the root
 * is never one, so a schema carrying only a `run` parsed and then did nothing at
 * all. Measured while writing this file, reported, and fixed in SIG-150 -- a
 * root `run` is dispatched now, and `test/root-run.test.ts` is where that lives.
 * This stays a command because what it is here to exercise is dispatch by
 * **match**, which is the other half.
 *
 * @param over - What to change about the command.
 * @param schema - What to change about the schema around it.
 * @returns The schema.
 */
function app(
  over: Record<string, unknown> = {},
  schema: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    commands: {
      greet: {
        args: [{ name: '[who]' }],
        default: true,
        desc: 'Greet somebody',
        options: { '-v, --verbose': { type: 'bool' } },
        run({ argv }: ParseState) {
          process.stdout.write(`hello ${(argv.who as string) ?? 'world'}\n`);
        },
        ...over,
      },
    },
    desc: 'A demo',
    name: 'demo',
    ...schema,
  };
}

describe('runCommand()', () => {
  it('should report what the command wrote, and how it exited', async () => {
    const ran = await runCommand({ argv: ['chris'], schema: app() });

    expect(ran.out).toBe('hello chris\n');
    expect(ran.err).toBe('');
    expect(ran.code).toBe(0);
  });

  it('should report the values the parse produced', async () => {
    const ran = await runCommand({ argv: ['chris', '-v'], schema: app() });

    expect(ran.argv.who).toBe('chris');
    expect(ran.argv.verbose).toBe(true);
    expect(ran.state?.cmd?.name).toBe('greet');
  });

  it('should report the values even when the command returns one of its own', async () => {
    // `main()` returns `(await run()) ?? state`, so a command that returns
    // something hides the state -- which is why this reads it off the hook
    // rather than off the return
    const ran = await runCommand({
      argv: ['chris'],
      schema: app({ run: () => 'answered' }),
    });

    expect(ran.result).toBe('answered');
    expect(ran.argv.who).toBe('chris');
    expect(ran.state).toBeDefined();
  });

  it('should report a handled error on stderr, with the error itself', async () => {
    const ran = await runCommand({
      argv: [],
      schema: app({ args: [{ name: '<who>' }] }),
    });

    expect(ran.code).toBe(1);
    expect(ran.err).toContain('<who>');
    expect(ran.error).toBeInstanceOf(Error);
    expect((ran.error as Error).message).toContain('Missing required arguments');
    // and stdout is untouched, which is what a pipe consumer depends on
    expect(ran.out).toBe('');
  });

  it('should report the values a failing parse still produced', async () => {
    // `afterParse` fires after the values are written and before anything judges
    // them, so a *validation* failure still has an argv worth looking at --
    // which is most of what a test about a bad invocation wants to assert
    const ran = await runCommand({
      argv: [],
      schema: app({
        args: [{ name: '<who>' }],
        options: { '--port [n]': { default: '5', type: 'int' } },
      }),
    });

    expect(ran.code).toBe(1);
    expect(ran.argv.port).toBe(5);
    expect((ran.error as Error).message).toContain('<who>');
  });

  it('should report the state of a parse that threw before a value was written', async () => {
    // a value its type rejects throws while argv is still being walked, so
    // `afterParse` never fires at all and the `beforeError` wrap is the only
    // thing that reports a state. Measured: `afterParse` fires zero times here
    const ran = await runCommand({
      argv: ['--port', 'eight'],
      schema: app({ options: { '--port [n]': { type: 'int' } } }),
    });

    expect(ran.code).toBe(1);
    expect((ran.error as Error).message).toContain('Invalid integer');
    expect(ran.state).toBeDefined();
    // and `argv` is honestly empty: nothing had been written when it threw
    expect(ran.argv).toEqual({});
  });

  it('should restore the exit code the process had', async () => {
    // a failing run sets `process.exitCode`, and left alone that is the *test
    // runner's* exit code: a green suite that reports a crash. The `afterEach`
    // above is this said once for every test in the file
    const ran = await runCommand({ argv: [], schema: app({ args: [{ name: '<who>' }] }) });

    expect(ran.code).toBe(1);
    expect(process.exitCode).toBeUndefined();
  });

  it('should call a write callback, which a writer may be waiting on', async () => {
    // `process.stdout` is a stream and `write(chunk, cb)` is a shape a command
    // may use: swallowing the callback is how a writer that waits for drain
    // waits for ever, and the capture is standing in for the stream
    let called = false;
    const ran = await runCommand({
      argv: ['x'],
      schema: app({
        run() {
          process.stdout.write('done\n', () => void (called = true));
        },
      }),
    });

    expect(called).toBe(true);
    expect(ran.out).toBe('done\n');
  });

  it('should capture a Buffer a command wrote, not the word Object', async () => {
    const ran = await runCommand({
      argv: ['x'],
      schema: app({
        run() {
          process.stdout.write(Buffer.from('bytes\n', 'utf8'));
        },
      }),
    });

    expect(ran.out).toBe('bytes\n');
  });

  it('should decode a character a command wrote in two buffers', async () => {
    // a `write` takes a string or a `Buffer`, and a command writing buffers can
    // split one in the middle of a multi-byte character -- so decoding per chunk
    // puts a `U+FFFD` in what a test reads and the assertion is wrong about one
    // character. The same trap `runOnTerminal()` closes on the other side of a
    // pipe, met here because `process.stdout.write` takes the same two shapes
    const whole = Buffer.from('日', 'utf8');
    const ran = await runCommand({
      argv: ['x'],
      schema: app({
        run() {
          process.stdout.write(whole.subarray(0, 1));
          process.stdout.write(whole.subarray(1));
        },
      }),
    });

    expect(ran.out).toBe('日');
    expect(ran.out).not.toContain('\uFFFD');
  });

  it('should be runnable again after a schema that throws on the way in', async () => {
    // the latch is set before the caller's schema is read, so a property of
    // theirs that throws there would leave it set for the life of the process
    // and every later run would refuse with "already running"
    const schema = {
      get hooks(): never {
        throw new Error('from the getter');
      },
    };

    await expect(runCommand({ argv: ['x'], schema })).rejects.toThrow('from the getter');

    const ran = await runCommand({ argv: ['chris'], schema: app() });

    expect(ran.out).toBe('hello chris\n');
  });

  it('should capture a Uint8Array, which a stream also takes', async () => {
    // `Writable.write` accepts one and `Buffer.isBuffer` refuses it, so the
    // first version stored `String(chunk)` and a write of two bytes reached a
    // test as `"195,169"`
    const ran = await runCommand({
      argv: ['x'],
      schema: app({
        run() {
          process.stdout.write(new Uint8Array([0xc3, 0xa9]));
        },
      }),
    });

    expect(ran.out).toBe('é');
  });

  it('should honour the encoding a command wrote with', async () => {
    // `write('c3a9', 'hex')` puts `é` on the stream, so reading the string as
    // it came is reading the wrong text
    const ran = await runCommand({
      argv: ['x'],
      schema: app({
        run() {
          process.stdout.write('c3a9', 'hex');
        },
      }),
    });

    expect(ran.out).toBe('é');
  });

  it('should be runnable again after the read that saves the streams throws', async () => {
    // the other reachable shape of the latch leak, and the one the comment
    // claimed was covered while the three reads sat outside the `try`
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'write');
    Object.defineProperty(process.stdout, 'write', {
      configurable: true,
      get(): never {
        throw new Error('from the write getter');
      },
    });

    try {
      await expect(runCommand({ argv: ['x'], schema: app() })).rejects.toThrow(
        'from the write getter'
      );
    } finally {
      Object.defineProperty(process.stdout, 'write', original as PropertyDescriptor);
    }

    const ran = await runCommand({ argv: ['chris'], schema: app() });

    expect(ran.out).toBe('hello chris\n');
  });

  it('should put the streams back, so a later write is not captured', async () => {
    const before = process.stdout.write;

    const ran = await runCommand({ argv: ['x'], schema: app() });

    expect(process.stdout.write).toBe(before);

    // and the second half of the name, which was never done: a restore that put
    // back a *different* function that still captured would pass the identity
    // check and fail this. Written through a stub of the real stream, because
    // writing to the worker's own stdout is output in the middle of a run
    const seen: string[] = [];
    const stub = (chunk: unknown): boolean => {
      seen.push(String(chunk));
      return true;
    };
    process.stdout.write = stub as typeof process.stdout.write;
    try {
      process.stdout.write('after\n');
    } finally {
      process.stdout.write = before;
    }

    expect(seen).toEqual(['after\n']);
    expect(ran.out).not.toContain('after');
  });

  it('should put the streams back when the run throws', async () => {
    const before = process.stderr.write;

    // `errorHandler: false` means the caller handles it, so this rethrows rather
    // than swallowing -- a helper that caught it would be a second answer to
    // what that setting means
    await expect(
      runCommand({
        argv: ['x'],
        schema: app({
          run() {
            throw new Error('from the command');
          },
        }),
        settings: { errorHandler: false },
      })
    ).rejects.toThrow('from the command');

    expect(process.stderr.write).toBe(before);
  });

  it('should refuse to run two at once, which would interleave the capture', async () => {
    // `process.stdout.write` is process-wide, so two runs would each capture a
    // share of the other's output -- which is not a failure anybody would read
    // as one. Refused rather than queued: the fix is one word in the test file
    let inner: unknown;

    await runCommand({
      argv: ['x'],
      schema: app({
        async run() {
          inner = await runCommand({ argv: ['y'], schema: app() }).catch((e: unknown) => e);
        },
      }),
    });

    expect(inner).toBeInstanceOf(Error);
    expect((inner as Error).message).toContain('already running');
  });

  it('should be runnable again after a run that threw', async () => {
    await runCommand({
      argv: ['x'],
      schema: app({
        run() {
          throw new Error('nope');
        },
      }),
      settings: { errorHandler: false },
    }).catch(() => undefined);

    const ran = await runCommand({ argv: ['chris'], schema: app() });

    expect(ran.out).toBe('hello chris\n');
  });
});

describe('runCommand() is main(), not a reimplementation of it', () => {
  it('should print help rather than reporting the argument it is missing', async () => {
    // help wins over a missing required argument, because `mycli build --help`
    // is asking what `build` needs and "you did not say" is not an answer
    const ran = await runCommand({
      argv: ['--help'],
      schema: app({ args: [{ name: '<who>' }] }),
    });

    expect(ran.code).toBe(0);
    expect(ran.out).toContain('demo');
    expect(ran.err).toBe('');
  });

  it('should answer --version before the command runs', async () => {
    const ran = await runCommand({ argv: ['--version'], schema: app({}, { version: '1.2.3' }) });

    expect(ran.out).toBe('1.2.3\n');
    expect(ran.state?.version).toBe('1.2.3');
  });

  it('should print help for a schema that declares commands and was given none', async () => {
    const hello: AnyCommand = command({ desc: 'Say hello', run: () => undefined });
    const ran = await runCommand({
      argv: [],
      schema: { commands: { hello }, name: 'demo' },
    });

    // `main()` spreads the request into a copy rather than writing it onto the
    // state, so what says this happened is the screen rather than `state.help`
    expect(ran.out).toContain('hello');
    expect(ran.out).toContain('Commands:');
  });

  it('should dispatch a subcommand', async () => {
    const hello: AnyCommand = command({
      args: [{ name: '[who]' }],
      desc: 'Say hello',
      run({ argv }) {
        process.stdout.write(`hi ${(argv.who as string) ?? 'there'}\n`);
      },
    });

    const ran = await runCommand({
      argv: ['hello', 'chris'],
      schema: { commands: { hello }, name: 'demo' },
    });

    expect(ran.out).toBe('hi chris\n');
    expect(ran.state?.cmd?.name).toBe('hello');
  });
});

describe('runCommand() and the app the caller handed it', () => {
  it("should leave the caller's own hooks running", async () => {
    const seen: string[] = [];
    const hooks = {
      afterParse: () => void seen.push('afterParse'),
      beforeError: () => void seen.push('beforeError'),
    };

    await runCommand({ argv: ['x'], schema: app({}, { hooks }) });
    await runCommand({ argv: [], schema: app({ args: [{ name: '<who>' }] }, { hooks }) });

    expect(seen).toEqual(['afterParse', 'afterParse', 'beforeError']);
  });

  it('should let a beforeError hook replace the error it reports', async () => {
    const ran = await runCommand({
      argv: [],
      schema: app(
        { args: [{ name: '<who>' }] },
        {
          hooks: { beforeError: () => new Error('replaced') },
        }
      ),
    });

    // returning a value makes that value the error, which is what the hook is
    // for -- a helper that reported the original would be reporting something
    // the app under test never raised
    expect((ran.error as Error).message).toBe('replaced');
    expect(ran.err).toContain('replaced');
  });

  it("should still report the error when the app's own hook throws", async () => {
    // the framework logs and skips a hook that throws, so one of theirs failing
    // must not also cost this the error it was called about -- a run reporting
    // `undefined` for it would say the run did not fail
    const ran = await runCommand({
      argv: [],
      schema: app(
        { args: [{ name: '<who>' }] },
        {
          hooks: {
            beforeError: () => {
              throw new Error('the hook itself');
            },
          },
        }
      ),
    });

    expect(ran.code).toBe(1);
    expect((ran.error as Error).message).toContain('Missing required arguments');
    expect(ran.state).toBeDefined();
  });

  it('should report a null a beforeError hook returned, as the runtime does', async () => {
    // `fireBeforeError()`'s predicate is `result !== undefined`, so returning
    // `null` really does replace the error there -- and a `??` here reported the
    // original while `main()` rendered the replacement, which is one wrap
    // disagreeing with the runtime about the same return value
    const ran = await runCommand({
      argv: [],
      schema: app({ args: [{ name: '<who>' }] }, { hooks: { beforeError: () => null } }),
    });

    expect(ran.error).toBeNull();
    // and the message is the one the runtime renders for it, which is what says
    // the two agree rather than merely that this reported something
    expect(ran.err).toContain('Unknown error');
  });

  it('should leave an afterRun hook of theirs alone', async () => {
    // the wrap replaces `afterParse` and `beforeError` and spreads the rest, so
    // this holds by construction -- and "by construction" is exactly the kind of
    // claim this file exists to check rather than to state, because the wrap is
    // a copy and a hook deduped by **function identity** would stop firing if
    // the copy produced a different function. It does not: a spread copies the
    // reference
    const seen: string[] = [];
    const ran = await runCommand({
      argv: ['x'],
      schema: app(
        {},
        {
          hooks: {
            afterRun: (data: { cmd: { name: string }; result: { ok: boolean } }) =>
              void seen.push(`${data.cmd.name}:${data.result.ok ? 'ok' : 'threw'}`),
          },
        }
      ),
    });

    expect(seen).toEqual(['greet:ok']);
    expect(ran.out).toBe('hello x\n');
  });

  it('should leave an afterRun hook alone on a run that failed', async () => {
    // the half that would break if the wrap ever grew an `afterRun` of its own
    // and got the ordering wrong: theirs still fires, and the error this reports
    // is still the error
    const seen: string[] = [];
    const ran = await runCommand({
      argv: ['x'],
      schema: app(
        {
          run: () => {
            throw new Error('command failed');
          },
        },
        {
          hooks: {
            afterRun: (data: { result: { ok: boolean } }) =>
              void seen.push(data.result.ok ? 'ok' : 'threw'),
          },
        }
      ),
    });

    expect(seen).toEqual(['threw']);
    expect((ran.error as Error).message).toBe('command failed');
    expect(ran.code).toBe(1);
  });

  it('should not write the wrap onto the schema it was handed', async () => {
    // a schema is an ordinary object an app exports once, so a helper that
    // mutated it would leave the wrap behind for every later run in the process
    const schema = app();

    await runCommand({ argv: ['x'], schema });

    expect(schema.hooks).toBeUndefined();
  });
});
