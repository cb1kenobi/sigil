/**
 * A debug overlay: captured console output and frame stats, inside the app.
 *
 *   node demos/renderer/03-debug.js   <- needs a terminal; space, l, c, ctrl-g, q
 *
 * Full screen, which is the case this exists for. The full-screen backend holds
 * what is written to it and flushes it on the way out -- there is no "above the
 * region" on a screen with no scrollback, and a log line the app thought it had
 * written is worse than one that arrives late -- so the only `console.log` you
 * can read while a full-screen app is running is one inside the app. The inline
 * backend has `write()` and does not need this.
 *
 * What to drive, and what each thing proves:
 *
 * - **ctrl-g** toggles the pane. It is `position: fixed`, so it is out of flow: the
 *   counter above it does not move when it appears, which is what lets the pane
 *   be appended to a root that knows nothing about it.
 * - **space** ticks the counter, which is an ordinary signal write. Watch the
 *   stats line: `f` is the frame number, `L`/`P` is whether that frame laid out
 *   and painted, and `n/m el` is how many elements moved out of how many there
 *   are. The pane holds hundreds of rows and `m` stays at the app's own handful,
 *   which is the overlay staying out of its own report.
 * - **l** logs a line from inside an effect. It appears on the next frame rather
 *   than at once, and that is the design: a write into the ring marks nothing and
 *   asks for no frame, because a log line that asked for a frame from inside the
 *   effect that logged it is a loop. Press **l** with the pane open and nothing
 *   else happening and the line waits; press space and it arrives. That is worth
 *   doing once, because it is the one piece of this that reads as a bug and is
 *   not.
 * - **c** clears the ring.
 * - **q** quits, and the captured lines are printed to the main screen on the way
 *   out -- which is where their reader is, and is what `restore()` makes safe.
 *
 * The stats line is `lines  f<frame>  <duration>ms  LP  <moved>/<elements> el
 * <resolved> re  <cells>c <bytes>b  <styles>s/<sweeps>w`. Only the two that say
 * `el` leave the pane out. `re` is a count the cascade hands back rather than a
 * set to filter, and the four after it are the canvas's: a cell count cannot leave
 * a subtree out, because the diff is over a grid and there is no tree left to ask
 * which element painted a cell.
 */
import { createFullscreenCanvas } from '@ttylabs/sigil/canvas';
import {
	captureConsole,
	createLogRing,
	enableDebugOverlay,
	themedCascade,
} from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.log('This demo takes the whole screen and reads keys, so it needs a terminal.');
	console.log('Run it without a pipe: node demos/renderer/03-debug.js');
}

if (process.stdin.isTTY && process.stdout.isTTY) {
	const count = new State(0);
	const log = createLogRing({ capacity: 300 });

	// the console goes into the ring, and is put back on the way out. A global
	// patch follows the rule the alternate screen and bracketed paste follow:
	// put back what you attached, and say whether this call was the one that
	// changed it
	const capture = captureConsole(log);

	const backend = createFullscreenCanvas();
	const view = render(
		() => {
			const label = text('', { class: 'sigil-heading' });
			const hint = text('space tick   l log   c clear   ctrl-g pane   q quit', {
				class: 'sigil-muted',
			});
			createEffect(() => {
				label.setText(`ticks: ${count.get()}`);
				// a log line from inside an effect, which is the case the whole thing
				// is written around: this asks for no frame of its own
				console.log(`tick ${count.get()}`);
			});
			return box({ 'flex-direction': 'column', padding: 1, 'row-gap': 1 }, label, hint);
		},
		{
			backend,
			cascade: themedCascade(),
			// off by default, because a frame nobody asks about pays nothing
			gatherStats: true,
		}
	);

	const input = createInput({ root: view.root });
	// a predicate rather than a name, which is what the option takes: there is no
	// chord grammar to write and no name to get wrong -- this decoder names the
	// arrows and the paging keys and nothing else, so `f12` is not a `Key.name`
	// that exists
	const overlay = enableDebugOverlay(view, {
		height: 12,
		input,
		key: (key) => key.ctrl && key.name === 'g',
		log,
	});

	input.bind((event) => {
		if (isAbort(event.key) || event.key.name === 'q') {
			event.stop();
			input.stop();
			overlay.dispose();
			// the screen goes back before anything is printed, and the console goes
			// back with it: what was captured belongs on the screen somebody is about
			// to be looking at
			view.dispose();
			capture.restore();
			for (const entry of log.entries().slice(-5)) {
				console.log(`  ${entry.level}: ${entry.text}`);
			}
			console.log(`  ${log.size} lines held, ${log.dropped} dropped off the front`);
			process.stdin.unref();
			return;
		}
		if (event.key.name === 'space') {
			event.stop();
			count.set(count.get() + 1);
		}
		if (event.key.name === 'l') {
			event.stop();
			// deliberately not followed by anything that asks for a frame: the line
			// waits for the next frame something else causes, which is the rule
			console.warn(`a line nobody asked a frame for (${log.size})`);
		}
		if (event.key.name === 'c') {
			event.stop();
			log.clear();
			// a clear does need a frame, and it is the app that asks: the ring is
			// inert by construction, so nothing inside it can
			view.invalidate();
		}
	});
}
