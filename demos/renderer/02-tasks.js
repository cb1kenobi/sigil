/**
 * A list that holds state while it is on screen, and keeps it through a move.
 *
 *   node demos/renderer/02-tasks.js      <- needs a terminal; j/k, space, e, x, J/K, f, n, q
 *
 * `01-app.js` shows what a component runtime *is*. This one is the question
 * SIG-78 actually asked: whether the explicit control flow signals require --
 * `Show` and `For` instead of an `if` and a `.map()` -- is tolerable in code
 * somebody has to live with, rather than merely defensible in a design document.
 * So it is written the way an app would be written, and the thing to watch is
 * what survives.
 *
 * Each row owns two pieces of state nothing above it can see: whether its notes
 * are expanded, and how many times it has been moved. Neither is in the task
 * data and neither is in a signal the list knows about -- they are a `State` and
 * a `createEffect` inside the row's own body, which `For` ran once.
 *
 * Reorder a row with `J` and watch all three of those stay with it: the
 * expansion, the move count, and the focus. That is what keyed-by-identity buys
 * and the whole reason `For` is not a `.map()`: the row that moved is the *same*
 * row, so its element, its effects and anything attached to them are left alone.
 * Position keying would rebuild every row below the change, which in a terminal
 * means the focus ring moving out from under whoever was typing.
 *
 * Filter with `f` and the same thing holds for a row that leaves the list and
 * comes back -- except that it does not, and that is the honest half: a row
 * filtered out is *disposed*, because `For` keys on the items it was given and a
 * row nothing is asking for is a branch to tear down. Its expansion goes with
 * it. `Show` is the same rule one level up, which is why collapsing the whole
 * list loses every expansion at once.
 *
 * The panel at the bottom is why this demo exists rather than merely runs. `e`
 * picks a task to inspect, and the panel is a `Show` whose `when` produces a
 * *value* rather than a boolean -- which is the shape anybody writes for a
 * detail pane, an error banner or a selected row. Press `e` on one task and then
 * on another and the panel follows, because `children` is handed an **accessor**
 * onto what `when` produced and reads it in an effect. It was handed the value
 * itself until this demo was written, and then it did not follow: both tasks are
 * present, so presence never moved, so the branch was never rebuilt, and the
 * panel described the first task for the rest of the run. That is the one bug
 * SIG-118 turned up, and it was found by writing an app rather than by writing
 * the renderer.
 */
import { box, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, For, onCleanup, render, Show } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { Cascade, parseStylesheet } from '@ttylabs/sigil/style';

if (!process.stdin.isTTY) {
	console.log('This demo reads keys, so it needs a terminal. Run it without a pipe.');
	process.exit(0);
}

const sheet = parseStylesheet(`
	.app { flex-direction: column; width: 56; border: round; border-color: gray; padding: 1 }
	.head { font-weight: bold }
	.tally { color: gray }
	.hint { color: gray }
	.rows { flex-direction: column }
	.task { flex-direction: column; padding-left: 1 }
	.line { }
	.task:focus .title { color: cyan; font-weight: bold }
	.task:focus .mark { color: cyan }
	.mark { padding-right: 1 }
	.done .title { color: gray; text-decoration: strikethrough }
	.notes { flex-direction: column; padding-left: 4 }
	.note { color: gray; font-style: italic }
	.moves { color: magenta; padding-left: 1 }
	.empty { color: gray; font-style: italic; padding-left: 1 }
	.panel { flex-direction: column; border: single; border-color: yellow; padding-left: 1 }
	.panel-title { color: yellow; font-weight: bold }
	.panel-note { color: gray }
`);

/** The data. Rows are keyed on these objects, so they are never replaced. */
const tasks = new State([
	{ done: true, notes: ['the multi-pass walk', 'and the registries'], title: 'write the parser' },
	{ done: false, notes: ['80 columns', 'then a theme'], title: 'draw the help screen' },
	{ done: false, notes: ['keyed, so a move keeps the row'], title: 'port the component set' },
	{ done: false, notes: [], title: 'ship 1.0' },
]);

const FILTERS = ['all', 'open', 'done'];
const filter = new State('all');
/** Collapsing the list wholesale, which is what the outer `Show` is for. */
const listOpen = new State(true);
/**
 * The task the panel is describing, or nothing.
 *
 * A `Show` over this is the shape that found the bug: moving from one task to
 * another is a value change with no presence change, so the branch is kept --
 * which is only correct because `children` is handed an accessor.
 */
const inspecting = new State(undefined);

/** Read by `For`, so a filter change is a reconcile rather than a rebuild. */
function visible() {
	const mode = filter.get();
	return tasks.get().filter((task) => mode === 'all' || (mode === 'done') === task.done);
}

function move(task, by) {
	const list = [...tasks.get()];
	const at = list.indexOf(task);
	const to = at + by;
	if (at === -1 || to < 0 || to >= list.length) {
		return;
	}
	list.splice(to, 0, ...list.splice(at, 1));
	tasks.set(list);
}

