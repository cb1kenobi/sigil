/**
 * Whether anything may draw, and whether it may move.
 *
 * Half of what a `--json` flag is for has nothing to do with JSON: it is
 * suppressing everything else. A script wants the data on stdout and no
 * spinner, no bar, no progress line, no note -- and that is worth having on its
 * own, whether or not a format was asked for.
 *
 * ## It is the motion axis with a third state, not a second mechanism
 *
 * `prefers-reduced-motion` is this shape one axis along, and the discipline is
 * the one `mountLive()` already records: one place folds the sources and every
 * built-in reads the answer, because "a component asking those sources for
 * itself would be a second reader of one rule". Quiet is one more source folded
 * into the same fold.
 *
 * What differs is the *answer*. Reduced motion means an animation that has
 * **already finished** -- the spinner draws its final frame, the bar prints its
 * percentage, the typewriter prints the whole string, which is exactly what a
 * CI log wants. Quiet has to mean **nothing at all**. That is a different answer
 * from the same components, so it is a third value rather than a stronger
 * setting, and the three are ordered by how much reaches the screen:
 *
 * - `live` -- a screen that can be repainted, and animation is wanted.
 * - `reduce` -- may draw, may not move. A pipe, a CI log, a forced preference.
 * - `quiet` -- may not draw at all.
 *
 * ## A result is not a progress report
 *
 * The line quiet is drawn along is between what a command **says** and what it
 * says **while working**. `sigil check`'s diagnostics are the answer to the
 * question it was asked, and a quiet mode that swallowed them would make the
 * command useless; its summary line is a report about work done, and that is
 * what quiet is for. So an error survives quiet, `--help` survives quiet, a
 * `table()` survives quiet, and a prompt survives quiet -- a dialogue is not
 * progress, and silencing one would hang the program waiting for an answer to a
 * question nobody was shown.
 *
 * **It is `mountLive()`'s rule and never `render()`'s**, which is where the line
 * falls on the drawing side. `mountLive()` is exactly the set of things that
 * draw *beside* an answer -- the spinner, the bar, the typewriter, the decrypt
 * -- and `render()` is an app drawing its own tree, which is the answer: a
 * full-screen app **is** the program, and blanking one because a script wanted
 * the data on stdout would be absurd. So a `ScrollBox` reads nothing here and is
 * not an omission: it is a view of content, so it is on `table()`'s side of the
 * line. The scroll box is named because the ticket named it and a reader has to
 * be able to tell a decision from a gap -- and so is the escape hatch, because
 * `RenderOptions` has no `quiet` and saying "pass it to the mount" would be
 * offering a spelling the idiomatic scroll-box app does not have: it hands a
 * tree to `render()`. An app that wants a quiet view of its own gives `render()`
 * a `createSinkCanvas()` backend, or does not build the tree. The same reading
 * puts `table()`, `largeText()` and `qrcode()` on the result side by their own
 * shape -- each returns a string and the caller does the writing, so quiet is
 * the caller's statement about its own `write()` -- and `enableDebugOverlay()`
 * with them: it is diagnostics about the program, which survive the way an error
 * does.
 *
 * ## There is no environment variable, and that is a decision
 *
 * `SIGIL_COLOR_SCHEME` and `SIGIL_REDUCED_MOTION` are each the user's override
 * of a **detection** -- the framework guessed, and the variable corrects the
 * guess. Quiet is not guessed: it is asked for, and the place to ask is argv,
 * which every sigil app offers for free through `--quiet`. A variable would be a
 * second spelling of one request.
 *
 * And it would break the declaration-respecting rule from behind. An app whose
 * `--quiet` means something of its own keeps it and gets no flag from the
 * framework, which makes that app responsible for what quiet means -- and a
 * variable would silence its built-ins anyway, without going through the
 * declaration it owns. `requestQuiet()` is the programmatic door for a caller
 * who wants one, and `MountOptions.quiet` is the per-component one.
 *
 * ```js
 * import { requestQuiet, resolveOutput } from '@ttylabs/sigil/style';
 *
 * requestQuiet(true);
 * resolveOutput({ live: true }); // 'quiet'
 * ```
 */

import { resolveMotion } from './motion.js';
import type { ReducedMotion } from './motion.js';

/** How much of what a built-in draws reaches the screen. */
export type OutputLevel = 'live' | 'quiet' | 'reduce';

/**
 * Whether this process was asked to be quiet, or `undefined` where nobody said.
 *
 * Process-wide because the two ends have no other connection: `--quiet` is read
 * while argv is parsed, and a spinner is built later inside a command's `run()`,
 * which is handed a `ParseState` it cannot pass on to every component it
 * touches. An app wiring the flag through by hand at every call site is the
 * per-caller judgement this axis exists to replace -- and a `--quiet` that
 * reached a component which ignored it would be a flag that parses and does
 * nothing, which this repository calls worse than no flag at all.
 */
let requested: boolean | undefined;

/**
 * How many times `requestQuiet()` has been called.
 *
 * The only thing that can tell "nobody has written since" from "somebody wrote
 * the same value", which is what a restore has to ask. See `quietGeneration()`.
 */
let wrote = 0;

