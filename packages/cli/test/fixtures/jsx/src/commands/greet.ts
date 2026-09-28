import { Panel, tagged } from '../panel.tsx';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { renderToString } from '@ttylabs/sigil/element';

const greet: AnyCommand = command({
	args: [{ desc: 'Who to greet', name: '[who]' }],
	desc: 'Greet somebody with a JSX element and with a template',

	run({ argv }) {
		const who = String(argv.who ?? 'world');
		process.stdout.write(`${renderToString(Panel({ who }), { width: 40 })}\n`);
		process.stdout.write(`${renderToString(tagged(who), { width: 40 })}\n`);
	},
});

export default greet;
