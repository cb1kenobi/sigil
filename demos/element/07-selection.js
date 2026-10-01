/**
 * Selection and the clipboard: giving back what mouse tracking takes away.
 *
 *   node demos/element/07-selection.js   <- needs a terminal; drag, y, q
 *
 * A terminal reporting the mouse stops doing its own text selection, so an app
 * that turned tracking on has -- from the user's point of view -- broken copy and
 * paste. The escape hatch is weaker than it sounds: which key overrides tracking
 * is the terminal's own, shift in xterm and most of what followed it, and
 * **alt/option in iTerm2, where shift does nothing at all**. Nothing an app can
 * detect or influence. So this is the app giving selection back.
 *
 * Three things worth watching:
 *
 * - **the selection is over the painted grid**, not over the tree. Two cells and
 *   the text between them, which is what you are pointing at -- and it is
 *   *laid-out* text, so the paragraph below copies with its wrap points in it,
 *   exactly as selecting from a terminal always has.
 * - **alt-drag is rectangular**, which is the answer to a two-column layout: a
 *   linear drag down the left pane takes the right pane's columns with it, and a
 *   block drag does not. (In iTerm2 an alt-drag never reaches the app, because
 *   alt is what gives you the terminal's own selection there. That is the
 *   terminal doing the job rather than this failing to.)
 * - **the sparkline does not copy.** `raw` elements default to
 *   `selectable={false}`, because a plot's braille is a wall of block characters
 *   nobody wants in their clipboard. Drag across it and the highlight skips it.
 *
 * `y` copies with OSC 52, which is what makes this work over ssh -- the terminal
 * holds the clipboard, so a remote app can reach it. **There is no default
 * binding for copy and that is deliberate**: Ctrl-C is the abort, and
 * Ctrl-Shift-C reaches a terminal as the same byte Ctrl-C does without the Kitty
 * keyboard protocol -- so a framework claiming either would be claiming a key it
 * cannot hear or one it must not take. `y` is this app's choice.
 *
 * And there is no success to report. A terminal does not answer an OSC 52,
 * several refuse it by default, and tmux needs `set -g set-clipboard on` -- so
 * what the line below says is that the bytes were written, never that the
 * clipboard changed. Paste somewhere to find out, which is the only way there is.
 */
import { box, raw, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, enableSelection, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';

if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.log('This demo reads the mouse, so it needs a terminal on both sides.');
	console.log('Run it without a pipe: node demos/element/07-selection.js');
}

if (process.stdin.isTTY && process.stdout.isTTY) {
	const sheet = parseStylesheet(`
		.app { flex-direction: column; width: 52; border: round; border-color: gray; padding: 1 }
		.title { font-weight: bold }
		.hint { color: gray; margin-top: 1 }
		.status { color: cyan }
		.panes { flex-direction: row; margin-top: 1 }
		.pane { width: 24; flex-direction: column }
		.gutter { width: 2 }
		.plot { color: magenta }
	`);

	/** What the last copy came to, which is all anybody can be told. */
	const status = new State('drag to select, y to copy');

	/** A braille sparkline, which is the thing that must not copy. */
	const plot = () => {
		const bars = '⣀⣄⣆⣇⣧⣷⣿⣷⣧⣇⣆⣄⣀⣄⣆⣇⣧⣷⣿⣷⣧⣇';
		return raw(
			{
				measure: () => ({ height: 1, minHeight: 1, minWidth: 1, width: bars.length }),
				paint: (painter, area) => void painter.text(area.x, area.y, bars),
			},
			{ class: 'plot' }
		);
	};

	const App = () => {
		const line = text('', { class: 'status' });
		createEffect(() => line.setText(status.get()));

		return box(
			{ class: 'app' },
			text('selection over the painted grid', { class: 'title' }),
			// a paragraph is a wrapping row of words, so what a selection copies is
			// where the lines actually broke rather than the string that went in
			text(
				'This paragraph wraps, and copying it gives you the wrap points back -- which is what selecting from a terminal has always done.',
				{ width: 48 }
			),
			box(
				{ class: 'panes' },
				box(
					{ class: 'pane' },
					text('left pane', { class: 'title' }),
					text('alpha'),
					text('bravo'),
					text('charlie')
				),
				box({ class: 'gutter' }),
				box(
					{ class: 'pane' },
					text('right pane', { class: 'title' }),
					text('one'),
					text('two'),
					text('three')
				)
			),
			box({ 'margin-top': 1 }, plot()),
			line,
			text('drag = linear, alt-drag = block, y = copy, c = clear, q = quit', { class: 'hint' })
		);
	};

	const view = render(App, { cascade: new Cascade([sheet]), width: 52 });

	// `motion: true` is deliberately **not** passed. Selection needs the motion a
	// held button produces, which is what `1002` already reports -- so it costs no
	// `1003`, which is a report per cell of pointer travel for as long as the app
	// runs. What is given up is `:hover`, which this demo does not use
	const input = createInput({ mouse: { surface: view.backend }, root: view.root });

	const selection = enableSelection(view, input);

	const quit = () => {
		selection.stop();
		input.stop();
		view.dispose();
		console.log('the tracking mode and the paste markers both went back');
		process.stdin.unref();
	};

	input.bind((event) => {
		if (isAbort(event.key) || event.key.name === 'q') {
			event.stop();
			quit();
			return;
		}

		if (event.key.name === 'y') {
			event.stop();
			const copy = selection.copy();
			status.set(
				copy.written
					? `sent ${copy.bytes} bytes to the clipboard${copy.truncated ? ' (truncated)' : ''} -- paste somewhere to find out`
					: copy.refused === 'empty'
						? 'nothing selected, so nothing was sent'
						: `refused: ${copy.refused}`
			);
			return;
		}

		if (event.key.name === 'c') {
			event.stop();
			selection.clear();
			status.set('cleared');
		}
	});
}
