import { DEFAULT_COLOR, palette, rgb } from '../../src/canvas/index.js';
import {
	Cascade,
	declare,
	degradeColor,
	degradeStyle,
	oklab,
	paletteRgb,
	parseStylesheet,
} from '../../src/style/index.js';
import { describe, expect, it } from 'vitest';

/** The name of a basic colour, for a message that says what went wrong. */
const NAMES = [
	'black',
	'red',
	'green',
	'yellow',
	'blue',
	'magenta',
	'cyan',
	'white',
	'bright black',
	'bright red',
	'bright green',
	'bright yellow',
	'bright blue',
	'bright magenta',
	'bright cyan',
	'bright white',
];

const at = (color: number, level: 0 | 1 | 2 | 3) => degradeColor(color, level);

describe('the ladder', () => {
	it('should leave everything alone at truecolor', () => {
		for (const color of [rgb(1, 2, 3), palette(200), palette(4), DEFAULT_COLOR]) {
			expect(at(color, 3)).toBe(color);
		}
	});

	it('should drop colour entirely at zero', () => {
		for (const color of [rgb(255, 0, 0), palette(200), palette(4)]) {
			expect(at(color, 0)).toBe(DEFAULT_COLOR);
		}
	});

	it('should keep the terminal own colour at every level', () => {
		// not a colour we chose, it is the absence of one
		for (const level of [0, 1, 2, 3] as const) {
			expect(at(DEFAULT_COLOR, level)).toBe(DEFAULT_COLOR);
		}
	});

	it('should quantize to the cube and the grey ramp at 256', () => {
		// exact cube entries survive being quantized, which is the cheapest
		// possible check that the cube is the one xterm uses
		for (const index of [16, 21, 59, 128, 196, 231]) {
			expect(at(rgb(...paletteRgb(index)), 2)).toBe(index);
		}
		for (const index of [232, 240, 255]) {
			expect(at(rgb(...paletteRgb(index)), 2)).toBe(index);
		}
	});

	it('should never land on the basic sixteen at 256', () => {
		// those sixteen are whatever the user's theme says they are, so quantizing
		// an ordinary colour onto one makes the answer depend on a setting nothing
		// here can read. The cube and the ramp are fixed by the spec
		for (let r = 0; r < 256; r += 17) {
			for (let g = 0; g < 256; g += 51) {
				for (let b = 0; b < 256; b += 51) {
					expect(at(rgb(r, g, b), 2)).toBeGreaterThanOrEqual(16);
				}
			}
		}
		// including the ones that would obviously match: pure black and pure white
		expect(at(rgb(0, 0, 0), 2)).toBe(16);
		expect(at(rgb(255, 255, 255), 2)).toBe(231);
	});

	it('should leave a palette colour alone where the level can already emit it', () => {
		expect(at(palette(200), 2)).toBe(200);
		expect(at(palette(4), 2)).toBe(4);
		expect(at(palette(4), 1)).toBe(4);
		expect(at(palette(15), 1)).toBe(15);
	});

	it('should bring a palette colour down to the basic sixteen at 16', () => {
		expect(at(palette(196), 1)).toBe(9); // cube pure red -> bright red
		expect(at(palette(21), 1)).toBe(4); // cube pure blue -> blue, see above
		expect(at(palette(232), 1)).toBe(0); // darkest grey -> black
		// #eeeeee is nearer xterm's white (#e5e5e5) than its bright white (#ffffff)
		expect(at(palette(255), 1)).toBe(7);
	});
});

describe('matching at sixteen colours', () => {
	const expectBasic = (color: number, want: number) => {
		const got = at(color, 1);
		expect(`${NAMES[got]} (${got})`, `for ${color}`).toBe(`${NAMES[want]} (${want})`);
	};

	it('should match the obvious ones', () => {
		expectBasic(rgb(255, 0, 0), 9);
		expectBasic(rgb(0, 255, 0), 10);
		// #0000ff is nearer xterm's blue (#0000ee) than its bright blue (#5c5cff)
		expectBasic(rgb(0, 0, 255), 4);
		expectBasic(rgb(255, 255, 255), 15);
		expectBasic(rgb(0, 0, 0), 0);
		expectBasic(rgb(255, 255, 0), 11);
		expectBasic(rgb(0, 255, 255), 14);
		expectBasic(rgb(255, 0, 255), 13);
	});

	it('should tell a dark one from its bright twin', () => {
		expectBasic(rgb(0xcd, 0, 0), 1);
		expectBasic(rgb(0, 0xcd, 0), 2);
		expectBasic(rgb(0x80, 0, 0), 1);
	});

	it('should put a mid grey on the grey, not on a colour', () => {
		expectBasic(rgb(127, 127, 127), 8);
		expectBasic(rgb(30, 30, 30), 0);
		expectBasic(rgb(220, 220, 220), 7);
	});

	it('should put orange on red rather than on green', () => {
		// the case Euclidean RGB gets wrong: #ff8800 is numerically nearer to
		// xterm's green than to its red, and perceptually nowhere near it
		expectBasic(rgb(0xff, 0x88, 0x00), 9);
		expectBasic(rgb(0xff, 0x5f, 0x00), 9);
	});

	it('should answer every colour with something in range', () => {
		for (let r = 0; r < 256; r += 37) {
			for (let g = 0; g < 256; g += 37) {
				for (let b = 0; b < 256; b += 37) {
					const got = at(rgb(r, g, b), 1);
					expect(got).toBeGreaterThanOrEqual(0);
					expect(got).toBeLessThanOrEqual(15);
				}
			}
		}
	});
});

