/**
 * A scroll box: the bar, the three ways to move it, and the culling underneath.
 *
 *   node demos/element/08-scroll.js      <- needs a terminal; arrows, wheel, drag, Tab, q
 *
 * Ten thousand rows in a twenty-row window, which is the size at which the thing
 * this demo is really about becomes visible: **paint culls a subtree whose extent
 * misses its clip**, so a frame draws the twenty rows on screen rather than the ten
 * thousand that exist. Without it the same frame is 35ms of painting and the app is
 * a slideshow; with it the paint is three tenths of a millisecond and what is left
 * is the layout, which is what windowing is for and is deliberately not here --
 * `09-virtual.js` is this list windowed, and the two are meant to be run one after
 * the other. This demo shows the culling rather than measuring it: the numbers come
 * from `node packages/sigil/scripts/benchmark-paint-cull.mjs`, which asserts the
 * two frames are identical before it times either of them.
 *
 * Four things to try, and each one is a claim:
 *
 * - **The arrows, PageUp/PageDown and Home/End**, which the box claims only where
 *   the axis has somewhere to go -- so a box whose content *fits* hands the key on
 *   rather than swallowing it, which is what scroll chaining is here. A box at its
 *   end still claims it: it has a range, and Home in a list already at its top is
 *   still that list's key rather than the outer pane's.
 * - **The wheel, with an acceleration curve.** A deliberate turn is three lines, the
 *   convention; a flick is up to four times that. Spin it and watch the thumb cover
 *   real ground -- without the curve, crossing ten thousand rows is 3,333 notches.
 * - **The thumb.** Press it and drag: the press captures the pointer, so a drag that
 *   wanders off the bar, or off the canvas, still reaches the thumb and still ends.
 *   Click the track above or below it to page.
 * - **Tab.** The rows are focusable, so Tab walks them -- and `scrollIntoView()` is
 *   wired to the focus ring, so tabbing past the last visible row scrolls rather
 *   than leaving the highlight somewhere you cannot see. That is the half of this
 *   ticket that is about the ring knowing where the clip rect is.
 *
 * The gutter is **reserved** rather than overlaid, and it is reserved whether or not
 * anything can scroll. A terminal cell holds one character, so an overlaid scrollbar
 * does not sit translucently over the text underneath -- it erases it, a column of
 * last characters at a time. Reserving it always is what stops the content reflowing
 * the moment it grows past the window, which is the only thing overlaying was ever
 * for.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { ScrollBox } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';
import { frameworkSheet } from '@ttylabs/sigil/theme';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.log('This demo reads keys and the mouse, so it needs a terminal.');
	console.log('Run it without a pipe: node demos/element/08-scroll.js');
}

if (process.stdin.isTTY && process.stdout.isTTY) {
	/** Ten thousand, which is the number the ticket's benchmark is written for. */
	const ROWS = 10_000;
	/** How tall the window is, border included. */
	const WINDOW = 20;

	const sheet = parseStylesheet(`
		.app { flex-direction: column }
		.log { border: round; border-color: gray; height: ${WINDOW} }
		.row { height: 1; padding-left: 1 }
		.row:focus { background-color: blue; color: white }
		.row:hover { color: cyan }
		.odd { color: gray }
		.readout { color: gray; margin-top: 1 }
		.key { color: yellow }
	`);

	/**
	 * The focus ring, once there is one.
	 *
	 * A signal rather than a reference because of an ordering nobody can escape:
	 * `createInput()` needs the root element, which `render()` produces, so the
	 * ring does not exist while the component that reads it is being built. An
	 * effect that reads a signal holding the ring tracks both -- the box and the
	 * focus inside it -- and starts answering the moment it is filled in.
	 */
	const ring = new State(undefined);

	const rows = [];
	for (let i = 0; i < ROWS; i++) {
		rows.push(
			text(`${String(i).padStart(5, ' ')}  event ${i} arrived on the queue`, {
				class: i % 2 === 0 ? 'row' : 'row odd',
				focusable: true,
				id: `row-${i}`,
				'white-space': 'nowrap',
			})
		);
	}

	function App() {
		const log = ScrollBox({
			children: () => box({ 'flex-direction': 'column' }, ...rows),
			props: { class: 'log' },
		});

		const readout = text('');
		createEffect(() => {
			const at = ring.get()?.current.get();
			readout.setText(
				at === undefined ? 'nothing focused' : `focus: ${at.id ?? 'the scroll box itself'}`
			);
		});

		return box(
			{ class: 'app' },
			log,
			box(
				{ class: 'readout', 'column-gap': 1, 'flex-direction': 'row' },
				text('arrows / pgup / home', { class: 'key' }),
				text('wheel', { class: 'key' }),
				text('drag the thumb', { class: 'key' }),
				text('tab', { class: 'key' }),
				text('q', { class: 'key' }),
				readout
			)
		);
	}

	const canvas = createInlineCanvas({ height: WINDOW + 2 });
	const view = render(App, {
		backend: canvas,
		cascade: new Cascade([frameworkSheet(), sheet]),
		height: WINDOW + 2,
		width: 'auto',
	});

	const input = createInput({
		root: view.root,
		mouse: { motion: true, surface: canvas },
	});

	// `q` quits whatever is focused, which `03-focus.js` could afford to guard and
	// this cannot: nothing here reads a character, and the box has to be focused
	// from the start or the first arrow key goes to the bindings and nowhere else
	// -- a demo that does nothing on the first thing anybody tries
	input.bind((event) => {
		if (isAbort(event.key) || event.key.name === 'q') {
			event.stop();
			view.dispose();
			input.stop();
		}
	});

	ring.set(input.focus);
	// the first focusable element, which is the scroll box itself: it is focusable
	// so that a box holding nothing focusable can still be scrolled, and here it
	// is what makes the arrows work before anybody has pressed Tab
	input.focus.next();
}
