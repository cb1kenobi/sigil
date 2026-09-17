import {
	ATTR,
	BLANK,
	CellBuffer,
	cellWidth,
	CONTINUATION,
	DEFAULT_COLOR,
	DEFAULT_STYLE,
	Painter,
	palette,
	rgb,
	type Style,
	StyleTable,
} from '../../src/canvas/index.js';
import { describe, expect, it } from 'vitest';

const style = (over: Partial<Style> = {}): Style => ({ ...DEFAULT_STYLE, ...over });

describe('StyleTable', () => {
	it('should give the default style index zero', () => {
		const table = new StyleTable();
		expect(table.intern(DEFAULT_STYLE)).toBe(StyleTable.DEFAULT);
		expect(StyleTable.DEFAULT).toBe(0);
	});

	it('should hand back the same index for an equal style', () => {
		const table = new StyleTable();
		const a = table.intern(style({ fg: palette(1) }));
		const b = table.intern(style({ fg: palette(1) }));
		expect(a).toBe(b);
		expect(table.size).toBe(2);
	});

	it('should distinguish styles that differ in any field', () => {
		const table = new StyleTable();
		const indices = new Set([
			table.intern(style({ fg: palette(1) })),
			table.intern(style({ bg: palette(1) })),
			table.intern(style({ attrs: ATTR.bold })),
			table.intern(style({ fg: rgb(255, 0, 0) })),
		]);
		expect(indices.size).toBe(4);
	});

	it('should not collide when two fields and the attributes all vary', () => {
		// the arithmetic key this replaced packed two 25-bit colours and eight
		// attribute bits into one number -- 58 bits, so the product ran past
		// MAX_SAFE_INTEGER and rounded the attributes away. Bold truecolor text
		// interned as plain truecolor text and rendered unstyled
		const table = new StyleTable();
		const plain = table.intern(style({ fg: rgb(200, 100, 50) }));
		const bold = table.intern(style({ fg: rgb(200, 100, 50), attrs: ATTR.bold }));
		expect(plain).not.toBe(bold);
		expect(table.get(bold).attrs).toBe(ATTR.bold);

		// and two unrelated pairs that the old key mapped onto one entry
		const a = table.intern(style({ fg: palette(0), bg: rgb(255, 255, 5) }));
		const b = table.intern(style({ fg: palette(1), bg: palette(4) }));
		expect(a).not.toBe(b);
		expect(table.get(a).bg).toBe(rgb(255, 255, 5));
		expect(table.get(b).bg).toBe(palette(4));
	});

	it('should fill a partial style from the defaults', () => {
		const table = new StyleTable();
		const index = table.intern({ fg: palette(4) });
		expect(table.get(index)).toEqual({ attrs: 0, bg: DEFAULT_COLOR, fg: palette(4) });
	});

	it('should freeze the default style, which is index zero', () => {
		// index 0 is what every cell starts with, and `get()` handed back the
		// exported object itself -- so one write made the diff start every frame
		// from a "default" that was not one
		const table = new StyleTable();
		expect(Object.isFrozen(table.get(0))).toBe(true);
		expect(Object.isFrozen(DEFAULT_STYLE)).toBe(true);
	});

	it('should refuse a colour channel rather than clamping it', () => {
		// clamping is how `rgb(NaN, 0, 0)` becomes black and `rgb(256, -1, 1.9)`
		// becomes near-but-not-what-was-asked-for. The styler refuses; so does this
		expect(() => rgb(Number.NaN, 0, 0)).toThrow(TypeError);
		expect(() => rgb(256, 0, 0)).toThrow(TypeError);
		expect(() => rgb(0, -1, 0)).toThrow(TypeError);
		expect(() => rgb(0, 0, 1.9)).toThrow(TypeError);
		expect(() => palette(300)).toThrow(TypeError);
		expect(() => palette(-5)).toThrow(TypeError);
		expect(() => palette(1.9)).toThrow(TypeError);
	});

	it('should refuse a style that is not one', () => {
		// `undefined` propagates all the way to `38;5;undefined`, which a terminal
		// drops and nobody can trace back
		const table = new StyleTable();
		expect(() => table.intern({ fg: Number.NaN })).toThrow(TypeError);
		expect(() => table.intern({ bg: 1.5 })).toThrow(TypeError);
		expect(() => table.intern({ attrs: -1 })).toThrow(TypeError);
	});

	it('should not let a caller rewrite an interned style', () => {
		const table = new StyleTable();
		const index = table.intern(style({ fg: palette(2) }));
		expect(() => {
			(table.get(index) as { fg: number }).fg = palette(5);
		}).toThrow();
		expect(table.get(index).fg).toBe(palette(2));
	});

	it('should not collide across the colour ranges', () => {
		// a palette index and a 24-bit colour share no numeric space, and the key
		// has to keep them apart or two different styles become one
		const table = new StyleTable();
		const seen = new Set<number>();
		for (let i = 0; i < 256; i++) {
			seen.add(table.intern(style({ fg: palette(i) })));
			seen.add(table.intern(style({ bg: palette(i) })));
		}
		for (const [r, g, b] of [
			[0, 0, 0],
			[255, 255, 255],
			[1, 2, 3],
			[0, 0, 1],
		]) {
			seen.add(table.intern(style({ fg: rgb(r, g, b) })));
			seen.add(table.intern(style({ bg: rgb(r, g, b) })));
		}
		seen.add(table.intern(style({ fg: DEFAULT_COLOR, bg: DEFAULT_COLOR })));
		// every distinct style got a distinct index
		expect(seen.size).toBe(table.size);
	});

	it('should copy the style it interns', () => {
		const table = new StyleTable();
		const mutable = style({ fg: palette(2) });
		const index = table.intern(mutable);
		mutable.fg = palette(5);
		expect(table.get(index).fg).toBe(palette(2));
	});

	it('should answer with the default style for an index nothing interned', () => {
		expect(new StyleTable().get(999)).toEqual(DEFAULT_STYLE);
	});
});

