import { xml } from '../src/index.js';
import { absent, file, read } from './helpers.js';
import { createConfig, createConfigSync, isWritableStore, json } from '@ttylabs/sigil/config';
import type { ConfigSchema } from '@ttylabs/sigil/config';
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('the store', () => {
  describe('the contract', () => {
    it('should report its format and its source', () => {
      const path = file(`<config/>`);
      const store = xml(path);
      expect(store.format).toBe('xml');
      expect(store.source).toBe(path);
    });

    it('should be a writable store', () => {
      expect(isWritableStore(xml(file(`<config/>`)))).toBe(true);
    });

    it('should read the same thing both ways', async () => {
      // two real implementations over one shared parse rather than one wrapping
      // the other, which is what `ConfigStore` asks for
      const store = xml(file(`<config><a>1</a></config>`));
      expect((await store.read()).value).toStrictEqual(store.readSync().value);
    });

    it('should write the same thing both ways', async () => {
      const a = file(`<config><x>1</x></config>`);
      const b = file(`<config><x>1</x></config>`);
      await xml(a).write({ x: '2' });
      xml(b).writeSync({ x: '2' });
      expect(read(a)).toBe(read(b));
    });

    it('should expand a ~ rather than making a directory called one', () => {
      // one implementation of that rule, which is `paths.expand()`'s -- and
      // without it `readFileSync` reports an `ENOENT` naming a path with a `~`
      // still in it, which reads as "the file is missing"
      expect(xml('~/sigil-xml-nope/config.xml').source).not.toContain('~');
    });

    it('should refuse a path that cannot name a file', () => {
      // refused here rather than at the read, which is `json()`'s own reason:
      // `expand('')` is `'.'`, so an empty path reported a failure to read a
      // directory nobody named
      expect(() => xml('')).toThrow(/needs a path/);
      expect(() => xml(undefined as unknown as string)).toThrow(/needs a path/);
    });

    it('should report a read that failed for a reason other than absence', () => {
      // `isMissing()` is core's, and it is `ENOENT` alone: reading every error
      // as absence was a real defect there, found by review
      const dir = absent('dir');
      writeFileSync(dir, '');
      expect(() => xml(`${dir}/config.xml`).readSync()).toThrow(/Failed to read/);
    });
  });

  describe('the claimed paths', () => {
    it('should leave a key another process wrote in the save window alone', () => {
      // the one thing re-reading buys. A store handed a whole document and
      // nothing else can only diff the whole of it, so a key another process
      // changed between the read and the write is reverted -- even one this
      // process never touched
      const path = file(`<config>\n  <a>1</a>\n</config>\n`);
      const store = xml(path);
      const held = store.readSync().value as Record<string, unknown>;

      // somebody else, in the window
      writeFileSync(path, `<config>\n  <a>1</a>\n  <b>2</b>\n</config>\n`);

      store.writeSync({ ...held, a: '9' }, { paths: ['a'] });

      expect(xml(path).readSync().value).toStrictEqual({ a: '9', b: '2' });
    });

    it('should be total with no claim, which is what write(value) means on its own', () => {
      const path = file(`<config>\n  <a>1</a>\n  <b>2</b>\n</config>\n`);
      xml(path).writeSync({ a: '9' });
      expect(xml(path).readSync().value).toStrictEqual({ a: '9' });
    });

    it('should claim a path over a file that is not there', () => {
      const path = absent();
      xml(path).writeSync({ a: '1', b: '2' }, { paths: ['a'] });
      expect(xml(path).readSync().value).toStrictEqual({ a: '1' });
    });

    it('should refuse a claimed path whose ancestor is not an object', () => {
      // `overlay()` is core's rather than this package's, so the null
      // exemption, the non-object refusal and the claimed-delete no-op are each
      // the answer core already arrived at by review rather than a second one
      const path = file(`<config>\n  <items>a</items>\n</config>\n`);
      expect(() => xml(path).writeSync({ items: { b: '1' } }, { paths: ['items.b'] })).toThrow(
        /"items" in .* is not an object/
      );
    });
  });

  describe('through a Config', () => {
    it('should load and coerce, because the schema runs over every layer', () => {
      // "this store needs no `checkValue()`" is true of the *store* and false
      // if read as "an XML value never meets the schema": `Config` coerces
      // every layer whatever produced it, so `'8080'` on an `int` setting is
      // the number every reader after the coercion sees
      const schema: ConfigSchema = { 'server.port': { type: 'int' } };
      const config = createConfigSync({
        layers: [
          { name: 'f', store: xml(file(`<config><server port="8080"/></config>`), { schema }) },
        ],
        schema,
      });
      expect(config.get('server.port')).toBe(8080);
    });

    it('should set, save and read back', async () => {
      const path = file(`<config>\n  <a>1</a>\n</config>\n`);
      const config = await createConfig({ layers: [{ name: 'f', store: xml(path) }] });
      config.set('a', '2');
      expect(config.layers[0]?.dirty).toBe(true);
      await config.save();
      expect(read(path)).toBe(`<config>\n  <a>2</a>\n</config>\n`);
    });

    it('should delete a key', async () => {
      const path = file(`<config>\n  <a>1</a>\n  <b>2</b>\n</config>\n`);
      const config = await createConfig({ layers: [{ name: 'f', store: xml(path) }] });
      config.delete('b');
      await config.save();
      expect(read(path)).toBe(`<config>\n  <a>1</a>\n</config>\n`);
    });

    it('should report its format and its source on the layer', () => {
      const path = file(`<config/>`);
      const config = createConfigSync({ layers: [{ name: 'system', store: xml(path) }] });
      expect(config.layers[0]).toMatchObject({ format: 'xml', name: 'system', source: path });
    });
  });

  describe('the cross-format claim, which is the whole point of the mapping', () => {
    it('should let a JSON layer shadow an XML one at the same path', () => {
      // the table in the sentinel argument, as a test. Under `_attributes` the
      // two layers would hold two different paths, neither shadowing the other:
      // `get('server.port')` would answer the user's, the system default would
      // be invisible at that path, and deleting the override would give
      // `undefined` rather than the default
      const system = xml(file(`<config><server port="8080"/></config>`));
      const user = json(file(`{"server":{"port":9090}}`));
      const config = createConfigSync({
        layers: [
          { name: 'system', store: system },
          { name: 'user', store: user },
        ],
      });

      expect(config.get('server.port')).toBe(9090);
      config.delete('server.port', 'user');
      expect(config.get('server.port')).toBe('8080');
    });

    it('should shadow a setting the XML layer spelled as a child element', () => {
      // the other spelling of the same setting, which has to shadow identically
      const config = createConfigSync({
        layers: [
          {
            name: 'system',
            store: xml(file(`<config><server><port>8080</port></server></config>`)),
          },
          { name: 'user', store: json(file(`{"server":{"port":9090}}`)) },
        ],
      });
      expect(config.get('server.port')).toBe(9090);
    });

    it('should hold a list at the same path a JSON layer does', () => {
      const schema: ConfigSchema = { plugins: { multiple: true } };
      const config = createConfigSync({
        layers: [
          {
            name: 'system',
            store: xml(file(`<config><plugins>a</plugins><plugins>b</plugins></config>`), {
              schema,
            }),
          },
        ],
        schema,
      });
      const asJson = createConfigSync({
        layers: [{ name: 'system', store: json(file(`{"plugins":["a","b"]}`)) }],
        schema,
      });
      expect(config.get('plugins')).toStrictEqual(asJson.get('plugins'));
    });

    it('should let a JSON layer shadow an XML list', () => {
      const schema: ConfigSchema = { plugins: { multiple: true } };
      const config = createConfigSync({
        layers: [
          { name: 'system', store: xml(file(`<config><plugins>a</plugins></config>`), { schema }) },
          { name: 'user', store: json(file(`{"plugins":["z"]}`)) },
        ],
        schema,
      });
      expect(config.get('plugins')).toStrictEqual(['z']);
    });
  });

  describe('the array mutators, which is where the contract was ambiguous', () => {
    // found by review round 2 and measured: `canRepresent` is handed a value
    // and the path it is written to, and for a `push` core handed over the
    // **item** at the **list's** path -- a pair no path-sensitive store can
    // answer, because `set('plugins', 'a')` and `push('plugins', 'a')` hand
    // over the identical one. XML is the first store to read a path, since it
    // cannot tell a list of one occurrence from a scalar, so every push and
    // unshift on a declared `multiple` path threw. Fixed in core, which now
    // asks about the list the call produces
    const schema: ConfigSchema = { plugins: { multiple: true, type: 'string' } };

    it('should push onto a list, which is the commonest way to add one', async () => {
      const path = file(`<config>\n  <!-- what to load -->\n  <plugins>a</plugins>\n</config>\n`);
      const config = await createConfig({
        layers: [{ name: 'user', store: xml(path, { schema }) }],
        schema,
      });

      config.push('plugins', 'b');
      config.unshift('plugins', 'z');
      expect(config.get('plugins')).toStrictEqual(['z', 'a', 'b']);
      expect(config.pop('plugins')).toBe('b');

      await config.save();
      expect(read(path)).toBe(
        `<config>\n  <!-- what to load -->\n  <plugins>z</plugins>\n  <plugins>a</plugins>\n</config>\n`
      );
    });

    it('should refuse a pop that leaves a list XML cannot tell from a scalar', async () => {
      // the other half of the same finding: `pop` asked nothing at all, so a
      // value this store cannot hold reached memory and the refusal waited for
      // `save()` -- which is the one thing `canRepresent` exists to stop
      const path = file(`<config>\n  <tags>a</tags>\n  <tags>b</tags>\n</config>\n`);
      const config = await createConfig({ layers: [{ name: 'user', store: xml(path) }] });

      expect(() => config.pop('tags')).toThrow(/declare "tags" as multiple/);
      expect(config.get('tags'), 'the refused pop changed nothing').toStrictEqual(['a', 'b']);
    });
  });
});
