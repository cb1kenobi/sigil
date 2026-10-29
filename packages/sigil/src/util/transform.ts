import { __ } from '../i18n/index.js';
import type { DataType } from '../types.js';

/**
 * Every data type name, as the one list the three readers of it share.
 *
 * Exact membership rather than a pattern, which is what the entry about
 * anchoring was reaching for: `/^auto|bool|...|yesno$/` bound the alternation
 * looser than the anchors, so any string merely *containing* one of the middle
 * names passed -- `integer` and `boolean` being the two somebody actually types
 * -- and past the guard `transformValue()` does not know that name, so it
 * handed the raw string back and a `type: 'integer'` option quietly produced
 * `'8080'`. A `Set` cannot be got wrong that way, and there is now one of it
 * where `init-arg.ts`, `init-option.ts` and a config schema each had their own.
 *
 * Two sets because the vocabularies really differ by one: an option may be a
 * `count` and an argument may not, and neither may a config setting -- a
 * counter is a thing argv increments, and a config file has nothing to
 * increment.
 */
export const DATA_TYPES: ReadonlySet<string> = new Set([
  'auto',
  'bool',
  'date',
  'int',
  'json',
  'number',
  'string',
  'yesno',
]);

/** The data types an option may declare: every one above, plus `count`. */
export const OPTION_DATA_TYPES: ReadonlySet<string> = new Set([...DATA_TYPES, 'count']);

const boolFalseRE = /^(false|f|no|n|off|0)$/i;
const boolTrueRE = /^(true|t|yes|y|on|1)$/i;
const dateRE =
  /^\d{4}-\d{2}-\d{2}(T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-]\d{2}):(\d{2}))?)?$/i;
const dateIntRE = /^\d{13}$/;
const dateInvalid = /^Invalid Date$/i;
const hexRE = /^0x[A-Fa-f0-9]+$/;
const intRE = /^-?\d+$/;
const noRE = /^no?$/i;
const yesRE = /^y(es)?$/i;

/**
 * The two words `yesno` is named for, as values rather than as prose.
 *
 * They are interpolated into the message below so that the key is
 * `Value must be "{0}" or "{1}"` and the quoted words arrive as *data*. A
 * translator handed `Value must be "yes" or "no"` has nothing telling them the
 * quoted words are a vocabulary rather than a sentence, so they translate them
 * -- and `yesRE` then refuses the `ja` the message just asked for, which is a
 * message that parses and lies.
 *
 * Which is the whole of this ticket's rule said at the one place it bites in the
 * parser: **argv is API and stays English**, because a value in a shell script
 * must not mean something different under another `LANG`. What a *prompt*
 * accepts is the other case, and `confirm()` is where that is answered.
 */
const YES = 'yes';
const NO = 'no';

/**
 * The number of days in a month, written out rather than asked of the engine.
 *
 * It was `new Date(Date.UTC(year, month, 0)).getUTCDate()`, and `Date.UTC` maps a
 * year of 0 to 99 onto 1900 to 1999 -- so February of year 0, which is a leap
 * year, was counted with 1900's 28 days and `0000-02-29` was refused. A calendar
 * check that exists to be arithmetic, and independent of what the engine does
 * with a year, cannot read the year through the one primitive that does
 * something to it. The rule is the Gregorian one, proleptic, which is also the
 * rule ECMAScript's `Date` follows for the full four digits `dateRE` admits.
 *
 * Exported for the `date()` prompt, which steps a day against the month it is in
 * and has to agree with the parser about how long that month is.
 *
 * @param year - The full year.
 * @param month - The month, 1-12.
 * @returns The last day of that month.
 */
export function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  }
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/**
 * Builds the `Date` that a `dateRE` match describes, or nothing where it
 * describes a date that does not exist.
 *
 * `date` and `auto` match the same `dateRE`, and only `date` checked what it
 * matched -- so `auto` kept the defect `date` was fixed for, on the path
 * undeclared options coerce with. One function because the two reading one
 * pattern and disagreeing about what it proves is how that happened. What
 * follows a value that is not a date is the caller's: `date` throws, `auto`
 * goes on guessing.
 *
 * @param m - A `dateRE` match.
 * @returns The date, or `undefined` if the match is not one.
 */
