/**
 * Transitions and keyframes: declarative animation over whole cells.
 *
 *   node demos/style/03-animation.js      <- needs a terminal; space, c, Tab, q
 *
 * A terminal is a frame loop, so CSS animation works here. Two mechanisms, both
 * CSS's: a `transition` animates a style change caused by *anything* -- a class
 * toggled by a keystroke below, and a `:focus` that just matched -- and
 * `@keyframes` plus `animation` runs a named sequence.
 *
 * The interesting constraint is that geometry interpolates in **whole cells**. A
 * bar going from 4 to 30 columns has twenty-seven visible states however long it
 * takes, so sub-cell easing is invisible -- and the frame loop therefore does not
 * wake for a frame that would paint what is already on screen. The counter at
 * the bottom is that: frames painted against the thirty a second a loop with no
 * frame skip would have drawn.
 *
 * Nothing moves when there is no terminal to move on, which is
 * `prefers-reduced-motion` with a real analogue: a pipe, a file and a CI log
 * have no frames, so an animation there would write a line per tick into
 * something nobody will watch play. `SIGIL_REDUCED_MOTION=1` says the same thing
 * on a terminal, and a finite animation then shows the state it would have
 * ended on.
 */
import { box, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';

// parsed at module scope rather than inside `run()`, so that a typo in it is a
// failure the piped demos test can see: that test spawns with stdin ignored, so
// nothing below the terminal guard is ever reached there
const sheet = parseStylesheet(`
	.app { flex-direction: column; width: 46; border: round; border-color: gray; padding: 1 }
	.title { font-weight: bold }
	.hint { color: gray }

	/* a transition is an ordinary declaration: what it animates is any change
	   to the property, from a class, a theme, a resize, or a :focus */
	.bar { height: 1; width: 4; background-color: #2244aa; transition: width 600ms ease-out }
	.bar.wide { width: 30 }

	/* two properties at one duration, which is what a list is for */
	.swatch {
		height: 1;
		width: 8;
		background-color: #333333;
		color: #888888;
		transition-property: background-color, color;
		transition-duration: 400ms;
	}
	.swatch.hot { background-color: #cc3311; color: #ffddcc }

	/* and the whole of an animation: a name, a time, and a curve */
	@keyframes march { from { left: 0 } to { left: 20 } }
	.runner {
		height: 1;
		width: 4;
		position: relative;
		background-color: #22aa55;
		animation: march 1600ms ease-in-out infinite alternate;
	}

	.track { height: 1; width: 40 }
	.field { border: single; border-color: gray; padding-left: 1; height: 3 }
	/* a transition over a state the cascade already matches: no component code */
	.field { transition: border-color 300ms linear }
	.field:focus { border-color: cyan }
`);

if (process.stdin.isTTY) {
	run();
} else {
	console.log('This demo animates and reads keys, so it needs a terminal. Run it without a pipe.');
	console.log('Piped, every animation collapses to its end state -- which is what you would want');
	console.log('in a log: one line per thing that happened rather than one per tick.');
}

function run() {
	const wide = new State(false);
	const hot = new State(false);
	/** The line the frame counter is written to, kept rather than looked up. */
	let counter;

	let painted = 0;
	const started = Date.now();

	function App() {
		const bar = box({ class: 'bar' });
		const swatch = text('swatch', { class: 'swatch' });
		counter = text('', { class: 'hint' });

		createEffect(() => {
			bar.toggleClass('wide', wide.get());
		});
		createEffect(() => {
			swatch.toggleClass('hot', hot.get());
		});

		// not a per-frame readout: this effect runs when a signal moves, and what
		// it prints is read again on whatever frame happens next
		createEffect(() => {
			void wide.get();
			void hot.get();
			counter.setText('counting frames');
		});

		return box(
			{ class: 'app' },
			text('transitions and keyframes', { class: 'title' }),
			bar,
			swatch,
			box({ class: 'track' }, box({ class: 'runner' })),
			box({ class: 'field', focusable: true }, text('tab here')),
			counter,
			text('space widens, c heats, Tab focuses, q quits', { class: 'hint' })
		);
	}

	const view = render(App, { cascade: new Cascade([sheet]), width: 'auto' });

	// the backend is wrapped *after* the renderer built it, rather than handed in:
	// a backend passed to `render()` is one whose size is its owner's, so the
	// canvas would stay the one row it was built with and only the bottom of the
	// box would be drawn. The frame loop calls this through the object, so
	// replacing the method is enough to count what was painted
	const draw = view.backend.render.bind(view.backend);
	view.backend.render = (paint) => {
		painted++;
		return draw(paint);
	};

	const input = createInput({ root: view.root });

	// the counter is written from outside the graph, because what it reports is a
	// fact about the frame loop rather than about any signal
	const tick = setInterval(() => {
		const seconds = (Date.now() - started) / 1000;
		const naive = Math.round(seconds * 30);
		counter.setText(
			`${String(painted)} frames painted, against ${String(naive)} at thirty a second` +
				(view.animating ? ' (animating)' : '')
		);
	}, 250);
	tick.unref?.();

	input.bind((event) => {
		const { key } = event;
		if (isAbort(key) || key.name === 'q') {
			event.stop();
			clearInterval(tick);
			view.dispose();
			input.stop();
			console.log(
				`${String(painted)} frames for ${String(Math.round((Date.now() - started) / 1000))}s`
			);
			return;
		}
		if (key.name === 'space') {
			event.stop();
			wide.set(!wide.get());
		} else if (key.name === 'c') {
			event.stop();
			hot.set(!hot.get());
		}
	});
}
