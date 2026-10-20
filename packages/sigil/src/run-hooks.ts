import debug from './debug/index.js';
import { collectHooks } from './hook-sources.js';
import {
  type AfterRunHookData,
  type InternalCommand,
  type ParseState,
  type RunOutcome,
} from './types.js';
import { safeLog } from './util/safe-log.js';

const { log } = debug('sigil:run');

/**
 * Fires the `afterRun` hooks for a command whose `run()` has finished, however
 * it finished.
 *
 * This runs from what is effectively a `finally`, with an error very possibly
 * already in flight, so **it does not throw** -- and not by being careful:
 * every hook is called inside its own `try`, so the loop cannot be left part
 * way through, and there is no statement after the loop that can fail. If it
 * did throw, the thrown value would reach `main()`'s own `catch` and the
 * `beforeError` hooks would fire on a broken cleanup rather than on the error
 * the user needed.
 *
 * A hook's own failure is reported under `DEBUG=sigil:run` and the next hook
 * still runs, which is `disposeOwner()`'s rule: every cleanup runs even when
 * one throws, and what it threw is reported rather than replacing the outcome
 * in flight.
 *
 * Whatever a hook hands back is ignored, which is the `catch`-as-recovery
 * refusal written into the type as well. See `AfterRunHook`.
 *
 * `cmd` is a parameter rather than read off `state.cmd`, which is the same
 * command: that field is `InternalCommand | undefined`, and the one caller has
 * already narrowed it by asking for a `run` to call. So the narrowing is the
 * argument rather than a guard here that nothing could reach.
 *
 * @param cmd - The command that ran.
 * @param outcome - What its `run()` came to.
 * @param ms - How long it took.
 * @param state - The parse state it was handed.
 */
export async function fireAfterRun(
  cmd: InternalCommand,
  outcome: RunOutcome,
  ms: number,
  state: ParseState
): Promise<void> {
  // frozen, and that is the `catch`-as-recovery refusal holding at run time
  // rather than only in the type. `readonly` is a TypeScript fiction once the
  // code is running, and `main()` reads the **same** outcome object after this
  // returns -- so a hook writing `outcome.ok = false` really did turn a
  // successful run into a thrown `undefined`, which is the recovery door the
  // type was written to close, open in the other direction. Measured before it
  // was closed.
  //
  // **What is frozen is exactly what this module is the author of**, and saying
  // that precisely took a review round, because the first version of this
  // comment claimed more. Refused: flipping `ok`, swapping `value` or `error`
  // for something else, and rewriting `ms` -- which is a hook misleading the
  // hooks after it in the same chain, so `data` is frozen as well as `outcome`.
  //
  // **Not refused, and it must not be**: the insides of objects the *app* owns.
  // `outcome.value` is the object the command returned, which the command can
  // reach and mutate after returning -- measured -- and `outcome.error` is the
  // error, which `beforeError` is documented as entitled to mutate: measured,
  // a `beforeError` hook writing `err.message` and `err.exitCode` has exactly
  // the effect an `afterRun` hook writing them has, so this opens no channel
  // that was closed. Deep-freezing either would freeze somebody else's object
  // on the way past, take away that documented right, and seal a `Date` or a
  // class instance a command handed back. `state` is mutable for the same
  // reason, which is its own: a `run()` writes to it and so may a hook.
  //
  // So a hook can still **install a `beforeError`** and reach the rendered
  // error through it. That is not a way round the refusal either, and it was
  // worth measuring rather than asserting: `beforeError` may replace an error
  // and may never suppress it, so what an `afterRun` reaches that way is
  // precisely what declaring a `beforeError` reaches. Snapshotting that set
  // before this fires was the suggested fix and is refused -- a hook installed
  // by a `parse` hook or by a `run()` fires, so making this the one place where
  // installing one does not work would be a special case nobody asked for.
  //
  // The freeze **refuses** a write either way; it only **confesses** one from
  // strict-mode code. An ES module is always strict, so a hook in one is told;
  // a hook out of `new Function` or a sloppy `.cjs` body has the write dropped
  // in silence, and finds out nothing. Which is the host's rule rather than
  // this module's, and is the honest limit of "a hook that tried to rewrite
  // what happened finds out"
  const data: AfterRunHookData = Object.freeze({
    cmd,
    ms,
    outcome: Object.freeze(outcome),
    state,
  });

  // no second argument: that one is the schema for an error thrown before there
  // was a state, which cannot happen here -- and reading `state.schema` at the
  // call site would be the one read outside `collectHooks()`'s own guard
  for (const hook of collectHooks('afterRun', state)) {
    try {
      await hook(data);
    } catch (hookErr) {
      // `DEBUG=sigil:run` is where a broken cleanup confesses
      safeLog(log, hookErr);
    }
  }
}
