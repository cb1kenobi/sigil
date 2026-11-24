/**
 * Writing to standard output without being killed by the reader leaving, and
 * knowing that all of it landed (SIG-538, SIG-542).
 *
 * Two failures with one cause, which is that Node tells a program very little
 * about a write to `process.stdout`:
 *
 * - **The reader goes away.** `mycli list | head -1` closes the pipe once `head`
 *   has its line, the next write fails `EPIPE`, and an `error` event on a stream
 *   with no listener is an uncaught exception -- a stack trace from a program
 *   that did nothing wrong. `guardOutput()` is the listener, and it is what
 *   `main()` attaches before it parses anything.
 * - **Part of a write is taken.** When stdout is a regular file Node writes with
 *   one `fs.writeSync()` and **discards the byte count**, so a kernel that takes
 *   only part of it -- a full disk, or `ulimit -f` -- raises no `error` event and
 *   the command exits 0 over a cut-off file. `writeOut()` loops on the count, and
 *   the retry is what turns a short write into an error: the kernel takes nothing
 *   at a full disk or at the size limit, so the second call fails with the real
 *   errno, and a call that returns zero is refused rather than looped on.
 *
 * Imports only `node:fs`, so it stays off the parser's graph and out of the
 * terminal's.
 */

import { fstatSync, writeSync } from 'node:fs';

/**
 * The errors that mean the other end is gone and nothing more will be read.
 *
 * `EPIPE` is the reader closing the pipe -- `mycli --help | head -1` the instant
 * `head` has its line. `ERR_STREAM_DESTROYED` is the same thing arriving through
 * a stream that has already torn down. `EOF` is Windows saying `EPIPE` another
 * way: libuv maps `ERROR_BROKEN_PIPE`, which is what a write to a pipe whose
 * reader has closed can come back as there, to `EOF`. None of them is the app's
 * fault and none is worth a stack trace.
 */
const GONE = new Set(['EPIPE', 'EOF', 'ERR_STREAM_DESTROYED', 'ERR_STREAM_WRITE_AFTER_END']);

/**
 * Whether an error from writing to a stream is the reader having gone away.
 *
 * The one answer to that question, so that a program which writes to
 * `process.stdout` itself and one that writes through a terminal agree on which
 * errors are the far end leaving and which are a real fault. The terminal's own
 * listener swallows every error, as best-effort output should; a program whose
 * output matters attaches one that returns when this says `true` and rethrows
 * when it says `false`, which is how `mycli > file` on a full disk (`ENOSPC`)
 * stays a failure while `mycli | head -1` does not.
 *
 * @param err - Whatever a write threw or a stream emitted.
 * @returns `true` for `EPIPE` and its relatives.
 */
export function isStreamGone(err: unknown): boolean {
  return GONE.has((err as NodeJS.ErrnoException | undefined)?.code as string);
}

/**
 * Marks a listener as this module's, across copies of this module.
 *
 * A built app carries its own copy of the runtime and a plugin or a test may
 * load a second, so a module-level set would answer "guarded" for one copy and
 * "not yet" for the next, and a stream would collect a listener per copy. The
 * mark is on the listener, found by asking the stream what it holds, and is
 * `Symbol.for` so every copy reads the same one -- and a listener something took
 * off is a stream that is asked again rather than one a set remembers.
 */
const GUARD = Symbol.for('@ttylabs/sigil/output-guard');

/** Only what a guard asks of a stream. */
export interface GuardableStream {
  listeners?(event: 'error'): readonly unknown[];
  on?(event: 'error', listener: (err: unknown) => void): unknown;
}

/**
 * Lets a reader that has gone away end a program's output quietly.
 *
 * One listener on each stream, attached once however many times this is called
 * and however many copies of the runtime call it, which is what lets a nested
 * `main()` ask again without stacking. It returns when `isStreamGone()` says the
 * reader left, and **throws anything else** from the listener -- which is the
 * uncaught exception it was before the guard existed, so a real fault
 * (`ENOSPC`, `EFBIG`) still fails the program rather than exiting 0 over a
 * cut-off file. That is the difference from the terminal's listener, which
 * swallows every error because its output is best-effort.
 *
 * The listener is never taken off: a program's lifetime is the guard's, and the
 * `EPIPE` for the last write arrives after `main()` has resolved. What it does
 * not touch is the exit code: later writes land nowhere, nothing is printed, and
 * the code is whatever the command's own result was.
 *
 * @param streams - What to guard. Defaults to `process.stdout` and
 * `process.stderr`.
 */
export function guardOutput(
  streams: readonly GuardableStream[] = [process.stdout, process.stderr]
): void {
  for (const stream of streams) {
    if (typeof stream?.on !== 'function') {
      continue;
    }

    const held = typeof stream.listeners === 'function' ? stream.listeners('error') : [];
    if (held.some((listener) => (listener as { [GUARD]?: true })[GUARD] === true)) {
      continue;
    }

    const onError = (err: unknown): void => {
      if (!isStreamGone(err)) {
        throw err;
      }
    };
    (onError as { [GUARD]?: true })[GUARD] = true;
    stream.on('error', onError);
  }
}

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
 * The descriptor to write through directly, when a stream is a regular file.
 *
 * Only a file: a pipe or a terminal is written through the stream, whose queue
 * already carries a partial write to completion and whose `error` event is what
 * `guardOutput()` listens for. And only the real stream -- a test or an app that
 * replaced `write` on `process.stdout` is capturing, and bypassing its capture
 * would put the output somewhere it cannot see.
 *
 * @returns The descriptor, or `undefined` for the stream to handle.
 */
function fileDescriptor(stream: object): number | undefined {
  const fd = (stream as { fd?: unknown }).fd;
  if (Object.hasOwn(stream, 'write') || typeof fd !== 'number') {
    return undefined;
  }

  try {
    return fstatSync(fd).isFile() ? fd : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes to a stream, and throws if the stream is a file and not all of it landed.
 *
 * Anything that is not a regular file -- a pipe, a terminal, a stream whose
 * `write` was replaced, a stream with no descriptor -- is `stream.write()`,
 * unchanged. For a file the text goes through the descriptor, whole.
 *
 * @param stream - Where to write: `process.stdout` for a document, and
 * `process.stderr` for a diagnostic, since `2> log` is a file as much as `> out`.
 * @param text - What to write.
 * @throws When part of the text did not land.
 */
export function writeTo(
  stream: { readonly fd?: unknown; write(text: string): unknown },
  text: string
): void {
  const fd = fileDescriptor(stream);

  if (fd === undefined) {
    stream.write(text);
    return;
  }

  writeFully(text, (bytes, offset) => writeSync(fd, bytes, offset));
}

/**
 * Writes to stdout, and throws if all of it did not land.
 *
 * What `main()` writes its help, its `--version` and a command's serialized
 * output through, and what a program that prints a document of its own should
 * use in place of `process.stdout.write()` when the document is data -- a
 * cut-off JSON file that exited 0 fails somewhere else, later.
 *
 * @param text - The text.
 * @throws When part of the text did not land.
 */
export function writeOut(text: string): void {
  writeTo(process.stdout, text);
}
