import { codes } from '../../src/ansi/codes.js';
import type { ColorLevel } from '../../src/ansi/color-support.js';
import { ansi, createAnsi } from '../../src/ansi/index.js';
import type { Styler } from '../../src/ansi/style.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);

beforeEach(() => {
	ansi.level = 3;
});

afterEach(() => {
	ansi.level = undefined;
});

describe('styling', () => {
	it('should apply a named style', () => {
		expect(ansi.red('hi')).toBe(`${ESC}[31mhi${ESC}[39m`);
		expect(ansi.bold('hi')).toBe(`${ESC}[1mhi${ESC}[22m`);
		expect(ansi.bgCyan('hi')).toBe(`${ESC}[46mhi${ESC}[49m`);
	});

	it('should apply the bright variants', () => {
		expect(ansi.redBright('hi')).toBe(`${ESC}[91mhi${ESC}[39m`);
		expect(ansi.bgRedBright('hi')).toBe(`${ESC}[101mhi${ESC}[49m`);
		expect(ansi.gray('hi')).toBe(ansi.blackBright('hi'));
		expect(ansi.grey('hi')).toBe(ansi.blackBright('hi'));
	});

	it('should chain styles outermost first', () => {
		expect(ansi.bold.red('hi')).toBe(`${ESC}[1m${ESC}[31mhi${ESC}[39m${ESC}[22m`);
	});

	// the named styles are a fixed set and a chain of them is only as deep as
	// the source that spells it out, so caching them is bounded by the caller
	it('should return the same styler for the same named chain', () => {
		expect(ansi.bold.red).toBe(ansi.bold.red);
		expect(ansi.bold.red).not.toBe(ansi.red.bold);
	});

	// which is also what keeps the cache bounded: a chain built in a loop stops
	// growing instead of retaining a styler per iteration
	it('should treat a style already in the chain as a no-op', () => {
		expect(ansi.bold.bold).toBe(ansi.bold);
		expect(ansi.bold.red.bold).toBe(ansi.bold.red);

		let style: Styler = ansi;
		for (let i = 0; i < 1000; i++) {
			style = style.bold.red;
		}
		expect(style).toBe(ansi.bold.red);
		expect(style('hi')).toBe(ansi.bold.red('hi'));
	});

	// a cache keyed on a color would be bounded by that color's input instead,
	// and a process cycling through a gradient would grow an entry per frame
	it('should not cache a color, but should still render it the same', () => {
		expect(ansi.hex('#ff0000')).not.toBe(ansi.hex('#ff0000'));
		expect(ansi.hex('#ff0000')('x')).toBe(ansi.hex('#ff0000')('x'));
		expect(ansi.rgb(255, 0, 0)('x')).toBe(ansi.hex('#f00')('x'));
	});

	it('should pass text through when the root styler is called', () => {
		expect(ansi('hi')).toBe('hi');
	});

	it('should join multiple arguments with a space', () => {
		expect(ansi.red('a', 'b', 'c')).toBe(`${ESC}[31ma b c${ESC}[39m`);
		expect(ansi.red(1, true, null)).toBe(`${ESC}[31m1 true null${ESC}[39m`);
	});

	it('should leave an empty string alone', () => {
		expect(ansi.red()).toBe('');
		expect(ansi.red('')).toBe('');
	});

	it('should write nothing at level 0', () => {
		ansi.level = 0;
		expect(ansi.bold.red('hi')).toBe('hi');
		expect(ansi.hex('#ff0000')('hi')).toBe('hi');
	});
});

