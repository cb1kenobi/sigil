import { command, type AnyCommand } from '@ttylabs/sigil';
import { renderToString } from '@ttylabs/sigil/element';
import { ui } from '@ttylabs/sigil/template';

/** A greeting, written as a template rather than as factory calls. */
function greeting(who: string) {
	return ui`<box flex-direction="column">
		<text class="hello">Hello, ${who}!</text>
		<text>from a compiled template</text>
	</box>`;
}

const greet: AnyCommand = command({
	args: [{ desc: 'Who to greet', name: '[who]' }],
	desc: 'Greet somebody with a template',

	run({ argv }) {
		process.stdout.write(
			`${renderToString(greeting(String(argv.who ?? 'world')), { width: 40 })}\n`
		);
	},
});

export default greet;
