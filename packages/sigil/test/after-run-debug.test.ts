/**
 * The timing line, and the one place a broken `afterRun` hook confesses.
 *
 * Both are the `sigil`/`sigil:run` debug log, which is **silent unless somebody
 * asked** -- so they are exactly the kind of thing a test asserts with
 * `not.toThrow()` and thereby says nothing about. `watch-debug.test.ts` records
 * a review round finding two tests named for a log that would have passed with
 * the logging deleted.
 *
 * A file of its own, because `DEBUG` is read once at the debug module's own load
 * from a `const` nothing can reach afterwards: the only way to observe the log
 * is to set the variable **before** the import, which `vi.hoisted` is for and
 * which is module-wide.
 */

import { main } from '../src/index.js';
import type { ParseState } from '../src/types.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  // before any import, because `debug()` reads `process.env.DEBUG` at load.
  // Both namespaces, because the two claims are two namespaces: the timing line
  // pairs with `Executing command`, which is `sigil`, and a hook's failure
  // belongs to the module that fires it, which is `sigil:run` -- the same split
  // `error-hooks.ts` already keeps with `sigil:error`
  process.env.DEBUG = 'sigil,sigil:run';
});

let logged: string[];
let out: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;
let errText: string[];
let exitCode: typeof process.exitCode;

beforeEach(() => {
  exitCode = process.exitCode;
  logged = [];
  errText = [];
  // **stdout**, which is where `debug()`'s `log` writes -- `debug(ns)` is a
  // `Console` over the two process streams, so `log` is stdout and `error` is
  // stderr. Both of these lines are `log`, matching `Executing command` in
  // `main()` and `error-hooks.ts`'s own confession for a `beforeError` hook
  // that threw: two reports about a user hook that threw, on two different
  // streams, would be the inconsistency. That the stream is stdout at all is a
  // question about every `DEBUG=sigil` line there already is rather than about
  // these two, so it is left where it is.
  //
  // The stream is held by reference and `.write()` called on it, so a spy
  // installed now is seen by a logger built at module load
  out = vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    logged.push(String(chunk));
    return true;
  }) as never);
  err = vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    errText.push(String(chunk));
    return true;
  }) as never);
});

afterEach(() => {
  out.mockRestore();
  err.mockRestore();
  process.exitCode = exitCode;
});

/** What reached the log. */
function text(): string {
  return logged.join('');
}

describe('the timing line', () => {
  it('should name the command, that it returned, and how long it took', async () => {
    await main({ argv: ['build'], schema: { commands: { build: { run: () => 'built' } } } });

    // the whole line rather than a substring of it: what it has to say is the
    // three things a reader is there for, and `toContain('build')` would hold
    // over `Executing command "build"` alone -- which is the line that was
    // already there and is why this is asserted as a shape
    expect(text()).toMatch(/sigil Command "build" returned after \d+\.\d{3}ms/);
  });

  it('should say a command threw rather than returned', async () => {
    await main({
      argv: ['boom'],
      schema: {
        commands: {
          boom: {
            run: () => {
              throw new Error('nope');
            },
          },
        },
      },
    });

    expect(text()).toMatch(/sigil Command "boom" threw after \d+\.\d{3}ms/);
    expect(text()).not.toContain('returned after');
    // and the error still reached stderr, so the log is not standing in for it
    expect(errText.join('')).toBe('Error: nope\n');
  });

  it('should report a duration a sleep makes a lower bound of', async () => {
    // the line is useless if it always reads zero, which is what `Date.now()`
    // would give for most commands. A real sleep is the only input that can
    // tell a sub-millisecond clock from a whole-millisecond one
    await main({
      argv: ['slow'],
      schema: {
        commands: { slow: { run: () => new Promise((resolve) => setTimeout(resolve, 20)) } },
      },
    });

    const ms = Number(/returned after ([\d.]+)ms/.exec(text())?.[1]);
    expect(ms).toBeGreaterThanOrEqual(15);
    // and the upper bound a sabotage asked for: mixing the two clocks makes the
    // number an epoch timestamp, which every lower bound passes
    expect(ms).toBeLessThan(60_000);
  });

  it('should come after the line that says the command started', async () => {
    // the pair is the point: one `DEBUG=sigil` gives both halves, which is why
    // the timing shares `Executing command`'s namespace rather than taking one
    // of its own
    await main({ argv: ['build'], schema: { commands: { build: { run: () => 'built' } } } });

    const all = text();
    expect(all.indexOf('Executing command "build"')).toBeGreaterThanOrEqual(0);
    expect(all.indexOf('Command "build" returned')).toBeGreaterThan(
      all.indexOf('Executing command "build"')
    );
  });

  it('should say nothing for a run that never happened', async () => {
    await main({ argv: ['--help'], schema: { commands: { build: { run: () => 'built' } } } });

    // the help screen went to the same stream, so this is an absence inside a
    // capture that is certainly not empty -- which is what stops it passing for
    // the wrong reason
    expect(text()).toContain('Usage:');
    expect(text()).not.toContain('returned after');
    expect(text()).not.toContain('threw after');
  });
});

