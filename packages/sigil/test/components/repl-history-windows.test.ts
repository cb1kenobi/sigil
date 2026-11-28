import { createHistory } from '../../src/components/repl-history.js';
import { tempDir } from '../temp.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * What Windows answers where POSIX says `EEXIST`, forced on a machine that does not.
 *
 * Creating a lock file another process has just unlinked and not yet let go of is
 * `EPERM` there, opening a file for a moment under a scanner is `EBUSY`, and unlinking
 * one somebody is opening is `EPERM` too. None is a fault, and the first draft of the
 * history treated them as one: the lock threw, the append was never made, and four
 * writers on the Windows jobs lost between one and a dozen of 150 lines each
 * (`packages/cli/test/repl-history.test.ts`). The real thing is that test; this is the
 * answers, so a regression is found on the machine it is written on.
 */

const failures = vi.hoisted(() => ({ append: 0, lock: 0, unlink: 0 }));

vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>();
  const busy = (code: string): Error => Object.assign(new Error(code), { code });
  return {
    ...actual,
    appendFileSync: ((...args: Parameters<typeof actual.appendFileSync>) => {
      if (failures.append > 0) {
        failures.append -= 1;
        throw busy('EBUSY');
      }
      return actual.appendFileSync(...args);
    }) as typeof actual.appendFileSync,
    openSync: ((...args: Parameters<typeof actual.openSync>) => {
      if (String(args[0]).endsWith('.lock') && failures.lock > 0) {
        failures.lock -= 1;
        throw busy('EPERM');
      }
      return actual.openSync(...args);
    }) as typeof actual.openSync,
    unlinkSync: ((...args: Parameters<typeof actual.unlinkSync>) => {
      if (String(args[0]).endsWith('.lock') && failures.unlink > 0) {
        failures.unlink -= 1;
        throw busy('EPERM');
      }
      return actual.unlinkSync(...args);
    }) as typeof actual.unlinkSync,
  };
});

const real = process.platform;

/** Makes `process.platform` say what Windows would. */
function asWindows(): void {
  Object.defineProperty(process, 'platform', { value: 'win32' });
}

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: real });
  failures.append = 0;
  failures.lock = 0;
  failures.unlink = 0;
});

describe('a history on Windows', () => {
  it('should wait out a lock it is refused with EPERM, and write the line', () => {
    asWindows();
    const file = join(tempDir('sigil-history-eperm-'), 'history');
    const history = createHistory({ file });
    failures.lock = 5;

    history.add('one');

    expect(readFileSync(file, 'utf8')).toBe('"one"\n');
    expect(failures.lock).toBe(0);
  });

  it('should write the line again when the append is refused for a moment', () => {
    asWindows();
    const file = join(tempDir('sigil-history-ebusy-'), 'history');
    const history = createHistory({ file });
    failures.append = 3;

    history.add('one');

    expect(readFileSync(file, 'utf8')).toBe('"one"\n');
  });

  it('should not leave the lock behind when it cannot be removed at once', () => {
    asWindows();
    const dir = tempDir('sigil-history-unlink-');
    const file = join(dir, 'history');
    const history = createHistory({ file });
    failures.unlink = 4;

    history.add('one');
    // a lock left standing would make the second wait ten seconds for it to be stale
    const started = Date.now();
    history.add('two');

    expect(Date.now() - started).toBeLessThan(2000);
    expect(readFileSync(file, 'utf8')).toBe('"one"\n"two"\n');
  });

  it('should still answer such a refusal as a fault anywhere but Windows', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const file = join(tempDir('sigil-history-posix-'), 'history');
    const errors: unknown[] = [];
    const history = createHistory({ file, onError: (error) => errors.push(error) });
    failures.lock = 1;

    // the lock throws, which is reported and does not stop the line being written
    history.add('one');

    expect(errors.length).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toBe('"one"\n');
  });
});
