import * as coerce from '../src/util/coerce.js';
import { daysInMonth, transformValue } from '../src/util/transform.js';
import { describe, expect, it } from 'vitest';

describe('@ttylabs/sigil/coerce', () => {
  it('should publish transformValue() and daysInMonth() and nothing else', () => {
    // the contract is the signature and the error sentences of these two; the
    // data type sets, checkValue() and assertChoices() are the parser's own and
    // stay behind `transform.ts`, so a helper added there does not become
    // public by being exported from its own module
    expect(Object.keys(coerce).sort()).toEqual(['daysInMonth', 'transformValue']);
  });

  it('should be the function the parser coerces with rather than a copy', () => {
    expect(coerce.transformValue).toBe(transformValue);
    expect(coerce.daysInMonth).toBe(daysInMonth);
  });

  it('should coerce a string to a declared type with the parser sentences', () => {
    expect(coerce.transformValue('8080', 'int')).toBe(8080);
    expect(coerce.transformValue('yes', 'bool')).toBe(true);
    expect(coerce.transformValue('2024-06-15', 'date')).toBeInstanceOf(Date);
    expect(() => coerce.transformValue('eight', 'int')).toThrow('Invalid integer: eight');
    expect(() => coerce.transformValue('2024-02-30', 'date')).toThrow('Invalid date: "2024-02-30"');
  });

  it('should count the days in a month the way the parser does', () => {
    expect(coerce.daysInMonth(2024, 2)).toBe(29);
    expect(coerce.daysInMonth(2023, 2)).toBe(28);
    expect(coerce.daysInMonth(1900, 2)).toBe(28);
    expect(coerce.daysInMonth(2024, 12)).toBe(31);
  });
});
