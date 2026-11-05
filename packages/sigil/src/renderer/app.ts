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
 *   const root = box({ 'flex-grow': 1, focusable: true }, text('q quits'));
 *   root.onKey = (event) => event.key.name === 'q' && app.exit();
 *   return root;
 * }
 *
 * await runApp(App).exited;
 * ```
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
import { errorHandler } from '../error-handler.js';
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
import type { Cascade, Stylesheet } from '../style/index.js';
import { type Terminal, terminal as defaultTerminal } from '../terminal/index.js';
import { themedCascade } from '../theme/index.js';
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
   * For a test or an unusual destination. Without one, an interactive app draws
   * on the alternate screen, or inline with `fullscreen: false`, and an app with
   * nobody to type draws one inline frame -- see `interactive`.
   */
  backend?: CanvasBackend;
  /**
   * The cascade, whole, in place of the themed one.
   *
   * The escape hatch: without it the app draws through `themedCascade()` --
   * the framework's own sheet, then `theme`, then `sheets` -- which is what every
   * built-in component is styled for. A cascade passed here is used as it is,
   * framework sheet or not.
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
   * for it, and an app with nobody to type never asks.
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
   * dialog cannot swallow it. `false` binds nothing, for an app that decides for
   * itself when to go; then something has to call `exit()`, because raw mode
   * means Ctrl-C is a key and never a signal.
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
export interface App<T = unknown> {
  /**
   * Ends the app: unmounts the tree, gives the keys and the screen back, and
   * settles `exited` with `value`.
   *
   * Safe from anywhere -- a key handler, an effect, a frame -- because the
   * teardown runs on the next microtask rather than underneath whatever called
   * it. The second call does nothing, so a quit key and a button that arrive
   * together settle it once, with the first value.
   */
  exit(value?: T): void;
  /**
   * Settles once the app has gone and the terminal is back as it was.
   *
   * With the value `exit()` was given, and `undefined` for anything else: the
   * quit key, `view.dispose()`, a failed frame, or an app with nobody to type.
   * It never rejects. A failure is reported to `onError` -- by default rendered
   * the way `main()` renders one, with `process.exitCode` set -- for the reason
   * `main()` resolves rather than rejects: what awaits this is a bin script, and
   * an unhandled rejection dumping a stack over a terminal that was just given
   * back is the wrong default.
   */
  readonly exited: Promise<T | undefined>;
  /**
   * The router: keys, focus and the mouse. `undefined` when not `interactive`.
   *
   * Already built while the component's body runs, which is what `useApp()` is
   * for: a control that needs the focus ring can have it at build time.
   */
  readonly input: InputRouter | undefined;
  /**
   * Whether anybody can type: stdin and the output both terminals.
   *
   * When not, the app draws one inline frame, unmounts, and is over -- `exited`
   * settles at once. A full-screen app in a pipe has nobody to read its keys and
   * no screen to own, and one frame of plain text is the most honest thing it can
   * say there: it is what `app | cat` and a CI log are for, and it exits zero
   * rather than failing a script that only wanted to see it.
   */
  readonly interactive: boolean;
  /** `true` until the app has finished going. */
  readonly running: boolean;
  /** The terminal the app is drawing on. */
  readonly terminal: Terminal;
  /**
   * The renderer, for `detect()`, `onFrame()`, `restyler` and the rest.
   *
   * Not yet there while the component's body runs, because the body is how the
   * renderer gets its tree -- reading it then throws rather than answering
   * `undefined`. A body that wants it reads it in `onMount()` or a handler.
   */
  readonly view: Renderer;
}

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
export function useApp<T = unknown>(): App<T> {
  const app = useContext(AppContext);
  if (app === undefined) {
    throw new Error('useApp() was called outside runApp(): read it in a component body under one');
  }
  return app as App<T>;
}

/**
 * Mounts a component as an app, and runs it until it is told to stop.
 *
 * @param component - Builds the app's root element. Runs once, under the app.
 * @param opts - The terminal, the sheets, and how it ends.
 * @returns The app. A throw from the component's body propagates from here, with
 *   the terminal already given back, as it does from `render()`.
 */
export function runApp<T = unknown>(component: () => Element, opts: AppOptions = {}): App<T> {
  const terminal = opts.terminal ?? defaultTerminal;
  const stdin = opts.stdin ?? (terminal.stdin as InputStream | undefined);
  const interactive = stdin !== undefined && canReadKeys({ stdin, terminal });
  const report = opts.onError ?? reportError;

  let view: Renderer | undefined;
  let input: InputRouter | undefined;
  let running = true;
  let exiting = false;
  let result: T | undefined;
  let settle: (value: T | undefined) => void = () => {};
  const exited = new Promise<T | undefined>((resolve) => {
    settle = resolve;
  });

  /**
   * Renders an error the way `main()` does, through the backend.
   *
   * Through the backend rather than straight to stderr, which is the one thing
   * that differs from `render()`'s default: a full-screen backend holds a line
   * written while it owns the screen and writes it once the main screen is back,
   * so an `onMount` that threw is read afterwards instead of being drawn into the
   * middle of a frame. A failed frame has already stopped the backend by the time
   * it is reported, and a stopped backend writes straight through.
   *
   * What is reported before there is a renderer to ask waits in `early`: the
   * first frame is painted inside `render()`, so an `onMount` that throws on it
   * is reported before `render()` has returned the backend it should go through.
   */
  function reportError(error: unknown): void {
    errorHandler(error, {
      stderr: {
        write(chunk: string): boolean {
          if (view) {
            view.backend.write(chunk, 'stderr');
          } else {
            early.push(chunk);
          }
          return true;
        },
      } as NodeJS.WritableStream,
    });
  }
  const early: string[] = [];

  /**
   * Takes everything down, in the order it went up and reversed.
   *
   * The renderer first, while the router is still whole: a dialog the renderer
   * closes on its way out puts the focus back through the router. Then the
   * router, which gives back raw mode, the paste markers and the mouse. Then
   * `restore()`, which is the guarantee rather than a step -- whatever is left,
   * a hidden cursor or an alternate screen a backend of the caller's entered,
   * goes back, and it is idempotent where the other two have already done it.
   */
  function finish(): void {
    if (!running) {
      return;
    }
    running = false;
    try {
      if (view?.mounted) {
        view.dispose();
      }
    } finally {
      input?.stop();
      terminal.restore();
      settle(result);
    }
  }

  const app: App<T> = {
    exit(value?: T): void {
      if (exiting) {
        return;
      }
      exiting = true;
      result = value;
      // a microtask rather than now: `exit()` is called from key handlers, from
      // effects and from inside a frame, and unmounting the tree underneath any
      // of those is the re-entrancy `runFrame()` already refuses
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
    terminal,
    get view(): Renderer {
      if (view === undefined) {
        throw new Error(
          'App.view is not there while the component is being built: read it in onMount()'
        );
      }
      return view;
    },
  };

  // the host the component's root goes in, built first so that the router can
  // exist before the component does -- a router is built over a root, and the
  // component's own root is not a thing anybody has until its body has run
  const host = box({ class: 'sigil-app', 'flex-direction': 'column' });

  if (interactive) {
    const mouse = opts.mouse;
    input = createInput({
      mouse: mouse
        ? { motion: mouse !== true && mouse.motion === true, surface: lateSurface(() => view) }
        : undefined,
      paste: opts.paste,
      root: host,
      stdin,
      terminal,
    });

    const quit = opts.quit ?? isAbort;
    if (quit !== false) {
      // first, so that it sees every key before anything the component binds
      input.bind((event) => {
        if (quit(event.key)) {
          event.stop();
          app.exit();
        }
      });
    }
    // stdin ending is somebody hanging up, and an app nobody can type to is over
    input.onEnd(() => app.exit());
  }

  const fullscreen = opts.fullscreen !== false && interactive;
  try {
    view = render(
      () =>
        provideContext(AppContext, app as App, () => {
          host.append(component());
          return host;
        }),
      {
        backend: opts.backend ?? (fullscreen ? createFullscreenCanvas({ terminal }) : undefined),
        cascade:
          opts.cascade ??
          themedCascade({
            colorScheme: opts.colorScheme,
            reducedMotion: opts.reducedMotion,
            sheets: opts.sheets,
            theme: opts.theme,
          }),
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
    // `render()` has already given the terminal back; the router is the one
    // thing it did not know about
    running = false;
    input?.stop();
    for (const chunk of early.splice(0)) {
      terminal.writeErr(chunk);
    }
    throw error;
  }

  for (const chunk of early.splice(0)) {
    view.backend.write(chunk, 'stderr');
  }

  // the renderer going by any route ends the app: `view.dispose()` from a
  // handler, or a frame that failed -- which has put the terminal back and is
  // about to report why
  view.onDispose(() => app.exit());

  if (!interactive) {
    // one frame, then gone: there is nobody to type and nothing to own
    view.frame();
    app.exit();
  } else if (opts.detect !== false && input) {
    view
      .detect(input, typeof opts.detect === 'object' ? opts.detect : undefined)
      .catch((error: unknown) => {
        if (running) {
          report(error);
        }
      });
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
