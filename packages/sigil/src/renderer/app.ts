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
import { box, type Element } from '../element/index.js';
import { renderError } from '../error-handler.js';
import type { DetectOptions } from '../input/capabilities.js';
import {
  canReadKeys,
  createInput,
  type InputRouter,
  type InputStream,
  isAbort,
  type Key,
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
   * What `exit()` was given; `130` for the quit key, which is what a shell
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
  /** `true` until the app has finished going. `false` from the start for a refusal. */
  readonly running: boolean;
  /**
   * Swaps the theme under the running app, and the screen follows.
   *
   * Takes a stylesheet, source text -- parsed at origin `theme`, as the `theme`
   * option reads it -- or `undefined` for the framework's own defaults. The theme
   * sheet the runner holds is replaced in place, so what the old one set and the
   * new one does not is gone rather than left standing, which is why a switcher
   * needs no reset sheet and no restatement of the defaults. With no theme sheet
   * yet, setting one adds it, and the origin puts it between the framework's and
   * the app's wherever it arrives; `undefined` takes it out. Setting the sheet
   * that is already the theme does nothing.
   *
   * A source that does not parse throws before anything is swapped, so the old
   * theme stays on screen.
   *
   * @param theme - The new theme, or `undefined` for none.
   * @throws If the app was given its own `cascade`, because the runner did not
   *   build it and cannot know which of its sheets is the theme: use
   *   `app.cascade.replace()` there. Also throws for an app that refused to start.
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

/** The exit code for stdin ending: 128 plus `SIGHUP`'s 1, a terminal hanging up. */
const EXIT_HUNG_UP = 129;

/** The exit code for a failure: an error that ended the app, or a refusal to start. */
const EXIT_FAILED = 1;

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
  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);
  const interactive = stdin !== undefined && canReadKeys({ stdin, terminal });
  const report = opts.onError ?? reportError;

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
      view.backend.write(line, 'stderr');
    } else if (rendering) {
      early.push(line);
    } else {
      terminal.writeErr(line);
    }
  }
  const early: string[] = [];

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
    settle(stdinFailed || view?.failed === true ? EXIT_FAILED : code);
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
    get running() {
      return running;
    },
    setTheme(next: Stylesheet | string | undefined): void {
      if (opts.cascade !== undefined) {
        throw new Error(
          'App.setTheme() cannot swap the theme of a cascade passed as the cascade option: the app did not build it and cannot know which of its sheets is the theme. Use app.cascade.replace(old, next) instead'
        );
      }
      // the app's own cascade, and a refusal's absence of one is said by the getter
      const sheets = app.cascade;
      // parsed before anything moves, so a source that fails leaves the old theme
      // on screen -- the swap below is the only part that can be seen
      const sheet = typeof next === 'string' ? parseTheme(next) : next;
      if (sheet === themeSheet) {
        return;
      }
      if (themeSheet === undefined) {
        sheets.add(sheet as Stylesheet);
      } else if (sheet === undefined) {
        sheets.remove(themeSheet);
      } else {
        sheets.replace(themeSheet, sheet);
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
      themeSheet = typeof opts.theme === 'string' ? parseTheme(opts.theme) : opts.theme;
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
    for (const line of early.splice(0)) {
      terminal.writeErr(line);
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

  for (const line of early.splice(0)) {
    view.backend.write(line, 'stderr');
  }

  // the renderer going by any route ends the app: `view.dispose()` from a
  // handler, which is the app ending itself, or a frame that failed. The handler
  // need not know which -- `finish()` asks `view.failed`, and a failure beats the
  // 0 this asks for. A first frame that failed inside `render()` has already
  // gone, so this is called at once
  view.onDispose(() => app.exit());

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
