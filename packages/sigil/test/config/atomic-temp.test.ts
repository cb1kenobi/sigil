/**
 * Where the temp file goes, and what happens to it when the write fails.
 *
 * `writeAtomic()` names its own temp file and renames it over the target, so
 * nothing outside can see it -- the file exists only between the open and the
 * rename, and both halves are synchronous enough that no caller can look. The
 * alternative to wrapping `fs` is a seam whose only reader would be this file,
 * which is the shape packages/cli/AGENTS.md argues against.
 *
 * So `node:fs` and `node:fs/promises` are wrapped the way `bundle-close.test.ts`
 * wraps `rolldown`: the real calls run, the real files are written, and the one
 * thing the wrapper adds is a record of which paths were opened, renamed and
 * unlinked, plus a way to make one of them fail. Nothing here is a fake
 * filesystem.
 *
 * A file of its own rather than a `describe` inside `write.test.ts`, because
 * `vi.mock` is hoisted and module-wide: every test in the file it sits in would
 * run through the wrapper, which is a thing nobody reading those tests would
 * expect.
 */

import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** One entry per call the write made, in order, as `verb path`. */
const calls: string[] = [];

/** Which call should fail next, so that the cleanup path is reachable. */
let fail: 'close' | 'fsync' | 'loop' | 'readlink' | 'rename' | 'stat' | undefined;

/**
 * What to put at a temp name just before it is opened, standing in for whoever
 * got there first: a symlink to a file somebody else owns, or a plain file.
 *
 * Planted through the wrapper rather than at a guessed name, because the name
 * is unpredictable now -- and a test that guessed the old `<pid>-0` spelling
 * would pass for any name at all the moment it changed, whether or not the open
 * had become exclusive. This way the open meets the planted file whatever it is
 * called.
 */
let plant: { kind: 'file' | 'link'; times: number; victim: string } | undefined;

/** Every name `plant` put something at, which the write must leave alone. */
const planted: string[] = [];

/** Puts what `plant` says at a path, once per remaining `times`. */
function plantAt(path: string, real: typeof import('node:fs')): void {
  if (plant === undefined || plant.times === 0) {
    return;
  }
  plant.times--;
  if (plant.kind === 'link') {
    real.symlinkSync(plant.victim, path);
  } else {
    real.writeFileSync(path, 'PLANTED');
  }
  planted.push(path);
}

/** The code `fsync()` fails with, because *which* codes are swallowed is the claim. */
let flushCode = 'EINVAL';

/**
 * The code `readlink()` fails with, for the reason `flushCode` exists.
 *
 * The walk that follows a dangling link can only meet one of these if the link
 * changed between `realpathSync()` and `readlinkSync()` -- every other shape is
 * raised by the `realpathSync()` above it -- so a race is the only way to reach
 * either branch, and wrapping `fs` is the only way to stage one.
 */
let linkCode = 'EACCES';

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();

  return {
    ...real,
    chownSync(path: string, uid: number, gid: number): void {
      calls.push(`chown ${path}`);
      real.chownSync(path, uid, gid);
    },
    closeSync(fd: number): void {
      real.closeSync(fd);
      if (fail === 'close') {
        throw new Error('close refused');
      }
    },
    fsyncSync(fd: number): void {
      if (fail === 'fsync') {
        // the code is the test's, because *which* ones are swallowed is the
        // whole claim: a filesystem declining the operation answers `EINVAL`
        // from a network mount, and a flush that **failed** answers `EIO` --
        // where the bytes may not be on disk, which is the truncated file this
        // module exists to prevent arriving by the one road it was meant to
        // close
        throw Object.assign(new Error(flushCode), { code: flushCode });
      }
      real.fsyncSync(fd);
    },
    statSync(path: string, opts?: unknown): unknown {
      if (fail === 'stat') {
        throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
      }
      return (real.statSync as (p: string, o?: unknown) => unknown)(path, opts);
    },
    openSync(path: string, flags: string, mode?: number): number {
      calls.push(`open ${path}`);
      plantAt(path, real);
      return real.openSync(path, flags, mode);
    },
    readlinkSync(path: string, opts?: unknown): unknown {
      if (fail === 'readlink') {
        throw Object.assign(new Error(linkCode), { code: linkCode });
      }
      if (fail === 'loop') {
        // a link that points at itself, which the file system itself refuses
        // with `ELOOP` -- so this is the one way to put the walk in a cycle,
        // and it is the race the bound exists for
        return path;
      }
      return (real.readlinkSync as (p: string, o?: unknown) => unknown)(path, opts);
    },
    renameSync(from: string, to: string): void {
      calls.push(`rename ${from} -> ${to}`);
      if (fail === 'rename') {
        throw new Error('rename refused');
      }
      real.renameSync(from, to);
    },
    unlinkSync(path: string): void {
      calls.push(`unlink ${path}`);
      real.unlinkSync(path);
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const fs = await vi.importActual<typeof import('node:fs')>('node:fs');

  return {
    ...real,
    async open(path: string, flags: string, mode?: number): Promise<unknown> {
      calls.push(`open ${path}`);
      plantAt(path, fs);
      return real.open(path, flags, mode);
    },
  };
});