describe('a hook that threw', () => {
  it('should confess under sigil:run', async () => {
    await main({
      argv: ['build'],
      schema: {
        hooks: {
          afterRun: () => {
            throw new Error('cleanup failed');
          },
        },
        commands: { build: { run: () => 'built' } },
      },
    });

    expect(text()).toContain('sigil:run');
    expect(text()).toContain('cleanup failed');
  });

  it('should say nothing at all where the app declared no hook', async () => {
    // the claim in its own right -- a namespace that confesses on every run of
    // every app is noise -- and the input that makes `collectHooks()`'s
    // `typeof hook === 'function'` load bearing. Found by sabotage: adding every
    // source's value to the set, `undefined` included, changes **no answer**,
    // because the per-hook `try` catches the `TypeError` from awaiting one and
    // the real hooks still fire in order. What it changes is this log, on every
    // command of every app that declared nothing
    await main({ argv: ['build'], schema: { commands: { build: { run: () => 'built' } } } });

    // not an empty capture: the timing line is in it, which is what stops this
    // passing because nothing was logged at all
    expect(text()).toContain('Command "build" returned');
    expect(text()).not.toContain('sigil:run');
    expect(text()).not.toContain('TypeError');
  });

  it('should confess a rejection as readily as a throw', async () => {
    await main({
      argv: ['build'],
      schema: {
        hooks: { afterRun: () => Promise.reject(new Error('cleanup rejected')) },
        commands: { build: { run: () => 'built' } },
      },
    });

    expect(text()).toContain('cleanup rejected');
  });

  it('should confess a hook that tried to rewrite the outcome', async () => {
    // the frozen outcome makes the attempt loud rather than silent, which is
    // the whole argument for freezing it rather than handing over a copy:
    // a hook that believed it had recovered finds out here
    await main({
      argv: ['build'],
      schema: {
        hooks: {
          afterRun: (d) => {
            (d.outcome as { ok: boolean }).ok = false;
          },
        },
        commands: { build: { run: () => 'built' } },
      },
    });

    expect(text()).toContain('sigil:run');
    expect(text()).toMatch(/read only|not extensible|Cannot assign/i);
  });

  it('should say nothing about a sloppy-mode write, which it cannot see', async () => {
    // the other half of the refusal, and the half the first write-up of it
    // overclaimed: a frozen write is refused either way and confessed only from
    // strict-mode code. An ES module is always strict, so the test above gets a
    // line; a hook out of `new Function` has a sloppy body and the write is a
    // silent no-op the runtime never hears about. Found by review
    // the write to `d.state.argv` is the execution witness: this test is defined
    // by the **absence** of a confession, so without one "refused in silence"
    // and "never invoked" are indistinguishable to it. Asked for by review
    const sloppy = new Function('d', 'd.state.argv.sloppyRan = true; d.outcome.ok = false;') as (
      d: unknown
    ) => void;

    let argv: Record<string, unknown> | undefined;
    await main({
      argv: ['build'],
      schema: {
        hooks: {
          afterRun: sloppy as never,
          afterParse: (state: ParseState) => void (argv = state.argv as Record<string, unknown>),
        },
        commands: { build: { run: () => 'built' } },
      },
    });

    expect(argv?.sloppyRan).toBe(true);
    // not an empty capture: the timing line is in it
    expect(text()).toContain('Command "build" returned');
    expect(text()).not.toContain('sigil:run');
  });

  it('should confess each of several rather than stopping at the first', async () => {
    await main({
      argv: ['build'],
      schema: {
        hooks: {
          afterRun: () => {
            throw new Error('the schema hook');
          },
        },
        commands: {
          build: {
            hooks: {
              afterRun: (): void => {
                throw new Error('the command hook');
              },
            },
            run: (state: ParseState) => state.cmd?.name,
          },
        },
      },
    });

    const all = text();
    expect(all).toContain('the command hook');
    expect(all).toContain('the schema hook');
    expect(all.indexOf('the command hook')).toBeLessThan(all.indexOf('the schema hook'));
  });
});
