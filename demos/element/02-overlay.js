/**
 * An overlay, a stacking order, and a pane that scrolls.
 *
 *   node demos/element/02-overlay.js
 *   node demos/element/02-overlay.js | cat     <- the frames as plain text
 *
 * The half of layout that is not flow. A dropdown anchors to the panel it was
 * written inside and takes no space on the way past -- the list underneath it
 * does not reflow, which is the whole reason anybody reaches for one. A pane
 * with `overflow: hidden` clips what its children draw to its own edge, and
 * scrolling it moves the boxes rather than the drawing, so a box is still where
 * it looks like it is.
 *
 * Watch the row the list ends on while the dropdown opens: it does not move.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import { arrange, box, paint, resolveStyles, text } from '@ttylabs/sigil/element';
import { Cascade, parseStylesheet, Restyler } from '@ttylabs/sigil/style';

const sheet = parseStylesheet(`
	.app { flex-direction: column; width: 34; height: 8; border: round; border-color: gray; padding: 1 }
	.pane { flex-direction: column; overflow: hidden; height: 4 }
	.row { color: gray }
	.row.on { color: cyan; font-weight: bold }
	.menu {
		position: absolute; top: 1; left: 12; z-index: 1;
		flex-direction: column; width: 18;
		border: single; border-color: cyan; background-color: black;
	}
	.item { color: cyan }
	.hint { color: gray }
`);

const LINES = ['parser', 'canvas', 'layout', 'cascade', 'element tree', 'renderer', 'templates'];

const app = box({ class: 'app' });
const pane = box({ class: 'pane' });
for (const line of LINES) pane.append(text(line, { class: 'row' }));
app.append(pane, text('clipped, scrolled, overlaid', { class: 'hint' }));

const menu = box({ class: 'menu' });
for (const item of ['open', 'rename', 'delete']) menu.append(text(item, { class: 'item' }));

const backend = createInlineCanvas({ height: 8, width: 34 });
const restyler = new Restyler(new Cascade([sheet]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const draw = () => {
	resolveStyles(app, restyler);
	arrange(app, { height: backend.height, width: backend.width });
	backend.render((painter) => paint(app, painter));
};

for (let step = 0; step < 12; step++) {
	// the pane scrolls under the overlay, and the overlay does not move with it:
	// it is out of flow, so the scroll that moves the pane's children is not its
	pane.scrollTo(0, step % (LINES.length - 2));

	if (step === 4) app.append(menu);
	if (step === 9) menu.remove();

	draw();
	await sleep(320);
}

backend.done();
console.log('the pane clipped, the overlay floated, and neither moved the other');
