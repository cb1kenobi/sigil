import { resolveStyles, text } from '../src/element/index.js';
import { Restyler } from '../src/style/index.js';
import { themedCascade } from '../src/theme/index.js';
import * as themes from '../src/theme/themes.js';
import { describe, expect, it } from 'vitest';

/**
 * The themes this package ships.
 *
 * What is asserted here is what makes one shippable rather than what it looks
 * like: a theme sigil hands out is drawn against a background it cannot see, by an
 * app that did not pick its colours, so the properties below are the ones whose
 * absence would make it worse than no theme at all.
 */

/** The seven roles `FRAMEWORK_CSS` defines, which is what a theme is a value for. */
const ROLES = ['accent', 'muted', 'heading', 'success', 'error', 'warn', 'info'] as const;

/** Every exported theme, by the name it is exported under. */
const SHIPPED = Object.entries(themes).filter(([, css]) => typeof css === 'string');

function styleOf(css: string, role: string, colorScheme: 'dark' | 'light') {
	const node = text('x', { class: `sigil-${role}` });
	resolveStyles(node, new Restyler(themedCascade({ colorScheme, theme: css })));
	return node.style;
}

describe('the themes sigil ships', () => {
	it('should export at least one, so the walks below are not vacuous', () => {
		// the guard every derived list in here needs: a filter that matched nothing
		// would make each `for` below pass for ever without asserting anything
		expect(SHIPPED.length).toBeGreaterThanOrEqual(3);
	});

	for (const [name, css] of SHIPPED) {
		describe(name, () => {
			it('should set every role', () => {
				// all seven, every time: switching themes *adds* a sheet rather than
				// replacing one, because a `Cascade` has `add` and no `remove` -- so a
				// role a theme leaves out silently keeps the previous theme's value
				for (const role of ROLES) {
					expect(css, role).toContain(`.sigil-${role}`);
				}
			});

			it('should name only palette colours, never a value of its own', () => {
				// the property that makes it safe on a background it cannot see. A hex
				// value is a bet on one: measured with WCAG contrast against both #000
				// and #fff, every truecolor palette anybody reaches for has entries
				// below 3:1 on one side, so there is no single value that is safe
				expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
				expect(css).not.toMatch(/\brgb\(/iu);

				for (const role of ROLES) {
					const { color } = styleOf(css, role, 'dark');

					// -1 is no colour at all, which is what a theme drawing in attributes
					// alone resolves to and is not a palette value to check
					if (color !== -1) {
						expect(color, role).toBeGreaterThanOrEqual(0);
						expect(color, role).toBeLessThanOrEqual(15);
					}
				}
			});

			it('should carry a light half wherever it de-emphasises with dim', () => {
				// SGR 2 blends the foreground *towards* the background, so it is grey on
				// black one way and grey on white the other -- and the second is the
				// unreadable parenthetical the framework's own light half exists for. A
				// theme using `dim` owes the other scheme a rule; one using a colour
				// does not, which is why this is conditional rather than required
				for (const role of ROLES) {
					if (styleOf(css, role, 'dark').dim) {
						expect(styleOf(css, role, 'light').dim, role).toBe(false);
					}
				}
			});

			it('should say something about every role in both schemes', () => {
				// a role that resolves to nothing at all in one scheme is a role whose
				// text is indistinguishable from body copy there, which is the defect a
				// light-background palette shipped on a dark terminal has
				for (const scheme of ['dark', 'light'] as const) {
					for (const role of ROLES) {
						const s = styleOf(css, role, scheme);
						const says = s.color !== -1 || s.dim || s.bold || s.inverse || s.italic || s.underline;

						expect(says, `${role} in ${scheme}`).toBe(true);
					}
				}
			});
		});
	}
});
