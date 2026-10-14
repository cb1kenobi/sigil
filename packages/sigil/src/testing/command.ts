import main from '../index.js';
import type { AppOptions, ParseState, Schema } from '../types.js';

/**
 * Running a command the way a user does, and reading back what they would see.
 *
 * ## Over the real `main()`, and that is the whole point
 *
 * A helper that called `parse()` and then the command's `run()` itself would be
 * a second answer to what a parse means: it would have to decide, again, that
 * help outranks a missing required option, that `--version` is answered before
 * the command runs, that a schema which declares commands and was given none
 * prints help, and what a thrown value does to the exit code. Every one of those
 * is a decision `main()` already took and that AGENTS.md records the argument
 * for. So this calls `main()` and reads what it did.
 *
 * What it adds is the three things `main()` writes to the process rather than
 * returning, which is correct for a bin script and useless to a test:
 *
 * 1. **stdout and stderr.** Help, `--version` and a command's own output all go
 *    through `process.stdout.write`; a handled error goes through
 *    `process.stderr.write`. Both are patched for the length of the call and put
 *    back in a `finally`.
 * 2. **The exit code.** `main()` sets `process.exitCode` and resolves. Left
 *    alone, a test for a failing command sets the *test runner's* exit code and
 *    a green suite reports a crash -- so it is read and then restored to
 *    whatever it was.
 * 3. **The parse state.** `main()` returns the state only when the command
 *    returned nothing, so a command that returns a value hides it, and an error
 *    before the command ran returns `undefined`. Captured through the schema's
 *    own hooks instead; see `wrap()`.
 *
 * ## One at a time
 *
 * `process.stdout.write` is process-wide, so two of these running at once would
 * each capture a share of the other's output -- which is not a failure anybody
 * would read as one. It is refused rather than serialised: a queue would make
 * `it.concurrent` *look* like it worked while doubling the wall clock of a
 * suite whose whole point is that it is fast, and the fix is one word in the
 * test file.
 */

/** A patchable write, as both of the process's output streams have. */
type Write = (chunk: unknown, ...rest: unknown[]) => boolean;

/** What a run came to. */
export interface RanCommand {
  /**
   * The values the parse produced, which is what a command's `run()` reads.
   *
   * `{}` when the parse never got far enough to produce any -- a schema that
   * will not initialize, a working directory that is gone. `state` being
   * `undefined` is how to tell that from a parse that produced nothing.
   */
  readonly argv: Record<string, unknown>;
  /**
   * The exit code the run would have left behind: `process.exitCode` after
   * `main()`, or `0` where it set none.
   */
  readonly code: number;
  /** Everything written to stderr, which is where a handled error goes. */
  readonly err: string;
  /**
   * The error, after the `beforeError` hooks have had it.
   *
   * The object rather than the rendered message, so a test can ask whether it
   * was the right *kind* of failure rather than matching prose that is
   * translated. `undefined` for a run that did not fail, and for one whose
   * `settings.errorHandler` is `false` -- that one rethrows, and this rethrows
   * with it.
   */
  readonly error: unknown;
  /** Everything written to stdout: help, `--version`, and the command's own. */
  readonly out: string;
  /** What `main()` returned, which for a command that returns a value is that. */
  readonly result: unknown;
  /** The parse state, where the parse got far enough to produce one. */
  readonly state: ParseState | undefined;
}

/** Set while a run is in progress, because the streams it patches are global. */
let running = false;

/**
 * Runs `main()` and reports what a user would have seen.
 *
 * The options are `main()`'s own, unchanged: a second shape for "how to run this
 * app" would be a second thing to keep in agreement with `AppOptions`, and the
 * point of this helper is that the app under test is configured the way it is in
 * its own bin.
 *
 * `argv` is the one worth passing every time. `main()` falls back to
 * `process.argv.slice(2)`, which under a test runner is the runner's own
 * arguments -- so a run that left it out would parse `--reporter=dot`.
 *
 * @param opts - What to run, as `main()` takes it.
 * @returns What it wrote, how it exited, and what it parsed.
 * @throws Whatever `main()` throws, which is only ever the error a
 *   `settings.errorHandler` of `false` asked to be given back.
 */
