/**
 * Writing a document to standard output, and knowing that all of it landed.
 *
 * `sigil reference app > docs/cli.md` wrote its whole document in one
 * `process.stdout.write()`. When stdout is a file Node writes it synchronously
 * with one `fs.writeSync()` and **discards the byte count**, so a kernel that
 * accepts only part of it -- a full disk, or `ulimit -f` -- raised no `error`
 * event and the command exited 0 over a cut-off file (SIG-539). A command that
 * writes in several pieces gets a second write that fails `EFBIG` or `ENOSPC`
 * and `guardOutput()` rethrows it; a command that writes once has no second
 * write to fail on.
 *
 * So a file is written here with `fs.writeSync()` in a loop that reads the count
 * and goes again with the rest. The retry is what turns a short write into an
 * error: the kernel accepts nothing at a full disk or at the size limit, so the
 * second call fails with the real errno, and a call that returns zero is refused
 * as well rather than looped on.
 */

import { fstatSync, writeSync } from 'node:fs';

/** Writes some bytes from an offset, and says how many were taken: `fs.writeSync()`'s shape. */
export type WriteBytes = (bytes: Uint8Array, offset: number) => number;

/**
 * Writes every byte, or throws.
 *
 * @param text - What to write.
 * @param write - The sink, which may take fewer bytes than it was offered.
 * @throws When the sink refuses a write, or takes none of it.
 */
export function writeFully(text: string, write: WriteBytes): void {
  const bytes = Buffer.from(text, 'utf-8');
  let done = 0;

  while (done < bytes.length) {
    let taken: number;
    try {
      taken = write(bytes, done);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      throw new Error(
        `The output was cut off: ${done} of ${bytes.length} bytes were written` +
          `${code ? ` (${code})` : ''}.`,
        { cause: err }
      );
    }

    if (taken <= 0) {
      throw new Error(
        `The output was cut off: ${done} of ${bytes.length} bytes were written, ` +
          `and the destination took no more.`
      );
    }
    done += taken;
  }
}

/**
 * The descriptor to write through directly, when stdout is a regular file.
 *
 * Only a file: a pipe or a terminal is written through the stream, whose queue
 * already carries a partial write to completion and whose `error` event is what
 * `guardOutput()` listens for. And only the real stream -- a test or an app that
 * replaced `write` on `process.stdout` is capturing, and bypassing its capture
 * would put the output somewhere it cannot see.
 *
 * @returns The descriptor, or `undefined` for the stream to handle.
 */
function fileDescriptor(): number | undefined {
  const stdout = process.stdout;
  if (Object.hasOwn(stdout, 'write') || typeof stdout.fd !== 'number') {
    return undefined;
  }

  try {
    return fstatSync(stdout.fd).isFile() ? stdout.fd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes a document to stdout, and throws if all of it did not land.
 *
 * Every toolchain command that prints something a caller redirects goes through
 * here rather than through `process.stdout.write()`, so a command added next
 * year is cut off loudly too if it asks for this and not otherwise: the one
 * definition is the point, and `sigil.ts`'s own `--version` uses it as well.
 *
 * @param text - The document.
 */
export function writeOut(text: string): void {
  const fd = fileDescriptor();

  if (fd === undefined) {
    process.stdout.write(text);
    return;
  }

  writeFully(text, (bytes, offset) => writeSync(fd, bytes, offset));
}
