/**
 * What the file manager's tests share: a directory of their own under the temp
 * directory, removed when the file is done, and the manager mounted over a test
 * terminal with its file system counted.
 *
 * Every destructive operation a test runs is run inside one of these directories
 * and nowhere else: the manager is pointed at it through `FilesContext`, which is
 * what `src/ui.ts` provides with the working directory. A trash too: the file
 * system a test mounts moves an item into a directory of its own made here, never
 * into the trash of the machine the suite runs on, which `@ttylabs/sigil/trash`'s
 * own tests cover.
 */

import { createFiles, type Files, FilesContext } from '../src/files.ts';
import { stylesheet } from '../src/root.ui.ts';
import { type App, runApp } from '@ttylabs/sigil/app';
import type { Element } from '@ttylabs/sigil/element';
import { encodePng } from '@ttylabs/sigil/png';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, frame, pressEscape, type TestTerminal } from '@ttylabs/sigil/testing';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Every directory a test file made, which its `afterAll` hands to {@link removeTempDirs}. */
const made: string[] = [];

/**
 * A new, empty directory under the temp directory, with its links resolved -- on
 * macOS the temp directory is behind `/var`, a link to `/private/var`, and a path
 * the manager prints is compared with one the test built.
 *
 * @returns Its path.
 */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sigil-file-manager-')));
  made.push(dir);
  return dir;
}

/**
 * Removes every directory {@link tempDir} made. `maxRetries` for Windows, where a
 * directory only just let go of can answer EBUSY for a moment; one that still
 * cannot go fails the file, as `tempDir()` does in every package
 * (`packages/sigil/src/testing/AGENTS.md`).
 */
export function removeTempDirs(): void {
  for (const dir of made.splice(0)) {
    rmSync(dir, { force: true, maxRetries: 5, recursive: true });
  }
}

/** A picture: four pixels across, two down, red on the left and blue on the right. */
export const PICTURE: Uint8Array = encodePng({
  data: new Uint8Array([
    255, 0, 0, 255, 255, 0, 0, 255, 0, 0, 255, 255, 0, 0, 255, 255, 255, 0, 0, 255, 255, 0, 0, 255,
    0, 0, 255, 255, 0, 0, 255, 255,
  ]),
  height: 2,
  width: 4,
});

/**
 * Writes files under a directory: a string is a file's text, bytes are its bytes,
 * and an object is a directory of more.
 *
 * @param dir - Where.
 * @param spec - What.
 */
export function write(dir: string, spec: Tree): void {
  for (const [name, value] of Object.entries(spec)) {
    const path = join(dir, name);
    if (typeof value === 'string' || value instanceof Uint8Array) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value);
    } else {
      mkdirSync(path, { recursive: true });
      write(path, value);
    }
  }
}

/** Every manager {@link mount} started, so a failed assertion still gives its terminal back. */
const mounted: App[] = [];

/** Ends every manager {@link mount} started and a test did not end itself. */
export function exitMounted(): void {
  for (const app of mounted.splice(0)) {
    app.exit(0);
  }
}

/** Whether the temp directory's file system ignores case, as macOS's and Windows' do by default. */
export function ignoresCase(): boolean {
  const dir = tempDir();
  write(dir, { probe: '' });
  return existsSync(join(dir, 'PROBE'));
}

/** What {@link write} writes. */
export interface Tree {
  readonly [name: string]: string | Uint8Array | Tree;
}

/** A mounted manager, and how a test drives it. */
export interface Mounted {
  readonly app: App;
  /** Presses keys, waiting for the file system after each. */
  press(...keys: string[]): Promise<void>;
  /** Escape, which the router holds back a moment in case it starts a sequence. */
  escape(): Promise<void>;
  /** The screen, a row a line. */
  screen(): string;
  /** Waits until every read and write has finished and the frame after it is drawn. */
  settle(): Promise<void>;
  readonly term: TestTerminal;
  /** Types text, a key at a time. */
  type(value: string): Promise<void>;
}

/**
 * Mounts a root over a test terminal, with the file system opened at `start` and
 * counted, so that `settle()` waits for what the manager asked of it rather than
 * for a guess at how long a disk takes.
 *
 * @param App - The root.
 * @param start - Where it opens.
 * @param opts - The terminal's size and colour level, and a wrapper for the file
 *   system when a test needs one call to behave differently.
 * @returns The mounted manager.
 */
export async function mount(
  App: () => Element,
  start: string,
  opts: {
    colorLevel?: 0 | 1 | 2 | 3;
    columns?: number;
    rows?: number;
    wrap?: (files: Files) => Files;
  } = {}
): Promise<Mounted> {
  // a trash of the test's own, in place before any wrap sees the file system: the
  // real one is the user's
  const bin = tempDir();
  const fake: Files = {
    ...createFiles({ start }),
    async trash(path) {
      const to = join(bin, basename(path));
      await rename(path, to);
      return to;
    },
  };
  const real = (opts.wrap ?? ((files: Files) => files))(fake);
  let running = 0;
  const counted =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      running++;
      return fn(...args).finally(() => {
        running--;
      });
    };
  const files: Files = {
    copy: counted(real.copy),
    list: counted(real.list),
    move: counted(real.move),
    read: counted(real.read),
    real: counted(real.real),
    remove: counted(real.remove),
    same: counted(real.same),
    start: real.start,
    taken: counted(real.taken),
    trash: counted(real.trash),
  };
  const term = createTestTerminal({
    colorLevel: opts.colorLevel ?? 0,
    columns: opts.columns ?? 100,
    rows: opts.rows ?? 24,
  });
  const app = runApp(() => provideContext(FilesContext, files, App), {
    detect: false,
    sheets: [stylesheet],
    terminal: term.terminal,
  });
  mounted.push(app);

  // idle for three frames running: a read that resolves starts the next one
  // within a turn, so one quiet frame is not yet quiet
  const settle = async (): Promise<void> => {
    const deadline = Date.now() + 20_000;
    let quiet = 0;
    while (quiet < 3) {
      if (Date.now() > deadline) {
        throw new Error(`the file system was still busy after 20s:\n${term.viewport.join('\n')}`);
      }
      await frame(app);
      quiet = running === 0 ? quiet + 1 : 0;
      if (running) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      } else {
        await new Promise((resolve) => setImmediate(resolve));
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
  return {
    app,
    escape: async () => {
      await pressEscape(term);
      await settle();
    },
    press,
    screen: () => term.viewport.join('\n'),
    settle,
    term,
    type: (value) => press(...Array.from(value)),
  };
}