export async function runCommand(opts: AppOptions = {}): Promise<RanCommand> {
  if (running) {
    throw new Error(
      'runCommand() is already running: it patches process.stdout and process.stderr, ' +
        'so two at once would each capture part of the other. Run them one at a time.'
    );
  }
  running = true;

  const out: Chunk[] = [];
  const err: Chunk[] = [];
  let stdout: typeof process.stdout.write | undefined;
  let stderr: typeof process.stderr.write | undefined;
  let exitCode: typeof process.exitCode;
  let state: ParseState | undefined;
  let error: unknown;

  // **everything** past the latch is inside the `try`, down to the reads that
  // save what is about to be replaced -- which is not tidiness: a throw between
  // setting the latch and entering the block leaves it set for the life of the
  // process, and every later run refuses with "already running". Two reachable
  // shapes: `wrap()` reads the caller's schema, so a property of theirs that
  // throws on the way out is one, and a `process.stdout.write` somebody
  // redefined as a throwing getter is the other. The first version of this
  // moved `wrap()` in and left the three reads out, with a comment claiming
  // otherwise -- found by review, which is the half a deletion-based pass
  // cannot see. Each restore is guarded on having something to put back, so the
  // `finally` is safe wherever the throw happened
  try {
    // the property as it stands, not a bound copy of it: restoring a bound copy
    // leaves one more `bind` on the stream after every run, so `write` is a
    // different function each time and a test asking whether it was put back
    // cannot tell a restore from a leak
    stdout = process.stdout.write;
    stderr = process.stderr.write;
    exitCode = process.exitCode;

    const schema = wrap(opts.schema, {
      onError(value) {
        error = value;
      },
      onState(value) {
        state = value;
      },
    });

    process.stdout.write = capture(out) as typeof process.stdout.write;
    process.stderr.write = capture(err) as typeof process.stderr.write;
    process.exitCode = undefined;

    // the state is the hooks' and only the hooks': `afterParse` fires for every
    // parse that produced one, and `beforeError` reports one for every parse
    // that threw after `state` existed. A fallback on `main()`'s own return was
    // written here and deleted for being unreachable -- it answers with the
    // state only when the command returned nothing, which is exactly when the
    // hook has already answered with the same object
    const result = await main({ ...opts, schema });

    return {
      argv: (state?.argv as Record<string, unknown>) ?? {},
      code: codeOf(process.exitCode),
      err: text(err),
      error,
      out: text(out),
      result,
      state,
    };
  } finally {
    // guarded on having read one: a throw from the read itself leaves nothing
    // to put back, and assigning `undefined` over a stream's `write` would be
    // the fixture breaking the process it was only ever meant to observe
    if (stdout) {
      process.stdout.write = stdout;
    }
    if (stderr) {
      process.stderr.write = stderr;
    }
    process.exitCode = exitCode;
    running = false;
  }
}

/** What one `write` handed over, kept as it came. */
type Chunk = Buffer | string;

/**
 * What a stream's writes come to, with a run of buffers decoded together.
 *
 * A `write` takes a string or a `Buffer`, and a command writing buffers can
 * split one in the middle of a multi-byte character -- so decoding per chunk
 * puts a `U+FFFD` in what a test reads and the assertion is wrong about one
 * character. Which is the same trap `runOnTerminal()` closes on the other side
 * of a pipe, met here because `process.stdout.write` takes the same two shapes.
 *
 * @param chunks - What was written, in order.
 * @returns The text.
 */
function text(chunks: readonly Chunk[]): string {
  let result = '';
  let buffered: Buffer[] = [];

  const flush = (): void => {
    if (buffered.length > 0) {
      result += Buffer.concat(buffered).toString('utf8');
      buffered = [];
    }
  };

  for (const chunk of chunks) {
    if (typeof chunk === 'string') {
      flush();
      result += chunk;
    } else {
      buffered.push(chunk);
    }
  }
  flush();

  return result;
}

