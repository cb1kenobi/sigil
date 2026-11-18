/**
 * What the visualizer's tests share: a directory of their own under the temp
 * directory, removed when the file is done, and the visualizer mounted over a
 * test terminal with its disk counted.
 *
 * Every delete a test runs is inside one of these directories and nowhere else:
 * the visualizer is pointed at it through `DiskContext`, which is what
 * `src/index.ts` provides with the directory it was given. So is every trash: the
 * disk a test mounts moves an item into a directory of its own made here, never
 * into the trash of the machine the suite runs on, which `@ttylabs/sigil/trash`'s
 * own tests cover.
 */

import { createDisk, type Disk, DiskContext } from '../src/disk.ts';
import { App, stylesheet } from '../src/root.tsx';
import { type App as RunningApp, runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';
import { createTestTerminal, frame, KEYS, type TestTerminal } from '@ttylabs/sigil/testing';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** Every directory a test file made, which its `afterAll` hands to {@link removeTempDirs}. */
const made: string[] = [];

/**
 * A new, empty directory under the temp directory, with its links resolved -- on
 * macOS the temp directory is behind `/var`, a link to `/private/var`, and a path
 * the visualizer prints is compared with one the test built.
 *
 * @returns Its path.
 */
export function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sigil-disk-usage-')));
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

/** What {@link write} writes: a number is a file of that many bytes, an object a directory. */
export interface Tree {
  readonly [name: string]: number | string | Tree;
}

/**
 * Writes files under a directory: a number is a file of that many bytes, a string
 * is a file's text, and an object is a directory of more.
 *
 * @param dir - Where.
 * @param spec - What.
 */
export function write(dir: string, spec: Tree): void {
  for (const [name, value] of Object.entries(spec)) {
    const path = join(dir, name);
    if (typeof value === 'number' || typeof value === 'string') {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, typeof value === 'number' ? new Uint8Array(value) : value);
    } else {
      mkdirSync(path, { recursive: true });
      write(path, value);
    }
  }
}

/** Every visualizer {@link mount} started, so a failed assertion still gives its terminal back. */
const mounted: RunningApp[] = [];

/** Ends every visualizer {@link mount} started and a test did not end itself. */
export function exitMounted(): void {
  for (const app of mounted.splice(0)) {
    app.exit(0);
  }
}

/** A mounted visualizer, and how a test drives it. */
export interface Mounted {
  readonly app: RunningApp;
  /** The disk calls it made that change it, in order, as `remove path` and `trash path`. */
  readonly calls: string[];
  /** Escape, which the router holds back a moment in case it starts a sequence. */
  escape(): Promise<void>;
  /** Presses keys, waiting for the disk after each. */
  press(...keys: string[]): Promise<void>;
  /** The screen, a row a line. */
  screen(): string;
  /** Waits until every read and write has finished and the frame after it is drawn. */
  settle(): Promise<void>;
  readonly term: TestTerminal;
}

/**
 * Mounts the visualizer over a test terminal, scanning `root`, with the disk
 * counted so that `settle()` waits for what the visualizer asked of it rather
 * than for a guess at how long a disk takes.
 *
 * @param root - What it scans.
 * @param opts - The terminal's size and colour level, the mouse, and a wrapper for
 *   the disk when a test needs one call to behave differently.
 * @returns The mounted visualizer, once its first scan has finished unless told not to wait.
 */
export async function mount(
  root: string,
  opts: {
    colorLevel?: 0 | 1 | 2 | 3;
    columns?: number;
    mouse?: boolean;
    rows?: number;
    /** Whether to wait for the first scan before handing it back. Defaults to `true`. */
    settled?: boolean;
    wrap?: (disk: Disk) => Disk;
  } = {}
): Promise<Mounted> {
  // a trash of the test's own, in place before any wrap sees the disk: the real
  // one is the user's
  const bin = tempDir();
  const fake: Disk = {
    ...createDisk(root),
    async trash(path) {
      const to = join(bin, basename(path));
      await rename(path, to);
      return to;
    },
  };
  const real = (opts.wrap ?? ((disk: Disk) => disk))(fake);
  const calls: string[] = [];
  let running = 0;
  const counted =
    <A extends [string, ...unknown[]], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      if (name === 'remove' || name === 'trash') {
        calls.push(`${name} ${args[0]}`);
      }
      running++;
      return fn(...args).finally(() => {
        running--;
      });
    };
  const disk: Disk = {
    list: counted('list', real.list),
    remove: counted('remove', real.remove),
    root: real.root,
    stat: counted('stat', real.stat),
    trash: counted('trash', real.trash),
  };
  const term = createTestTerminal({
    colorLevel: opts.colorLevel ?? 0,
    columns: opts.columns ?? 100,
    rows: opts.rows ?? 24,
  });
  const app = runApp(() => provideContext(DiskContext, disk, App), {
    detect: false,
    mouse: opts.mouse ?? false,
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
        throw new Error(`the disk was still busy after 20s:\n${term.viewport.join('\n')}`);
      }
      await frame(app);
      quiet = running === 0 ? quiet + 1 : 0;
      await new Promise((resolve) => setTimeout(resolve, running ? 5 : 1));
    }
  };
  const press = async (...keys: string[]): Promise<void> => {
    for (const key of keys) {
      await term.press(key);
      await settle();
    }
  };
  if (opts.settled ?? true) {
    await settle();
  } else {
    await frame(app);
  }
  return {
    app,
    calls,
    escape: async () => {
      await term.press(KEYS.escape);
      await new Promise((resolve) => setTimeout(resolve, 80));
      await settle();
    },
    press,
    screen: () => term.viewport.join('\n'),
    settle,
    term,
  };
}
