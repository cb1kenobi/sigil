import {
  DISABLE_MOUSE_BUTTONS,
  DISABLE_MOUSE_SGR,
  ENABLE_MOUSE_BUTTONS,
  ENABLE_MOUSE_SGR,
  ENTER_ALT_SCREEN,
} from '@ttylabs/sigil/terminal';
import { runOnTerminal } from '@ttylabs/sigil/testing';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Whether `--mouse` reaches `runApp()`, read off what each entry writes to the
 * terminal it was started on.
 *
 * The entry is the one place the flag is wired -- `argv.mouse` into
 * `runApp()`'s `mouse` option -- and the tests beside this one all mount `App`
 * under `runApp()` themselves and pass `mouse` by hand, so none of them runs the
 * line that does it. Take it out and the suite stays green over a client with no
 * mouse at all (SIG-522).
 *
 * Both entries are spawned, as a whole process over a terminal on stdin and
 * stdout, because they are two schemas that spell the flag separately: the built
 * `bin` is `src/index.ts` as `sigil build` read it, and `src/ui.ts` is the `ui`
 * twin Node runs as it is. What is asserted is the terminal's own bytes -- the
 * mouse reported on starting and handed back on quitting -- rather than what
 * `runApp()` was given, since a spy on it would pass for an entry that handed
 * the option to something else.
 */

const dir = resolve(import.meta.dirname, '..');
const bin = join(dir, 'dist', 'git-client.mjs');
const entries = [
  { file: bin, label: 'dist/git-client.mjs' },
  { file: join(dir, 'src', 'ui.ts'), label: 'src/ui.ts' },
];

/** Somewhere that is not a repository, so that the client has nothing to read but an empty answer. */
const cwd = mkdtempSync(join(tmpdir(), 'sigil-git-client-entry-'));
afterAll(() => {
  rmSync(cwd, { force: true, maxRetries: 5, recursive: true });
});

/** A repository with one untracked file, which is all the client needs to have something to show. */
const repo = mkdtempSync(join(tmpdir(), 'sigil-git-client-entry-repo-'));
execFileSync('git', ['init', '--quiet'], { cwd: repo });
writeFileSync(join(repo, 'untracked-marker.txt'), 'x\n');
afterAll(() => {
  rmSync(repo, { force: true, maxRetries: 5, recursive: true });
});

/**
 * What the entry wrote, from its start to its exit on `q`, once the screen shows
 * `shows`. `dir` is the positional, and is the working directory unless said.
 */
async function started(
  file: string,
  flags: string[],
  { dir = cwd, shows = /\S/ }: { dir?: string; shows?: RegExp } = {}
): Promise<string> {
  if (file === bin) {
    expect(
      existsSync(file),
      `${file} is missing: run \`pnpm build\` from the repository root, or \`pnpm --filter @ttylabs/example-git-client build\``
    ).toBe(true);
  }
  const running = runOnTerminal({
    argv: [dir, ...flags],
    columns: 80,
    cwd,
    rows: 24,
    run: file,
    stdin: true,
  });
  try {
    // the first frame, so that `q` is a key somebody has read. Longer than the
    // default: four cold node starts at once, on a runner that may be slow
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
  for (const { file, label } of entries) {
    it.concurrent(`should report the mouse with --mouse and hand it back on quitting: ${label}`, async () => {
      const out = await started(file, ['--mouse']);
      expect(out, 'button tracking was turned on').toContain(ENABLE_MOUSE_BUTTONS);
      expect(out, 'in the encoding the app reads').toContain(ENABLE_MOUSE_SGR);
      expect(out.lastIndexOf(DISABLE_MOUSE_BUTTONS), 'and turned off again').toBeGreaterThan(
        out.indexOf(ENABLE_MOUSE_BUTTONS)
      );
      expect(out.lastIndexOf(DISABLE_MOUSE_SGR)).toBeGreaterThan(out.indexOf(ENABLE_MOUSE_SGR));
    }, 45_000);

    it.concurrent(`should leave the terminal selecting text without --mouse: ${label}`, async () => {
      const out = await started(file, []);
      expect(out, 'the app drew').toContain(ENTER_ALT_SCREEN);
      expect(out, 'no tracking mode').not.toContain(ENABLE_MOUSE_BUTTONS);
      expect(out, 'no mouse encoding').not.toContain(ENABLE_MOUSE_SGR);
    }, 45_000);

    it.concurrent(`should read the repository it was given rather than the working directory: ${label}`, async () => {
      // `cwd` is not a repository and `repo` is, so the file only shows if `dir`
      // reached `createGit()`
      await started(file, [], { dir: repo, shows: /untracked-marker\.txt/ });
    }, 45_000);
  }
});
