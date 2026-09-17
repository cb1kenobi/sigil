import {
	CellBuffer,
	DEFAULT_COLOR,
	Dots,
	palette,
	Painter,
	Pixels,
	StyleTable,
} from '../../src/canvas/index.js';
import { describe, expect, it } from 'vitest';

/** A painter over a fresh buffer, and the table to read its styles back from. */
function surface(width: number, height: number) {
	const styles = new StyleTable();
	const buffer = new CellBuffer(width, height);
	return { buffer, painter: new Painter(buffer, styles), styles };
}

describe('Dots', () => {
	it('should map every dot position to its own bit', () => {
		// braille was six dots read down the left column then down the right, and
		// the eighth row was appended later -- so the bottom row is bits 3 and 7
		// rather than the next two in sequence. Deriving this gets it subtly wrong
		const expected: [number, number, string][] = [
			[0, 0, '⠁'],
			[1, 0, '⠈'],
			[0, 1, '⠂'],
			[1, 1, '⠐'],
			[0, 2, '⠄'],
			[1, 2, '⠠'],
			[0, 3, '⡀'],
			[1, 3, '⢀'],
		];

		for (const [x, y, char] of expected) {
			const dots = new Dots(1, 1);
			dots.set(x, y);
			expect(dots.charAt(0, 0), `dot ${x},${y}`).toBe(char);
		}
	});

	it('should fill the cell when every dot is set', () => {
		const dots = new Dots(1, 1);
		for (let y = 0; y < 4; y++) {
			for (let x = 0; x < 2; x++) {
				dots.set(x, y);
			}
		}
		expect(dots.charAt(0, 0)).toBe('⣿');
	});

	it('should report an empty cell as nothing rather than as a blank braille', () => {
		// U+2800 is a real character that some fonts draw the dot frame for, and
		// painting it would also overwrite whatever the plot is sitting on
		expect(new Dots(2, 2).charAt(0, 0)).toBeUndefined();
	});

	it('should size itself in cells and report dots', () => {
		const dots = new Dots(10, 3);
		expect([dots.width, dots.height]).toEqual([10, 3]);
		expect([dots.dotWidth, dots.dotHeight]).toEqual([20, 12]);
	});

	it('should ignore a dot outside the grid rather than throwing', () => {
		// a plot clips at its box, and making every caller bounds-check each point
		// is how the check ends up in the wrong place
		const dots = new Dots(1, 1);
		expect(() => {
			dots.set(-1, 0);
			dots.set(0, -1);
			dots.set(2, 0);
			dots.set(0, 4);
		}).not.toThrow();
		expect(dots.charAt(0, 0)).toBeUndefined();
		expect(dots.get(99, 99)).toBe(false);
	});

	it('should clear a dot without disturbing its neighbours', () => {
		const dots = new Dots(1, 1);
		dots.set(0, 0);
		dots.set(1, 3);
		dots.unset(0, 0);
		expect(dots.get(0, 0)).toBe(false);
		expect(dots.get(1, 3)).toBe(true);
		expect(dots.charAt(0, 0)).toBe('⢀');
	});

	it('should draw a horizontal line across cells', () => {
		const dots = new Dots(3, 1);
		dots.line(0, 0, 5, 0);
		for (let x = 0; x < 6; x++) {
			expect(dots.get(x, 0), `dot ${x}`).toBe(true);
		}
		expect(dots.get(0, 1)).toBe(false);
	});

	it('should draw a diagonal that advances on both axes', () => {
		const dots = new Dots(2, 1);
		dots.line(0, 0, 3, 3);
		expect([dots.get(0, 0), dots.get(1, 1), dots.get(2, 2), dots.get(3, 3)]).toEqual([
			true,
			true,
			true,
			true,
		]);
	});

	it('should draw a line the same way in both directions', () => {
		const forward = new Dots(4, 2);
		const backward = new Dots(4, 2);
		forward.line(1, 1, 6, 5);
		backward.line(6, 5, 1, 1);
		expect(forward.charAt(0, 0)).toBe(backward.charAt(0, 0));
		expect(forward.charAt(1, 1)).toBe(backward.charAt(1, 1));
	});

	it('should paint only the cells that have dots', () => {
		// the gap has to be left as it was, which is what lets a plot sit on a
		// background someone else drew
		const { buffer, painter } = surface(4, 1);
		buffer.write(0, 0, '....', StyleTable.DEFAULT);

		const dots = new Dots(4, 1);
		dots.set(0, 0);
		dots.set(6, 0);
		dots.blit(painter, 0, 0);

		expect(buffer.toString()).toBe('⠁..⠁');
	});

	it('should paint at the offset it was given', () => {
		const { buffer, painter } = surface(6, 3);
		const dots = new Dots(1, 1);
		dots.set(0, 0);
		dots.blit(painter, 3, 2);
		expect(buffer.charAt(3, 2)).toBe('⠁');
		expect(buffer.charAt(0, 0)).toBe(' ');
	});

	it('should paint the dots in the style it was given', () => {
		const { buffer, painter, styles } = surface(2, 1);
		const dots = new Dots(2, 1);
		dots.set(0, 0);
		dots.blit(painter, 0, 0, { fg: palette(6) });
		expect(styles.get(buffer.styleAt(0, 0)).fg).toBe(palette(6));
	});
});