describe('nesting', () => {
	// bold and dim share close code 22, and every foreground shares 39, so a
	// nested style that closes would switch the outer one off too
	it('should reopen a style the inner text closed', () => {
		const inner = ansi.green('green');
		expect(ansi.red(`red ${inner} red`)).toBe(
			`${ESC}[31mred ${ESC}[32mgreen${ESC}[39m${ESC}[31m red${ESC}[39m`
		);
	});

	it('should reopen every style in the chain', () => {
		expect(ansi.bold.red(`a${ansi.dim('b')}c`)).toBe(
			`${ESC}[1m${ESC}[31ma${ESC}[2mb${ESC}[22m${ESC}[1mc${ESC}[39m${ESC}[22m`
		);
	});

	// a reset turns every attribute off, not just the one that named it, so the
	// whole chain has to come back rather than one part of it
	it('should reopen the whole chain after a reset', () => {
		expect(ansi.red(`a${ansi.reset('x')}b`)).toBe(
			`${ESC}[31ma${ESC}[0m${ESC}[31mx${ESC}[0m${ESC}[31mb${ESC}[39m`
		);
	});

	// the parameters are read rather than the sequence compared, because every
	// one of these means the same thing to a terminal
	it('should recognize every spelling of a reset', () => {
		const open = `${ESC}[1m${ESC}[31m`;
		const close = `${ESC}[39m${ESC}[22m`;
		for (const reset of [`${ESC}[0m`, `${ESC}[m`, `${ESC}[00m`, `${ESC}[0;0m`, `${CSI}0m`]) {
			expect(ansi.bold.red(`a${reset}b`), reset).toBe(`${open}a${reset}${open}b${close}`);
		}
		// a reset does not have to be the only parameter
		expect(ansi.bold.red(`a${ESC}[0;32mb`)).toBe(`${open}a${ESC}[0;32m${open}b${close}`);
	});

	it('should reopen a style a multi-parameter sequence turned off in passing', () => {
		expect(ansi.red(`a${ESC}[39;4mb`)).toBe(`${ESC}[31ma${ESC}[39;4m${ESC}[31mb${ESC}[39m`);
	});

	// two foregrounds share close code 39, so both reopen after it -- and the
	// innermost has to be the one left in effect
	it('should leave the innermost style in effect when two share a close code', () => {
		expect(ansi.red.green(`a${ansi.blue('b')}c`)).toBe(
			`${ESC}[31m${ESC}[32ma${ESC}[34mb${ESC}[39m${ESC}[31m${ESC}[32mc${ESC}[39m${ESC}[39m`
		);
		expect(ansi.bgRed.bgGreen(`a${ansi.bgBlue('b')}c`)).toBe(
			`${ESC}[41m${ESC}[42ma${ESC}[44mb${ESC}[49m${ESC}[41m${ESC}[42mc${ESC}[49m${ESC}[49m`
		);
	});

	it('should leave a sub-parameter alone', () => {
		// the `3` of a curly underline is not a parameter of its own
		expect(ansi.red(`a${ESC}[4:3mb`)).toBe(`${ESC}[31ma${ESC}[4:3mb${ESC}[39m`);
	});

	// an extended color spreads over the parameters after it in the semicolon
	// form, and reading those as attributes of their own meant a color could turn
	// the outer style back on over itself: `38;2;255;0;0` carries a `0` and was
	// taken for a reset, so blue reopened on top of the red and the text rendered
	// blue, and `38;5;39` carries the foreground's own close code
	it('should not read an extended color as attributes of its own', () => {
		expect(ansi.blue(`a${ansi.rgb(255, 0, 0)('b')}c`)).toBe(
			`${ESC}[34ma${ESC}[38;2;255;0;0mb${ESC}[39m${ESC}[34mc${ESC}[39m`
		);
		expect(ansi.red(`a${ansi.ansi256(39)('b')}c`)).toBe(
			`${ESC}[31ma${ESC}[38;5;39mb${ESC}[39m${ESC}[31mc${ESC}[39m`
		);
		expect(ansi.bgBlue(`a${ansi.bgRgb(0, 0, 0)('b')}c`)).toBe(
			`${ESC}[44ma${ESC}[48;2;0;0;0mb${ESC}[49m${ESC}[44mc${ESC}[49m`
		);
	});

	// a control: 196 is not a close code and never had the problem, so it pins
	// that the fix did not stop reopening where reopening is right
	it('should still reopen after an extended color that closes nothing', () => {
		expect(ansi.red(`a${ansi.ansi256(196)('b')}c`)).toBe(
			`${ESC}[31ma${ESC}[38;5;196mb${ESC}[39m${ESC}[31mc${ESC}[39m`
		);
	});

	// the color's own parameters are skipped, but real attributes sharing the
	// sequence with it are still read
	it('should read attributes that share a sequence with an extended color', () => {
		expect(ansi.red(`a${ESC}[38;2;0;0;0;39mb`)).toBe(
			`${ESC}[31ma${ESC}[38;2;0;0;0;39m${ESC}[31mb${ESC}[39m`
		);
		expect(ansi.bold(`a${ESC}[38;5;22;22mb`)).toBe(
			`${ESC}[1ma${ESC}[38;5;22;22m${ESC}[1mb${ESC}[22m`
		);
		// and a reset that shares one is still a reset
		expect(ansi.red(`a${ESC}[38;5;1;0mb`)).toBe(`${ESC}[31ma${ESC}[38;5;1;0m${ESC}[31mb${ESC}[39m`);
	});

	// the colon form carries the color inside one parameter, so there is nothing
	// to skip -- and a malformed run has no length, so the rest of the sequence
	// belongs to it rather than being read as attributes
	it('should handle the colon form and a malformed extended color', () => {
		expect(ansi.red(`a${ESC}[38:2:255:0:0mb`)).toBe(`${ESC}[31ma${ESC}[38:2:255:0:0mb${ESC}[39m`);

		// and because it is one parameter, what follows it is an attribute of its
		// own -- skipping as though it were the semicolon form swallowed the `39`
		// and left the outer style closed for the rest of the text
		expect(ansi.red(`a${ESC}[38:2:255:0:0;39mb`)).toBe(
			`${ESC}[31ma${ESC}[38:2:255:0:0;39m${ESC}[31mb${ESC}[39m`
		);
		expect(ansi.bold(`a${ESC}[38:5:1;22mb`)).toBe(
			`${ESC}[1ma${ESC}[38:5:1;22m${ESC}[1mb${ESC}[22m`
		);
		expect(ansi.red(`a${ESC}[38;9;39mb`)).toBe(`${ESC}[31ma${ESC}[38;9;39mb${ESC}[39m`);
		expect(ansi.red(`a${ESC}[38mb`)).toBe(`${ESC}[31ma${ESC}[38mb${ESC}[39m`);
	});

	it('should close and reopen around a newline', () => {
		expect(ansi.bgRed('a\nb')).toBe(`${ESC}[41ma${ESC}[49m\n${ESC}[41mb${ESC}[49m`);
		expect(ansi.bgRed('a\r\nb')).toBe(`${ESC}[41ma${ESC}[49m\r\n${ESC}[41mb${ESC}[49m`);
	});
});

