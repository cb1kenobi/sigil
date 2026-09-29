import { command, type AnyCommand } from '@ttylabs/sigil';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { Cascade, utilitySheet } from '@ttylabs/sigil/style';

/** The classes this draws with, written out so the scan can see them. */
function panel(label: string) {
	return box(
		{ class: 'flex-col p-1 border' },
		text('Failed', { class: 'bold text-red' }),
		// a class built from a piece, so that the scan has an open-ended token and
		// has to keep every `text-*` rule rather than only the one written out
		text(label, { class: `text-${label}` })
	);
}

const show: AnyCommand = command({
	desc: 'Draw a panel with utility classes',

	run() {
		process.stdout.write(
			`${renderToString(panel('cyan'), {
				cascade: new Cascade([utilitySheet()]),
				colorLevel: 3,
				width: 24,
			})}\n`
		);
	},
});

export default show;
