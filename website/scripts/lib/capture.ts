import { environment } from '../../../packages/cli/test/guides.ts';
import { StyledScreen } from './styled-screen.ts';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';

/**
 * What every capture of a program for the site has in common.
 *
 * The home page's screens (`home-capture.ts`) and the component pages'
 * (`component-capture.ts`) are captured the same way, and this is the way: a
 * child process run in a fixed environment with colour forced, whose output is
 * one JSON object, and a prompt's bytes replayed through `StyledScreen` so that
 * what is kept is the screen a reader was looking at rather than the cursor
 * moves that drew it.
 */

/**
 * The environment a capture is run in: colour forced, everything else fixed.
 *
 * `environment()` is the guides' own, so a capture sees what the guide test
 * sees: no `CI`, no inherited colour scheme, a fixed home.
 *
 * @param columns - The width the program is told it has.
 * @returns The environment.
 */
export function captureEnv(columns = 80): NodeJS.ProcessEnv {
  return { ...environment([], {}), COLUMNS: String(columns), FORCE_COLOR: '1' };
}

/**
 * Runs a node script as a child and reads the one JSON object it prints.
 *
 * @param script - The script.
 * @param args - Its arguments.
 * @param opts - Where to run it, and in what environment.
 * @returns What it printed, parsed.
 */
export function runJson<T>(
  script: string,
  args: readonly string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv }
): Promise<T> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    // a program that never finishes is a capture that fails, not one that hangs
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.stdout.on('data', (chunk: Buffer) => void (stdout += chunk.toString()));
    child.on('error', fail);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        fail(new Error(`${script} ${args.join(' ')} exited ${code}:\n${stderr}`));
        return;
      }
      settle(JSON.parse(stdout) as T);
    });
  });
}

/**
 * A prompt's bytes as the screen they leave, with its colour.
 *
 * @param output - What was written.
 * @param columns - The screen's width.
 * @param rows - Its height, which must be more than the bytes use.
 * @returns The screen, one line per row, as `StyledScreen.toSgr()` writes it.
 */
export function screenOf(output: string, columns: number, rows = 24): string {
  const screen = new StyledScreen(columns, rows);
  screen.write(output);
  return screen.toSgr();
}

/**
 * Runs a list of jobs a few at a time, keeping their order.
 *
 * @param items - What to run over.
 * @param job - The job.
 * @returns The results, in the order of `items`.
 */
export async function inParallel<T, R>(
  items: readonly T[],
  job: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next++;
      results[at] = await job(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(items.length, availableParallelism()) }, worker));
  return results;
}
