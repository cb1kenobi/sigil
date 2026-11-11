import { createGit, type Git, GitContext } from '../src/git.ts';
import { App as JsxApp, stylesheet } from '../src/root.tsx';
import { App as UiApp } from '../src/root.ui.ts';
import { type App, runApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, ctrl, frame, KEYS, type TestTerminal } from '@ttylabs/sigil/testing';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The client run by `runApp()` over a test terminal, against a repository each
 * test makes for itself -- real git, through `GitContext`, which is what
 * `src/ui.ts` provides with the working directory. Nothing here is run in the
 * repository the client is developed in.
 *
 * Git is told nothing about the machine it is on: no system config, a global
 * config file of the test's own, an identity in the environment, and a ceiling
 * at the temp directory -- so a CI runner with no identity, a laptop that signs
 * every commit, a Windows runner whose system config turns on `core.autocrlf`,
 * and a `GIT_DIR` left in the environment by a hook all see the same git. See
 * "The git client" in `examples/AGENTS.md`.
 */

/** Every directory this file made, removed when it is done. */
const made: string[] = [];
afterAll(() => {
  // `maxRetries` for Windows, where a directory git has only just let go of can
  // answer EBUSY for a moment; a directory that still cannot go fails the file,
  // as `tempDir()` does in every package (`packages/sigil/src/testing/AGENTS.md`)
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 5, recursive: true });
  }
});

/** A repository the test owns, and the git the client and the test both run. */
interface Repo {
  readonly dir: string;
  readonly env: Record<string, string | undefined>;
  /** Runs git in the repository, as the test, and hands back what it printed. */
  git(...args: string[]): string;
  /** Writes a file of the working tree, with `\n` line endings on every platform. */
  write(path: string, lines: readonly string[]): void;
}

/**
 * A fresh repository under the temp directory: `a.txt` of thirty numbered lines
 * and `b.txt`, committed on `main`, and a second branch `feature` at the same
 * commit. `empty` makes it with no commit at all.
 */
function repository(opts: { empty?: boolean; init?: boolean } = {}): Repo {
  const home = mkdtempSync(join(tmpdir(), 'sigil-git-client-'));
  made.push(home);
  const dir = join(home, 'repo');
  mkdirSync(dir);
  const config = join(home, 'gitconfig');
  writeFileSync(
    config,
    '[init]\n\tdefaultBranch = main\n[core]\n\tautocrlf = false\n\tsafecrlf = false\n[commit]\n\tgpgsign = false\n'
  );
  const env: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(process.env)) {
    // a GIT_DIR or a GIT_INDEX_FILE from a hook would point git at another repository
    if (!name.startsWith('GIT_')) {
      env[name] = value;
    }
  }
  Object.assign(env, {
    GIT_AUTHOR_EMAIL: 'ada@example.com',
    GIT_AUTHOR_NAME: 'Ada',
    GIT_CEILING_DIRECTORIES: home,
    GIT_COMMITTER_EMAIL: 'ada@example.com',
    GIT_COMMITTER_NAME: 'Ada',
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
  });

  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env, stdio: 'pipe' });
  const write = (path: string, lines: readonly string[]): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), lines.map((line) => `${line}\n`).join(''));
  };

  if (opts.init !== false) {
    git('init', '-q');
    if (!opts.empty) {
      write('a.txt', NUMBERS);
      write('b.txt', ['bee']);
      git('add', '.');
      git('commit', '-q', '-m', 'first');
      git('branch', 'feature');
    }
  }
  return { dir, env, git, write };
}

/** One to thirty, a line each. */
const NUMBERS = Array.from({ length: 30 }, (_, i) => String(i + 1));

/** `NUMBERS` with line 3 and line 25 changed: two hunks, far enough apart to stay two. */
const TWO_HUNKS = NUMBERS.map((n) => (n === '3' ? 'three' : n === '25' ? 'twenty-five' : n));

/** What a mounted client is driven with. */
interface Mounted {
  readonly app: App;
  /** Presses keys, waiting for git to finish after each. */
  press(...keys: string[]): Promise<void>;
  /** The screen, a row a line. */
  screen(): string;
  /** Waits until git has finished and the frame after it is drawn. */
  settle(): Promise<void>;
  readonly term: TestTerminal;
}

