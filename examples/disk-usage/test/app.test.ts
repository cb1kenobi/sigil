import type { Disk } from '../src/disk.ts';
import { exitMounted, mount, type Mounted, removeTempDirs, tempDir, write } from './fixture.ts';
import { frame, KEYS } from '@ttylabs/sigil/testing';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The visualizer run by `runApp()` over a test terminal, scanning a directory each
 * test makes for itself -- the real disk, through `DiskContext`, which is what
 * `src/index.ts` provides with the directory it was given. Every delete here
 * happens inside that directory, and the assertions are on the disk as well as on
 * the screen.
 */

afterAll(removeTempDirs);

// the borders and the tree's guides are drawn from the environment, and a
// Windows runner says ASCII: these say what a terminal that draws box characters
// is, so the screens below are the same on every runner
beforeEach(() => {
  vi.stubEnv('TERM', 'xterm-256color');
  vi.stubEnv('WT_SESSION', '1');
});
afterEach(() => {
  exitMounted();
  vi.unstubAllEnvs();
});

const LONG = 30_000;

/**
 * `work/`: media that is most of it, some source, a note, and an empty directory.
 * 97,000 bytes in all.
 */
function workspace(): string {
  const root = tempDir();
  write(root, {
    work: {
      empty: {},
      media: { 'clip.mp4': 60_000, 'song.mp3': 20_000 },
      'notes.md': 5000,
      src: { 'main.ts': 9000, 'util.ts': 3000 },
    },
  });
  return join(root, 'work');
}

/** The line under the panes, which says what is selected. */
function info(m: Mounted): string {
  const rows = m.term.viewport;
  return rows.at(-2) ?? '';
}

/** The map's half of the screen: every row's text right of the tree's panel. */
function mapPart(m: Mounted): string {
  return m.term.viewport
    .slice(1, -2)
    .map((row) => row.slice(row.indexOf('╮╭') + 2))
    .join('\n');
}

