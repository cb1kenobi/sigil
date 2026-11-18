import { categoryOf, createDisk, type Disk, formatSize, isInside, printable } from '../src/disk.ts';
import { findNode, removePath, scanDisk, shownPath, startProgress } from '../src/scan.ts';
import { removeTempDirs, tempDir, write } from './fixture.ts';
import { linkSync, mkdirSync, symlinkSync } from 'node:fs';
import { join, sep } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The scan and the rules, without an app: what a tree of files counts for, over
 * directories the tests make, and the tree a delete leaves.
 */

afterAll(removeTempDirs);

/**
 * Whether this process can make a symbolic link: Windows needs a privilege for
 * one, which a runner may not have, and a test that returned early there would
 * pass while asserting nothing.
 */
const canLink = ((): boolean => {
  const dir = tempDir();
  try {
    symlinkSync(join(dir, 'nowhere'), join(dir, 'probe-link'));
    return true;
  } catch {
    return false;
  }
})();

describe('formatSize()', () => {
  it('should write bytes, then one decimal in powers of 1000', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(999)).toBe('999 B');
    expect(formatSize(1000)).toBe('1.0 kB');
    expect(formatSize(8200)).toBe('8.2 kB');
    expect(formatSize(530_100_000_000)).toBe('530.1 GB');
    expect(formatSize(2_500_000_000_000)).toBe('2.5 TB');
  });

  it('should carry a size that rounds up to a thousand into the next unit', () => {
    // 999,960 bytes is 999.96 kB, which one decimal would write as 1000.0 kB
    expect(formatSize(999_960)).toBe('1.0 MB');
    expect(formatSize(999_949)).toBe('999.9 kB');
  });
});

describe('categoryOf()', () => {
  it('should read a kind off the extension, case set aside', () => {
    expect(categoryOf('main.ts')).toBe('code');
    expect(categoryOf('README.MD')).toBe('text');
    expect(categoryOf('photo.JPG')).toBe('image');
    expect(categoryOf('talk.mp4')).toBe('media');
    expect(categoryOf('backup.tar.gz')).toBe('archive');
    expect(categoryOf('libfoo.so')).toBe('binary');
  });

  it('should call a name with no extension, or a dot file, other', () => {
    expect(categoryOf('Makefile')).toBe('other');
    expect(categoryOf('.env')).toBe('other');
    expect(categoryOf('data.unknownext')).toBe('other');
  });
});

describe('isInside()', () => {
  it('should hold a path inside itself and under it, and nothing beside it', () => {
    const base = join(sep, 'work');
    expect(isInside(base, base)).toBe(true);
    expect(isInside(join(base, 'a', 'b'), base)).toBe(true);
    // a sibling whose name starts with the directory's is not under it
    expect(isInside(join(sep, 'workshop'), base)).toBe(false);
    expect(isInside(sep, base)).toBe(false);
  });
});

describe('printable()', () => {
  it('should draw each control character as a replacement, one for one', () => {
    expect(printable('bad\u001b[31mname')).toBe('bad�[31mname');
    expect(printable('tab\there')).toBe('tab�here');
    expect(printable('plain')).toBe('plain');
  });
});