/** Collects what is written, as either stream's `write` is called. */
function capture(into: Chunk[]): Write {
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    // what a stream really takes, which is three things rather than one. Kept as
    // it came rather than coerced, so that `text()` can decode a run of buffers
    // together: a command writing one multi-byte character in two buffers would
    // otherwise reach a test as two replacement characters.
    //
    // A `Uint8Array` is a shape `Writable.write` accepts and `Buffer.isBuffer`
    // refuses, so the first version of this stored `String(chunk)` and a write
    // of `new Uint8Array([0xc3, 0xa9])` reached a test as `"195,169"`. And an
    // **encoding** is the caller's: `write('c3a9', 'hex')` puts `é` on the
    // stream, so reading the string as it came is reading the wrong text. Both
    // found by review
    const encoding = typeof rest[0] === 'string' ? rest[0] : undefined;
    if (typeof chunk === 'string') {
      into.push(encoding === undefined ? chunk : Buffer.from(chunk, encoding as BufferEncoding));
    } else if (chunk instanceof Uint8Array) {
      into.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    } else {
      into.push(String(chunk));
    }

    // a caller that passed a callback is owed the call: `process.stdout` is a
    // stream, and swallowing its callback is how a writer that waits for drain
    // waits for ever
    const done = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    done?.();
    return true;
  };
}

/**
 * A copy of the schema whose hooks report the state and the error.
 *
 * Wrapping rather than replacing, which is the composition AGENTS.md documents
 * for a hook that is one function rather than a list: read what is there and
 * call it first. A `beforeError` that returns a replacement still replaces,
 * because its return value is passed straight back -- a helper that swallowed
 * that would change what the app under test does, which is the one thing a test
 * helper may never do.
 *
 * A **copy**, so that the caller's own schema object is never written to. That
 * matters more here than it looks: a schema is an ordinary object an app exports
 * once, so a helper that mutated it would leave the wrap behind for every later
 * run in the same process.
 *
 * `afterParse` is where the state is read because it fires after `processArgs()`
 * and `processOptions()` have written `state.argv` and before anything judges
 * it, which is the window that hook exists for. What is kept is the state
 * *object*, not a copy of its values, so a write made later -- by validation, by
 * the command itself -- is in what this reports.
 *
 * @param schema - The caller's schema.
 * @param report - Where to send what the hooks see.
 * @returns A schema to hand `main()`.
 */
function wrap(
  schema: Schema | undefined,
  report: { onError(err: unknown): void; onState(state: ParseState): void }
): Schema {
  const hooks = schema?.hooks;

  return {
    ...schema,
    hooks: {
      ...hooks,
      async afterParse(state: ParseState): Promise<void> {
        report.onState(state);
        await (hooks?.afterParse as ((s: ParseState) => Promise<void> | void) | undefined)?.(state);
      },
      async beforeError(err: unknown, state: ParseState | undefined): Promise<unknown> {
        // the state first, and the error reported whichever way the caller's
        // own hook goes. The framework logs and skips a hook that throws, so
        // one of theirs failing must not also cost this the error it was
        // called about -- the error is still the error, and a run reporting
        // `undefined` for it would say the run did not fail
        if (state) {
          report.onState(state);
        }
        try {
          const replaced = await hooks?.beforeError?.(err, state);
          // `=== undefined` rather than `??`, which is the predicate
          // `fireBeforeError()` uses -- `result !== undefined`. A hook that
          // returns `null` really does replace the error there, so a `??`
          // here reported the original while `main()` rendered the
          // replacement: one wrap disagreeing with the runtime about the
          // same return value. Found by review
          report.onError(replaced === undefined ? err : replaced);
          return replaced;
        } catch (thrown) {
          report.onError(err);
          throw thrown;
        }
      },
    },
  };
}

/**
 * The exit code a run left behind.
 *
 * `process.exitCode` is `undefined` until something sets it, and node exits zero
 * then -- so reporting `undefined` would make every passing run's code a value a
 * caller has to guard. A string is what node accepts and coerces, so it is read
 * the way node reads it rather than handed back as-is.
 *
 * @param code - What `main()` left on the process.
 * @returns The number a shell would see.
 */
function codeOf(code: typeof process.exitCode): number {
  // `null` as well as `undefined`, because that is what the type says a process
  // may hold and node exits zero for either
  if (code === undefined || code === null) {
    return 0;
  }
  const n = Number(code);
  return Number.isInteger(n) ? n : 0;
}
