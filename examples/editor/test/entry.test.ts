import {
  DISABLE_MOUSE_BUTTONS,
  DISABLE_MOUSE_SGR,
  ENABLE_MOUSE_BUTTONS,
  ENABLE_MOUSE_SGR,
  ENTER_ALT_SCREEN,
} from '@ttylabs/sigil/terminal';
import { runOnTerminal } from '@ttylabs/sigil/testing';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Whether `--mouse` and the `dir` argument reach what they are for, read off
 * what the entry writes to the terminal it was started on.
 *
 * The entry is the one place both are wired -- `argv.mouse` into `runApp()`'s
 * `mouse` option and `argv.dir` into `createWorkspace()` -- and the tests beside
 * this one mount `App` under `runApp()` themselves, passing `mouse` by hand and
 * a workspace through `WorkspaceContext`, so none of them runs either line. Take
 * the first out and the suite stays green over an editor with no mouse at all
 * (SIG-594, which is SIG-522's finding for the git client and the log browser).
 *
 * The built `bin` is spawned, as a whole process over a terminal on stdin and
 * stdout; the editor has no `ui` twin, because its root is JSX. What is asserted
 * is the terminal's own bytes -- the mouse reported on starting and handed back
 * on quitting -- rather than what `runApp()` was given, since a spy on it would
 * pass for an entry that handed the option to something else.
 */

const dir = resolve(import.meta.dirname, '..');
const bin = join(dir, 'dist', 'editor.mjs');

/** A directory of its own to run from and one to open, so the two cannot be confused. */
const scratch = mkdtempSync(join(tmpdir(), 'sigil-editor-entry-'));
const cwd = join(scratch, 'started-here');
const opened = join(scratch, 'opened-dir');
mkdirSync(cwd);
mkdirSync(opened);
writeFileSync(join(opened, 'note.txt'), 'hello\n');
afterAll(() => {
  rmSync(scratch, { force: true, maxRetries: 5, recursive: true });
});

/** What the entry wrote, from its start to its exit on `q`, once the screen shows `shows`. */
async function started(argv: string[], shows: RegExp = /\S/): Promise<string> {
  expect(
    existsSync(bin),
    `${bin} is missing: run \`pnpm build\` from the repository root, or \`pnpm --filter @ttylabs/example-editor build\``
  ).toBe(true);
  const running = runOnTerminal({ argv, columns: 80, cwd, rows: 24, run: bin, stdin: true });
  try {
    // the first frame, so that `q` is a key somebody has read. Longer than the
    // default: several cold node starts at once, on a runner that may be slow
    await running.waitFor(/\S/, { timeout: 20_000 });
    await running.waitFor(shows, { timeout: 20_000 });
    await running.press('q');
    const ran = await running;
    expect(ran.err, 'nothing on stderr').toBe('');
    expect(ran.code, 'q quits with 0').toBe(0);
    return ran.out;
  } finally {
    running.kill();
  }
}

describe('the entry', () => {
  it.concurrent('should report the mouse with --mouse and hand it back on quitting', async () => {
    const out = await started(['--mouse']);
    expect(out, 'button tracking was turned on').toContain(ENABLE_MOUSE_BUTTONS);
    expect(out, 'in the encoding the app reads').toContain(ENABLE_MOUSE_SGR);
    expect(out.lastIndexOf(DISABLE_MOUSE_BUTTONS), 'and turned off again').toBeGreaterThan(
      out.indexOf(ENABLE_MOUSE_BUTTONS)
    );
    expect(out.lastIndexOf(DISABLE_MOUSE_SGR)).toBeGreaterThan(out.indexOf(ENABLE_MOUSE_SGR));
  }, 45_000);

  it.concurrent('should leave the terminal selecting text without --mouse', async () => {
    const out = await started([]);
    expect(out, 'the app drew').toContain(ENTER_ALT_SCREEN);
    expect(out, 'no tracking mode').not.toContain(ENABLE_MOUSE_BUTTONS);
    expect(out, 'no mouse encoding').not.toContain(ENABLE_MOUSE_SGR);
  }, 45_000);

  it.concurrent('should open the directory it was given rather than the working directory', async () => {
    // the file tree's root row is the directory, so a `dir` that did not reach
    // `createWorkspace()` would show `started-here` here, which is where the
    // process was started
    const out = await started([opened], /opened-dir/);
    expect(out).not.toContain('started-here');
  }, 45_000);
});
