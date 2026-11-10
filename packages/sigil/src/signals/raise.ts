/**
 * Two refusals the reactive layer and everything built on it make the same way.
 *
 * A module of its own, importing nothing, because one reader sits on a graph
 * that has no signals in it: `element/focus.ts` is imported by the element tree,
 * and reaching this through `graph.ts` would put the whole signals graph behind
 * `@ttylabs/sigil/element` for six lines. Internal: neither is re-exported from
 * `index.ts`.
 */

/**
 * Rethrows what a walk collected, having finished the walk first: nothing for
 * none, one error as itself, more as an `AggregateError`.
 *
 * One callback must not take the rest of a graph mutation, a focus drain or a
 * teardown with it -- a sink left unmarked keeps serving a value from before the
 * write, and a cleanup skipped is a subscription nobody can reach to cancel --
 * so the errors are gathered and raised once the structure is consistent again.
 *
 * @param errors - What was caught along the way.
 * @param message - What to call the aggregate, when there is more than one.
 */
export function raise(errors: readonly unknown[], message: string): void {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}

/**
 * Refuses what an `async` effect body returned.
 *
 * A promise stored as the cleanup means the *next* run calls it and fails with
 * "previous is not a function" -- one run later than the mistake and nowhere
 * near it. An effect cannot be async anyway: tracking stops at the first
 * `await`, because by then the body has returned and something else is
 * evaluating. Anything else that is not a cleanup is ignored by the caller, so
 * this asks about a thenable and nothing more.
 *
 * @param returned - What the effect body returned.
 */
export function refuseAsync(returned: unknown): void {
  if (
    returned !== null &&
    typeof returned === 'object' &&
    typeof (returned as { then?: unknown }).then === 'function'
  ) {
    throw new TypeError(
      'An effect may not be async: tracking stops at the first await, so nothing read after it is a dependency'
    );
  }
}
