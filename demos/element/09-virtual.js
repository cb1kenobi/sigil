/**
 * The same ten thousand rows, windowed: only the ones on screen are built.
 *
 *   node demos/element/09-virtual.js    <- needs a terminal; arrows, wheel, drag, Tab, q
 *
 * `08-scroll.js` is this list with every row in the tree, and the two are meant
 * to be run one after the other: they look the same, scroll the same, report the
 * same range and draw the thumb in the same place. What differs is the line at
 * the bottom, which counts the elements that exist: **49**, against the **10,008**
 * the same list comes to with every row built. Measured, and 08 prints no count
 * of its own -- one text per row plus eight nodes of chrome -- so the comparison
 * is this number against that one rather than two numbers on two screens.
 *
 * It reads **45** at the very bottom, and that is the arithmetic rather than a
 * leak: the window is the rows the viewport can see, and at the end of the list
 * there are only eighteen left to see.
 *
 * Paint culling (SIG-110) already meant the frame drew the twenty rows on screen
 * rather than the ten thousand that existed, which took the paint from 35ms to
 * three tenths of a millisecond and left the **arrange** as the whole frame at
 * 72ms. An element that does not exist is not measured, not re-resolved and not
 * painted, so this is the other half: `node
 * packages/sigil/scripts/benchmark-virtual-list.mjs` asserts the two frames are
 * identical and then reports 81ms against 0.61ms for one wheel notch.
 *
 * What makes it cheap is that it is **only a component**. Nothing in the layout
 * engine, the cascade, the paint walk or `scrollRange()` knows a window is in
 * play: a spacer above and below is an ordinary box with a declared height, so
 * the content box's extent spans the whole list and the range, the clamp and the
 * thumb are the answers they would be over every row.
 *
 * Two things to try, and the second one is this tier's honest edge:
 *
 * - **Scroll it, every way.** Arrows, PageUp/PageDown, Home/End, the wheel with
 *   its acceleration curve, and dragging the thumb. Watch the element count stay
 *   in the forties and the thumb describe ten thousand rows rather than the
 *   window. Home
 *   and End are the sharpest: the thumb goes to the very top and the very bottom,
 *   which it could not do if the range came from what was built.
 * - **Tab.** The rows are focusable and Tab walks the ones that **exist**, which
 *   with a window is the ones on screen. So the focus can never end up somewhere
 *   you cannot see -- which is the failure `scrollIntoView()` is wired to the
 *   focus ring to prevent, and a window makes it unreachable rather than fixed.
 *   What it costs is the other direction: tabbing past the last visible row wraps
 *   instead of scrolling on, because a row nobody built is not in the ring. That
 *   is written down as left for a later tier rather than hidden here.
 *
 * `scrollIntoView()` itself does work, and it is the writer the component does
 * not own -- the keys, the wheel and the thumb all go through handlers it wired,
 * and the focus ring calls `scrollIntoView()` with nothing in between. One hook
 * on the element, `onScroll`, is what covers all four: `scrollTo()` is the only
 * writer of the offset there is.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { ScrollBox } from '@ttylabs/sigil/components';
import { box, cellStyle, raw, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';
import { frameworkSheet } from '@ttylabs/sigil/theme';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.log('This demo reads keys and the mouse, so it needs a terminal.');
	console.log('Run it without a pipe: node demos/element/09-virtual.js');
}

if (process.stdin.isTTY && process.stdout.isTTY) {
	/** Ten thousand, which is the number both benchmarks are written for. */
	const ROWS = 10_000;
	/** How tall the window is, border included. */
	const WINDOW = 20;

	const sheet = parseStylesheet(`
		.app { flex-direction: column }
		.log { border: round; border-color: gray }
		.row { padding-left: 1 }
		.row:focus { background-color: blue; color: white }
		.row:hover { color: cyan }
		.odd { color: gray }
		.readout { color: gray; margin-top: 1 }
		.key { color: yellow }
		.count { color: magenta }
	`);

	/** The focus ring, once there is one: `createInput()` needs the root first. */
	const ring = new State(undefined);

	/**
	 * One row, built when it enters the window and kept while it stays in one.
	 *
	 * No `height` here: the component gives each row a slot of exactly the
	 * declared height that cannot shrink, so "every row is one cell" is true of
	 * the tree rather than of the intention -- which is what makes the range exact
	 * rather than estimated.
	 */
	const row = (i) =>
		text(`${String(i).padStart(5, ' ')}  event ${i} arrived on the queue`, {
			class: i % 2 === 0 ? 'row' : 'row odd',
			focusable: true,
			id: `row-${i}`,
			'white-space': 'nowrap',
		});

	/** How many elements the tree is holding, which is what this demo is about. */
	function countElements(element) {
		let n = 1;
		for (const child of element.children) {
			n += countElements(child);
		}
		return n;
	}

	function App() {
		const log = ScrollBox({
			// the height is in **props** and not in the sheet, deliberately: the first
			// window is bounded by the height the host declared, because the viewport
			// sits inside the host and nothing has arranged anything yet. Written as
			// `.log { height: 20 }` instead there is no bound to read, so the *first
			// layout* builds nothing and it is the frame's second pass that fills the
			// window in -- which is correct either way since SIG-132, and is one layout
			// rather than two. Recorded under "Windowing a long list" in AGENTS.md
			props: { class: 'log', height: WINDOW },
			rows: { count: ROWS, height: 1, row },
		});

		const readout = text('');
		createEffect(() => {
			const at = ring.get()?.current.get();
			readout.setText(
				at === undefined ? 'nothing focused' : `focus: ${at.id ?? 'the scroll box itself'}`
			);
		});

		/**
		 * The element count, painted rather than placed.
		 *
		 * It is a question about the tree as it is *now*, and the window changes
		 * inside `scrollTo()` -- so a signal beside it would be a second copy of a
		 * number the tree already holds, and an effect would need something to
		 * depend on that a wheel notch moves. A `raw` element paints from the frame
		 * it is in, which is the same reason the scrollbar's thumb is one.
		 */
		const count = raw(
			{
				measure: () => ({ height: 1, width: 40 }),
				paint: (painter, area, element) => {
					painter.text(
						area.x,
						area.y,
						`${countElements(log)} elements for ${ROWS} rows`,
						cellStyle(element.style)
					);
				},
			},
			{ class: 'count' }
		);

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
			),
			count
		);
	}

	const canvas = createInlineCanvas({ height: WINDOW + 3 });
	const view = render(App, {
		backend: canvas,
		cascade: new Cascade([frameworkSheet(), sheet]),
		height: WINDOW + 3,
		width: 'auto',
	});

	const input = createInput({
		root: view.root,
		mouse: { motion: true, surface: canvas },
	});

	// `q` quits whatever is focused, for the reason `08-scroll.js` records: nothing
	// here reads a character, and the box has to be focused from the start or the
	// first arrow key goes to the bindings and nowhere else
	input.bind((event) => {
		if (isAbort(event.key) || event.key.name === 'q') {
			event.stop();
			view.dispose();
			input.stop();
		}
	});

	ring.set(input.focus);
	input.focus.next();
}
