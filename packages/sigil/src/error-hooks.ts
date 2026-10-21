import debug from './debug/index.js';
import { collectHooks } from './hook-sources.js';
import { ErrorState, type ParseState, type Schema } from './types.js';
import { safeLog } from './util/safe-log.js';

const { log } = debug('sigil:error');

/**
 * Stashes the in-flight parse state on an error on its way out, so the error
 * path can still reach the matched command -- and with it the usage line worth
 * printing. Invisible to anything inspecting the error; see `ErrorState`.
 *
 * @param err - The thrown value.
 * @param state - The state that was in flight, if there was one.
 */
export function attachState(err: unknown, state: ParseState | undefined): void {
  if (!state || err === null || (typeof err !== 'object' && typeof err !== 'function')) {
    return;
  }

  try {
    Object.defineProperty(err, ErrorState, {
      configurable: true,
      enumerable: false,
      value: state,
      writable: true,
    });
  } catch {
    // a frozen error keeps its own counsel
  }
}

/**
 * Recovers the parse state `parse()` stashed on an error it threw.
 *
 * @param err - The thrown value.
 * @returns The state that was in flight, if there was one.
 */
export function stateFromError(err: unknown): ParseState | undefined {
  try {
    return (err as { [ErrorState]?: ParseState } | null | undefined)?.[ErrorState];
  } catch {
    return undefined;
  }
}

/**
 * Fires the `beforeError` hooks for an error on its way out.
 *
 * A hook may observe the error, mutate it, or return a replacement -- it may
 * never suppress it. Returning `undefined` (which is what a hook that only
 * looks returns) keeps the current error; returning anything else makes that
 * value the error from there on, including for the hooks that follow. A hook
 * that throws is logged and skipped: the error already in flight is the one
 * the user needs, and a broken hook must not take its place.
 *
 * @param err - The thrown value.
 * @param state - The parse state, when parsing got far enough to produce one.
 * @param schema - The schema, for errors thrown before there was a state.
 * @returns The error to report, which is `err` unless a hook replaced it.
 */
export async function fireBeforeError(
  err: unknown,
  state: ParseState | undefined,
  schema?: Schema
): Promise<unknown> {
  let current = err;

  for (const hook of collectHooks('beforeError', state, schema)) {
    let result: unknown;

    try {
      result = await hook(current, state);
    } catch (hookErr) {
      // `DEBUG=sigil:error` is where a broken hook confesses
      safeLog(log, hookErr);
      continue;
    }

    if (result !== undefined && result !== current) {
      current = result;
      // the replacement has to carry the state too, otherwise swapping the
      // error out costs the renderer its usage line
      attachState(current, state);
    }
  }

  return current;
}
