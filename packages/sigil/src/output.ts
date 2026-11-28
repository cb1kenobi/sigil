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
 * `EIO` is the one code that depends on **what was written to**, which is why the
 * stream is an argument. A terminal that hung up -- an ssh connection dropped, a
 * window closed -- fails the next write `EIO`, and that is the reader leaving as
 * much as `EPIPE` is. On a file `EIO` is the disk failing, and on a pipe it is not
 * a thing a reader leaving produces, so for those it stays a real fault and is
 * thrown. With no stream to ask about it is thrown too.
 *
 * @param err - Whatever a write threw or a stream emitted.
 * @param stream - The stream it came from, when the caller has it.
 * @returns `true` for `EPIPE` and its relatives, and for `EIO` on a TTY.
 */
export function isStreamGone(err: unknown, stream?: { readonly isTTY?: boolean }): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code as string;
  return GONE.has(code) || (code === 'EIO' && stream?.isTTY === true);
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
  readonly isTTY?: boolean;
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
      if (!isStreamGone(err, stream)) {
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
 * The descriptor to write through directly, when a stream is the process's own
 * output and is a regular file.
 *
 * Only `process.stdout` and `process.stderr` (SIG-671): a stream somebody else
 * made has a queue of its own, and an `fs.WriteStream` has a position too, so
 * writing to its descriptor puts the text ahead of what the stream still holds
 * and, for one opened with `start`, at offset 0 of the file. The process's own
 * streams are the ones whose descriptor is nobody's but the process's, which is
 * what makes writing round them safe. Compared by identity and read at call time,
 * since `process.stdout` is a getter and a test may have replaced it.
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
  if (stream !== process.stdout && stream !== process.stderr) {
    return undefined;
  }

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
 * Writes to a stream, and throws if the stream is the process's own output, is a
 * file, and not all of it landed.
 *
 * Only `process.stdout` and `process.stderr` take the checked path. Any other
 * stream -- a pipe, a terminal, a stream whose `write` was replaced, a stream with
 * no descriptor, and a stream the caller opened, an `fs.WriteStream` included --
 * is `stream.write()`, unchanged: it owns its queue and its position, so the text
 * lands in order and where the stream says. What such a stream does about a short
 * write is its own, and arrives as its `error` event rather than as a throw here.
 * For the process's own file the text goes through the descriptor, whole.
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

/**
 * What a piece of long-running work says about itself (SIG-722).
 *
 * A progress bar reports where it is and of how much; a spinner has no measure,
 * so it reports its message and a count of its updates as the progress. Nothing
 * here draws: this is for a reader that is not a terminal -- an MCP server
 * forwarding a tool call's progress to its client -- and it is told whatever the
 * terminal is, quiet runs included, because a report is not output.
 */
export interface ProgressUpdate {
  /** What the work is doing, where it says. */
  readonly message?: string;
  /** How far along, in units of `total`, or a count of updates where there is none. */
  readonly progress: number;
  /** What `progress` is counting towards, where the work knows. */
  readonly total?: number;
}

/** A reader of {@link ProgressUpdate}s. */
export type ProgressObserver = (update: ProgressUpdate) => void;

/**
 * The observers, kept on `globalThis` under a registered symbol so that every
 * copy of this module in a process shares them: an ejected progress bar is a
 * copy, and so is a second install of the package, and an observer one of them
 * cannot reach would hear nothing from it.
 */
const OBSERVERS = Symbol.for('@ttylabs/sigil.progressObservers');

/**
 * The observer set, made on first use.
 *
 * @returns The set.
 */
function observers(): Set<ProgressObserver> {
  const shared = globalThis as unknown as Record<symbol, Set<ProgressObserver> | undefined>;
  return (shared[OBSERVERS] ??= new Set());
}

/**
 * Hears every progress report in this process until the returned function is
 * called.
 *
 * @param observer - Told each report.
 * @returns What stops it hearing them.
 */
export function observeProgress(observer: ProgressObserver): () => void {
  observers().add(observer);
  return () => {
    observers().delete(observer);
  };
}

/**
 * Tells every observer about a piece of work's progress.
 *
 * An observer that throws is skipped and the rest are still told: the report is
 * a side channel of the work, and a reader failing must not fail the work it was
 * reading about.
 *
 * @param update - The report.
 */
export function reportProgress(update: ProgressUpdate): void {
  for (const observer of Array.from(observers())) {
    try {
      observer(update);
    } catch {
      // the observer's own failure, which is its to report
    }
  }
}
