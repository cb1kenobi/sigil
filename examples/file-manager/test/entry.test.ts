import { runOnTerminal } from '@ttylabs/sigil/testing';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Whether the `dir` argument reaches the file manager, read off what each entry
 * draws on the terminal it was started on.
 *
 * The entry is the one place `argv.dir` goes into `createFiles()`'s `start`, and
 * the tests beside this one mount `App` under `runApp()` over a `FilesContext` of
 * their own, so none of them runs that line: take it out and the suite stays green
 * over a file manager that always opens the working directory (SIG-594, which is
 * SIG-522's finding for the examples with a flag). The file manager has no mouse,
 * so this is the positional alone.
 *
 * Both entries are spawned, as a whole process over a terminal on stdin and
 * stdout, because they are two schemas that spell the argument separately: the
 * built `bin` is `src/index.ts` as `sigil build` read it, and `src/ui.ts` is the
 * `ui` twin Node runs as it is. The process is started in a directory that is not
 * the one it is given, so the only way for the file inside to be drawn is for the
 * argument to have arrived.
 */

const dir = resolve(import.meta.dirname, '..');
const bin = join(dir, 'dist', 'file-manager.mjs');
const entries = [
  { file: bin, label: 'dist/file-manager.mjs' },
  { file: join(dir, 'src', 'ui.ts'), label: 'src/ui.ts' },
];

/** A directory of its own to run from and one to open, so the two cannot be confused. */
const scratch = mkdtempSync(join(tmpdir(), 'sigil-file-manager-entry-'));
const cwd = join(scratch, 'started-here');
const opened = join(scratch, 'opened-dir');
mkdirSync(cwd);
mkdirSync(opened);
writeFileSync(join(opened, 'weighed.txt'), 'hello\n');
afterAll(() => {
  rmSync(scratch, { force: true, maxRetries: 5, recursive: true });
});

describe('the entry', () => {
  for (const { file, label } of entries) {
    it.concurrent(`should open the directory it was given rather than the working directory: ${label}`, async () => {
      if (file === bin) {
        expect(
          existsSync(file),
          `${file} is missing: run \`pnpm build\` from the repository root, or \`pnpm --filter @ttylabs/example-file-manager build\``
        ).toBe(true);
      }
      const running = runOnTerminal({
        argv: [opened],
        columns: 100,
        cwd,
        rows: 30,
        run: file,
        stdin: true,
      });
      try {
        // longer than the default: several cold node starts at once, on a runner
        // that may be slow
        await running.waitFor(/weighed\.txt/, { timeout: 20_000 });
        await running.press('q');
        const ran = await running;
        expect(ran.err, 'nothing on stderr').toBe('');
        expect(ran.code, 'q quits with 0').toBe(0);
      } finally {
        running.kill();
      }
    }, 45_000);
  }
});