describe('scanDisk()', () => {
  it('should total every directory and sort its contents largest first', async () => {
    const root = tempDir();
    write(root, {
      big: { 'a.bin': 3000, 'b.txt': 500 },
      empty: {},
      'small.md': 100,
      zero: 0,
    });
    const { root: tree } = await scanDisk(createDisk(root));
    expect(tree.bytes).toBe(3600);
    expect(tree.files).toBe(4);
    expect(tree.children?.map((child) => child.name)).toStrictEqual([
      'big',
      'small.md',
      // nothing in it and nothing in the file: by files, then by name
      'zero',
      'empty',
    ]);
    const big = findNode(tree, join(root, 'big'));
    expect(big?.bytes).toBe(3500);
    expect(big?.children?.map((child) => [child.name, child.bytes])).toStrictEqual([
      ['a.bin', 3000],
      ['b.txt', 500],
    ]);
    // a directory is coloured by what most of its bytes are
    expect(big?.category).toBe('binary');
  });

  it.skipIf(!canLink)('should list a link and never follow it', async () => {
    const root = tempDir();
    write(root, { real: { 'data.bin': 5000 } });
    // a link to the directory, and one to the root itself, which a scan that
    // followed links would walk forever
    symlinkSync(join(root, 'real'), join(root, 'again'));
    symlinkSync(root, join(root, 'loop'));
    const { root: tree } = await scanDisk(createDisk(root));
    expect(tree.bytes).toBe(5000);
    const again = findNode(tree, join(root, 'again'));
    expect(again?.kind).toBe('link');
    expect(again?.bytes).toBe(0);
    expect(again?.children).toBeUndefined();
  });

  it('should count a file with two names once, at the first in byte order', async () => {
    const root = tempDir();
    write(root, { b: { 'data.bin': 4000 }, a: {} });
    linkSync(join(root, 'b', 'data.bin'), join(root, 'a', 'copy.bin'));
    const real = createDisk(root);
    for (const order of ['as listed', 'reversed']) {
      // which name a walk reaches first is the listing's order and the race
      // between reads; which one counts must be neither
      const disk: Disk = {
        ...real,
        list: async (dir) =>
          order === 'reversed' ? (await real.list(dir)).toSorted().reverse() : real.list(dir),
      };
      const { links, root: tree } = await scanDisk(disk, { parallel: 1 });
      expect(tree.bytes, order).toBe(4000);
      expect(findNode(tree, join(root, 'a', 'copy.bin'))?.bytes, order).toBe(4000);
      expect(findNode(tree, join(root, 'b', 'data.bin'))?.bytes, order).toBe(0);
      expect([...links.values()], order).toStrictEqual([
        [join(root, 'a', 'copy.bin'), join(root, 'b', 'data.bin')],
      ]);
    }
  });

  it('should list a directory on another device and not enter it', async () => {
    const root = tempDir();
    write(root, { here: { 'a.bin': 100 }, mounted: { 'huge.bin': 9000 } });
    const real = createDisk(root);
    // a mount point cannot be made in a test, so the disk says it is one
    const disk: Disk = {
      ...real,
      async stat(path) {
        const info = await real.stat(path);
        return path.startsWith(join(root, 'mounted')) ? { ...info, dev: 'elsewhere' } : info;
      },
    };
    const { root: tree } = await scanDisk(disk);
    expect(tree.bytes).toBe(100);
    const mounted = findNode(tree, join(root, 'mounted'));
    expect(mounted?.children).toStrictEqual([]);
    expect(mounted?.note).toMatch(/another file system/);
  });

  it('should keep a directory that could not be read, and say why', async () => {
    const root = tempDir();
    write(root, { locked: { 'a.bin': 100 }, open: { 'b.bin': 200 } });
    const real = createDisk(root);
    const disk: Disk = {
      ...real,
      async list(dir) {
        if (dir === join(root, 'locked')) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return real.list(dir);
      },
    };
    const progress = startProgress();
    const found = await scanDisk(disk, { progress });
    expect(found.root.bytes).toBe(200);
    expect(found.errors).toBe(1);
    expect(findNode(found.root, join(root, 'locked'))?.note).toBe('Could not be read: EACCES');
  });

  it('should keep a file whose read failed for any reason but its going', async () => {
    const root = tempDir();
    write(root, { 'locked.bin': 10, 'open.bin': 20 });
    const real = createDisk(root);
    const disk: Disk = {
      ...real,
      async stat(path) {
        if (path === join(root, 'locked.bin')) {
          throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        return real.stat(path);
      },
    };
    const found = await scanDisk(disk);
    expect(found.errors).toBe(1);
    expect(findNode(found.root, join(root, 'locked.bin'))?.note).toBe('Could not be read: EACCES');
  });

  it('should make no read it had queued once it was told to stop', async () => {
    const root = tempDir();
    write(root, { a: 1, b: 2, c: 3 });
    const real = createDisk(root);
    const controller = new AbortController();
    let stats = 0;
    const disk: Disk = {
      ...real,
      async list(dir) {
        const names = await real.list(dir);
        // the listing lands after the scan was thrown away
        controller.abort();
        return names;
      },
      async stat(path) {
        if (path !== root) {
          stats++;
        }
        return real.stat(path);
      },
    };
    await expect(scanDisk(disk, { parallel: 1, signal: controller.signal })).rejects.toThrow();
    expect(stats).toBe(0);
  });

  it('should have no more reads in flight than it was told', async () => {
    const root = tempDir();
    write(root, {
      a: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}.bin`, i])),
      b: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`${i}.bin`, i])),
    });
    const real = createDisk(root);
    let now = 0;
    let most = 0;
    const counted =
      <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
      async (...args: A): Promise<R> => {
        most = Math.max(most, ++now);
        try {
          await new Promise((resolve) => setTimeout(resolve, 1));
          return await fn(...args);
        } finally {
          now--;
        }
      };
    const disk: Disk = { ...real, list: counted(real.list), stat: counted(real.stat) };
    const found = await scanDisk(disk, { parallel: 3 });
    expect(found.root.files).toBe(40);
    expect(most).toBe(3);
  });

  it('should leave out a name that went between the listing and its read', async () => {
    const root = tempDir();
    write(root, { 'kept.bin': 10, 'gone.bin': 20 });
    const real = createDisk(root);
    const disk: Disk = {
      ...real,
      async stat(path) {
        if (path === join(root, 'gone.bin')) {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        }
        return real.stat(path);
      },
    };
    const found = await scanDisk(disk);
    expect(found.root.children?.map((child) => child.name)).toStrictEqual(['kept.bin']);
    expect(found.errors).toBe(0);
  });

  it('should write its progress as it goes, and stop when told', async () => {
    const root = tempDir();
    write(root, { a: { 'x.bin': 10 }, b: { 'y.bin': 20 } });
    const progress = startProgress();
    const done = await scanDisk(createDisk(root), { progress });
    expect(progress).toMatchObject({ bytes: 30, dirs: 3, files: 2 });
    expect(done.root.bytes).toBe(30);

    const controller = new AbortController();
    const real = createDisk(root);
    const disk: Disk = {
      ...real,
      async list(dir) {
        controller.abort();
        return real.list(dir);
      },
    };
    await expect(scanDisk(disk, { signal: controller.signal })).rejects.toThrow();
  });
});

describe('removePath()', () => {
  it('should take a node out and make every directory above it smaller', async () => {
    const root = tempDir();
    write(root, { a: { b: { 'big.bin': 5000, 'small.bin': 10 } }, 'c.bin': 3000 });
    const before = await scanDisk(createDisk(root));
    const after = removePath(before, join(root, 'a', 'b', 'big.bin'));
    expect(after.root.bytes).toBe(3010);
    expect(findNode(after.root, join(root, 'a'))?.bytes).toBe(10);
    expect(findNode(after.root, join(root, 'a', 'b', 'big.bin'))).toBeUndefined();
    // the order moves with the sizes: `a` was the larger and is not any more
    expect(after.root.children?.map((child) => child.name)).toStrictEqual(['c.bin', 'a']);
    // and what the delete did not touch is the node it was
    expect(findNode(after.root, join(root, 'c.bin'))).toBe(
      findNode(before.root, join(root, 'c.bin'))
    );
    // the one before is as it was
    expect(before.root.bytes).toBe(8010);
  });

  it('should count a hard-linked file at its next name once the counted one goes', async () => {
    const root = tempDir();
    write(root, { a: {}, b: { 'data.bin': 4000 } });
    linkSync(join(root, 'b', 'data.bin'), join(root, 'a', 'copy.bin'));
    const before = await scanDisk(createDisk(root));
    expect(findNode(before.root, join(root, 'a', 'copy.bin'))?.bytes).toBe(4000);

    // deleting one name of a file frees nothing while another is left, so the
    // total stays and the bytes move to `b`
    const after = removePath(before, join(root, 'a'));
    expect(after.root.bytes).toBe(4000);
    expect(findNode(after.root, join(root, 'b', 'data.bin'))?.bytes).toBe(4000);
    expect([...after.links.values()]).toStrictEqual([[join(root, 'b', 'data.bin')]]);

    // and once the last name goes, the bytes do too
    expect(removePath(after, join(root, 'b', 'data.bin')).root.bytes).toBe(0);
  });

  it('should leave the bytes where they are when a name that did not count goes', async () => {
    const root = tempDir();
    write(root, { a: {}, b: { 'data.bin': 4000 } });
    linkSync(join(root, 'b', 'data.bin'), join(root, 'a', 'copy.bin'));
    const before = await scanDisk(createDisk(root));
    const after = removePath(before, join(root, 'b', 'data.bin'));
    expect(after.root.bytes).toBe(4000);
    expect(findNode(after.root, join(root, 'a', 'copy.bin'))?.bytes).toBe(4000);
    expect([...after.links.values()]).toStrictEqual([[join(root, 'a', 'copy.bin')]]);
  });

  it('should leave the root, and a path not in the tree, alone', async () => {
    const root = tempDir();
    write(root, { 'a.bin': 10 });
    const scan = await scanDisk(createDisk(root));
    expect(removePath(scan, root)).toBe(scan);
    expect(removePath(scan, join(root, 'missing'))).toBe(scan);
    expect(removePath(scan, join(tempDir(), 'a.bin'))).toBe(scan);
  });
});

describe('shownPath()', () => {
  it('should show a path under the root with the root its first name', async () => {
    const root = tempDir();
    mkdirSync(join(root, 'work', 'src'), { recursive: true });
    const scan = await scanDisk(createDisk(join(root, 'work')));
    expect(shownPath(scan.root, join(root, 'work'))).toBe('work');
    expect(shownPath(scan.root, join(root, 'work', 'src'))).toBe(join('work', 'src'));
  });
});
