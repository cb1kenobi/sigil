import { yaml } from '../src/index.js';
import { file } from './helpers.js';
import { createConfigSync, type ConfigSchema } from '@ttylabs/sigil/config';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

/**
 * The schema version, which is the one place this store could silently disagree
 * with the rest of the library.
 *
 * Every row here is a **measurement of the parser** rather than a reading of a
 * spec, which is the point: the argument for pinning rests on the two versions
 * differing, and a table nobody ran is a table that goes stale when `yaml`
 * changes its mind.
 */
describe('the schema version', () => {
  /** What the store reads a one-key document as. */
  const value = (body: string): unknown => (yaml(file(body)).readSync().value as { a: unknown }).a;

  it('should read YAML 1.2 core, which is what the store pins', () => {
    // the Norway problem: 1.1 reads these five as booleans and 1.2's core
    // schema reads them as the strings they are
    expect(value('a: yes')).toBe('yes');
    expect(value('a: no')).toBe('no');
    expect(value('a: on')).toBe('on');
    expect(value('a: off')).toBe('off');
    expect(value('a: NO')).toBe('NO');

    // and the two that would actually bite a CLI config, which the Norway
    // problem gets the attention for: a file mode and a time
    expect(value('a: 017')).toBe(17);
    expect(value('a: 12:30')).toBe('12:30');
    expect(value('a: 1:2:3')).toBe('1:2:3');

    // the rest of the core schema, so that pinning the version has not pinned
    // away the typing this store exists to hand over
    expect(value('a: 8080')).toBe(8080);
    expect(value('a: 1.5')).toBe(1.5);
    expect(value('a: true')).toBe(true);
    expect(value('a: null')).toBe(null);
    expect(value('a: ~')).toBe(null);
    expect(value('a: 0x1f')).toBe(31);
    expect(value('a: 0o17')).toBe(15);
    expect(value('a: "8080"')).toBe('8080');
    expect(value('a: .inf')).toBe(Infinity);
  });

  it('should differ from YAML 1.1 on every one of those, which is why it is pinned', () => {
    // the other half of the claim, measured against the same parser: without
    // the pin, a `yaml` whose default moved would move what a user's file means
    const under11 = (body: string): unknown =>
      (parseDocument(body, { merge: true, version: '1.1' }).toJS() as { a: unknown }).a;

    expect(under11('a: yes')).toBe(true);
    expect(under11('a: no')).toBe(false);
    expect(under11('a: on')).toBe(true);
    expect(under11('a: off')).toBe(false);
    expect(under11('a: NO')).toBe(false);
    expect(under11('a: 017')).toBe(15);
    expect(under11('a: 12:30')).toBe(750);
    expect(under11('a: 1:2:3')).toBe(3723);
    expect(under11('a: 1_000')).toBe(1000);
    expect(under11('a: 0o17')).toBe('0o17');
    expect(under11('a: 2026-10-19')).toBeInstanceOf(Date);
  });

  /**
   * The ticket's own table, asserted through a real `createConfigSync()`.
   *
   * What it establishes is that on **this library's** `bool` vocabulary the two
   * versions happen to agree -- `yes` reaches a `bool` setting as `true` whether
   * the parser handed over the string or the boolean -- and that the agreement
   * is a property of two vocabularies settled independently rather than of
   * anything either one knows about the other.
   */
  describe('what a scalar reaches a setting as', () => {
    const setting = (body: string, schema: ConfigSchema): unknown =>
      createConfigSync({ layers: [{ name: 'u', store: yaml(file(body)) }], schema }).get('a');

    it('should read yes, no, on and off as a bool either version would agree about', () => {
      const bool: ConfigSchema = { a: { type: 'bool' } };

      expect(setting('a: yes', bool)).toBe(true);
      expect(setting('a: no', bool)).toBe(false);
      expect(setting('a: on', bool)).toBe(true);
      expect(setting('a: off', bool)).toBe(false);
      // and the boolean 1.1 would have produced, which is the other half of
      // "the two versions agree here"
      expect(setting('a: true', bool)).toBe(true);
      expect(setting('a: false', bool)).toBe(false);
    });

    it('should read a number as the type the schema declared', () => {
      expect(setting('a: 8080', { a: { type: 'int' } })).toBe(8080);
      // a leading zero is **not** kept, which is the ticket's own table's one
      // wrong row: 1.2's core int is `[-+]?[0-9]+`, so `08080` is the decimal
      // number 8080 rather than the string `'08080'`. Which is the lossy guess
      // AGENTS.md records refusing for the parser's `auto` type -- `007`
      // becoming `7` -- arriving from the file's own grammar rather than from a
      // coercion this library chose
      expect(setting('a: 08080', { a: { type: 'int' } })).toBe(8080);
      expect(setting('a: 1.5', { a: { type: 'number' } })).toBe(1.5);
    });

    it('should read an ISO date as a date, which is the one YAML 1.1 types itself', () => {
      // 1.2 core has no timestamp tag, so this arrives as a string and
      // `transformValue()` reads it -- where 1.1 would have handed over a `Date`
      // and `checkValue()` would have taken that. Both work, by two routes
      expect(setting('a: 2026-10-19T00:00:00Z', { a: { type: 'date' } })).toBeInstanceOf(Date);
    });
  });

  it('should enable merge keys, which the core schema does not have', () => {
    // without `merge: true` a `<<` is a literal key spelled `<<`, which is a
    // file that reads **wrong** rather than one that errors
    const value = yaml(file('base: &b\n  p: 1\nc:\n  <<: *b\n  q: 2\n')).readSync().value;
    expect(value).toStrictEqual({ base: { p: 1 }, c: { p: 1, q: 2 } });
  });

  it('should read two keys that name one path as a duplicate, which plain YAML does not', () => {
    // `1: a` and `"1": b` are two distinct YAML keys and one config path, so
    // without the comparator in `options.ts` the second silently wins -- one
    // setting with two answers and nothing said
    expect(() => yaml(file('1: a\n"1": b\n')).readSync()).toThrow(/unique/i);

    // and the plain duplicate, so that widening the comparator has not replaced
    // the check it widens
    expect(() => yaml(file('a: 1\na: 2\n')).readSync()).toThrow(/unique/i);
  });

  it('should allow two merge keys in one map, which the comparator must not refuse', () => {
    // `yaml`'s own comparator special-cases `<<` and a custom one replaces it,
    // so the symbol exclusion in `samePath()` is what keeps this legal
    const value = yaml(file('p: &p\n  x: 1\nq: &q\n  y: 2\nc:\n  <<: *p\n  <<: *q\n')).readSync()
      .value;
    expect((value as { c: unknown }).c).toStrictEqual({ x: 1, y: 2 });
  });
});
