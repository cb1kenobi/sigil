import { Panel } from '../panel.tsx';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { renderToString } from '@ttylabs/sigil/element';

const greet: AnyCommand = command({
	desc: 'Greet somebody with JSX the development transform compiled',

	run() {
		process.stdout.write(`${renderToString(Panel({ who: 'world' }), { width: 40 })}\n`);
	},
});

export default greet;
