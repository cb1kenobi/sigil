/**
 * What a suggestion costs a parse that did not fail, which is nothing.
 *
 * A file of its own because `vi.mock` is hoisted and module-wide, which is the
 * rule `bundle-close.test.ts` is a separate file for: every test in the file it
 * sat in would run through the wrapper.
 *
 * The cheap mistake this is written against is hoisting the candidate list above
 * the `if` that throws -- a routed tree reads one `readdir` per level argv named,
 * and that deferral is why a sixty-command CLI starts in 40ms, so building a list
 * on a successful parse would spend it. Two counts, because they are two claims:
 * a successful parse does not **enter** this module at all, and a failing one
 * reads not one byte more than the parse had already read.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Every call that crossed the boundary from the parser into `suggest.ts`. */
const entered: string[] = [];

/** Every directory `readdirSync` was handed, in order, since the last reset. */
const reads: string[] = [];

// a mock rather than `vi.spyOn`, because an ESM namespace is not configurable
// -- which is the pattern `shake-walk.test.ts` already takes, and for its
// reason: the real `readdirSync` runs and the wrapper only records
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();

  return {
    ...real,
    readdirSync: (path: Parameters<typeof real.readdirSync>[0], ...rest: unknown[]) => {
      reads.push(String(path));
      return (real.readdirSync as (...args: unknown[]) => unknown)(path, ...rest);
    },
  };
});

vi.mock('../../src/parser/suggest.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const wrapped: Record<string, unknown> = {};

  for (const [name, value] of Object.entries(real)) {
    wrapped[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => {
            entered.push(name);
            return (value as (...a: unknown[]) => unknown)(...args);
          }
        : value;
  }

  return wrapped;
});

const { parse } = await import('../../src/parser/parse.js');

const here = dirname(fileURLToPath(import.meta.url));
const routes = join(here, 'fixtures', 'routes');

const inline = () => ({
  commands: {
    build: { args: ['[entry]'], run() {} },
    db: { commands: { migrate: { run() {} } }, run() {} },
  },
  name: 'mycli',
  options: { '--verbose': 'x' },
});

describe('what a successful parse pays', () => {
  beforeEach(() => {
    entered.length = 0;
  });

  it.each([
    [['build']],
    [['build', 'out.js']],
    [['db', 'migrate']],
    [['--verbose', 'build']],
    [['help']],
    [['--help']],
    [[]],
  ])('should not enter the suggestion module for %o', async (argv) => {
    await parse({ argv, schema: inline() });

    expect(entered).toEqual([]);
  });

  it('should enter it exactly once where something is about to throw', async () => {
    await expect(parse({ argv: ['buidl'], schema: inline() })).rejects.toThrow(
      'Did you mean "build"?'
    );

    // the message builder, and the message builder only: the candidate list
    // and the ranking are reached from inside it, which is what keeps the
    // `if` that throws the one place any of it happens
    expect(entered).toEqual(['unexpectedArgument']);
  });

  it('should not enter it twice for one throw', async () => {
    await expect(
      parse({
        argv: ['--verbsoe'],
        schema: inline(),
        settings: { allowUnknownOptions: false },
      })
    ).rejects.toThrow('Did you mean "--verbose"?');

    expect(entered).toEqual(['unknownOption']);
  });

  // `suggestions: false` still enters, because the message is built there --
  // which is the point of putting the switch inside rather than at the call
  // site: there is one reader of it
  it('should enter it once with suggestions off, and say nothing', async () => {
    await expect(
      parse({ argv: ['buidl'], schema: inline(), settings: { suggestions: false } })
    ).rejects.toThrow('Unexpected argument "buidl"');

    expect(entered).toEqual(['unexpectedArgument']);
  });
});

describe('what a suggestion over a routed tree reads', () => {
  /** Parses, swallowing whatever it threw, and hands back the directories read. */
  async function readsFor(argv: string[]): Promise<string[]> {
    reads.length = 0;
    await parse({ argv, schema: { commands: routes, name: 'mycli' } }).catch(() => undefined);
    return [...reads];
  }

  it('should read exactly what the successful parse read, and no more', async () => {
    // the suggestion comes out of a registry the parse had already populated:
    // the root's level is read while the schema is built, and every deeper
    // level was read by the `loadCommand()` that put that context in the chain
    const ok = await readsFor(['build']);
    const typo = await readsFor(['buidl']);

    expect(typo).toEqual(ok);
    // the root's level, read while the schema was built, and nothing else
    expect(ok).toHaveLength(1);
  });

  it('should read exactly what the successful parse read one level down', async () => {
    const ok = await readsFor(['db', 'migrate', 'up']);
    const typo = await readsFor(['db', 'migrate', 'pu']);

    expect(typo).toEqual(ok);
    // one `readdir` per level argv named, which is what the deferral promises:
    // the root's, `db`'s and `db/migrate`'s
    expect(ok).toHaveLength(3);
  });

  it('should still suggest over a routed tree, which is what makes the counts mean something', async () => {
    await expect(parse({ argv: ['buidl'], schema: { commands: routes } })).rejects.toThrow(
      'Unexpected argument "buidl". Did you mean "build"?'
    );
  });

  it('should not walk a level argv never named to find a candidate', async () => {
    // `db/migrate/` is two levels down and is never read, so a typo of `up`
    // typed at the root offers nothing -- which is the deferral's own cost and
    // is the same answer help gives
    reads.length = 0;
    await expect(parse({ argv: ['pu'], schema: { commands: routes } })).rejects.toThrow(
      'Unexpected argument "pu"'
    );

    expect(reads.some((dir) => dir.includes('migrate'))).toBe(false);
  });
});
