import {
	Cascade,
	cells,
	DEFAULT_MEDIA,
	forcedMotion,
	matchesMedia,
	type MediaContext,
	parseMediaQueryList,
	parseStylesheet,
	StyleError,
} from '../../src/style/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * `@keyframes`, and the media feature that says whether anything should move.
 */

describe('reading @keyframes', () => {
	it('should read from, to, and a percentage', () => {
		const sheet = parseStylesheet(`
			@keyframes slide {
				from { left: 0 }
				50% { left: 5 }
				to { left: 10 }
			}
		`);
		const frames = sheet.keyframes.get('slide');
		expect(frames?.map((frame) => frame.offset)).toEqual([0, 0.5, 1]);
		expect(frames?.[1].declarations).toEqual([['left', cells(5)]]);
	});

	it('should read a list of selectors as one block at several offsets', () => {
		const sheet = parseStylesheet(
			'@keyframes pulse { 0%, 100% { bold: false } 50% { bold: true } }'
		);
		const frames = sheet.keyframes.get('pulse');
		expect(frames?.map((frame) => frame.offset)).toEqual([0, 0.5, 1]);
		expect(frames?.[0].declarations).toEqual([['bold', false]]);
		expect(frames?.[2].declarations).toEqual([['bold', false]]);
	});

	it('should sort the stops, however they were written', () => {
		const sheet = parseStylesheet(
			'@keyframes x { to { left: 2 } from { left: 0 } 10% { left: 1 } }'
		);
		expect(sheet.keyframes.get('x')?.map((frame) => frame.offset)).toEqual([0, 0.1, 1]);
	});

	it('should expand a shorthand, because a keyframe is ordinary declarations', () => {
		const sheet = parseStylesheet('@keyframes p { to { padding: 1 2 } }');
		expect(sheet.keyframes.get('p')?.[0].declarations).toEqual([
			['paddingTop', 1],
			['paddingRight', 2],
			['paddingBottom', 1],
			['paddingLeft', 2],
		]);
	});

	it('should read a comment inside one, like anywhere else in a sheet', () => {
		const sheet = parseStylesheet('@keyframes x { /* why */ to { left: 1 /* here */ } }');
		expect(sheet.keyframes.get('x')?.[0].declarations).toEqual([['left', cells(1)]]);
	});

	it('should replace a name declared twice rather than merging it', () => {
		// which is CSS: the later `@keyframes` of a name is the animation, whole
		const sheet = parseStylesheet(
			'@keyframes x { from { left: 0 } to { left: 9 } } @keyframes x { to { left: 1 } }'
		);
		expect(sheet.keyframes.get('x')?.length).toBe(1);
		expect(sheet.keyframes.get('x')?.[0].declarations).toEqual([['left', cells(1)]]);
	});

	it('should refuse a cascade keyword, which has nothing here to resolve against', () => {
		expect(() => parseStylesheet('@keyframes x { to { color: inherit } }')).toThrow(/inherit/);
	});

	it('should refuse !important, which has no cascade here to invert', () => {
		// asserted on the *reason* rather than on the word: with the guard gone the
		// value parser refuses `red !important` anyway and its message happens to
		// contain "important", so a looser assertion passed either way and said
		// nothing about this rule at all
		expect(() => parseStylesheet('@keyframes x { to { color: red !important } }')).toThrow(
			/means nothing inside @keyframes/
		);
	});

	it('should refuse an unknown property where it was written', () => {
		expect(() => parseStylesheet('@keyframes x { to { wiggle: 1 } }')).toThrow(StyleError);
	});

	it('should refuse a selector that is not an offset', () => {
		expect(() => parseStylesheet('@keyframes x { middle { left: 1 } }')).toThrow(
			/keyframe selector/
		);
		expect(() => parseStylesheet('@keyframes x { 120% { left: 1 } }')).toThrow(/past the end/);
	});

	it('should refuse a name that is not an identifier', () => {
		expect(() => parseStylesheet('@keyframes { to { left: 1 } }')).toThrow(/@keyframes name/);
		expect(() => parseStylesheet('@keyframes 2fast { to { left: 1 } }')).toThrow(/@keyframes name/);
	});

	it('should say which line an unclosed block was on', () => {
		expect(() => parseStylesheet('\n\n@keyframes x { to { left: 1 }')).toThrow(/line 3/);
	});

	it('should sit inside @layer and not inside @media', () => {
		// a layer has nothing to apply to a block that is matched by name, so it is
		// ignored; a media query would need a rule for which of two matching blocks
		// of one name wins, which is a resolution order nothing needs yet
		const layered = parseStylesheet('@layer utilities { @keyframes x { to { left: 1 } } }');
		expect(layered.keyframes.has('x')).toBe(true);
		expect(layered.rules).toEqual([]);

		expect(() =>
			parseStylesheet('@media (min-width: 10) { @keyframes x { to { left: 1 } } }')
		).toThrow(/cannot sit inside @media/);
	});

	it('should still name the at-rules there are when one is unknown', () => {
		expect(() => parseStylesheet('@supports (x) { }')).toThrow(/@layer, @media and @keyframes/);
	});

	it('should leave a sheet with none with an empty map rather than nothing', () => {
		expect(parseStylesheet('text { color: red }').keyframes.size).toBe(0);
	});
});

