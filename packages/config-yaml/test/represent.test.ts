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
      expect(yamlCanHold(new Map([['a', 1]]), 'a')).toMatch(/Map of this kind as a plain mapping/);
      expect(yamlCanHold(new Set([1]), 'a')).toMatch(/Set of this kind as a plain mapping/);
      class Thing {
        x = 1;
      }
      expect(yamlCanHold(new Thing(), 'a')).toMatch(/Thing of this kind as a plain mapping/);
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
});
