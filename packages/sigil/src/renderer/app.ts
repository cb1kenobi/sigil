/**
 * An app: one call from a component to a running full-screen program.
 *
 * `render()` mounts a tree and nothing else, on purpose -- which backend, which
 * stylesheets and whether anybody is typing are the app's decisions, and a
 * spinner must not pay for a key router it never reads. So every interactive
 * program used to assemble the same seven steps by hand: ask whether both ends
 * are terminals, build the router, parse the sheets into a cascade, pick a
 * backend, `render()`, bind a quit key, and take all of it down again on the
 * way out. `runApp()` is those seven steps, done once.
 *
 * ```js
 * import { runApp, useApp } from '@ttylabs/sigil/app';
 * import { box, text } from '@ttylabs/sigil/element';
 *
 * function App() {
 *   const app = useApp();
 *   app.input?.bind((event) => {
 *     if (event.key.name === 'enter') {
 *       event.stop();
 *       app.exit(); // 0
 *     }
 *   });
 *   return box({ 'flex-grow': 1 }, text('Enter saves, Ctrl-C quits'));
 * }
 *
 * process.exitCode = await runApp(App).exited; // 0, 130 for Ctrl-C, 1 for a failure
 * ```
 *
 * **It captures the console while it runs** (SIG-310): a `console.log()` from the
 * app or a library it calls would write into the alternate screen, where the next
 * frame's diff does not know the cells changed. The lines go to `app.logs`; a full-screen
 * app replays them to the main screen when it fails and discards them when it
 * does not, and an inline one writes each above the live region as it arrives.
 * `console: false` turns it off. See `AppOptions.console`.
 *
 * It resolves an exit code and touches neither `process.exitCode` nor
 * `process.exit()`: the process's exit code is global state, and setting it is
 * the app's one line rather than a side effect of a library call. The cost is
 * stated rather than hidden -- an author who ignores the resolved code exits `0`.
 *
 * A subpath of its own, `@ttylabs/sigil/app`, which is the exception the root
 * `AGENTS.md` asks to argue for itself, and the argument is the import graph:
 * this is the one module that needs the renderer, the router and the theme at
 * once, and each of the three subpaths it could have joined keeps the other two
 * off its graph deliberately. `renderer/AGENTS.md` has the numbers under
 * "Running an app".
 */

import { createFullscreenCanvas } from '../canvas/index.js';
import type { CanvasBackend } from '../canvas/index.js';
import {
  captureConsole,
  type ConsoleCapture,
  createLogRing,
  type LogEntry,
  type LogRing,
} from '../components/console-capture.js';
import { box, type Element } from '../element/index.js';
import { renderError } from '../error-handler.js';
import { __ } from '../i18n/index.js';
import type { DetectOptions } from '../input/capabilities.js';
import {
  canReadKeys,
  createInput,
  type InputRouter,
  type InputStream,
  isAbort,
  type Key,
  parseFallbackKey,
  type MouseSurface,
} from '../input/index.js';
import { type Cascade, parseStylesheet, type Stylesheet } from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { parseTheme, themedCascade } from '../theme/index.js';
import { render, type Renderer, type RenderOptions } from './index.js';
import { type Context, createContext, provideContext, useContext } from './owner.js';

/** How to run one. */
export interface AppOptions extends Pick<
  RenderOptions,
  | 'colorLevel'
  | 'colorScheme'
  | 'effects'
  | 'frameMs'
  | 'gatherStats'
  | 'now'
  | 'onError'
  | 'reducedMotion'
