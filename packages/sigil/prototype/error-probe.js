import { createRoot } from '@ttylabs/sigil/renderer';
import { Show } from '@ttylabs/sigil/renderer';
import { ui } from '@ttylabs/sigil/template';

const cases = [
	['unknown host type', () => ui`<box><txet>oops</txet></box>`],
	['a component named rather than interpolated', () => ui`<box><Show/></box>`],
	['unclosed tag', () => ui`<box><text>hello</box>`],
	['mismatched close', () => ui`<box><text>hello</text></boxx>`],
	['two roots', () => ui`<text>a</text><text>b</text>`],
	[
		'a non-thunk where Show wants one',
		() => ui`<${Show} when=${'nope'}>${() => ui`<text>x</text>`}</>`,
	],
];

for (const [name, build] of cases) {
	try {
		createRoot((dispose) => {
			build();
			dispose();
		});
		console.log(`${name}\n  -> no error`);
	} catch (error) {
		console.log(`${name}\n  -> ${error.message}`);
	}
}