const COLUMNS = 110;
const ROWS = 32;

/**
 * Mounts a root over a test terminal, with git pointed at the repository and
 * counted, so that `settle()` waits for what the client asked of it rather than
 * for a guess at how long git takes -- which on a Windows runner is a lot longer
 * than here.
 */
async function mount(App: () => Element, repo: Repo): Promise<Mounted> {
  const real = createGit({ cwd: repo.dir, env: repo.env });
  let running = 0;
  const counted = <T>(work: Promise<T>): Promise<T> => {
    running++;
    return work.finally(() => {
      running--;
    });
  };
  const git: Git = {
    cwd: real.cwd,
    readFile: (path, limit) => counted(real.readFile(path, limit)),
    run: (args, opts) => counted(real.run(args, opts)),
  };
  const term = createTestTerminal({ colorLevel: 0, columns: COLUMNS, rows: ROWS });
  const app = runApp(() => provideContext(GitContext, git, App), {
    detect: false,
    sheets: [stylesheet],
    terminal: term.terminal,
  });

  // idle for three frames running: a git that resolves queues the next one
  // within a turn, so one quiet frame is not yet quiet
  const settle = async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    let quiet = 0;
    while (quiet < 3) {
      if (Date.now() > deadline) {
        throw new Error(`git was still running after 20s:\n${term.viewport.join('\n')}`);
      }
      await frame(app);
      quiet = running === 0 ? quiet + 1 : 0;
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) {
      await term.press(key);
      await settle();
    }
  };
  await settle();
  return { app, press, screen: () => term.viewport.join('\n'), settle, term };
}

/** Escape, which the router holds back a moment in case it starts a sequence. */
async function escape(client: Mounted): Promise<void> {
  await client.term.press(KEYS.escape);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await client.settle();
}

const LONG = 30_000;

