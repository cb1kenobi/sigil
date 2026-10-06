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

/**
 * A theme with its `@media (min-color-level: ...)` blocks taken out.
 *
 * Brace-counted rather than matched with a pattern, because a nested block would
 * end the match early and leave half a rule behind -- which would read as the base
 * half naming a colour it does not name.
 */
function withoutRichHalf(css: string): string {
	let out = '';
	let at = 0;

	for (;;) {
		const found = css.indexOf('@media', at);

		if (found === -1) {
			return out + css.slice(at);
		}

		const open = css.indexOf('{', found);
		let depth = 0;
		let end = open;

		for (; end < css.length; end++) {
			if (css[end] === '{') depth++;
			else if (css[end] === '}' && --depth === 0) break;
		}

		// only the richer half is removed: a `prefers-color-scheme` block is part of
		// what the base half says, and dropping it would excuse a hex value in one
		const query = css.slice(found, open);

		out +=
			css.slice(at, found) + (query.includes('min-color-level') ? '' : css.slice(found, end + 1));
		at = end + 1;
	}
}

function styleOf(css: string, role: string, colorScheme: 'dark' | 'light', colorLevel = 1) {
	const cascade = themedCascade({ colorScheme, theme: css });

	// the level is set on the cascade rather than passed to it, because that is
	// what a renderer does: `colorLevel` is a media field, and the richer half of
	// each theme is a `@media (min-color-level: 2)` block keyed on it
	cascade.media = { ...cascade.media, colorLevel };

	const node = text('x', { class: `sigil-${role}` });
	resolveStyles(node, new Restyler(cascade));
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
			it('should set every role in its base half', () => {
				// all seven, every time: switching themes *adds* a sheet rather than
				// replacing one, because a `Cascade` has `add` and no `remove` -- so a
				// role a theme leaves out silently keeps the previous theme's value.
				//
				// The *base* half, because that is what a sixteen-colour terminal gets
				// and the richer one is an override on top. Asserted against the whole
				// string, a role set only inside `@media (min-color-level: 2)` passed
				// this while being absent everywhere it matters -- which a sabotage said
				// rather than a reading of it
				const base = withoutRichHalf(css);

				for (const role of ROLES) {
					expect(base, role).toContain(`.sigil-${role}`);
				}
			});

			it('should name only the basic sixteen in its base half', () => {
				// the property that makes it safe on a background it cannot see: at
				// sixteen colours a theme cannot know what it is drawn against, and
				// measured with WCAG contrast against both #000 and #fff, every
				// truecolor palette anybody reaches for has entries below 3:1 on one
				// side. An index is not a colour -- it is the user's own terminal theme
				// answering, which is the only thing that knows the background.
				//
				// Asserted on the *source* rather than on a resolved style, and that is
				// the whole reason this test is written this way: degradation happens at
				// resolve time, so asking the cascade at level 1 hands back an index
				// whatever was written -- `#ff00ff` resolves to 13 there. A guard built
				// on that can never fail, which is what a sabotage said about the first
				// version of it
				const base = withoutRichHalf(css);

				expect(base).not.toMatch(/#[0-9a-f]{3,8}\b/iu);
				expect(base).not.toMatch(/\brgb\(/iu);

				for (const [, index] of base.matchAll(/\bpalette\((\d+)\)/gu)) {
					expect(Number(index), `palette(${index})`).toBeLessThanOrEqual(15);
				}
			});

			it('should mean something by a richer half, where it has one', () => {
				// a `@media (min-color-level: 2)` block that resolves to nothing outside
				// the basic sixteen is a block doing no work, which is a thing to delete
				// rather than ship. `MONO` has none, because there is no richer version
				// of "not coloured"
				if (!css.includes('min-color-level')) {
					return;
				}

				for (const scheme of ['dark', 'light'] as const) {
					const rich = ROLES.map((role) => styleOf(css, role, scheme, 2).color);

					expect(
						rich.some((color) => color > 15),
						scheme
					).toBe(true);
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
