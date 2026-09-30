/**
 * The mouse: `:hover` from a hit test, a click that focuses, and the wheel.
 *
 *   node demos/element/04-mouse.js      <- needs a terminal; move, click, scroll, q
 *
 * One router already owned stdin for keys, and a mouse report arrives on the same
 * stream interleaved with what you type -- so it belongs to the same owner, and a
 * private listener for it would be the failure the router exists to replace.
 * What is added on top of the key path is three things:
 *
 * - **a translation.** A report is in *screen* coordinates and a canvas is a rect
 *   that deliberately does not know where it sits, so the backend closes the gap.
 *   Full screen is free. Inline asks, with a cursor position report, and forgets
 *   again whenever the anchor goes -- a resize, a line written above the region,
 *   an eviction. Watch the status line after resizing the window: the first
 *   report afterwards is the one that pays for finding out.
 * - **a hit test**, in reverse paint order, honouring the same clip rectangle
 *   paint drew inside. That rectangle is written onto the tree by `arrange()`
 *   rather than worked out twice, which is the one bit of restructuring here.
 * - **`:hover`**, which is zero lines of component code for the same reason
 *   `:focus` is: the hit test sets a state and the stylesheet matches it. It is
 *   set on the whole chain rather than the innermost box, because in CSS the
 *   pointer is inside every box that contains it.
 *
 * `motion: true` is what makes hover possible and is opt-in: it is xterm's
 * `1003`, which reports **every cell the pointer crosses**, for as long as the app
 * runs, over what may be an ssh link. Without it `:hover` matches nothing --
 * which is what it did before there was a mouse at all, so no sheet changes
 * meaning by turning tracking on.
 *
 * **What turning this on takes away**: a terminal reporting the mouse stops doing
 * its own text selection, so from your point of view this demo has broken copy
 * and paste. Shift-drag overrides it in most terminals and not all. That is the
 * price of the feature and is worth knowing before an app asks for it.
 */
import { box, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';

// both halves, and the reason is recorded in AGENTS.md: the query goes to the
// terminal's output and the reply arrives on its input, so a guard that asked
// about stdin alone let `| cat` through from a terminal and threw a stack over the
// output
if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.log('This demo reads the mouse, so it needs a terminal on both sides.');
	console.log('Run it without a pipe: node demos/element/04-mouse.js');
}

if (process.stdin.isTTY && process.stdout.isTTY) {
	const sheet = parseStylesheet(`
		.app { flex-direction: column; width: 46; border: round; border-color: gray; padding: 1 }
		.tile { border: single; border-color: gray; padding-left: 1; padding-right: 1; height: 3 }
		/* the whole feature, in two rules nothing in the components knows about */
		.tile:hover { border-color: cyan }
		.tile:focus { border-color: magenta; font-weight: bold }
		.count { color: gray }
		.status { color: gray; margin-top: 1 }
		.hint { color: gray }
	`);

	/** One tile per row, each counting its own clicks and holding its own number. */
	const tiles = ['alpha', 'beta', 'gamma'].map((name) => ({
		clicks: new State(0),
		name,
		wheel: new State(0),
	}));

	/** What the last report came to, which is the thing worth watching. */
	const status = new State('move the pointer over a tile');

	const App = () => {
		const rows = tiles.map((tile) => {
			const label = text('');
			createEffect(() =>
				label.setText(`${tile.name}  clicks ${tile.clicks.get()}  wheel ${tile.wheel.get()}`)
			);

			const it = box({ class: 'tile', focusable: true, id: tile.name }, label);

			// a component reads the mouse the way it reads a key: one handler, and the
			// event bubbles from here up to the root until something stops it
			it.onMouse = (event) => {
				if (event.kind === 'click') {
					tile.clicks.set(tile.clicks.get() + 1);
				} else if (event.kind === 'wheel') {
					tile.wheel.set(tile.wheel.get() + (event.wheel === 'up' ? 1 : -1));
					// the wheel is the tile's business and not the app's, so it stops here
					event.stop();
				}
			};
			return it;
		});

		const line = text('', { class: 'status' });
		createEffect(() => line.setText(status.get()));

		return box(
			{ class: 'app' },
			...rows,
			line,
			text('click to focus, Tab to move, scroll a tile, q quits', { class: 'hint' })
		);
	};

	const view = render(App, { cascade: new Cascade([sheet]), height: 13, width: 46 });

	// the backend is what knows where the canvas sits, so it is what a report is
	// translated against. `motion: true` is the opt-in that buys `:hover`
	const input = createInput({
		mouse: { motion: true, surface: view.backend },
		root: view.root,
	});

	// after the tree, which is the opposite of `bind()` and the whole of what the
	// mouse does differently: a binding goes first so an app cannot be made
	// unquittable, and nothing about the mouse has that shape -- so what is left is
	// the useful position, which is everything the tree did not claim
	input.onMouse((event) => {
		const where = `(${event.x}, ${event.y})`;
		const hovered = input.hovered?.id ?? 'nothing';
		status.set(`${event.kind} ${where} on ${event.target?.id ?? 'no element'} -- over ${hovered}`);
	});

	const quit = () => {
		input.stop();
		view.dispose();
		// what each tile ended up holding, which is the point: the events went to the
		// box under the pointer rather than to whoever was focused
		for (const tile of tiles) {
			console.log(`  ${tile.name}: ${tile.clicks.get()} clicks, wheel at ${tile.wheel.get()}`);
		}
		console.log('one router for keys and the mouse, and every mode put back');

		// stdin was resumed to read keys, and a handle that has been read from is one
		// that keeps the loop alive; `input.stop()` pauses it, which is not the same
		// thing as letting go of it. Said explicitly rather than left to hang.
		//
		// `unref()` rather than `process.exit(0)`, which is what the demo next door
		// does: a write to a pipe is asynchronous, so exiting truncates whatever is
		// still queued -- the trap `01-capabilities.js` carries an entry for. This lets
		// node drain the four lines above and then find nothing left to wait for
		process.stdin.unref();
	};

	input.bind((event) => {
		// a key binding still goes first, which is where quitting belongs.
		//
		// `q` quits whatever is focused, unlike `03-focus.js` next door, and that is
		// the mouse's doing: nothing here consumes a printable key, so there is no
		// field for a `q` to be typed into -- and click-to-focus means a click leaves
		// something focused, so a `&& !event.target` guard would make `q` stop working
		// the moment you clicked anything. Which it did, until it was tested
		if (isAbort(event.key) || event.key.name === 'q') {
			event.stop();
			quit();
		}
	});
}
