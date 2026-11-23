import { type Screen, runOnTerminal } from '@ttylabs/sigil/testing';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Whether `--mouse` reaches `runApp()`, read off what each entry writes to the
 * terminal it was started on.
 *
 * The entry is the one place the flag is wired -- `argv.mouse` into `runApp()`'s
 * `mouse` option -- and the tests beside this one all mount `App` under
 * `runApp()` themselves and pass `mouse` by hand, so none of them runs the line
 * that does it. Take it out and the suite stays green over a client with no
 * mouse at all (SIG-522).
 *
 * Both entries are spawned, as a whole process over a terminal on stdin and
 * stdout, because they are two schemas that spell the flag separately: the built
 * `bin` is `src/index.ts` as `sigil build` read it, and `src/ui.ts` is the `ui`
 * twin Node runs as it is. What is asserted is the terminal the entry left, as
 * `Screen.mouse` reads it off the bytes -- the mouse modes on while it ran and
 * none once it had quit -- rather than what `runApp()` was given, since a spy on
 * it would pass for an entry that handed the option to something else.
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

/**
 * The environment git is run in, here and in the entry: no config of the
 * machine's, so that a global `core.excludesFile` ignoring `*.txt` cannot hide
 * the file below. `app.test.ts` isolates its fixture the same way.
 */
const gitEnv = {
  GIT_CONFIG_GLOBAL: join(cwd, 'no-such-gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
};

/** A repository with one untracked file, which is all the client needs to have something to show. */
const repo = mkdtempSync(join(tmpdir(), 'sigil-git-client-entry-repo-'));
beforeAll(() => {
  execFileSync('git', ['init', '--quiet'], { cwd: repo, env: { ...process.env, ...gitEnv } });
  writeFileSync(join(repo, 'untracked-marker.txt'), 'x\n');
});
afterAll(() => {
  rmSync(repo, { force: true, maxRetries: 5, recursive: true });
});

/** What the entry showed while it ran, and what it left behind on `q`. */
interface Started {
  /** Whether the alternate screen was up while it ran, which is that the app drew. */
  alternate: boolean;
  /** The mouse modes the terminal was in once the entry had quit: handed back is all `false`. */
  after: Screen['mouse'];
  /** The mouse modes the terminal was in after the first frame. */
  during: Screen['mouse'];
}

/** A terminal with no mouse reporting on, which is what an entry owes it on quitting. */
const quiet = { buttons: false, motion: false, sgr: false };

/**
 * The entry, from its start to its exit on `q`, once the screen shows
 * `shows`. `dir` is the positional, and is the working directory unless said.
 */
async function started(
  file: string,
  flags: string[],
  { dir = cwd, shows = /\S/ }: { dir?: string; shows?: RegExp } = {}
): Promise<Started> {
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
    env: gitEnv,
    rows: 24,
    run: file,
    stdin: true,
  });
  try {
    // the first frame, so that `q` is a key somebody has read. Longer than the
    // default: four cold node starts at once, on a runner that may be slow
    await running.waitFor(/\S/, { timeout: 20_000 });
    await running.waitFor(shows, { timeout: 20_000 });
    // read while it runs: the mouse is on before the first frame is drawn
    const { alternate, mouse: during } = running.screen;
    await running.press('q');
    const ran = await running;
    expect(ran.err, 'nothing on stderr').toBe('');
    expect(ran.code, 'q quits with 0').toBe(0);
    return { after: running.screen.mouse, alternate, during };
  } finally {
    running.kill();
  }
}

describe('the entry', () => {
  for (const { file, label } of entries) {
    it.concurrent(`should report the mouse with --mouse and hand it back on quitting: ${label}`, async () => {
      const ran = await started(file, ['--mouse']);
      expect(ran.during, 'button tracking, in the encoding the app reads').toEqual({
        buttons: true,
        motion: false,
        sgr: true,
      });
      expect(ran.after, 'and turned off again').toEqual(quiet);
    }, 45_000);

    it.concurrent(`should leave the terminal selecting text without --mouse: ${label}`, async () => {
      const ran = await started(file, []);
      expect(ran.alternate, 'the app drew').toBe(true);
      expect(ran.during, 'no tracking mode and no mouse encoding').toEqual(quiet);
    }, 45_000);

    it.concurrent(`should read the repository at the dir it was given rather than the working directory: ${label}`, async () => {
      // `cwd` is not a repository and `repo` is, so the file only shows if `dir`
      // reached `createGit()`
      await started(file, [], { dir: repo, shows: /untracked-marker\.txt/ });
    }, 45_000);
  }
});