> {
  /**
   * Where frames go, in place of the one the app would pick.
   *
   * For a test or an unusual destination. Without one, the app draws on the
   * alternate screen, or inline with `fullscreen: false`.
   */
  backend?: CanvasBackend;
  /**
   * The cascade, whole, in place of the themed one.
   *
   * The escape hatch: without it the app draws through `themedCascade()` --
   * the framework's own sheet, then `theme`, then `sheets` -- which is what every
   * built-in component is styled for. A cascade passed here is used as it is,
   * framework sheet or not -- and without the runner's `.sigil-app > *` rule, so
   * a column root taller than the screen wants `min-height: 0` of its own.
   *
   * Also without `setTheme()`, which throws: the runner cannot know which of the
   * sheets in a cascade it did not build is the theme. Swap one yourself with
   * `cascade.replace()`, which restyles on its own.
   */
  cascade?: Cascade;
  /**
   * Whether the app captures `console` while it runs. Defaults to `true`.
   *
   * A `console.log()` from the app or a library it calls writes straight into
   * the alternate screen, where the next frame's diff does not know the cells
   * changed -- so by default `runApp()` patches the console methods into a ring
   * of the last 1,000 lines, `app.logs`, and nothing reaches the screen while
   * the app owns it. Full screen replays the ring to the main screen once it is
   * back, **only when the app failed**: an exit code that is not `0` or `130`, a
   * throw from the component's body, a failed frame, or the process ending under
   * the app (a throw or rejection nobody caught, or a `process.exit(n)`), before the
   * error report, `log`, `info`, `debug`, `dir` and `dirxml` to stdout and `warn`
   * and `error` to stderr as the console would have printed them. A clean exit
   * discards it, and so does `130`: Ctrl-C is the habitual way out of a healthy app,
   * and an app that hangs never reaches its quit binding. A signal ends the process
   * without an `exit` event, so it loses the ring. Inline (`fullscreen: false`)
   * writes each line above the live region as it arrives, to the same two streams,
   * and holds nothing.
   *
   * What a custom `onError` logs through `console` is never discarded and never
   * drawn into the screen: it is written to the main screen after the replay, on any
   * exit code. Only one capture can be live, so an app that starts while another
   * holds it gets `logs === undefined` and its console is the real one -- and once
   * the first exits, the second's lines reach its screen.
   *
   * `false` leaves the console alone. So does a capture already installed by
   * `captureConsole()` before `runApp()`: the patch is global and only one can
   * be live, so the runner does not take it over, and `app.logs` is `undefined`.
   * A bare `process.stdout.write()` and a child process's stderr are not the
   * console and still write straight to the screen.
   */
  console?: boolean;
  /**
   * Whether to ask the terminal what it is once the app is up. Defaults to `true`.
   *
   * `Renderer.detect()`: the background colour for light and dark, and the colour
   * depth, read from replies rather than guessed from the environment. On by
   * default here and nowhere else, because the rule it would break is a CLI
   * paying a round trip to print one line -- and an app is the long-lived,
   * interactive program that rule was never about. The first frame does not wait
   * for it.
   */
  detect?: boolean | DetectOptions;
  /**
   * The alternate screen, or inline under the prompt. Defaults to `true`.
   *
   * Full screen because that is what an app is: it owns the screen, gives it back
   * exactly as it was, and has no scrollback to fight. Inline is for the tool
   * that wants its last frame left in the log -- it follows its content's height,
   * the way a `render()` with no height does.
   */
  fullscreen?: boolean;
  /**
   * Whether to track the mouse, and with motion for `:hover`. Off by default.
   *
   * `InputOptions.mouse` without the surface, which the app knows and the caller
   * would only be able to hand over after the app had already started.
   */
  mouse?: boolean | { motion?: boolean };
  /** Whether a paste arrives whole. On by default, as `createInput()` has it. */
  paste?: boolean;
  /**
   * Which key ends the app. Defaults to `isAbort()`, Ctrl-C and Ctrl-D.
   *
   * Checked before anything else sees the key -- the router's function bindings
   * run first and this is the first of them -- so a focused field or an open
   * dialog cannot swallow it. It ends the app with 130, the code a shell gives a
   * program interrupted by Ctrl-C, since raw mode turned that interruption into
   * a key. `false` binds nothing, for an app that decides for itself when to go;
   * then something has to call `exit()`.
   */
  quit?: false | ((key: Key) => boolean);
  /**
   * The key that ends the app cleanly, as a spec. Defaults to `'q'`.
   *
   * A **fallback**, `InputRouter.fallback()`: it comes after the focused element
   * and its ancestors, so a text field that takes `q` keeps it and typing a word
   * into a filter does not quit, while with nothing focused -- or focus anywhere
   * that does not use the key -- `q` ends the app. It is listed as "quit" (translated) by
   * `bindings()`, so a key-help footer shows it without the app writing the line.
   * Ends it with `0` rather than the `130` of `quit`: a `q` is the app choosing to
   * go, and it is not an interrupt.
   *
   * One key, modifiers allowed; a spec of two throws as `fallback()` does, with the
   * terminal already given back. `false` binds nothing, for an app whose `q` means
   * something else or that quits some other way -- the key it gives up is then
   * free for the app's own fallback or `onKey`. An app that binds `q` itself with
   * `bind('q', …)` or an element's `onKey` gets it first, and this is then only
   * what is left. `quit` is unchanged and is checked first.
   */
  quitKey?: false | string;
  /**
   * App stylesheets, over the theme. Source text is parsed.
   *
   * Ignored where `cascade` is given.
   */
  sheets?: readonly (Stylesheet | string)[];
  /** Where keys come from. Defaults to the terminal's own input. */
  stdin?: InputStream;
  /** The terminal. Defaults to the process's. */
  terminal?: Terminal;
  /**
   * A theme, over the framework's defaults and under `sheets`.
   *
   * Source text is parsed as a theme. A `Stylesheet` must already be one -- made by
   * `parseTheme()`, at origin `theme` -- and anything else throws; so does the same
   * sheet as both the theme and one of `sheets`. `app.setTheme()` swaps it later.
   *
   * Ignored where `cascade` is given.
   */
  theme?: Stylesheet | string;
}

