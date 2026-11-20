import { deletionDate, encodePath, trashFreedesktop, trashName } from '../src/trash/freedesktop.js';
import { trash } from '../src/trash/index.js';
import { keyOf, recycle } from '../src/trash/windows.js';
import { tempDir } from './temp.js';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, rm } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * `trash()`, over directories the tests make.
 *
 * Nothing here moves anything it did not make inside a `tempDir()`. The
 * freedesktop half is pointed at a trash inside that directory too, so on every
 * platform it is run on, the trash it fills is removed with the rest. The real
 * platform's trash is used once per platform below, and each of those tests takes
 * back out exactly the path `trash()` said it put there -- so the suite leaves
 * nothing in the trash of a CI runner or of the machine somebody runs it on.
 */

const WINDOWS = process.platform === 'win32';
// the freedesktop trash writes Unix ids and modes, and Windows has neither
const FREEDESKTOP = !WINDOWS;

/** A directory of its own, links resolved, since macOS's temp directory is behind `/var`. */
function made(prefix: string): string {
  return realpathSync(tempDir(prefix));
}

/** A `.trashinfo`, as the lines it holds. */
function infoOf(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

describe.runIf(FREEDESKTOP)('the freedesktop trash', () => {
  // a skipped describe still runs its body to collect what it skips, and Windows
  // has no `getuid`
  const uid = process.getuid?.() ?? 0;
  const now = new Date(2024, 5, 15, 9, 5, 7);

  it('should move a file into the home trash and say where it came from', async () => {
    const root = made('sigil-trash-home-');
    const dataHome = join(root, 'data');
    const file = join(root, 'a.txt');
    writeFileSync(file, 'one');

    const { info, path } = await trashFreedesktop(file, { dataHome, now });

    expect(path).toBe(join(dataHome, 'Trash', 'files', 'a.txt'));
    expect(info).toBe(join(dataHome, 'Trash', 'info', 'a.txt.trashinfo'));
    expect(existsSync(file)).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe('one');
    expect(infoOf(info)).toEqual([
      '[Trash Info]',
      `Path=${encodePath(file)}`,
      'DeletionDate=2024-06-15T09:05:07',
      '',
    ]);
  });

  it('should make the home trash private', async () => {
    const root = made('sigil-trash-mode-');
    const dataHome = join(root, 'data');
    writeFileSync(join(root, 'a'), '');

    await trashFreedesktop(join(root, 'a'), { dataHome });

    for (const dir of ['files', 'info']) {
      expect(statSync(join(dataHome, 'Trash', dir)).mode & 0o077).toBe(0);
    }
  });

  it('should give a second item of one name the next free name', async () => {
    const root = made('sigil-trash-names-');
    const dataHome = join(root, 'data');
    const files = join(dataHome, 'Trash', 'files');
    const paths: string[] = [];
    for (const content of ['one', 'two', 'three']) {
      writeFileSync(join(root, 'a.txt'), content);
      paths.push((await trashFreedesktop(join(root, 'a.txt'), { dataHome })).path);
    }

    expect(paths).toEqual([join(files, 'a.txt'), join(files, 'a.2.txt'), join(files, 'a.3.txt')]);
    expect(paths.map((path) => readFileSync(path, 'utf8'))).toEqual(['one', 'two', 'three']);
    expect(existsSync(join(dataHome, 'Trash', 'info', 'a.3.txt.trashinfo'))).toBe(true);
  });

  it('should skip a name taken in files/ that has no .trashinfo', async () => {
    const root = made('sigil-trash-stray-');
    const dataHome = join(root, 'data');
    const files = join(dataHome, 'Trash', 'files');
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'a.txt'), 'left behind');
    writeFileSync(join(root, 'a.txt'), 'mine');

    const { path } = await trashFreedesktop(join(root, 'a.txt'), { dataHome });

    expect(path).toBe(join(files, 'a.2.txt'));
    expect(readFileSync(join(files, 'a.txt'), 'utf8')).toBe('left behind');
    // the name it reserved and gave up is given up in info/ too
    expect(existsSync(join(dataHome, 'Trash', 'info', 'a.txt.trashinfo'))).toBe(false);
  });

  it('should move a directory whole, and a link as a link', async () => {
    const root = made('sigil-trash-kinds-');
    const dataHome = join(root, 'data');
    mkdirSync(join(root, 'dir', 'deep'), { recursive: true });
    writeFileSync(join(root, 'dir', 'deep', 'x'), 'x');
    writeFileSync(join(root, 'target'), 'kept');
    symlinkSync(join(root, 'target'), join(root, 'link'));

    const dir = await trashFreedesktop(join(root, 'dir'), { dataHome });
    const link = await trashFreedesktop(join(root, 'link'), { dataHome });

    expect(readFileSync(join(dir.path, 'deep', 'x'), 'utf8')).toBe('x');
    expect(lstatSync(link.path).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link.path)).toBe(join(root, 'target'));
    expect(readFileSync(join(root, 'target'), 'utf8')).toBe('kept');
  });

  it('should escape a path as a URL, so a newline or a % cannot be misread', async () => {
    const root = made('sigil-trash-escape-');
    const dataHome = join(root, 'data');
    const name = 'a b%\n"ü\'.txt';
    writeFileSync(join(root, name), '');

    const { info } = await trashFreedesktop(join(root, name), { dataHome });

    const path = infoOf(info)[1];
    expect(path.endsWith("/a%20b%25%0A%22%C3%BC'.txt")).toBe(true);
    expect(decodeURIComponent(path.slice('Path='.length))).toBe(join(root, name));
  });

  it('should record the real path when the item is reached through a link', async () => {
    const root = made('sigil-trash-via-');
    const dataHome = join(root, 'data');
    mkdirSync(join(root, 'real'));
    symlinkSync(join(root, 'real'), join(root, 'via'));
    writeFileSync(join(root, 'real', 'a'), '');

    const { info } = await trashFreedesktop(join(root, 'via', 'a'), { dataHome });

    expect(infoOf(info)[1]).toBe(`Path=${encodePath(join(root, 'real', 'a'))}`);
  });

  it('should leave the item and remove its .trashinfo when the move fails', async () => {
    const root = made('sigil-trash-fails-');
    // a trash inside the directory being trashed: a directory cannot be moved
    // into itself, so the `rename()` fails after the info file is written
    const dataHome = join(root, 'dir', 'data');
    mkdirSync(dataHome, { recursive: true });

    await expect(trashFreedesktop(join(root, 'dir'), { dataHome })).rejects.toThrow();

    expect(existsSync(join(root, 'dir'))).toBe(true);
    expect(existsSync(join(dataHome, 'Trash', 'info', 'dir.trashinfo'))).toBe(false);
  });

  it('should refuse a trash whose files/ is a link, and leave the item', async () => {
    const root = made('sigil-trash-linked-');
    const dataHome = join(root, 'data');
    mkdirSync(join(dataHome, 'Trash', 'info'), { recursive: true });
    mkdirSync(join(root, 'elsewhere'));
    // `mkdir()` and `rename()` follow a link mid-path, so this would take the
    // item to `elsewhere` and call it trashed
    symlinkSync(join(root, 'elsewhere'), join(dataHome, 'Trash', 'files'));
    writeFileSync(join(root, 'a'), 'kept');

    await expect(trashFreedesktop(join(root, 'a'), { dataHome })).rejects.toThrow(/a link/);

    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('kept');
    expect(existsSync(join(root, 'elsewhere', 'a'))).toBe(false);
  });

  it('should refuse a trash that is itself a link', async () => {
    const root = made('sigil-trash-linked-home-');
    const dataHome = join(root, 'data');
    mkdirSync(dataHome);
    mkdirSync(join(root, 'elsewhere'));
    symlinkSync(join(root, 'elsewhere'), join(dataHome, 'Trash'));
    writeFileSync(join(root, 'a'), 'kept');

    await expect(trashFreedesktop(join(root, 'a'), { dataHome })).rejects.toThrow(/a link/);

    expect(readFileSync(join(root, 'a'), 'utf8')).toBe('kept');
    expect(existsSync(join(root, 'elsewhere', 'files', 'a'))).toBe(false);
  });

  it('should throw for a path that is not there, and make no trash for it', async () => {
    const root = made('sigil-trash-missing-');
    const dataHome = join(root, 'data');

    await expect(trashFreedesktop(join(root, 'nope'), { dataHome })).rejects.toThrow(/ENOENT/);
    expect(existsSync(dataHome)).toBe(false);
  });

  describe('on another device', () => {
    /**
     * A test cannot mount anything, so `mount` is made another device by the
     * device function the trash is handed: it and everything under it answer
     * `other`. The home trash is beside it, on the real device, so an item in
     * `mount` has to go to the trash at the top of `mount`.
     */
    function fixture(prefix: string) {
      const root = made(prefix);
      const mount = join(root, 'mount');
      mkdirSync(join(mount, 'sub'), { recursive: true });
      const real = String(lstatSync(root).dev);
      const device = async (path: string): Promise<string> => {
        await lstat(path);
        return path === mount || path.startsWith(mount + sep) ? 'other' : real;
      };
      return { dataHome: join(root, 'data'), device, mount, root };
    }

    it('should use .Trash-$uid at the top of the mount, made private, with a relative path', async () => {
      const { dataHome, device, mount } = fixture('sigil-trash-mount-');
      writeFileSync(join(mount, 'sub', 'a.txt'), 'a');

      const { info, path } = await trashFreedesktop(join(mount, 'sub', 'a.txt'), {
        dataHome,
        device,
        now,
        uid,
      });

      const trashDir = join(mount, `.Trash-${uid}`);
      expect(path).toBe(join(trashDir, 'files', 'a.txt'));
      expect(statSync(trashDir).mode & 0o077).toBe(0);
      expect(infoOf(info)[1]).toBe('Path=sub/a.txt');
      expect(existsSync(join(dataHome, 'Trash'))).toBe(false);
    });

    it('should use .Trash/$uid where the administrator made a sticky .Trash', async () => {
      const { dataHome, device, mount } = fixture('sigil-trash-sticky-');
      mkdirSync(join(mount, '.Trash'));
      chmodSync(join(mount, '.Trash'), 0o1777);
      writeFileSync(join(mount, 'a'), '');

      const { path } = await trashFreedesktop(join(mount, 'a'), { dataHome, device, uid });

      expect(path).toBe(join(mount, '.Trash', String(uid), 'files', 'a'));
      expect(existsSync(join(mount, `.Trash-${uid}`))).toBe(false);
    });

    it('should not use a .Trash without the sticky bit, or one that is a link', async () => {
      const { dataHome, device, mount, root } = fixture('sigil-trash-unsafe-');
      mkdirSync(join(mount, '.Trash'));
      chmodSync(join(mount, '.Trash'), 0o777);
      writeFileSync(join(mount, 'a'), '');

      const first = await trashFreedesktop(join(mount, 'a'), { dataHome, device, uid });

      expect(first.path).toBe(join(mount, `.Trash-${uid}`, 'files', 'a'));
      expect(existsSync(join(mount, '.Trash', String(uid)))).toBe(false);

      // a link to a sticky directory somewhere else is somebody else's trash
      mkdirSync(join(root, 'elsewhere'));
      chmodSync(join(root, 'elsewhere'), 0o1777);
      await rm(join(mount, '.Trash'), { recursive: true });
      symlinkSync(join(root, 'elsewhere'), join(mount, '.Trash'));
      writeFileSync(join(mount, 'b'), '');

      const second = await trashFreedesktop(join(mount, 'b'), { dataHome, device, uid });

      expect(second.path).toBe(join(mount, `.Trash-${uid}`, 'files', 'b'));
      expect(existsSync(join(root, 'elsewhere', String(uid)))).toBe(false);
    });

    /**
     * A `.Trash` somebody else made, by asking as a uid one past the real one: it
     * and everything this makes is then "somebody else's", so the user-owned
     * trashes are refused too and the call throws either way. What differs is
     * whether `.Trash/$uid` was tried, which is the decision being pinned.
     */
    it("should use another user's .Trash only where the top is not writable by all", async () => {
      const other = uid + 1;
      const tried = async (topMode: number): Promise<boolean> => {
        const { dataHome, device, mount } = fixture('sigil-trash-owner-');
        mkdirSync(join(mount, '.Trash'));
        chmodSync(join(mount, '.Trash'), 0o1777);
        writeFileSync(join(mount, 'a'), '');
        chmodSync(mount, topMode);
        try {
          await expect(
            trashFreedesktop(join(mount, 'a'), { dataHome, device, uid: other })
          ).rejects.toThrow(/cannot be used/);
          return existsSync(join(mount, '.Trash', String(other)));
        } finally {
          chmodSync(mount, 0o755);
        }
      };

      // anyone could have made it, and anyone who did could empty it
      expect(await tried(0o777)).toBe(false);
      // root squashed to `nobody` over NFS reads like this, and is the spec's case
      expect(await tried(0o755)).toBe(true);
    });

    it('should throw and leave the item where there is no trash it can use', async () => {
      const { dataHome, device, mount } = fixture('sigil-trash-none-');
      // a file where the trash would be made, so it cannot be
      writeFileSync(join(mount, `.Trash-${uid}`), '');
      writeFileSync(join(mount, 'a'), 'still here');

      await expect(trashFreedesktop(join(mount, 'a'), { dataHome, device, uid })).rejects.toThrow(
        /cannot be used/
      );

      expect(readFileSync(join(mount, 'a'), 'utf8')).toBe('still here');
      expect(existsSync(join(dataHome, 'Trash'))).toBe(false);
    });

    it('should refuse the top of a mount', async () => {
      const { dataHome, device, mount } = fixture('sigil-trash-top-');

      await expect(trashFreedesktop(mount, { dataHome, device, uid })).rejects.toThrow(
        /top of a mount/
      );
      expect(existsSync(mount)).toBe(true);
    });
  });
});

