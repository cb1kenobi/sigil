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
      expect(yaml(file('1: a\ntrue: b\n2.5: c\n')).readSync().value).toStrictEqual({
        '1': 'a',
        '2.5': 'c',
        true: 'b',
      });
    });

    it('should refuse a null key, which names no path either', () => {
      // this used to read as `''`, which no dotted path can address, and the
      // JSON analogy the rule above rests on says `'null'`:
      // `JSON.stringify({[null]: 1})` is `{"null":1}`. Keeping it was a silent
      // data drop -- a null key beside an empty-string key read as the
      // empty-string one with the other value gone
      expect(() => yaml(file('null: c\n')).readSync()).toThrow(
        /null mapping key names no config path/
      );
      expect(() => yaml(file('~: c\n')).readSync()).toThrow(/null mapping key/);
      expect(() => yaml(file('? null\n: c\n')).readSync()).toThrow(/null mapping key/);
    });

    it('should not read a null key and an empty-string key as one, dropping a value', () => {
      // `null: a` beside `"": b` read as `{"": "b"}`: no error, nothing thrown,
      // and `a` gone. The refusal is what makes the collision impossible
      expect(() => yaml(file('null: a\n"": b\n')).readSync()).toThrow(/null mapping key/);
    });

    it('should still take an empty-string key, which a JSON layer holds too', () => {
      // equally unreachable by a dotted path, and deliberately kept: it is what
      // the user wrote and what the sibling store holds, so refusing it would
      // invent a divergence. A null key is a *different* key yaml maps onto the
      // same path, and inconsistently -- through a `<<` it lands on `'null'`
      expect(yaml(file('"": b\nname: x\n')).readSync().value).toStrictEqual({
        '': 'b',
        name: 'x',
      });
    });

    it('should not call a null key a duplicate of the string "null"', () => {
      // `String(null)` is `'null'`, so the uniqueness comparator widened the two
      // onto one path and refused them as one. They are different keys and, by
      // the JSON rule, different paths -- so the refusal a reader gets is the
      // one that says what is actually wrong
      expect(() => yaml(file('null: a\n"null": b\n')).readSync()).toThrow(
        /null mapping key names no config path/
      );
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

  describe('what the parse is pinned to', () => {
    it('should keep 1.2 core over a document that names its own version', () => {
      // the `schema` pin was written down as a declared sabotage survivor on
      // the ground that `yaml` already defaults to 1.2 core. A document naming
      // `%YAML 1.1` is what separates them: without the pin `setSchema` takes
      // the directive and `yes` is `true`, `017` is `15`, `12:30` is `750` and
      // a date is a `Date` -- the whole Norway family this exists to refuse
      expect(
        yaml(file('%YAML 1.1\n---\na: yes\nb: 017\nc: 12:30\nd: on\n')).readSync().value
      ).toStrictEqual({ a: 'yes', b: 17, c: '12:30', d: 'on' });
    });
  });

  describe('a scalar this runtime cannot hold as written', () => {
    it('should refuse an integer past 2^53-1, which reads back as a different one', () => {
      // the framework's own rule: the parser's `int` type throws on exactly
      // this rather than handing back `...992` for `...993`
      expect(() => yaml(file('a: 9007199254740993\n')).readSync()).toThrow(/past 2\^53-1/);
      expect(() => yaml(file('a: 0x20000000000001\n')).readSync()).toThrow(/past 2\^53-1/);
    });

    it('should take every integer it can tell apart', () => {
      expect(yaml(file('a: 9007199254740991\n')).readSync().value).toStrictEqual({
        a: 9007199254740991,
      });
      expect(yaml(file('a: 8080\nb: -1\nc: 1.5\n')).readSync().value).toStrictEqual({
        a: 8080,
        b: -1,
        c: 1.5,
      });
    });
  });

  describe('the non-specific tag', () => {
    it('should take ! on a scalar, which the core schema resolves to a string', () => {
      // refused as "outside the core schema" although the parser reports
      // neither an error nor a warning for it and resolves it to its own text
      expect(yaml(file('a: ! true\nb: ! 8080\n')).readSync().value).toStrictEqual({
        a: 'true',
        b: '8080',
      });
    });

    it('should still refuse a tag the core schema has not got', () => {
      expect(() => yaml(file('a: !!set\n  ? x\n')).readSync()).toThrow();
    });
  });

  describe('a key that is not a scalar', () => {
    it('should name an alias as an alias rather than as a mapping', () => {
      expect(() => yaml(file('id: &id name\n*id : 1\n')).readSync()).toThrow(
        /key is an alias, which names no config path/
      );
    });

    it('should still name a sequence and a mapping', () => {
      expect(() => yaml(file('[1, 2]: a\n')).readSync()).toThrow(/key is a sequence/);
      expect(() => yaml(file('? {a: 1}\n: b\n')).readSync()).toThrow(/key is a mapping/);
    });
  });
});