describe('CellBuffer', () => {
	it('should start as blanks in the default style', () => {
		const buffer = new CellBuffer(3, 2);
		expect(buffer.toLines()).toEqual(['   ', '   ']);
		expect(buffer.styleAt(0, 0)).toBe(StyleTable.DEFAULT);
	});

	it('should strip escape sequences rather than painting them as text', () => {
		// the ESC is zero width so it takes no cell, but `[31m` is four ordinary
		// characters -- every existing component builds strings like this
		const buffer = new CellBuffer(10, 1);
		const ESC = String.fromCharCode(0x1b);
		buffer.write(0, 0, `${ESC}[31mred${ESC}[39m`, 0);
		expect(buffer.toString()).toBe('red');
	});

	it('should write text', () => {
		const buffer = new CellBuffer(6, 1);
		expect(buffer.write(0, 0, 'hi', 0)).toBe(2);
		expect(buffer.toLines()).toEqual(['hi    ']);
	});

	it('should clip at the right edge', () => {
		const buffer = new CellBuffer(3, 1);
		buffer.write(0, 0, 'hello', 0);
		expect(buffer.toLines()).toEqual(['hel']);
	});

	it('should refuse coordinates off the grid', () => {
		const buffer = new CellBuffer(3, 1);
		expect(buffer.put(-1, 0, 'x', 0)).toBe(0);
		expect(buffer.put(0, 5, 'x', 0)).toBe(0);
		expect(buffer.put(3, 0, 'x', 0)).toBe(0);
		expect(buffer.toLines()).toEqual(['   ']);
	});

	describe('wide clusters', () => {
		it('should take two columns and leave a continuation', () => {
			const buffer = new CellBuffer(4, 1);
			expect(buffer.put(0, 0, '漢', 0)).toBe(2);
			expect(buffer.charAt(0, 0)).toBe('漢');
			expect(buffer.charAt(1, 0)).toBe(CONTINUATION);
			expect(buffer.charAt(2, 0)).toBe(BLANK);
		});

		it('should read back as text without doubling the cluster', () => {
			const buffer = new CellBuffer(4, 1);
			buffer.write(0, 0, '漢字', 0);
			// two clusters, four columns, and the line still says what it renders
			expect(buffer.toLines()).toEqual(['漢字']);
		});

		it('should blank the other half when its lead is overwritten', () => {
			const buffer = new CellBuffer(4, 1);
			buffer.put(0, 0, '漢', 0);
			buffer.put(0, 0, 'a', 0);
			expect(buffer.charAt(0, 0)).toBe('a');
			// the orphaned continuation would otherwise render as half a glyph
			expect(buffer.charAt(1, 0)).toBe(BLANK);
		});

		it('should blank the lead when its continuation is overwritten', () => {
			const buffer = new CellBuffer(4, 1);
			buffer.put(0, 0, '漢', 0);
			buffer.put(1, 0, 'b', 0);
			expect(buffer.charAt(0, 0)).toBe(BLANK);
			expect(buffer.charAt(1, 0)).toBe('b');
		});

		it('should break both neighbours when a wide cluster lands across two', () => {
			const buffer = new CellBuffer(6, 1);
			buffer.put(0, 0, '漢', 0);
			buffer.put(2, 0, '字', 0);
			// lands on the continuation of the first and the lead of the second
			buffer.put(1, 0, '한', 0);
			expect(buffer.charAt(0, 0)).toBe(BLANK);
			expect(buffer.charAt(1, 0)).toBe('한');
			expect(buffer.charAt(2, 0)).toBe(CONTINUATION);
			expect(buffer.charAt(3, 0)).toBe(BLANK);
		});

		it('should refuse to paint half a cluster at the right edge', () => {
			const buffer = new CellBuffer(3, 1);
			expect(buffer.put(2, 0, '漢', 0)).toBe(1);
			// half a wide glyph is worse than none, so the column takes a blank
			expect(buffer.charAt(2, 0)).toBe(BLANK);
		});

		it('should stop a string before a cluster that will not fit', () => {
			const buffer = new CellBuffer(3, 1);
			buffer.write(0, 0, 'a漢b', 0);
			expect(buffer.toLines()).toEqual(['a漢']);
		});
	});

	describe('a cluster wider than two columns', () => {
		it('should be held in two cells, not in one with a gap after it', () => {
			// `graphemeWidth()` sums what a cluster contains, and a CJK character
			// with a spacing mark comes to three. A grid has no third cell: the
			// cluster went into one, the cursor advanced by three, and the cells in
			// between were never drawn while still holding content nothing painted
			// over
			const buffer = new CellBuffer(8, 1);
			expect(buffer.put(0, 0, '\u6F22\u0903', 0)).toBe(2);
			expect(buffer.charAt(1, 0)).toBe(CONTINUATION);
			expect(buffer.charAt(2, 0)).toBe(BLANK);
		});

		it('should leave the rest of a string where the grid can draw it', () => {
			const buffer = new CellBuffer(8, 1);
			buffer.write(0, 0, '\u6F22\u0903x', 0);
			expect(buffer.charAt(2, 0)).toBe('x');
		});

		it('should report two from cellWidth', () => {
			expect(cellWidth('\u6F22\u0903')).toBe(2);
			expect(cellWidth('a')).toBe(1);
			expect(cellWidth('\u0301')).toBe(0);
		});
	});

	describe('control characters', () => {
		it('should refuse a newline rather than dropping it', () => {
			// zero width, so it took no cell and `put()` returned 0 -- and `write()`
			// only stopped on a positive-width cluster that failed to land, so a
			// wrapped paragraph painted as one concatenated line with no complaint
			const buffer = new CellBuffer(10, 2);
			expect(() => buffer.write(0, 0, 'ab\ncd', 0)).toThrow(/control character/);
		});

		it('should refuse a tab, a carriage return, and a C1', () => {
			const buffer = new CellBuffer(10, 1);
			for (const control of ['a\tb', 'a\rb', 'a\u0085b', 'a\u0000b']) {
				expect(() => buffer.write(0, 0, control, 0)).toThrow(RangeError);
			}
		});

		it('should name the character it refused', () => {
			const buffer = new CellBuffer(10, 1);
			expect(() => buffer.write(0, 0, 'a\tb', 0)).toThrow(/U\+0009/);
		});
	});

	describe('zero-width clusters', () => {
		it('should not give a combining mark a column of its own', () => {
			const buffer = new CellBuffer(4, 1);
			// e + combining acute is one cluster, one column
			buffer.write(0, 0, 'éx', 0);
			expect(buffer.charAt(0, 0)).toBe('é');
			expect(buffer.charAt(1, 0)).toBe('x');
		});

		it('should refuse a bare combining mark', () => {
			const buffer = new CellBuffer(4, 1);
			expect(buffer.put(0, 0, '́', 0)).toBe(0);
			expect(buffer.charAt(0, 0)).toBe(BLANK);
		});
	});

	it('should lay a wide cluster two columns at a time when filling', () => {
		const buffer = new CellBuffer(10, 1);
		buffer.fill(2, 0, 4, 1, '漢', 0);
		expect(buffer.toLines()).toEqual(['  漢漢    ']);
	});

	it('should leave a rectangle short rather than overrun it', () => {
		const buffer = new CellBuffer(10, 1);
		buffer.write(0, 0, '..........', 0);
		// three columns cannot hold two wide clusters, and half of one is worse
		// than a gap -- the old loop wrote its continuation past the rectangle,
		// over whatever else had been painted there
		buffer.fill(2, 0, 3, 1, '漢', 0);
		expect(buffer.charAt(5, 0)).toBe('.');
		expect(buffer.toLines()).toEqual(['..漢......']);
	});

	it('should not loop forever on a zero-width fill cluster', () => {
		const buffer = new CellBuffer(4, 1);
		buffer.fill(0, 0, 4, 1, '\u0301', 0);
		expect(buffer.toLines()).toEqual(['    ']);
	});

	it('should fill a rectangle, clipped to the grid', () => {
		const buffer = new CellBuffer(4, 3);
		buffer.fill(1, 1, 10, 10, '#', 0);
		expect(buffer.toLines()).toEqual(['    ', ' ###', ' ###']);
	});

	it('should clear back to blanks in the default style', () => {
		const table = new StyleTable();
		const buffer = new CellBuffer(3, 1);
		buffer.write(0, 0, 'abc', table.intern(style({ fg: palette(1) })));
		buffer.clear();
		expect(buffer.toLines()).toEqual(['   ']);
		expect(buffer.styleAt(0, 0)).toBe(StyleTable.DEFAULT);
	});

	it('should discard contents on resize', () => {
		const buffer = new CellBuffer(3, 1);
		buffer.write(0, 0, 'abc', 0);
		buffer.resize(5, 2);
		expect(buffer.width).toBe(5);
		expect(buffer.height).toBe(2);
		// nothing is preserved: the layout is about to run again at the new size,
		// and stale cells would only give the diff something wrong to compare with
		expect(buffer.toLines()).toEqual(['     ', '     ']);
	});

	it('should copy from another buffer, resizing to match', () => {
		const source = new CellBuffer(3, 1);
		source.write(0, 0, 'abc', 7);
		const target = new CellBuffer(9, 4);
		target.copyFrom(source);
		expect(target.width).toBe(3);
		expect(target.height).toBe(1);
		expect(target.toLines()).toEqual(['abc']);
		expect(target.styleAt(1, 0)).toBe(7);
	});

	it('should trim trailing blanks in toString', () => {
		const buffer = new CellBuffer(6, 2);
		buffer.write(0, 0, 'hi', 0);
		expect(buffer.toString()).toBe('hi\n');
	});
});

describe('Painter', () => {
	it('should intern styles as it paints', () => {
		const table = new StyleTable();
		const buffer = new CellBuffer(5, 1);
		const painter = new Painter(buffer, table);

		painter.text(0, 0, 'ab', style({ fg: palette(3) }));
		painter.text(2, 0, 'cd', style({ fg: palette(3) }));

		expect(buffer.styleAt(0, 0)).toBe(buffer.styleAt(2, 0));
		expect(table.size).toBe(2);
	});

	it('should fill with a style', () => {
		const table = new StyleTable();
		const buffer = new CellBuffer(3, 1);
		new Painter(buffer, table).fill(0, 0, 3, 1, style({ bg: palette(4) }));
		expect(buffer.toLines()).toEqual(['   ']);
		expect(table.get(buffer.styleAt(1, 0)).bg).toBe(palette(4));
	});
});
