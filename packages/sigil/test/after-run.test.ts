/**
 * The one thing that fires after a command's `run()`.
 *
 * `main()` used to end at `return (await cmd.run(state)) ?? state;` with nothing
 * after it, so there was no way to write a `finally` -- close the handle, flush
 * the writer, release the lock -- nor a `postrun` for telemetry. Both are one
 * hook, because they are one moment.
 *
 * Most of what is asserted here is **ordering** rather than firing: a test that
 * says the hook fired says nothing about whether the command's own ran before
 * its parent's, nor about whether it ran before the error was rendered, and
 * those two are the whole of the design.
 */

import { main } from '../src/index.js';
import type { AfterRunHook, AfterRunHookData, ParseState } from '../src/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** What the built-in error handler wrote, as `sigil.test.ts` reads it. */
function captureStderr() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);

  return {
    restore: () => spy.mockRestore(),
    get text() {
      return chunks.join('');
    },
  };
}

/** What stdout got, for the runs that print help or a version. */
function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as never);

  return {
    restore: () => spy.mockRestore(),
    get text() {
      return chunks.join('');
    },
  };
}

/** A hook that records what it was handed, as a readable line. */
function recorder(label: string, into: string[]) {
  return (data: AfterRunHookData): void => {
    into.push(`${label}:${data.cmd.name}:${data.outcome.ok ? 'ok' : 'threw'}`);
  };
}

