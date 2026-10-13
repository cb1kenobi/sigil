import { envValue } from '../../src/util/env-value.js';
import {
	assertChoices,
	checkValue,
	DATA_TYPES,
	OPTION_DATA_TYPES,
	transformValue,
} from '../../src/util/transform.js';
import { describe, expect, it } from 'vitest';

describe('checkValue', () => {
	// `transformValue()` turns a *string* into a value, which is the wrong
	// function for the only source `@ttylabs/sigil/config` exists for: a JSON or
	// YAML file hands back `true`, `8080` and `{...}` already typed
	it('should hand a string straight to transformValue', () => {
		// which is what makes an all-strings format work at all, and what stops
		// three readers of one question disagreeing about what `off` means
		for (const [value, type, want] of [
			['8080', 'int', 8080],
			['off', 'bool', false],
			['on', 'bool', true],
			['yes', 'yesno', true],
			['1.5', 'number', 1.5],
			['x', 'string', 'x'],
		] as const) {
			expect(checkValue(value, type)).to.equal(want);
			expect(checkValue(value, type)).to.equal(transformValue(value, type));
		}
	});

	it('should refuse a string the vocabulary does not know', () => {
		// strict and symmetric, so a string that is not one of the words it knows
		// throws rather than becoming a setting nobody chose
		expect(() => checkValue('nope', 'bool')).toThrow(/Invalid boolean/);
		expect(() => checkValue('eight', 'int')).toThrow(/Invalid integer/);
	});

	it.each([
		[true, 'bool'],
		[false, 'bool'],
		[true, 'yesno'],
		[8080, 'int'],
		[-1, 'int'],
		[0, 'int'],
		[1.5, 'number'],
		[Infinity, 'number'],
		[{ a: 1 }, 'json'],
		[[1, 2], 'json'],
		[null, 'json'],
		[{ a: 1 }, 'auto'],
		[42, 'auto'],
	])('should keep %o as a %s', (value, type) => {
		expect(checkValue(value, type)).to.deep.equal(value);
	});

	// every refusal is one of the parser's own keys, with the **value** through
	// the slot rather than a word for its kind -- which is what makes this
	// function cost one new key rather than seven, and what keeps a translator
	// from being handed `Invalid {0}: {1}` with an English noun in the first slot
	it.each([
		[42, 'bool', /Invalid boolean: "42"/],
		[null, 'bool', /Invalid boolean: "null"/],
		[[1], 'bool', /Invalid boolean: "\[1\]"/],
		[42, 'yesno', /Value must be "yes" or "no"/],
		[8080.5, 'int', /Invalid integer: 8080\.5/],
		['', 'int', /Invalid integer/],
		[true, 'int', /Invalid integer: true/],
		[Number.NaN, 'number', /Invalid number: NaN/],
		[true, 'number', /Invalid number: true/],
		[42, 'string', /Invalid string: 42/],
		[null, 'string', /Invalid string: null/],
		[{ a: 1 }, 'string', /Invalid string: \{"a":1\}/],
	])('should refuse %o as a %s', (value, type, message) => {
		expect(() => checkValue(value, type)).toThrow(message);
	});

	it('should show a value rather than [object Object]', () => {
		// `String({ a: 1 })` is `[object Object]`, which is a message about a value
		// that shows nothing about it
		expect(() => checkValue({ a: 1, b: [2] }, 'string')).toThrow(
			/Invalid string: \{"a":1,"b":\[2\]\}/
		);
	});

	it('should cap what it shows, because a message is a line', () => {
		let message = '';
		try {
			checkValue({ long: 'x'.repeat(200) }, 'string');
		} catch (e: unknown) {
			message = (e as Error).message;
		}
		expect(message).to.have.length.below(60);
		expect(message).to.contain('\u2026');
	});

	it('should show a value JSON cannot render', () => {
		// a cycle, and a `BigInt`, which `JSON.stringify` throws on
		const cycle: Record<string, unknown> = {};
		cycle.self = cycle;
		expect(() => checkValue(cycle, 'string')).toThrow(/Invalid string: \[object Object\]/);
		expect(() => checkValue(1n, 'string')).toThrow(/Invalid string: \[object BigInt\]/);
		expect(() => checkValue(() => 1, 'string')).toThrow(/Invalid string:/);
	});

	it('should refuse an integer too large to be exact', () => {
		// past 2^53-1 a `number` is not the integer that was written, which is the
		// one failure a caller cannot detect -- the rule `transformValue()` already
		// keeps for the string spelling of the same value
		expect(() => checkValue(2 ** 53, 'int')).toThrow(/too large to be exact/);
		expect(() => checkValue('9007199254740993', 'int')).toThrow(/too large to be exact/);
	});

	it('should take a Date and an epoch for a date', () => {
		const when = new Date('2024-06-15T00:00:00Z');
		expect(checkValue(when, 'date')).to.equal(when);
		expect(checkValue(when.getTime(), 'date')).to.deep.equal(when);
	});

	it.each([
		[new Date('nope'), /Invalid date: "Invalid Date"/],
		[0, /Invalid date: "0"/],
		[-1, /Invalid date: "-1"/],
		[Number.POSITIVE_INFINITY, /Invalid date: "Infinity"/],
		['nope', /Invalid date: "nope"/],
		[{}, /Invalid date: "\{\}"/],
	])('should refuse %o as a date', (value, message) => {
		expect(() => checkValue(value, 'date')).toThrow(message);
	});

	it('should read count the way int does, so the two cannot disagree', () => {
		// `count` is not a config data type and is handled anyway, because the two
		// functions read one vocabulary and a name one of them knows and the other
		// does not is how they come to disagree
		expect(checkValue(3, 'count')).to.equal(3);
		expect(() => checkValue(1.5, 'count')).toThrow(/Invalid count: 1\.5/);
		expect(checkValue('3', 'count')).to.equal(3);
	});

	it('should hand an unrecognized type name back untouched', () => {
		// which is what `transformValue()` does with one, so the two agree. The
		// refusal belongs where the declaration was written
		const value = { shape: 1 };
		expect(checkValue(value, 'nonsense')).to.equal(value);
		expect(checkValue('x', 'nonsense')).to.equal('x');
	});
});

