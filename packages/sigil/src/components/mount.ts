/**
 * Mounting one of the built-in components, for the imperative API in front of
 * it.
 *
 * `createSpinner()` and `text()` are functions a build script calls, not trees an
 * app renders, and what they need from the renderer is the same four things
 * every time: a canvas at the bottom of the log, the framework's stylesheet, a
 * way to write a line above the frame, and two ways to finish -- one that leaves
 * the last frame in the log and one that erases it. This is those four things.
 *
 * **Whether anything may draw is settled here and handed to the component**,
 * because it changes what the component draws rather than only how it is drawn.
 * A spinner in a CI log has no frames to animate, so it draws none and starts no
 * timer; the backend then writes the frame once per change rather than once per
 * tick, which is the live region's rule reached through the canvas instead of
 * through a second code path.
 *
 * One answer rather than two: this used to hand the build a `live` boolean *and*
 * the motion preference, and every component that read them computed
 * `live && motion !== 'reduce'` -- two values folded back into one at four call
 * sites, which is two readers of one rule by the time the fourth disagrees. The
 * spinner did disagree: it read `live` alone, so `SIGIL_REDUCED_MOTION=1` on a
 * terminal left it spinning at eighty milliseconds a frame, which is the one
 * thing that variable exists to stop. `resolveOutput()` is the fold and
 * `OutputLevel` is the answer.
 *
 * **That is a breaking change to this function**, taken at `0.0.1` and written
 * down here because `mountLive()` is exported: a build callback was
 * `(live: boolean, motion: ReducedMotion) => Element` and is now
 * `(level: OutputLevel) => Element`. An app that had one reads `level === 'live'`
 * in place of `live && motion !== 'reduce'`, which is the expression every
 * built-in in here was computing. Left unmigrated in JavaScript it still
 * *appears* to work -- `'live'` is truthy and `motion` is `undefined`, so the
 * old expression is true -- which is why the migration is one sentence rather
 * than left to a type error somebody may not connect to this.
 */

import { ansi as defaultAnsi } from '../ansi/index.js';
import { type CanvasBackend, createSinkCanvas } from '../canvas/index.js';
import type { Element } from '../element/index.js';
import { render, type Renderer } from '../renderer/index.js';
import { type OutputLevel, resolveOutput } from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { type StyledOptions, themedCascade } from '../theme/index.js';

export interface MountOptions extends StyledOptions {
  /** Where frames go. Defaults to an inline canvas that follows its content. */
  backend?: CanvasBackend;
  /**
   * Milliseconds between frames. Defaults to the renderer's thirty a second.
   *
   * Worth naming for something that animates faster than that -- and worth
   * naming in a test, where a frame arriving a tick late is the difference
   * between asserting on what was drawn and asserting on when.
   */
  frameMs?: number;
  /** Where a throw from the component or an effect goes. */
  onError?: (error: unknown) => void;
  /**
   * Whether this is progress rather than the answer.
   *
   * The top of `resolveOutput()`'s chain, above the process-wide `--quiet`
   * request. `true` says draw nothing; **`false` says this is not progress at
   * all**, which is how a built-in opts out -- a prompt is a dialogue rather
   * than a progress report, and a silenced one waits forever for an answer to a
   * question nobody was shown.
   *
   * Left unset, the process-wide request decides, which is what makes `--quiet`
   * reach a spinner an app never wired up. A value that is not a boolean is
   * refused rather than read by truthiness, for the reason `resolveOutput()`
   * records: `'false'` is truthy.
   *
   * **A prompt overrides a `true` here**, and deliberately: `run()` writes
   * `quiet: false` after the caller's options for the reason the content box
   * writes `flex-direction` after them -- a silenced dialogue is a question
   * nobody was shown and an answer nobody can give, so it is not the caller's
   * to ask for. `focusable` goes before a caller's props precisely because
   * opting out there is harmless; this is the other half of that call. It
   * **discards** the value rather than reading it, so a prompt cannot refuse a
   * bad one either -- the refusal belongs to whoever asks the fold, and a prompt
   * never does.
   *
   * When that refusal lands differs by component, and that is the lazy mount
   * showing rather than a second rule: `createProgress()` mounts as it is built,
   * so it throws there, while a spinner, a typewriter and a decrypt mount on
   * their first frame or write and throw then.
   */
  quiet?: boolean;
  /** The terminal to draw through. Defaults to the process's. */
  terminal?: Terminal;
}

export interface Mounted {
  /** Where frames are going. */
  readonly backend: CanvasBackend;
  /** Leaves the last frame where it was drawn and gives the screen back. */
  done(): void;
  /** Paints a frame now, whatever the pacing says. */
  frame(): void;
  /**
   * Whether frames are repainted in place and animation is wanted.
   *
   * `resolveOutput()`'s answer read as a boolean: `false` for a pipe, for a
   * file, for a reduced-motion preference and for a quiet run. It is the
   * resolved answer rather than the raw terminal fact, because two values that
   * every reader folds back into one is what this mount stopped handing down.
   */
  readonly live: boolean;
  /** The renderer, for anything that wants the tree or the restyler. */
  readonly renderer: Renderer;
  /** Erases what was drawn and gives the screen back, leaving nothing behind. */
  stop(): void;
  /** Writes a line that stays, above the frame. */
  write(text: string): void;
}

