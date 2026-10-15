import { xml } from '../src/index.js';
import { absent, file, read } from './helpers.js';
import { createConfigSync } from '@ttylabs/sigil/config';
import type { ConfigSchema, WritableConfigStore } from '@ttylabs/sigil/config';
import { statSync } from 'node:fs';
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

    it('should leave a CDATA section and an attribute alone on a same-value write', () => {
      // and its name used to claim the coercion, which it cannot see: `port` is
      // an attribute, whose bytes serialize identically either way, and
      // `banner` is a sibling whose value is already a string -- so the
      // comparison this described could be deleted and the output was still
      // byte for byte the source. Found by review round 2; the test that does
      // see it is `should not rewrite a value a schema coerced to a number`
      //
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

    it('should leave no collision behind when it promotes a prefixed one', () => {
      // the attribute is removed *before* the elements are written, or the
      // document holds a name spelled both ways, which the read refuses -- and
      // **prefixed**, which is the half that was untested: the removal is
      // against the attribute's own namespace, and with it taken off nothing in
      // the suite failed, because every promotion case used an unprefixed
      // attribute and the test above already asserts the whole string. Found by
      // review round 2
      const { path, store } = over(`<config xmlns:n="urn:x" n:server="prod"/>`);
      store.writeSync({ server: { host: 'x' } });

      // the elements take the **parent's** prefix rather than the attribute's,
      // which is `newElement()`'s rule and is right here: a promoted key is a
      // new element, an unprefixed attribute is in no namespace even under a
      // default one, and the setting is identified by its local name either
      // way -- so taking the attribute's prefix would be a second rule for one
      // case. What the namespace on the *removal* buys is that `n:server` goes
      // at all rather than sitting beside the element as a collision
      expect(read(path)).toBe(`<config xmlns:n="urn:x"><server><host>x</host></server></config>`);
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
    // asserted on the **inode** rather than on the bytes, which is what the
    // first version of this did and could not see: what a no-op write would
    // put there is byte for byte what is there, so comparing the file's
    // contents passes whether or not the file was written. `writeAtomic()`
    // renames a temp file over the target, so a write changes the inode and a
    // skipped write does not -- exact, and with no timing in it, where an
    // mtime at millisecond resolution is a flaky test one busy machine later
    it('should touch no file, which is what keeps the mtime a watcher reads', () => {
      const src = `<config>\n  <a>1</a>\n</config>\n`;
      const { path, store } = over(src);
      const was = statSync(path).ino;
      store.writeSync({ a: '1' });
      expect(statSync(path).ino, 'skipped').toBe(was);
      store.writeSync({ a: '2' });
      expect(statSync(path).ino, 'written').not.toBe(was);
    });

    it('should touch no file through the async path either', async () => {
      // the two are separate implementations of one loop, for the reason
      // `createConfigSync()` is -- so the guard is two guards, and the sync
      // test above cannot see the other one
      const { path, store } = over(`<config>\n  <a>1</a>\n</config>\n`);
      const was = statSync(path).ino;
      await store.write({ a: '1' });
      expect(statSync(path).ino, 'skipped').toBe(was);
      await store.write({ a: '2' });
      expect(statSync(path).ino, 'written').not.toBe(was);
    });
  });

  describe('a comment that shared the line of the removed element', () => {
    // it is not the child's to take, and pulling it up **inline** onto the
    // previous element makes the file say something false. Measured against
    // the JSONC store, which leaves such a comment on a line of its own: the
    // two really did disagree and this was the worse one. Found by review
    // round 2
    it('should leave it on a line of its own rather than inline', () => {
      const out = after(`<config>\n  <a>1</a>\n  <b>2</b> <!-- on b -->\n  <c>3</c>\n</config>\n`, {
        a: '1',
        c: '3',
      });
      expect(out).toBe(`<config>\n  <a>1</a>\n  <!-- on b -->\n  <c>3</c>\n</config>\n`);
    });

    it('should answer the same as a comment that had its own line already', () => {
      // the two spellings of one document come out identical, which is what
      // says the rule is about the line rather than about the comment
      const inline = `<config>\n  <a>1</a>\n  <b>2</b> <!-- on b -->\n  <c>3</c>\n</config>\n`;
      const own = `<config>\n  <a>1</a>\n  <!-- on b -->\n  <b>2</b>\n  <c>3</c>\n</config>\n`;
      expect(after(inline, { a: '1', c: '3' })).toBe(after(own, { a: '1', c: '3' }));
    });

    it('should keep the indent it had where the removed element was first', () => {
      const out = after(`<config>\n  <a>1</a> <!-- on a -->\n  <b>2</b>\n</config>\n`, {
        b: '2',
      });
      expect(out).toBe(`<config>\n  <!-- on a -->\n  <b>2</b>\n</config>\n`);
    });

    it('should take the whole line where nothing shared it', () => {
      // the control, so the tests above cannot pass by nothing ever being
      // taken: without the indent a removal leaves an indented blank line
      const out = after(`<config>\n  <a>1</a>\n  <b>2</b>\n  <c>3</c>\n</config>\n`, {
        a: '1',
        c: '3',
      });
      expect(out).toBe(`<config>\n  <a>1</a>\n  <c>3</c>\n</config>\n`);
    });

    it('should not read a gap holding a line break as sharing the line', () => {
      // a break ends the line, so what follows is on its own already and the
      // indent in front of the child is still the child's. Measured on a child
      // with no indent of its own, which is the one shape where keeping the
      // gap instead and keeping the indent differ
      const out = after(`<config><a>1</a>\n  <!-- c -->\n  <b>2</b>\n</config>`, { b: '2' });
      expect(out).toBe(`<config>\n  <!-- c -->\n  <b>2</b>\n</config>`);
    });

    it('should not read a gap with nothing after it as sharing the line', () => {
      // whitespace before the closing tag is the parent's own, so there is no
      // trivia for it to be in front of and the indent is taken as ever
      expect(after(`<config>\n  <a>1</a> </config>`, {})).toBe(`<config> </config>`);
    });

    it('should take the horizontal whitespace where the line ends after it', () => {
      // a space before the closing tag is the child's, because nothing shares
      // the line -- so this is the other side of the same question
      expect(after(`<config><a>1</a> <b>2</b></config>`, { a: '1' })).toBe(
        `<config><a>1</a></config>`
      );
    });

    it('should keep the comment of a list tail on its own line too', () => {
      // `writeList()` drops through the same function, so the rule is the
      // list's as well -- which nothing else here would have shown
      const schema: ConfigSchema = { p: { multiple: true, type: 'string' } };
      const out = after(
        `<config>\n  <p>1</p>\n  <p>2</p>\n  <p>3</p> <!-- on 3 -->\n</config>\n`,
        { p: ['1', '2'] },
        schema
      );
      expect(out).toBe(`<config>\n  <p>1</p>\n  <p>2</p>\n  <!-- on 3 -->\n</config>\n`);
    });
  });

  describe('the diff, which is two guards covering for each other', () => {
    // each one deleted alone changes no answer for a same-value write, and
    // both deleted together moves an inner comment -- which is how a survivor
    // becomes a wrong conclusion. So each is pinned by the input that
    // separates it, and the per-key one turns out to be a fast path
    it('should skip a list element that did not change, where the key diff cannot', () => {
      // the second element changed, so `same()` over the array is false and
      // the per-key skip cannot fire; what skips the first is `applyInto()`'s
      // own whole-subtree guard, and without it the comment inside it moves
      const schema: ConfigSchema = { p: { multiple: true, type: 'string' } };
      const out = after(
        `<config>\n  <p>1<!-- x --></p>\n  <p>2</p>\n</config>`,
        {
          p: ['1', '3'],
        },
        schema
      );
      expect(out).toBe(`<config>\n  <p>1<!-- x --></p>\n  <p>3</p>\n</config>`);
    });

    it('should not rewrite a value a schema coerced to a number', () => {
      // `same()` compares through `textFor()` rather than by identity, so a
      // setting declared `int` meeting its own `8080` is not a change -- by
      // identity a string never equals a number, every such key is rewritten,
      // and the rewrite moves whatever the element held beside its text.
      //
      // Handed over directly rather than through a `createConfigSync()`, and
      // the reason is the finding: review round 2 asked for the second, which
      // **removes** what this pins. A `saveSync()` claims only the paths this
      // process touched, so the overlay leaves `a` as the file has it and the
      // store is handed the file's own string -- never comparing a number with
      // a string at all. So this claim is a whole-document `write()`'s, which
      // is what a store's own test should drive anyway. No schema either, for
      // the other half of that finding: the store reads one for `multiple`
      // alone, so a `type` in it is decoration -- what matters is that the
      // value arrives coerced, which is what `coerceLayer()` hands a store
      const out = after(`<config>\n  <a>8080<!-- port --></a>\n  <b>2</b>\n</config>`, {
        a: 8080,
        b: '3',
      });
      expect(out).toBe(`<config>\n  <a>8080<!-- port --></a>\n  <b>3</b>\n</config>`);
    });

    it('should leave a value a save did not claim alone, whatever its type', () => {
      // which is the other half, and is why the test above drives a `write()`:
      // the three-way merge means a `save()` never hands the store a value this
      // process did not touch, so the diff is not what protects `a` there
      const schema: ConfigSchema = { a: { type: 'int' }, b: { type: 'string' } };
      const path = file(`<config>\n  <a>8080<!-- port --></a>\n  <b>2</b>\n</config>`);
      const config = createConfigSync({
        layers: [{ name: 'user', store: xml(path, { schema }) }],
        schema,
      });

      expect(config.get('a'), 'the schema coerced it').toBe(8080);
      config.set('b', '3');
      config.saveSync();

      expect(read(path)).toBe(`<config>\n  <a>8080<!-- port --></a>\n  <b>3</b>\n</config>`);
    });
  });

  describe('a new element takes the prefix its parent has', () => {
    it('should not let the serializer pick, where one namespace has two', () => {
      // `createElementNS()` with no prefix leaves the serializer to find one
      // for the URI, and with two bound it picks whichever it meets -- so a
      // new key beside a `q:`-spelled sibling came out `q:b` under a `p:`
      // parent. Legal, unusual, and silent: nobody reads a prefix twice
      const out = after(`<p:config xmlns:p="urn:x" xmlns:q="urn:x">\n  <q:a>1</q:a>\n</p:config>`, {
        a: '1',
        b: '2',
      });
      expect(out).toBe(
        `<p:config xmlns:p="urn:x" xmlns:q="urn:x">\n  <q:a>1</q:a>\n  <p:b>2</p:b>\n</p:config>`
      );
    });
  });

  describe('whether the document is laid out at all', () => {
    it('should not read a newline inside a value as a layout', () => {
      // `multiline()` asks about **whitespace-only** text holding a newline,
      // which is an indent; a newline inside a value is content. Without the
      // first half, a document written on one line whose only newline is in a
      // value is laid out, and the one place `step` is read -- a parent with
      // no element children -- then indents inside it
      const out = after(`<config><a>one\ntwo</a></config>`, { a: { z: '1' } });
      expect(out).toBe(`<config><a><z>1</z></a></config>`);
    });

    it('should lay a fresh insert out where the document really is', () => {
      // the control, so the test above cannot pass by nothing being laid out
      const out = after(`<config>\n  <a>x</a>\n</config>`, { a: { z: '1' } });
      expect(out).toBe(`<config>\n  <a>\n    <z>1</z>\n  </a>\n</config>`);
    });
  });
});
