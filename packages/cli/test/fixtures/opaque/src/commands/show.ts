import { command, type AnyCommand } from '@ttylabs/sigil';
import { box, renderToString } from '@ttylabs/sigil/element';
import { Cascade, utilitySheet } from '@ttylabs/sigil/style';

const show: AnyCommand = command({
	desc: 'Draw a box whose classes came from somewhere the scan cannot read',

	run({ argv }) {
		// every class is a value the source never spells out, which is the
		// documented unsound case and the one `build.safelist` exists for
		const classes = (argv.classes as string[] | undefined) ?? [];

		process.stdout.write(
			`${renderToString(box({ class: classes.join(' ') }), {
				cascade: new Cascade([utilitySheet()]),
				width: 20,
			})}\n`
		);
	},
});

export default show;
