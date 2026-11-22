/**
 * An error that is about what the person at the keyboard typed.
 *
 * A leaf module with no imports, so the parser, the error handler and the
 * published entry can all ask it without a cycle. `@ttylabs/sigil` and
 * `@ttylabs/sigil/error-handler` publish it.
 */

/**
 * Which kind of usage error it is. Stable, and not translated: a message is
 * rendered in the reader's locale, and a script or a `beforeError` hook
 * branches on this instead.
 *
 * - `unknown-option`: an option nothing declared, with `allowUnknownOptions: false`.
 * - `unknown-command`: a command name that did not resolve, as in `help buidl`.
 * - `unexpected-argument`: a positional with nothing to take it.
 * - `extra-arguments`: what follows `--`, where that is not allowed.
 * - `missing-value`: an option that takes a value, given none.
 * - `missing-argument`: a required argument that was not given.
 * - `missing-option`: a required option that was not given.
 * - `invalid-value`: a value its data type rejects, or one outside `choices`.
 * - `unsupported-format`: an output format the command does not present.
 */
export type UsageErrorCode =
  | 'extra-arguments'
  | 'invalid-value'
  | 'missing-argument'
  | 'missing-option'
  | 'missing-value'
  | 'unexpected-argument'
  | 'unknown-command'
  | 'unknown-option'
  | 'unsupported-format';

/**
 * The exit code a usage error asks for: `2`, the one `sysexits`-minded tools and
 * Commander settle on for "you ran me wrong", leaving `1` for "I broke".
 */
export const USAGE_EXIT_CODE = 2;

/**
 * What the user typed was not something the app can run.
 *
 * Thrown by the parser for every problem with argv, and by an app's own
 * `transform` or `run()` that wants the same treatment: the message alone is
 * rendered, with no stack, and the process exits `2`. Anything that is _not_ a
 * `UsageError` -- a `TypeError` out of `run()`, an invalid schema -- is a defect
 * in the program rather than in how it was invoked, and is reported as one.
 *
 * `exitCode` is an ordinary property, so a hook can change what one exits with.
 */
export class UsageError extends Error {
  /** Which kind of usage error this is. */
  readonly code: UsageErrorCode;
  /** The exit code the error handler sets. `2` unless changed. */
  exitCode: number = USAGE_EXIT_CODE;

  /**
   * @param message - What to tell the user, already translated.
   * @param code - Which kind of usage error it is.
   * @param options - A `cause`, when the error wraps another.
   */
  constructor(message: string, code: UsageErrorCode, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UsageError';
    this.code = code;
  }
}

/**
 * Wraps what a coercion or a `choices` check threw as a usage error.
 *
 * Those functions are shared with config files and the prompts, where a bad
 * value is not an invocation error, so they throw plain errors and the parser
 * -- which knows the value came from argv or the environment -- is what says
 * otherwise. A `UsageError` already is one and is passed through.
 *
 * @param err - What was thrown.
 * @param code - The kind to give it.
 * @returns The error to throw instead.
 */
export function asUsageError(err: unknown, code: UsageErrorCode): unknown {
  if (err instanceof UsageError || !(err instanceof Error)) {
    return err;
  }

  return new UsageError(err.message, code, { cause: err });
}