describe('resolving an animation name', () => {
	const sheet = (css: string, origin: 'app' | 'framework' | 'theme') =>
		parseStylesheet(css, { origin });

	it('should answer undefined for a name nothing declares', () => {
		expect(new Cascade([]).keyframes('nope')).toBeUndefined();
	});

	it('should let a later origin win', () => {
		const cascade = new Cascade([
			sheet('@keyframes x { to { left: 9 } }', 'app'),
			sheet('@keyframes x { to { left: 1 } }', 'framework'),
		]);
		// added second but at the earlier origin, so the app's is the answer
		expect(cascade.keyframes('x')?.[0].declarations).toEqual([['left', cells(9)]]);
	});

	it('should break a tie within an origin on the order sheets were added', () => {
		const cascade = new Cascade([
			sheet('@keyframes x { to { left: 1 } }', 'app'),
			sheet('@keyframes x { to { left: 2 } }', 'app'),
		]);
		expect(cascade.keyframes('x')?.[0].declarations).toEqual([['left', cells(2)]]);
	});

	it('should forget what it worked out when a sheet is added', () => {
		// a theme swapped at runtime is a sheet added, and a map kept across that
		// would answer for a sheet nobody has
		const cascade = new Cascade([sheet('@keyframes x { to { left: 1 } }', 'app')]);
		expect(cascade.keyframes('x')?.[0].declarations).toEqual([['left', cells(1)]]);
		cascade.add(sheet('@keyframes x { to { left: 7 } }', 'app'));
		expect(cascade.keyframes('x')?.[0].declarations).toEqual([['left', cells(7)]]);
	});
});

describe('the prefers-reduced-motion media feature', () => {
	const at = (reducedMotion: 'no-preference' | 'reduce'): MediaContext => ({
		...DEFAULT_MEDIA,
		reducedMotion,
	});
	const query = (text: string) => [parseMediaQueryList(text)];

	it('should match the value the context carries', () => {
		expect(matchesMedia(query('(prefers-reduced-motion: reduce)'), at('reduce'))).toBe(true);
		expect(matchesMedia(query('(prefers-reduced-motion: reduce)'), at('no-preference'))).toBe(
			false
		);
		expect(
			matchesMedia(query('(prefers-reduced-motion: no-preference)'), at('no-preference'))
		).toBe(true);
	});

	it('should not read the scheme by mistake, now that there are two keyword features', () => {
		// the field to compare comes off the same table the parser read the values
		// from, so this is what fails if the two come apart
		const light: MediaContext = { ...DEFAULT_MEDIA, colorScheme: 'light', reducedMotion: 'reduce' };
		expect(matchesMedia(query('(prefers-color-scheme: light)'), light)).toBe(true);
		expect(matchesMedia(query('(prefers-reduced-motion: reduce)'), light)).toBe(true);
		expect(matchesMedia(query('(prefers-color-scheme: dark)'), light)).toBe(false);
		expect(matchesMedia(query('(prefers-reduced-motion: no-preference)'), light)).toBe(false);
	});

	it('should default to no-preference, which is CSS and is not a guess at the terminal', () => {
		expect(DEFAULT_MEDIA.reducedMotion).toBe('no-preference');
	});

	it('should read the value in any case', () => {
		expect(matchesMedia(query('(PREFERS-REDUCED-MOTION: REDUCE)'), at('reduce'))).toBe(true);
	});

	it('should refuse a range and the bare form', () => {
		expect(() => parseMediaQueryList('(min-prefers-reduced-motion: reduce)')).toThrow(/no range/);
		expect(() => parseMediaQueryList('(prefers-reduced-motion)')).toThrow(/needs a value/);
	});

	it('should refuse a value that is neither', () => {
		expect(() => parseMediaQueryList('(prefers-reduced-motion: some)')).toThrow(
			/expected no-preference or reduce/
		);
	});

	it('should join with the other features', () => {
		expect(
			matchesMedia(query('(min-width: 10) and (prefers-reduced-motion: reduce)'), {
				...at('reduce'),
				width: 100,
			})
		).toBe(true);
	});
});

describe('a built-in cascade', () => {
	it('should read the motion override, the way it reads the scheme', () => {
		// `themedCascade()` is the one place every built-in's cascade comes from, so
		// a sheet with a `prefers-reduced-motion` half would otherwise resolve at
		// the frozen default for every table and every help screen there is
		const before = process.env.SIGIL_REDUCED_MOTION;
		try {
			process.env.SIGIL_REDUCED_MOTION = '1';
			expect(themedCascade().media.reducedMotion).toBe('reduce');
			delete process.env.SIGIL_REDUCED_MOTION;
			expect(themedCascade().media.reducedMotion).toBe('no-preference');
			expect(themedCascade({ reducedMotion: 'reduce' }).media.reducedMotion).toBe('reduce');
		} finally {
			if (before === undefined) {
				delete process.env.SIGIL_REDUCED_MOTION;
			} else {
				process.env.SIGIL_REDUCED_MOTION = before;
			}
		}
	});
});

describe('the reduced-motion override', () => {
	it('should read the vocabulary a boolean property reads, plus the feature keywords', () => {
		for (const raw of ['reduce', '1', 'on', 'yes', 'true', 'REDUCE']) {
			expect(forcedMotion({ SIGIL_REDUCED_MOTION: raw }), raw).toBe('reduce');
		}
		for (const raw of ['no-preference', '0', 'off', 'no', 'false']) {
			expect(forcedMotion({ SIGIL_REDUCED_MOTION: raw }), raw).toBe('no-preference');
		}
	});

	it('should read an empty or absent variable as nobody having said', () => {
		expect(forcedMotion({})).toBeUndefined();
		expect(forcedMotion({ SIGIL_REDUCED_MOTION: '' })).toBeUndefined();
		expect(forcedMotion({ SIGIL_REDUCED_MOTION: '  ' })).toBeUndefined();
	});

	it('should fall through on a value that is neither rather than deciding', () => {
		expect(forcedMotion({ SIGIL_REDUCED_MOTION: 'maybe' })).toBeUndefined();
	});
});
