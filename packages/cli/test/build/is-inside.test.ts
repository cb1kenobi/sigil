import { isInside } from '../../src/build/discover.ts';
import { posix, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The one answer to "is this path under that directory", which guards the
 * bundle unwind, the runtime cache and the registry's paths, and is half of the
 * clean guard.
 *
 * Both platforms are asked on every machine, through `posix` and `win32`, and no
 * path below spells a separator: each is built by the path module it is asked
 * of.
 */

const posixApp = posix.join(posix.sep, 'home', 'someone', 'apps', 'mycli');
const drive = `C:${win32.sep}`;
const winApp = win32.join(drive, 'Users', 'someone', 'apps', 'mycli');
const share = win32.join(`${win32.sep}${win32.sep}server`, 'share', win32.sep);

describe('isInside', () => {
  it('should find a path under the filesystem root, which a prefix with a second separator missed', () => {
    expect(isInside(posix.sep, posix.join(posix.sep, 'tmp'), posix)).toBe(true);
    expect(isInside(drive, win32.join(drive, 'tmp'), win32)).toBe(true);
    expect(isInside(share, win32.join(share, 'apps'), win32)).toBe(true);
  });

  it('should not count the directory itself', () => {
    expect(isInside(posixApp, posixApp, posix)).toBe(false);
    expect(isInside(winApp, winApp, win32)).toBe(false);
    expect(isInside(posix.sep, posix.sep, posix)).toBe(false);
  });

  it('should not read a sibling sharing a prefix as inside', () => {
    const dist = posix.join(posixApp, 'dist');
    expect(isInside(dist, posix.join(posixApp, 'dist-old', 'a.js'), posix)).toBe(false);

    const winDist = win32.join(winApp, 'dist');
    expect(isInside(winDist, win32.join(winApp, 'dist-old', 'a.js'), win32)).toBe(false);
  });

  it('should refuse a path that climbs out, and keep a child called ..foo', () => {
    expect(isInside(posixApp, posix.join(posixApp, '..', 'other'), posix)).toBe(false);
    expect(isInside(posixApp, posix.join(posixApp, 'a', '..', '..', 'other'), posix)).toBe(false);
    expect(isInside(posixApp, posix.join(posixApp, '..foo'), posix)).toBe(true);

    expect(isInside(winApp, win32.join(winApp, '..', 'other'), win32)).toBe(false);
    expect(isInside(winApp, win32.join(winApp, '..foo'), win32)).toBe(true);
  });

  // a prefix is case-sensitive and the Windows filesystem is not, so the copy
  // this replaced read a differently cased path into the app as outside it
  it('should compare Windows paths without regard to case', () => {
    const lower = win32.join(winApp.toLowerCase(), 'dist', 'a.js');
    expect(isInside(winApp, lower, win32)).toBe(true);
    expect(isInside(winApp.toUpperCase(), win32.join(winApp, 'a.js'), win32)).toBe(true);
  });

  it('should keep POSIX paths case-sensitive', () => {
    expect(isInside(posixApp, posix.join(posixApp.toUpperCase(), 'a.js'), posix)).toBe(false);
  });

  it('should refuse a path on another drive', () => {
    expect(isInside(winApp, win32.join(`D:${win32.sep}`, 'a.js'), win32)).toBe(false);
    expect(isInside(winApp, win32.join(share, 'a.js'), win32)).toBe(false);
  });

  it('should resolve a relative path against the working directory', () => {
    expect(isInside(process.cwd(), 'a.js')).toBe(true);
    expect(isInside('.', 'a.js')).toBe(true);
    expect(isInside('.', '.')).toBe(false);
  });
});
