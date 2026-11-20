import { STACK } from './spawned.ts';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A reader that goes away ends the toolchain's output without a stack (SIG-537).
 *
 * `sigil add | head -1` exited 1 every time with Node's unhandled-error dump:
 * `head` exits once it has its line, the next write fails `EPIPE`, and nothing
 * in the package listened for the stream's `error` event, which with no listener
 * is an uncaught exception. `sigil check`, `reference` and `--help` only looked
 * safe because their output is short enough to finish first.
 *
 * Spawned, and from both `src/` and the built executable: the built one never
 * reaches `run()`, so a guard written there would pass the first and fail the
 * second -- which is the one that is shipped.
 *
 * The reader is closed by the test, not by a `head` racing the child: the read
 * end is destroyed the moment the child exists, which is long before node has
 * started, so every write the child makes meets a reader that is gone. That is
 * the whole of what `head -1` produces after its line, with nothing left to
 * chance.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const app = join(here, 'fixtures', 'app');

const bins = {
  'dist/sigil.mjs': join(root, 'dist', 'sigil.mjs'),
  'src/sigil.ts': join(root, 'src', 'sigil.ts'),
};

interface Ran {
  code: number | null;
  /** What came out of the stream that stayed open. */
  seen: string;
}

/**
 * Runs the toolchain with one of its two output streams already closed.
 *
 * @param bin - The entry to run.
 * @param args - Its argv.
 * @param closed - The stream whose reader goes away.
 * @returns The exit code and the text of the stream left open.
 */
function runClosed(bin: string, args: string[], closed: 'stderr' | 'stdout'): Promise<Ran> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [bin, ...args], {
      cwd: root,
      env: { ...process.env, COLUMNS: '80' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const open = closed === 'stdout' ? child.stderr : child.stdout;
    let seen = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${args.join(' ')} did not finish within 30s`));
    }, 30_000);

    open.on('data', (chunk: Buffer) => void (seen += chunk.toString()));
    child[closed].destroy();
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ code, seen });
    });
  });
}

describe('a toolchain command whose reader has gone away', () => {
  describe.each(Object.entries(bins))('%s', (_name, bin) => {
    it('should list the registry into a closed stdout without a stack', async () => {
      // 73 lines written in several pieces, which is what made `add` the one
      // that died: the first write reaches the pipe, and a later one does not
      const ran = await runClosed(bin, ['add'], 'stdout');

      expect(ran.seen).not.toMatch(/EPIPE|Unhandled 'error' event/);
      expect(ran.seen).not.toMatch(STACK);
      expect(ran.code).toBe(0);
    });

    it('should print a command tree into a closed stdout, and still say how the check came out', async () => {
      // the stream that stayed open is the proof the command carried on: the
      // summary is the last thing `check` writes
      const ran = await runClosed(bin, ['check', app, '--tree'], 'stdout');

      expect(ran.seen).not.toMatch(/EPIPE|Unhandled 'error' event/);
      expect(ran.seen).not.toMatch(STACK);
      expect(ran.seen).toContain('13 commands');
      expect(ran.code).toBe(0);
    });

    it('should write its summary into a closed stderr without failing', async () => {
      // nothing can be read off the stream that closed, so the exit code is the
      // evidence: an uncaught `EPIPE` on stderr exits 1 over a check that passed
      const ran = await runClosed(bin, ['check', app, '--tree'], 'stderr');

      expect(ran.seen).toContain('commands/build.ts');
      expect(ran.code).toBe(0);
    });

    it('should keep the exit code of a command that failed, rather than swallowing it with the pipe', async () => {
      // the error is rendered to the stream that closed, and the code is still
      // the error's own. This one does not fail without the guard -- an uncaught
      // `EPIPE` also exits 1 -- so it pins the other half: that the rule is
      // "stop writing" and not "exit zero because nobody is listening"
      const ran = await runClosed(bin, ['nope'], 'stderr');

      expect(ran.code).toBe(1);
    });
  });
});
