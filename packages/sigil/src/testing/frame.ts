import type { App } from '../renderer/app.js';
import type { Renderer } from '../renderer/index.js';
import { tick } from './terminal.js';

/**
 * Something that has a frame loop to paint: the app `runApp()` returns, or the
 * renderer `render()` does.
 */
export type Framed = Pick<App, 'running' | 'view'> | Pick<Renderer, 'frame' | 'mounted'>;

/**
 * Lets what was sent land, and paints the frame it asked for.
 *
 * ## Why a test needs it
 *
 * A frame is drawn on the renderer's clock, about thirty a second, and not once
 * per key -- so a key leaves the screen as it was until the next tick. So does
 * anything an `onMount` wrote: the first paint is synchronous and so is the
 * mount, but a signal written in it is a signal write like any other and lands in
 * the frame after. A test that wants to read what a key did used to wait for the
 * clock, with a timer sized by guessing, which is a test that is slow when it is
 * right and wrong under load.
 *
 * ## What it does, and why it forces the frame
 *
 * It paints one **now** through `Renderer.frame()`, which settles the signal
 * graph and paints whatever it dirtied "whatever the pacing says". Waiting for
 * the clock would be the same answer arrived at slowly, and an awaitable that
 * resolved on the *next* frame would hang for a program that has nothing dirty
 * and so never schedules one. It turns the loop over by hand, which is the
 * deterministic reading of "the screen after this key".
 *
 * The turn of the event loop before it is `press()`'s own and for its reason: a
 * key reaches a handler through a promise chain, and the frame has to see what
 * the handler wrote. Once is what a key costs; a handler that does async work of
 * its own -- a sampler that resolves later -- is `await frame(app)` again.
 *
 * A program that has gone, or never started, is a no-op rather than a throw: the
 * last thing a test does is often to ask for the screen after a quit key, and
 * "the app is gone" is the answer it is about to read.
 *
 * This is for an app in the same process. A **spawned** program paints on its
 * own clock and the only thing the parent sees is bytes, so that is
 * `waitFor()` on the handle `runOnTerminal()` returns.
 *
 * @param app - The app, or the renderer.
 * @returns Settled, with the frame on the screen.
 */
export async function frame(app: Framed): Promise<void> {
  await tick(1);
  if ('view' in app) {
    // `view` throws for an app that refused to start, and `running` is the
    // question that says so without a try
    if (app.running) {
      app.view.frame();
    }
  } else if (app.mounted) {
    app.frame();
  }
  // and the effects that frame ran, and whatever they queued, are the next turn
  await tick(1);
}