for (const [syntax, App] of [
  ['jsx', JsxApp],
  ['ui', UiApp],
] as const) {
  describe(`the git client (${syntax})`, () => {
    it(
      'should list the changes, the branches and the log of the repository it was given',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        repo.write('c.txt', ['new']);
        const client = await mount(App, repo);
        const screen = client.screen();

        expect(screen).toMatch(/\[1\] Files · 2/);
        expect(screen).toMatch(/ M a\.txt/);
        expect(screen).toMatch(/\?\? c\.txt/);
        // the cursor starts on the branch checked out, not the first by name; the
        // pointer is `>` where the terminal is not taken to draw unicode, which is
        // a Windows runner
        expect(screen).toMatch(/[❯>] \* main/);
        expect(screen).toMatch(/feature/);
        expect(screen).toMatch(/\[3\] Commits · 1/);
        expect(screen).toMatch(/ first/);
        // and the diff of the first file, both hunks of it
        expect(screen).toMatch(/\[4\] a\.txt/);
        expect(screen).toMatch(/-3/);
        expect(screen).toMatch(/\+three/);
        // the footer follows the focus, which starts on the files
        expect(screen).toMatch(/space stage/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should stage a file with Space, and unstage it with Space again',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        const client = await mount(App, repo);

        await client.press(' ');
        expect(repo.git('diff', '--cached', '--name-only')).toBe('a.txt\n');
        expect(client.screen()).toMatch(/M  a\.txt/);
        expect(client.screen()).toMatch(/Staged a\.txt/);

        await client.press(' ');
        expect(repo.git('diff', '--cached', '--name-only')).toBe('');
        expect(client.screen()).toMatch(/ M a\.txt/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should stage one hunk of two from the diff pane, and unstage it again',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        const client = await mount(App, repo);

        // the second hunk: `]` moves the cursor, Space stages what it is on
        await client.press('4', ']', ' ');
        const staged = repo.git('diff', '--cached');
        expect(staged).toMatch(/\+twenty-five/);
        expect(staged).not.toMatch(/\+three/);
        expect(repo.git('diff')).toMatch(/\+three/);
        expect(client.screen()).toMatch(/MM a\.txt/);
        expect(client.screen()).toMatch(/Staged a hunk of a\.txt/);

        // the staged hunk is last now, under `Staged`; the cursor stays on the
        // second hunk, which is it
        await client.press(' ');
        expect(repo.git('diff', '--cached')).toBe('');
        expect(client.screen()).toMatch(/ M a\.txt/);

        // and `[` back to the first
        await client.press('[', ' ');
        expect(repo.git('diff', '--cached')).toMatch(/\+three/);
        expect(repo.git('diff', '--cached')).not.toMatch(/\+twenty-five/);

        // Escape goes back to the list the diff is of, and the footer with it
        expect(client.screen()).toMatch(/space stage hunk/);
        await escape(client);
        expect(client.screen()).toMatch(/[▸>] \[1\] Files/);
        expect(client.screen()).toMatch(/space stage ·/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should stage a file with no final newline a hunk at a time',
      async () => {
        const repo = repository();
        writeFileSync(join(repo.dir, 'b.txt'), 'bee, with no newline');
        const client = await mount(App, repo);

        // `b.txt` is the only change, so it is what the diff pane shows
        await client.press('4', ' ');
        expect(repo.git('diff', '--cached')).toMatch(/\\ No newline at end of file/);
        expect(repo.git('show', ':b.txt')).toBe('bee, with no newline');

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should unstage a rename with no content changes whole, from the diff pane',
      async () => {
        const repo = repository();
        repo.git('mv', 'a.txt', 'moved.txt');
        const client = await mount(App, repo);

        // a pure rename is one file with no hunks, so Space in the diff pane
        // unstages the whole of it -- its source included, or the deletion of
        // `a.txt` would stay staged (`D  a.txt`) beside an untracked
        // `moved.txt`. `git mv` moved the file on disk, so with nothing staged
        // the rename is left as a deletion and a new file in the working tree,
        // which is what Space on the file in the files pane leaves too
        await client.press('4', ' ');
        expect(repo.git('diff', '--cached', '--name-only')).toBe('');
        expect(repo.git('status', '--porcelain')).toBe(' D a.txt\n?? moved.txt\n');
        expect(client.screen()).toMatch(/Unstaged moved\.txt/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should commit what is staged, with a message written in a text area',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        const client = await mount(App, repo);

        await client.press(' ', 'c');
        expect(client.screen()).toMatch(/Commit/);
        // Enter is a newline in the area, so the message has a body
        await client.press('Change two lines', KEYS.enter, KEYS.enter, 'Three and twenty-five.');
        await client.press(ctrl('s'));

        expect(repo.git('log', '-1', '--format=%B')).toBe(
          'Change two lines\n\nThree and twenty-five.\n\n'
        );
        expect(repo.git('status', '--porcelain')).toBe('');
        expect(client.screen()).toMatch(/Committed [0-9a-f]+: Change two lines/);
        expect(client.screen()).toMatch(/\[3\] Commits · 2/);

        // a commit that went through takes its draft with it, so the next
        // dialog opens empty and answering it at once commits nothing
        repo.write('b.txt', ['bee', 'and more']);
        await client.press('r', ' ', 'c', ctrl('s'));
        expect(client.screen()).toMatch(/An empty message: nothing committed/);
        expect(repo.git('rev-list', '--count', 'HEAD')).toBe('2\n');

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should not commit when nothing is staged, or when the message is empty',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        const client = await mount(App, repo);

        await client.press('c');
        expect(client.screen()).toMatch(/Nothing is staged/);

        // staged, and the dialog answered with nothing written in it
        await client.press(' ', 'c', ctrl('s'));
        expect(client.screen()).toMatch(/An empty message: nothing committed/);
        expect(repo.git('rev-list', '--count', 'HEAD')).toBe('1\n');

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should keep a draft through Escape, and commit it later',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        const client = await mount(App, repo);

        await client.press(' ', 'c', 'Kept');
        await escape(client);
        expect(repo.git('rev-list', '--count', 'HEAD')).toBe('1\n');

        await client.press('c', ctrl('s'));
        expect(repo.git('log', '-1', '--format=%s')).toBe('Kept\n');

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should discard a file only once the confirm is answered yes',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        const client = await mount(App, repo);

        // the confirm starts on No, so Enter keeps the changes
        await client.press('d');
        expect(client.screen()).toMatch(/Discard the unstaged changes to a\.txt/);
        await client.press(KEYS.enter);
        expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toMatch(/three/);

        // Escape is a no as well
        await client.press('d');
        await escape(client);
        expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toMatch(/three/);

        // Tab to Yes, then Enter
        await client.press('d', KEYS.tab, KEYS.enter);
        expect(readFileSync(join(repo.dir, 'a.txt'), 'utf8')).toBe(
          NUMBERS.map((n) => `${n}\n`).join('')
        );
        expect(client.screen()).toMatch(/Discarded the changes to a\.txt/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should delete an untracked file only once the confirm is answered yes',
      async () => {
        const repo = repository();
        repo.write('c.txt', ['scratch']);
        const client = await mount(App, repo);

        await client.press('d');
        expect(client.screen()).toMatch(/Delete c\.txt\? It is untracked/);
        await client.press(KEYS.enter);
        expect(existsSync(join(repo.dir, 'c.txt'))).toBe(true);

        await client.press('d', KEYS.tab, KEYS.enter);
        expect(existsSync(join(repo.dir, 'c.txt'))).toBe(false);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should stage an untracked file whole from the diff pane',
      async () => {
        const repo = repository();
        repo.write('c.txt', ['one', 'two']);
        const client = await mount(App, repo);
        expect(client.screen()).toMatch(/\+two/);

        await client.press('4', ' ');
        expect(repo.git('diff', '--cached', '--name-only')).toBe('c.txt\n');

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should switch branches, and make one from a dialog',
      async () => {
        const repo = repository();
        const client = await mount(App, repo);

        // `feature` is above `main`, so Up from where the cursor starts
        await client.press('2', KEYS.up, ' ');
        expect(repo.git('branch', '--show-current')).toBe('feature\n');
        expect(client.screen()).toMatch(/Switched to feature/);

        await client.press('n', 'topic', KEYS.enter);
        expect(repo.git('branch', '--show-current')).toBe('topic\n');
        expect(client.screen()).toMatch(/\[2\] Branches · 3/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should delete a branch only once the confirm is answered yes, and never the one checked out',
      async () => {
        const repo = repository();
        const client = await mount(App, repo);

        // the cursor starts on `main`, which is checked out
        await client.press('2', 'D');
        expect(client.screen()).toMatch(/main is checked out/);
        expect(repo.git('branch', '--list', 'main')).toMatch(/main/);

        await client.press(KEYS.up, 'D');
        expect(client.screen()).toMatch(/Delete the branch feature\?/);
        await client.press(KEYS.enter);
        expect(repo.git('branch', '--list', 'feature')).toMatch(/feature/);

        await client.press('D', KEYS.tab, KEYS.enter);
        expect(repo.git('branch', '--list', 'feature')).toBe('');
        expect(client.screen()).toMatch(/\[2\] Branches · 1/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should show a commit, and say what git said when it refuses',
      async () => {
        const repo = repository();
        repo.write('a.txt', TWO_HUNKS);
        repo.git('commit', '-q', '-a', '-m', 'Two lines', '-m', 'With a body.');
        repo.write('a.txt', ['changed again']);
        const client = await mount(App, repo);

        await client.press('3');
        expect(client.screen()).toMatch(/Author: Ada <ada@example\.com>/);
        expect(client.screen()).toMatch(/With a body\./);
        expect(client.screen()).toMatch(/\+twenty-five/);

        // a switch the working tree would lose changes to: git refuses, and says so
        await client.press('2', KEYS.up, ' ');
        expect(repo.git('branch', '--show-current')).toBe('main\n');
        expect(client.screen()).toMatch(/would be overwritten/);

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should start on a repository with no commits, and make the first',
      async () => {
        const repo = repository({ empty: true });
        repo.write('a.txt', ['first line']);
        const client = await mount(App, repo);
        expect(client.screen()).toMatch(/No commits yet/);

        await client.press(' ', 'c', 'Begin', ctrl('s'));
        expect(repo.git('log', '--format=%s')).toBe('Begin\n');

        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );

    it(
      'should say so in a directory that is not a repository, and still quit',
      async () => {
        const repo = repository({ init: false });
        const client = await mount(App, repo);
        expect(client.screen()).toMatch(/not a git repository/);

        await client.press(' ', 'c', '4', ' ');
        await client.press('q');
        expect(await client.app.exited).toBe(0);
      },
      LONG
    );
  });
}