describe('the disk usage visualizer', () => {
  it(
    'should list every directory and file largest first, with a total for each',
    async () => {
      const work = workspace();
      const m = await mount(work);
      const screen = m.screen();
      expect(screen).toMatch(/❯ ▾ work +97\.0 kB/);
      // sorted by what each holds, the empty directory last, sizes aligned on
      // the right of the column
      const order = ['media', 'src', 'notes.md', 'empty'].map((name) => screen.indexOf(name));
      expect(order).toStrictEqual(order.toSorted((a, b) => a - b));
      expect(screen).toMatch(/▸ media +80\.0 kB/);
      expect(screen).toMatch(/▸ src +12\.0 kB/);
      expect(screen).toMatch(/notes\.md +5\.0 kB/);
      expect(screen).toMatch(/▸ empty +0 B/);
      // the header has the total, the map is of the root, the line under says so
      expect(screen).toMatch(/97\.0 kB in 5 files/);
      expect(screen).toMatch(/Map: work/);
      expect(info(m)).toMatch(/work · 97\.0 kB · 100\.0% · 5 files/);
      expect(screen).toMatch(/Scanned 5 files/);
      // and the map names what it can
      expect(mapPart(m)).toMatch(/clip\.mp4/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should open and close a directory, and keep the map on the selection',
    async () => {
      const work = workspace();
      const m = await mount(work);
      const before = mapPart(m);
      await m.press(KEYS.down);
      expect(info(m)).toMatch(/work[\\/]media · 80\.0 kB · 82\.5% · 2 files/);
      // moving the selection moves the outline, which is the map changing and
      // nothing else on it
      expect(mapPart(m)).not.toBe(before);

      await m.press(KEYS.right, KEYS.down);
      expect(m.screen()).toMatch(/❯ │ +├── +clip\.mp4 +60\.0 kB/u);
      expect(info(m)).toMatch(/clip\.mp4 · 60\.0 kB · 61\.9%/);
      const onClip = mapPart(m);
      await m.press(KEYS.down);
      expect(info(m)).toMatch(/song\.mp3 · 20\.0 kB/);
      expect(mapPart(m)).not.toBe(onClip);

      // Left goes to the directory and closes it
      await m.press(KEYS.left, KEYS.left);
      expect(m.screen()).toMatch(/❯ ├── ▸ media/u);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should map a directory on Enter and its parent on Backspace, and follow the selection out',
    async () => {
      const work = workspace();
      const m = await mount(work);
      await m.press(KEYS.down, KEYS.down, KEYS.enter);
      expect(m.screen()).toMatch(/Map: work[\\/]src/);
      expect(mapPart(m)).toMatch(/main\.ts/);
      expect(mapPart(m)).not.toMatch(/clip\.mp4/);

      await m.press(KEYS.backspace);
      expect(m.screen()).toMatch(/Map: work /);
      expect(mapPart(m)).toMatch(/clip\.mp4/);

      // mapped into `src` and then moved off it, to `media`: the map goes back up
      // to where both are, so the selection is always on it
      await m.press(KEYS.enter);
      expect(m.screen()).toMatch(/Map: work[\\/]src/);
      await m.press(KEYS.up);
      expect(m.screen()).toMatch(/Map: work /);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should map the directory a row is double-clicked on, and say map it for Enter',
    async () => {
      const work = workspace();
      const m = await mount(work, { mouse: true });
      // Enter is the tree's own, worded for what it does here
      const footer = m.term.viewport.at(-1) ?? '';
      expect(footer).toMatch(/map it/);
      expect(footer).not.toMatch(/open/);

      const rows = m.term.viewport;
      const y = rows.findIndex((row) => / src +12\.0 kB/.test(row));
      expect(y).toBeGreaterThan(0);
      const x = (rows[y] as string).indexOf('src') + 1;
      const click = `\x1b[<0;${x};${y + 1}M\x1b[<0;${x};${y + 1}m`;
      // both clicks in one read, as a fast double click arrives
      await m.press(click + click);
      expect(info(m)).toMatch(/work[\\/]src · 12\.0 kB/);
      expect(m.screen()).toMatch(/Map: work[\\/]src/);
      expect(mapPart(m)).toMatch(/main\.ts/);
      expect(mapPart(m)).not.toMatch(/clip\.mp4/);

      // a file maps the directory it is in: back up to the root, then into `src`
      // by a double click on one of its files
      await m.press(KEYS.backspace, KEYS.right);
      expect(m.screen()).toMatch(/Map: work /);
      const at = m.term.viewport.findIndex((row) => row.includes('util.ts'));
      expect(at).toBeGreaterThan(0);
      const column = (m.term.viewport[at] as string).indexOf('util.ts') + 1;
      const onFile = `\x1b[<0;${column};${at + 1}M\x1b[<0;${column};${at + 1}m`;
      await m.press(onFile + onFile);
      expect(info(m)).toMatch(/util\.ts · 3\.0 kB/);
      expect(m.screen()).toMatch(/Map: work[\\/]src(?![\\/])/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should delete only once the confirm is answered yes, which it does not start on',
    async () => {
      const work = workspace();
      const m = await mount(work);
      await m.press(KEYS.down);
      // the confirm starts on No, so Enter keeps it, and so does Escape
      await m.press('d');
      expect(m.screen()).toMatch(/Delete the directory media and everything in/);
      expect(m.screen()).toMatch(/80\.0 kB, 2 files/);
      await m.press(KEYS.enter);
      expect(existsSync(join(work, 'media'))).toBe(true);
      await m.press('d');
      await m.escape();
      expect(existsSync(join(work, 'media'))).toBe(true);
      expect(m.calls).toStrictEqual([]);

      await m.press('d', KEYS.tab, KEYS.enter);
      expect(existsSync(join(work, 'media'))).toBe(false);
      expect(m.calls).toStrictEqual([`remove ${join(work, 'media')}`]);
      // the sizes follow without a rescan: the total, the order, the share
      expect(m.screen()).toMatch(/❯ ▾ work +17\.0 kB|17\.0 kB in 3 files/);
      expect(m.screen()).toMatch(/Deleted media, freed 80\.0 kB/);
      // and the cursor is on what came after it
      expect(info(m)).toMatch(/work[\\/]src · 12\.0 kB · 70\.6%/);
      expect(mapPart(m)).not.toMatch(/clip\.mp4/);
      expect(m.screen()).not.toMatch(/▸ media/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should move to the trash on t, after a confirm that starts on Yes',
    async () => {
      const work = workspace();
      const m = await mount(work);
      await m.press(KEYS.down, 't');
      expect(m.screen()).toMatch(/Move the directory media and everything in it/);
      await m.escape();
      expect(existsSync(join(work, 'media'))).toBe(true);
      expect(m.calls).toStrictEqual([]);

      // Enter takes the button it starts on, which for a trash is Yes
      await m.press('t', KEYS.enter);
      expect(existsSync(join(work, 'media'))).toBe(false);
      expect(m.calls).toStrictEqual([`trash ${join(work, 'media')}`]);
      expect(m.screen()).toMatch(/❯ ▾ work +17\.0 kB|17\.0 kB in 3 files/);
      // and it does not claim to have freed what the trash still holds (the
      // toast covers the end of the line)
      expect(m.screen()).toMatch(/Moved media to the trash: 80\.0 kB, freed when it is/);
      expect(m.screen()).not.toMatch(/freed 80/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should leave the item, say why, and not scan again when the trash will not take it',
    async () => {
      const work = workspace();
      let lists = 0;
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            lists++;
            return disk.list(dir);
          },
          trash: async (path) => {
            throw new Error(`Could not move ${path} to the trash: it is the top of a mount`, {
              cause: new Error('it is the top of a mount'),
            });
          },
        }),
      });
      const scanned = lists;
      await m.press(KEYS.down, 't', KEYS.enter);
      // the reason, under the item's own name rather than its whole path
      expect(m.screen()).toMatch(/Could not move media to the trash: it is/);
      expect(existsSync(join(work, 'media'))).toBe(true);
      expect(m.screen()).toMatch(/▸ media +80\.0 kB/);
      // a trash moves the item or leaves it, so there is nothing to read again
      expect(lists).toBe(scanned);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should scan again when the trash does not say where it moved to',
    async () => {
      const work = workspace();
      let lists = 0;
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            lists++;
            return disk.list(dir);
          },
          // Windows, when the shell recycles an item without handing it back
          trash: async (path) => {
            await disk.trash(path);
            return '';
          },
        }),
      });
      const scanned = lists;
      await m.press(KEYS.down, 't', KEYS.enter);
      expect(lists).toBeGreaterThan(scanned);
      expect(m.screen()).toMatch(/Rescanned 3 files/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should scan again when the trash it moved to is inside the directory scanned',
    async () => {
      const work = workspace();
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          // a home directory on Linux, whose trash is under it
          trash: async (path) => {
            mkdirSync(join(work, 'Trash'), { recursive: true });
            const to = join(work, 'Trash', 'media');
            renameSync(path, to);
            return to;
          },
        }),
      });
      await m.press(KEYS.down, 't', KEYS.enter);
      expect(m.screen()).toMatch(/Rescanned 5 files/);
      // the bytes are still under the root, so the total has not moved
      expect(m.screen()).toMatch(/97\.0 kB in 5 files/);
      expect(m.screen()).toMatch(/▸ Trash +80\.0 kB/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should delete a file and move the cursor to the one before when it was the last',
    async () => {
      const work = workspace();
      const m = await mount(work);
      await m.press(KEYS.down, KEYS.down, KEYS.right, KEYS.down, KEYS.down);
      expect(info(m)).toMatch(/util\.ts · 3\.0 kB/);
      await m.press('d');
      expect(m.screen()).toMatch(/Delete util\.ts \(3\.0 kB\)\?/);
      await m.press(KEYS.tab, KEYS.enter);
      expect(existsSync(join(work, 'src', 'util.ts'))).toBe(false);
      expect(existsSync(join(work, 'src', 'main.ts'))).toBe(true);
      expect(info(m)).toMatch(/main\.ts · 9\.0 kB/);
      expect(m.screen()).toMatch(/▾ src +9\.0 kB/);
      // gone from the open branch it was read into, not only from the sizes
      expect(m.screen()).not.toMatch(/── +util\.ts/u);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should keep r for the confirm while it is open, so no scan starts under a delete',
    async () => {
      // `d` is refused while a scan runs, and this is the other half: the dialog
      // has the keys, so the tree a delete is applied to is the one it asked over
      const work = workspace();
      const m = await mount(work);
      await m.press(KEYS.down, 'd', 'r');
      expect(m.screen()).not.toMatch(/Rescanning/);
      await m.press(KEYS.tab, KEYS.enter);
      expect(existsSync(join(work, 'media'))).toBe(false);
      expect(m.screen()).toMatch(/Deleted media, freed 80\.0 kB/);
      expect(m.screen()).not.toMatch(/Rescanned/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should neither scan nor ask again while a delete is on its way',
    async () => {
      // a scan under an `rm` reads half of what it removes and would put it back
      // on screen when it ended; a second confirm would delete the same thing
      const work = workspace();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let lists = 0;
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            lists++;
            return disk.list(dir);
          },
          remove: async (path) => {
            await gate;
            return disk.remove(path);
          },
        }),
      });
      const scanned = lists;
      await m.term.press(KEYS.down, 'd');
      await m.term.press(KEYS.tab);
      await m.term.press(KEYS.enter);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await m.term.press('r');
      await m.term.press('d');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(m.screen()).toMatch(/Wait for the delete to finish/);
      expect(m.screen()).not.toMatch(/Delete the directory/);
      expect(lists).toBe(scanned);
      release();
      await m.settle();
      expect(existsSync(join(work, 'media'))).toBe(false);
      expect(m.calls).toStrictEqual([`remove ${join(work, 'media')}`]);
      expect(m.screen()).toMatch(/Deleted media, freed 80\.0 kB/);
      expect(m.screen()).toMatch(/17\.0 kB in 3 files/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should stop showing a scan it threw away, though that scan is still waiting on the disk',
    async () => {
      // the first scan is held in its very first read for good, so its walk
      // never looks at the signal again; `r` replaces it, and the replacement
      // ends -- after which nothing may still be counting
      const work = workspace();
      let first = true;
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      const m = await mount(work, {
        settled: false,
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            if (first && dir === work) {
              first = false;
              held();
              await new Promise(() => {});
            }
            return disk.list(dir);
          },
        }),
      });
      // the first scan is inside its read before `r` replaces it, whatever the
      // runner's speed; and the replacement is waited for by what it says, since
      // the disk never goes quiet for `settle()` to see
      await holding;
      await m.term.press('r');
      const deadline = Date.now() + 20_000;
      while (!/Rescanned 5 files/.test(m.screen())) {
        expect(Date.now(), m.screen()).toBeLessThan(deadline);
        await frame(m.app);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      // three of the thrown-away scan's progress ticks, which would each have
      // written its counts back over the header
      await new Promise((resolve) => setTimeout(resolve, 350));
      await frame(m.app);
      expect(m.screen()).toMatch(/Rescanned 5 files/);
      expect(m.screen()).not.toMatch(/scanning \d+ files/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should say a directory mapped with Enter that could not be read was not read',
    async () => {
      const work = workspace();
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            if (dir === join(work, 'empty')) {
              throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            }
            return disk.list(dir);
          },
        }),
      });
      await m.press(KEYS.end, KEYS.enter);
      expect(m.screen()).toMatch(/Map: work[\\/]empty/);
      expect(mapPart(m)).toMatch(/Could not be read: EACCES/);
      expect(mapPart(m)).not.toMatch(/Nothing here/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should say why a scan failed over the tree the last one left',
    async () => {
      const work = workspace();
      let broken = false;
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          stat: async (path) => {
            if (broken && path === work) {
              throw Object.assign(new Error('no such file or directory'), { code: 'ENOENT' });
            }
            return disk.stat(path);
          },
        }),
      });
      broken = true;
      await m.press('r');
      expect(m.screen()).toMatch(/Scan failed/);
      expect(m.screen()).toMatch(/Could not scan/);
      // and the last tree is still there to look at
      expect(m.screen()).toMatch(/▸ media +80\.0 kB/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should say a root that could not be read was not read, not that it is empty',
    async () => {
      const work = workspace();
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            if (dir === work) {
              throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
            }
            return disk.list(dir);
          },
        }),
      });
      expect(mapPart(m)).toMatch(/Could not be read: EACCES/);
      expect(mapPart(m)).not.toMatch(/Nothing here/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should not delete the root it scanned',
    async () => {
      const work = workspace();
      const m = await mount(work);
      await m.press('d');
      expect(m.screen()).toMatch(/The root is not deleted from here/);
      expect(m.screen()).not.toMatch(/Delete the directory/);
      expect(existsSync(work)).toBe(true);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should say so, and scan again, when a delete fails part of the way',
    async () => {
      const work = workspace();
      let lists = 0;
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            lists++;
            return disk.list(dir);
          },
          async remove(path) {
            // one file goes and then the delete fails, as a permission would
            await disk.remove(join(path, 'song.mp3'));
            throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' });
          },
        }),
      });
      const scanned = lists;
      await m.press(KEYS.down, 'd', KEYS.tab, KEYS.enter);
      expect(m.screen()).toMatch(/Could not delete media/);
      // what is left is read again rather than guessed at
      expect(lists).toBeGreaterThan(scanned);
      expect(m.screen()).toMatch(/▸ media +60\.0 kB/);
      expect(m.screen()).toMatch(/Rescanned 4 files/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should scan again on r, keeping the selection',
    async () => {
      const work = workspace();
      const m = await mount(work);
      await m.press(KEYS.down, KEYS.down);
      expect(info(m)).toMatch(/work[\\/]src · 12\.0 kB/);
      write(work, { src: { 'big.ts': 100_000 } });
      await m.press('r');
      expect(m.screen()).toMatch(/Rescanned 6 files/);
      expect(m.screen()).toMatch(/197\.0 kB in 6 files/);
      // `src` is the largest now, and still selected
      expect(info(m)).toMatch(/work[\\/]src · 112\.0 kB/);
      expect(m.screen()).toMatch(/❯ ├── ▸ src +112\.0 kB/u);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should show how far a scan has got while it runs, and refuse to delete until it ends',
    async () => {
      const work = workspace();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let held = false;
      const m = await mount(work, {
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            // the first scan runs through; the second waits in `src`
            if (held && dir === join(work, 'src')) {
              await gate;
            }
            return disk.list(dir);
          },
        }),
      });
      held = true;
      await m.term.press('r');
      // the scan is held, so the counts are read on the progress timer
      await new Promise((resolve) => setTimeout(resolve, 250));
      await m.term.press(KEYS.down);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(m.screen()).toMatch(/scanning \d+ files/);
      await m.term.press('d');
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(m.screen()).toMatch(/Wait for the scan to finish/);
      release();
      await m.settle();
      expect(m.screen()).toMatch(/Rescanned 5 files/);
      expect(m.screen()).not.toMatch(/scanning \d+ files/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should say what is happening on the map before the first scan ends',
    async () => {
      const work = workspace();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const m = await mount(work, {
        settled: false,
        wrap: (disk): Disk => ({
          ...disk,
          list: async (dir) => {
            if (dir === join(work, 'src')) {
              await gate;
            }
            return disk.list(dir);
          },
        }),
      });
      // the counts reach the screen on the progress timer, not per file
      await new Promise((resolve) => setTimeout(resolve, 250));
      await m.term.press(KEYS.down);
      const screen = m.screen();
      expect(mapPart(m)).toMatch(/Scanning\.\.\./);
      expect(mapPart(m)).toMatch(/\d+ files, [\d.]+ kB/);
      // the tree has nothing to show until the scan ends
      expect(screen).toMatch(/│ Scanning\.\.\./);
      expect(screen).toMatch(/scanning \d+ files/);
      release();
      await m.settle();
      expect(m.screen()).toMatch(/Scanned 5 files/);
      expect(mapPart(m)).not.toMatch(/Scanning/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should say why when the root cannot be scanned',
    async () => {
      const missing = join(tempDir(), 'not-here');
      const m = await mount(missing);
      expect(m.screen()).toMatch(/Could not scan/);
      expect(m.screen()).toMatch(/Scan failed/);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should select what is clicked on the map, opening the tree down to it',
    async () => {
      const work = workspace();
      const m = await mount(work, { mouse: true });
      const rows = m.term.viewport;
      const y = rows.findIndex((row) => row.includes('main.ts'));
      expect(y).toBeGreaterThan(0);
      const x = (rows[y] as string).indexOf('main.ts');
      // SGR reports count from one
      await m.press(`\x1b[<0;${x + 2};${y + 1}M`, `\x1b[<0;${x + 2};${y + 1}m`);
      expect(info(m)).toMatch(/work[\\/]src[\\/]main\.ts · 9\.0 kB/);
      expect(m.screen()).toMatch(/❯ │ +├── +main\.ts +9\.0 kB/u);
      m.app.exit(0);
    },
    LONG
  );

  it.skipIf(process.platform === 'win32')(
    'should draw a control character in a name as a replacement, not drop it',
    async () => {
      // Windows does not allow one in a name at all
      const work = workspace();
      write(work, { 'bad\u001b[31mname.bin': 200_000 });
      const m = await mount(work);
      expect(m.screen()).toMatch(/bad�\[31mname\.bin/u);
      await m.press(KEYS.down);
      expect(info(m)).toMatch(/bad�\[31mname\.bin · 200\.0 kB/u);
      m.app.exit(0);
    },
    LONG
  );

  it(
    'should draw at every size from the smallest the examples are run at',
    async () => {
      const work = workspace();
      for (const [columns, rows] of [
        [60, 16],
        [80, 24],
        [160, 48],
      ] as const) {
        for (const colorLevel of [0, 1, 2, 3] as const) {
          const m = await mount(work, { colorLevel, columns, rows });
          const screen = m.screen();
          expect(screen, `${columns}x${rows} at ${colorLevel}`).toMatch(/Files/);
          expect(screen, `${columns}x${rows} at ${colorLevel}`).toMatch(/Map: work/);
          expect(screen, `${columns}x${rows} at ${colorLevel}`).toMatch(/[█▀▄]/);
          m.app.exit(0);
        }
      }
    },
    LONG
  );
});