describe('Pixels', () => {
	it('should size itself in cells and report pixel rows', () => {
		const pixels = new Pixels(8, 3);
		expect([pixels.width, pixels.height, pixels.pixelHeight]).toEqual([8, 3, 6]);
	});

	it('should paint two differently coloured halves as one upper block', () => {
		const { buffer, painter, styles } = surface(1, 1);
		const pixels = new Pixels(1, 1);
		pixels.set(0, 0, palette(1));
		pixels.set(0, 1, palette(4));
		pixels.blit(painter, 0, 0);

		expect(buffer.charAt(0, 0)).toBe('▀');
		const style = styles.get(buffer.styleAt(0, 0));
		expect([style.fg, style.bg]).toEqual([palette(1), palette(4)]);
	});

	it('should paint a solid cell as a full block in one colour', () => {
		// `█` in one colour survives a terminal that renders the half blocks a
		// pixel short, which several do at small font sizes
		const { buffer, painter, styles } = surface(1, 1);
		const pixels = new Pixels(1, 1);
		pixels.set(0, 0, palette(2));
		pixels.set(0, 1, palette(2));
		pixels.blit(painter, 0, 0);

		expect(buffer.charAt(0, 0)).toBe('█');
		expect(styles.get(buffer.styleAt(0, 0)).fg).toBe(palette(2));
	});

	it('should paint a lone bottom pixel as a lower block', () => {
		const { buffer, painter, styles } = surface(1, 1);
		const pixels = new Pixels(1, 1);
		pixels.set(0, 1, palette(3));
		pixels.blit(painter, 0, 0);

		expect(buffer.charAt(0, 0)).toBe('▄');
		const style = styles.get(buffer.styleAt(0, 0));
		expect([style.fg, style.bg]).toEqual([palette(3), DEFAULT_COLOR]);
	});

	it('should leave an uncoloured cell alone', () => {
		const { buffer, painter } = surface(2, 1);
		buffer.write(0, 0, 'ab', StyleTable.DEFAULT);
		const pixels = new Pixels(2, 1);
		pixels.set(1, 0, palette(5));
		pixels.blit(painter, 0, 0);

		expect(buffer.charAt(0, 0)).toBe('a');
		expect(buffer.charAt(1, 0)).toBe('▀');
	});

	it('should ignore a pixel outside the grid', () => {
		const pixels = new Pixels(1, 1);
		expect(() => {
			pixels.set(-1, 0, palette(1));
			pixels.set(0, 2, palette(1));
			pixels.set(1, 0, palette(1));
		}).not.toThrow();
		expect(pixels.get(0, 0)).toBe(DEFAULT_COLOR);
		expect(pixels.get(99, 99)).toBe(DEFAULT_COLOR);
	});

	it('should clear back to the terminal colour', () => {
		const pixels = new Pixels(2, 1);
		pixels.set(0, 0, palette(1));
		pixels.clear();
		expect(pixels.get(0, 0)).toBe(DEFAULT_COLOR);
	});
});
