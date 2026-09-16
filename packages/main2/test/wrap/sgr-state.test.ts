import { createSgrState } from '../../src/wrap/sgr-state.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);
const CSI = String.fromCharCode(0x9b);

/** Applies a run of sequences and reports what is left in effect. */
function after(...sequences: string[]) {
	const state = createSgrState();
	for (const sequence of sequences) {
		state.apply(sequence);
	}
	return state;
}

describe('what stays in effect', () => {
	it('should start with nothing', () => {
		const state = createSgrState();
		expect(state.active).toBe(false);
		expect(state.open()).toBe('');
		expect(state.close()).toBe('');
	});

	it('should remember an attribute', () => {
		const state = after(`${ESC}[1m`);
		expect(state.active).toBe(true);
		expect(state.open()).toBe(`${ESC}[1m`);
		expect(state.close()).toBe(`${ESC}[22m`);
	});

	it('should remember several, as one sequence each way', () => {
		const state = after(`${ESC}[1m`, `${ESC}[4m`, `${ESC}[31m`);
		expect(state.open()).toBe(`${ESC}[1;4;31m`);
		expect(state.close()).toBe(`${ESC}[22;24;39m`);
	});

	it('should read several parameters from one sequence', () => {
		expect(after(`${ESC}[1;4;31m`).open()).toBe(`${ESC}[1;4;31m`);
	});

	// two foregrounds in a row leave the second in effect, not both, so the state
	// is one entry per slot rather than a list of everything seen
	it('should let an attribute replace the one holding its slot', () => {
		expect(after(`${ESC}[31m`, `${ESC}[32m`).open()).toBe(`${ESC}[32m`);
		expect(after(`${ESC}[1m`, `${ESC}[2m`).open()).toBe(`${ESC}[2m`);
		expect(after(`${ESC}[31m`, `${ESC}[41m`).open()).toBe(`${ESC}[31;41m`);
	});

	it('should forget what a closing parameter closes', () => {
		expect(after(`${ESC}[1m`, `${ESC}[31m`, `${ESC}[39m`).open()).toBe(`${ESC}[1m`);
		expect(after(`${ESC}[1m`, `${ESC}[22m`).active).toBe(false);
		// bold and dim share a slot and a close
		expect(after(`${ESC}[2m`, `${ESC}[22m`).active).toBe(false);
		expect(after(`${ESC}[4m`, `${ESC}[24m`).active).toBe(false);
		expect(after(`${ESC}[41m`, `${ESC}[49m`).active).toBe(false);
	});

	it('should close a slot named in passing', () => {
		expect(after(`${ESC}[1m`, `${ESC}[31m`, `${ESC}[39;4m`).open()).toBe(`${ESC}[1;4m`);
	});

	it('should forget everything on a reset, however it is spelled', () => {
		for (const reset of [`${ESC}[0m`, `${ESC}[m`, `${ESC}[00m`, `${ESC}[0;0m`, `${CSI}0m`]) {
			expect(after(`${ESC}[1m`, `${ESC}[31m`, reset).active, reset).toBe(false);
		}
		// a reset can carry what comes after it
		expect(after(`${ESC}[1m`, `${ESC}[0;32m`).open()).toBe(`${ESC}[32m`);
	});

	it('should keep the parameters of a 256-color or a truecolor', () => {
		expect(after(`${ESC}[38;5;214m`).open()).toBe(`${ESC}[38;5;214m`);
		expect(after(`${ESC}[38;2;95;135;175m`).open()).toBe(`${ESC}[38;2;95;135;175m`);
		expect(after(`${ESC}[48;2;0;0;0m`).close()).toBe(`${ESC}[49m`);
		// and read what follows them as parameters of their own
		expect(after(`${ESC}[38;5;214;1m`).open()).toBe(`${ESC}[38;5;214;1m`);
		expect(after(`${ESC}[1;38;2;1;2;3;4m`).open()).toBe(`${ESC}[1;38;2;1;2;3;4m`);
	});

	it('should let an extended color replace a simple one and the other way round', () => {
		expect(after(`${ESC}[31m`, `${ESC}[38;5;214m`).open()).toBe(`${ESC}[38;5;214m`);
		expect(after(`${ESC}[38;5;214m`, `${ESC}[31m`).open()).toBe(`${ESC}[31m`);
	});

	// storing it would be worse than losing it: the parameters of whatever came
	// next would be written after it on the way back and read as the rest of the
	// color, turning malformed input into a valid color nobody asked for
	it('should drop a color whose parameters do not add up', () => {
		expect(after(`${ESC}[38;5m`).active).toBe(false);
		expect(after(`${ESC}[38;2;1;2m`).active).toBe(false);
		expect(after(`${ESC}[38m`).active).toBe(false);
		// and a mode it does not know is the same case
		expect(after(`${ESC}[38;9;1m`).active).toBe(false);
		// nothing of the malformed color leaks into what follows it
		expect(after(`${ESC}[38;5m`, `${ESC}[1m`).open()).toBe(`${ESC}[1m`);
		expect(after(`${ESC}[38;2;1;2m`, `${ESC}[1m`).open()).toBe(`${ESC}[1m`);
	});

	it('should read the single byte C1 form', () => {
		expect(after(`${CSI}1m`).open()).toBe(`${ESC}[1m`);
	});

	// a sub-parameter belongs to the parameter in front of it rather than standing
	// on its own -- and it has to survive, because `4:3` is a curly underline and
	// `4` is a straight one
	it('should keep a sub-parameter without reading it as a parameter', () => {
		expect(after(`${ESC}[4:3m`).open()).toBe(`${ESC}[4:3m`);
		expect(after(`${ESC}[4:3m`).close()).toBe(`${ESC}[24m`);
		expect(after(`${ESC}[4:3m`, `${ESC}[24m`).active).toBe(false);
	});

	// the colon form carries the whole color in one parameter. Rebuilding it from
	// its leading number writes `ESC[38m`, which is not a sequence at all.
	it('should keep a colon-form color whole', () => {
		expect(after(`${ESC}[38:2:95:135:175m`).open()).toBe(`${ESC}[38:2:95:135:175m`);
		expect(after(`${ESC}[38:5:214m`).open()).toBe(`${ESC}[38:5:214m`);
		expect(after(`${ESC}[48:2:0:0:0m`).close()).toBe(`${ESC}[49m`);
		// and the parameters after it are still parameters of their own
		expect(after(`${ESC}[38:2:95:135:175;1m`).open()).toBe(`${ESC}[38:2:95:135:175;1m`);
	});

	it('should ignore what it does not model rather than guess at a slot', () => {
		// 10 is a font selection, 51 is framed, 73 is superscript
		expect(after(`${ESC}[10m`).active).toBe(false);
		expect(after(`${ESC}[1m`, `${ESC}[51m`).open()).toBe(`${ESC}[1m`);
	});

	it('should ignore a sequence that is not an SGR', () => {
		for (const sequence of [
			`${ESC}[2J`,
			`${ESC}[1;1H`,
			`${ESC}]8;;https://example.com${String.fromCharCode(0x07)}`,
			`${ESC}(B`,
			'not a sequence',
			'',
		]) {
			expect(after(`${ESC}[1m`, sequence).open(), JSON.stringify(sequence)).toBe(`${ESC}[1m`);
		}
	});

	// closing the slots that are open, rather than writing a blanket reset, so
	// that styling the surrounding output had set and this text never touched
	// survives
	it('should close only the slots it opened', () => {
		expect(after(`${ESC}[31m`).close()).toBe(`${ESC}[39m`);
		expect(after(`${ESC}[31m`).close()).not.toContain('0m');
	});

	it('should forget everything when reset', () => {
		const state = after(`${ESC}[1m`, `${ESC}[31m`);
		state.reset();
		expect(state.active).toBe(false);
		expect(state.open()).toBe('');
	});
});
