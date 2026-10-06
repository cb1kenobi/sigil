import { text } from '../../src/element/index.js';
import { resolveStyles } from '../../src/element/index.js';
import { renderToLines } from '../../src/element/string.js';
import {
	Cascade,
	type ColorScheme,
	DEFAULT_MEDIA,
	forcedScheme,
	luminance,
	matchesMedia,
	type MediaContext,
	parseMediaQueryList,
	parseStylesheet,
	Restyler,
	SCHEME_MIDPOINT,
	schemeForBackground,
	schemeFromEnv,
	schemeFromTerminalEnv,
	StyleError,
} from '../../src/style/index.js';
import { FRAMEWORK_CSS, themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * `prefers-color-scheme`: the one input that makes a default colour safe.
 *
 * Every default sigil ships is a bet on dark, and there was nothing an author or a
 * theme could write to make one conditional. The whole feature is: get the value,
 * put it on the media context, and let the cascade do what it already does -- so
 * most of what is asserted here is that nothing new had to be invented.
 */

describe('the media query', () => {
	const at = (scheme: ColorScheme): MediaContext => ({ ...DEFAULT_MEDIA, colorScheme: scheme });
	const query = (source: string) => [parseMediaQueryList(source)];

	it('should take light and dark', () => {
		expect(matchesMedia(query('(prefers-color-scheme: dark)'), at('dark'))).toBe(true);
		expect(matchesMedia(query('(prefers-color-scheme: dark)'), at('light'))).toBe(false);
		expect(matchesMedia(query('(prefers-color-scheme: light)'), at('light'))).toBe(true);
	});

	// the rule every keyword in this grammar follows: a property name and `inherit`
	// are already case-insensitive, and a class is not, because one is a CSS keyword
	// and the other is a name somebody chose
	it('should read the keyword in any case', () => {
		expect(matchesMedia(query('(prefers-color-scheme: LIGHT)'), at('light'))).toBe(true);
		expect(matchesMedia(query('(PREFERS-COLOR-SCHEME: light)'), at('light'))).toBe(true);
	});

	it('should join with the other features', () => {
		const wide: MediaContext = {
			colorLevel: 3,
			colorScheme: 'light',
			height: 24,
			reducedMotion: 'no-preference',
			width: 120,
		};
		expect(matchesMedia(query('(min-width: 100) and (prefers-color-scheme: light)'), wide)).toBe(
			true
		);
		expect(matchesMedia(query('(min-width: 100) and (prefers-color-scheme: dark)'), wide)).toBe(
			false
		);
	});

	// a range on a keyword means nothing, and the bare form of a feature that always
	// has a value is a query that is always true -- a rule inside one reads as
	// conditional while being unconditional, which is worse than an error
	it('should refuse a range and refuse the bare form', () => {
		expect(() => parseMediaQueryList('(min-prefers-color-scheme: light)')).toThrow(
			/takes no range/
		);
		expect(() => parseMediaQueryList('(prefers-color-scheme)')).toThrow(/needs a value/);
	});

	it('should refuse a value that is neither', () => {
		expect(() => parseMediaQueryList('(prefers-color-scheme: sepia)')).toThrow(StyleError);
		expect(() => parseMediaQueryList('(prefers-color-scheme: 1)')).toThrow(
			/expected light or dark/
		);
	});

	// dark, because that is what every default colour in this library has always been
	// a bet on: making the constant anything else would change the meaning of every
	// sheet already written against it
	it('should default to dark', () => {
		expect(DEFAULT_MEDIA.colorScheme).to.equal('dark');
	});
});

describe('the luminance threshold', () => {
	// the property rather than the digits: the boundary sits at *half* of full
	// scale, so a change to how brightness is computed fails for the right reason
	it('should read the midpoint rather than the digits', () => {
		expect(SCHEME_MIDPOINT).to.equal(255 / 2);
		expect(luminance(255, 255, 255)).to.equal(255);
		expect(luminance(0, 0, 0)).to.equal(0);
		expect(luminance(128, 128, 128)).to.equal(128);
	});

	it('should read a background either side of it', () => {
		expect(schemeForBackground(255, 255, 255)).to.equal('light');
		expect(schemeForBackground(0, 0, 0)).to.equal('dark');
		// 0x1c1c1c, which is Ghostty's default
		expect(schemeForBackground(28, 28, 28)).to.equal('dark');
		// #fdf6e3, Solarized Light's base3
		expect(schemeForBackground(253, 246, 227)).to.equal('light');
		// #002b36, Solarized Dark's base03
		expect(schemeForBackground(0, 43, 54)).to.equal('dark');
	});

	// the weighting is BT.601's, which is what makes a saturated green read as light
	// where a saturated blue of the same numeric size does not
	it('should weight the channels rather than averaging them', () => {
		expect(schemeForBackground(0, 240, 0)).to.equal('light');
		expect(schemeForBackground(0, 0, 240)).to.equal('dark');
	});

	it('should sit exactly on the boundary at the midpoint', () => {
		const grey = Math.ceil(SCHEME_MIDPOINT);
		expect(schemeForBackground(grey, grey, grey)).to.equal('light');
		expect(schemeForBackground(grey - 1, grey - 1, grey - 1)).to.equal('dark');
	});
});

describe('what the environment says', () => {
	// `COLORFGBG` is `fg;bg` with the background as a palette index. The split is
	// the one the sixteen already imply, and `8` is the interesting entry: it is
	// called bright black and it is a dark grey
	const DARK = [0, 1, 2, 3, 4, 5, 6, 8];
	const LIGHT = [7, 9, 10, 11, 12, 13, 14, 15];

	it.each(DARK)('should read a background of %i as dark', (bg) => {
		expect(schemeFromEnv({ COLORFGBG: `15;${bg}` })).to.equal('dark');
	});

	it.each(LIGHT)('should read a background of %i as light', (bg) => {
		expect(schemeFromEnv({ COLORFGBG: `0;${bg}` })).to.equal('light');
	});

	// the variable has two shapes in the wild -- `15;0` and `15;default;0` -- so the
	// background is the last field rather than the second
	it('should take the last field, not the second', () => {
		expect(schemeFromEnv({ COLORFGBG: '15;default;0' })).to.equal('dark');
		expect(schemeFromEnv({ COLORFGBG: '0;default;15' })).to.equal('light');
	});

	// a field that is not a palette index is no answer rather than a guess, which is
	// the rule an empty environment variable already follows in the parser
	it('should read nothing out of what it cannot read', () => {
		expect(schemeFromEnv({})).toBeUndefined();
		expect(schemeFromEnv({ COLORFGBG: '' })).toBeUndefined();
		expect(schemeFromEnv({ COLORFGBG: '15;default' })).toBeUndefined();
		expect(schemeFromEnv({ COLORFGBG: 'nonsense' })).toBeUndefined();
		expect(schemeFromEnv({ COLORFGBG: '15;99' })).toBeUndefined();
		expect(schemeFromEnv({ COLORFGBG: '15;-1' })).toBeUndefined();
	});

	// the two halves are separate functions because they sit at different places in
	// the chain: a reply beats `COLORFGBG` and must not beat the user's override, and
	// reading both through one call is what put a reply above it for one commit
	it('should read the two sources separately as well as together', () => {
		const env = { COLORFGBG: '15;0', SIGIL_COLOR_SCHEME: 'light' };
		expect(forcedScheme(env)).to.equal('light');
		expect(schemeFromTerminalEnv(env)).to.equal('dark');
		expect(schemeFromEnv(env)).to.equal('light');
		expect(forcedScheme({ COLORFGBG: '15;0' })).toBeUndefined();
		expect(schemeFromTerminalEnv({ SIGIL_COLOR_SCHEME: 'light' })).toBeUndefined();
	});

	// what the *user* said beats what the terminal happens to report, which is the
	// direction `NO_COLOR` sets the precedent for -- and it is the only recourse for
	// a terminal that sets no `COLORFGBG` and answers no OSC 11
	it('should let the user override the terminal', () => {
		expect(schemeFromEnv({ COLORFGBG: '15;0', SIGIL_COLOR_SCHEME: 'light' })).to.equal('light');
		expect(schemeFromEnv({ COLORFGBG: '0;15', SIGIL_COLOR_SCHEME: 'dark' })).to.equal('dark');
		expect(schemeFromEnv({ SIGIL_COLOR_SCHEME: ' DARK ' })).to.equal('dark');
		// and something that is neither falls through rather than deciding
		expect(schemeFromEnv({ COLORFGBG: '0;15', SIGIL_COLOR_SCHEME: 'sepia' })).to.equal('light');
	});
});

describe('the framework sheet', () => {
	// the classes the help screen really emits: de-emphasis is the .sigil-muted
	// role now, which is the one place the light half lives rather than one rule
	// per component that wanted it
	const noteAt = (scheme: ColorScheme) => {
		const node = text('x', { class: 'sigil-help-note sigil-muted' });
		resolveStyles(node, new Restyler(themedCascade({ colorScheme: scheme })));
		return node.style;
	};

	/**
	 * The half that proves the feature, and it is smaller than it looks.
	 *
	 * Every colour in that sheet is a palette index, and the basic sixteen are
	 * whatever the user's terminal theme says they are -- so there is nothing in them
	 * to fix conditionally, which is the rule working rather than a gap. What does
	 * not follow the theme is `dim`: SGR 2 blends the foreground *towards the
	 * background*, so it is grey on black one way and grey on white the other, and
	 * the second is the unreadable parenthetical this was asked for.
	 */
	it('should carry de-emphasis on an attribute for dark and a colour for light', () => {
		expect(noteAt('dark').dim).toBe(true);
		const light = noteAt('light');
		expect(light.dim).toBe(false);
		// gray is palette index 8, which a light theme renders dark because it has to
		// render text in it
		expect(light.color).toBe(8);
	});

	it('should leave a palette colour alone in both', () => {
		for (const scheme of ['dark', 'light'] as const) {
			const node = text('!', { class: 'sigil-symbol is-error sigil-error' });
			resolveStyles(node, new Restyler(themedCascade({ colorScheme: scheme })));
			expect(node.style.color, scheme).toBe(1);
		}
	});

	// the media context is set by `themedCascade()` rather than left at the frozen
	// default, because that is the one place every built-in's cascade comes from --
	// without it a light terminal would get the dark half of the sheet through the
	// door nobody watched
	it('should read the scheme out of the environment when nobody said', () => {
		// the env is forced rather than read back, which is what the first version of
		// this did: with neither variable set, `schemeFromEnv()` is `undefined` and the
		// expectation collapses to the `'dark'` the frozen default already is -- so the
		// whole read could be replaced with a literal and the test stayed green
		const before = { ...process.env };
		try {
			delete process.env.SIGIL_COLOR_SCHEME;
			process.env.COLORFGBG = '0;15';
			expect(themedCascade().media.colorScheme).to.equal('light');

			process.env.SIGIL_COLOR_SCHEME = 'dark';
			expect(themedCascade().media.colorScheme).to.equal('dark');

			delete process.env.COLORFGBG;
			delete process.env.SIGIL_COLOR_SCHEME;
			expect(themedCascade().media.colorScheme).to.equal('dark');
		} finally {
			delete process.env.COLORFGBG;
			delete process.env.SIGIL_COLOR_SCHEME;
			Object.assign(process.env, before);
		}
	});
});

describe('renderToString', () => {
	const sheet = parseStylesheet(`
		text { color: red }
		@media (prefers-color-scheme: light) { text { color: blue } }
	`);

	// a value the caller may pass, never one this path goes and asks for: a string
	// being built has no screen, and the media queries are the caller's apart from
	// the width and the colour depth this call is the authority on
	it('should take a scheme from the caller', () => {
		const dark = renderToLines(text('x'), {
			cascade: new Cascade([sheet]),
			colorLevel: 1,
			colorScheme: 'dark',
			width: 4,
		});
		const light = renderToLines(text('x'), {
			cascade: new Cascade([sheet]),
			colorLevel: 1,
			colorScheme: 'light',
			width: 4,
		});
		expect(dark[0]).not.to.equal(light[0]);
		expect(dark[0]).to.contain('31m');
		expect(light[0]).to.contain('34m');
	});

	it("should leave the cascade's own answer alone when nobody said", () => {
		const cascade = new Cascade([sheet]);
		cascade.media = { ...cascade.media, colorScheme: 'light' };
		expect(renderToLines(text('x'), { cascade, colorLevel: 1, width: 4 })[0]).to.contain('34m');
		// and put back exactly as it was found, which is the rule this path already
		// keeps for the whole media context
		expect(cascade.media.colorScheme).to.equal('light');
	});
});

describe('the light half and the dark half', () => {
	/**
	 * A `dim` in one and not the other is the whole bug this feature is for.
	 *
	 * Derived from the sheet rather than written out, because a list of five class
	 * names beside a sheet of the same five is a list that goes stale the first time
	 * somebody adds a dim parenthetical -- and a rule added to the dark half with no
	 * light twin is exactly the unreadable-on-white case, arriving silently.
	 */
	it('should carry a light rule for every dim rule', () => {
		const [dark, light] = FRAMEWORK_CSS.split('@media (prefers-color-scheme: light) {');
		const dimmed = (css: string) =>
			new Set([...css.matchAll(/^\s*(\.[\w.-]+)\s*\{[^}]*\bdim\s*:/gm)].map((m) => m[1]));

		expect(dimmed(dark).size, 'nothing in the dark half is dim any more').toBeGreaterThan(0);
		expect([...dimmed(light)].sort()).toEqual([...dimmed(dark)].sort());
	});

	// the light half is at origin `framework`, so it is beaten by an ordinary rule in
	// an app's own sheet -- no `!important` and no specificity contest, which is the
	// promise the whole theme origin exists to keep
	it('should be overridable by an app with an ordinary rule', () => {
		const node = text('x', { class: 'sigil-help-note sigil-muted' });
		resolveStyles(
			node,
			new Restyler(
				themedCascade({ colorScheme: 'light', sheets: ['.sigil-help-note { color: magenta }'] })
			)
		);
		expect(node.style.color).toBe(5);
	});

	// and a theme sits between the two, so it beats the light half and loses to the app
	it('should be overridable by a theme', () => {
		const node = text('x', { class: 'sigil-help-note sigil-muted' });
		resolveStyles(
			node,
			new Restyler(
				themedCascade({ colorScheme: 'light', theme: '.sigil-help-note { color: green }' })
			)
		);
		expect(node.style.color).toBe(2);
	});
});
