import { assertCleanable, clean, holdsApp } from '../src/commands/_inspect.ts';
import { tempDir } from './temp.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, parse, posix, resolve, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The guard in front of `rmSync(out, { recursive: true })`.
 *
 * Everything here asks the guard and nothing here asks `clean()` to remove a
 * directory it should refuse, because the defect this file is named for is the
 * guard saying yes to `/`. A regression would make that removal real, so the
 * one end-to-end test is over a temp directory that is an ancestor of a temp
 * app, and the root is only ever put to `assertCleanable()` and `holdsApp()`,
 * which are pure path arithmetic.
 *
 * Both platforms are asked on every machine, through `posix` and `win32`, and no
 * path below spells a separator: each is built by the path module it is asked
 * of, and the roots are each module's own `sep` or a drive letter in front of
 * it.
 */

const posixApp = posix.join(posix.sep, 'home', 'someone', 'apps', 'mycli');
const drive = `C:${win32.sep}`;
const winApp = win32.join(drive, 'Users', 'someone', 'apps', 'mycli');
const share = win32.join(`${win32.sep}${win32.sep}server`, 'share', win32.sep);
const shareApp = win32.join(share, 'apps', 'mycli');

describe('the clean guard', () => {
  it('should refuse the filesystem root, which `${out}${sep}` read as `//` and let through', () => {
    expect(holdsApp(posix.sep, posixApp, posix)).toBe(true);
  });

  it('should refuse a drive root, which `${out}${sep}` read as `C:\\\\` and let through', () => {
    expect(holdsApp(drive, winApp, win32)).toBe(true);
    expect(holdsApp(share, shareApp, win32)).toBe(true);
  });

  it('should refuse the host root through assertCleanable()', () => {
    // asked of the guard alone, never of `clean()`: this is the call that
    // used to return and let the removal through
    const app = resolve(tempDir('sigil-clean-guard-'), 'app');

    expect(() => assertCleanable(parse(app).root, app, true)).toThrow('holds the app itself');
  });

  it('should refuse every ancestor of the app, and the app root itself', () => {
    for (let dir = posixApp; ; dir = posix.dirname(dir)) {
      expect(holdsApp(dir, posixApp, posix), dir).toBe(true);
      if (dir === posix.dirname(dir)) {
        break;
      }
    }

    for (let dir = winApp; ; dir = win32.dirname(dir)) {
      expect(holdsApp(dir, winApp, win32), dir).toBe(true);
      if (dir === win32.dirname(dir)) {
        break;
      }
    }
  });

  it('should refuse a Windows ancestor spelled in another case, as the filesystem reads it', () => {
    // a prefix test is case-sensitive and Windows is not, so `c:\users` used
    // to pass as somewhere other than above `C:\Users\...`
    expect(holdsApp(win32.join('c:', 'users'), winApp, win32)).toBe(true);
    expect(holdsApp(win32.join('c:', win32.sep), winApp, win32)).toBe(true);
    // the app root itself, spelled in another case, is the app root
    expect(holdsApp(winApp.toLowerCase(), winApp, win32)).toBe(true);
  });

  it('should allow a directory inside the app, beside it, or on another drive', () => {
    expect(holdsApp(posix.join(posixApp, 'dist'), posixApp, posix)).toBe(false);
    expect(holdsApp(posix.join(posixApp, '..', 'mycli-dist'), posixApp, posix)).toBe(false);
    expect(holdsApp(posix.join(posix.sep, 'elsewhere'), posixApp, posix)).toBe(false);

    expect(holdsApp(win32.join(winApp, 'dist'), winApp, win32)).toBe(false);
    expect(holdsApp(win32.join(winApp, '..', 'mycli-dist'), winApp, win32)).toBe(false);
    expect(holdsApp(win32.join('D:', win32.sep), winApp, win32)).toBe(false);
  });

  it('should read a child called `..foo` as inside rather than above', () => {
    // `..` is matched as a whole segment: `relative()` from a parent to a
    // directory called `..foo` starts with the two dots and is still a child
    const parent = posix.join(posix.sep, 'srv');

    expect(holdsApp(parent, posix.join(parent, '..foo'), posix)).toBe(true);
    expect(holdsApp(posix.join(parent, '..foo', 'dist'), posix.join(parent, '..foo'), posix)).toBe(
      false
    );
  });

  it('should leave an ancestor of the app in place when clean() is asked to empty it', () => {
    const base = tempDir('sigil-clean-guard-');
    const app = join(base, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'package.json'), '{}');

    expect(() => clean(base, app, true)).toThrow('holds the app itself');
    expect(existsSync(join(app, 'package.json'))).toBe(true);
  });

  it('should refuse nothing when cleaning was not asked for', () => {
    const app = resolve(tempDir('sigil-clean-guard-'), 'app');

    expect(() => assertCleanable(parse(app).root, app, false)).not.toThrow();
  });
});
