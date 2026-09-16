import type { DataType } from '../types.js';

const boolFalseRE = /^(false|f|no|n|off|0)$/i;
const boolTrueRE = /^(true|t|yes|y|on|1)$/i;
const dateRE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d+)?Z?)?$/i;
const dateIntRE = /^\d{13}$/;
const dateInvalid = /^Invalid Date$/i;
const hexRE = /^0x[A-Fa-f0-9]+$/;
const intRE = /^-?\d+$/;
const noRE = /^no?$/i;
const yesRE = /^y(es)?$/i;

/**
 * The number of days in a month, without asking the local time zone: day 0 of
 * the next month is the last day of this one, and `Date.UTC` keeps the
 * arithmetic out of wherever the process happens to be running.
 *
 * @param year - The full year.
 * @param month - The month, 1-12.
 * @returns The last day of that month.
 */
function daysInMonth(year: number, month: number): number {
	return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function transformValue(
	value: string,
	type: DataType | string
): Date | number | boolean | string | unknown {
	if (type === 'bool') {
		// an omitted value is false, the same way `--num` with no value is 0
		if (!value) {
			return false;
		}
		if (boolTrueRE.test(value)) {
			return true;
		}
		if (boolFalseRE.test(value)) {
			return false;
		}
		throw new Error(`Invalid boolean: "${value}"`);
	}

	if (type === 'date') {
		let date;
		let m;

		if (dateIntRE.test(value)) {
			const num = Number(value);
			if (!isNaN(num) && num > 0) {
				date = new Date(num);
			}
		} else {
			m = value.match(dateRE);
			if (m) {
				// `dateRE` only checks the shape, and `Date` overflows rather than
				// refusing: `2024-02-30` came back as March 1st, so a day that does not
				// exist produced the wrong day instead of the error `9999-99-99` already
				// got. The calendar is checked here rather than by reading the parts back
				// off the `Date`, because the getters that would read them are local while
				// the value may be UTC -- `2024-06-15T00:00:00Z` is the 14th in Chicago
				// and the 15th in Auckland, so a round trip rejected real instants
				// depending on where it ran
				const [year, month, day] = m[0].split(/\D/, 3).map(Number);

				if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
					throw new Error(`Invalid date: "${value}"`);
				}

				date = new Date(m[1] ? m[0] : `${m[0]}T00:00:00`);
			}
		}

		if (!date || dateInvalid.test(date.toString())) {
			throw new Error(`Invalid date: "${value}"`);
		}

		return date;
	}

	// a counter is an int that argv increments rather than writes, so a value that
	// reaches it from anywhere else -- the environment, a string `default` -- is
	// coerced and rejected the same way: without this it stayed a string, and
	// `VERBOSE=lots` put the word "lots" on a destination the types call a number
	if (type === 'int' || type === 'count') {
		// a counter is a flag, and a flag with no value is off: `bool` reads an empty
		// value as false, so an empty counter is 0 rather than an error. `VERBOSE=` in
		// the environment means the variable is there and says nothing, which for a
		// flag is a reading it has -- off.
		//
		// `int` is not a flag and has no such reading: empty is not an integer, so it
		// is rejected the way `date` and `json` reject it. That is the whole rule --
		// an empty value is a value only where the type has one, which is `string`
		// and the two flag types
		if (type === 'count' && !value) {
			return 0;
		}

		let num;
		if ((!hexRE.test(value) && !intRE.test(value)) || isNaN((num = Number(value)))) {
			throw new Error(`Invalid ${type === 'count' ? 'count' : 'integer'}: ${value}`);
		}

		// past 2^53-1 a `number` is not the integer that was written -- `Number` maps
		// `9007199254740993` to `...992` -- so an id given to an `int` option came back
		// as a different id and nothing said so. Every other data type rejects input it
		// cannot represent, and silently returning the wrong integer is the one failure
		// a caller cannot detect
		if (!Number.isSafeInteger(num)) {
			throw new Error(
				`${type === 'count' ? 'Count' : 'Integer'} is too large to be exact: ${value}`
			);
		}

		return num;
	}

	if (type === 'json') {
		try {
			return JSON.parse(value);
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
		} catch (e: any) {
			throw new Error(`Invalid JSON: ${e.message}`);
		}
	}

	if (type === 'number') {
		// `Number('')` and `Number(' ')` are both 0, which would make an empty or
		// blank value parse as zero where every other valued type rejects it. Neither
		// is a number somebody wrote
		if (!value.trim()) {
			throw new Error(`Invalid number: ${value}`);
		}

		const num = Number(value);
		if (isNaN(num)) {
			throw new Error(`Invalid number: ${value}`);
		}
		return num;
	}

	if (type === 'yesno') {
		if (yesRE.test(value)) {
			return true;
		}
		if (noRE.test(value)) {
			return false;
		}
		throw new Error('Value must be "yes" or "no"');
	}

	if (type === 'auto' && typeof value === 'string') {
		// an empty or blank value is a string, not zero
		if (!value.trim()) {
			return value;
		}

		const lvalue = value.toLowerCase();

		// try as a boolean
		if (lvalue === 'true') {
			return true;
		}

		if (lvalue === 'false') {
			return false;
		}

		// try as a date
		const m = value.match(dateRE);
		if (m) {
			return new Date(m[1] ? m[0] : `${m[0]}T00:00:00`);
		}

		// try as a number
		const num = Number(value);
		if (!isNaN(num)) {
			return num;
		}

		// try as json
		try {
			return JSON.parse(value);
		} catch {
			// nope
		}
	}

	// return the original value
	return value;
}