/**
 * One task. Built once per task object, and kept while that object is in the
 * list -- whatever the list does to its order.
 *
 * @param item - The task.
 * @param index - Where it currently sits, as an accessor: a row that moved is
 *   the same row, so it is told its new position rather than rebuilt at it.
 * @returns The row.
 */
function Task(item, index) {
	/** Row-local, and the point of the demo: nothing above can see either. */
	const expanded = new State(false);
	const moves = new State(0);

	const title = text('', { class: 'title' });
	const mark = text('', { class: 'mark' });
	const moved = text('', { class: 'moves' });

	createEffect(() => {
		title.setText(`${index() + 1}. ${item.title}`);
	});
	// two effects over one row rather than one over both, because they read
	// different things: the title follows the position, the mark follows `done`.
	// A signal change runs the one effect that read it
	createEffect(() => {
		mark.setText(tasks.get().includes(item) && item.done ? '[x]' : '[ ]');
	});
	createEffect(() => {
		const count = moves.get();
		moved.setText(count === 0 ? '' : `moved ${count}x`);
	});

	// a row that goes away says so, which is the branch being disposed -- and is
	// how an app cancels whatever the row had in flight
	onCleanup(() => {
		if (process.env.SIGIL_DEMO_TRACE) {
			console.error(`disposed: ${item.title}`);
		}
	});

	const row = box({ class: 'task', focusable: true });
	row.append(
		box({ class: 'line' }, mark, title, moved),
		// the notes hang off the row's *own* state, so expanding one row says
		// nothing about any other. The wrapper is told the layout the branch would
		// have had, which is the tax every `Show` and `For` charges here
		Show({
			children: () =>
				For({
					children: (note) => text(`- ${note}`, { class: 'note' }),
					each: () => item.notes,
					props: { class: 'notes' },
				}),
			props: { class: 'notes' },
			when: () => expanded.get() && item.notes.length > 0,
		})
	);

	createEffect(() => {
		row.toggleClass('done', tasks.get().includes(item) && item.done);
	});

	row.onKey = (event) => {
		const { key } = event;
		if (key.name === 'space') {
			event.stop();
			expanded.set(!expanded.get());
		} else if (key.name === 'e') {
			event.stop();
			// one truthy value replacing another, which is the case the panel's
			// `Show` is here to keep honest
			inspecting.set(inspecting.get() === item ? undefined : item);
		} else if (key.name === 'x') {
			event.stop();
			item.done = !item.done;
			// the data is not a signal, so say what changed: the array identity is
			// what the effects above are watching
			tasks.set([...tasks.get()]);
		} else if (key.sequence === 'J') {
			event.stop();
			moves.set(moves.get() + 1);
			move(item, 1);
		} else if (key.sequence === 'K') {
			event.stop();
			moves.set(moves.get() + 1);
			move(item, -1);
		}
	};

	return row;
}

function App() {
	const tally = text('', { class: 'tally' });
	createEffect(() => {
		const list = tasks.get();
		const open = list.filter((task) => !task.done).length;
		tally.setText(`${open} of ${list.length} open - filter: ${filter.get()}`);
	});

	return box(
		{ class: 'app' },
		box({ class: 'line' }, text('tasks', { class: 'head' })),
		tally,
		// collapsing the list disposes every row, which is what `Show` means: a
		// hidden branch is still a branch, so it is not hidden, it is gone
		Show({
			children: () =>
				For({
					children: Task,
					each: visible,
					fallback: () => text('nothing matches this filter', { class: 'empty' }),
					props: { class: 'rows' },
				}),
			fallback: () => text('list collapsed', { class: 'empty' }),
			props: { class: 'rows' },
			when: () => listOpen.get(),
		}),
		// a detail pane over a value rather than a boolean. `task` is an accessor,
		// so the one effect below is what makes the panel follow a different task
		// without the branch -- and anything it held -- being thrown away
		Show({
			children: (task) => {
				const title = text('', { class: 'panel-title' });
				const note = text('', { class: 'panel-note' });
				createEffect(() => {
					title.setText(task().title);
				});
				createEffect(() => {
					const count = task().notes.length;
					note.setText(`${count} note${count === 1 ? '' : 's'} - e again to close`);
				});
				return box({ class: 'panel' }, title, note);
			},
			props: { class: 'rows' },
			when: () => inspecting.get(),
		}),
		text('j/k move  space notes  e inspect  x done  J/K reorder  f filter  n collapse  q quit', {
			class: 'hint',
		})
	);
}

const view = render(App, { cascade: new Cascade([sheet]) });
const input = createInput({ root: view.root });

input.bind((event) => {
	const { key } = event;
	if (isAbort(key) || key.name === 'q') {
		event.stop();
		view.dispose();
		input.stop();
		process.exit(0);
	}

	// the rows claim what is theirs first, so these only ever see what is left
	if (key.name === 'j') {
		event.stop();
		input.focus.next();
	} else if (key.name === 'k') {
		event.stop();
		input.focus.previous();
	} else if (key.name === 'f') {
		event.stop();
		filter.set(FILTERS[(FILTERS.indexOf(filter.get()) + 1) % FILTERS.length]);
	} else if (key.name === 'n') {
		event.stop();
		listOpen.set(!listOpen.get());
	}
});

input.focus.next();