describe('the trash a name takes', () => {
  it('should number before the extension, and after a dot file', () => {
    expect(trashName('a.txt', 1)).toBe('a.txt');
    expect(trashName('a.txt', 2)).toBe('a.2.txt');
    expect(trashName('a.tar.gz', 3)).toBe('a.tar.3.gz');
    expect(trashName('.bashrc', 2)).toBe('.bashrc.2');
    expect(trashName('Makefile', 2)).toBe('Makefile.2');
  });

  it('should write a deletion date in local time with no zone', () => {
    expect(deletionDate(new Date(2004, 7, 31, 22, 32, 8))).toBe('2004-08-31T22:32:08');
    expect(deletionDate(new Date(2024, 0, 2, 3, 4, 5))).toBe('2024-01-02T03:04:05');
  });
});

describe('trash()', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

  afterEach(() => {
    Object.defineProperty(process, 'platform', platform);
    vi.unstubAllEnvs();
  });

  it('should refuse an empty path rather than move the working directory', async () => {
    await expect(trash('')).rejects.toThrow(TypeError);
  });

  it('should say which path it could not move, and why', async () => {
    const root = made('sigil-trash-gone-');

    const err = await trash(join(root, 'nope')).catch((e: Error) => e);

    // a string to `toContain()`, not to `toMatch()`, which would read a Windows
    // path's backslashes as escapes
    expect((err as Error).message).toContain(
      `Could not move ${join(root, 'nope')} to the trash: ENOENT`
    );
    // the `cause` is the reason alone, for a screen that already shows the name:
    // node's own message ends with the path
    expect(((err as Error).cause as Error).message).toBe('ENOENT: no such file or directory');
    expect((((err as Error).cause as Error).cause as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it.runIf(FREEDESKTOP)('should use the freedesktop trash on Linux, at XDG_DATA_HOME', async () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
    const root = made('sigil-trash-linux-');
    vi.stubEnv('XDG_DATA_HOME', join(root, 'data'));
    writeFileSync(join(root, 'a.txt'), 'a');

    const path = await trash(join(root, 'a.txt'));

    expect(path).toBe(join(root, 'data', 'Trash', 'files', 'a.txt'));
    expect(readFileSync(path, 'utf8')).toBe('a');
    expect(existsSync(join(root, 'a.txt'))).toBe(false);
  });

  /**
   * The platform's own trash, which is the user's on a developer's machine. Each
   * test takes out exactly what `trash()` said it put in, in a `finally`, so a
   * failed assertion does not leave it there either.
   */
  describe.runIf(process.platform === 'darwin' || WINDOWS)("the platform's own trash", () => {
    /**
     * Each call on Windows starts PowerShell, and one that misses the cache
     * compiles the C# as well -- under the suite's own load, two calls passed 10 s
     * on node 24 and timed out on node 22 when every call compiled, and the cached
     * cases below make several calls each.
     */
    const SLOW = 60_000;

    /** Takes an item back out of the trash, with whatever the platform keeps beside it. */
    async function takeOut(where: string): Promise<void> {
      if (!where) {
        return;
      }
      await rm(where, { force: true, recursive: true });
      if (WINDOWS) {
        // `$R…` is the item and `$I…` says where it came from
        const name = basename(where);
        await rm(join(dirname(where), `$I${name.slice(2)}`), { force: true });
      }
    }

    it(
      'should move a file, and a name with spaces, quotes and more than ASCII',
      async () => {
        const root = made('sigil-trash-real-');
        const names = ['plain.txt', `it's a "test" ü 日本.txt`];
        for (const name of names) {
          // a name with `"` is not a name Windows allows
          const file = join(root, WINDOWS ? name.replaceAll('"', '') : name);
          writeFileSync(file, name);
          let where = '';
          try {
            where = await trash(file);
            expect(where).not.toBe('');
            expect(existsSync(file)).toBe(false);
            expect(readFileSync(where, 'utf8')).toBe(name);
            expect(where).toMatch(WINDOWS ? /\$Recycle\.Bin/i : /\.Trash/);
          } finally {
            await takeOut(where);
          }
          expect(existsSync(where)).toBe(false);
        }
      },
      SLOW
    );

    it(
      'should move a directory and everything in it',
      async () => {
        const root = made('sigil-trash-real-dir-');
        const dir = join(root, 'dir');
        mkdirSync(join(dir, 'deep'), { recursive: true });
        writeFileSync(join(dir, 'deep', 'x'), 'x');
        let where = '';
        try {
          where = await trash(dir);
          expect(existsSync(dir)).toBe(false);
          expect(readFileSync(join(where, 'deep', 'x'), 'utf8')).toBe('x');
        } finally {
          await takeOut(where);
        }
      },
      SLOW
    );

    /**
     * The compiled helper, kept in a cache this test names rather than the
     * runner's own, so each case starts from a file it wrote. What each call did
     * with it is what `recycle()` reports; the item is trashed every time.
     */
    describe.runIf(WINDOWS)('the compiled helper, cached', () => {
      /** Trashes a fresh file through `recycle()` with this cache, and takes it back out. */
      async function once(file: string | undefined, hash = keyOf('sigil-trash-test')) {
        const item = join(made('sigil-trash-cached-'), 'a.txt');
        writeFileSync(item, 'a');
        let where = '';
        try {
          const out = await recycle(item, file, hash);
          where = out.path;
          expect(where).not.toBe('');
          expect(existsSync(item)).toBe(false);
          return out.cache;
        } finally {
          await takeOut(where);
        }
      }

      it(
        'should compile once, then load the sealed helper from the cache',
        async () => {
          const file = join(made('sigil-trash-cache-'), 'sigil', 'trash.bin');

          expect(await once(file)).toBe('saved');
          expect(existsSync(file)).toBe(true);
          expect(await once(file)).toBe('hit');
          expect(await once(file)).toBe('hit');
        },
        SLOW
      );

      it(
        'should rebuild rather than load a file that does not unseal',
        async () => {
          const file = join(made('sigil-trash-forged-'), 'trash.bin');
          expect(await once(file)).toBe('saved');
          const sealed = readFileSync(file);

          // anything another process could write there: bytes that are not a
          // seal at all, a seal cut short, and a real seal for another source
          writeFileSync(file, 'MZ not a seal');
          expect(await once(file)).toBe('saved');
          writeFileSync(file, sealed.subarray(0, sealed.length - 1));
          expect(await once(file)).toBe('saved');
          writeFileSync(file, sealed);
          expect(await once(file, keyOf('another source'))).toBe('saved');
          // and what was rebuilt is good for its own key
          expect(await once(file, keyOf('another source'))).toBe('hit');
        },
        SLOW
      );

      it(
        'should not run a planted assembly that was never sealed',
        async () => {
          const file = join(made('sigil-trash-planted-'), 'trash.bin');
          // a real assembly with the helper's own name and method, which answers
          // without moving anything: if it is ever loaded, the item stays put and
          // `once()` says so, rather than the test passing on bytes that
          // `Assembly.Load()` would have refused anyway
          execFileSync(
            `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              'Add-Type -TypeDefinition $env:PLANTED_SOURCE -OutputAssembly $env:PLANTED_FILE -OutputType Library',
            ],
            {
              env: {
                ...process.env,
                PLANTED_FILE: file,
                PLANTED_SOURCE:
                  'namespace SigilTrash { public static class Bin { public static string Recycle(string path) { return "{\\"path\\":\\"planted\\"}"; } } }',
              },
            }
          );
          expect(readFileSync(file).subarray(0, 2).toString()).toBe('MZ');

          expect(await once(file)).toBe('saved');
          expect(await once(file)).toBe('hit');
        },
        SLOW
      );

      it(
        'should have two calls racing on an empty cache both recycle, and leave one file',
        async () => {
          const file = join(made('sigil-trash-race-'), 'trash.bin');

          const states = await Promise.all([once(file), once(file)]);

          expect(states.every((state) => state === 'saved' || state === 'built')).toBe(true);
          expect(states).toContain('saved');
          expect(readdirSync(dirname(file))).toEqual([basename(file)]);
          expect(await once(file)).toBe('hit');
        },
        SLOW
      );

      it(
        'should still trash, compiling each time, where the cache cannot be written',
        async () => {
          const root = made('sigil-trash-unwritable-');
          // a file where the cache's directory would be made
          writeFileSync(join(root, 'taken'), '');
          const under = join(root, 'taken', 'trash.bin');
          // a directory where the cache file would be written
          const occupied = join(root, 'dir.bin');
          mkdirSync(occupied);

          expect(await once(under)).toBe('built');
          expect(await once(under)).toBe('built');
          expect(await once(occupied)).toBe('built');
          expect(statSync(occupied).isDirectory()).toBe(true);
          expect(await once(undefined)).toBe('built');
        },
        SLOW
      );
    });
  });
});