describe('the data type lists', () => {
	it('should be one list rather than three', () => {
		// exact membership rather than a pattern, which is what the anchoring entry
		// was reaching for: any string merely *containing* one of the middle names
		// used to pass, and `integer` and `boolean` are the two somebody types
		expect([...DATA_TYPES].sort()).to.deep.equal([
			'auto',
			'bool',
			'date',
			'int',
			'json',
			'number',
			'string',
			'yesno',
		]);
		expect(DATA_TYPES.has('integer')).to.equal(false);
		expect(DATA_TYPES.has('boolean')).to.equal(false);
		expect(DATA_TYPES.has('count')).to.equal(false);
	});

	it('should differ by exactly count, which is argv´s to increment', () => {
		expect([...OPTION_DATA_TYPES].filter((t) => !DATA_TYPES.has(t))).to.deep.equal(['count']);
	});

	it('should name only types the coercion branches on', () => {
		// the defect this guards is the one the anchoring entry records: a name
		// that passes the declaration guard and then coerces as *nothing*, because
		// `transformValue()` hands an unrecognized name its string back untouched.
		// So each name needs an input where something happens to it -- and the
		// table has to cover the list exactly, or a type added to the list without
		// a probe here is the hole again
		const probes: Record<string, [string, unknown]> = {
			auto: ['1', 1],
			bool: ['yes', true],
			count: ['3', 3],
			date: ['1700000000000', new Date(1700000000000)],
			int: ['8080', 8080],
			json: ['[1]', [1]],
			number: ['1.5', 1.5],
			// `string` is the one name whose answer *is* the string it was handed,
			// so there is no coercion to observe -- what says the name is known is
			// that it is the default every other reader falls back to
			string: ['x', 'x'],
			yesno: ['y', true],
		};

		expect(Object.keys(probes).sort()).to.deep.equal([...OPTION_DATA_TYPES].sort());

		for (const [type, [input, want]] of Object.entries(probes)) {
			expect(transformValue(input, type), type).to.deep.equal(want);
			expect(checkValue(input, type), type).to.deep.equal(want);
		}
	});
});

describe('assertChoices', () => {
	it('should accept a value in the list and refuse one that is not', () => {
		expect(() => assertChoices(['a', 'b'], 'a', 'setting "x"')).to.not.throw();
		expect(() => assertChoices(['a', 'b'], 'c', 'setting "x"')).toThrow(
			/Invalid value "c" for setting "x"/
		);
	});

	it('should check every element of a list', () => {
		expect(() => assertChoices(['a'], ['a', 'b'], 'setting "x"')).toThrow(/"b"/);
	});

	it('should say nothing where there are no choices or no value', () => {
		expect(() => assertChoices(undefined, 'anything', 'x')).to.not.throw();
		expect(() => assertChoices(['a'], undefined, 'x')).to.not.throw();
	});

	it('should compare by identity, which a Date and an object cannot satisfy', () => {
		// the oddity worth sharing rather than copying: a `choices` list of either
		// is a declaration no value can satisfy, and that is true of a command line
		// as well
		expect(() => assertChoices([new Date(0)], new Date(0), 'x')).toThrow(/Invalid value/);
		expect(() => assertChoices([{ a: 1 }], { a: 1 }, 'x')).toThrow(/Invalid value/);
	});
});

describe('envValue', () => {
	// one function, two callers: a config setting declaring `env` and an option
	// declaring `env` must not come to disagree about what `PORT=` means
	it('should read an empty variable as unset', () => {
		expect(envValue({ PORT: '' }, ['PORT'])).to.equal(undefined);
	});

	it('should read zero and a space as values', () => {
		// only the empty string is falsy among the values a variable can hold
		expect(envValue({ PORT: '0' }, ['PORT'])).to.equal('0');
		expect(envValue({ PORT: ' ' }, ['PORT'])).to.equal(' ');
	});

	it('should take the first that is set', () => {
		expect(envValue({ A: '', B: 'b', C: 'c' }, ['A', 'B', 'C'])).to.equal('b');
	});

	it('should answer nothing where none is set', () => {
		expect(envValue({}, ['A'])).to.equal(undefined);
		expect(envValue({ A: undefined }, ['A'])).to.equal(undefined);
		expect(envValue({ A: 'a' }, [])).to.equal(undefined);
	});
});
