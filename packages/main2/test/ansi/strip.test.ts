import { hasAnsi, strip } from '../../src/ansi/strip.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const CAN = String.fromCharCode(0x18);
const SUB = String.fromCharCode(0x1a);
const ST = `${ESC}\\`;

describe('strip()', () => {
	it('should leave a plain string alone', () => {
		expect(strip('')).toBe('');
		expect(strip('hello')).toBe('hello');
		expect(strip('café 日本語')).toBe('café 日本語');
	});

	it('should remove SGR sequences', () => {
		expect(strip(`${ESC}[31mred${ESC}[39m`)).toBe('red');
		expect(strip(`${ESC}[1m${ESC}[4m${ESC}[38;2;95;135;175mx${ESC}[0m`)).toBe('x');
		expect(strip(`${ESC}[38;5;214mx${ESC}[39m`)).toBe('x');
	});

	it('should remove cursor and erase sequences', () => {
		expect(strip(`${ESC}[2J${ESC}[H`)).toBe('');
		expect(strip(`a${ESC}[3Db${ESC}[?25lc`)).toBe('abc');
		expect(strip(`${ESC}[1;2;3;4;5;6;7;8;9;10H`)).toBe('');
	});

	it('should remove an OSC hyperlink, both terminators', () => {
		expect(strip(`${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL}`)).toBe('link');
		expect(strip(`${ESC}]8;;https://example.com${ST}link${ESC}]8;;${ST}`)).toBe('link');
	});

	it('should remove an OSC window title, semicolons and spaces and all', () => {
		expect(strip(`${ESC}]0;my cli: building; almost${BEL}done`)).toBe('done');
	});

	it('should remove DCS, APC, and the other string sequences', () => {
		expect(strip(`${ESC}P1;2|payload${ST}x`)).toBe('x');
		expect(strip(`${ESC}_tmux;whatever${ST}x`)).toBe('x');
		expect(strip(`${ESC}^private${ST}x`)).toBe('x');
		expect(strip(`${ESC}X${ST}x`)).toBe('x');
	});

	it('should remove a CSI with colon sub-parameters or an intermediate byte', () => {
		// curly underline, a device status query, and a private mode report
		expect(strip(`${ESC}[4:3mx${ESC}[4:0m`)).toBe('x');
		expect(strip(`${ESC}[58;2;0;255;0mx${ESC}[59m`)).toBe('x');
		expect(strip(`${ESC}[1$qx`)).toBe('x');
		expect(strip(`${ESC}[>"px`)).toBe('x');
	});

	it('should remove two and three character escapes', () => {
		expect(strip(`${ESC}(Bx`)).toBe('x');
		expect(strip(`${ESC}7x${ESC}8`)).toBe('x');
		expect(strip(`${ESC}=x${ESC}>`)).toBe('x');
	});

	it('should remove single byte C1 introducers', () => {
		expect(strip('31mred39m')).toBe('red');
		expect(strip(`0;title${BEL}x`)).toBe('x');
	});

	// a half written sequence is still not printable text, and leaving part of
	// one behind would corrupt whatever measures or wraps the result next
	it('should remove a sequence truncated at the end of the string', () => {
		expect(strip(`red${ESC}[3`)).toBe('red');
		expect(strip(`red${ESC}[`)).toBe('red');
		expect(strip(`red${ESC}`)).toBe('red');
		expect(strip(`red${ESC}]8;;https://example.com`)).toBe('red');
		expect(strip(`red${ESC}Ppayload`)).toBe('red');
	});

	// a terminal leaves the string state on a cancel or on an ESC, so an
	// unterminated one must not swallow everything printable after it
	it('should end a string sequence where a terminal ends it', () => {
		expect(strip(`${ESC}]0;title${CAN}visible`)).toBe('visible');
		expect(strip(`${ESC}]0;title${SUB}visible`)).toBe('visible');
		expect(strip(`${ESC}]0;title${ESC}[31mred`)).toBe('red');
		expect(strip(`${ESC}Ppayload${CAN}visible`)).toBe('visible');
		expect(strip(`${ESC}_apc${ESC}[0mvisible`)).toBe('visible');
	});

	it('should not eat text that only looks like a sequence', () => {
		expect(strip('[31mred')).toBe('[31mred');
		expect(strip('a[1;2Hb')).toBe('a[1;2Hb');
	});

	it('should be idempotent', () => {
		const once = strip(`${ESC}[31m${ESC}]8;;x${BEL}red${ESC}[39m`);
		expect(strip(once)).toBe(once);
	});
});

describe('hasAnsi()', () => {
	it('should report whether a string carries a sequence', () => {
		expect(hasAnsi('plain')).toBe(false);
		expect(hasAnsi('')).toBe(false);
		expect(hasAnsi(`${ESC}[31mred${ESC}[39m`)).toBe(true);
		expect(hasAnsi('31m')).toBe(true);
	});

	// a `g` flagged regex kept between calls carries `lastIndex`, which makes
	// `test()` answer differently depending on what ran before it
	it('should answer the same way every time', () => {
		const str = `${ESC}[31mred${ESC}[39m`;
		expect(hasAnsi(str)).toBe(true);
		expect(hasAnsi(str)).toBe(true);
		expect(hasAnsi(str)).toBe(true);
	});
});