/** A running app, and the way to end it. */
export interface App {
  /**
   * The cascade the app draws through: the one passed as `cascade`, or the one
   * the runner built.
   *
   * Changing it restyles the app on its own -- `add()`, `remove()` and `replace()`
   * each tell the renderer, which marks everything stale and asks for a frame --
   * so nothing here reaches into `view.restyler`. Already there while the
   * component's body runs, unlike `view`. An app that refused to start has none,
   * and reading it throws.
   */
  readonly cascade: Cascade;
  /**
   * Ends the app: unmounts the tree, gives the keys and the screen back, and
   * settles `exited` with `code`.
   *
   * Safe from anywhere -- a key handler, an effect, a frame -- because the
   * teardown runs on the next microtask rather than underneath whatever called
   * it. The second call does nothing, so a quit key and a button that arrive
   * together settle it once, with the first code -- unless the app fails before
   * the teardown has run, which settles it with `1` instead: see `exited`.
   *
   * @param code - The exit code. Defaults to `0`.
   */
  exit(code?: number): void;
  /**
   * The exit code, once the app has gone and the terminal is back as it was.
   *
   * What `exit()` was given; `0` for `quitKey`, which is a `q` and not an
   * interrupt; `130` for the quit key, which is what a shell
   * reports for Ctrl-C; `1` for a failure that ended the app, after `onError`
   * has written it; `1` for a throw from the component's body, which also
   * propagates from `runApp()`; `1` for a refusal to start without a terminal;
   * `129` when stdin ended under the app, which is the shell's code for a
   * terminal that hung up, and `1` if it ended in an error, which goes to
   * `onError` like any other failure; and `0` for an app the code ended itself
   * with `view.dispose()`.
   *
   * Of two intentional codes the first wins. A failure beats both: an `exit(0)`
   * called from the body, or from an effect, leaves the frame it was called in to
   * finish -- and a frame that then fails is a crash, so it settles `1`, never the
   * success that was asked for. So does stdin failing before the teardown has let
   * go of it, including an error whose event was still on its way. A cleanup that
   * throws during an intentional unmount -- `exit()`'s, or a `view.dispose()` the
   * app called -- is reported and does not count, since it did not end the app;
   * one thrown while a failed frame tears down is part of that failure.
   *
   * A code rather than a value, and handed back rather than set. Passing return
   * values up through layers of commands and contexts couples every layer to the
   * one below it, and `process.exitCode` is global state, so `runApp()` does
   * neither: it never touches `process.exitCode` or `process.exit()`. An app that
   * wants the process to exit with it says so in one line --
   * `process.exitCode = await app.exited` -- and one that ignores it exits `0`.
   * It never rejects, for the reason `main()` resolves: what awaits this is a bin
   * script, and an unhandled rejection dumping a stack over a terminal that was
   * just given back is the wrong default.
   */
  readonly exited: Promise<number>;
  /**
   * The router: keys, focus and the mouse. `undefined` for an app that refused.
   *
   * Already built while the component's body runs, which is what `useApp()` is
   * for: a control that needs the focus ring can have it at build time.
   */
  readonly input: InputRouter | undefined;
  /**
   * Whether the app started: stdin and the output both terminals.
   *
   * `false` is a refusal. Nothing was drawn, one line went to stderr, and
   * `exited` settled with `1` at once -- see `runApp()`.
   */
  readonly interactive: boolean;
  /**
   * The console lines the app has captured, newest last; for the debug overlay.
   *
   * `enableDebugOverlay(app.view, { input: app.input, log: app.logs })` shows the
   * same ring the runner replays on a failed exit. The runner owns it and the
   * console patch with it, and the overlay never installs one of its own: the
   * patch is global, so there is one, and the app owns the pairing.
   *
   * `undefined` where nothing was captured: `console: false`, a capture the app
   * installed itself before `runApp()` -- that one is left alone -- and a refusal
   * to start.
   */
  readonly logs: LogRing | undefined;
  /** `true` until the app has finished going. `false` from the start for a refusal. */
  readonly running: boolean;
  /**
   * Swaps the theme under the running app, and the screen follows.
   *
   * Takes source text -- parsed as a theme, as the `theme` option reads it -- a
   * stylesheet already at origin `theme`, which is what `parseTheme()` makes, or
   * `undefined` for the framework's own defaults. A sheet at any other origin
   * throws, since the origin is what places it and the same call would otherwise
   * land in different places depending on whether there was a theme already.
   *
   * The theme sheet the runner holds is replaced in place, so what the old one set
   * and the new one does not is gone rather than left standing, which is why a
   * switcher needs no reset sheet and no restatement of the defaults. With no theme
   * sheet yet, setting one adds it, and the origin puts it between the framework's
   * and the app's wherever it arrives; `undefined` takes it out. Setting the sheet
   * that is already the theme does nothing.
   *
   * The runner owns the one sheet it set. If the app took it out of
   * `app.cascade`, or swapped it for another, a later call adds a new one and
   * leaves whatever the app put there alone.
   *
   * A source that does not parse throws before anything is swapped, so the old
   * theme stays on screen.
   *
   * @param theme - The new theme, or `undefined` for none.
   * @throws For an app that refused to start, which has no cascade. For a
   *   stylesheet not at origin `theme`, or one the cascade already holds as
   *   another sheet. And if the app was given its own `cascade`, because the runner
   *   did not build it and cannot know which of its sheets is the theme: use
   *   `app.cascade.replace()` there.
   */
  setTheme(theme: Stylesheet | string | undefined): void;
  /** The terminal the app is drawing on. */
  readonly terminal: Terminal;
  /**
   * The renderer, for `detect()`, `onFrame()`, `restyler` and the rest.
   *
   * Not yet there while the component's body runs, because the body is how the
   * renderer gets its tree -- reading it then throws rather than answering
   * `undefined`. A body that wants it reads it in `onMount()` or a handler. An
   * app that refused to start has none, and reading it throws too.
   */
  readonly view: Renderer;
}

/**
 * The exit code for the quit key: what a shell reports for a program Ctrl-C
 * interrupted, which is 128 plus `SIGINT`'s 2. Raw mode turns that interruption
 * into a key, so the code the shell would have reported is the one handed back.
 */
const EXIT_INTERRUPTED = 130;

/**
 * Reads a theme the way `runApp()` and `setTheme()` both do.
 *
 * Source text is `parseTheme()`'s. A parsed sheet must already be a theme, which
 * is its *origin* being `theme`: the origin is what puts it between the
 * framework's sheet and the app's, so a sheet parsed at another one would sit
 * somewhere else depending on whether an app happened to have a theme already --
 * after the app's sheets when it was added, in the theme's slot when it replaced
 * one. Refused rather than guessed at, naming the function that makes one.
 *
 * @param theme - What the caller gave.
 * @returns The theme sheet, or `undefined` for none.
 * @throws For a sheet whose origin is not `theme`.
 */
function readTheme(theme: Stylesheet | string | undefined): Stylesheet | undefined {
  if (typeof theme === 'string') {
    return parseTheme(theme);
  }
  if (theme !== undefined && theme.origin !== 'theme') {
    throw new Error(
      `A theme must be a stylesheet at origin "theme", and this one is at "${theme.origin}": make it with parseTheme(css), or hand over the source text`
    );
  }
  return theme;
}

/** The exit code for stdin ending: 128 plus `SIGHUP`'s 1, a terminal hanging up. */
const EXIT_HUNG_UP = 129;

/** A line waiting for a backend, and the stream it is for. */
interface Held {
  text: string;
  to?: 'stderr';
}

