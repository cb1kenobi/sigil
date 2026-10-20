import { yaml } from '../src/index.js';
import { editsFor } from '../src/write.js';
import { absent, file, read } from './helpers.js';
import { createConfigSync } from '@ttylabs/sigil/config';
import { describe, expect, it } from 'vitest';

describe('writing a value back', () => {
  /** A config over one YAML layer. */
  const over = (path: string) => createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });

  describe('the acceptance test: one key set, every other byte identical', () => {
    it('should keep the comments, the anchors, the quoting and the indentation', () => {
      const source = `# the app's settings
server:
  # where to listen
  port: 8080
  host: example.com
  tls: true
defaults: &d
  retries: 3
staging:
  <<: *d
  host: staging.example.com
plugins:
  - a
  - b
motd: |
  line one
  line two
quoted: 'single'
flow: {x: 1, y: 2}
`;
      const path = file(source);
      const config = over(path);
      config.set('server.port', 9090);
      config.saveSync();

      expect(read(path)).toBe(source.replace('8080', '9090'));
    });

    it('should keep a four-space document four-space', () => {
      const source = 'server:\n    port: 8080\n    host: h\n';
      const path = file(source);
      const config = over(path);
      config.set('server.host', 'other');
      config.saveSync();

      expect(read(path)).toBe(source.replace('h\n', 'other\n'));
    });

    it('should keep CRLF, a byte order mark and a trailing blank line', () => {
      const source = '\uFEFFserver:\r\n  port: 8080\r\n\r\n';
      const path = file(source);
      const config = over(path);
      config.set('server.port', 9090);
      config.saveSync();

      expect(read(path)).toBe('\uFEFFserver:\r\n  port: 9090\r\n\r\n');
    });

    it('should keep a file with no final newline without one', () => {
      const path = file('a: 1');
      const config = over(path);
      config.set('a', 2);
      config.saveSync();

      expect(read(path)).toBe('a: 2');
    });
  });

  describe('the diff, which is why anything survives at all', () => {
    it('should emit nothing where nothing differs', () => {
      expect(editsFor({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 2 } })).toStrictEqual([]);
    });

    it('should emit one edit per differing leaf', () => {
      expect(editsFor({ a: 1, b: { c: 2, d: 3 } }, { a: 1, b: { c: 9, d: 3 } })).toStrictEqual([
        { at: ['b', 'c'], drop: false, value: 9 },
      ]);
    });

    it('should emit a removal for a key the target does not have', () => {
      expect(editsFor({ a: 1, b: 2 }, { a: 1 })).toStrictEqual([{ at: ['b'], drop: true }]);
    });

    it('should emit one edit for a subtree whose kind changed', () => {
      // rather than one per leaf under it, which is what keeps no edit a prefix
      // of another and so makes the order not matter
      expect(editsFor({ a: { b: 1 } }, { a: 2 })).toStrictEqual([
        { at: ['a'], drop: false, value: 2 },
      ]);
    });

    it('should diff a sequence by index, which is what keeps a comment on an untouched item', () => {
      expect(editsFor({ a: [1, 2, 3] }, { a: [1, 9, 3] })).toStrictEqual([
        { at: ['a', '1'], drop: false, value: 9 },
      ]);
    });

    it('should drop a shortened sequence from the tail first', () => {
      // so that a shorter target does not renumber under the sets that follow
      expect(editsFor({ a: [1, 2, 3] }, { a: [1] })).toStrictEqual([
        { at: ['a', '2'], drop: true },
        { at: ['a', '1'], drop: true },
      ]);
    });

    it('should append to a sequence rather than rewriting it', () => {
      expect(editsFor({ a: [1] }, { a: [1, 2] })).toStrictEqual([
        { at: ['a', '1'], drop: false, value: 2 },
      ]);
    });

    it('should keep a comment on a sequence item nothing touched', () => {
      // through the whole list rather than `set('plugins.1', ...)`, which is
      // **core's** rule rather than this store's: a dotted path addresses object
      // keys, so `writePath()` refuses a non-object ancestor and the array
      // methods are how a list is changed. The diff is what makes replacing the
      // whole list touch one item
      const source = 'plugins:\n  - a # first\n  - b # second\n';
      const path = file(source);
      const config = over(path);
      config.set('plugins', ['a', 'z']);
      config.saveSync();

      expect(read(path)).toBe('plugins:\n  - a # first\n  - z # second\n');
    });

    it('should append through push rather than rewriting the list', () => {
      const source = 'plugins:\n  - a # first\n';
      const path = file(source);
      const config = over(path);
      config.push('plugins', 'b');
      config.saveSync();

      expect(read(path)).toBe('plugins:\n  - a # first\n  - b\n');
    });
  });

  describe('the three kinds of path a write refuses', () => {
    it('should refuse a write through an alias, which setIn throws an internal error about', () => {
      // measured: `setIn(['c','p'], 9)` over `c: *b` raises
      // `Expected YAML collection at c. Remaining path: p`, which names neither
      // the file nor anything a user can act on
      const path = file('base: &b\n  p: 1\nc: *b\n');
      const config = over(path);
      config.set('c.p', 9);

      expect(() => config.saveSync()).toThrow(/"c" is an alias, on line 3/);
      // and the file is untouched, because the render happens before the write
      expect(read(path)).toBe('base: &b\n  p: 1\nc: *b\n');
    });

    it('should refuse replacing an alias, which would drop the reference', () => {
      const path = file('a: &x 1\nb: *x\n');
      const config = over(path);
      config.set('b', 2);

      expect(() => config.saveSync()).toThrow(/"b" is an alias, on line 2/);
    });

    it('should refuse a write at or under an aliased anchor', () => {
      // writing `base.p` moves `c.p` as well -- a path the write never claimed
      // -- so the document would no longer hold the value it was handed
      const path = file('base: &b\n  p: 1\nc:\n  <<: *b\n');
      const config = over(path);
      config.set('base.p', 9);

      expect(() => config.saveSync()).toThrow(/"base" carries an anchor another node aliases/);
    });

    it('should refuse deleting an aliased anchor, which leaves the document unserializable', () => {
      // measured: `deleteIn(['a'])` over `a: &x 1\nb: *x` leaves a document
      // whose `toString()` throws `Unresolved alias`, so the file cannot be
      // written at all
      const path = file('a: &x 1\nb: *x\n');
      const config = over(path);
      config.delete('a');

      expect(() => config.saveSync()).toThrow(/carries an anchor another node aliases/);
    });

    it('should refuse removing a key a map takes from a merge', () => {
      // measured: `deleteIn(['c','p'])` answers **false** and changes nothing,
      // so the value still reads 1 after a `delete()` said it was gone. Silent,
      // which is the worst of the three
      const path = file('base: &b\n  p: 1\nc:\n  <<: *b\n  q: 2\n');
      const config = over(path);
      config.delete('c.p');

      expect(() => config.saveSync()).toThrow(/comes from the merge key on line 4/);
    });

    it('should allow setting a key a map takes from a merge, which shadows it', () => {
      // the one place this differs from the three above: `yaml` writes the key
      // into the map, the anchor is untouched, and a re-read answers exactly
      // what was written. Shadowing is the only way to make that path hold that
      // value without editing an anchor every map that merges it also reads
      const path = file('base: &b\n  p: 1\nc:\n  <<: *b\n  q: 2\n');
      const config = over(path);
      config.set('c.p', 99);
      config.saveSync();

      expect(read(path)).toBe('base: &b\n  p: 1\nc:\n  <<: *b\n  q: 2\n  p: 99\n');
      // the value really is what was asked for, and `base` really is untouched
      expect(yaml(path).readSync().value).toStrictEqual({
        base: { p: 1 },
        c: { p: 99, q: 2 },
      });
    });

    it('should find an alias inside a sequence, which fences the anchor it names', () => {
      // the alias walk descends a sequence as well as a mapping: without that,
      // `*b` inside a list is not found, `&b` is not in the aliased set, and a
      // write to `base.p` is allowed -- which moves `list.0.p`, a path the
      // write never claimed
      const path = file('base: &b\n  p: 1\nlist:\n  - *b\n');
      const config = over(path);
      config.set('base.p', 9);

      expect(() => config.saveSync()).toThrow(/"base" carries an anchor another node aliases/);
    });

    it('should refuse dropping an ancestor that holds an aliased anchor', () => {
      // the fences check **prefixes** of the edit path and the exact path, and
      // `editsFor()` emits a drop or a kind-changing replacement of a whole
      // subtree as one edit at the ancestor -- so the anchor buried inside it
      // was never consulted and `yaml` threw its own `Unresolved alias`, with
      // neither the file nor the path in it, which is exactly the message
      // these refusals exist to replace
      for (const [body, target] of [
        ['grp:\n  host: &k example.com\nother: *k\n', { other: 'example.com' }],
        ['grp:\n  host: &k example.com\nother: *k\n', { grp: 5, other: 'example.com' }],
        ['grp:\n  &k host: example.com\nother: *k\n', { other: 'host' }],
      ] as const) {
        const path = file(body);
        const before = read(path);
        expect(() => yaml(path).writeSync(target), body).toThrow(
          /Cannot write "grp".*which carries an anchor another node aliases/s
        );
        expect(read(path), body).toBe(before);
      }
    });

    it('should still descend into a collection, which meets the fence at its own path', () => {
      // the other side of it, or the guard above would refuse every write to a
      // map that happens to hold an anchor somewhere under it
      const path = file('grp:\n  host: &k example.com\n  port: 1\nother: *k\n');
      yaml(path).writeSync({ grp: { host: 'example.com', port: 2 }, other: 'example.com' });
      expect(read(path)).toContain('port: 2');
      expect(read(path)).toContain('&k');
    });

    it('should allow a write to an anchor nothing aliases, which shares nothing', () => {
      // the narrowing rather than caution: an anchor nobody refers to is a
      // label, so editing what it names moves nothing else -- and the write
      // preserves the anchor either way
      const path = file('e: &y\n  p: 1\n');
      const config = over(path);
      config.set('e.p', 2);
      config.saveSync();

      expect(read(path)).toBe('e: &y\n  p: 2\n');
    });

    it('should leave an alias on a path the write does not touch', () => {
      // which is the whole of what the diff buys: nothing rewrote the lines
      // holding it
      const path = file('base: &b\n  p: 1\nc: *b\nother: 1\n');
      const config = over(path);
      config.set('other', 2);
      config.saveSync();

      expect(read(path)).toBe('base: &b\n  p: 1\nc: *b\nother: 2\n');
    });

    it('should check every edit before applying any', () => {
      // `Show`'s own rule in the runtime: build first and touch nothing until
      // there is something to put there, because that is the only order where a
      // failure needs no undo. Two edits, the second refused -- the first must
      // not reach the file
      const source = 'ok: 1\nbase: &b\n  p: 1\nc: *b\n';
      const path = file(source);
      const config = over(path);
      config.set('ok', 2);
      config.set('c.p', 9);

      expect(() => config.saveSync()).toThrow(/alias/);
      expect(read(path)).toBe(source);
    });
  });

  describe('writing where there is nothing to write into', () => {
    it('should write a file that is not there', () => {
      const path = absent();
      const config = over(path);
      config.set('server.port', 8080);
      config.saveSync();

      expect(read(path)).toBe('server:\n  port: 8080\n');
    });

    it('should write into a file holding nothing but whitespace', () => {
      const path = file('\n  \n');
      const config = over(path);
      config.set('a', 1);
      config.saveSync();

      expect(read(path)).toBe('a: 1\n');
    });
  });

  describe('what it refuses to write', () => {
    it('should refuse a value YAML cannot hold, naming the path', () => {
      const path = file('a: 1\n');
      expect(() => yaml(path).writeSync({ a: new Map() })).toThrow(
        /Cannot write .*Map of this kind.*\(at "a"\)/
      );
    });

    it('should refuse a document whose root is not a mapping', () => {
      const path = file('a: 1\n');
      expect(() => yaml(path).writeSync(42)).toThrow(/must hold an object/);
      expect(() => yaml(path).writeSync([1, 2])).toThrow(/must hold an object/);
    });
  });

  it('should touch no file where the write changes nothing', async () => {
    // which keeps the mtime a watcher reads, and makes `apply()` of a freshly
    // read value a no-op rather than a rewrite of the same bytes
    const source = '# keep me\na: 1\n';
    const path = file(source);
    const before = (await import('node:fs')).statSync(path).mtimeMs;
    await new Promise((done) => setTimeout(done, 10));

    yaml(path).writeSync({ a: 1 });

    expect(read(path)).toBe(source);
    expect((await import('node:fs')).statSync(path).mtimeMs).toBe(before);
  });

  describe('the claimed paths, which is what makes the re-read mean something', () => {
    it('should leave a key another process changed alone', () => {
      // a store handed a whole document can only diff the whole of it, so a key
      // another process changed between the read and the write is reverted --
      // which is the defect `WriteOptions.paths` exists for
      const path = file('mine: 1\ntheirs: 1\n');
      const store = yaml(path);

      store.writeSync({ mine: 2, theirs: 1 }, { paths: ['mine'] });
      expect(read(path)).toBe('mine: 2\ntheirs: 1\n');

      // somebody else writes while this process holds a stale read
      yaml(path).writeSync({ mine: 2, theirs: 99 });
      store.writeSync({ mine: 3, theirs: 1 }, { paths: ['mine'] });

      expect(yaml(path).readSync().value).toStrictEqual({ mine: 3, theirs: 99 });
    });

    it('should write the whole document where nothing was claimed', () => {
      // which is the only thing `write(value)` can mean on its own
      const path = file('mine: 1\ntheirs: 1\n');
      yaml(path).writeSync({ mine: 2 });

      expect(yaml(path).readSync().value).toStrictEqual({ mine: 2 });
    });
  });

  it('should write both halves the same way', async () => {
    const source = '# c\na: 1\n';
    const sync = file(source);
    const async = file(source);

    yaml(sync).writeSync({ a: 2 });
    await yaml(async).write({ a: 2 });

    expect(read(sync)).toBe(read(async));
    expect(read(sync)).toBe('# c\na: 2\n');
  });

  describe('a key the document does not spell as a string', () => {
    it('should edit the key it has rather than appending a second one', () => {
      // the write used to leave `1: a` and add `"1": b`, after which the read
      // refused the result with `Map keys must be unique` -- `save()` exiting
      // normally having written a config nothing can load
      for (const [body, target, want] of [
        ['1: a\n', { '1': 'b' }, '1: b\n'],
        ['true: a\n', { true: 'b' }, 'true: b\n'],
        ['2.5: a\n', { '2.5': 'b' }, '2.5: b\n'],
      ] as const) {
        const path = file(body);
        yaml(path).writeSync(target);
        expect(read(path), body).toBe(want);
        expect(yaml(path).readSync().value, body).toStrictEqual(target);
      }
    });

    it('should delete it, where it used to be a silent no-op', () => {
      for (const body of ['1: a\nname: x\n', 'true: a\nname: x\n']) {
        const path = file(body);
        yaml(path).writeSync({ name: 'x' });
        expect(read(path), body).toBe('name: x\n');
      }
    });

    it('should build a sequence rather than a mapping for an index', () => {
      // `collectionFromPath` builds an array for a numeric key and a mapping
      // for a string one, and every segment used to be `String(i)`
      const path = file('a: 1\n');
      yaml(path).writeSync({ a: 1, items: [1, 2] });
      expect(yaml(path).readSync().value).toStrictEqual({ a: 1, items: [1, 2] });
      expect(Array.isArray((yaml(path).readSync().value as { items: unknown }).items)).toBe(true);
    });
  });

  describe('a scalar carrying an explicit tag', () => {
    it('should refuse a value of a different type rather than letting the tag rewrite it', () => {
      // `a: !!bool true` set to the string `'false'` left the file **byte
      // identical** and read back boolean `true` -- the write silently not
      // taking -- and `a: !!int 5` set to `'nope'` wrote `!!int .nan`, which the
      // next read refuses with `Unresolved tag`
      for (const [body, target] of [
        ['a: !!bool true\n', { a: 'false' }],
        ['a: !!bool true\n', { a: 2 }],
        ['a: !!str 5\n', { a: 6 }],
        ['a: !!int 5\n', { a: 'nope' }],
        ['a: !!float 1.5\n', { a: 'x' }],
      ] as const) {
        const path = file(body);
        expect(() => yaml(path).writeSync(target), body).toThrow(/carries the tag/);
        expect(read(path), body).toBe(body);
      }
    });

    it('should allow a value of the same type, which the tag re-stringifies as itself', () => {
      for (const [body, target] of [
        ['a: !!str 5\n', { a: '6' }],
        ['a: !!int 5\n', { a: 6 }],
        ['a: !!bool true\n', { a: false }],
      ] as const) {
        const path = file(body);
        yaml(path).writeSync(target);
        expect(yaml(path).readSync().value, body).toStrictEqual(target);
      }
    });

    it('should refuse a same-type value the tag cannot spell back', () => {
      // the `typeof` proxy this guard first used let these through: the type
      // matches and the tag still cannot write the value as itself, so the
      // file stopped parsing. `!!float` is the sharp one -- JS has no spelling
      // of `2.0`, so an integer-valued number onto it is an unreadable file
      for (const [body, target] of [
        ['a: !!int 5\n', { a: 1.5 }],
        ['a: !!int 5\n', { a: 1e21 }],
        ['a: !!int 5\n', { a: Infinity }],
        ['a: !!float 1.5\n', { a: 2 }],
      ] as const) {
        const path = file(body);
        const before = read(path);
        expect(() => yaml(path).writeSync(target), body).toThrow(
          /would not write .* back as itself/
        );
        expect(read(path), body).toBe(before);
      }
    });

    it('should refuse null onto a tag, which typeof object let straight through', () => {
      // `typeof null` is `'object'`, which the old guard exempted as a kind
      // change -- so `!!bool true` set to `null` wrote `a: !!bool false` and
      // read back **false**, and `!!str 5` read back the string `"null"`.
      // Silent wrong data with no throw anywhere
      for (const body of ['a: !!bool true\n', 'a: !!str 5\n', 'a: !!int 5\n']) {
        const path = file(body);
        expect(() => yaml(path).writeSync({ a: null }), body).toThrow(
          /would not write null back as itself/
        );
      }
      // and the tag that does take it
      const path = file('a: !!null ~\n');
      yaml(path).writeSync({ a: null });
      expect(yaml(path).readSync().value).toStrictEqual({ a: null });
    });

    it('should still take a collection, which replaces the node and its tag', () => {
      // the one case the old `'object'` test was right about
      const path = file('a: !!int 5\n');
      yaml(path).writeSync({ a: { b: 1 } });
      expect(yaml(path).readSync().value).toStrictEqual({ a: { b: 1 } });
    });

    it('should leave an untagged scalar alone', () => {
      const path = file('a: true\n');
      yaml(path).writeSync({ a: 'false' });
      expect(yaml(path).readSync().value).toStrictEqual({ a: 'false' });
    });
  });

  describe('a path that descends through a merge key', () => {
    const nested = 'base: &b\n  nest:\n    a: 1\n    b: 2\nc:\n  <<: *b\n';

    it('should refuse a set deeper than the merged key, which lost a key', () => {
      // the own pair shadows the whole merged `nest` rather than merging into
      // it, so asking for `{a: 9, b: 2}` wrote `c.nest.a` and the read answered
      // `{a: 9}` -- key `b` gone, with no throw
      const path = file(nested);
      const value = yaml(path).readSync().value as { c: { nest: { a: number } } };
      value.c.nest.a = 9;
      expect(() => yaml(path).writeSync(value)).toThrow(/comes from the merge key/);
      expect(read(path)).toBe(nested);
    });

    it('should refuse one that would turn a sequence into a mapping', () => {
      const body = 'base: &b\n  items:\n    - 1\n    - 2\nc:\n  <<: *b\n';
      const path = file(body);
      const value = yaml(path).readSync().value as { c: { items: number[] } };
      value.c.items[0] = 9;
      expect(() => yaml(path).writeSync(value)).toThrow(/comes from the merge key/);
      expect(read(path)).toBe(body);
    });

    it('should refuse a delete below one, which threw a raw yaml message', () => {
      // `Expected YAML collection at nest. Remaining path: a`, naming neither
      // the file nor the path
      const path = file(nested);
      const value = yaml(path).readSync().value as { c: { nest: { a?: number } } };
      delete value.c.nest.a;
      expect(() => yaml(path).writeSync(value)).toThrow(/comes from the merge key/);
      expect(read(path)).toBe(nested);
    });

    it('should still shadow the merged key itself, which is documented and works', () => {
      const path = file('base: &b\n  p: 1\n  q: 2\nc:\n  <<: *b\n');
      const value = yaml(path).readSync().value as { c: { p: number } };
      value.c.p = 9;
      yaml(path).writeSync(value);
      expect(read(path)).toContain('p: 9');
      expect((yaml(path).readSync().value as { c: { p: number } }).c.p).toBe(9);
    });
  });

  describe('an anchor on a key', () => {
    const body = '&k host: example.com\ncopy: *k\n';

    it('should refuse a removal, which left the document unrenderable', () => {
      // `deleteIn()` had already removed the pair the alias points at, after
      // which `toString()` threw `Unresolved alias` naming no file
      const path = file(body);
      expect(() => yaml(path).writeSync({ copy: 'host' })).toThrow(/its key carries an anchor/);
      expect(read(path)).toBe(body);
    });

    it('should still allow its value to be edited, which keeps both', () => {
      const path = file(body);
      yaml(path).writeSync({ copy: 'host', host: 'other' });
      expect(read(path)).toContain('&k');
      expect(read(path)).toContain('*k');
      expect(read(path)).toContain('other');
    });
  });
});
