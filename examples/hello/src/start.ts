/**
 * Mounting an app full screen, by hand, until the runner exists.
 *
 * SIG-276 is `runApp()`: one call from a component to a full-screen app. This
 * is the same job done in the open, so that an example can be written before
 * that call exists -- and it is shaped like it on purpose. An example's entry
 * says `start(App, { stylesheet })` and the smoke test says
 * `start(App, { stylesheet, terminal })`; when the runner lands, this file is
 * deleted and each of those lines names `runApp` instead. Nothing in `App`
 * changes, because all it is handed is the router and a way to stop.
 *
 * Every example carries its own copy until then, which is the one exception to
 * "one definition of each helper" that `examples/AGENTS.md` records and the
 * reason it is temporary rather than shared: a module every example imported
 * would be a published package's worth of surface standing in for one that is
 * days away.
 */

import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import { box, type Element } from '@ttylabs/sigil/element';
import { canReadKeys, createInput, type InputRouter, isAbort } from '@ttylabs/sigil/input';
import { render, type Renderer } from '@ttylabs/sigil/renderer';
import { terminal as processTerminal, type Terminal } from '@ttylabs/sigil/terminal';
import { themedCascade } from '@ttylabs/sigil/theme';

/** What the root component is handed. */
export interface AppProps {
  /** Ends the app: the screen goes back, and `start()` settles with `code`. */
  exit(code?: number): void;
  /** The router, for bindings, the focus ring, and anything that takes one. */
  readonly input: InputRouter;
}

/** A root component. */
export type App = (props: AppProps) => Element;

/** How to start it. */
export interface StartOptions {
  /** Whether to track the mouse. Off by default: it takes text selection away. */
  readonly mouse?: boolean;
  /** The app's stylesheet, cascaded over the framework's own. */
  readonly stylesheet?: string;
  /** The terminal. Defaults to the process's; a test hands `createTestTerminal()`'s. */
  readonly terminal?: Terminal;
}

/**
 * Runs `app` on the whole screen until it calls `exit()`, or Ctrl-C.
 *
 * Without a terminal on both sides there is nobody to read keys from and
 * nowhere to draw a screen, so it says so and resolves `0`: piping an example
 * into `cat` is a question about what it is, not a failure. That is the rule
 * every interactive demo already follows.
 *
 * @param app - The root component.
 * @param opts - The stylesheet, the terminal, and the mouse.
 * @returns The exit code `app` asked for.
 */
export function start(app: App, opts: StartOptions = {}): Promise<number> {
  const terminal = opts.terminal ?? processTerminal;

  if (!canReadKeys({ terminal })) {
    terminal.write('This app draws a full screen and reads keys, so it needs a terminal.\n');
    return Promise.resolve(0);
  }

  return new Promise((settle, fail) => {
    // the root exists before the component runs, so that the router does too:
    // `render()` hands back the root only after the body has run, and a body
    // that binds a key needs the router while it is running
    const root = box({ 'flex-direction': 'column', height: '100%', width: '100%' });
    const backend = createFullscreenCanvas({ terminal });
    const input = createInput({
      mouse: opts.mouse ? { surface: backend } : undefined,
      root,
      terminal,
    });

    let view: Renderer | undefined;
    let done = false;

    /** Puts everything back, once, and settles one way or the other. */
    const finish = (outcome: () => void): void => {
      if (done) {
        return;
      }
      done = true;
      input.stop();
      // `undefined` only when the first frame threw, and `render()` has already
      // given the screen back by then
      view?.dispose();
      outcome();
    };
    const exit = (code = 0): void => finish(() => settle(code));

    // first, so that Ctrl-C always works: a function binding sees every key
    // before anything focused does, which is what an app that cannot be quit
    // is the failure of
    input.bind((event) => {
      if (isAbort(event.key)) {
        event.stop();
        exit(130);
      }
    });

    try {
      view = render(
        () => {
          root.append(app({ exit, input }));
          return root;
        },
        {
          backend,
          cascade: themedCascade({ sheets: opts.stylesheet ? [opts.stylesheet] : [] }),
          onError: (error) => finish(() => fail(error)),
          terminal,
        }
      );
    } catch (error) {
      // the body or the first frame threw. `render()` hands that to its caller
      // rather than to `onError`, and the router is still reading stdin
      finish(() => fail(error));
    }
  });
}