describe('afterRun', () => {
  let exitCode: typeof process.exitCode;

  beforeEach(() => {
    exitCode = process.exitCode;
  });

  afterEach(() => {
    // a leaked exit code would fail the entire test run
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  });

  describe('whose it is', () => {
    it('should fire the command’s own before the schema’s', async () => {
      // the **order**, not the firing: a test asserting both fired passes
      // whichever direction the walk goes, and the direction is the decision
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: recorder('schema', seen) },
        commands: {
          build: { hooks: { afterRun: recorder('build', seen) }, run: () => 'built' },
        },
      };

      await main({ argv: ['build'], schema });

      expect(seen).toEqual(['build:build:ok', 'schema:build:ok']);
    });

    it('should walk the whole chain, innermost first', async () => {
      // two levels cannot tell `[...contexts, schema]` from
      // `[contexts[0], schema]`: both give the same two-element answer. Three
      // is the shortest chain where the middle command's own hook is the
      // discriminator
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: recorder('schema', seen) },
        commands: {
          db: {
            hooks: { afterRun: recorder('db', seen) },
            commands: {
              migrate: { hooks: { afterRun: recorder('migrate', seen) }, run: () => undefined },
            },
          },
        },
      };

      await main({ argv: ['db', 'migrate'], schema });

      expect(seen).toEqual(['migrate:migrate:ok', 'db:migrate:ok', 'schema:migrate:ok']);
    });

    it('should fire a schema hook once, not once per source it is reachable by', async () => {
      // the root context is `initCommand()` over a **copy** of the schema, so
      // the same function is reachable as `contexts.at(-1).hooks.afterRun` and
      // as `state.schema.hooks.afterRun`. `collectHooks()` keeps a set of the
      // hooks rather than of their sources, which is what makes that one firing
      let fired = 0;
      const schema = {
        hooks: { afterRun: () => void fired++ },
        commands: { build: { run: () => undefined } },
      };

      await main({ argv: ['build'], schema });

      expect(fired).toBe(1);
    });

    it('should fire one function once however many sources declared it', async () => {
      // the other side of the same set: an app that put one cleanup on the
      // command and on the schema asked for one cleanup, not two
      let fired = 0;
      const afterRun = (): void => void fired++;
      const schema = {
        hooks: { afterRun },
        commands: { build: { hooks: { afterRun }, run: () => undefined } },
      };

      await main({ argv: ['build'], schema });

      expect(fired).toBe(1);
    });

    it('should leave the caller’s declaration alone', async () => {
      // `initCommand()` copies the hooks object, so a hook that replaces a hook
      // on the command it was handed must not reach back into the schema and
      // change what every later parse of it does
      const original = (): void => undefined;
      const schema = {
        commands: {
          build: {
            hooks: { afterRun: original },
            run: (state: ParseState) => {
              state.cmd!.hooks!.afterRun = (): void => undefined;
            },
          },
        },
      };

      await main({ argv: ['build'], schema });

      expect((schema.commands.build.hooks as { afterRun: unknown }).afterRun).toBe(original);
    });
  });

  describe('two sources for one schema hook, and a merge that takes six as one', () => {
    // both of these are the copy `initCommand()` makes read from the other
    // side, both reproduce **identically on `main` through `beforeError`**, and
    // neither is this hook's to fix. Pinned so that whoever meets one finds a
    // measurement rather than a surprise

    it('should fire both halves where a run() replaced the schema hook', async () => {
      // the root context's `hooks` is a *copy* of the schema's, which is what
      // stops a hook reaching back into the caller's declaration -- so the two
      // objects hold the same function until somebody writes to one, and then
      // they hold two. `collectHooks()` dedupes on function identity, so both
      // are collected and the schema's slot fires twice for one run.
      //
      // Measured on `main` for `beforeError` with the same one assignment, so
      // it is the mechanism rather than anything new. Not fixed: both sources
      // are needed -- the copy is what a `run()` writes to and the original is
      // what a hook installed before the parse writes to -- and dropping either
      // loses a real case. What a replacement wants is to write **both**, or to
      // wrap rather than replace
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('declared') },
        commands: {
          build: {
            run: (state: ParseState) => {
              state.schema.hooks!.afterRun = (): void => void seen.push('replacement');
              return 'built';
            },
          },
        },
      };

      await main({ argv: ['build'], schema });

      expect(seen).toEqual(['declared', 'replacement']);
    });

    it('should lose a placeholder’s hook where the module declared any hooks at all', async () => {
      // `loadCommand()` fills a key from the placeholder only where the module
      // left it `undefined`, and `hooks` is one key -- so a module mentioning an
      // *unrelated* hook discards the placeholder's `afterRun` rather than
      // overriding it. Every other merged property really is one value; `hooks`
      // is a bag of six, and the merge treats it as one where validation and
      // collection both treat it as six.
      //
      // Measured on `main` for `beforeError` too. Not fixed: a per-key merge is
      // a change to what every hook's declaration means on every lazily loaded
      // command, which is not a thing to take inside a ticket about one hook
      const seen: string[] = [];
      const schema = {
        commands: {
          build: {
            hooks: { afterRun: () => void seen.push('placeholder') },
            load: () =>
              Promise.resolve({
                default: { hooks: { beforeError: (): void => undefined }, run: () => 'built' },
              }),
          },
        },
      };

      expect(await main({ argv: ['build'], schema })).toBe('built');
      expect(seen).toEqual([]);
    });

    it('should keep it where the module declared no hooks', async () => {
      // the control, which is what says the finding above is about the merge
      // rather than about a lazily loaded command never reaching the walk
      const seen: string[] = [];
      const schema = {
        commands: {
          build: {
            hooks: { afterRun: () => void seen.push('placeholder') },
            load: () => Promise.resolve({ default: { run: () => 'built' } }),
          },
        },
      };

      await main({ argv: ['build'], schema });

      expect(seen).toEqual(['placeholder']);
    });

    it('should fire a lazily loaded module’s own hook, and refuse a bad one at load', async () => {
      // the half that is not a limitation: a module's own `afterRun` is
      // collected, and `initCommand()` over the merge refuses a non-function
      // with the same message an inline declaration gets
      const seen: string[] = [];
      await main({
        argv: ['build'],
        schema: {
          commands: {
            build: {
              load: () =>
                Promise.resolve({
                  default: {
                    hooks: { afterRun: (): void => void seen.push('module') },
                    run: () => 'built',
                  },
                }),
            },
          },
        },
      });

      expect(seen).toEqual(['module']);

      await expect(
        main({
          argv: ['build'],
          schema: {
            commands: {
              build: {
                load: () => Promise.resolve({ default: { hooks: { afterRun: 'nope' } } }),
              },
            },
          },
          settings: { errorHandler: false },
        })
      ).rejects.toThrow('Expected command afterRun hook to be a function');
    });

    it('should fire for a default command, which argv never named', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: recorder('schema', seen) },
        commands: {
          build: {
            default: true,
            hooks: { afterRun: recorder('build', seen) },
            run: () => 'built',
          },
        },
      };

      await main({ argv: [], schema });

      expect(seen).toEqual(['build:build:ok', 'schema:build:ok']);
    });
  });

  describe('the outcome', () => {
    it('should carry what run() returned', async () => {
      let outcome: AfterRunHookData['outcome'] | undefined;
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void (outcome = d.outcome) },
        commands: { build: { run: () => ({ artifacts: 2 }) } },
      };

      await main({ argv: ['build'], schema });

      expect(outcome).toEqual({ ok: true, value: { artifacts: 2 } });
    });

    it('should carry the raw return rather than main()’s ?? state', async () => {
      // `main()` answers with the parse state for a command that returned
      // nothing, and reporting that as the command's value would be a lie about
      // what the command did -- which matters because this is the value a
      // serializer will be handed
      let value: unknown = 'unset';
      const schema = {
        hooks: {
          afterRun: (d: AfterRunHookData) => {
            value = d.outcome.ok ? d.outcome.value : 'threw';
          },
        },
        commands: { nil: { run: () => undefined } },
      };

      const result = await main({ argv: ['nil'], schema });

      expect(value).toBeUndefined();
      // and the half that makes it a claim: `main()` answered with the state
      expect((result as ParseState).argv).toEqual({});
    });

    it('should carry a null return, which main() also substitutes away', async () => {
      // `?? state` reads `null` as nothing too, so this is the second input
      // where the outcome and `main()`'s answer differ -- and the one somebody
      // writes by accident
      let value: unknown = 'unset';
      const schema = {
        hooks: {
          afterRun: (d: AfterRunHookData) => {
            value = d.outcome.ok ? d.outcome.value : 'threw';
          },
        },
        commands: { nil: { run: () => null } },
      };

      const result = await main({ argv: ['nil'], schema });

      expect(value).toBeNull();
      expect((result as ParseState).argv).toEqual({});
    });

    it('should carry a falsy value main() hands straight back', async () => {
      let value: unknown = 'unset';
      const schema = {
        hooks: {
          afterRun: (d: AfterRunHookData) => {
            value = d.outcome.ok ? d.outcome.value : 'threw';
          },
        },
        commands: { zero: { run: () => 0 } },
      };

      expect(await main({ argv: ['zero'], schema })).toBe(0);
      expect(value).toBe(0);
    });

    it('should time the body, and hand over a duration rather than a clock reading', async () => {
      // a lower bound over a real sleep, which cannot be flaky in the direction
      // contention pushes it: a busy machine makes this longer, never shorter.
      //
      // And an upper bound, which is the half a sabotage pass had to ask for.
      // Reading the *second* clock off `Date.now()` and the first off
      // `performance.now()` makes `ms` an epoch timestamp -- about 1.76e12 --
      // which satisfies every lower bound there is. The bound is not calibrated
      // against the sleep, which is why it is not the flaky kind: it is
      // calibrated against the gap between a duration and a timestamp, and a
      // minute sits twenty-nine million times under one
      let ms = -1;
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void (ms = d.ms) },
        commands: { slow: { run: () => new Promise((resolve) => setTimeout(resolve, 15)) } },
      };

      await main({ argv: ['slow'], schema });

      expect(ms).toBeGreaterThanOrEqual(10);
      expect(ms).toBeLessThan(60_000);
    });

    it('should time a body that threw', async () => {
      let ms = -1;
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void (ms = d.ms) },
        commands: {
          slow: {
            run: async () => {
              await new Promise((resolve) => setTimeout(resolve, 15));
              throw new Error('late');
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['slow'], schema });
      stderr.restore();

      expect(ms).toBeGreaterThanOrEqual(10);
      expect(ms).toBeLessThan(60_000);
    });

    it('should hand over the command and the state the run was given', async () => {
      let data: AfterRunHookData | undefined;
      const schema = {
        commands: {
          build: {
            hooks: { afterRun: (d: AfterRunHookData) => void (data = d) },
            options: { '--out <dir>': {} },
            run: () => undefined,
          },
        },
      };

      await main({ argv: ['build', '--out', 'dist'], schema });

      expect(data?.cmd.name).toBe('build');
      expect(data?.state.argv).toEqual({ out: 'dist' });
      // the same object the `run()` was handed, not a copy of its values
      expect(data?.state.cmd).toBe(data?.cmd);
    });
  });

  describe('a run that threw', () => {
    it('should fire with the error as the outcome', async () => {
      const boom = new Error('nope');
      let outcome: AfterRunHookData['outcome'] | undefined;
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void (outcome = d.outcome) },
        commands: {
          boom: {
            run: () => {
              throw boom;
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(outcome).toEqual({ error: boom, ok: false });
    });

    it('should fire before beforeError, not after it', async () => {
      // the ordering is the design: a hook flushes its log and the error still
      // reports. A test asserting only that the error reported says nothing
      // about which of the two went first
      const seen: string[] = [];
      const schema = {
        hooks: {
          afterRun: () => void seen.push('afterRun'),
          beforeError: () => void seen.push('beforeError'),
        },
        commands: {
          boom: {
            run: () => {
              throw new Error('nope');
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(seen).toEqual(['afterRun', 'beforeError']);
    });

    it('should leave the error to be rendered and the exit code to be set', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        commands: {
          boom: {
            run: () => {
              throw new Error('nope');
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(seen).toEqual(['afterRun']);
      expect(stderr.text).toBe('Error: nope\n');
      expect(process.exitCode).toBe(1);
    });

    it('should fire before the error reaches a settings.errorHandler of false', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        commands: {
          boom: {
            run: () => {
              throw new Error('nope');
            },
          },
        },
      };

      await expect(
        main({ argv: ['boom'], schema, settings: { errorHandler: false } })
      ).rejects.toThrow('nope');

      expect(seen).toEqual(['afterRun']);
    });

    it('should fire before a custom error handler', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        commands: {
          boom: {
            run: () => {
              throw new Error('nope');
            },
          },
        },
      };

      await main({
        argv: ['boom'],
        schema,
        settings: { errorHandler: () => void seen.push('handler') },
      });

      expect(seen).toEqual(['afterRun', 'handler']);
    });

    it('should discriminate on ok rather than on the error being there', async () => {
      // anything at all can be thrown, `undefined` included -- which is why the
      // union is tagged. A shape that read `error !== undefined` would report
      // this run as a success
      let outcome: AfterRunHookData['outcome'] | undefined;
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void (outcome = d.outcome) },
        commands: {
          boom: {
            run: () => {
              throw undefined;
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(outcome).toEqual({ error: undefined, ok: false });
      expect(outcome?.ok).toBe(false);
    });

    it('should fire for a rejection as readily as for a throw', async () => {
      // a `run()` that hands back a rejected promise never raises
      // synchronously, so an implementation that only wrapped the call and not
      // the await would miss it
      let outcome: AfterRunHookData['outcome'] | undefined;
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void (outcome = d.outcome) },
        commands: { boom: { run: () => Promise.reject(new Error('rejected')) } },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(outcome?.ok).toBe(false);
      expect((outcome as { error: Error }).error.message).toBe('rejected');
    });

    it('should fire for a thrown value that is not an error', async () => {
      let outcome: AfterRunHookData['outcome'] | undefined;
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void (outcome = d.outcome) },
        commands: {
          boom: {
            run: () => {
              throw 'a string';
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(outcome).toEqual({ error: 'a string', ok: false });
    });
  });

  describe('a hook that throws', () => {
    it('should not replace the error already in flight', async () => {
      // the owner tree's rule: a failed cleanup is reported, never promoted to
      // the thing the user is told about
      const schema = {
        hooks: {
          afterRun: () => {
            throw new Error('cleanup failed');
          },
        },
        commands: {
          boom: {
            run: () => {
              throw new Error('the real failure');
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(stderr.text).toBe('Error: the real failure\n');
    });

    it('should not stop the hooks after it', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('schema') },
        commands: {
          build: {
            hooks: {
              afterRun: () => {
                seen.push('build');
                throw new Error('cleanup failed');
              },
            },
            run: () => undefined,
          },
        },
      };

      await main({ argv: ['build'], schema });

      expect(seen).toEqual(['build', 'schema']);
    });

    it('should not turn a successful run into a failure', async () => {
      // the sharper half: on the success path there is no error for a broken
      // hook to hide behind, so a `fireAfterRun()` that let one escape would
      // reach `main()`'s own catch and render a cleanup as the command's result
      const schema = {
        hooks: {
          afterRun: () => {
            throw new Error('cleanup failed');
          },
        },
        commands: { build: { run: () => 'built' } },
      };

      const stderr = captureStderr();
      const result = await main({ argv: ['build'], schema });
      stderr.restore();

      expect(result).toBe('built');
      expect(stderr.text).toBe('');
      expect(process.exitCode).toBeUndefined();
    });

    it('should not turn a rejection into a failure either', async () => {
      const schema = {
        hooks: { afterRun: () => Promise.reject(new Error('cleanup rejected')) },
        commands: { build: { run: () => 'built' } },
      };

      const stderr = captureStderr();
      const result = await main({ argv: ['build'], schema });
      stderr.restore();

      expect(result).toBe('built');
      expect(stderr.text).toBe('');
    });

    it('should not let a throwing hook getter installed at run time cost the run', async () => {
      // the input that makes `collectHooks()`'s own `try` load bearing, and it
      // took finding: a throwing getter *declared* on a command or on the
      // schema is refused where the schema is initialized -- `initCommand()`
      // and `parse()` both read every hook by name before anything runs -- so
      // it never reaches the walk. What does reach it is a hook installed
      // **later**, which is the documented way to compose one, and a wrap that
      // went wrong is how somebody gets here
      const schema = {
        commands: {
          build: {
            // declared empty so there is an object to install onto: a command
            // with no `hooks` at all has none, which `copyDeclaration()` decides
            hooks: {},
            run: (state: ParseState) => {
              Object.defineProperty(state.cmd!.hooks!, 'afterRun', {
                get(): never {
                  throw new Error('hostile getter');
                },
              });
              return 'built';
            },
          },
        },
      };

      const stderr = captureStderr();
      const result = await main({ argv: ['build'], schema });
      stderr.restore();

      expect(result).toBe('built');
      expect(stderr.text).toBe('');
    });

    it('should not let a hooks object replaced at run time cost the run', async () => {
      // `cmd.hooks` is not among the three containers `lockDerived()` seals, so
      // replacing it wholesale is reachable too -- and the walk reads
      // `source.hooks?.[name]`, so one `try` answers for both shapes
      const schema = {
        commands: {
          build: {
            hooks: { afterRun: (): void => undefined },
            run: (state: ParseState) => {
              Object.defineProperty(state.cmd!, 'hooks', {
                get(): never {
                  throw new Error('hostile getter');
                },
              });
              return 'built';
            },
          },
        },
      };

      const stderr = captureStderr();
      const result = await main({ argv: ['build'], schema });
      stderr.restore();

      expect(result).toBe('built');
      expect(stderr.text).toBe('');
    });
  });

  describe('a state a run() wrecked', () => {
    // the walk reads `state.contexts` and `state.schema`, and a `run()` is
    // handed the state -- so both are reachable, and both made `main()`
    // **reject** rather than handle, which is the one thing `main()` is
    // documented not to do. Found by review round 1, reproduced in both
    // directions: the same two inputs reach it through `beforeError` alone,
    // which they have done since `collectHooks()` was written. Sharing one walk
    // is what makes one fix answer for both, so both sides are asserted
    it('should survive a contexts somebody replaced with a number', async () => {
      const schema = {
        hooks: { afterRun: () => undefined },
        commands: {
          boom: {
            run: (state: ParseState) => {
              (state as { contexts: unknown }).contexts = 42;
              throw new Error('the real failure');
            },
          },
        },
      };

      const stderr = captureStderr();
      // resolves rather than rejects, which is the claim
      await expect(main({ argv: ['boom'], schema })).resolves.toBeUndefined();
      stderr.restore();

      expect(stderr.text).toBe('Error: the real failure\n');
      expect(process.exitCode).toBe(1);
    });

    it('should survive a schema redefined as a throwing getter', async () => {
      const schema = {
        hooks: { afterRun: () => undefined },
        commands: {
          boom: {
            run: (state: ParseState) => {
              Object.defineProperty(state, 'schema', {
                get(): never {
                  throw new Error('hostile schema');
                },
              });
              throw new Error('the real failure');
            },
          },
        },
      };

      const stderr = captureStderr();
      await expect(main({ argv: ['boom'], schema })).resolves.toBeUndefined();
      stderr.restore();

      expect(stderr.text).toBe('Error: the real failure\n');
    });

    it('should survive a wrecked state on a run that succeeded', async () => {
      // the success path has no error for a thrown walk to hide behind, so a
      // `fireAfterRun()` that let one escape would reach `main()`'s own catch
      // and render the walk as the command's result
      const schema = {
        hooks: { afterRun: () => undefined },
        commands: {
          build: {
            run: (state: ParseState) => {
              (state as { contexts: unknown }).contexts = 42;
              return 'built';
            },
          },
        },
      };

      const stderr = captureStderr();
      expect(await main({ argv: ['build'], schema })).toBe('built');
      stderr.restore();

      expect(stderr.text).toBe('');
    });

    it('should survive it through beforeError too, which is the same walk', async () => {
      // the sibling the fix answers for: this reached `main()`'s own `catch`
      // through `fireBeforeError()`, so `main()` rejected with a `TypeError`
      // about iterating `42` and nothing was rendered at all
      const seen: string[] = [];
      const schema = {
        hooks: { beforeError: () => void seen.push('beforeError') },
        commands: {
          boom: {
            run: (state: ParseState) => {
              (state as { contexts: unknown }).contexts = 42;
              throw new Error('the real failure');
            },
          },
        },
      };

      const stderr = captureStderr();
      await expect(main({ argv: ['boom'], schema })).resolves.toBeUndefined();
      stderr.restore();

      // the schema is still reachable, so the hook still fires -- what the
      // guard costs is the chain, not every source
      expect(seen).toEqual(['beforeError']);
      expect(stderr.text).toBe('Error: the real failure\n');
    });

    it('should still fire the hooks the wreckage left reachable', async () => {
      // what the guard gives up is whatever the spread could not finish, which
      // is wider than "a `contexts` that is not an array" -- a review round
      // asked for that precision. `push(...iterable)` evaluates the spread
      // whole before it pushes, so an iterable that yields two good sources and
      // then throws contributes **neither**, exactly as a `42` does. Either
      // way a command's own hook is lost and the schema's still fires, because
      // that one is collected in a `try` of its own. The right trade -- the
      // alternative is losing the error -- and the same shape the old code had,
      // which is why it is not a regression
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('schema') },
        commands: {
          build: {
            hooks: { afterRun: () => void seen.push('command') },
            run: (state: ParseState) => {
              (state as { contexts: unknown }).contexts = 42;
              return 'built';
            },
          },
        },
      };

      await main({ argv: ['build'], schema });

      expect(seen).toEqual(['schema']);
    });
  });

  describe('it may not recover, which is the catch refusal', () => {
    /**
     * A hook that hands something back, cast past the type that refuses one.
     *
     * `AfterRunHook` returns `void | Promise<void>`, so a TypeScript app cannot
     * write a recovering hook at all -- `pnpm check` failed on the first draft
     * of these two tests, which is the refusal doing half its job. The cast is
     * the point rather than a nuisance: what is being asserted is the **other**
     * half, that the runtime ignores one, and the caller who gets there is the
     * JavaScript app the type cannot reach.
     */
    function returning(value: unknown): AfterRunHook {
      return (() => value) as unknown as AfterRunHook;
    }

    it('should ignore what a hook returns on a run that threw', async () => {
      // oclif's `catch` is a recovery hook and this is a reporting one. A hook
      // that could turn a failed run into a successful one would have to answer
      // what `main()` returns, what the exit code is, and whether the error was
      // ever an error -- which is `beforeError`'s own refusal one step along
      const schema = {
        hooks: { afterRun: returning('recovered') },
        commands: {
          boom: {
            run: () => {
              throw new Error('nope');
            },
          },
        },
      };

      const stderr = captureStderr();
      const result = await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(result).toBeUndefined();
      expect(stderr.text).toBe('Error: nope\n');
      expect(process.exitCode).toBe(1);
    });

    it('should ignore what a hook returns on a run that succeeded', async () => {
      const schema = {
        hooks: { afterRun: returning('replaced') },
        commands: { build: { run: () => 'built' } },
      };

      expect(await main({ argv: ['build'], schema })).toBe('built');
    });

    it('should refuse a hook that rewrites the outcome it was handed', async () => {
      // the recovery door in the other direction, and it was **open**: `main()`
      // reads the same outcome object after the hooks, so a hook writing
      // `outcome.ok = false` turned a successful run into a thrown `undefined`.
      // Frozen now, so the write throws, is reported under `DEBUG=sigil:run`,
      // and changes nothing
      const schema = {
        hooks: {
          afterRun: (d: AfterRunHookData) => {
            (d.outcome as { ok: boolean }).ok = false;
            (d.outcome as { value: unknown }).value = 'tampered';
          },
        },
        commands: { build: { run: () => 'built' } },
      };

      const stderr = captureStderr();
      const result = await main({ argv: ['build'], schema });
      stderr.restore();

      expect(result).toBe('built');
      expect(stderr.text).toBe('');
      expect(process.exitCode).toBeUndefined();
    });

    it('should refuse a hook that rewrites a failure into a success', async () => {
      // the direction somebody would try on purpose: a `catch` that recovers.
      // The error still reports, which is what makes the refusal a behaviour
      // rather than a type
      const schema = {
        hooks: {
          afterRun: (d: AfterRunHookData) => {
            (d.outcome as { ok: boolean }).ok = true;
          },
        },
        commands: {
          boom: {
            run: () => {
              throw new Error('nope');
            },
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['boom'], schema });
      stderr.restore();

      expect(stderr.text).toBe('Error: nope\n');
      expect(process.exitCode).toBe(1);
    });

    it('should refuse a hook that rewrites the duration for the hooks after it', async () => {
      // the same defect one step along: `ms` is a fact about what happened, and
      // a hook editing it would be editing what the next hook in the chain is
      // told
      const seen: number[] = [];
      const schema = {
        hooks: { afterRun: (d: AfterRunHookData) => void seen.push(d.ms) },
        commands: {
          build: {
            hooks: {
              afterRun: (d: AfterRunHookData) => {
                (d as { ms: number }).ms = -1;
              },
            },
            run: () => new Promise((resolve) => setTimeout(resolve, 15)),
          },
        },
      };

      await main({ argv: ['build'], schema });

      expect(seen).toHaveLength(1);
      expect(seen[0]).toBeGreaterThanOrEqual(10);
      expect(seen[0]).toBeLessThan(60_000);
    });
  });

  describe('what the freeze does not seal, which is the app’s own', () => {
    // review round 1 reported three ways a hook reaches what is rendered, and
    // all three reproduce. None is a way round the refusal, and what says so is
    // that each is a channel the app already had: these are **differentials**
    // rather than assertions about either answer, so deep-freezing the value or
    // the error, or snapshotting the `beforeError` set, fails them

    it('should let a hook annotate the error exactly as beforeError may', async () => {
      // `beforeError` is documented as entitled to "observe the error, mutate
      // it, or return a replacement", so an `afterRun` hook writing
      // `err.message` is doing what that hook does. Deep-freezing the error
      // would take that documented right away from both
      const tamper = (err: unknown): void => {
        (err as { message: string }).message = 'tampered';
        (err as { exitCode: number }).exitCode = 3;
      };
      const boom = () => {
        throw new Error('the real failure');
      };

      const viaAfterRun = captureStderr();
      await main({
        argv: ['boom'],
        schema: {
          hooks: {
            afterRun: (d: AfterRunHookData) => {
              if (!d.outcome.ok) {
                tamper(d.outcome.error);
              }
            },
          },
          commands: { boom: { run: boom } },
        },
      });
      viaAfterRun.restore();
      const afterRunCode = process.exitCode;

      const viaBeforeError = captureStderr();
      await main({
        argv: ['boom'],
        schema: { hooks: { beforeError: tamper }, commands: { boom: { run: boom } } },
      });
      viaBeforeError.restore();

      expect(viaAfterRun.text).toBe(viaBeforeError.text);
      expect(afterRunCode).toBe(process.exitCode);
      // and not vacuous: the tampering really did reach the screen
      expect(viaAfterRun.text).toBe('Error: tampered\n');
      expect(afterRunCode).toBe(3);
    });

    it('should let a hook annotate the returned value exactly as the command may', async () => {
      // the object is the command's own and it can keep a reference to it, so
      // the framework handing a hook the same reference opens nothing
      const viaHook = await main({
        argv: ['build'],
        schema: {
          hooks: {
            afterRun: (d: AfterRunHookData) => {
              if (d.outcome.ok) {
                (d.outcome.value as { artifacts: number }).artifacts = 99;
              }
            },
          },
          commands: { build: { run: () => ({ artifacts: 2 }) } },
        },
      });

      let held: { artifacts: number } | undefined;
      const viaCommand = await main({
        argv: ['build'],
        schema: {
          commands: {
            build: {
              run: () => {
                held = { artifacts: 2 };
                return held;
              },
            },
          },
        },
      });
      held!.artifacts = 99;

      expect(viaHook).toEqual(viaCommand);
      expect(viaHook).toEqual({ artifacts: 99 });
    });

    it('should let a hook install a beforeError, which reaches only what that hook reaches', async () => {
      // the suggested fix was to snapshot the `beforeError` set before this
      // fires, and it is refused: a hook installed by a `parse` hook or by a
      // `run()` fires, so making this the one place installing one does not
      // work would be a special case nobody asked for. What it reaches is
      // `beforeError`'s own reach -- which may replace an error and may never
      // suppress it
      const replace = (): Error => new Error('replaced');

      const viaAfterRun = captureStderr();
      await main({
        argv: ['boom'],
        schema: {
          hooks: {
            afterRun: (d: AfterRunHookData) => {
              d.state.schema.hooks!.beforeError = replace;
            },
          },
          commands: {
            boom: {
              run: () => {
                throw new Error('the real failure');
              },
            },
          },
        },
      });
      viaAfterRun.restore();
      const afterRunCode = process.exitCode;

      const viaDeclaration = captureStderr();
      await main({
        argv: ['boom'],
        schema: {
          hooks: { beforeError: replace },
          commands: {
            boom: {
              run: () => {
                throw new Error('the real failure');
              },
            },
          },
        },
      });
      viaDeclaration.restore();

      expect(viaAfterRun.text).toBe(viaDeclaration.text);
      expect(afterRunCode).toBe(process.exitCode);
      // the error still reports, which is the half that makes it not recovery
      expect(viaAfterRun.text).toBe('Error: replaced\n');
      expect(afterRunCode).toBe(1);
    });

    it('should refuse a sloppy-mode write too, and tell it nothing', async () => {
      // the freeze **refuses** either way and only **confesses** to strict-mode
      // code. An ES module is always strict; a hook out of `new Function` has a
      // sloppy body, so the write is dropped in silence. Which is the host's
      // rule rather than this module's, and is the honest limit of "a hook that
      // tried to rewrite what happened finds out"
      //
      // It writes to `d.state.argv` as well, which is the execution witness a
      // review round asked for: without one, "refused in silence" and "never
      // invoked at all" are the same two assertions, so a collection that had
      // dropped the hook would pass this unchanged
      const sloppy = new Function(
        'd',
        'd.state.argv.sloppyRan = true; d.outcome.ok = false; d.ms = -1;'
      ) as AfterRunHook;

      const stderr = captureStderr();
      let argv: Record<string, unknown> | undefined;
      const result = await main({
        argv: ['build'],
        schema: {
          hooks: {
            afterRun: sloppy,
            afterParse: (state: ParseState) => void (argv = state.argv as Record<string, unknown>),
          },
          commands: { build: { run: () => 'built' } },
        },
      });
      stderr.restore();

      // it ran: `state` is mutable and that write is allowed
      expect(argv?.sloppyRan).toBe(true);
      // and was refused: the run is still a success and the value is still the value
      expect(result).toBe('built');
      expect(stderr.text).toBe('');
      expect(process.exitCode).toBeUndefined();
    });

    it('should ignore a non-function somebody assigned after init', async () => {
      // the rule a review round asked to be written down rather than left as
      // three: a hook is checked where it is **declared** -- `initCommand()` for
      // a command and `parse()` for the schema -- and one assigned later is past
      // every check there is, so it is skipped. One rule for every hook rather
      // than a confession in the one walk that could not have prevented it
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('schema') },
        commands: {
          build: {
            hooks: { afterRun: (): void => void seen.push('command') },
            run: (state: ParseState) => {
              (state.cmd!.hooks as { afterRun: unknown }).afterRun = 'nope';
              return 'built';
            },
          },
        },
      };

      const stderr = captureStderr();
      expect(await main({ argv: ['build'], schema })).toBe('built');
      stderr.restore();

      // the command's own is gone, the schema's still fires, and nothing failed
      expect(seen).toEqual(['schema']);
      expect(stderr.text).toBe('');
    });
  });

  describe('a run that never happened', () => {
    it('should fire nothing for --help', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        commands: { build: { run: () => 'built' } },
      };

      const stdout = captureStdout();
      await main({ argv: ['build', '--help'], schema });
      stdout.restore();

      expect(stdout.text).toContain('Usage:');
      expect(seen).toEqual([]);
    });

    it('should fire nothing for --version', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        version: '1.2.3',
        commands: { build: { run: () => 'built' } },
      };

      const stdout = captureStdout();
      await main({ argv: ['--version'], schema });
      stdout.restore();

      expect(stdout.text).toBe('1.2.3\n');
      expect(seen).toEqual([]);
    });

    it('should fire nothing for an invocation that printed help instead', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        commands: { build: { run: () => 'built' } },
      };

      const stdout = captureStdout();
      await main({ argv: [], schema });
      stdout.restore();

      expect(stdout.text).toContain('Usage:');
      expect(seen).toEqual([]);
    });

    it('should fire nothing for a command with no run', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        commands: { db: { commands: { migrate: { run: () => 'migrated' } } } },
      };

      const stdout = captureStdout();
      await main({ argv: ['db'], schema });
      stdout.restore();

      expect(seen).toEqual([]);
    });

    it('should fire nothing for a run: null, which initCommand refuses outright', async () => {
      // this was named "fire nothing for a run: null" and passed for the wrong
      // reason -- which is the defect this file is written against, in this
      // file. `Command.run` is typed `| null`, so `null` reads as the spelling
      // for "this command dispatches nothing"; `initCommand()` **refuses** it
      // with `Invalid run function`, so the parse fails and `afterRun` is
      // silent for the reason every parse failure is rather than for the
      // reason the name gave. Found by reading the stray stderr line the full
      // suite printed -- the test captured stdout and not stderr, which is how
      // a wrong premise stayed invisible while the assertion held.
      //
      // So it asserts what `run: null` does, with `beforeError` beside it to
      // say the run really did fail
      const seen: string[] = [];
      const schema = {
        hooks: {
          afterRun: () => void seen.push('afterRun'),
          beforeError: () => void seen.push('beforeError'),
        },
        commands: { noop: { run: null } },
      };

      const stderr = captureStderr();
      await main({ argv: ['noop'], schema });
      stderr.restore();

      expect(seen).toEqual(['beforeError']);
      expect(stderr.text).toBe('Error: Invalid run function in "noop" command\n');
    });

    it('should fire nothing for a command whose run was left out', async () => {
      // which is the shape `run: null` reads as and is not: a command with no
      // `run` at all dispatches nothing, prints its help, and exits zero
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: () => void seen.push('afterRun') },
        commands: { noop: {} },
      };

      const stdout = captureStdout();
      expect(await main({ argv: ['noop'], schema })).toBeDefined();
      stdout.restore();

      expect(seen).toEqual([]);
      expect(stdout.text).toContain('Usage:');
      expect(process.exitCode).toBe(0);
    });

    it('should fire nothing for a parse that failed before any command ran', async () => {
      const seen: string[] = [];
      const schema = {
        hooks: {
          afterRun: () => void seen.push('afterRun'),
          beforeError: () => void seen.push('beforeError'),
        },
        commands: { build: { options: { '--out <dir>': {} }, run: () => 'built' } },
      };

      const stderr = captureStderr();
      await main({ argv: ['build'], schema });
      stderr.restore();

      // the `beforeError` entry is what makes this not vacuous: the run really
      // did fail, and the hook that fires for a failure fired
      expect(seen).toEqual(['beforeError']);
      expect(stderr.text).toContain('Missing required options');
    });

    it('should fire nothing for a value its data type refused', async () => {
      // a different throw site from the one above: a coercion failure happens
      // while argv is being read rather than while it is being judged, so a
      // test that used only a validation failure would be pinning one of two
      const seen: string[] = [];
      const schema = {
        hooks: {
          afterRun: () => void seen.push('afterRun'),
          beforeError: () => void seen.push('beforeError'),
        },
        commands: { build: { options: { '--jobs [n]': { type: 'int' } }, run: () => 'built' } },
      };

      const stderr = captureStderr();
      await main({ argv: ['build', '--jobs', 'abc'], schema });
      stderr.restore();

      expect(seen).toEqual(['beforeError']);
      expect(stderr.text).toContain('Invalid integer');
    });
  });

  describe('the throw sites a structural argument covered and no test did', () => {
    // review round 3 walked every way a value can be thrown between `main()`
    // being called and `main()` returning -- about thirty-five shapes -- and
    // found **no** behaviour defect: `afterRun` fires exactly once wherever a
    // command ran, never where nothing ran, and `main()` never rejects but for
    // the two documented ways. What it found were coverage gaps, and these are
    // the five worth closing, each a shape the one exit from `parse()` argued
    // for rather than a test asserted

    it('should fire once for a run() that returned a thenable rather than a promise', async () => {
      // `await cmd.run(state)` assimilates any thenable, so a hand-rolled
      // `{ then }` is indistinguishable from a promise here -- which is worth
      // pinning because an implementation that wrapped the *call* and not the
      // await would miss it, and the obvious fixture is a real promise
      let outcome: AfterRunHookData['outcome'] | undefined;
      // a **block** disable with the reason rather than a `-next-line` one: this
      // repository records a suppression a formatter can detach from its target
      // as one that stops working without anybody having edited anything, and
      // `no-thenable` is right about every other object here and wrong for the
      // one whose subject it is
      /* eslint-disable unicorn/no-thenable */
      const result = await main({
        argv: ['build'],
        schema: {
          hooks: { afterRun: (d: AfterRunHookData) => void (outcome = d.outcome) },
          commands: {
            build: { run: () => ({ then: (resolve: (v: string) => void) => resolve('thenable') }) },
          },
        },
      });
      /* eslint-enable unicorn/no-thenable */

      expect(result).toBe('thenable');
      expect(outcome).toEqual({ ok: true, value: 'thenable' });
    });

    it('should fire for a rejection with undefined, which is the tag earning its keep', async () => {
      // the sync `throw undefined` is pinned above; this is the asynchronous
      // half, and it is the one that carries the tagged union end to end --
      // `throw outcome.error` throws `undefined` and the handler renders
      // `Unknown error`, so an `error !== undefined` reading would have called
      // this a success all the way out
      let outcome: AfterRunHookData['outcome'] | undefined;

      const stderr = captureStderr();
      await main({
        argv: ['build'],
        schema: {
          hooks: { afterRun: (d: AfterRunHookData) => void (outcome = d.outcome) },
          commands: { build: { run: () => Promise.reject(undefined) } },
        },
      });
      stderr.restore();

      expect(outcome).toEqual({ error: undefined, ok: false });
      expect(stderr.text).toBe('Error: Unknown error\n');
      expect(process.exitCode).toBe(1);
    });

    it('should fire nothing where printing help is what failed', async () => {
      // the one "a run that never happened" shape where something *did* fail,
      // and it was pinned nowhere: a `help` hook that throws reaches
      // `handleError()` from inside `printHelp()`, so `beforeError` fires on a
      // help-rendering failure and `afterRun` stays silent -- no command ran.
      // The message is the help module's own, so what is asserted is the
      // ordering and the exit code rather than prose
      const seen: string[] = [];

      const stderr = captureStderr();
      await main({
        argv: ['build', '--help'],
        schema: {
          hooks: {
            afterRun: () => void seen.push('afterRun'),
            beforeError: () => void seen.push('beforeError'),
          },
          commands: {
            build: {
              hooks: {
                help: () => {
                  throw new Error('helpboom');
                },
              },
              run: () => 'built',
            },
          },
        },
      });
      stderr.restore();

      expect(seen).toEqual(['beforeError']);
      expect(stderr.text).toMatch(/^Error: /);
      expect(process.exitCode).toBe(1);
    });

    it('should survive a hook that threw a value nothing can even inspect', async () => {
      // `safeLog()` is what makes this survivable and nothing pinned it for
      // this hook: `Console.log` formats its argument before writing, so a
      // thrown object whose `message` and `name` getters throw throws *inside*
      // the logging of it -- in the one place that is reached only when
      // something has already gone wrong
      const seen: string[] = [];
      const hostile = {
        get message(): never {
          throw new Error('not even inspectable');
        },
        get name(): never {
          throw new Error('not even inspectable');
        },
      };

      const stderr = captureStderr();
      const result = await main({
        argv: ['build'],
        schema: {
          hooks: { afterRun: () => void seen.push('schema') },
          commands: {
            build: {
              hooks: {
                afterRun: (): void => {
                  seen.push('command');
                  throw hostile;
                },
              },
              run: () => 'built',
            },
          },
        },
      });
      stderr.restore();

      // the next hook still ran, the run is still a success, and nothing leaked
      expect(seen).toEqual(['command', 'schema']);
      expect(result).toBe('built');
      expect(stderr.text).toBe('');
    });

    it('should have fired before a custom error handler that throws rejects main()', async () => {
      // a handler that throws rejecting `main()` is documented -- "that is a
      // bug in the handler" -- and what nothing pinned is the composition: a
      // telemetry hook must not lose the run because the app's handler is
      // broken, so the assertion is that `afterRun` had already fired once
      const seen: string[] = [];

      await expect(
        main({
          argv: ['build'],
          schema: {
            hooks: { afterRun: () => void seen.push('afterRun') },
            commands: {
              build: {
                run: () => {
                  throw new Error('the real failure');
                },
              },
            },
          },
          settings: {
            errorHandler: () => {
              throw new Error('the handler itself');
            },
          },
        })
      ).rejects.toThrow('the handler itself');

      expect(seen).toEqual(['afterRun']);
    });
  });

  describe('the commands the framework adds', () => {
    it('should fire for completion, which really is a command that ran', async () => {
      // `help` returns before `cmd.run` because `state.help` is set, and
      // `--version` does too -- but `completion` is an ordinary command with an
      // ordinary `run`, so a telemetry hook sees it. Which is the honest answer
      // rather than a surprise, and is written down because a reviewer would
      // otherwise report it as one
      const seen: string[] = [];
      const schema = {
        name: 'app',
        hooks: { afterRun: recorder('schema', seen) },
        commands: { build: { run: () => 'built' } },
      };

      const stdout = captureStdout();
      await main({ argv: ['completion', 'bash'], schema });
      stdout.restore();

      expect(stdout.text).toContain('_app');
      expect(seen).toEqual(['schema:completion:ok']);
    });
  });

  describe('a nested main()', () => {
    it('should fire once per command rather than twice for one', async () => {
      // the shape AGENTS.md records for `beforeError` is **one error reported
      // twice**; this is two commands each reported once, which is what
      // `afterRun` means. A telemetry hook wants both
      const seen: string[] = [];
      const schema = {
        hooks: { afterRun: recorder('schema', seen) },
        commands: {
          clean: { run: () => 'cleaned' },
          build: {
            run: async (state: ParseState) => {
              await main({ argv: ['clean'], schema: state.schema });
              return 'built';
            },
          },
        },
      };

      await main({ argv: ['build'], schema });

      expect(seen).toEqual(['schema:clean:ok', 'schema:build:ok']);
    });

    it('should report the outer command as having thrown what the inner threw', async () => {
      // two outcomes rather than one reported twice: `clean` failed, and
      // `build` failed because it did. The error object is the same because
      // that is what `build` threw
      const seen: string[] = [];
      const errors: unknown[] = [];
      const schema = {
        hooks: {
          afterRun: (d: AfterRunHookData) => {
            seen.push(`${d.cmd.name}:${d.outcome.ok ? 'ok' : 'threw'}`);
            if (!d.outcome.ok) {
              errors.push(d.outcome.error);
            }
          },
        },
        commands: {
          boom: {
            run: () => {
              throw new Error('inner');
            },
          },
          build: {
            run: (state: ParseState) =>
              main({
                argv: ['boom'],
                schema: state.schema,
                settings: { errorHandler: false },
              }),
          },
        },
      };

      const stderr = captureStderr();
      await main({ argv: ['build'], schema });
      stderr.restore();

      expect(seen).toEqual(['boom:threw', 'build:threw']);
      expect(errors[0]).toBe(errors[1]);
      // and the error is reported once, by the outer handler, because the inner
      // call was told to rethrow
      expect(stderr.text).toBe('Error: inner\n');
    });

    it('should name the command each call matched rather than the one above it', async () => {
      const seen: string[] = [];
      const schema = {
        commands: {
          clean: { hooks: { afterRun: recorder('clean', seen) }, run: () => undefined },
          build: {
            hooks: { afterRun: recorder('build', seen) },
            run: (state: ParseState) => main({ argv: ['clean'], schema: state.schema }),
          },
        },
      };

      await main({ argv: ['build'], schema });

      // `clean`'s own hook fires for `clean` and `build`'s for `build`; neither
      // sees the other's command, because `contexts` is that call's own
      expect(seen).toEqual(['clean:clean:ok', 'build:build:ok']);
    });
  });

  describe('a declaration that is not a hook', () => {
    it('should refuse one on a command where it was written', async () => {
      await expect(
        main({
          argv: ['build'],
          schema: { commands: { build: { hooks: { afterRun: 'nope' as never } } } },
          settings: { errorHandler: false },
        })
      ).rejects.toThrow('Expected command afterRun hook to be a function');
    });

    it('should refuse one on the schema, which has a check of its own', async () => {
      // two checks rather than one, and that is pre-existing rather than
      // something this added: `parse()` walks `Object.entries(schema.hooks)`,
      // which is generic over every name and therefore covered `afterRun`
      // before it existed, and it runs *before* the root context is built -- so
      // it is the one that answers for the schema and its message is its own.
      // `initCommand()`'s list is what covers a **command**, and that one had
      // to be told
      await expect(
        main({
          argv: [],
          schema: { hooks: { afterRun: 42 as never } },
          settings: { errorHandler: false },
        })
      ).rejects.toThrow('Expected "afterRun" hook to be a function');
    });
  });
});
