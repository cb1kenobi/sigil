import { Panel } from '../panel.tsx';
import { command, type AnyCommand } from '@ttylabs/sigil';
import { renderToString } from '@ttylabs/sigil/element';

const greet: AnyCommand = command({
	args: [{ desc: 'Who to greet', name: '[who]' }],
	desc: 'Greet somebody with a JSX element',

	run({ argv }) {
		process.stdout.write(
			`${renderToString(Panel({ who: String(argv.who ?? 'world') }), { width: 40 })}\n`
		);
	},
});

export default greet;
