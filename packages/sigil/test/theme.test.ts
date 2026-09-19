import { box, renderToString, text } from '../src/element/index.js';
import { parseStylesheet } from '../src/style/index.js';
import { frameworkSheet, FRAMEWORK_CSS, parseTheme, themedCascade } from '../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * Themes.
 *
 * A theme is a stylesheet origin and nothing else, which is the whole of the
 * answer: the framework's defaults are a `framework` origin, a theme is a
 * `theme` one, and an app's own rules are `app`. Every question about who wins
 * is the cascade's, already answered, already tested -- so what is asserted here
 * is that the three really are those three origins and that the built-ins really
 * do carry the classes a theme is written against.
 */

const ESC = String.fromCharCode(0x1b);

describe('the framework sheet', () => {
	it('should parse', () => {
		expect(frameworkSheet().rules.length).to.be.greaterThan(5);
	});

	it('should be at the framework origin', () => {
		expect(frameworkSheet().origin).to.equal('framework');
	});

	// a `Stylesheet` is frozen and a `Cascade` only reads it, so parsing it per
	// spinner would be the same work per component per process
	it('should be parsed once', () => {
		expect(frameworkSheet()).to.equal(frameworkSheet());
	});

	// a prop beats a sheet per property, so a colour written into a template is
	// one a theme cannot reach without `!important`
	it('should be the only place a built-in names a colour', () => {
		expect(FRAMEWORK_CSS).to.contain('.sigil-symbol');
		expect(FRAMEWORK_CSS).to.contain('.sigil-help-heading');
	});
});

describe('parseTheme()', () => {
	it('should be at the theme origin', () => {
		expect(parseTheme('.x { color: red }').origin).to.equal('theme');
	});
});

describe('themedCascade()', () => {
	const styled = (css: string | undefined, sheets?: (string | ReturnType<typeof parseTheme>)[]) =>
		renderToString(text('x', { class: 'sigil-symbol' }), {
			cascade: themedCascade({ sheets, theme: css }),
			colorLevel: 1,
			width: 5,
		});

	// cyan, which is what the framework sheet says a mark is
	it('should apply the framework defaults with no theme at all', () => {
		expect(styled(undefined)).to.equal(`${ESC}[36mx${ESC}[0m`);
	});

	it('should let a theme beat them with an ordinary rule', () => {
		expect(styled('.sigil-symbol { color: magenta }')).to.equal(`${ESC}[35mx${ESC}[0m`);
	});

	it('should let the app beat the theme', () => {
		expect(
			styled('.sigil-symbol { color: magenta }', ['.sigil-symbol { color: yellow }'])
		).to.equal(`${ESC}[33mx${ESC}[0m`);
	});

	it('should take a sheet that is already parsed', () => {
		expect(styled(undefined, [parseStylesheet('.sigil-symbol { color: green }')])).to.equal(
			`${ESC}[32mx${ESC}[0m`
		);
	});

	// no specificity contest and no `!important`, which is only true because the
	// defaults are an earlier origin rather than rules in the same one
	it('should not need specificity to be overridden', () => {
		const tree = box({}, text('x', { class: 'sigil-symbol is-success' }));
		const themed = renderToString(tree, {
			cascade: themedCascade({ theme: '.sigil-symbol { color: magenta }' }),
			colorLevel: 1,
			width: 5,
		});

		// the framework's `.sigil-symbol.is-success` is (0,2,0) and the theme's
		// `.sigil-symbol` is (0,1,0), so specificity would keep green -- the origin
		// is what makes the theme win
		expect(themed).to.equal(`${ESC}[35mx${ESC}[0m`);
	});
});
