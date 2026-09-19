/**
 * A component runtime: bodies that run once, effects that update in place.
 *
 *   node demos/renderer/01-app.js      <- needs a terminal; Tab, space, a/d, q
 *
 * Everything below the renderer, assembled. A component is a function of props
 * that builds elements, and its body runs **once** -- there is no re-render and
 * no diff. The reactive parts are `createEffect()`s that write to the node they
 * built, so a signal change runs the one effect that reads it, and the frame
 * that follows restyles, lays out and paints whatever that disturbed.
 *
 * Which means the interesting thing to watch is what *does not* happen: the
 * counter below prints how many times each component body ran, and those numbers
 * never move however much the screen changes.
 *
 * `Show` and `For` are the tax that charges: an `if` in a body runs once and a
 * `.map()` builds the list it saw, so a conditional and a list have to be
 * components -- they are the only thing that can own a branch and dispose it.
 */
import { box, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, For, onMount, render, Show } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';

if (!process.stdin.isTTY) {
	console.log('This demo reads keys, so it needs a terminal. Run it without a pipe.');
	process.exit(0);
}

const sheet = parseStylesheet(`
	.app { flex-direction: column; width: 46; border: round; border-color: gray; padding: 1 }
	.title { font-weight: bold }
	.hint { color: gray }
	.row { padding-left: 1 }
	.row:focus { background-color: blue; color: white }
	.badge { color: cyan }
	.empty { color: gray; font-style: italic }
	.count { color: gray }
`);

const items = new State([
	{ id: 1, name: 'parser' },
	{ id: 2, name: 'canvas' },
	{ id: 3, name: 'layout' },
]);
const showDone = new State(true);
/** How many component bodies have run. The number that does not move. */
const bodies = new State(0);
const ranOne = () => bodies.set(bodies.get() + 1);

/** One row. Built once per item, and kept while that item is in the list. */
function Row({ index, item }) {
	ranOne();
	const label = text('');
	// the row follows its own position without being rebuilt: `index` is an
	// accessor because a row that moved is the same row
	createEffect(() => {
		label.setText(`${index() + 1}. ${item.name}`);
	});
	return box({ class: 'row', focusable: true }, label);
}

function App() {
	ranOne();
	const counter = text('', { class: 'count' });
	createEffect(() => {
		counter.setText(`${items.get().length} items - ${bodies.get()} component bodies have run`);
	});

	onMount(() => {
		// after a frame rather than at the end of the body, because what is worth
		// knowing here is where the component landed -- and during the body there
		// is no answer. `box` is that answer, and it is why this fires when it does
		if (process.env.SIGIL_DEMO_TRACE) {
			console.error(`mounted ${counter.box?.width} columns wide`);
		}
	});

	return box(
		{ class: 'app' },
		text('sigil', { class: 'title' }),
		Show({
			children: () =>
				For({
					children: (item, index) => Row({ index, item }),
					each: () => items.get(),
					fallback: () => text('nothing left', { class: 'empty' }),
					props: { 'flex-direction': 'column' },
				}),
			props: { 'flex-direction': 'column' },
			when: () => showDone.get(),
		}),
		counter,
		text('Tab moves, space hides, a adds, d deletes, q quits', { class: 'hint' })
	);
}

const view = render(App, { cascade: new Cascade([sheet]) });
const input = createInput({ root: view.root });

let next = 4;
input.bind((event) => {
	const { key } = event;
	if (isAbort(key) || key.name === 'q') {
		event.stop();
		view.dispose();
		input.stop();
		console.log(`${bodies.get()} component bodies ran, for every frame that was drawn`);
		process.exit(0);
	}

	if (key.name === 'space') {
		event.stop();
		showDone.set(!showDone.get());
	} else if (key.name === 'a') {
		event.stop();
		items.set([...items.get(), { id: next, name: `thing ${next}` }]);
		next++;
	} else if (key.name === 'd') {
		event.stop();
		items.set(items.get().slice(0, -1));
	}
});
