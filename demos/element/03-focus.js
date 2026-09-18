/**
 * One router owns stdin, and Tab moves the focus.
 *
 *   node demos/element/03-focus.js      <- needs a terminal; Tab, Shift-Tab, q
 *
 * Every prompt used to set raw mode, attach its own listener, decode, and put
 * everything back -- which works exactly as long as there is one prompt. Two at
 * once fight over the stream and neither can see what the other consumed. Here
 * one router reads, and the key is dispatched to the focused element and then to
 * every ancestor until something stops it.
 *
 * The highlight is zero lines of component code: focus sets a state, and the
 * stylesheet matches it with `:focus`.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { arrange, box, createTree, paint, resolveStyles, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { Cascade, parseStylesheet, Restyler } from '@ttylabs/sigil/style';

if (!process.stdin.isTTY) {
	console.log('This demo reads keys, so it needs a terminal. Run it without a pipe.');
	process.exit(0);
}

const sheet = parseStylesheet(`
	.app { flex-direction: column; width: 40; border: round; border-color: gray; padding: 1 }
	.field { border: single; border-color: gray; padding-left: 1; padding-right: 1; height: 3 }
	.field:focus { border-color: cyan }
	.label { color: gray }
	/* the label never holds the focus -- the field does -- so it is reached
	   through the field rather than by a :focus of its own */
	.field:focus .label { color: cyan; font-weight: bold }
	.hint { color: gray }
`);

const app = box({ class: 'app' });
const fields = ['name', 'email', 'role'].map((name) => {
	const label = text(`${name}: `, { class: 'label' });
	const field = box({ class: 'field', focusable: true }, label);
	// the key reaches the focused field first; the app binding below never sees
	// what this stops
	field.onKey = (event) => {
		if (event.key.name.length === 1 && !event.key.ctrl) {
			label.setText(`${name}: ${label.text.split(': ')[1] ?? ''}${event.key.name}`);
			event.stop();
		}
	};
	return field;
});

app.append(...fields, text('Tab moves, type, Ctrl-C quits', { class: 'hint' }));

const backend = createInlineCanvas({ height: 12, width: 40 });
const restyler = new Restyler(new Cascade([sheet]));
const tree = createTree(app);
const input = createInput({ root: app });

const draw = () => {
	// the tree records what changed and the restyler is told what that implies,
	// which is the join the renderer (SIG-67) will own. Without it the restyler
	// re-resolves nothing after the first frame: focus really does move and the
	// `:focus` rule never re-matches, so the ring is invisible
	const marks = tree.take();
	for (const element of marks.classes) restyler.touchClasses(element);
	for (const element of marks.props) restyler.touchProps(element);
	for (const element of marks.children) restyler.touchChildren(element);

	resolveStyles(app, restyler);
	arrange(app, { height: backend.height, width: backend.width });
	backend.render((painter) => paint(app, painter));
};

const quit = () => {
	input.stop();
	backend.done();
	// what the tree ended up holding, which is the point: the keys went to the
	// focused element rather than to whoever grabbed stdin first
	for (const field of fields) console.log(`  ${field.children[0].text}`);
	console.log('one router, one focus ring, and the terminal put back');
	process.exit(0);
};

input.bind((event) => {
	// an app binding sees every key first, which is where quitting belongs: an
	// app that cannot be quit because a focused field swallowed Ctrl-C is the
	// failure this order exists to prevent
	if (isAbort(event.key) || (event.key.name === 'q' && !event.target)) {
		event.stop();
		quit();
	}
});

// every key redraws, which is the frame loop the renderer will own
input.bind(() => queueMicrotask(draw));
input.focus.focus(fields[0]);
draw();