/**
 * What a mount with these options would draw, without mounting anything.
 *
 * `mountLive()` calls this and so does every facade's `write()`, which is the
 * one place in a built-in that writes **without a mount**: there is no frame to
 * put a line above, so the three lazy components write through the terminal
 * directly -- and that was a second writer of the rule, measured, leaking
 * `"leaked\n"` out of `createSpinner({ quiet: true }).write()` and out of every
 * `write()` after a `succeed()`, which is the common one. So the question is
 * asked here, once, with the inputs gathered once: a caller that assembled them
 * itself would be the drift this axis exists to remove.
 *
 * @param opts - The terminal, and whether this is progress at all.
 * @returns How much of what it draws would reach the screen.
 */
export function mountLevel(opts: MountOptions = {}): OutputLevel {
  const terminal = opts.terminal ?? defaultTerminal;
  return resolveOutput({
    live: terminal.isTTY && !terminal.closed,
    quiet: opts.quiet,
    reducedMotion: opts.reducedMotion,
  });
}

/**
 * Mounts a built-in component over an inline canvas.
 *
 * @param build - Builds the tree. Handed how much of what it draws reaches the
 *   screen, because that is a question about what to draw rather than about how
 *   it is drawn.
 * @param opts - The terminal, the theme, the colour level, and whether this is
 *   progress at all.
 * @returns The handle.
 */
export function mountLive(
  build: (level: OutputLevel) => Element,
  opts: MountOptions = {}
): Mounted {
  const terminal = opts.terminal ?? defaultTerminal;
  /**
   * The one fold, read once, and handed to the component.
   *
   * Resolved before `render()` rather than inside the build for the reason the
   * build needs it at all: whether anything may draw decides which **backend**
   * this mount gets. Which also makes it one answer in one place rather than the
   * pair this used to hand down.
   *
   * **Once is the whole of it, and that cuts one way.** A mount is a decision
   * about what to build and what to build it over, so a component built under
   * quiet holds the sink for its life: the `mountLevel()` the three lazy facades
   * and the bar ask on each `write()` can only ever *suppress*, never start
   * drawing again. Measured -- a bar built under a request and then handed a
   * `setQuiet(undefined)` goes on writing nothing. Which is right for the
   * lifecycle an app has, one `main()` and one request with every component
   * built inside `run()`; what reaches it is a caller lifting the request
   * mid-run, which is a test's teardown or a demo. Re-resolving per frame would
   * mean swapping a backend out from under the renderer, and nothing has asked.
   */
  const level = mountLevel({ ...opts, terminal });
  const live = level === 'live';
  const cascade = themedCascade(opts);

  const renderer = render(() => build(level), {
    // the sink wins over a backend the caller named, because quiet is about
    // whether anything draws at all rather than about where it draws -- and a
    // built-in that really is the answer says so with `quiet: false`, which is
    // the one statement above the request
    backend: level === 'quiet' ? createSinkCanvas({ terminal }) : opts.backend,
    cascade,
    colorLevel: opts.colorLevel ?? (opts.ansi ?? defaultAnsi).level,
    // passed on as well as into the cascade, because `readMedia()` rebuilds the
    // whole media context and would otherwise drop it: `themedCascade()` sets the
    // scheme and the renderer then overwrites it on the first frame. Found by
    // reading the two together rather than by a failing test, which is why one
    // exists now
    colorScheme: opts.colorScheme,
    frameMs: opts.frameMs,
    // passed on for the same reason the scheme is, and the renderer adds the
    // terminal under it: a pipe collapses an animation to its end state without
    // anybody asking, which is what `live` has always meant for a spinner
    reducedMotion: opts.reducedMotion,
    onError: opts.onError,
    terminal,
    // as wide as what is drawn: these frames end up in a log, and a canvas the
    // width of the screen would leave every one of them padded out to the
    // margin with spaces nobody can see and everybody copies
    width: 'auto',
  });

  return {
    get backend() {
      return renderer.backend;
    },

    done(): void {
      renderer.dispose();
    },

    frame(): void {
      renderer.frame();
    },

    live,

    renderer,

    stop(): void {
      // the erase has to happen before the renderer lets go: finishing the
      // region is what hands the rows back, and afterwards there is no anchor
      // for an erase to be relative to. The renderer's own teardown records the
      // same ordering from the other side
      renderer.backend.stop();
      renderer.dispose();
    },

    write(text: string): void {
      renderer.backend.write(text);
    },
  };
}
