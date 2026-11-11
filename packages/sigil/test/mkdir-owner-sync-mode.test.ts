import { mkdirOwnerSync } from '../src/util/mkdir-owner-sync.js';
import { tempDir } from './temp.js';
import { chmodSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * What `mkdirOwnerSync()` makes on a real file system. `mkdir-owner-sync.test.ts`
 * replaces `node:fs` to reason about owners, which is why the mode is asked about
 * in a file of its own: a mode is the kernel's answer, and only a real `mkdir`
 * gives it.
 */

/**
 * A parent whose mode is known, so that nothing a test reads back is inherited
 * from the system temp directory -- on Linux a setgid parent makes every child
 * setgid whatever mode it was asked for.
 */
function parent(): string {
  const dir = join(tempDir('sigil-mkdir-mode-'), 'parent');
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  return dir;
}

describe('mkdirOwnerSync mode', () => {
  // the default was `0o7777`, which asks for setuid, setgid and sticky on top of
  // `rwxrwxrwx`. macOS drops the three special bits on a new directory and Linux
  // keeps the sticky one, so the same call made `755` on one and `1755` on the
  // other -- nobody asked for either special bit, and the umask removes only
  // permission bits
  it.skipIf(process.platform === 'win32')(
    'should not ask for the setuid, setgid or sticky bits by default',
    () => {
      const base = parent();
      const dest = join(base, 'a', 'b', 'c');

      mkdirOwnerSync(dest);

      // every directory the call made, not only the last one
      for (const dir of [join(base, 'a'), join(base, 'a', 'b'), dest]) {
        expect((statSync(dir).mode & 0o7000).toString(8), dir).to.equal('0');
      }
    }
  );

  it.skipIf(process.platform === 'win32')('should still apply an explicit mode', () => {
    const base = parent();
    const dest = join(base, 'a', 'b');

    // a umask removes bits and never adds them, and none an ordinary umask
    // removes are in `0o700`
    mkdirOwnerSync(dest, { mode: 0o700 });

    for (const dir of [join(base, 'a'), dest]) {
      expect((statSync(dir).mode & 0o7777).toString(8), dir).to.equal('700');
    }
  });
});
