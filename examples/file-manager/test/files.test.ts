import {
  copyName,
  createFiles,
  type Entry,
  formatSize,
  isInside,
  nameProblem,
  planPaste,
  planRename,
  sortEntries,
  visibleEntries,
} from '../src/files.ts';
import { ignoresCase, removeTempDirs, tempDir, write } from './fixture.ts';
import { existsSync, linkSync, readdirSync, readFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The rules the manager asks before it changes anything, and the calls it makes
 * to change it -- every one of them inside a directory of the test's own.
 */

afterAll(removeTempDirs);

/** An entry, for the rules that read nothing but the name and the kind. */
const entry = (name: string, kind: Entry['kind'] = 'file'): Entry => ({
  kind,
  link: false,
  name,
  path: name,
  size: 0,
});

describe('a listing', () => {
  it('should put directories first, then names with numbers read as numbers', () => {
    const sorted = sortEntries([
      entry('b10.txt'),
      entry('B2.txt'),
      entry('zeta', 'directory'),
      entry('a.txt'),
      entry('alpha', 'directory'),
    ]);
    expect(sorted.map((it) => it.name)).toStrictEqual([
      'alpha',
      'zeta',
      'a.txt',
      'B2.txt',
      'b10.txt',
    ]);
  });

  it('should break a tie between names that differ only in case, so the order is total', () => {
    const a = sortEntries([entry('readme'), entry('README')]).map((it) => it.name);
    const b = sortEntries([entry('README'), entry('readme')]).map((it) => it.name);
    expect(a).toStrictEqual(b);
  });

  it('should leave out dot files unless they are asked for', () => {
    const all = [entry('.env'), entry('a.txt'), entry('.git', 'directory')];
    expect(visibleEntries(all, { filter: '', hidden: false }).map((it) => it.name)).toStrictEqual([
      'a.txt',
    ]);
    expect(visibleEntries(all, { filter: '', hidden: true })).toHaveLength(3);
  });

  it('should filter ignoring case until the filter has a capital in it', () => {
    const all = [entry('Readme.md'), entry('readme.txt'), entry('main.ts')];
    expect(visibleEntries(all, { filter: 'read', hidden: false })).toHaveLength(2);
    expect(
      visibleEntries(all, { filter: 'Read', hidden: false }).map((it) => it.name)
    ).toStrictEqual(['Readme.md']);
  });
});

describe('a name', () => {
  it('should refuse an empty name, . and .., a separator and a NUL', () => {
    expect(nameProblem('')).toMatch(/empty/);
    expect(nameProblem('.')).toBeDefined();
    expect(nameProblem('..')).toBeDefined();
    expect(nameProblem('a/b')).toMatch(/separator/);
    expect(nameProblem('a\0b')).toMatch(/NUL/);
    expect(nameProblem('notes v2.txt')).toBeUndefined();
  });

  it('should refuse a backslash on Windows, where it separates, and nowhere else', () => {
    expect(nameProblem('a\\b', 'win32')).toMatch(/separator/);
    expect(nameProblem('a\\b', 'linux')).toBeUndefined();
  });

  it('should name a copy after its original, keeping the extension, Finder-style', () => {
    expect(copyName('a.txt', 1)).toBe('a copy.txt');
    expect(copyName('a.txt', 2)).toBe('a copy 2.txt');
    expect(copyName('Makefile', 1)).toBe('Makefile copy');
    // a dot file's dot is its name, not an extension
    expect(copyName('.env', 1)).toBe('.env copy');
  });

  it('should size a file the way ls -h does', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1023)).toBe('1023 B');
    expect(formatSize(1024)).toBe('1 KB');
    expect(formatSize(4300)).toBe('4.2 KB');
    expect(formatSize(38 * 1024)).toBe('38 KB');
    expect(formatSize(1.1 * 1024 * 1024)).toBe('1.1 MB');
  });
});

describe('inside', () => {
  it('should say a directory is inside itself and its descendants are inside it', () => {
    const root = tempDir();
    expect(isInside(root, root)).toBe(true);
    expect(isInside(join(root, 'a', 'b'), root)).toBe(true);
    expect(isInside(root, join(root, 'a'))).toBe(false);
    // a sibling whose name starts with the directory's is not inside it
    expect(isInside(`${root}-other`, root)).toBe(false);
    expect(isInside(join(root, '..a'), root)).toBe(true);
  });
});

