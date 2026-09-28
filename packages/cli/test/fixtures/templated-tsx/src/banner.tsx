import type { Element } from '@ttylabs/sigil/element';
import { ui } from '@ttylabs/sigil/template';

/**
 * A `ui` template in a `.tsx`, which is the module kind the build's `id` filter
 * used to skip.
 *
 * JSX is the canonical syntax and the tag is the zero-build one, so the two live
 * side by side in one app -- which makes a `.tsx` a *likely* place for the tag
 * rather than an exotic one. oxc reads the language off the filename, so this
 * file is parsed as JSX whether or not it holds any, and the extension is
 * therefore the right thing to gate on.
 *
 * There is no source-run twin of this fixture, and that is a rule rather than an
 * omission: node cannot load a `.tsx` at all -- `Unknown file extension` -- so
 * an app with one is a built app by construction.
 *
 * It holds no JSX *element*, deliberately, and that is scope rather than a
 * limitation: `test/fixtures/jsx/` is the fixture for what the JSX transform
 * compiles against, and one fixture pinning two unrelated things is one that
 * cannot say which of them broke.
 */
export function banner(): Element {
	return ui`<text class="banner">a template from a .tsx</text>`;
}
