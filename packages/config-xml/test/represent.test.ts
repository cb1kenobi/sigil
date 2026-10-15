import { xml } from '../src/index.js';
import { file } from './helpers.js';
import { createConfigSync } from '@ttylabs/sigil/config';
import { describe, expect, it } from 'vitest';

/** What this store says about a value at a path. */
function hold(value: unknown, path = 'x'): true | string {
  return (xml(file(`<config/>`)).canRepresent as (v: unknown, p: string) => true | string)(
    value,
    path
  );
}

describe('what this store can hold', () => {
  describe('what the format cannot', () => {
    it('should refuse null and undefined, because XML has no such thing', () => {
      // core drops a key holding either before it reaches a store, so this is
      // reachable only through a `write()` a caller made directly -- which is
      // public API, and is the same reason `jsonCanHold()` is asked at both
      // doors
      expect(hold(null)).toMatch(/XML has no null/);
      expect(hold(undefined)).toMatch(/XML has no undefined/);
    });

    it('should refuse a function and a symbol', () => {
      expect(hold(() => 1)).toMatch(/no function/);
      expect(hold(Symbol('x'))).toMatch(/no symbol/);
    });

    it('should refuse a value whose string form is useless', () => {
      // a `Map` reaches a file as `[object Map]`, which is the silent-rewrite
      // class `jsonCanHold()` exists for
      expect(hold(new Map())).toMatch(/no way to write a Map/);
      expect(hold(new Set())).toMatch(/no way to write a Set/);
      class Thing {}
      expect(hold(new Thing())).toMatch(/no way to write a Thing/);
    });

    it('should refuse a value that refers back to itself', () => {
      const cycle: Record<string, unknown> = { a: 1 };
      cycle.self = cycle;
      expect(hold(cycle)).toMatch(/refers back to itself/);
    });

    it('should refuse a hole in a list', () => {
      // every array method skips one, which is the finding `jsonCanHold()`
      // records: `[1, , 2].map()` answers a sparse array, so a walk through
      // `map()` destructured a hole and threw out of the function whose whole
      // job is to name what cannot be written.
      //
      // Built rather than written as `[1, , 2]`, which `no-sparse-arrays`
      // refuses and is right to: a comma in the middle of a literal is a typo
      // far more often than it is a hole somebody meant
      const sparse = [1, 2];
      delete sparse[0];
      expect(hold(sparse)).toMatch(/no hole in a list/);
    });

    it('should allow a value referenced twice, which is a DAG rather than a cycle', () => {
      const shared = { a: '1' };
      expect(hold({ x: shared, y: shared })).toBe(true);
    });
  });

  describe('what the format turns into text, which is a saving rather than a cost', () => {
    it('should allow a number and a boolean', () => {
      // XML has no scalar kind, so these reach the file as text -- exactly what
      // `transformValue()` already coerces, and exactly how an environment
      // variable already reaches an option
      expect(hold(8080)).toBe(true);
      expect(hold(true)).toBe(true);
    });

    it('should allow a Date, because the schema reads one back', () => {
      // its ISO form is why: `transformValue(iso, 'date')` reads one back, so a
      // `Date` really does round-trip where a `Map` reaches the file as
      // `[object Map]`. The same reasoning `jsonCanHold()` records for letting
      // a `toJSON` through, narrowed to the one case the schema can read
      expect(hold(new Date())).toBe(true);
    });

    it('should round-trip a Date through a date setting', () => {
      const path = file(`<config/>`);
      const when = new Date('2026-10-14T12:00:00.000Z');
      const schema = { when: { type: 'date' as const } };
      const config = createConfigSync({
        layers: [{ name: 'f', store: xml(path, { schema }) }],
        schema,
      });
      config.set('when', when);
      config.saveSync();

      const again = createConfigSync({
        layers: [{ name: 'f', store: xml(path, { schema }) }],
        schema,
      });
      expect(again.get('when')).toStrictEqual(when);
    });
  });

  describe('what this mapping cannot tell apart', () => {
    it('should refuse an empty object, which is the same bytes as an empty string', () => {
      // the mapping picks `''`, because that is what `set('host', '')` writes:
      // picking `{}` would make a `set()` of the empty string read back as an
      // object, which is a round trip that changes a value
      expect(hold({})).toMatch(/empty object is the same bytes/);
      expect(hold({ a: {} })).toMatch(/at "x.a"/);
    });

    it('should allow an empty object at the document, where it is an empty config', () => {
      // which is what a store over a file nobody has written yet reads, and
      // `<config/>` reads back as `{}` by the root rule
      expect(hold({}, '')).toBe(true);
    });

    it('should refuse a list of one empty string, which is the same bytes as an empty list', () => {
      // an empty list writes one empty element and a declared `multiple` path
      // reads that back as `[]`
      expect(hold([''])).toMatch(/one empty string is the same bytes/);
    });

    it('should allow an empty item anywhere else in a list', () => {
      // three occurrences read back whole, so only the single-item case is
      // ambiguous
      expect(hold(['a', '', 'b'])).toBe(true);
    });

    it('should allow an empty list', () => {
      expect(hold([])).toBe(true);
    });
  });

  describe('a string whose own whitespace is load bearing', () => {
    it('should be refused, because a read trims', () => {
      // honest and inconvenient over silent and wrong, which is the direction
      // this repository already picks: the alternative is a round trip that
      // quietly changes a value
      expect(hold(' padded ')).toMatch(/XML trims a value/);
      expect(hold('\ttabbed')).toMatch(/XML trims a value/);
    });

    it('should allow the empty string, which trims to itself', () => {
      expect(hold('')).toBe(true);
    });

    it('should refuse a whitespace-only string', () => {
      expect(hold(' ')).toMatch(/XML trims a value/);
    });

    it('should name the path inside a value rather than the value handed over', () => {
      expect(hold({ server: { name: ' x ' } }, 'top')).toMatch(/at "top.server.name"/);
    });
  });

  describe('through a Config', () => {
    it('should refuse at the set that wrote it, naming the layer and the format', () => {
      // `canRepresent()` is synchronous for exactly this: a format that cannot
      // hold what it was handed says so at the call that wrote it rather than
      // at a `save()` in an exit handler
      const config = createConfigSync({ layers: [{ name: 'f', store: xml(file(`<config/>`)) }] });
      expect(() => config.set('a', ' x ')).toThrow(/XML trims a value/);
    });

    it('should refuse at the write for a caller that reached the store directly', () => {
      // asked at both doors, because a `write()` a caller made directly has had
      // nothing checked
      expect(() => xml(file(`<config/>`)).writeSync({ a: ' x ' })).toThrow(/Cannot write/);
    });

    it('should refuse a value the write is claiming even where the set did not', () => {
      // asked of the **merged** document rather than of `value`, or a part of
      // `value` this write is not claiming would refuse a write that never
      // touches it
      const path = file(`<config>\n  <a>1</a>\n</config>\n`);
      expect(() => xml(path).writeSync({ a: ' x ', b: '2' }, { paths: ['a'] })).toThrow(
        /Cannot write/
      );
    });

    it('should leave the file untouched where it refuses', () => {
      // the edit is computed before anything is written, which is what makes a
      // refusal cost nothing
      const src = `<config>\n  <a>1</a>\n</config>\n`;
      const path = file(src);
      expect(() => xml(path).writeSync({ a: ' x ' })).toThrow();
      expect(xml(path).readSync().value).toStrictEqual({ a: '1' });
    });
  });
});
