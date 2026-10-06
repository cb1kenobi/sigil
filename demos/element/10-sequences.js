/**
 * Key sequences: `g g`, `Ctrl-X Ctrl-S`, and a leader key with a pending state.
 *
 *   node demos/element/10-sequences.js   <- needs a terminal; g g, Space f, Ctrl-X Ctrl-S, q
 *
 * A binding was one key, so `g g` and a leader key were both unexpressible.
 * What makes them expressible is a trie over the bindings plus a **pending
 * sequence**: a key the trie has a child for is held rather than dispatched, and
 * the keys held so far are a signal an app can render -- which is what the `g`
 * in the corner below is, and is how a vim-like UI stays usable.
 *
 * Three things are worth watching rather than reading about.
 *
 * `g` is bound **and** `g g` is bound, so a lone `g` has to wait to find out
 * which: press it and the status line shows `g`, and half a second later `g`
 * fires on its own. Press the second one inside that window and the pair fires
 * instead. That is `SEQUENCE_TIMEOUT`, and it is the only thing here that waits.
 *
 * `Space` is the leader and nothing else, so it waits with **no deadline at
 * all** -- there is nothing to disambiguate, and any key that does not continue
 * it already cancels it. Press Space and leave it; the `space` sits there.
 *
 * And Ctrl-C quits from inside a half-entered sequence, every time. A function
 * binding sees every key before the trie is even consulted, which is the same
 * sentence this framework already carries about a focused input: an app that
 * cannot be quit is the failure that ordering exists to prevent.
 */
import { box, text } from '@ttylabs/sigil/element';
import { createInput, formatKeys, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';

// both sides, which is the rule `demos/terminal/01-capabilities.js` is written
// down for: `createInput()` refuses to exist unless stdin *and* the terminal's
// output are terminals, because the keys arrive on one and the frame is drawn to
// the other
if (!process.stdin.isTTY || !process.stdout.isTTY) {
	console.log('This demo reads keys and draws frames, so it needs a terminal on both sides.');
	process.exit(0);
}

const sheet = parseStylesheet(`
	.app { flex-direction: column; width: 52; border: round; border-color: gray; padding: 1 }
	.title { font-weight: bold }
	.hint { color: gray }
	.log { color: cyan }
	/* a gap rather than a trailing space in the label, because the wrapper trims
	   one: a text of "pending: " measured and drew "pending:". And no backtick in
	   this comment, which is the rule FRAMEWORK_CSS carries -- one inside a
	   template literal ends the sheet, and what the parser then reports is a
	   syntax error further down than the character that caused it */
	.pending { flex-direction: row; padding-top: 1; column-gap: 1 }
	.label { color: gray }
	/* the pending keys, which is the whole of what an app renders about this */
	.keys { color: yellow; font-weight: bold }
	.waiting { color: gray; font-style: italic }
`);

/** What the last binding to fire did, so that the screen says it happened. */
const last = new State('nothing yet');

/** The pending sequence, read off the router rather than tracked here. */
const pending = new State('');

/** Whether that pending node is a binding too, which is the only case that waits. */
const waiting = new State(false);

function App() {
	const log = text('', { class: 'log' });
	createEffect(() => log.setText(`last: ${last.get()}`));

	const keys = text('', { class: 'keys' });
	createEffect(() => keys.setText(pending.get() === '' ? '--' : pending.get()));

	const note = text('', { class: 'waiting' });
	createEffect(() => note.setText(waiting.get() ? '(waiting on a deadline)' : ''));

	return box(
		{ class: 'app' },
		text('Key sequences', { class: 'title' }),
		text('g g, g, Space f, Space w q, Ctrl-X Ctrl-S', { class: 'hint' }),
		text('Escape clears, Backspace pops one, Ctrl-C always quits', { class: 'hint' }),
		log,
		box({ class: 'pending' }, text('pending:', { class: 'label' }), keys, note),
		text('q quits', { class: 'hint' })
	);
}

const view = render(App, { cascade: new Cascade([sheet]) });
const input = createInput({ root: view.root });

// a function binding, which sees every key before the trie is consulted. That is
// where quitting belongs and it is the whole Ctrl-C guarantee: no keystroke
// whatsoever, pending sequence or not, can make this unreachable
input.bind((event) => {
	if (isAbort(event.key) || event.key.name === 'q') {
		event.stop();
		view.dispose();
		input.stop();
		console.log('one trie, one pending sequence, and Ctrl-C reachable throughout');
		process.exit(0);
	}
});

// `g` and `g g` are both bound, which is the only shape that waits
input.bind('g', () => last.set('g -- the shorter one, on its deadline'));
input.bind('g g', () => last.set('g g -- the pair, inside the window'));
input.bind('ctrl+x ctrl+s', () => last.set('ctrl+x ctrl+s -- saved'));

// and the leader, declared once so that moving it off Space is one edit
const leader = input.leader('space');
leader.bind('f', (keys) => last.set(`${formatKeys(keys)} -- find`));
leader.bind('w q', (keys) => last.set(`${formatKeys(keys)} -- write and quit`));

// the pending state is a signal, so the status line follows the *deadline*
// firing as well as every key -- which a redraw-on-keypress could not do, since
// a sequence committing on a timeout is not a key
createEffect(() => {
	const keys = input.sequence.get();
	pending.set(formatKeys(keys));
	waiting.set(keys.length === 1 && keys[0]?.name === 'g');
});