describe('pasting', () => {
  const files = createFiles();

  it('should copy beside the original under the next free copy name', async () => {
    const root = tempDir();
    write(root, { 'a.txt': 'alpha', 'a copy.txt': 'taken' });
    const from = { kind: 'file' as const, link: false, path: join(root, 'a.txt') };
    const plan = await planPaste(files, 'copy', from, root);
    expect(plan).toStrictEqual({ ok: true, to: join(root, 'a copy 2.txt') });
  });

  it('should refuse to copy or move a directory into itself or under itself', async () => {
    const root = tempDir();
    write(root, { tree: { inner: { 'x.txt': 'x' } } });
    const from = { kind: 'directory' as const, link: false, path: join(root, 'tree') };
    for (const mode of ['copy', 'move'] as const) {
      expect(await planPaste(files, mode, from, join(root, 'tree'))).toMatchObject({ ok: false });
      expect(await planPaste(files, mode, from, join(root, 'tree', 'inner'))).toMatchObject({
        ok: false,
        reason: `Cannot ${mode} tree into itself`,
      });
    }
  });

  it('should refuse to move onto a name that is taken, rather than write over it', async () => {
    const root = tempDir();
    write(root, { 'a.txt': 'mine', there: { 'a.txt': 'theirs' } });
    const from = { kind: 'file' as const, link: false, path: join(root, 'a.txt') };
    const plan = await planPaste(files, 'move', from, join(root, 'there'));
    expect(plan).toMatchObject({ ok: false, reason: expect.stringMatching(/already taken/) });
  });

  it('should have nothing to do moving a file into the directory it is in', async () => {
    const root = tempDir();
    write(root, { 'a.txt': 'a' });
    const from = { kind: 'file' as const, link: false, path: join(root, 'a.txt') };
    expect(await planPaste(files, 'move', from, root)).toMatchObject({
      ok: false,
      reason: 'a.txt is already here',
    });
  });

  it('should refuse what is not there any more', async () => {
    const root = tempDir();
    const from = { kind: 'file' as const, link: false, path: join(root, 'gone.txt') };
    expect(await planPaste(files, 'copy', from, root)).toMatchObject({ ok: false });
  });

  it('should copy a directory whole, and refuse to copy over one that appeared', async () => {
    const root = tempDir();
    write(root, { tree: { 'x.txt': 'x', inner: { 'y.txt': 'y' } } });
    await files.copy(join(root, 'tree'), join(root, 'copy'));
    expect(readFileSync(join(root, 'copy', 'inner', 'y.txt'), 'utf8')).toBe('y');
    await expect(
      files.copy(join(root, 'tree', 'x.txt'), join(root, 'copy', 'x.txt'))
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'should copy a link as the link, never as what it points at',
    async () => {
      // a link to a directory copied as what it points at is a link to `/`
      // copying the disk. Skipped on Windows, where making a link needs a
      // privilege a CI runner may not have
      const root = tempDir();
      write(root, { target: { 'x.txt': 'x' } });
      symlinkSync(join(root, 'target'), join(root, 'link'));
      await files.copy(join(root, 'link'), join(root, 'copied'));
      const listed = await files.list(root);
      expect(listed.find((it) => it.name === 'copied')).toMatchObject({
        kind: 'directory',
        link: true,
      });
    }
  );
});

describe('renaming', () => {
  const files = createFiles();

  it('should refuse a name another file has', async () => {
    const root = tempDir();
    write(root, { 'a.txt': 'a', 'b.txt': 'b' });
    expect(await planRename(files, join(root, 'a.txt'), 'b.txt')).toMatchObject({
      ok: false,
      reason: 'b.txt is already taken',
    });
    expect(readFileSync(join(root, 'b.txt'), 'utf8')).toBe('b');
  });

  it('should rename to the same name in another case, on any file system', async () => {
    // on one that ignores case `A.txt` is taken -- by `a.txt` itself -- which is
    // still a rename; on one that does not, it is free. Either way it happens
    const root = tempDir();
    write(root, { 'a.txt': 'a' });
    const plan = await planRename(files, join(root, 'a.txt'), 'A.txt');
    expect(plan).toStrictEqual({ ok: true, to: join(root, 'A.txt') });
    await files.move(join(root, 'a.txt'), join(root, 'A.txt'));
    expect(readdirSync(root)).toStrictEqual(['A.txt']);
  });

  it('should refuse to rename one hard link onto another, which would do nothing', async () => {
    // both names are one file, so `rename()` succeeds and leaves both
    const root = tempDir();
    write(root, { 'a.txt': 'a' });
    linkSync(join(root, 'a.txt'), join(root, 'b.txt'));
    expect(await planRename(files, join(root, 'a.txt'), 'b.txt')).toMatchObject({
      ok: false,
      reason: 'b.txt is already taken',
    });
  });

  it.skipIf(ignoresCase())(
    'should refuse a name in another case that the directory already lists',
    async () => {
      // only where case is kept can both spellings be listed: as two files, and
      // as two names of one hard link, which a rename would leave both of
      const root = tempDir();
      write(root, { 'a.txt': 'a', 'b.txt': 'b', 'B.txt': 'other' });
      linkSync(join(root, 'a.txt'), join(root, 'A.txt'));
      for (const [from, to] of [
        ['a.txt', 'A.txt'],
        ['b.txt', 'B.txt'],
      ] as const) {
        expect(await planRename(files, join(root, from), to)).toMatchObject({ ok: false });
      }
      expect(readdirSync(root).sort()).toStrictEqual(['A.txt', 'B.txt', 'a.txt', 'b.txt']);
    }
  );

  it('should refuse a separator, so a rename never moves a file', async () => {
    const root = tempDir();
    write(root, { 'a.txt': 'a', sub: {} });
    expect(await planRename(files, join(root, 'a.txt'), 'sub/a.txt')).toMatchObject({
      ok: false,
    });
    expect(existsSync(join(root, 'a.txt'))).toBe(true);
  });
});