const { writeAtomic, writeAtomicSync } = await import('../../src/config/atomic.js');

let root: string;

beforeEach(() => {
  calls.length = 0;
  fail = undefined;
  plant = undefined;
  planted.length = 0;
  flushCode = 'EINVAL';
  linkCode = 'EACCES';
  root = mkdtempSync(join(tmpdir(), 'sigil-atomic-'));
});

afterEach(() => {
  rmSync(root, { force: true, recursive: true });
});

/** The path the one `open` was given. */
function opened(): string {
  const call = calls.find((it) => it.startsWith('open '));
  return call === undefined ? '' : call.slice('open '.length);
}

describe('where the temp file goes', () => {
  it('should be in the target own directory rather than in tmp', () => {
    // `rename()` is only atomic **within one filesystem**, so a temp file in
    // `tmp()` is a copy and a delete rather than a rename -- which has the
    // half-written window back, plus a cross-device failure on the platforms
    // that refuse `EXDEV`
    const path = join(root, 'c.jsonc');
    writeAtomicSync(path, 'x');

    expect(dirname(opened())).to.equal(root);
    expect(dirname(opened())).to.not.equal(tmpdir());
    expect(opened()).to.not.equal(path);
    expect(calls).to.deep.equal([`open ${opened()}`, `rename ${opened()} -> ${path}`]);
  });

  it('should pick a name no other save in this process can pick', () => {
    // two saves in one process is ordinary -- a run that sets five keys and
    // saves two layers -- and a shared temp name would have them overwrite each
    // other's bytes
    writeAtomicSync(join(root, 'a.jsonc'), 'x');
    const first = opened();
    calls.length = 0;
    writeAtomicSync(join(root, 'a.jsonc'), 'y');

    expect(opened()).to.not.equal(first);
  });

  it('should leave nothing behind where the rename failed', () => {
    const path = join(root, 'c.jsonc');
    writeFileSync(path, 'old');
    fail = 'rename';

    expect(() => writeAtomicSync(path, 'new')).toThrow(/rename refused/);
    // the old file is still the old file, which is what atomic means
    expect(readFileSync(path, 'utf8')).to.equal('old');
    expect(readdirSync(root)).to.deep.equal(['c.jsonc']);
    expect(calls.at(-1)).to.equal(`unlink ${opened()}`);
  });

  it('should leave nothing behind where the close failed', () => {
    // the one failure that happens with the temp file already written and the
    // handle already gone, which is why the cleanup brackets the whole use of
    // it rather than only the rename
    const path = join(root, 'c.jsonc');
    fail = 'close';

    expect(() => writeAtomicSync(path, 'new')).toThrow(/close refused/);
    expect(readdirSync(root)).to.deep.equal([]);
  });

  it('should attempt no chown where the process is not root', () => {
    // the owner is the target's or the directory's **under sudo** only, because
    // a non-root process cannot hand a file to anybody and a `chown` it tries
    // anyway is a failure over a file it was going to write correctly. The root
    // half -- that `sudo mycli config set` leaves a config its owner can still
    // edit -- is a claim no non-root test can make, so it is declared in
    // docs/history/writing-a-config-file-back-without-destroying-it.md rather
    // than asserted here
    const path = join(root, 'c.jsonc');
    writeFileSync(path, 'old');
    writeAtomicSync(path, 'new');

    expect(process.getuid?.()).to.not.equal(0);
    expect(calls.filter((it) => it.startsWith('chown '))).to.deep.equal([]);
  });

  it.each(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'])(
    'should write anyway where the filesystem declined to flush with %s',
    (code) => {
      // swallowed, because a filesystem that refuses one refuses it always:
      // `EINVAL` is what a network mount answers. Each of the five rather than
      // the one, because the **set** is the claim -- four of them were in it and
      // pinned by nothing, so cutting it back to `EINVAL` failed no test while
      // turning a declined flush into a failed save. Found by review
      const path = join(root, 'c.jsonc');
      fail = 'fsync';
      flushCode = code;

      writeAtomicSync(path, 'new');
      expect(readFileSync(path, 'utf8')).to.equal('new');
    }
  );
});

