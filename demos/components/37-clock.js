/**
 * A stopwatch beside a spinner, and a countdown before an action.
 *
 *   node demos/components/37-clock.js
 *   node demos/components/37-clock.js | cat     <- no readout, and no ticking
 *
 * `stopwatch()` and `timer(ms)` are signals first: `text` and `elapsed` are read
 * off the clock, and read inside an effect they re-run once a second. So
 * "Installing... 1s" is a spinner's text and an effect, and the countdown is a
 * view put in a tree. `done` is what a countdown before an action awaits.
 *
 * Only the readout is gated by the output. Piped, nothing ticks and nothing is
 * drawn -- a stopwatch in a log would say `0s` once, which is wrong rather than
 * missing -- but the timer still runs out, because the action it counts down to
 * still has to happen.
 */
import {
  createSpinner,
  formatDuration,
  mountLive,
  stopwatch,
  timer,
} from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';
import { effect } from '@ttylabs/sigil/signals';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// the elapsed time beside a spinner
const watch = stopwatch().start();
const spin = createSpinner({ text: 'Installing...' }).start();
const stop = effect(() => {
  // `live` is false where nothing would redraw, and a log line wants no number
  spin.text = watch.live ? `Installing... ${watch.text}` : 'Installing...';
});

await sleep(1200);
stop();
spin.succeed(`Installed in ${formatDuration(watch.elapsed / 1000)}`);

// a countdown before something proceeds, as a node in a tree
const countdown = timer(2000, { format: 'clock' }).start();
const frame = mountLive(() =>
  box(
    {},
    text(countdown.live ? 'Deploying in' : 'Deploying', { 'margin-right': 1 }),
    countdown.view()
  )
);

const ran = await countdown.done;
frame.stop();

if (ran) {
  console.log('Deployed');
}