function fromDateMatch(m: RegExpMatchArray): Date | undefined {
  // `dateRE` only checks the shape, and `Date` overflows rather than refusing:
  // `2024-02-30` came back as March 1st, so a day that does not exist produced
  // the wrong day instead of the error `9999-99-99` already got. The calendar is
  // checked here rather than by reading the parts back off the `Date`, because
  // the getters that would read them are local while the value may be UTC --
  // `2024-06-15T00:00:00Z` is the 14th in Chicago and the 15th in Auckland, so a
  // round trip rejected real instants depending on where it ran
  const [year, month, day] = m[0].split(/\D/, 3).map(Number);

  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return;
  }

  // the clock overflows the same way the calendar does, and hour 24 is the
  // overflow the `Invalid Date` guard below cannot see: `24` is a legal two-digit
  // match and `2024-01-01T24:00:00` is a perfectly valid `Date` -- the next
  // midnight -- so a value naming one day arrived as the day after it, exactly as
  // `2024-02-30` arrived as March 1st. Minute and second 60 happen to be refused
  // by `Date`, and are refused here anyway so that a leap second is this
  // library's answer rather than an engine's
  if (m[1] && (Number(m[2]) > 23 || Number(m[3]) > 59 || Number(m[4]) > 59)) {
    return;
  }

  // an offset is the rest of the clock and is read the same way: out of range it
  // falls outside the one string format `Date` is specified to parse, and what an
  // engine does with a string outside that format is its own business -- which is
  // the reason none of this is left to `Date` to begin with
  if (m[5] !== undefined && (Math.abs(Number(m[5])) > 23 || Number(m[6]) > 59)) {
    return;
  }

  // the shape still admits what the guards above do not cover, and `Date` answers
  // that with an `Invalid Date` rather than by refusing -- an object whose
  // `getTime()` is `NaN` with nothing having said so
  const date = new Date(m[1] ? m[0] : `${m[0]}T00:00:00`);

  return dateInvalid.test(date.toString()) ? undefined : date;
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
    throw new Error(__`Invalid boolean: "${value}"`);
  }

  if (type === 'date') {
    let date;

    if (dateIntRE.test(value)) {
      const num = Number(value);
      if (!isNaN(num) && num > 0) {
        date = new Date(num);
      }
    } else {
      const m = value.match(dateRE);
      if (m) {
        date = fromDateMatch(m);
      }
    }

    if (!date) {
      throw new Error(__`Invalid date: "${value}"`);
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
      // two keys rather than a noun interpolated into one: `Invalid {0}: {1}`
      // would put the English word `count` through a slot, where what a
      // translator needs is the whole sentence
      throw new Error(
        type === 'count' ? __`Invalid count: ${value}` : __`Invalid integer: ${value}`
      );
    }

    // past 2^53-1 a `number` is not the integer that was written -- `Number` maps
    // `9007199254740993` to `...992` -- so an id given to an `int` option came back
    // as a different id and nothing said so. Every other data type rejects input it
    // cannot represent, and silently returning the wrong integer is the one failure
    // a caller cannot detect
    if (!Number.isSafeInteger(num)) {
      throw new Error(
        type === 'count'
          ? __`Count is too large to be exact: ${value}`
          : __`Integer is too large to be exact: ${value}`
      );
    }

    return num;
  }

  if (type === 'json') {
    try {
      return JSON.parse(value);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      throw new Error(__`Invalid JSON: ${e.message}`);
    }
  }

  if (type === 'number') {
    // `Number('')` and `Number(' ')` are both 0, which would make an empty or
    // blank value parse as zero where every other valued type rejects it. Neither
    // is a number somebody wrote
    if (!value.trim()) {
      throw new Error(__`Invalid number: ${value}`);
    }

    const num = Number(value);
    if (isNaN(num)) {
      throw new Error(__`Invalid number: ${value}`);
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
    throw new Error(__`Value must be "${YES}" or "${NO}"`);
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

    // try as a date. A date-shaped string that is not a date is not an error
    // here the way it is for `date`: `auto` is a ladder of guesses that ends at
    // the string it was handed -- it does not throw on JSON it cannot parse
    // either -- so `2024-02-30` is simply not the date guess, and falls through
    // to the string it always was. Throwing would fail the parse over an
    // undeclared option, which is the default path `auto` sits on and the one
    // place nobody asked for a date at all
    const m = value.match(dateRE);
    if (m) {
      const date = fromDateMatch(m);
      if (date) {
        return date;
      }
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

/**
 * Validates a value against a list of allowed choices.
 *
 * Here rather than in `parse.ts` because there are two readers now: an option
 * or argument declaring `choices`, and a config setting declaring one. Two
 * implementations would be two answers to "is this value allowed", and the
 * reason this one is worth sharing rather than copying is the oddity it
 * carries: membership is `includes()`, which compares a `Date` and an object by
 * **identity**, so a `choices` list of either is a declaration no value can
 * satisfy. That is true of a command line as well, and it is exactly the kind
 * of property that a second copy quietly disagrees about.
 *
 * @param choices - The allowed values, if the definition declared any.
 * @param value - The resolved value.
 * @param label - The option, argument or setting named in the error message.
 */
export function assertChoices(
  choices: readonly unknown[] | undefined,
  value: unknown,
  label: string
): void {
  if (!Array.isArray(choices) || value === undefined) {
    return;
  }

  for (const v of Array.isArray(value) ? value : [value]) {
    if (!choices.includes(v)) {
      throw new Error(__`Invalid value "${v}" for ${label}`);
    }
  }
}

/**
 * The data types whose non-string values are integers, as the one place that
 * pairing is written down.
 *
 * `count` is not a config data type and is handled anyway, for the reason
 * `transformValue()` handles it beside `int`: the two functions read one
 * vocabulary, and a type name one of them knows and the other does not is how
 * they come to disagree.
 */
const INTEGER_TYPES = new Set(['count', 'int']);

/**
 * Renders a value for a message slot.
 *
 * The slot carries the **value** rather than a word for its kind, which is what
 * lets every message below be one of the parser's own existing keys: a
 * `Expected an integer, got a number` would put the English words "a number"
 * through a slot, and the i18n work already records why that is the wrong shape
 * -- a translator needs the whole sentence, and `Invalid {0}: {1}` with a noun
 * in the first slot is a sentence they cannot write.
 *
 * `String()` is not enough on its own, because `String({ a: 1 })` is
 * `[object Object]` -- a message about a value that shows nothing about it. JSON
 * where that works, capped, because a message is a line rather than a document.
 *
 * @param value - The value.
 * @returns Something short enough to put in a sentence.
 */
function show(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (value === undefined) {
    return 'undefined';
  }

  // a `Date` has a `toJSON` that answers `null` for an invalid one, so
  // `JSON.stringify(new Date(NaN))` is the string `"null"` -- a message about a
  // date that says nothing about a date. `String()` answers `Invalid Date`,
  // which is the one thing a reader needs to see, and an ISO-ish string for a
  // valid one. The one value kind in this vocabulary whose JSON lies about it
  if (value instanceof Date) {
    return String(value);
  }

  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    // a cycle, or a `BigInt`, which `JSON.stringify` throws on
    text = Object.prototype.toString.call(value);
  }

  return text.length > 40 ? `${text.slice(0, 39)}\u2026` : text;
}

/**
 * Takes a value that arrives **already typed** and answers with it where the
 * declared data type can hold it.
 *
 * `transformValue()` turns a *string* into a value, which is the right function
 * for argv, for an environment variable and for a string `default` -- and the
 * wrong one for the only source `@ttylabs/sigil/config` exists for. A JSON or a
 * YAML file hands back `true`, `8080` and `{...}` already typed, and the
 * parser's own `default` path records what happens to those: "non-string
 * defaults pass through untouched", which is deliberate there because the
 * author wrote the value in code, in the right type. A user's config file is
 * not that.
 *
 * So this sits beside `transformValue()` and reads the same vocabulary, which
 * is what keeps one definition of what an `int` is. A **string** is handed
 * straight to it rather than being refused, and that is the decision rather
 * than a convenience: it is what makes an all-strings format work at all --
 * XML has no other scalar kind -- and it is what stops three readers of one
 * question disagreeing, since `--shake=off`, `SHAKE=off` and `"shake": "off"`
 * would otherwise mean three different things. `transformValue()`'s vocabulary
 * is strict and symmetric, so a string that is not one of the words it knows
 * throws rather than becoming a setting nobody chose.
 *
 * @param value - The value, typed or not.
 * @param type - The declared data type.
 * @returns The value, coerced where it arrived as a string.
 * @throws If the type cannot hold what arrived.
 */
export function checkValue(value: unknown, type: DataType | string): unknown {
  // a string is the one case the parser's own coercion already answers, and it
  // answers it better than a second reading would
  if (typeof value === 'string') {
    return transformValue(value, type);
  }

  // `auto` is a ladder of guesses over a string, and a value that is already
  // typed needs no guessing -- so there is nothing for it to check. `json` is
  // the same statement about a different thing: what it means is "whatever
  // `JSON.parse` produced", and this value is past that
  if (type === 'auto' || type === 'json') {
    return value;
  }

  if (type === 'bool') {
    if (typeof value !== 'boolean') {
      throw new Error(__`Invalid boolean: "${show(value)}"`);
    }
    return value;
  }

  if (type === 'yesno') {
    if (typeof value !== 'boolean') {
      throw new Error(__`Value must be "${YES}" or "${NO}"`);
    }
    return value;
  }

  if (type === 'date') {
    // a `Date` is what an object layer can hold and no text format can, and an
    // epoch is what `transformValue()` already reads a 13-digit string as --
    // so the two agree about what a number means rather than one of them
    // having a second idea.
    //
    // Which took a review round to be true: the test was `isFinite(value) &&
    // value > 0`, which is far wider than `dateIntRE`, so `8080` was a date in
    // 1969 where `"8080"` throws -- and a *fraction* was one too, truncated to
    // the epoch, which is a value no spelling of this type accepts. A file
    // holding `"when": 8080` is a port somebody put on the wrong line, and the
    // whole reason `checkValue()` exists is that a file and an option cannot
    // come to disagree
    if (value instanceof Date) {
      if (Number.isNaN(value.getTime())) {
        throw new Error(__`Invalid date: "${show(value)}"`);
      }
      return value;
    }
    if (Number.isInteger(value) && (value as number) >= 1e12 && (value as number) < 1e13) {
      return new Date(value as number);
    }
    throw new Error(__`Invalid date: "${show(value)}"`);
  }

  if (INTEGER_TYPES.has(type)) {
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      throw new Error(
        type === 'count' ? __`Invalid count: ${show(value)}` : __`Invalid integer: ${show(value)}`
      );
    }
    // past 2^53-1 a `number` is not the integer that was written, which is the
    // one failure a caller cannot detect -- the rule `transformValue()` already
    // keeps for the string spelling of the same value
    if (!Number.isSafeInteger(value)) {
      throw new Error(
        type === 'count'
          ? __`Count is too large to be exact: ${value}`
          : __`Integer is too large to be exact: ${value}`
      );
    }
    return value;
  }

  if (type === 'number') {
    // `NaN` and nothing else: `transformValue('Infinity', 'number')` is
    // `Infinity`, so refusing it here would make the two spellings of one value
    // disagree
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new Error(__`Invalid number: ${show(value)}`);
    }
    return value;
  }

  if (type === 'string') {
    // every string already returned above, so anything reaching here is not
    // one. Refused rather than coerced: a number where a string was declared is
    // a mistake in the file worth reporting, and `String(value)` would turn it
    // into a setting that looks right.
    //
    // The one new key this function needs, and it is new because the parser
    // never had to refuse a *non-string* for a `string` option -- argv hands
    // over nothing else
    throw new Error(__`Invalid string: ${show(value)}`);
  }

  // an unrecognized type name is the caller's to refuse where the declaration
  // was written -- `initOption()` does, with an anchored pattern, and
  // `assertSettings()` does the same for a config schema. Returning the value
  // untouched is what `transformValue()` does with one, so the two agree
  return value;
}
