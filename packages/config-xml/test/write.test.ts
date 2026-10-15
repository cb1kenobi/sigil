import { xml } from '../src/index.js';
import { absent, file, read } from './helpers.js';
import type { ConfigSchema, WritableConfigStore } from '@ttylabs/sigil/config';
import { describe, expect, it } from 'vitest';

/** A store over a file holding this, and the path, so a test can read it back. */
function over(text: string, schema?: ConfigSchema): { path: string; store: WritableConfigStore } {
  const path = file(text);
  return { path, store: xml(path, schema ? { schema } : {}) };
}

/** What a file holds after the value it already holds is written back whole. */
function after(text: string, value: unknown, schema?: ConfigSchema): string {
  const { path, store } = over(text, schema);
  store.writeSync(value);
  return read(path);
}

describe('writing', () => {
  describe('the acceptance test', () => {
    it('should change one key and leave every other byte identical', () => {
      // the JSON store's own acceptance test, one format along -- and what it
      // rests on is measured rather than hoped: a declaration, two comments,
      // nested elements, a CDATA section and tab indentation all come through
      // `@xmldom/xmldom` 0.9.12 untouched
      const src = [
        `<?xml version="1.0" encoding="UTF-8"?>`,
        `<!-- the app's settings -->`,
        `<config mode="dev">`,
        `\t<!-- where to listen -->`,
        `\t<server port="8080">`,
        `\t\t<host>example.com</host>`,
        `\t</server>`,
        `\t<banner><![CDATA[<b>hi</b>]]></banner>`,
        `</config>`,
        ``,
      ].join('\n');

      const out = after(src, {
        banner: '<b>hi</b>',
        mode: 'dev',
        server: { host: 'example.com', port: '9090' },
      });

      expect(out).toBe(src.replace('8080', '9090'));
    });

    it('should keep a CDATA section nobody touched', () => {
      // the finding a review round named: assigning `textContent` to a
      // CDATA-bearing element **with the string it already holds** turns
      // `<![CDATA[<b>hi</b>]]>` into `&lt;b&gt;hi&lt;/b&gt;`, so a walk that
      // sets unconditionally destroys every CDATA section in the file on any
      // write. Diffing first is what makes this hold
      const src = `<config>\n  <a>1</a>\n  <banner><![CDATA[<b>hi</b>]]></banner>\n</config>\n`;
      expect(after(src, { a: '2', banner: '<b>hi</b>' })).toBe(src.replace('<a>1</a>', '<a>2</a>'));
    });

    it('should rewrite a CDATA section as CDATA where its value really changed', () => {
      // the author chose that spelling for a reason, and a value holding `<`
      // written as a text node is escaped where they wanted it verbatim
      const src = `<config><banner><![CDATA[<b>hi</b>]]></banner></config>`;
      expect(after(src, { banner: '<i>bye</i>' })).toBe(
        `<config><banner><![CDATA[<i>bye</i>]]></banner></config>`
      );
    });

    it('should not rewrite a value the schema coerced to a number', () => {
      // a layer's value has been through `coerceLayer()`, so an `int` setting
      // holds the number 8080 where the document holds the string '8080'.
      // Comparing those as *values* says they differ, and then every typed
      // setting is rewritten on every save -- the CDATA defect arriving through
      // the schema. So the diff compares at the level of the bytes
      const src = `<config port="8080">\n  <banner><![CDATA[<b>&</b>]]></banner>\n</config>\n`;
      expect(after(src, { banner: '<b>&</b>', port: 8080 })).toBe(src);
    });
  });

  describe('an insert', () => {
    it('should copy the indentation its siblings have', () => {
      expect(
        after(`<config>\n  <server>\n    <host>a</host>\n  </server>\n</config>\n`, {
          server: { host: 'a', port: '80' },
        })
      ).toBe(
        `<config>\n  <server>\n    <host>a</host>\n    <port>80</port>\n  </server>\n</config>\n`
      );
    });

    it('should use the document’s own step where there are no siblings to copy', () => {
      expect(after(`<config>\n  <server/>\n</config>\n`, { server: { port: '80' } })).toBe(
        `<config>\n  <server>\n    <port>80</port>\n  </server>\n</config>\n`
      );
    });

    it('should read the layout off the first sibling that has one', () => {
      // neither the first nor the last. The first alone is wrong here: `<a>`
      // shares the opening tag's line and has no preceding text at all, so an
      // insert read "no layout" off it and landed inline against a `<b>` that
      // is laid out. Found by probing the detection rather than by a report
      expect(after(`<config><a>1</a>\n  <b>2</b>\n</config>\n`, { a: '1', b: '2', c: '3' })).toBe(
        `<config><a>1</a>\n  <b>2</b>\n  <c>3</c>\n</config>\n`
      );
    });

    it('should copy the majority rather than an outlier where the indent is inconsistent', () => {
      // which is what the *last* sibling that has one would get wrong
      expect(
        after(`<config>\n  <a>1</a>\n      <b>2</b>\n</config>\n`, { a: '1', b: '2', c: '3' })
      ).toBe(`<config>\n  <a>1</a>\n      <b>2</b>\n  <c>3</c>\n</config>\n`);
    });

    it('should go after whatever shares the last sibling\u2019s line', () => {
      // `last.nextSibling` alone splices the new element **in front of** an
      // inline comment, so the comment came out on the new element's line -- a
      // file saying something false, which the JSONC writer's own entry records
      // as worse than losing the comment outright. The same finding in a second
      // format, found by review round 1
      expect(after(`<config>\n  <a>1</a> <!-- on a -->\n</config>\n`, { a: '1', b: '2' })).toBe(
        `<config>\n  <a>1</a> <!-- on a -->\n  <b>2</b>\n</config>\n`
      );
    });

    it('should read a newline inside a value as content rather than as layout', () => {
      // a text node that is nothing but whitespace and holds a break is a
      // document laid out across lines; a break *inside a value* is content.
      // Without the distinction a single-line document holding a multi-line
      // CDATA section reads as laid out
      expect(
        after(`<config><note><![CDATA[l1\nl2]]></note></config>`, {
          note: 'l1\nl2',
          port: '80',
        })
      ).toBe(`<config><note><![CDATA[l1\nl2]]></note><port>80</port></config>`);
    });

    it('should leave no stray blank line in an empty but laid-out document', () => {
      // the **root** is where this shows, because it reads as `{}` where a leaf
      // reads as `''`: both are plain objects, so the clear that handles a
      // scalar becoming a container was skipped, the `\n` survived, and the
      // insert added a second one beside it -- a blank line in every file
      // written into one
      expect(after(`<config>\n</config>\n`, { a: '1' })).toBe(`<config>\n  <a>1</a>\n</config>\n`);
    });

    it('should keep a single-line document on one line', () => {
      // a document with no line break in its layout has no step to read, and
      // inventing one would reformat a file nobody asked to reformat
      expect(after(`<config><a>1</a></config>`, { a: '1', b: '2' })).toBe(
        `<config><a>1</a><b>2</b></config>`
      );
    });

    it('should keep the parent’s own prefix, rather than dropping out of its namespace', () => {
      // measured: `createElement('b')` inside `<n:cfg xmlns:n="urn:x">` yields
      // `<b>2</b>` beside `<n:a>1</n:a>` -- a new key silently out of the
      // namespace every other key is in, which for a document something else
      // validates is a file that stops validating
      expect(after(`<n:config xmlns:n="urn:x"><n:a>1</n:a></n:config>`, { a: '1', b: '2' })).toBe(
        `<n:config xmlns:n="urn:x"><n:a>1</n:a><n:b>2</n:b></n:config>`
      );
    });

    it('should land in a default namespace without a prefix', () => {
      // the two spellings serialize identically there -- measured -- which is
      // what makes the prefix rule one rule rather than a branch
      expect(after(`<config xmlns="urn:y"><a>1</a></config>`, { a: '1', b: '2' })).toBe(
        `<config xmlns="urn:y"><a>1</a><b>2</b></config>`
      );
    });

    it('should promote a leaf to a container, dropping its text', () => {
      expect(
        after(`<config>\n  <server>old</server>\n</config>\n`, { server: { port: '80' } })
      ).toBe(`<config>\n  <server>\n    <port>80</port>\n  </server>\n</config>\n`);
    });
  });

  describe('an element becoming a leaf', () => {
    it('should drop its attributes with its children', () => {
      // an element holds a scalar or named parts and never both, so leaving the
      // attributes behind wrote `<server host="h">none</server>` -- mixed
      // content the **read refuses**, which is a `save()` producing a file this
      // store cannot read back. Found by review round 1
      expect(
        after(`<config><server host="h"><port>1</port></server></config>`, {
          server: 'none',
        })
      ).toBe(`<config><server>none</server></config>`);
    });

    it('should drop them for an empty value too, which is a wrong value rather than a throw', () => {
      // `{ server: '' }` over `<server host="h"/>` left the attribute and read
      // back as `{ host: 'h' }`
      const { path, store } = over(`<config><server host="h"/></config>`);
      store.writeSync({ server: '' });
      expect(xml(path).readSync().value).toStrictEqual({ server: '' });
    });

    it('should drop them for an emptied list, which is the third shape', () => {
      // an emptied list over `<p n="a"/>` read back as `[{ n: 'a' }]`
      const schema: ConfigSchema = { p: { multiple: true } };
      const { path, store } = over(`<config><p n="a"/><p n="b"/></config>`, schema);
      store.writeSync({ p: [] });
      expect(xml(path, { schema }).readSync().value).toStrictEqual({ p: [] });
    });

    it('should fall back to a text node for a value holding ]]>', () => {
      // `createCDATASection` **throws** `data contains "]]>"` -- a DOM error
      // naming nothing -- and the value is perfectly representable as escaped
      // text, so refusing it would refuse the format's own answer. What is lost
      // is the author's CDATA spelling for that one element, which is smaller
      // than the `a]]]]><![CDATA[>b` split that keeps it and produces a file
      // nobody wants to read. Found by review round 1
      const { path, store } = over(`<config><s><![CDATA[old]]></s></config>`);
      store.writeSync({ s: 'a]]>b' });
      expect(read(path)).toBe(`<config><s>a]]&gt;b</s></config>`);
      expect(xml(path).readSync().value).toStrictEqual({ s: 'a]]>b' });
    });
  });

  describe('a document whose root is not an object', () => {
    it('should be refused at the write as well as at the read', () => {
      // without it `write([1, 2])` reached the walk as a scalar root and wrote
      // `<config>1,2</config>` -- the `String(array)` corruption, at the one
      // path the list check skips because the root is where a document may
      // legitimately be `{}`
      expect(() => xml(file(`<config/>`)).writeSync([1, 2])).toThrow(/must hold an object/);
      expect(() => xml(file(`<config/>`)).writeSync('x')).toThrow(/must hold an object/);
    });
  });

  describe('a removal', () => {
    it('should take the whitespace that was laying a child out with it', () => {
      // left behind, a removal leaves an indented blank line per key -- the
      // line rule the JSONC writer already keeps
      expect(after(`<config>\n  <a>1</a>\n  <b>2</b>\n</config>\n`, { a: '1' })).toBe(
        `<config>\n  <a>1</a>\n</config>\n`
      );
    });

    it('should remove an attribute the value no longer has', () => {
      expect(after(`<config a="1" b="2"/>`, { a: '1' })).toBe(`<config a="1"/>`);
    });

    it('should remove a prefixed attribute by its own namespace', () => {
      expect(after(`<config xmlns:n="urn:x" n:a="1" b="2"/>`, { b: '2' })).toBe(
        `<config xmlns:n="urn:x" b="2"/>`
      );
    });
  });

  describe('a scalar at a path the document spells as an attribute', () => {
    it('should stay an attribute', () => {
      // the DOM is what remembers which spelling a setting had, which is what
      // makes a round trip clean and is why a sentinel mapping was refused
      expect(after(`<config><server port="1"/></config>`, { server: { port: '2' } })).toBe(
        `<config><server port="2"/></config>`
      );
    });

    it('should update a prefixed attribute rather than adding a second one', () => {
      // `setAttributeNS(null, 'mode', ...)` on an element whose attribute is
      // `n:mode` adds a **second** attribute called `mode` beside it, which is
      // the two-answers-for-one-setting this mapping refuses, created by the
      // write that was meant to keep the spelling
      expect(after(`<config xmlns:n="urn:x" n:mode="dev"/>`, { mode: 'prod' })).toBe(
        `<config xmlns:n="urn:x" n:mode="prod"/>`
      );
    });
  });

  describe('an object or a list at a path the document spells as an attribute', () => {
    it('should promote the attribute to elements', () => {
      // `setAttribute('server', '[object Object]')` is what a review round
      // measured. An attribute holds a string, so a value that is an object
      // cannot stay one -- and an element can hold anything, which makes it the
      // general spelling and the attribute the special case kept where it fits
      expect(after(`<config server="prod"/>`, { server: { host: 'x' } })).toBe(
        `<config><server><host>x</host></server></config>`
      );
    });

    it('should promote it for a list too', () => {
      expect(after(`<config plugins="a"/>`, { plugins: ['a', 'b'] })).toBe(
        `<config><plugins>a</plugins><plugins>b</plugins></config>`
      );
    });

    it('should leave no collision behind when it promotes', () => {
      // the attribute is removed *before* the elements are written, or the
      // document holds a name spelled both ways, which the read refuses
      const { path, store } = over(`<config server="prod"/>`);
      store.writeSync({ server: { host: 'x' } });
      expect(xml(path).readSync().value).toStrictEqual({ server: { host: 'x' } });
    });
  });

  describe('a list', () => {
    const schema: ConfigSchema = { plugins: { multiple: true } };

    it('should append one element for a push', () => {
      expect(
        after(`<config>\n  <plugins>a</plugins>\n</config>\n`, { plugins: ['a', 'b'] }, schema)
      ).toBe(`<config>\n  <plugins>a</plugins>\n  <plugins>b</plugins>\n</config>\n`);
    });

    it('should drop the tail for a shorter list', () => {
      expect(
        after(
          `<config>\n  <plugins>a</plugins>\n  <plugins>b</plugins>\n</config>\n`,
          { plugins: ['a'] },
          schema
        )
      ).toBe(`<config>\n  <plugins>a</plugins>\n</config>\n`);
    });

    it('should write an empty list as one empty element', () => {
      // zero elements is the key being *absent*, which merges as nothing and
      // lets the layer below show through rather than shadowing it with an
      // explicit empty
      expect(
        after(
          `<config>\n  <plugins>a</plugins>\n  <plugins>b</plugins>\n</config>\n`,
          { plugins: [] },
          schema
        )
      ).toBe(`<config>\n  <plugins/>\n</config>\n`);
    });

    it('should round-trip an empty list through the file', () => {
      const { path, store } = over(`<config><plugins>a</plugins></config>`, schema);
      store.writeSync({ plugins: [] });
      expect(xml(path, { schema }).readSync().value).toStrictEqual({ plugins: [] });
    });

    it('should write a list of objects', () => {
      expect(
        after(`<config>\n  <a>1</a>\n</config>\n`, {
          a: '1',
          plugin: [{ name: 'a' }, { name: 'b' }],
        })
      ).toBe(
        `<config>\n  <a>1</a>\n  <plugin>\n    <name>a</name>\n  </plugin>\n  <plugin>\n    <name>b</name>\n  </plugin>\n</config>\n`
      );
    });

    it('should keep a list inline in a single-line document', () => {
      // `<config/>` is a document with no layout in it at all, so there is no
      // step to read and inventing one would reformat a file nobody asked to
      // reformat -- which is the same rule a single-line insert already keeps
      expect(after(`<config/>`, { plugin: [{ name: 'a' }, { name: 'b' }] })).toBe(
        `<config><plugin><name>a</name></plugin><plugin><name>b</name></plugin></config>`
      );
    });

    it('should collapse several elements to the first where the value is one thing', () => {
      expect(after(`<config>\n  <a>1</a>\n  <a>2</a>\n</config>\n`, { a: '3' })).toBe(
        `<config>\n  <a>3</a>\n</config>\n`
      );
    });
  });

  describe('a file written from nothing', () => {
    it('should carry a declaration and be laid out', () => {
      // a fresh `<config/>` has no text in it at all, so the layout detection
      // reads as single-line on its own -- which would put a from-scratch file
      // on one line however many settings it holds
      const path = absent();
      xml(path).writeSync({ server: { port: '80' } });
      expect(read(path)).toBe(
        `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <server>\n    <port>80</port>\n  </server>\n</config>\n`
      );
    });

    it('should take the root element name it was given', () => {
      const path = absent();
      xml(path, { root: 'settings' }).writeSync({ a: '1' });
      expect(read(path)).toContain('<settings>');
    });

    it('should refuse a root name no element can have', () => {
      expect(() => xml('x.xml', { root: '1nope' })).toThrow(/not a usable XML root element name/);
      expect(() => xml('x.xml', { root: 'a b' })).toThrow(/not a usable XML root element name/);
    });

    it('should write an empty document for an empty value', () => {
      const path = absent();
      xml(path).writeSync({});
      expect(read(path)).toBe(`<?xml version="1.0" encoding="UTF-8"?>\n<config/>\n`);
      expect(xml(path).readSync().value).toStrictEqual({});
    });
  });

  describe('the shape its bytes carry', () => {
    it('should put CRLF back', () => {
      const src = `<config>\r\n  <a>1</a>\r\n</config>\r\n`;
      expect(after(src, { a: '2' })).toBe(`<config>\r\n  <a>2</a>\r\n</config>\r\n`);
    });

    it('should put a byte order mark back', () => {
      expect(after(`\uFEFF<config><a>1</a></config>\n`, { a: '2' })).toBe(
        `\uFEFF<config><a>2</a></config>\n`
      );
    });

    it('should keep a file with no trailing newline without one', () => {
      expect(after(`<config><a>1</a></config>`, { a: '2' })).toBe(`<config><a>2</a></config>`);
    });

    it('should keep a carriage return alone, which is the third flavour', () => {
      // without it an old Mac file reports a loss and cannot be written to
      // without `lossy`, for a line ending that is merely extinct rather than
      // wrong -- and three characters is what it costs. Found by probing
      expect(after(`<config>\r  <a>1</a>\r</config>\r`, { a: '2' })).toBe(
        `<config>\r  <a>2</a>\r</config>\r`
      );
    });

    it('should keep the trailing run rather than one break of it', () => {
      // the whole run rather than a boolean, which costs the same: the
      // serializer drops everything after the root, so a boolean puts back one
      // break where there were two and a file ending in a blank line is
      // reported as a loss it need not suffer
      expect(after(`<config><a>1</a></config>\n\n`, { a: '2' })).toBe(
        `<config><a>2</a></config>\n\n`
      );
      expect(after(`<config><a>1</a></config>\r\n`, { a: '2' })).toBe(
        `<config><a>2</a></config>\r\n`
      );
    });

    it('should take CRLF where a mixed document holds one at all', () => {
      // rather than whichever came first: a mixed document is already mangled
      // and either answer rewrites somebody's lines, so what is left to pick is
      // the simpler rule -- and it is reported as a loss either way
      const out = after(`<config>\n  <a>1</a>\r\n</config>\n`, { a: '2' });
      expect(out).toBe(`<config>\r\n  <a>2</a>\r\n</config>\n`);
    });
  });

  describe('a write that changes nothing', () => {
    it('should touch no file, which is what keeps the mtime a watcher reads', () => {
      const src = `<config>\n  <a>1</a>\n</config>\n`;
      const { path, store } = over(src);
      const before = read(path);
      store.writeSync({ a: '1' });
      expect(read(path)).toBe(before);
    });
  });
});
