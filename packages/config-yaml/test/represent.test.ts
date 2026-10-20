import { yaml } from '../src/index.js';
import { yamlCanHold } from '../src/represent.js';
import { file, read } from './helpers.js';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';

describe('what YAML can hold', () => {
  /** What the store writes a value as, read back off the file. */
  const roundTrip = (value: unknown): { back: unknown; wrote: string } => {
    const path = file('k: 0\n');
    yaml(path).writeSync({ k: value });
    return { back: (yaml(path).readSync().value as { k: unknown }).k, wrote: read(path) };
  };

  describe('what it allows that jsonCanHold() refuses', () => {
    it('should hold Infinity, because YAML has a spelling for it and JSON does not', () => {
      // `.inf` reads back as `Infinity` and `checkValue(Infinity, 'number')`
      // takes one -- it refuses only `NaN` -- so the value survives both the
      // round trip and the next load. JSON rewrites it as `null`, which is why
      // its own store refuses it. The one place this store is **wider** than
      // the runtime's
      expect(yamlCanHold(Infinity, 'a')).toBe(true);
      expect(yamlCanHold(-Infinity, 'a')).toBe(true);

      const up = roundTrip(Infinity);
      expect(up.wrote).toBe('k: .inf\n');
      expect(up.back).toBe(Infinity);

      const down = roundTrip(-Infinity);
      expect(down.wrote).toBe('k: -.inf\n');
      expect(down.back).toBe(-Infinity);
    });

    it('should hold null, because YAML has one', () => {
      expect(yamlCanHold(null, 'a')).toBe(true);
    });
  });

  describe('what it allows that @ttylabs/config-xml refuses', () => {
    it('should hold every string there is, because YAML has an escape for each', () => {
      // XML refuses a whole class here -- a C0 control, a lone surrogate,
      // `U+FFFE`, a value whose own whitespace matters -- because it has no
      // escape for most of them. Measured through a real UTF-8 file: `yaml`
      // reaches for a double-quoted scalar when it has to and every one of
      // these comes back byte for byte
      for (const value of [
        '',
        ' padded ',
        'yes',
        'no',
        '8080',
        'true',
        'null',
        '~',
        '#c',
        '- x',
        '*x',
        '&x',
        '<<',
        'a: b',
        '\t',
        '\n',
        '\r',
        '\u0000',
        '\u0001',
        '\u007f',
        '\u0085',
        ' ',
        ' ',
        '￾',
        '\uD800',
        '\uDC00',
        '\uFEFF',
        '😀',
      ]) {
        expect(yamlCanHold(value, 'a'), JSON.stringify(value)).toBe(true);
        expect(roundTrip(value).back, JSON.stringify(value)).toBe(value);
      }
    });

    it('should hold any key, because YAML quotes one', () => {
      // XML holds a key to its `Name` production; YAML quotes it. What a key
      // still cannot be is unreachable-by-path, and that is **core's** refusal
      // rather than this one's
      for (const key of ['a b', 'a:b', '1', 'true', '#c', '- x', '  pad  ', '\u0001']) {
        const path = file('z: 0\n');
        yaml(path).writeSync({ [key]: 1, z: 0 });
        expect(Object.keys(yaml(path).readSync().value as object), key).toContain(key);
      }
    });
  });

  describe('what it refuses, because the write would be silent', () => {
    it('should refuse undefined, which YAML writes as null', () => {
      expect(yamlCanHold(undefined, 'a')).toMatch(/delete the key instead/);
    });

    it('should refuse NaN, which writes as .nan and no load accepts', () => {
      // `.nan` round-trips as `NaN` and `checkValue(NaN, 'number')` **throws**,
      // so writing one produces a config the next run cannot load. Which is the
      // asymmetry with `Infinity` above and the reason each is measured rather
      // than grouped
      expect(yamlCanHold(NaN, 'a')).toMatch(/no load accepts/);
    });

    it('should refuse a number YAML writes as an integer the read then refuses', () => {
      // the other half of the read-time check, and the defect a review round
      // found: `canRepresent` allowed every number, so `set('a', 2 ** 60)`
      // saved `a: 1152921504606847000` and the next load **threw** -- the store
      // writing a file it cannot read, which is the exact class this module
      // exists to refuse, introduced by the guard that was meant to close it
      expect(yamlCanHold(2 ** 60, 'a')).toMatch(
        /YAML writes 1152921504606847000, which is not the integer this runtime holds/
      );
      expect(yamlCanHold(-(2 ** 60), 'a')).toMatch(/not the integer this runtime holds/);
      expect(yamlCanHold(Number('12345678901234567890'), 'a')).toMatch(
        /not the integer this runtime holds/
      );
      // and the one that looks like a counterexample and is not: a **literal**
      // past 2^53 is already the double, so `Number('9007199254740993')` is
      // `...992` and writing `9007199254740992` loses nothing. Which is the
      // asymmetry with the read stated exactly -- the read refuses a *source*
      // whose digits the double does not hold, and this refuses a *double*
      // whose printing is not the double. There is no third case
      expect(yamlCanHold(Number('9007199254740993'), 'a')).toBe(true);
      expect(yamlCanHold(2 ** 54, 'a')).toBe(true);
    });

    it('should allow a number that round-trips, however large', () => {
      // asked of the **text** `yaml` will write rather than of the value, which
      // is what keeps the two halves symmetric. `1e21` prints `1e+21`, which is
      // a float in the file and a float the read takes; `1.5e20` prints
      // `150000000000000000000`, which is integer form and does survive; and
      // 2^53 is exact, so refusing it would refuse a value the file names
      // unambiguously
      expect(yamlCanHold(1e21, 'a')).toBe(true);
      expect(yamlCanHold(1.5e20, 'a')).toBe(true);
      expect(yamlCanHold(2 ** 53, 'a')).toBe(true);
      expect(yamlCanHold(-1.5, 'a')).toBe(true);
    });

    it('should not write a file its own next read refuses', () => {
      // the two halves meeting, which is the claim rather than either guard:
      // every number the write accepts is one the read takes back
      for (const value of [1e21, 1.5e20, 2 ** 53, 8080, -1.5, Infinity]) {
        expect(yamlCanHold(value, 'k'), String(value)).toBe(true);
        expect(roundTrip(value).back).toStrictEqual(value);
      }
    });

    it('should refuse a bigint, because no scalar reads one back', () => {
      // `String(10n)` is exact text, so unlike JSON -- which throws -- YAML
      // writes it happily and it reads back as the **number** 10
      expect(yamlCanHold(10n, 'a')).toMatch(/reads back as a bigint/);
    });

    it('should refuse a function and a symbol, which toString throws about', () => {
      expect(yamlCanHold(() => 1, 'a')).toMatch(/no function/);
      expect(yamlCanHold(Symbol('s'), 'a')).toMatch(/no symbol/);
    });

    it('should refuse an invalid Date, whose own toJSON is null', () => {
      // and it is checked **before** the `toJSON` pass, which is what makes it
      // reachable: `new Date(NaN).toJSON()` is `null`, so the generic pass
      // would let it through and `yaml` would write `null`
      expect(yamlCanHold(new Date(NaN), 'a')).toMatch(/invalid Date as null/);
    });

    it('should hold a valid Date, whose ISO form type: date reads back', () => {
      expect(yamlCanHold(new Date('2026-01-01T00:00:00Z'), 'a')).toBe(true);
      expect(roundTrip(new Date('2026-01-01T00:00:00Z')).back).toBe('2026-01-01T00:00:00.000Z');
    });

    it('should refuse a Map, a Set and a class instance, each a different kind on the way back', () => {
      // and name the kind each is really written as, which is three answers
      // rather than one: measured through `Document.createNode()`, a `Map` is a
      // mapping although it is iterable, a `Set` and a typed array are each a
      // sequence, and a boxed primitive is a scalar. Saying "a plain mapping"
      // of all of them contradicted this module's own table
      expect(yamlCanHold(new Map([['a', 1]]), 'a')).toMatch(/Map of this kind as a plain mapping/);
      expect(yamlCanHold(new Set([1]), 'a')).toMatch(/Set of this kind as a sequence/);
      expect(yamlCanHold(new Uint8Array([1]), 'a')).toMatch(
        /Uint8Array of this kind as a sequence/
      );
      expect(yamlCanHold(new Number(1), 'a')).toMatch(/Number of this kind as a plain scalar/);
      class Thing {
        x = 1;
      }
      expect(yamlCanHold(new Thing(), 'a')).toMatch(/Thing of this kind as a plain mapping/);
    });

    it('should check what a toJSON answers rather than taking its word', () => {
      // returning as soon as `toJSON` was a function meant any object with one
      // was representable whatever it then wrote: measured, `canRepresent` said
      // yes and the write produced `null`, the number `10`, a mapping, a
      // sequence, `{}` and a raw `Tag not resolved` naming neither path nor file
      expect(yamlCanHold({ toJSON: () => undefined }, 'k')).toMatch(/undefined/);
      expect(yamlCanHold({ toJSON: () => 10n }, 'k')).toMatch(/bigint|10/);
      expect(yamlCanHold({ toJSON: () => new Map([['a', 1]]) }, 'k')).toMatch(/Map/);
      expect(yamlCanHold({ toJSON: () => new Set([1]) }, 'k')).toMatch(/Set/);
      expect(yamlCanHold({ toJSON: () => () => 1 }, 'k')).toMatch(/function/i);
      expect(yamlCanHold({ toJSON: () => ({ n: 10n }) }, 'k')).toMatch(/k\.n/);
    });

    it('should refuse a toJSON that answers a Date, which is written as an empty mapping', () => {
      // `createNode` calls `toJSON` **once** and does not call it again on what
      // came back, so a Date in the answer position is written as a mapping of
      // its own enumerable keys, which is `{}`. The valid Date beside it still
      // passes, through its own ISO string
      expect(yamlCanHold({ toJSON: () => new Date('2026-01-01T00:00:00Z') }, 'k')).toMatch(/Date/);
      expect(yamlCanHold(new Date('2026-01-01T00:00:00Z'), 'k')).toBe(true);
    });

    it('should report a toJSON that throws rather than letting it escape', () => {
      expect(
        yamlCanHold(
          {
            toJSON: () => {
              throw new Error('nope');
            },
          },
          'k'
        )
      ).toMatch(/its own toJSON threw: nope/);
    });

    it('should refuse a hole in a sequence, which YAML writes as null', () => {
      const sparse = [1];
      sparse[2] = 3;
      expect(yamlCanHold(sparse, 'a')).toMatch(/no hole in a sequence/);
    });

    it('should refuse a cycle rather than hanging', () => {
      const cycle: Record<string, unknown> = {};
      cycle.self = cycle;
      expect(yamlCanHold(cycle, 'a')).toMatch(/refers back to itself/);
    });

    it('should allow a value referenced twice, which is a DAG rather than a cycle', () => {
      const shared = { p: 1 };
      expect(yamlCanHold({ x: shared, y: shared }, 'a')).toBe(true);
    });
  });

  it('should name the path the offending value is at, not the one it was handed', () => {
    // `set('server', { retries: new Map() })` is a plain object holding
    // something that reads back as a different kind, and naming `server` would
    // point at the thing that is fine
    expect(yamlCanHold({ retries: new Map() }, 'server')).toMatch(/\(at "server\.retries"\)/);
    expect(yamlCanHold([1, 10n], 'list')).toMatch(/\(at "list\.1"\)/);
    expect(yamlCanHold(10n, '')).not.toMatch(/\(at/);
  });

  it('should allow a toJSON object, because yaml calls it as JSON.stringify does', () => {
    expect(yamlCanHold({ toJSON: () => 'x' }, 'a')).toBe(true);
    expect(
      parseDocument('k: 0\n')
        .createNode({ toJSON: () => 'x' })
        .toString()
    ).toBe('x');
  });

  it('should refuse a symbol key, which is silently dropped on the way out', () => {
    // `canRepresent` said yes and the write left the file untouched
    expect(yamlCanHold({ a: 1, [Symbol('k')]: 2 }, 'x')).toMatch(/no symbol key/);
  });

  it('should refuse a non-index own property of a sequence, dropped the same way', () => {
    const list: number[] & { extra?: number } = [1, 2];
    list.extra = 3;
    expect(yamlCanHold(list, 'x')).toMatch(/would be dropped/);
  });

  it('should refuse a canonical-numeric property that is not an array index', () => {
    // the guard tested `String(Number(key)) === key`, which is "a canonical
    // number" rather than "an index" -- so each of these satisfied it, none
    // extends `length` or makes a hole for the hole check to catch, and every
    // one was an own enumerable property silently dropped on write
    for (const key of ['-1', '1.5', 'Infinity', 'NaN', '4294967295', '9007199254740991']) {
      const list = [1, 2] as number[] & Record<string, unknown>;
      list[key] = 9;
      expect(yamlCanHold(list, 'x'), key).toMatch(new RegExp(`"${key}" would be dropped`));
    }
  });

  it('should still take an ordinary sequence, index keys and all', () => {
    // the other side of it, or the guard above would refuse every array there
    // is. `4294967294` is the last index a JS array has, so it is an index and
    // `4294967295` one above is not
    expect(yamlCanHold([1, 2, 3], 'x')).toBe(true);
    expect(yamlCanHold([], 'x')).toBe(true);
    const sparse: unknown[] = [1, 2];
    sparse[5] = 6;
    expect(yamlCanHold(sparse, 'x')).toMatch(/hole/);
  });

  it('should name the form yaml really writes, measured rather than assumed', () => {
    // three cells of this table were wrong. A boxed `String` is **iterable**,
    // so the sequence test claimed it where `createNode()` writes the scalar
    // `ab`; a boxed `BigInt` was in no branch and fell through to the mapping
    // default where it writes `10`; and a `DataView` is an `ArrayBuffer.isView`
    // with no iterator and no indexed members, so it writes `{}`
    expect(yamlCanHold(new DataView(new ArrayBuffer(2)), 'x')).toMatch(/as a plain mapping/);
    expect(yamlCanHold(Object(10n), 'x')).toMatch(/as a plain scalar/);
    expect(yamlCanHold(new String('ab'), 'x')).toMatch(/as a plain scalar/);
    // and the ones that were already right, so the reordering kept them
    expect(yamlCanHold(new Set([1]), 'x')).toMatch(/as a sequence of its own members/);
    expect(yamlCanHold(new Uint8Array([1]), 'x')).toMatch(/as a sequence of its own members/);
    expect(yamlCanHold(new Map([['a', 1]]), 'x')).toMatch(/as a plain mapping/);
  });

  it('should name a generator something rather than nothing', () => {
    // a generator's `constructor.name` is the **empty string**, which `??`
    // passes through, so the sentence read "YAML writes a  of this kind as"
    const gen = (function* () {
      yield 1;
    })();
    expect(yamlCanHold(gen, 'x')).toMatch(/YAML writes a value of this kind/);
  });
});
