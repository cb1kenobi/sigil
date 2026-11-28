import { tempDir } from './temp.ts';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Two REPLs of one app at once must not lose each other's lines, and this is the
 * only test that can say so.
 *
 * `packages/sigil/test/components/repl-history.test.ts` interleaves two histories
 * in one process, which proves the ordering rules and cannot prove the claim: an
 * append is atomic **between processes**, and a trim that rewrites the file under
 * a lock cannot swallow one that is in flight. That is a property of the file
 * system and of processes, so it is asserted with real ones, through the built
 * package's own subpath, which is also why it is in the package whose tests
 * require a build.
 */

const here = dirname(fileURLToPath(import.meta.url));
const cli = resolve(here, '..');

/** A writer: adds `count` lines named for itself, as fast as it can. */
const WRITER = `
import { createHistory } from '@ttylabs/sigil/components/repl-history';
const [file, name, count, max] = process.argv.slice(1);
const history = createHistory({ file, max: Number(max) });
for (let i = 0; i < Number(count); i++) {
  history.add(name + '-' + i);
}
`;

/** Rewrites the file `rounds` times, as fast as it can. */
const TRIMMER = `
import { createHistory } from '@ttylabs/sigil/components/repl-history';
const [file, rounds] = process.argv.slice(1);
const history = createHistory({ file, max: 10000 });
for (let i = 0; i < Number(rounds); i++) {
  history.trim();
  // a trim happens now and then and not back to back: a lock taken again the
  // instant it is let go is one nobody else can ever get. A rewrite is a flushed
  // temporary file and a rename, tens of milliseconds on a Windows runner, so what
  // is left between two of them is what the writers get to work in -- the first
  // version slept two and its 150 rounds were the whole of the test's time there
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
}
`;

/** Runs a script over a file and says how it ended. */
function spawnScript(script: string, name: string, args: string[]): Promise<number | null> {
  return new Promise((settle, fail) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, '--', ...args], {
      // the package is resolved from the working directory, as an app resolves it
      cwd: cli,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail(new Error(`${name} did not finish within 60s`));
    }, 60_000);
    child.stderr.on('data', (chunk: Buffer) => void (stderr += chunk.toString()));
    child.on('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        fail(new Error(`${name} exited ${code}: ${stderr}`));
      }
      settle(code);
    });
  });
}

/** Runs a trimmer. */
function trimmer(file: string, rounds: number): Promise<number | null> {
  return spawnScript(TRIMMER, 'trimmer', [file, String(rounds)]);
}

/** Runs a writer and says how it ended. */
function write(file: string, name: string, count: number, max: number): Promise<number | null> {
  return spawnScript(WRITER, `writer ${name}`, [file, name, String(count), String(max)]);
}

/** The entries a file holds. */
function entries(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string);
}

describe('a REPL history shared by processes', () => {
  it('should keep every line of four writers appending at once', async () => {
    const file = join(tempDir('sigil-repl-writers-'), 'history');
    const names = ['a', 'b', 'c', 'd'];

    await Promise.all(names.map((name) => write(file, name, 150, 10_000)));

    const held = entries(file);
    expect(held).toHaveLength(600);
    for (const name of names) {
      // each writer's own lines are in the order it wrote them, whatever came between
      const own = held.filter((line) => line.startsWith(`${name}-`));
      expect(own).toEqual(Array.from({ length: 150 }, (_, i) => `${name}-${i}`));
    }
  });

  it('should lose no line to a trim that runs while the others append', async () => {
    const file = join(tempDir('sigil-repl-trim-'), 'history');
    writeFileSync(file, `${JSON.stringify('seed')}\n`);
    const names = ['a', 'b', 'c', 'd'];

    // a fifth process does nothing but rewrite the file as the others append to it.
    // Its cap is far over what is there, so every rewrite holds every line it read --
    // which is what makes a line lost to one a line lost to the rewrite, and not to
    // the cap
    await Promise.all([...names.map((name) => write(file, name, 150, 10_000)), trimmer(file, 40)]);

    const held = entries(file);
    for (const name of names) {
      expect(
        held.filter((line) => line.startsWith(`${name}-`)),
        name
      ).toEqual(Array.from({ length: 150 }, (_, i) => `${name}-${i}`));
    }
  });
});
