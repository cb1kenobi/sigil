import { yaml } from '../src/index.js';
import { absent, file, read } from './helpers.js';
import { createConfig, createConfigSync, isWritableStore } from '@ttylabs/sigil/config';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('the store', () => {
  it('should be a writable store', () => {
    expect(isWritableStore(yaml(absent()))).toBe(true);
  });

  it('should answer with its path and its format', () => {
    const path = absent();
    expect(yaml(path).source).toBe(path);
    expect(yaml(path).format).toBe('yaml');
  });

  describe('the format name, which is the .yml and .yaml decision made visible', () => {
    it('should be one store for both extensions', () => {
      // two registrations would be two stores to keep in agreement about a
      // schema version, a residual table and three write refusals, for two
      // spellings of one format. So the extension is not read at all
      const yml = file('a: 1\n', 'config.yml');
      const yamlExt = file('a: 1\n', 'config.yaml');

      expect(yaml(yml).readSync().value).toStrictEqual(yaml(yamlExt).readSync().value);
      expect(yaml(yml).format).toBe(yaml(yamlExt).format);
    });

    it('should let an app say otherwise in a diagnostic', () => {
      expect(yaml(absent(), { format: 'yml' }).format).toBe('yml');
    });

    it('should refuse a format name that is not one', () => {
      expect(() => yaml(absent(), { format: '' })).toThrow(/non-empty format/);
      expect(() => yaml(absent(), { format: 42 as unknown as string })).toThrow(/non-empty format/);
    });
  });

  describe('the path', () => {
    it('should refuse one that is not a non-empty string', () => {
      // refused here rather than at the read, which is `json()`'s own reason:
      // `expand('')` is `'.'`, so an empty path reported a failure to read a
      // directory nobody named
      expect(() => yaml('')).toThrow(/needs a path/);
      expect(() => yaml(undefined as unknown as string)).toThrow(/needs a path/);
      expect(() => yaml(42 as unknown as string)).toThrow(/needs a path/);
    });

    it('should expand a leading tilde', () => {
      // a `~` is the single most likely thing an app writes by hand, and
      // `readFileSync` of one is an `ENOENT` naming a path with a `~` still in
      // it -- which reads as "the file is missing" rather than "the `~` was not
      // expanded"
      expect(yaml('~/.config/app/config.yaml').source).not.toContain('~');
    });
  });

  describe('through a real config', () => {
    it('should merge under a JSON layer at the same paths', () => {
      // the whole of why a store interface exists: a setting is at the same path
      // whatever format the layer that holds it is, so the precedence chain is
      // about the layers rather than about their formats
      const system = file('server:\n  port: 8080\n  host: system\n');
      const user = file('server:\n  host: user\n');
      const config = createConfigSync({
        layers: [
          { name: 'system', readOnly: true, store: yaml(system) },
          { name: 'user', store: yaml(user) },
        ],
        schema: { 'server.port': { type: 'int' } },
      });

      expect(config.get('server.port')).toBe(8080);
      expect(config.get('server.host')).toBe('user');
    });

    it('should hand over already-typed scalars, which is checkValue()s half', () => {
      // YAML's core schema resolves `8080` to a number, so this store needs
      // `checkValue()` where `@ttylabs/config-xml` has nothing
      // but strings and needs `transformValue()`. Neither is the store's own
      // call -- `Config` coerces every layer whatever produced it
      const config = createConfigSync({
        layers: [{ name: 'u', store: yaml(file('port: 8080\ntls: true\nname: x\n')) }],
        schema: { name: { type: 'string' }, port: { type: 'int' }, tls: { type: 'bool' } },
      });

      expect(config.get('port')).toBe(8080);
      expect(config.get('tls')).toBe(true);
      expect(config.get('name')).toBe('x');
    });

    it('should refuse a value the schema cannot hold, naming the setting and the layer', () => {
      expect(() =>
        createConfigSync({
          layers: [{ name: 'u', store: yaml(file('port: not-a-number\n')) }],
          schema: { port: { type: 'int' } },
        })
      ).toThrow(/Invalid value for "port" in u/);
    });

    it('should report a list a single occurrence would have made a scalar', () => {
      // and that is a question this store does **not** have: YAML spells a
      // one-item list `[a]` or `- a`, so there is no ambiguity for a schema to
      // resolve. Which is why there is no `schema` option here where
      // `@ttylabs/config-xml` needs one
      const config = createConfigSync({
        layers: [{ name: 'u', store: yaml(file('plugins:\n  - a\n')) }],
        schema: { plugins: { multiple: true } },
      });

      expect(config.get('plugins')).toStrictEqual(['a']);
    });

    it('should not share an anchored value with its aliases', () => {
      // `toJS()` resolves an alias to the **same object** the anchor resolved
      // to, so without `unshare()` a write to one path moves another: the
      // overlay of a claimed `c.p` made `base.p` move with it, the diff
      // reported two edits, and the refusal then named `base` -- a path the
      // caller never mentioned
      const value = yaml(file('base: &b\n  p: 1\nc: *b\n')).readSync().value as Record<
        string,
        unknown
      >;

      expect(value.base).toStrictEqual({ p: 1 });
      expect(value.c).toStrictEqual({ p: 1 });
      expect(value.base).not.toBe(value.c);
    });

    it('should not share an anchored sequence with its aliases either', () => {
      // measured, `toJS()` shares all three forms -- a flow sequence, a block
      // sequence and a mapping -- so the copy has to walk an array as well as a
      // plain object. Returning the array as it found it left `a === b`
      for (const body of ['a: &s [1, 2]\nb: *s\n', 'a: &s\n  - 1\nb: *s\n']) {
        const value = yaml(file(body)).readSync().value as Record<string, unknown>;

        expect(value.a, body).toStrictEqual(value.b);
        expect(value.a, body).not.toBe(value.b);
      }
    });
  });

  describe('the lossless rule, end to end', () => {
    it('should refuse a save that would lose something', () => {
      const path = file('a: 1   # c\n');
      const config = createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });
      config.set('a', 2);

      expect(() => config.saveSync()).toThrow(/inline comment/);
      expect(read(path)).toBe('a: 1   # c\n');
    });

    it('should write it anyway where the call said lossy', () => {
      const path = file('a: 1   # c\n');
      const config = createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });
      config.set('a', 2);
      config.saveSync({ lossy: true });

      // the comment survives; its own spacing does not, which is what the
      // residual says
      expect(read(path)).toBe('a: 2 # c\n');
    });

    it('should write it anyway where the layer said lossy', () => {
      const path = file('a: 1   # c\n');
      const config = createConfigSync({
        layers: [{ lossy: true, name: 'u', store: yaml(path) }],
      });
      config.set('a', 2);
      config.saveSync();

      expect(read(path)).toBe('a: 2 # c\n');
    });

    it('should report what it would lose on the layer', () => {
      const config = createConfigSync({
        layers: [{ name: 'u', store: yaml(file('a: 1   # c\n')) }],
      });

      // absent rather than empty is the contract, so `?.length` is the way to
      // read it
      expect(config.layers[0]?.wouldLose?.length).toBe(1);
      expect(config.layers[0]?.wouldLose?.[0]?.kind).toBe('comment');
    });

    it('should report nothing on a layer whose document round-trips', () => {
      const config = createConfigSync({
        layers: [{ name: 'u', store: yaml(file('# c\na: 1\n')) }],
      });

      expect(config.layers[0]?.wouldLose).toBeUndefined();
    });
  });

  it('should save through the async half too', async () => {
    const path = file('# c\na: 1\n');
    const config = await createConfig({ layers: [{ name: 'u', store: yaml(path) }] });
    config.set('a', 2);
    await config.save();

    expect(read(path)).toBe('# c\na: 2\n');
  });

  it('should refuse a write to a read-only layer, naming both ways out', async () => {
    const system = file('a: 1\n');
    const config = createConfigSync({
      layers: [
        { name: 'system', readOnly: true, store: yaml(system) },
        { name: 'user', store: yaml(absent()) },
      ],
    });

    expect(() => config.delete('a')).toThrow(/read-only/);
  });

  it('should report a read failure that is not absence, through both halves', async () => {
    // `ENOENT` alone is "the file is not there", which is `isMissing()`'s own
    // rule -- and the two halves are two real implementations, so each needs
    // its own answer
    const dir = mkdtempSync(join(tmpdir(), 'sigil-yaml-'));
    expect(() => yaml(dir).readSync()).toThrow(/Failed to read/);
    await expect(yaml(dir).read()).rejects.toThrow(/Failed to read/);
  });

  describe('a document whose root resolves to null', () => {
    // `rootOf()` is one reader of one rule where there were two: the read said a
    // null root is `{}` and the write cast `readDocument()`'s `unknown` to a
    // record and handed it to `overlay()`. The symptom depended on the door
    const nulls = ['# only a comment\n', 'null\n', '~\n', '---\n', '...\n'];

    it('should read each of them as an empty config', () => {
      for (const body of nulls) {
        expect(yaml(file(body)).readSync().value, body).toStrictEqual({});
      }
    });

    it('should save a setting into one rather than throwing a TypeError', () => {
      // `set()` plus `saveSync()` threw `Cannot set properties of null (setting
      // 'a')`, naming no file and nothing a reader could act on
      for (const body of nulls) {
        const path = file(body);
        const config = createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });
        config.set('a', 1);
        expect(() => config.saveSync({ lossy: true }), body).not.toThrow();
        expect(yaml(path).readSync().value, body).toStrictEqual({ a: 1 });
      }
    });

    it('should keep the comment a null root carried, which apply() plus save() ate', () => {
      // the worst of the three doors: this **succeeded**, with `wouldLose`
      // absent, and dropped the comment -- the lossless rule broken with nothing
      // reported
      const path = file('null # c\n');
      const config = createConfigSync({ layers: [{ name: 'u', store: yaml(path) }] });
      config.apply('u', { a: 1 });
      config.saveSync();
      expect(read(path)).toContain('# c');
      expect(yaml(path).readSync().value).toStrictEqual({ a: 1 });
    });

    it('should carry a comment attached to the null scalar itself', () => {
      // `---\n# hi\n` keeps it on `contents.comment` and a bare `# hi\n` on the
      // document's own `commentBefore`, so only the first needs carrying -- and
      // `setIn()` throws `Expected a YAML collection as document contents` on
      // that shape, which is why `openRoot()` replaces the scalar rather than
      // leaving it
      for (const body of ['---\n# hi\n', '# h\n---\n# b\nnull # t\n']) {
        const path = file(body);
        yaml(path).writeSync({ a: 1 });
        const after = read(path);
        for (const mark of body.match(/#[^\n]*/g) ?? []) {
          expect(after, body).toContain(mark);
        }
      }
    });

    it('should touch no file where nothing was asked for', () => {
      // `openRoot()` runs after the no-op return, so a null root and an empty
      // target leave the document exactly as it parsed. Without that ordering a
      // no-op write of `null # c\n` rendered `{}\n`
      for (const body of ['null # c\n', 'null\n', '---\n']) {
        const path = file(body);
        yaml(path).writeSync(yaml(path).readSync().value);
        expect(read(path), body).toBe(body);
      }
    });

    it('should still refuse a root that is neither a mapping nor null', () => {
      for (const body of ['42\n', '"s"\n', 'true\n', '- 1\n- 2\n']) {
        expect(() => yaml(file(body)).readSync(), body).toThrow(/must hold an object/);
      }
    });

    it('should refuse a non-mapping root through a claimed write too', () => {
      // the direct door, which `save()` hides by re-reading and refusing first:
      // this threw `TypeError: Cannot create property 'a' on number '42'`
      const path = file('42\n');
      expect(() => yaml(path).writeSync({ a: 1 }, { paths: ['a'] })).toThrow(/must hold an object/);
      expect(read(path)).toBe('42\n');
    });
  });

  describe('the options a store is built with', () => {
    it('should refuse options that are not an object', () => {
      // `yaml(p, 'yml')`, `['yml']` and `false` each succeeded with the format
      // left at `'yaml'`, so the argument parsed and did nothing, and
      // `yaml(p, null)` was a raw TypeError about reading `format` of null
      for (const bad of [null, 'yml', ['yml'], false, 42]) {
        expect(() => yaml(absent(), bad as never), String(bad)).toThrow(/options as an object/);
      }
    });

    it('should still take no options at all, and a format', () => {
      expect(yaml(absent()).format).toBe('yaml');
      expect(yaml(absent(), { format: 'yml' }).format).toBe('yml');
    });
  });
});