/**
 * Records that this process was asked to be quiet, or that it was not.
 *
 * `main()` is what calls this, once, with what the parse found -- rather than
 * `parse()`, which is a parser and owes its caller no process-wide side effect.
 * `main()` already owns `process.exitCode` and the error handler, so one more
 * fact about the process is in character there.
 *
 * `undefined` puts it back to nobody having said, which is what a test wants on
 * the way out: the flag is process-wide, so a run that set it would otherwise
 * decide the answer for every test after it in the same worker.
 *
 * A statement made **inside** a `main()` outlives that run, and deliberately:
 * this is a statement about the process, so `main()` puts back only what it
 * attached and only where nobody has written since -- which is what the
 * generation below is for. The consequence worth knowing is that a nested run
 * can countermand the outer one's flag for the rest of it, because there is one
 * slot and the inner statement is the more recent. One process, one intent.
 *
 * @param on - Whether to be quiet, or `undefined` for nobody having said.
 */
export function requestQuiet(on: boolean | undefined): void {
  requested = asked(on, 'requestQuiet');
  wrote += 1;
}

/**
 * How many times anybody has recorded a request.
 *
 * What `main()` needs in order to put back what it attached without reversing
 * somebody else's statement, and a **counter** rather than the value, because a
 * boolean has no identity: `captureConsole()` can compare the function it
 * installed, where comparing `true` to `true` cannot tell "nobody wrote since"
 * from "a command asked for the same thing" -- and reversing a command's own
 * `requestQuiet(true)` is what that cost. This is the same answer
 * `unanchor()` gives a cursor reply that arrived about an anchor that has since
 * moved: bump a generation, and an answer that does not match it is stale.
 *
 * Not in the `style` barrel: `main()` is the only reader and a counter is
 * nobody's business outside the package. A statement made *inside* a run
 * outlives it, which is what makes it a statement about the process.
 *
 * @returns The generation, which moves on every write.
 */
export function quietGeneration(): number {
  return wrote;
}

/**
 * The one reading of a quiet statement, which is strict rather than truthy.
 *
 * Truthiness is wrong here in the direction that costs: `'false'` and
 * `new Boolean(false)` -- the classic untyped-JS values -- are both truthy, so
 * `requestQuiet('false')` silenced the whole process and
 * `createSpinner({ quiet: 'false' })` silenced the spinner, each measured. A
 * number is the accident the other way. Neither is a value anybody meant, and
 * there is no third answer to fall back to the way a bad interval falls back to
 * a default -- so it is refused where it was written, which is the call a
 * non-boolean `hidden` already gets.
 *
 * It is about the two **values** that decide whether something draws, and
 * deliberately not about `schema.quiet`, which decides whether the *flag
 * exists* and keeps `schema.help`'s and `schema.completion`'s `=== false`
 * posture: a garbage value there offers a flag nobody wanted, where a garbage
 * value here loses output somebody did. Two precedents point opposite ways --
 * `hidden` throws and `help` does not -- and the three free flags agreeing with
 * each other is worth more than this one being the strictest. Validating all
 * three is a change to the other two, which is not a thing to take inside a
 * ticket about this one.
 *
 * @param value - What a caller said.
 * @param where - What to name in the message.
 * @returns The statement, or `undefined` where nobody made one.
 */
function asked(value: unknown, where: string): boolean | undefined {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new TypeError(`Expected ${where} to be a boolean`);
  }
  return value;
}

/**
 * What `requestQuiet()` last recorded.
 *
 * @returns Whether quiet was asked for, or `undefined` where nobody said.
 */
export function quietRequested(): boolean | undefined {
  return requested;
}

/**
 * The level, from the most specific source that has an answer.
 *
 * The one fold, and the order is "more specific knowledge about the same
 * question" the way the scheme's and the motion preference's are:
 *
 * 1. `quiet` -- this mount's own statement. `false` is how a built-in says it is
 *    not progress at all, which is what a prompt does: it is a dialogue, and a
 *    silenced one waits forever for an answer to a question nobody was shown.
 * 2. The process-wide request, which is `--quiet`.
 * 3. The motion preference, which is its own three-source fold.
 * 4. Whether there is a screen.
 *
 * The screen is a **ceiling** rather than one more opinion, which is why the
 * last two are an `||` rather than a chain: `live` means frames get repainted in
 * place, and a pipe has nowhere to repaint -- so nothing can ask for animation
 * into one. That is the same asymmetry `refineColorLevel()` is written down for,
 * where a reply may raise a level and never lower it off the floor a pipe
 * produced, and it is what keeps a forced `reducedMotion: 'no-preference'` from
 * writing a line per reveal step into a log file.
 *
 * @param input - This mount's own statement, the app's motion preference,
 *   whether there is a screen, and the environment to read overrides from.
 * @returns What may be drawn.
 */
export function resolveOutput(input: {
  env?: Record<string, string | undefined>;
  /** Whether there is a terminal to draw on: `isTTY && !closed`. */
  live: boolean;
  /** Whether this is progress at all. `false` opts a built-in out of quiet. */
  quiet?: boolean;
  reducedMotion?: ReducedMotion;
}): OutputLevel {
  // truthiness, and safely: `asked()` is what refuses everything that is not a
  // boolean, so what reaches this is `true`, `false` or nothing. A `=== true`
  // beside it was written and deleted again for being unable to change an
  // answer, which is the call this repository makes on a guard that cannot
  if (asked(input.quiet, 'quiet') ?? requested) {
    return 'quiet';
  }

  return resolveMotion(input) === 'reduce' || !input.live ? 'reduce' : 'live';
}