describe('256 colors', () => {
	it('should write a palette index at level 2 and above', () => {
		expect(ansi.ansi256(214)('hi')).toBe(`${ESC}[38;5;214mhi${ESC}[39m`);
		expect(ansi.bgAnsi256(214)('hi')).toBe(`${ESC}[48;5;214mhi${ESC}[49m`);

		ansi.level = 2;
		expect(ansi.ansi256(214)('hi')).toBe(`${ESC}[38;5;214mhi${ESC}[39m`);
	});

	it('should downsample to the basic 16 at level 1', () => {
		ansi.level = 1;
		// the first 16 palette entries are the basic colors themselves
		expect(ansi.ansi256(1)('hi')).toBe(`${ESC}[31mhi${ESC}[39m`);
		expect(ansi.ansi256(9)('hi')).toBe(`${ESC}[91mhi${ESC}[39m`);
		expect(ansi.bgAnsi256(1)('hi')).toBe(`${ESC}[41mhi${ESC}[49m`);
		// 196 is the cube's full red
		expect(ansi.ansi256(196)('hi')).toBe(`${ESC}[91mhi${ESC}[39m`);
		// 16 is the cube's black
		expect(ansi.ansi256(16)('hi')).toBe(`${ESC}[30mhi${ESC}[39m`);
	});

	it('should reject an index outside the palette', () => {
		expect(() => ansi.ansi256(256)).toThrow(
			'Invalid color code "256"; expected an integer between 0 and 255'
		);
		expect(() => ansi.ansi256(-1)).toThrow(/Invalid color code/);
		expect(() => ansi.ansi256(1.5)).toThrow(/Invalid color code/);
	});
});

