import { command, type AnyCommand } from '@ttylabs/sigil';
import { renderToString } from '@ttylabs/sigil/element';
import { Cascade, utilitySheet } from '@ttylabs/sigil/style';
import { ui } from '@ttylabs/sigil/template';

/**
 * A view that is a `ui` template *and* asks for the utility sheet, so that both
 * build transforms rewrite one module and the two have to agree about what the
 * module ends up being.
 */
function view(who: string) {
	return ui`<box class="flex-col gap-1">
		<text class="bold text-green">${who}</text>
		<text class="dim">from a template and a shaken sheet</text>
	</box>`;
}

const tpl: AnyCommand = command({
	args: [{ desc: 'Who to greet', name: '[who]' }],
	desc: 'Draw a template styled with utility classes',

	run({ argv }) {
		process.stdout.write(
			`${renderToString(view(String(argv.who ?? 'world')), {
				cascade: new Cascade([utilitySheet()]),
				colorLevel: 3,
				width: 40,
			})}\n`
		);
	},
});

export default tpl;
