import { spawnSync } from 'node:child_process';
import { chmodSync, writeFileSync } from 'node:fs';

/**
 * Writes an executable a test is about to run, without this process ever
 * holding the file open for writing (SIG-482).
 *
 * `writeFileSync(path, script, { mode: 0o755 })` followed by a spawn of `path`
 * fails now and then on Linux with `ETXTBSY`, and the cause is not the test
 * that wrote it. This package runs its tests in vitest's `threads` pool, so
 * several test files share one process, and a `fork()` copies every descriptor
 * the process holds -- including one another thread opened a microsecond ago
 * to write a stub. The copy is close-on-exec, so it lasts only until the forked
 * child calls `execve()`; but until then the file has a writer, and Linux
 * refuses to execute a file that has one. So a stub written in one thread and
 * spawned at once can meet a fork from a sibling thread that happened to land
 * inside `writeFileSync()`'s open-to-close window.
 *
 * Writing to a temporary name and renaming it into place does **not** help,
 * though it is the usual advice: the inherited descriptor holds the inode, not
 * the name, and a rename keeps the inode. Nor can the tests coordinate their
 * forks with one another, since the forks are in code under test and in other
 * files. What does work is never having the descriptor here at all: the bytes
 * go through `/bin/sh -c 'cat > "$1"'`, so the only process that opens the file
 * for writing is that child's, and it has exited -- and with it every writer
 * the file will ever have -- before this returns. The mode is applied
 * afterwards with `chmod`, which opens nothing, and is exact rather than
 * filtered by the umask the way `writeFileSync()`'s `mode` is.
 *
 * The cost is one short-lived `sh` per stub. Every POSIX platform takes this
 * path, macOS included, though only Linux refuses the exec: the path CI's Linux
 * jobs take is then the one a local run takes too. Windows has no such rule
 * and no `/bin/sh`, so it writes the file in place, and a mode there only
 * toggles the read-only flag.
 *
 * @param path - Where the executable goes. Its directory must exist.
 * @param contents - The script or binary, written byte for byte.
 * @param mode - The permission bits it ends with on POSIX.
 */
export function writeExecutable(path: string, contents: string | Uint8Array, mode = 0o755): void {
  if (process.platform === 'win32') {
    writeFileSync(path, contents);
    return;
  }

  const wrote = spawnSync('/bin/sh', ['-c', 'cat > "$1"', 'sh', path], {
    encoding: 'utf-8',
    input: contents,
  });

  if (wrote.error) {
    throw wrote.error;
  }

  if (wrote.status !== 0) {
    // a signal leaves `status` null and usually nothing on stderr, so it is
    // named or the message would end in a colon
    const why =
      wrote.stderr.trim() ||
      (wrote.signal ? `sh was killed by ${wrote.signal}` : `sh exited ${wrote.status}`);
    throw new Error(`Could not write ${path}: ${why}`);
  }

  chmodSync(path, mode);
}
