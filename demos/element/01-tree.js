/**
 * The whole stack in one file: a tree, a stylesheet, a layout, and cells.
 *
 *   node demos/element/01-tree.js
 *   node demos/element/01-tree.js | cat     <- the same frame, uninterpreted
 *
 * An element is the one object every layer above the canvas reads. The cascade
 * matches selectors against it, the layout engine measures and places it, and
 * the paint walk draws it -- and none of those three know about the other two,
 * because each was written against an interface an element happens to satisfy.
 *
 * What is *not* here is a renderer: nothing below redraws when something
 * changes, because deciding when to redraw is the frame loop's and the frame
 * loop is its own ticket. What the tree does is say what changed, which is the
 * `marks` printed at the end.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { arrange, box, createTree, paint, resolveStyles, text } from '@ttylabs/sigil/element';
import { Cascade, parseStylesheet, Restyler } from '@ttylabs/sigil/style';

const sheet = parseStylesheet(`
	.panel {
		border: round;
		border-color: gray;
		padding: 1;
		flex-direction: column;
		width: 34;
	}
	.title { color: cyan; font-weight: bold }
	.row { flex-direction: row; gap: 1 }
	.label { color: gray }
	.done { color: green }
	.pending { color: yellow }
`);

const rows = [
	['parser', 'done'],
	['layout', 'done'],
	['renderer', 'pending'],
];

const root = box({ class: 'panel' }, text('sigil 2.0', { class: 'title' }));
for (const [name, state] of rows) {
	root.append(
		box(
			{ class: 'row' },
			text(state === 'done' ? '✓' : '·', { class: state }),
			text(name, { class: 'label' })
		)
	);
}

const tree = createTree(root);
const restyler = new Restyler(new Cascade([sheet]));
const backend = createInlineCanvas({ height: 7, width: 34 });

const draw = () => {
	resolveStyles(root, restyler);
	arrange(root, { height: backend.height, width: backend.width });
	backend.render((painter) => paint(root, painter));
};

draw();
await new Promise((resolve) => setTimeout(resolve, 700));

// one mutation, and the tree says exactly what it implies -- nothing else is
// marked, which is what makes a narrower invalidation possible later
root.children[3].children[0].setProp('class', 'done').setText('✓');
root.children[3].children[1].setText('renderer (just landed)');

draw();
backend.done();

const marks = tree.take();
console.log(
	'marked:',
	Object.entries(marks)
		.filter(([, set]) => set.size > 0)
		.map(([kind, set]) => `${kind}=${set.size}`)
		.join(' ') || 'nothing'
);
