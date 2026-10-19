import { yaml } from '../src/index.js';
import { absent, file } from './helpers.js';
import { createConfigSync } from '@ttylabs/sigil/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('reading a document', () => {
  it('should read a mapping as a config value, typed', () => {
    const doc = yaml(
      file('# top\nserver:\n  port: 8080\n  tls: true\nplugins:\n  - a\n  - b\n')
    ).readSync();

    expect(doc.value).toStrictEqual({ plugins: ['a', 'b'], server: { port: 8080, tls: true } });
    expect(doc.wouldLose).toBeUndefined();
  });

  it('should read aliases and merge keys, which is what they are enabled for', () => {
    expect(
      yaml(file('base: &b\n  p: 1\nc:\n  <<: *b\n  q: 2\nd: *b\n')).readSync().value
    ).toStrictEqual({ base: { p: 1 }, c: { p: 1, q: 2 }, d: { p: 1 } });
  });

  describe('a file that says nothing', () => {
    it('should read an absent file as an empty document', () => {
      expect(yaml(absent()).readSync().value).toStrictEqual({});
    });

    it('should read a blank file as an empty document', () => {
      // `touch config.yaml` is the ordinary state of a config nobody has
      // written yet, and refusing to start over one is the wrong answer
      expect(yaml(file('')).readSync().value).toStrictEqual({});
      expect(yaml(file('\n\n  \n')).readSync().value).toStrictEqual({});
    });

    it('should read a comment-only file as an empty document', () => {
      // which does **not** fall out of the blank check: the bytes are not
      // whitespace, and `parseDocument()` answers a document whose value is
      // `null` -- so without the null branch this is refused by the
      // must-hold-a-mapping check rather than read as empty
      expect(yaml(file('# nothing here yet\n')).readSync().value).toStrictEqual({});
      expect(yaml(file('---\n')).readSync().value).toStrictEqual({});
    });
  });

  describe('what it refuses, naming the line', () => {
    it('should refuse a multi-document stream', () => {
      // taking the first silently drops the rest, which is the
      // parses-and-does-the-wrong-thing shape
      expect(() => yaml(file('a: 1\n---\nb: 2\n')).readSync()).toThrow(/multiple documents/i);
    });

    it('should refuse an unknown tag rather than reading it as a string', () => {
      // an unresolved tag is a **warning** rather than an error, and `yaml`
      // resolves it to the scalar's own text -- so `!custom 5` would read as
      // `'5'` with the tag gone and nothing said
      expect(() => yaml(file('a: !custom 5\n')).readSync()).toThrow(/Unresolved tag/);
    });

    it('should refuse a tag outside the core schema, which resolves to an exotic JS value', () => {
      // each of these resolves without a warning and produces a value no other
      // layer format can hand back: a `Set`, a `Map`, a `Buffer`, a `Date`.
      // `isPlainObject()` reads every one as a leaf, so an app would get a value
      // the merge carries by reference and this store's own `canRepresent()`
      // then refuses to write
      for (const [body, tag] of [
        ['a: !!set {x, y}\n', '!!set'],
        ['a: !!omap [{x: 1}]\n', '!!omap'],
        ['a: !!binary aGk=\n', '!!binary'],
        ['a: !!timestamp 2026-01-01\n', '!!timestamp'],
        ['a: !!pairs [{x: 1}]\n', '!!pairs'],
      ] as const) {
        expect(() => yaml(file(body)).readSync(), tag).toThrow(/outside YAML 1.2's core schema/);
      }
    });

    it('should take an explicit core tag, which is how a string is forced', () => {
      // the other half: `!!str 5` is the one spelling of "this 5 is a string",
      // so refusing every tag would refuse the feature
      expect(yaml(file('a: !!str 5\nb: !!int 5\nc: !!bool true\n')).readSync().value).toStrictEqual(
        { a: '5', b: 5, c: true }
      );
    });

    it('should refuse a mapping key that is a collection, which names no path', () => {
      // and refuse it **before** `toJS()`, which is not an ordering nicety: that
      // call stringifies such a key and prints
      // `Warning: Keys with collection values...` to **stderr** through
      // `process.emitWarning`, and a CLI writing to stderr because somebody's
      // config has an exotic key in it is not something to let happen
      expect(() => yaml(file('[1, 2]: a\n')).readSync()).toThrow(/key is a sequence/);
      expect(() => yaml(file('{a: 1}: b\n')).readSync()).toThrow(/key is a mapping/);
    });

    it('should say a collection key names no path rather than that it is a duplicate', () => {
      // the comparator in `options.ts` reads `a.value` off a scalar, and two
      // collection keys both answer `undefined` -- so without its `isScalar`
      // guard they compare equal, `yaml` reports `DUPLICATE_KEY`, and
      // `assertReadable()` reports *that* first because it consults
      // `doc.errors` before it walks. Both are refusals, so the only thing the
      // guard changes is which cause the message names
      expect(() => yaml(file('[1, 2]: a\n[3, 4]: b\n')).readSync()).toThrow(/key is a sequence/);
    });

    it('should take a scalar key of any type, because it names a path', () => {
      // `1: a` is the path `1`, which is where `{"1": "a"}` puts it in JSON --
      // so the two formats agree and there is nothing to refuse
      expect(yaml(file('1: a\ntrue: b\nnull: c\n')).readSync().value).toStrictEqual({
        '': 'c',
        '1': 'a',
        true: 'b',
      });
    });

    it('should refuse a recursive alias, whose value is a cycle', () => {
      expect(() => yaml(file('a: &x\n  b: *x\n')).readSync()).toThrow(/refers to itself/);
    });

    it('should refuse an alias named undefined that comes before its anchor', () => {
      // the anchors seen so far are tracked through a `typeof name === 'string'`
      // guard, and `anchors.add(String(name))` without it adds the string
      // `'undefined'` for every *unanchored* node -- after which an alias
      // spelled `*undefined` finds it and the forward check passes. Absurd as
      // an input and the one that separates the two spellings
      expect(() => yaml(file('b: *undefined\na: 1\n')).readSync()).toThrow(
        /comes before the anchor/
      );
    });

    it('should refuse an alias that comes before its anchor, which the round trip throws on', () => {
      // `doc.errors` is **empty** for this, and `toJS()` **and** `toString()`
      // each raise `Unresolved alias` -- so without this the fidelity round trip
      // threw first, with neither the path nor a line in it
      expect(() => yaml(file('b: *x\na: &x 1\n')).readSync()).toThrow(
        /comes before the anchor it refers to/
      );
    });

    it('should refuse a document whose root is not a mapping', () => {
      // merging a scalar or a sequence would make every key of every layer
      // below it vanish
      expect(() => yaml(file('42\n')).readSync()).toThrow(/must hold an object/);
      expect(() => yaml(file('- 1\n- 2\n')).readSync()).toThrow(/must hold an object/);
      expect(() => yaml(file('just a string\n')).readSync()).toThrow(/must hold an object/);
    });

    it('should report a syntax error with the file in it', () => {
      expect(() => yaml(file('a: [1, 2\n')).readSync()).toThrow(/Failed to parse .*config\.yaml/);
    });

    it('should report a read failure that is not absence', () => {
      // `ENOENT` alone is "the file is not there", which is `isMissing()`'s own
      // rule: reading every error that way is what handed a `0o600` config back
      // world-readable in the runtime
      const dir = mkdtempSync(join(tmpdir(), 'sigil-yaml-'));
      expect(() => yaml(dir).readSync()).toThrow(/Failed to read/);
    });
  });

  describe("an unsafe key, which is core's refusal rather than this store's", () => {
    // `__proto__` arrives from `toJS()` as an **own** property rather than
    // moving the prototype -- measured -- and `copyValue()` in the runtime
    // refuses it, naming the layer. So this store does not reimplement that
    // guard, which is what keeps one answer to the question
    for (const key of ['__proto__', 'constructor']) {
      it(`should hand ${key} over as an own property for core to refuse`, () => {
        const path = file(`${key}:\n  x: 1\n`);

        // the copy that unshares aliases has to preserve it as own for that
        // refusal to happen at all: written `out[key] = ...`, a key of
        // `__proto__` sets the copy's **prototype**, `isPlainObject()` then
        // says the document is not a mapping, and what a user sees is
        // `must hold an object` about a file whose real problem is a key
        // nobody should be able to write
        const value = yaml(path).readSync().value;
        expect(Object.hasOwn(value as object, key)).toBe(true);
        expect(Object.getPrototypeOf(value)).toBe(Object.prototype);

        expect(() => createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] })).toThrow(
          new RegExp(`Unsafe config key "${key}" in u`)
        );
      });
    }
  });

  it('should read both halves the same way', async () => {
    // `read()` and `readSync()` are two real implementations over one parse,
    // which is what the interface asks for
    const path = file('a: 1\nb:\n  c: [1, 2]\n');
    expect((await yaml(path).read()).value).toStrictEqual(yaml(path).readSync().value);
  });
});