describe('a file somebody else put at the temp name', () => {
  // the open was `'w'` under `<path>.<pid>-<seq>.tmp` with `seq` from 0, so a
  // symlink planted at that name redirected the write to its target and the
  // rename then moved **the link** over the config -- after which every later
  // save wrote through it as well. Both halves of the write are pinned, because
  // the sync and async opens are two real implementations of one loop
  const writes = {
    async: (path: string, text: string) => writeAtomic(path, text),
    // `async` so that a throw arrives as a rejection, which is what lets one
    // assertion read both
    sync: async (path: string, text: string) => writeAtomicSync(path, text),
  };

  for (const [how, write] of Object.entries(writes)) {
    it.skipIf(process.platform === 'win32')(
      `should not write through a symlink planted at the temp name (${how})`,
      async () => {
        // skipped on Windows, where making a symlink takes a privilege the CI
        // runner does not have; the plain-file case below is the portable half
        const path = join(root, 'config.json');
        const victim = join(root, 'victim.txt');
        writeFileSync(path, '{"a":1}\n');
        writeFileSync(victim, 'VICTIM\n');
        plant = { kind: 'link', times: 1, victim };

        await write(path, '{"a":2}\n');

        // the victim is untouched, the config is a file rather than the link,
        // and it holds what was written
        expect(readFileSync(victim, 'utf8')).to.equal('VICTIM\n');
        expect(lstatSync(path).isSymbolicLink()).toBe(false);
        expect(readFileSync(path, 'utf8')).to.equal('{"a":2}\n');
        // and the planted link is still where it was put: it is not this
        // process's to delete, so a name that is taken is left alone and another
        // is drawn
        expect(planted).to.have.length(1);
        expect(lstatSync(planted[0] as string).isSymbolicLink()).toBe(true);
        expect(opened()).to.equal(planted[0]);
        expect(calls.filter((it) => it.startsWith('open '))).to.have.length(2);
      }
    );

    it(`should give up where every temp name it draws is taken (${how})`, async () => {
      // a name is 64 random bits, so one collision is a coincidence and four in
      // a row is a directory answering `EEXIST` for everything -- worth raising
      // rather than looping on. A plain file rather than a link, so this half
      // runs everywhere, and `'w'` would have truncated and renamed it
      const path = join(root, 'config.json');
      const victim = join(root, 'victim.txt');
      writeFileSync(path, 'old');
      plant = { kind: 'file', times: Number.POSITIVE_INFINITY, victim };

      await expect(write(path, 'new')).rejects.toThrow(/EEXIST/);
      expect(readFileSync(path, 'utf8')).to.equal('old');
      expect(planted).to.have.length(4);
      for (const it of planted) {
        expect(readFileSync(it, 'utf8')).to.equal('PLANTED');
      }
      // nothing was unlinked: none of those files was this process's
      expect(calls.filter((it) => it.startsWith('unlink '))).to.deep.equal([]);
    });
  }

  it('should draw a temp name nobody can work out in advance', () => {
    // the other half of the fix, since an exclusive open under a name anybody
    // can predict is a save anybody can make fail. Two saves in one process used
    // to differ only in a counter
    const path = join(root, 'c.jsonc');
    writeAtomicSync(path, 'x');
    const first = opened();
    calls.length = 0;
    writeAtomicSync(path, 'y');

    expect(first).to.not.contain(`.${process.pid}-`);
    expect(basename(first)).to.match(/^c\.jsonc\.[0-9a-f]{16}\.tmp$/);
    expect(basename(opened())).to.match(/^c\.jsonc\.[0-9a-f]{16}\.tmp$/);
    expect(opened()).to.not.equal(first);
  });
});