/**
 * How long `writeAll()` waits for a reader that is not reading, in milliseconds.
 *
 * An `exit` handler cannot be allowed to hang the process for ever on a pipe nobody
 * drains, and a reader that has not taken a pipe's buffer in this long is not going
 * to.
 */
const WRITE_PATIENCE_MS = 5000;

/**
 * Writes all of `text` to a file descriptor, blocking, or gives up quietly.
 *
 * A non-blocking pipe answers `EAGAIN` when it is full, and the way to wait for
 * the reader without an event loop is to sleep a millisecond and try the rest.
 * Any other error is the far end gone (`EPIPE`) or a real fault in a process that
 * is already exiting, and neither is worth a throw out of an `exit` handler.
 * Not exported: it is public API the day it is, and the spawned test in
 * `app-console.test.ts` is what pins it.
 *
 * @param fd - The descriptor.
 * @param text - What to write.
 */
function writeAll(fd: number, text: string): void {
  const { writeSync } = process.getBuiltinModule('node:fs');
  const bytes = Buffer.from(text);
  const deadline = Date.now() + WRITE_PATIENCE_MS;
  let at = 0;
  while (at < bytes.length) {
    try {
      at += writeSync(fd, bytes, at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EAGAIN' || Date.now() > deadline) {
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);
    }
  }
}

/** Whether an exit code asks for the ring to be written out: not `0`, and not Ctrl-C's `130`. */
function replayable(code: number): boolean {
  return code !== EXIT_OK && code !== EXIT_INTERRUPTED;
}

/** The stream the console method would have written an entry to. */
function streamOf(entry: LogEntry): 'stderr' | undefined {
  return entry.level === 'warn' || entry.level === 'error' ? 'stderr' : undefined;
}

/** How many console lines the runner keeps, and so how many a failed exit can replay. */
const LOG_LINES = 1000;

/** The exit code for a failure: an error that ended the app, or a refusal to start. */
const EXIT_FAILED = 1;

/** The exit code for success, the only one that discards the console lines. */
const EXIT_OK = 0;

/**
 * The runner's own rule: the component's root may shrink to the screen.
 *
 * The root is a flex item in a column host the screen's height, and a flex item's
 * automatic minimum is its content's height -- so a column root taller than the
 * screen kept that height, `flex-grow: 1` could only grow it, and its bottom rows
 * were drawn nowhere. A system monitor with more cores than rows is the ordinary
 * way to get there, and every app's root wanted `min-height: 0` written by hand.
 *
 * Its own sheet between the theme and the app's sheets rather than an inline
 * style, so that a root's own `min-height` in an app sheet still wins: the
 * selectors tie, and a later sheet takes a tie. Parsed on first use, so a module
 * that only imports the subpath pays nothing.
 */
let hostSheet: Stylesheet | undefined;

/**
 * The app everything inside `runApp()` is built under, or `undefined` outside one.
 *
 * Exported for a component that works with or without an app -- one that uses
 * the router when there is one and draws without it when there is not -- which
 * reads it with `useContext(AppContext)` and checks. `useApp()` is for the
 * component that cannot work without one.
 */
export const AppContext: Context<App | undefined> = createContext<App | undefined>(
  undefined,
  'app'
);

/**
 * The app this component is being built under.
 *
 * Read during the component's body, like any context, since a handler that runs
 * later has no owner to ask -- so keep the answer:
 *
 * ```js
 * const app = useApp();
 * button.onKey = () => app.exit();
 * ```
 *
 * @returns The app.
 * @throws Outside `runApp()`, rather than answering `undefined` and leaving every
 *   caller to guard -- a component that can do without one reads `AppContext`.
 */
export function useApp(): App {
  const app = useContext(AppContext);
  if (app === undefined) {
    throw new Error('useApp() was called outside runApp(): read it in a component body under one');
  }
  return app;
}

/**
 * Mounts a component as an app, and runs it until it is told to stop.
 *
 * **The console is patched from here until the app is gone**, unless `console:
 * false` or a capture of the app's own is already live: see `AppOptions.console`
 * for what happens to the lines, and `App.logs` for the ring.
 *
 * **Without a terminal on both ends it refuses.** Where stdin or the output is
 * not a terminal it draws nothing, writes one error line to stderr through
 * `onError`, builds no router and no renderer, and settles `exited` with `1` at
 * once -- inline as well as full screen. A frame of a full-screen app in a pipe is
 * not useful output, and a refusal a script can detect is. A terminal handed in
 * as `terminal` is asked the same question, which is how a test runs one: the
 * testing terminal says yes.
 *
 * @param component - Builds the app's root element. Runs once, under the app.
 * @param opts - The terminal, the sheets, and how it ends.
 * @returns The app. A throw from the component's body propagates from here, with
 *   the terminal already given back, as it does from `render()` -- and `exited`
 *   on the handle `useApp()` gave the body settles `1`.
 */