describe('truecolor', () => {
	it('should write 24-bit channels at level 3', () => {
		expect(ansi.rgb(95, 135, 175)('hi')).toBe(`${ESC}[38;2;95;135;175mhi${ESC}[39m`);
		expect(ansi.bgRgb(95, 135, 175)('hi')).toBe(`${ESC}[48;2;95;135;175mhi${ESC}[49m`);
	});

	it('should accept hex with and without the hash, in either case', () => {
		expect(ansi.hex('#5f87af')('hi')).toBe(`${ESC}[38;2;95;135;175mhi${ESC}[39m`);
		expect(ansi.hex('5F87AF')('hi')).toBe(`${ESC}[38;2;95;135;175mhi${ESC}[39m`);
		expect(ansi.bgHex('#5f87af')('hi')).toBe(`${ESC}[48;2;95;135;175mhi${ESC}[49m`);
	});

	it('should expand a three digit hex by doubling each digit', () => {
		expect(ansi.hex('#abc')('hi')).toBe(ansi.hex('#aabbcc')('hi'));
		expect(ansi.hex('#f00')('hi')).toBe(`${ESC}[38;2;255;0;0mhi${ESC}[39m`);
	});

	it('should downsample to the 256 palette at level 2', () => {
		ansi.level = 2;
		expect(ansi.hex('#ff0000')('hi')).toBe(`${ESC}[38;5;196mhi${ESC}[39m`);
		// a gray goes to the 24 step ramp, which is far finer than the cube
		expect(ansi.hex('#808080')('hi')).toBe(`${ESC}[38;5;244mhi${ESC}[39m`);
		// but only the cube reaches pure black and white
		expect(ansi.hex('#000000')('hi')).toBe(`${ESC}[38;5;16mhi${ESC}[39m`);
		expect(ansi.hex('#ffffff')('hi')).toBe(`${ESC}[38;5;231mhi${ESC}[39m`);
	});

	// the cube's channels step 0, 95, 135, 175, 215, 255 -- neither evenly
	// spaced nor multiples of 51, so quantizing as if they were misses entries
	// that are an exact match
	it('should quantize to the cube steps the palette actually uses', () => {
		ansi.level = 2;
		// #5f87af is index 67 exactly
		expect(ansi.rgb(95, 135, 175)('hi')).toBe(`${ESC}[38;5;67mhi${ESC}[39m`);
		expect(ansi.hex('#005fd7')('hi')).toBe(`${ESC}[38;5;26mhi${ESC}[39m`);
		expect(ansi.hex('#d7ffaf')('hi')).toBe(`${ESC}[38;5;193mhi${ESC}[39m`);
	});

	it('should reach both ends of the grayscale ramp', () => {
		ansi.level = 2;
		// the ramp runs 8 to 238 as indices 232 to 255
		expect(ansi.rgb(8, 8, 8)('hi')).toBe(`${ESC}[38;5;232mhi${ESC}[39m`);
		expect(ansi.rgb(5, 5, 5)('hi')).toBe(`${ESC}[38;5;232mhi${ESC}[39m`);
		expect(ansi.rgb(238, 238, 238)('hi')).toBe(`${ESC}[38;5;255mhi${ESC}[39m`);
		// a near-gray still finds the ramp, even though the channels differ
		expect(ansi.rgb(128, 128, 129)('hi')).toBe(`${ESC}[38;5;244mhi${ESC}[39m`);
	});

	it('should downsample to the basic 16 at level 1', () => {
		ansi.level = 1;
		expect(ansi.hex('#ff0000')('hi')).toBe(`${ESC}[91mhi${ESC}[39m`);
		expect(ansi.hex('#800000')('hi')).toBe(`${ESC}[31mhi${ESC}[39m`);
		expect(ansi.hex('#000000')('hi')).toBe(`${ESC}[30mhi${ESC}[39m`);
		expect(ansi.bgHex('#ff0000')('hi')).toBe(`${ESC}[101mhi${ESC}[49m`);
	});

	// rounding each channel to a bit and reading the result as a color index
	// cannot reach a gray at all: every channel rounds the same way, so the only
	// grays it produces are black and white
	it('should downsample a gray to the nearest gray, not to black or white', () => {
		ansi.level = 1;
		// 90 is exactly #808080 and 37 is #c0c0c0
		expect(ansi.hex('#808080')('hi')).toBe(`${ESC}[90mhi${ESC}[39m`);
		expect(ansi.hex('#c0c0c0')('hi')).toBe(`${ESC}[37mhi${ESC}[39m`);
		expect(ansi.hex('#ffffff')('hi')).toBe(`${ESC}[97mhi${ESC}[39m`);
		expect(ansi.hex('#555555')('hi')).toBe(`${ESC}[90mhi${ESC}[39m`);
		// #404040 is exactly as far from black as from #808080, and a tie goes to
		// the lower index
		expect(ansi.hex('#404040')('hi')).toBe(`${ESC}[30mhi${ESC}[39m`);
		expect(ansi.hex('#0a0a0a')('hi')).toBe(`${ESC}[30mhi${ESC}[39m`);
		// and the same by way of the 256-color grayscale ramp
		expect(ansi.ansi256(244)('hi')).toBe(`${ESC}[90mhi${ESC}[39m`);
	});

	it('should reject a malformed hex color', () => {
		expect(() => ansi.hex('#ff00')).toThrow('Invalid hex color "#ff00"');
		expect(() => ansi.hex('nope')).toThrow(/Invalid hex color/);
		expect(() => ansi.hex('')).toThrow(/Invalid hex color/);
	});

	it('should reject a channel outside a byte', () => {
		expect(() => ansi.rgb(256, 0, 0)).toThrow(
			'Invalid red "256"; expected an integer between 0 and 255'
		);
		expect(() => ansi.rgb(0, -1, 0)).toThrow(/Invalid green/);
		expect(() => ansi.rgb(0, 0, 1.5)).toThrow(/Invalid blue/);
	});
});

