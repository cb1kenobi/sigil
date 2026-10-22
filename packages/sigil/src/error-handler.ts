import debug from './debug/index.js';
import { assertSerialized, formatFor, type SerializedError } from './format.js';
import { __ } from './i18n/index.js';
import type { ErrorContext, ErrorHandlerOptions } from './types.js';
import { safeLog as safeLogTo } from './util/safe-log.js';

export type { ErrorContext, ErrorHandler, ErrorHandlerOptions, ErrorRenderer } from './types.js';

const { log } = debug('sigil:error');

/**
 * The exit code used when the error does not name one of its own.
 */
const defaultExitCode = 1;

/**
 * What is rendered when the thrown value has nothing to say for itself.
 */
const fallbackMessage = 'Unknown error';

/**
 * Logs a value without letting the logger throw from inside the error path.
 *
 * @param value - The value to log.
 */
function safeLog(value: unknown): void {
  safeLogTo(log, value);
}

/**
 * Reads a string property without letting a throwing getter escape.
 *
 * @param obj - The object to read from.
 * @param key - The property to read.
 * @returns The value, when it is a non-empty string.
 */
function readString(obj: object, key: 'message' | 'name'): string | undefined {
  try {
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === 'string' && value ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Coerces anything to a string without throwing. A null-prototype object has
 * no `toString`, and a `toString` of someone else's making can throw.
 *
 * @param value - The value to coerce.
 * @returns The coerced string, or the fallback message.
 */
function stringify(value: unknown): string {
  try {
    return String(value) || fallbackMessage;
  } catch {
    return fallbackMessage;
  }
}

/**
 * Extracts a user-facing message from anything that can be thrown.
 *
 * Parser errors are plain `Error`s whose messages are written for the person
 * running the CLI, so the message is all that is wanted. Everything else --
 * a thrown string, a plain object, `null` -- still has to render as something
 * rather than crash the error path.
 *
 * @param err - The thrown value.
 * @returns A single-line-ish message, never empty.
 */
function errorMessage(err: unknown): string {
  if (typeof err === 'string') {
    return err || fallbackMessage;
  }

  if (err === null || err === undefined) {
    return fallbackMessage;
  }

  if (typeof err === 'object') {
    // `message` first, then `name` for an error thrown with neither a
    // message nor a subclass of its own
    return readString(err, 'message') ?? readString(err, 'name') ?? stringify(err);
  }

  return stringify(err);
}

/**
 * The message, and nothing else.
 *
 * The form every error takes when no output format was selected, and the one
 * the format-aware renderer falls back to -- which is why it is its own
 * function rather than a branch inside `renderError()`: a fallback that could
 * re-enter the thing it is a fallback for is not one.
 *
 * @param err - The thrown value.
 * @returns The text to write to stderr.
 */
function errorLine(err: unknown): string {
  return __`Error: ${errorMessage(err)}`;
}

/**
 * What a serialized error says about itself.
 *
 * Built from the same `errorMessage()` the human form prints, so the two
 * cannot come to disagree about what the error said. `name` is included
 * whenever the thrown value has one, which is uniform for every `Error` there
 * is and absent for a thrown string -- and it is the half a script can branch
 * on, because **a message is translated and a name is not**.
 *
 * @param err - The thrown value.
 * @returns The payload.
 */
function errorPayload(err: unknown): SerializedError {
  const name = err !== null && typeof err === 'object' ? readString(err, 'name') : undefined;

  return { error: name ? { message: errorMessage(err), name } : { message: errorMessage(err) } };
}

/**
 * The default error renderer: the message, or the error serialized in the
 * format argv selected.
 *
 * No stack trace -- the messages the parser throws are the user-facing text.
 * The whole error, stack and all, is logged through the debug logger, so
 * `DEBUG=sigil:error` brings it back when a stack is actually wanted.
 *
 * ## The third form through the seam that already had two
 *
 * `report.ts` in the toolchain keeps a two-forms discipline -- a laid-out form
 * for a terminal and one line per record for a pipe -- and a serialized error
 * is a third form through the same seam rather than a new mechanism. The reason
 * it has to exist at all is the one the whole feature rests on: a script that
 * gets JSON on success and a rendered message on failure cannot be scripted
 * against, so the two forms of a run's answer have to come out of one
 * selection. The exit code still carries the verdict.
 *
 * It reads the format off the state, which is what makes it work for a parse
 * error too: `--json` on a command that was not given a required option is a
 * failure the user asked to receive as JSON, and `Missing required options:
 * --port` comes out as a payload.
 *
 * ## Where the seam is, measured rather than described
 *
 * `detectFormat()` runs after argv has been **walked** and before it is
 * **judged**, which is the window `afterParse` is documented for -- so which
 * side of the seam a parse error falls on is which of those two it came out of,
 * and it is not the side the first version of this comment claimed. Measured on
 * the one it named: `--port eight` on an `int` is `Invalid integer: eight` as a
 * **plain line**, in either token order, because a value its type rejects
 * throws while argv is being read and nothing had yet said which format.
 * `Missing required options` and `Unexpected argument "extra"` are both
 * payloads, because those are judgements.
 *
 * Which is the same boundary the help rule already draws in the same place:
 * help wins over a *missing* required option, and an invalid value "failed on
 * the way in, while argv was being read, and there was never a question to
 * answer". Moving `detectFormat()` earlier would not close it -- the throw is
 * inside the pass that reads the option, so there is no earlier point that has
 * both the token and a settled chain. Recorded rather than guarded, because
 * what it costs is a plain line where a script wanted a payload and the
 * **exit code still carries the verdict**, which is the half a script keys on.
 *
 * A serializer that throws on the payload falls back to the message rather
 * than replacing the error with its own: a broken serializer must not cost the
 * reader the error they actually needed. That fallback is this function's own
 * rather than `errorHandler()`'s, and the reason is reachability: this is
 * exported for a caller to wrap, so `decorate(renderError(err, ctx))` has to
 * get text rather than a throw -- and `errorHandler()`'s catch falls back to
 * *this* function, so without one here a broken serializer would throw twice
 * and escape the error path entirely.
 *
 * This is also the extension point for richer rendering: pass a replacement as
 * `ErrorHandlerOptions.render` (or wrap this one) to add a usage line and
 * color. The renderer is handed the `ParseState` on `ctx`, when parsing got far
 * enough to produce one, which is where the matched command -- and therefore
 * the usage line to print -- comes from.
 *
 * @param err - The thrown value.
 * @param ctx - What the error path knows, which is where the selected format
 * comes from. Absent, or carrying no format, gives the message.
 * @returns The text to write to stderr.
 */
export function renderError(err: unknown, ctx?: ErrorContext): string {
  const state = ctx?.state;
  const name = state?.format;

  if (name === undefined) {
    return errorLine(err);
  }

  try {
    return assertSerialized(formatFor(state!.schema, name)(errorPayload(err)), name);
  } catch (formatErr) {
    safeLog(formatErr);
    return errorLine(err);
  }
}

/**
 * Resolves the process exit code an error asks for.
 *
 * An `exitCode` property is honored when it is an integer in the range a
 * process exit code can actually carry. An explicit `0` is honored too: that
 * is how a future `--help` short-circuit exits cleanly. Anything else -- a
 * string, a float, out of range, a getter that throws -- falls back.
 *
 * @param err - The thrown value.
 * @param fallback - The code to use when the error does not name a valid one.
 * @returns The exit code to set.
 */
export function errorExitCode(err: unknown, fallback: number = defaultExitCode): number {
  let code: unknown;

  try {
    code = (err as { exitCode?: unknown } | null | undefined)?.exitCode;
  } catch {
    return fallback;
  }

  return typeof code === 'number' && Number.isInteger(code) && code >= 0 && code <= 255
    ? code
    : fallback;
}

/**
 * Renders an error for the person running the CLI and sets the process exit
 * code. This is the single place `main()` turns a thrown value into output.
 *
 * It never calls `process.exit()` -- it sets `process.exitCode` so buffered
 * stdout still flushes.
 *
 * @param err - The thrown value.
 * @param opts - Rendering options: the `render` extension point, the
 * `ParseState` to hand it, and the stream to write to.
 */
export function errorHandler(err: unknown, opts: ErrorHandlerOptions = {}): void {
  const render = opts.render ?? renderError;
  const stderr = opts.stderr ?? process.stderr;
  const ctx: ErrorContext = { state: opts.state };

  // the full error, stack and all, is one `DEBUG=sigil:error` away
  safeLog(err);

  let text: string;
  try {
    text = String(render(err, ctx));
  } catch (renderErr) {
    // a renderer that throws must not replace the error it was given.
    // `renderError` cannot throw, so this fallback always produces text.
    safeLog(renderErr);
    // our own renderer, format-aware, which cannot loop: what threw was the
    // *caller's* `render`, and this one has a fallback of its own. Falling back
    // to the plain line instead was tried and is the worse answer -- it would
    // silently drop the format the reader asked for in the one case where the
    // app's own renderer is the thing that is broken. A sabotage pass is what
    // separated the two, because with `renderError()`'s own catch in place
    // either spelling produces the same text and the two guards were covering
    // for each other
    text = renderError(err, ctx);
  }

  // a stream that is already gone -- a destroyed socket, a closed pipe --
  // must not turn rendering an error into a second, worse error. This only
  // covers a throwing `write`; an asynchronous EPIPE arrives as an `error`
  // event on the stream, which is the terminal wrapper's job once there is
  // one again.
  try {
    stderr.write(`${text.replace(/[\r\n]+$/, '')}\n`);
  } catch (writeErr) {
    safeLog(writeErr);
  }

  process.exitCode = errorExitCode(err);
}