export function runApp(component: () => Element, opts: AppOptions = {}): App {
  // checked first, before a router is built and stdin is taken: from plain JS a
  // `true` would reach the key grammar as `spec.split is not a function`, and a
  // `null` would quietly mean `'q'`
  const quitKey = opts.quitKey === undefined ? 'q' : opts.quitKey;
  if (quitKey !== false && typeof quitKey !== 'string') {
    throw new TypeError(
      `quitKey is a key spec or false: got ${quitKey === null ? 'null' : typeof quitKey}`
    );
  }
  // and that it is one key, here and not only where it is registered: that is
  // inside the render callback, which a run that refuses to start never reaches --
  // so a piped CI run would pass what a terminal throws on
  if (quitKey !== false) {
    parseFallbackKey(quitKey);
  }
  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);
  const interactive = stdin !== undefined && canReadKeys({ stdin, terminal });
  const custom = opts.onError;
  /**
   * How many custom `onError` calls are on the stack.
   *
   * Whatever such a handler logs through `console` is the app saying why it
   * failed, and the capture has just taken it into a ring that is replayed on a
   * failed exit and thrown away on a clean one -- where "the error vanished" is the
   * result. So a line logged inside the call is a report: held with the others and
   * written after the replay whatever the exit code, never into the alternate
   * screen, and never replayed a second time (`diverted`).
   */
  let reporting = 0;
  const report = custom
    ? (error: unknown): void => {
        reporting++;
        try {
          custom(error);
        } finally {
          reporting--;
        }
      }
    : reportError;

  let view: Renderer | undefined;
  let input: InputRouter | undefined;
  /** The cascade the app draws through, once it has been built or taken. */
  let cascade: Cascade | undefined;
  /** The theme sheet the runner put in that cascade, which `setTheme()` replaces. */
  let themeSheet: Stylesheet | undefined;
  let running = interactive;
  let exiting = false;
  /** Whether `render()` is on the stack, which is when a report has nowhere to go yet. */
  let rendering = false;
  /**
   * Whether stdin failed under the app -- the one failure the renderer does not
   * know about, so it is kept here beside `view.failed`, which is the other.
   */
  let stdinFailed = false;
  let code = 0;
  /** The runner's ring, once it is installed. `undefined` where nothing is captured. */
  let logs: LogRing | undefined;
  let capture: ConsoleCapture | undefined;
  /**
   * Whether console lines go straight out, above the live region, as they arrive.
   *
   * `fullscreen: false`, because that is the mode with an "above". A full-screen
   * app holds its lines in the ring instead and decides on the way out.
   */
  const inline = opts.fullscreen === false;
  /**
   * What the error reports wait in while a full-screen app holds its console lines.
   *
   * A report written while the app runs would go to the backend's held buffer in
   * the order it happened, which puts it before the lines the ring replays -- and
   * the replay goes first, so that the report reads as the end of what led to it.
   * `finish()` writes the lines and then these, whatever the exit code.
   */
  const reports: Held[] = [];
  /** The ring entries a custom `onError` logged, which are reports and not replayed. */
  const diverted = new Set<number>();
  /** Whether a failed exit replays the ring: a full-screen capture that is installed. */
  let replays = false;
  /** Whether reports wait in `reports`: a full-screen capture, until it has been written. */
  let holding = false;
  /** The newest ring entry already written out, so that a second pass writes the rest. */
  let written = -1;
  let noted = false;
  let settle: (code: number) => void = () => {};
  const exited = new Promise<number>((resolve) => {
    settle = resolve;
  });

  /**
   * Writes an error as `main()` would, through the backend, and sets no exit code.
   *
   * `renderError()` rather than `errorHandler()`, because the latter also sets
   * `process.exitCode` -- the global state this module does not touch. The code is
   * `exited`'s to carry.
   *
   * Through the backend rather than straight to stderr, which is the one thing
   * that differs from `render()`'s default: a full-screen backend holds a line
   * written while it owns the screen and writes it once the main screen is back,
   * so an `onMount` that threw is read afterwards instead of being drawn into the
   * middle of a frame. A failed frame has already stopped the backend by the time
   * it is reported, and a stopped backend writes straight through.
   *
   * What is reported while `render()` is still running waits in `early`: the
   * first frame is painted inside `render()`, so an `onMount` that throws on it is
   * reported before `render()` has returned the backend it should go through.
   * With no renderer coming at all, which is a refusal, it goes straight out.
   */
  function reportError(error: unknown): void {
    const line = `${renderError(error).replace(/[\r\n]+$/, '')}\n`;
    if (view) {
      hold(line, 'stderr');
    } else if (rendering) {
      early.push({ text: line, to: 'stderr' });
    } else {
      terminal.writeErr(line);
    }
  }
  /** What was written while `render()` was still running, in the order it was. */
  const early: Held[] = [];

  /** Through the backend, or into `reports` where a full-screen capture is holding them. */
  function hold(text: string, to?: 'stderr'): void {
    if (holding) {
      reports.push({ text, to });
    } else if (view) {
      view.backend.write(text, to);
    } else if (rendering) {
      early.push({ text, to });
    } else {
      direct(text, to);
    }
  }

  /** What the ring does with a line the moment it is stored. */
  function captured(entry: LogEntry): void {
    if (inline) {
      echo(entry);
    } else if (reporting > 0) {
      diverted.add(entry.seq);
      hold(`${entry.text}\n`, streamOf(entry));
    }
  }

  /**
   * Straight to the stream's file descriptor, and not back until it is all out.
   *
   * For `onProcessExit()` alone. An `exit` handler runs after the event loop has
   * stopped, so a `stream.write()` that cannot complete at once -- a pipe whose
   * reader is behind -- is queued for a loop that never comes round again, and the
   * rest of a long replay is dropped: 65,536 bytes of it, exactly a pipe's buffer.
   * A stream without a descriptor (a test terminal's) has nothing to wait on and
   * is written the ordinary way. See `writeAll()`.
   */
  function flush(text: string, to?: 'stderr'): void {
    const fd = ((to === 'stderr' ? terminal.stderr : terminal.stdout) as { fd?: unknown }).fd;
    if (typeof fd === 'number') {
      writeAll(fd, text);
    } else {
      direct(text, to);
    }
  }

  /** Straight to the terminal, for once the backend has gone or never was. */
  function direct(text: string, to?: 'stderr'): void {
    if (to === 'stderr') {
      terminal.writeErr(text);
    } else {
      terminal.write(text);
    }
  }

  /**
   * Writes the ring's lines that have not gone out yet, through `write`.
   *
   * In order, each to the stream the console method would have used: `log`,
   * `info` and `debug` to stdout, `warn` and `error` to stderr, with no prefix.
   * The first pass opens with a stderr note when the ring dropped lines, saying
   * how many -- a replay that looks complete and is not is worse than one that
   * says so. A later pass writes only what arrived since, which is what a cleanup
   * that logs during the teardown leaves.
   */
  function replay(write: (text: string, to?: 'stderr') => void): void {
    const ring = logs;
    if (ring === undefined) {
      return;
    }
    if (!noted) {
      noted = true;
      const dropped = ring.dropped;
      if (dropped > 0) {
        write(
          `${dropped} earlier console ${dropped === 1 ? 'line was' : 'lines were'} dropped (the last ${ring.size} follow)\n`,
          'stderr'
        );
      }
    }
    for (const entry of ring.entries()) {
      if (entry.seq > written) {
        written = entry.seq;
        if (!diverted.has(entry.seq)) {
          write(`${entry.text}\n`, streamOf(entry));
        }
      }
    }
  }

  /**
   * A failed frame that a custom `onError` is about to hear of: the lines, then
   * the reports, through the backend.
   *
   * Only for a custom handler. The default one is held like every other report, so
   * `fail()` reports into `reports` and `finish()` writes the lines, the cleanups'
   * lines among them, and then it. A custom handler writes wherever it likes the
   * moment it is called, and the only way to put the lines ahead of that is to
   * write them first -- through `backend.write()`, which holds them and flushes
   * them in order as `fail()` stops the backend. The cost is that a cleanup which
   * logs during that same teardown lands in the tail `finish()` writes after the
   * handler, which is the best a handler the runner cannot hold allows.
   */
  function settleFailure(): void {
    if (!holding || view === undefined) {
      return;
    }
    holding = false;
    const backend = view.backend;
    replay((text, to) => backend.write(text, to));
    for (const held of reports.splice(0)) {
      backend.write(held.text, held.to);
    }
  }

  /**
   * An inline app's captured line, written above the live region at once.
   *
   * Through the backend, which clears the region, writes above it and repaints --
   * the one place a line may go on a screen that scrolls. Before the backend exists
   * it waits in `early`, with the reports, for the same reason they do.
   */
  function echo(entry: LogEntry): void {
    const to = streamOf(entry);
    if (view) {
      view.backend.write(entry.text, to);
    } else if (rendering) {
      early.push({ text: `${entry.text}\n`, to });
    } else {
      direct(`${entry.text}\n`, to);
    }
  }

  /**
   * The process is ending under a running app: a throw nobody caught, a rejection
   * nobody handled, or a `process.exit()`.
   *
   * The terminal's own `exit` handler puts the screen back, and this is called
   * `restore()` again for the order's sake -- it is idempotent, and it means the
   * lines below land on the main screen whichever handler ran first. The console
   * goes back so that an `exit` handler of the app's own writes normally rather
   * than into a ring nobody will read. The replay is `finish()`'s rule with the
   * process's code. A signal never gets here: the terminal re-raises it and the
   * process dies without an `exit` event, so a signal loses the ring.
   */
  function onProcessExit(exitCode: number): void {
    process.removeListener('exit', onProcessExit);
    terminal.restore();
    uncapture();
    if (replays) {
      holding = false;
      if (replayable(exitCode)) {
        replay(flush);
      }
      for (const held of reports.splice(0)) {
        flush(held.text, held.to);
      }
    }
    // what a first frame reported or echoed before `render()` had a backend to
    // hand it to: the process is ending inside that frame, and nothing else will
    // ever write it. The order the body-throw path uses
    for (const held of early.splice(0)) {
      flush(held.text, held.to);
    }
  }

  /** Puts the console back, once: the first caller wins, and it is a no-op after. */
  function uncapture(): void {
    capture?.restore();
    capture = undefined;
  }

  /**
   * Takes everything down: the renderer, the router, then whatever is left.
   *
   * The renderer unmounts the tree and gives the screen back. The router lets go
   * of stdin -- the half `restore()` cannot do, and the half that matters, since a
   * `data` listener still attached holds the process open after the last frame.
   * Then `restore()`, which is the guarantee rather than a step: a cursor the app
   * hid itself is one no backend owes back, and it comes back here. Idempotent
   * where the other two already did the work.
   *
   * The first two in the order they went up, reversed, and that is tidiness
   * rather than a dependency: stopping the router first was tried and nothing
   * observable moved, because a stopped router keeps its focus ring and a
   * dialog closing on the way out can still put the focus back.
   *
   * The code is the failure's where one ended the app, whatever `exit()` latched
   * first: two intentional codes are settled by the first, and a failure is not an
   * intention. Read after `input.stop()`, because a stream destroyed with an error
   * whose event was still a tick away is told to `onEnd()` from inside it. What
   * failed is asked of the renderer rather than inferred from its reports: a
   * cleanup that throws during an intentional unmount -- this `dispose()`, or one
   * the app's own code called -- is reported exactly as a failed frame is, and only
   * the renderer knows which of the two tore it down.
   *
   * Each step runs whatever the one before it threw, and `exited` settles
   * whatever any of them threw: `running` is already false, so nothing could
   * settle it later, and a router's `stop()` calls `onEnd()` handlers somebody
   * else registered. What a step threw is reported once every step has run --
   * so it is written to a screen that is back -- and does not change the code: a
   * teardown that throws is the cleanup rule's case, not a failure that ended
   * the app. Settled before those reports rather than after, which nobody
   * awaiting it can tell apart -- a continuation runs on a later microtask, after
   * this has finished writing -- and which leaves an `onError` that throws
   * nothing to stop the settle with.
   */
  function finish(): void {
    if (!running) {
      return;
    }
    running = false;
    const thrown: unknown[] = [];
    for (const step of [
      () => view?.mounted && view.dispose(),
      () => input?.stop(),
      () => terminal.restore(),
    ]) {
      try {
        step();
      } catch (error) {
        // an aggregate is opened up -- several `onEnd()` handlers that threw, from
        // the router's `stop()` -- so each is reported once, as itself: the
        // default writer renders one line per error and an aggregate's line is
        // its own message, which says that handlers threw and not what
        thrown.push(...(error instanceof AggregateError ? error.errors : [error]));
      }
    }
    const final = stdinFailed || view?.failed === true ? EXIT_FAILED : code;
    // the console goes back after the teardown rather than before it, so that a
    // cleanup which logs is captured like everything else rather than drawn over
    // a screen that is on its way out
    process.removeListener('exit', onProcessExit);
    uncapture();
    if (replays) {
      // the screen is back, so these go straight out. Not for a clean exit: the
      // ring is the app's own scrollback and 0 means nothing needs explaining.
      // Nor for Ctrl-C, which is the habitual way out of a healthy app. Already
      // written, for a custom handler's failed frame, so only the tail is
      const failing = replayable(final);
      if (holding) {
        holding = false;
        if (failing) {
          replay(direct);
        }
        for (const held of reports.splice(0)) {
          direct(held.text, held.to);
        }
      } else if (failing) {
        replay(direct);
      }
    }
    settle(final);
    for (const error of thrown) {
      report(error);
    }
  }

  const app: App = {
    get cascade(): Cascade {
      if (cascade === undefined) {
        throw new Error(
          interactive
            ? 'App.cascade is not there before the app has built it'
            : 'App.cascade is not there because runApp() refused to start without a terminal'
        );
      }
      return cascade;
    },
    exit(next = 0): void {
      if (exiting) {
        return;
      }
      exiting = true;
      code = next;
      // a microtask rather than now: called from the component's body, a
      // synchronous teardown ran before `render()` had finished, so the app said
      // it was gone while `render()` went on to mount and paint
      queueMicrotask(finish);
    },
    exited,
    get input() {
      return input;
    },
    interactive,
    get logs() {
      return logs;
    },
    get running() {
      return running;
    },
    setTheme(next: Stylesheet | string | undefined): void {
      // the refusal first: an app that never started has no cascade whatever it
      // was given, and that is the answer, not a complaint about the option
      const sheets = app.cascade;
      if (opts.cascade !== undefined) {
        throw new Error(
          'App.setTheme() cannot swap the theme of a cascade passed as the cascade option: the app did not build it and cannot know which of its sheets is the theme. Use app.cascade.replace(old, next) instead'
        );
      }
      // read before anything moves, so a source that fails -- or a sheet that is
      // not a theme -- leaves the old theme on screen
      const sheet = readTheme(next);
      // the sheet this app set, if it is still in there. `setTheme()` owns that
      // one sheet; an app that edited the cascade itself has taken it back, and
      // then there is nothing here to replace or remove
      const held = themeSheet !== undefined && sheets.sheets.includes(themeSheet);
      if (held && sheet === themeSheet) {
        return;
      }
      if (sheet !== undefined && sheets.sheets.includes(sheet)) {
        throw new Error(
          'App.setTheme() was given a stylesheet the cascade already holds as another sheet: a sheet is one theme or one app sheet, because the cascade finds it by identity and would swap both'
        );
      }
      if (!held) {
        if (sheet !== undefined) {
          sheets.add(sheet);
        }
      } else if (sheet === undefined) {
        sheets.remove(themeSheet as Stylesheet);
      } else {
        sheets.replace(themeSheet as Stylesheet, sheet);
      }
      themeSheet = sheet;
    },
    terminal,
    get view(): Renderer {
      if (view === undefined) {
        throw new Error(
          interactive
            ? 'App.view is not there while the component is being built: read it in onMount()'
            : 'App.view is not there because runApp() refused to start without a terminal'
        );
      }
      return view;
    },
  };

  if (!interactive) {
    // nothing built, nothing drawn: one line, and a code a script can test
    report(
      new Error(
        'Cannot run an app because stdin or the output is not a terminal: it needs somebody to type and a screen to draw on'
      )
    );
    settle(EXIT_FAILED);
    return app;
  }

  // the host the component's root goes in, built first so that the router can
  // exist before the component does -- a router is built over a root, and the
  // component's own root is not a thing anybody has until its body has run
  const host = box({ class: 'sigil-app', 'flex-direction': 'column' });

  const mouse = opts.mouse;
  const router = createInput({
    mouse: mouse
      ? { motion: mouse !== true && mouse.motion === true, surface: lateSurface(() => view) }
      : undefined,
    paste: opts.paste,
    root: host,
    stdin,
    terminal,
  });
  input = router;

  const quit = opts.quit ?? isAbort;
  if (quit !== false) {
    // first, so that it sees every key before anything the component binds
    router.bind((event) => {
      if (quit(event.key)) {
        event.stop();
        app.exit(EXIT_INTERRUPTED);
      }
    });
  }
  // stdin ending is the terminal hanging up, and an app nobody can type to is
  // over. Ending in an error is a failure like any other, so it is reported the
  // same way -- held by the backend and written once the screen is back -- rather
  // than leaving a 1 on stderr with no reason beside it. And flagged, because a
  // failure beats a code `exit()` has already latched, which this `exit()` alone
  // could not do: it would be the second call
  router.onEnd((error) => {
    if (error === undefined) {
      app.exit(EXIT_HUNG_UP);
      return;
    }
    stdinFailed = true;
    report(error);
    app.exit(EXIT_FAILED);
  });

  // the console before the component, so that a log line from its body is caught
  // too. After the refusal above: an app that never draws has nothing to protect
  // and patches nothing. A capture the app installed itself is the one that is
  // live, and the latch says no -- leaving it alone is the whole of that rule
  if (opts.console !== false) {
    const ring = createLogRing({ capacity: LOG_LINES, onPush: captured });
    const installed = captureConsole(ring);
    if (installed.installed) {
      capture = installed;
      logs = ring;
      replays = !inline;
      holding = replays;
      // first, so that the console is back before any other `exit` handler runs: an
      // app's own, registered earlier, would otherwise log into the ring this is
      // about to discard, or replay as part of it
      process.prependListener('exit', onProcessExit);
    }
  }

  rendering = true;
  try {
    // the cascade before the backend: parsing a sheet or a theme can throw, and
    // a full-screen canvas subscribes to resizes the moment it is built, which
    // only its `stop()` undoes -- so a bad sheet has to throw while there is
    // still no canvas to leak, leaving nothing behind but the router
    if (opts.cascade === undefined) {
      // parsed here rather than inside `themedCascade()`, which would parse the
      // same text to the same sheet, because `setTheme()` has to be able to hand
      // that very sheet to `replace()` -- a cascade finds a sheet by identity
      themeSheet = readTheme(opts.theme);
      // one sheet, one job: a cascade finds a sheet by identity, so the same
      // object as the theme and as an app sheet would be swapped out of both
      if (themeSheet !== undefined && opts.sheets?.includes(themeSheet)) {
        throw new Error(
          'runApp() was given the same stylesheet as the theme and as one of sheets: a sheet is one or the other, because setTheme() swaps it by identity'
        );
      }
      cascade = themedCascade({
        colorScheme: opts.colorScheme,
        reducedMotion: opts.reducedMotion,
        sheets: [
          (hostSheet ??= parseStylesheet('.sigil-app > * { min-height: 0 }')),
          ...(opts.sheets ?? []),
        ],
        theme: themeSheet,
      });
    } else {
      cascade = opts.cascade;
    }
    view = render(
      () =>
        provideContext(AppContext, app, () => {
          host.append(component());
          // after the body, so a key-help footer lists "quit" last, where an app
          // puts it. In here rather than beside the router so that a spec which is
          // not one key throws the way a body that throws does: `render()` gives
          // the screen back, and the catch below the call stops the router
          if (quitKey !== false) {
            router.fallback(quitKey, () => app.exit(), { description: __`quit`, priority: 9 });
          }
          return host;
        }),
      {
        backend:
          opts.backend ??
          (opts.fullscreen === false ? undefined : createFullscreenCanvas({ terminal })),
        cascade,
        colorLevel: opts.colorLevel,
        colorScheme: opts.colorScheme,
        effects: opts.effects,
        frameMs: opts.frameMs,
        gatherStats: opts.gatherStats,
        now: opts.now,
        onError: report,
        reducedMotion: opts.reducedMotion,
        terminal,
      }
    );
  } catch (error) {
    // a throw from the component's body, which `render()` has answered by
    // stopping the backend and giving the terminal back -- or a sheet or a theme
    // that failed to parse, before there was a backend or a screen to give back.
    // Either way the router is the one thing left, since `render()` never knew
    // about it
    running = false;
    router.stop();
    process.removeListener('exit', onProcessExit);
    uncapture();
    // a crash: the lines first, then why, as for any failure. Inline has nothing
    // to replay -- its lines went out as they came, or wait in `early`
    if (replays) {
      holding = false;
      replay(direct);
      for (const held of reports.splice(0)) {
        direct(held.text, held.to);
      }
    }
    for (const held of early.splice(0)) {
      direct(held.text, held.to);
    }
    // the app failed, so `exited` says so -- whatever `exit()` the body may have
    // called before it threw -- rather than staying pending for whoever kept the
    // handle `useApp()` gave it. The throw still goes to the caller, which is
    // `render()`'s rule
    settle(EXIT_FAILED);
    throw error;
  } finally {
    rendering = false;
  }

  for (const held of early.splice(0)) {
    hold(held.text, held.to);
  }
  // the renderer going by any route ends the app: `view.dispose()` from a
  // handler, which is the app ending itself, or a frame that failed. The handler
  // need not know which -- `finish()` asks `view.failed`, and a failure beats the
  // 0 this asks for. A first frame that failed inside `render()` has already
  // gone, so this is called at once. A report is held by a full-screen capture,
  // so the lines go ahead of it; a custom `onError` is the exception, and a failed
  // frame writes the lines here, while its backend is still to be stopped, so that
  // they land ahead of what `fail()` hands it once the screen is back
  const renderer = view;
  renderer.onDispose(() => {
    if (renderer.failed && custom !== undefined) {
      settleFailure();
    }
    app.exit();
  });

  if (opts.detect !== false && !exiting) {
    // not for an app already going: `exit()` from the body, or from an effect or
    // an `onMount` of the first frame -- which `render()` also runs -- leaves the
    // teardown a microtask away, and the probe writes its queries the moment it
    // is asked, so the terminal's replies would arrive on a stdin nobody reads
    // any more and land in the shell. A probe rejects only where a query could
    // not be written, which is a fault rather than a quiet terminal, and is
    // reported without deciding the code
    view.detect(router, typeof opts.detect === 'object' ? opts.detect : undefined).catch(report);
  }

  return app;
}

/**
 * A mouse surface for a backend that does not exist yet.
 *
 * The router asks where the canvas is the moment it is built, and the router is
 * built before `render()` so that the component can have it -- so the first ask
 * finds nothing, which is answered the way a terminal that said nothing is: the
 * origin is unknown, and the next report asks again. Every read after that is the
 * renderer's backend's own.
 *
 * @param view - Reads the renderer, once there is one.
 * @returns The surface.
 */
function lateSurface(view: () => Renderer | undefined): MouseSurface {
  return {
    get height() {
      return view()?.backend.height ?? 0;
    },
    locate(probe) {
      return view()?.backend.locate(probe) ?? Promise.resolve(false);
    },
    get origin() {
      return view()?.backend.origin;
    },
    toCanvas(column, row) {
      return view()?.backend.toCanvas(column, row);
    },
    get width() {
      return view()?.backend.width ?? 0;
    },
  };
}