describe('what a failed readlink means', () => {
  /** A link to a file that is not there, which is what makes the walk run. */
  function dangling(): { link: string; target: string } {
    const target = join(root, 'dotfiles', 'real.jsonc');
    const link = join(root, 'link.jsonc');
    symlinkSync(target, link);
    return { link, target };
  }

  it('should raise one that failed rather than reading it as the end of the chain', () => {
    // the walk follows a dangling link by hand, and the one thing it must not do
    // is read "I could not look" as "there is nothing here" -- which would write
    // the plain file at the link's own location, the defect the walk exists for.
    // An `EACCES` means the write cannot land, and saying so beats writing
    // somewhere else
    const { link } = dangling();
    fail = 'readlink';
    linkCode = 'EACCES';

    expect(() => writeAtomicSync(link, 'x')).toThrow(/EACCES/);
    // and nothing was opened, so there is no temp file to clean up
    expect(calls).to.deep.equal([]);
  });

  it('should give up on a chain that does not end rather than following it forever', () => {
    // the file system answers `ELOOP` for a cycle and for any chain of 31 or
    // more links, so the walk's input is a chain of at most thirty hops and no
    // state the file system can be in reaches the bound. What it bounds is a
    // link that changed between the two calls -- which is what the wrapper
    // stages here, because a loop with no bound in a save is a hang
    const { link } = dangling();
    fail = 'loop';

    expect(() => writeAtomicSync(link, 'x')).toThrow(/Too many levels of symbolic links/);
    expect(calls).to.deep.equal([]);
  });

  it.each(['EINVAL', 'ENOENT'])('should end the chain where %s says there is no link', (code) => {
    // `ENOENT` is nothing there, which is the end of a dangling chain and the
    // ordinary new-file case; `EINVAL` is something there that is **not** a
    // link, which only a race can produce because `realpathSync()` would have
    // resolved it. Both are the end of the walk, and the set *is* the claim --
    // cutting `EINVAL` out of it turns that race into a failed save
    const { link } = dangling();
    fail = 'readlink';
    linkCode = code;

    writeAtomicSync(link, 'x');
    // the write landed where the walk stopped, which is the link's own path
    expect(calls.at(-1)).to.equal(`rename ${opened()} -> ${link}`);
  });
});

describe('what a failed stat and a failed flush mean', () => {
  it('should raise a stat that failed for a reason other than the file missing', () => {
    // a bare `catch` read an `EPERM` or an `EIO` as a file that is not there, so
    // the mode of a file that **is** there was silently not carried and a `0o600`
    // config came back world-readable. Only `ENOENT` is nothing. Found by review
    const path = join(root, 'c.jsonc');
    writeFileSync(path, '{}\n');
    fail = 'stat';

    expect(() => writeAtomicSync(path, 'x')).toThrow(/EPERM/);
    // and nothing was opened, so there is no temp file to clean up either
    expect(calls).to.deep.equal([]);
  });

  it.each(['EIO', 'ENOSPC', 'EDQUOT'])(
    'should raise a flush that failed with %s rather than one declined',
    (code) => {
      // the difference is the whole point of flushing: an `EIO` says the bytes
      // may not be on disk, which is the truncated file this exists to prevent.
      // The five declined codes above are a filesystem that does not flush at
      // all, and each of those is pinned too -- the set *is* the claim
      const path = join(root, 'c.jsonc');
      fail = 'fsync';
      flushCode = code;

      expect(() => writeAtomicSync(path, 'x')).toThrow(new RegExp(code));
      // and the temp file is gone, so a failed flush leaves nothing behind
      expect(calls.filter((it) => it.startsWith('unlink '))).to.have.length(1);
      expect(readdirSync(root)).to.deep.equal([]);
    }
  );
});
