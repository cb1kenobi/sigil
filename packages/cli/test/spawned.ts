import { spawn } from 'node:child_process';
import { relative } from 'node:path';

/**
 * Running a script piped and reading back what it did, for the two suites that
 * run what the repository ships as runnable: `demos.test.ts` and
 * `examples.test.ts`.
 *
 * One definition rather than one per suite, because the two are asking the same
 * question of the same kind of file -- does it exit the way it should, with no
 * stack in its output -- and a second copy of the stack pattern is a second
 * answer to what a stack looks like.
 */

/**
 * A stack frame reaching the output is a throw nobody caught, exit code or not
 * -- which is also what catches an unhandled rejection that still exits `0`.
 *
 * The alternation is parenthesised because it means to be either whole branch
 * and not `^(\s+at .+)` or `(node:internal\/)$`: an alternation binds looser
 * than the anchors, which is the trap `optionTypesRE` in the parser is written
 * down for.
 */
export const STACK: RegExp = /(^\s+at .+$)|(node:internal\/)/m;

/** What a run came to. */
export interface Ran {
  code: number | null;
  stderr: string;
  stdout: string;
}

/**
 * Runs `file` under this node with nothing on stdin, so that a script can never
 * wait for a key that will not come.
 *
 * @param file - The script.
 * @param cwd - Where to run it, and what a failure names it relative to.
 * @param args - Its argv, after the script.
 * @returns Its exit code and both streams.
 */
export function run(file: string, cwd: string, args: readonly string[] = []): Promise<Ran> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [file, ...args], {
      cwd,
      env: { ...process.env, COLUMNS: '80' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${relative(cwd, file)} did not finish within 30s`));
    }, 30_000);

    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      settle({ code, stderr, stdout });
    });
  });
}
