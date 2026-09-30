/**
 * A drag, which is the case the capture was written for.
 *
 *   node demos/element/05-drag.js      <- needs a terminal; drag the slider, q
 *
 * `04-mouse.js` shows hover, a click and the wheel. This shows the one rule that
 * is invisible until you drag past the edge of the region: **a press captures the
 * pointer.**
 *
 * A report arriving outside the canvas's rect is dropped, because a click on the
 * log above the region is not the app's. On its own that strands every component
 * that tracks a press -- the release lands outside, is dropped, and a slider being
 * dragged waits for a `mouseup` that never comes, so the thumb sticks to the
 * pointer forever. So while a button is held, the motion and the release go to
 * whatever the press landed on, wherever the pointer has got to. That is the web's
 * implicit capture, and it is the difference between a draggable slider and a
 * decorative one.
 *
 * Which is why `event.x` can be **outside** the canvas here, exactly as `clientX`
 * is during a drag on a web page. Drag the thumb off the left or right edge and
 * watch the readout: the numbers keep coming, the slider clamps itself, and the
 * release still ends the drag.
 *
 * There is deliberately no `drag` event. Press, move and release are three events
 * a component already gets, and what a drag *means* -- a threshold, an axis lock,
 * a grabbed handle -- differs per component. What that comes to in practice is the
 * fifteen lines under `track.onMouse` below.
 *
 * The other thing worth watching is the two counters. A press and a release on the
 * same box is a `click`; a drag that wandered off and released out there is a
 * `mouseup` with no click after it, because a click is the nearest box containing
 * both ends and there is nothing out there to have anything in common with.
 */
import { box, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.log('This demo reads the mouse, so it needs a terminal on both sides.');
	console.log('Run it without a pipe: node demos/element/05-drag.js');
}

if (process.stdin.isTTY && process.stdout.isTTY) {
	/**
	 * How many cells the track is, which is also its resolution.
	 *
	 * The three widths in the sheet below add up to **exactly** the app's content
	 * box -- 44 wide, less a cell of border and a cell of padding on each side, is
	 * 40, and `9 + 26 + 5` is 40. That is not tidiness: `flex-shrink` defaults to 1,
	 * so an over-constrained row is squeezed rather than overflowing, and what it
	 * squeezes moves when the *content* moves. The first version asked for 45 in 40,
	 * and since a `nowrap` track cannot shrink below its own width the other two
	 * absorbed all five columns -- so the value's minimum growing by one at `100%`,
	 * where it had been three characters and became four, took a column out of the
	 * label and shifted the whole bar one cell left at exactly 100% and nowhere else.
	 */
	const TRACK = 26;

	const sheet = parseStylesheet(`
		.app { flex-direction: column; width: 44; border: round; border-color: gray; padding: 1 }
		.slider { height: 1 }
		.label { color: gray; width: 9 }
		.track { color: cyan; white-space: nowrap; width: ${TRACK} }
		/* five rather than four, so the widest value it ever holds still has a column
		   of slack: a right-aligned number whose box is exactly its own width is one
		   layout rounding away from moving what is beside it */
		/* the track is what you press, so it is what says so when the pointer is over
		   it -- one rule, and the hit test is what makes it true */
		.slider:hover .track { color: magenta }
		.value { color: gray; width: 5; text-align: right }
		.readout { color: gray; margin-top: 1 }
		.outside { color: yellow }
		.hint { color: gray }
	`);

	const value = new State(0.38);
	/** Whether a drag is live, which is what the readout is really about. */
	const dragging = new State(false);
	/** The raw report position, which during a capture may be off the canvas. */
	const at = new State('');
	const clicks = new State(0);
	const drags = new State(0);

	const App = () => {
		const bar = text('', { class: 'track' });
		createEffect(() => {
			const filled = Math.round(value.get() * TRACK);
			bar.setText('█'.repeat(filled) + '░'.repeat(TRACK - filled));
		});

		const percent = text('', { class: 'value' });
		createEffect(() => percent.setText(`${Math.round(value.get() * 100)}%`));

		const slider = box({ class: 'slider' }, text('volume', { class: 'label' }), bar, percent);

		// a component reads a drag out of the three events it already gets. The press
		// is what captures, so every move after it arrives here whatever the pointer
		// is over -- including nothing at all
		bar.onMouse = (event) => {
			const track = bar.box;
			if (!track) {
				return;
			}

			if (event.kind === 'mousedown') {
				dragging.set(true);
			}
			if (event.kind === 'mouseup') {
				if (dragging.get()) {
					drags.set(drags.get() + 1);
				}
				dragging.set(false);
			}
			if (event.kind === 'click') {
				clicks.set(clicks.get() + 1);
				return;
			}

			if (event.kind === 'mousedown' || (event.kind === 'mousemove' && dragging.get())) {
				// `bar.box` is where this element was drawn, which is the guarantee the
				// whole hit test rests on -- so the fraction is the pointer's offset into
				// it. Clamped here rather than by the router, because a captured report
				// really is outside and pretending otherwise would be the lie that
				// dropping it avoids
				const offset = event.x - track.x;
				const span = Math.max(1, track.width - 1);
				value.set(Math.min(1, Math.max(0, offset / span)));
			}

			// the slider owns the press, so nothing above it gets to act on the drag
			event.stop();
		};

		const line = text('', { class: 'readout' });
		createEffect(() =>
			line.setText(dragging.get() ? `dragging  ${at.get()}` : `idle  ${at.get()}`)
		);

		const escaped = text('', { class: 'outside' });
		const tally = text('', { class: 'hint' });
		createEffect(() => tally.setText(`${clicks.get()} clicks, ${drags.get()} drags finished`));

		return box(
			{ class: 'app' },
			slider,
			line,
			escaped,
			tally,
			text('press the bar and drag past the edge; q quits', { class: 'hint' })
		);
	};

	const view = render(App, { cascade: new Cascade([sheet]), height: 9, width: 44 });

	const input = createInput({
		mouse: { motion: true, surface: view.backend },
		root: view.root,
	});

	// after the tree, so this sees what the slider did not stop -- and it is the only
	// thing that can see a report which landed on no element at all
	input.onMouse((event) => {
		const off =
			event.x < 0 || event.y < 0 || event.x >= view.backend.width || event.y >= view.backend.height;
		at.set(`${event.kind} (${event.x}, ${event.y})${off ? '  <- off the canvas' : ''}`);
	});

	const quit = () => {
		input.stop();
		view.dispose();
		console.log(`  volume ended at ${Math.round(value.get() * 100)}%`);
		console.log(
			`  ${clicks.get()} clicks and ${drags.get()} drags, and every drag was told it ended`
		);
		// stdin was resumed to read keys, and a paused handle is not the same as one
		// let go of. `unref()` rather than `process.exit()`, which would truncate the
		// lines above on their way to a pipe
		process.stdin.unref();
	};

	input.bind((event) => {
		if (isAbort(event.key) || event.key.name === 'q') {
			event.stop();
			quit();
		}
	});
}