describe('level', () => {
	it('should downsample a chain built before the level changed', () => {
		const style = ansi.hex('#ff0000');
		expect(style('hi')).toBe(`${ESC}[38;2;255;0;0mhi${ESC}[39m`);
		ansi.level = 1;
		expect(style('hi')).toBe(`${ESC}[91mhi${ESC}[39m`);
	});

	it('should reject a level outside 0 to 3', () => {
		expect(() => {
			ansi.level = 4 as ColorLevel;
		}).toThrow('Invalid color level "4"; expected 0, 1, 2, or 3');
		expect(() => {
			ansi.level = -1 as ColorLevel;
		}).toThrow(/Invalid color level/);
		expect(() => {
			ansi.level = 1.5 as ColorLevel;
		}).toThrow(/Invalid color level/);
	});

	it('should detect the level again when cleared', () => {
		ansi.level = 0;
		ansi.level = undefined;
		// vitest's stdout is not a TTY, so detection lands on 0 either way; what
		// matters is that the override is gone rather than sticking at 0
		expect(ansi.level).toBe(ansi.supportsColor());
	});
});

describe('codes', () => {
	// the table cannot carry a `satisfies` clause, because `isolatedDeclarations`
	// will not infer a declaration through one
	it('should be an open and close SGR parameter per style', () => {
		for (const [name, pair] of Object.entries(codes)) {
			expect(pair, name).toHaveLength(2);
			for (const code of pair) {
				expect(Number.isInteger(code), `${name} -> ${code}`).toBe(true);
				expect(code, name).toBeGreaterThanOrEqual(0);
				expect(code, name).toBeLessThanOrEqual(107);
			}
		}
	});

	it('should expose every style as a styler', () => {
		for (const name of Object.keys(codes)) {
			expect(typeof ansi[name as keyof typeof codes], name).toBe('function');
		}
	});
});

describe('createAnsi()', () => {
	// stdout being redirected says nothing about stderr, so one level cannot
	// speak for both destinations
	it('should keep a level of its own', () => {
		const other = createAnsi({ level: 3 });
		ansi.level = 0;
		expect(other.red('hi')).toBe(`${ESC}[31mhi${ESC}[39m`);
		expect(ansi.red('hi')).toBe('hi');

		other.level = 0;
		ansi.level = 3;
		expect(other.red('hi')).toBe('hi');
		expect(ansi.red('hi')).toBe(`${ESC}[31mhi${ESC}[39m`);
	});

	it('should detect from the stream and environment it was given', () => {
		const tty = createAnsi({
			env: { TERM: 'xterm-256color' },
			isTTY: true,
			platform: 'linux',
		});
		expect(tty.level).toBe(2);
		expect(createAnsi({ env: {}, isTTY: false }).level).toBe(0);
	});

	it('should detect again after an override is cleared', () => {
		const style = createAnsi({ env: { TERM: 'xterm-256color' }, isTTY: true, platform: 'linux' });
		style.level = 0;
		expect(style.level).toBe(0);
		style.level = undefined;
		expect(style.level).toBe(2);
	});

	it('should reject an invalid level from either direction', () => {
		expect(() => createAnsi({ level: 7 as ColorLevel })).toThrow(/Invalid color level/);
		expect(() => {
			createAnsi().level = 7 as ColorLevel;
		}).toThrow(/Invalid color level/);
	});
});