describe('oklab', () => {
	it('should put black at zero and white at one', () => {
		expect(oklab([0, 0, 0])[0]).toBeCloseTo(0, 5);
		expect(oklab([255, 255, 255])[0]).toBeCloseTo(1, 3);
	});

	it('should give a grey no chroma', () => {
		const [, a, b] = oklab([128, 128, 128]);
		expect(a).toBeCloseTo(0, 6);
		expect(b).toBeCloseTo(0, 6);
	});

	it('should order lightness the way eyes do', () => {
		// pure green is much lighter than pure blue, which is the thing RGB
		// distance has no idea about
		expect(oklab([0, 255, 0])[0]).toBeGreaterThan(oklab([0, 0, 255])[0]);
	});
});

describe('the palette table', () => {
	it('should lay the cube out the way xterm does', () => {
		expect(paletteRgb(16)).toEqual([0, 0, 0]);
		expect(paletteRgb(231)).toEqual([255, 255, 255]);
		expect(paletteRgb(196)).toEqual([255, 0, 0]);
		expect(paletteRgb(46)).toEqual([0, 255, 0]);
		expect(paletteRgb(21)).toEqual([0, 0, 255]);
	});

	it('should lay the grey ramp out the way xterm does', () => {
		expect(paletteRgb(232)).toEqual([8, 8, 8]);
		expect(paletteRgb(255)).toEqual([238, 238, 238]);
	});

	it('should answer for every index', () => {
		for (let i = 0; i < 256; i++) {
			const [r, g, b] = paletteRgb(i);
			for (const channel of [r, g, b]) {
				expect(Number.isInteger(channel)).toBe(true);
				expect(channel).toBeGreaterThanOrEqual(0);
				expect(channel).toBeLessThanOrEqual(255);
			}
		}
	});
});

describe('degrading a style', () => {
	const style = declare({
		backgroundColor: '#0000ff',
		bold: 'true',
		'border-color': '#00ff00',
		color: '#ff0000',
		padding: '2',
	});

	it('should touch the colours and nothing else', () => {
		const degraded = degradeStyle(style, 1);
		expect(degraded.color).toBe(9);
		expect(degraded.backgroundColor).toBe(4);
		expect(degraded.borderColor).toBe(10);
		expect(degraded.bold).toBe(true);
		expect(degraded.paddingTop).toBe(2);
	});

	it('should leave the style it was given alone', () => {
		degradeStyle(style, 0);
		expect(style.color).toEqual(rgb(255, 0, 0));
	});

	it('should treat a background the same as a foreground', () => {
		// a different metric for backgrounds would be two tables and two sets of
		// surprises; the argument for one ("a wrong background is more visible")
		// argues for a better match rather than a different one, and Oklab is
		// already the better match
		expect(degradeStyle(style, 1).backgroundColor).toBe(degradeColor(rgb(0, 0, 255), 1));
	});

	it('should be free at truecolor', () => {
		expect(degradeStyle(style, 3)).toBe(style);
	});
});

describe('degrading through the cascade', () => {
	const sheet = parseStylesheet('.a { color: #ff8800; background-color: #223344 }');
	const node = { classes: ['a'], type: 'box' };

	it('should degrade what the sheets resolved to', () => {
		const cascade = new Cascade([sheet]);
		cascade.media = { colorLevel: 1, height: 24, width: 80 };
		expect(cascade.resolve(node).color).toBe(9);
	});

	it('should degrade what a prop set, on the fast path too', () => {
		const cascade = new Cascade([sheet]);
		cascade.media = { colorLevel: 1, height: 24, width: 80 };
		expect(cascade.resolve(node, { props: { color: '#00ff00' } }).color).toBe(10);
	});

	it('should let the author say what a colour means at a depth', () => {
		// the "give the author control" half: nearest-match is the default, not
		// the only option, and the media query is how an author overrides it
		const authored = parseStylesheet(
			'.a { color: #ff5f5f } @media (color-level: 1) { .a { color: magenta } }'
		);
		const cascade = new Cascade([authored]);

		cascade.media = { colorLevel: 3, height: 24, width: 80 };
		expect(cascade.resolve(node).color).toEqual(rgb(255, 95, 95));

		cascade.media = { colorLevel: 1, height: 24, width: 80 };
		// the authored answer, not the quantized one, and already emittable so
		// degradation leaves it alone
		expect(cascade.resolve(node).color).toBe(5);
	});

	it('should do nothing at truecolor, which is the default context', () => {
		expect(new Cascade([sheet]).resolve(node).color).toEqual(rgb(255, 136, 0));
	});

	it('should drop colour when the terminal has none', () => {
		const cascade = new Cascade([sheet]);
		cascade.media = { colorLevel: 0, height: 24, width: 80 };
		const style = cascade.resolve(node);
		expect(style.color).toBe(DEFAULT_COLOR);
		expect(style.backgroundColor).toBe(DEFAULT_COLOR);
	});
});

describe('the memo', () => {
	it('should answer the same way every time', () => {
		const first = degradeColor(rgb(83, 120, 200), 1);
		const second = degradeColor(rgb(83, 120, 200), 1);
		expect(first).toBe(second);
	});

	it('should keep the levels apart', () => {
		const color = rgb(200, 30, 30);
		expect(degradeColor(color, 2)).not.toBe(degradeColor(color, 1));
	});
});
