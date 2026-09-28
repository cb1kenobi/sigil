import { banner } from '../banner.tsx';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { renderToString } from '@ttylabs/sigil/element';

const show: AnyCommand = command({
	desc: 'Print a template that was written in a .tsx',

	run() {
		process.stdout.write(`${renderToString(banner(), { width: 40 })}\n`);
	},
});

export default show;
