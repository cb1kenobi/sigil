import debug from './debug/index.js';
import type { ErrorContext, ErrorHandlerOptions } from './types.js';
import { safeLog as safeLogTo } from './util/safe-log.js';

export type { ErrorContext, ErrorHandler, ErrorHandlerOptions, ErrorRenderer } from './types.js';

const { log } = debug('main2:error');

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
 * The default error renderer: the message, and nothing else.
 *
 * No stack trace -- the messages the parser throws are the user-facing text.
 * The whole error, stack and all, is logged through the debug logger, so
 * `DEBUG=main2:error` brings it back when a stack is actually wanted.
 *
 * This is the extension point for the Phase 3 help and ANSI work: pass a
 * replacement as `ErrorHandlerOptions.render` (or wrap this one) to add the
 * relevant usage line and color. The renderer is handed the `ParseState` on
 * `ctx`, when parsing got far enough to produce one, which is where the
 * matched command -- and therefore the usage line to print -- comes from.
 *
 * @param err - The thrown value.
 * @returns The text to write to stderr.
 */
export function renderError(err: unknown): string {
	return `Error: ${errorMessage(err)}`;
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
 * code. This is the single place `main2()` turns a thrown value into output.
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

	// the full error, stack and all, is one `DEBUG=main2:error` away
	safeLog(err);

	let text: string;
	try {
		text = String(render(err, ctx));
	} catch (renderErr) {
		// a renderer that throws must not replace the error it was given.
		// `renderError` cannot throw, so this fallback always produces text.
		safeLog(renderErr);
		text = renderError(err);
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
