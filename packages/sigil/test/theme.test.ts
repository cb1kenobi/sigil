import { table } from '../src/components/index.js';
import { box, renderToString, text } from '../src/element/index.js';
import { Cascade, parseStylesheet, type Stylesheet } from '../src/style/index.js';
import { frameworkSheet, FRAMEWORK_CSS, parseTheme, themedCascade } from '../src/theme/index.js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
		// the roles, which is where the colours are. The component classes are in
		// here too, in the comment that lists them as hooks, so asserting one of
		// those would pass off a line of prose as a rule
		expect(FRAMEWORK_CSS).to.contain('.sigil-accent');
		expect(FRAMEWORK_CSS).to.contain('.sigil-muted');
	});

	/**
	 * The role layer, as an invariant rather than as a list of examples.
	 *
	 * Every declaration a built-in shares with another built-in is on a role, so
	 * an app restyles its whole surface with one rule instead of finding the six
	 * component classes that each said `dim`. What makes that worth a test rather
	 * than a comment is that the regression is silent and gradual: one
	 * `.sigil-prompt-hint { dim: true }` added back here is a declaration the
	 * light half does not cover, and it looks like every other rule in the file.
	 *
	 * The four exceptions are declared rather than discovered. `.sigil-caret` is
	 * `inverse` and no role is inversion. `.sigil-scroll-track` is the one grey
	 * here that is not de-emphasised *text*, so it must not be `.sigil-muted` --
	 * that role is `dim` on a dark terminal, and a dim track is not a track.
	 * `.sigil-debug` is a **background** rather than a foreground: no role is one,
	 * and the debug pane is the one built-in drawn over the app's own content, so
	 * without it the app shows through between its words. And
	 * `.sigil-qrcode-paint` is a *pair* -- a foreground and a background together --
	 * because a scanner expects dark modules on a light one and a terminal is
	 * usually the other way round, so the code paints both of its colours rather
	 * than borrowing either: neither of them is de-emphasis, a state or an accent,
	 * so no role could carry them.
	 */
	it('should declare on a role, bar four exceptions that say why', () => {
		const ROLES = [
			'.sigil-accent',
			'.sigil-muted',
			'.sigil-heading',
			'.sigil-success',
			'.sigil-error',
			'.sigil-warn',
			'.sigil-info',
		];
		const EXCEPTIONS = [
			'.sigil-caret',
			'.sigil-debug',
			'.sigil-qrcode-paint',
			'.sigil-scroll-track',
		];

		// the selectors that carry a declaration, read off the parsed sheet rather
		// than off the source, so a comment cannot be mistaken for a rule
		const declaring = new Set(
			frameworkSheet()
				.rules.filter((rule) => rule.declarations.length > 0)
				.flatMap((rule) => rule.selectors.map((selector) => selector.source))
		);

		expect([...declaring].sort()).to.deep.equal([...ROLES, ...EXCEPTIONS].sort());
	});

	/**
	 * The sheet is the vocabulary, asserted rather than promised.
	 *
	 * Its own doc says to "read it as the list of names a theme may restyle", and
	 * most of those names carry no rule -- they are in the comment that lists them
	 * as hooks. A class with no rule is still a hook, and a built-in that draws
	 * with one the comment does not name is a hook nobody can find: nothing in a
	 * build catches it, because a class is a string in a props object.
	 *
	 * Over `src/components/` and `src/help/` together, which is every built-in.
	 * The registry generator already extracts a component's classes the same way,
	 * so this is the same read asked as an invariant. Found by a sabotage of the
	 * palette's own entry in the comment, which failed nothing.
	 */
	it('should name every class a built-in draws with', () => {
		const here = dirname(fileURLToPath(import.meta.url));
		const found = new Set<string>();

		/** Every `sigil-*` class a source under `dir` mentions. */
		function walk(dir: string): void {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					walk(path);
				} else if (entry.name.endsWith('.ts')) {
					for (const [cls] of readFileSync(path, 'utf8').matchAll(/sigil-[a-z-]+[a-z]/g)) {
						found.add(cls);
					}
				}
			}
		}

		for (const dir of ['components', 'help']) {
			walk(join(here, '..', 'src', dir));
		}

		// a glob that matches nothing passes every assertion under it
		expect(found.size).toBeGreaterThan(40);

		// the sheet's own names as whole tokens rather than as substrings, which a
		// sabotage had to say: `FRAMEWORK_CSS.includes('sigil-palette')` is true of
		// a sheet naming only `.sigil-palette-list`, because the short name is a
		// prefix of every longer one beside it -- so taking the host's own class
		// out of the vocabulary comment left this green. Read with the same pattern
		// the walk uses, so the two cannot disagree about what a class name is
		const named = new Set([...FRAMEWORK_CSS.matchAll(/sigil-[a-z-]+[a-z]/g)].map(([cls]) => cls));

		const missing = [...found].filter((cls) => !named.has(cls)).sort();
		expect(missing, 'classes a built-in draws with and the sheet does not name').to.deep.equal([]);
	});
});

describe('parseTheme()', () => {
	it('should be at the theme origin', () => {
		expect(parseTheme('.x { color: red }').origin).to.equal('theme');
	});
});

describe('themedCascade()', () => {
	const styled = (css: string | undefined, sheets?: (string | ReturnType<typeof parseTheme>)[]) =>
		// the classes a component really emits: a role carries the colour and the
		// component class is the narrower hook beside it, so a node wearing only one
		// of the two is a node no built-in builds
		renderToString(text('x', { class: 'sigil-symbol sigil-accent' }), {
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

	/*
	 * The three origins, in the one arrangement that can tell the origin axis from
	 * source order.
	 *
	 * `themedCascade()` pushes framework, then theme, then the app's own sheets --
	 * which is origin order, so within anything it builds the two axes always agree
	 * and no assertion over one can say which did the work. The rules are all
	 * `(0,1,0)` on one role, so specificity cannot either. Added here in **reverse**
	 * source order, the app's colour is the answer only if origin decides; sorting
	 * by source order hands it to the framework.
	 *
	 * The test this replaces asserted a theme beating a compound `(0,2,0)` component
	 * rule, and both halves of that had stopped being true: the role vocabulary
	 * deleted every compound colour rule from the sheet, and the node it built
	 * carried `sigil-symbol is-success` rather than a role -- so nothing in the
	 * framework sheet matched it at all and the theme's rule was uncontested. It
	 * passed with the origins inverted, which is a test saying nothing.
	 */
	it('should let a later origin beat an earlier one added after it', () => {
		const tree = box({}, text('x', { class: 'sigil-error' }));
		const app = parseStylesheet('.sigil-error { color: blue }');
		const theme = parseTheme('.sigil-error { color: magenta }');

		const over = (...sheets: Stylesheet[]) =>
			renderToString(tree, { cascade: new Cascade(sheets), colorLevel: 1, width: 5 });

		// app beats theme beats framework, with the framework's own sheet last in
		// source order every time
		expect(over(app, theme, frameworkSheet())).to.equal(`${ESC}[34mx${ESC}[0m`);
		expect(over(theme, frameworkSheet())).to.equal(`${ESC}[35mx${ESC}[0m`);
		expect(over(frameworkSheet())).to.equal(`${ESC}[31mx${ESC}[0m`);
	});
});

describe('a built-in drawn through a theme', () => {
	it('should take its colours from the sheet', () => {
		const out = table([{ name: 'a' }], {
			colorLevel: 1,
			theme: '.sigil-table-head { color: red }',
		});

		expect(out.split('\n')[0]).to.equal(`${ESC}[1;31mname${ESC}[0m`);
	});
});
