import { xml } from '../src/index.js';
import { file } from './helpers.js';
import type { ConfigSchema } from '@ttylabs/sigil/config';
import { describe, expect, it } from 'vitest';

/** What a document reads as, through the store rather than through the mapping. */
function value(text: string, schema?: ConfigSchema): unknown {
  return xml(file(text), schema ? { schema } : {}).readSync().value;
}

describe('the mapping', () => {
  describe('one path space', () => {
    it('should put an attribute and a child element at the same kind of path', () => {
      // the whole of this package's design: a setting has one path whatever
      // spelling the document used, so an app reading `server.port` does not
      // have to know which one it was
      expect(value(`<config><server port="8080"><host>a</host></server></config>`)).toStrictEqual({
        server: { host: 'a', port: '8080' },
      });
    });

    it('should read the two spellings of one setting as the same path', () => {
      // which is the sentence the ticket asks for, as two documents
      const asAttr = value(`<config><server port="8080"/></config>`);
      const asChild = value(`<config><server><port>8080</port></server></config>`);
      expect(asAttr).toStrictEqual(asChild);
    });

    it('should refuse a name used as both an attribute and a child, naming the line', () => {
      // one path space has one value per name, so a document with two answers
      // for one setting is refused where it was written rather than resolved by
      // a precedence nobody will remember
      expect(() =>
        value(`<config>\n  <server port="1"><port>2</port></server>\n</config>`)
      ).toThrow(/:2: <server> sets "port" both as an attribute and as a child element/);
    });

    it('should refuse two children of one local name under different prefixes', () => {
      // the cost of a path not carrying a prefix. Grouping on the local name
      // alone would merge two namespaces into one array silently, which is the
      // same two-answers-for-one-name through the door `nameOf()` opens
      expect(() =>
        value(`<config xmlns:n="urn:x" xmlns:m="urn:y">\n  <n:a>1</n:a>\n  <m:a>2</m:a>\n</config>`)
      ).toThrow(/children called "a" under more than one namespace prefix/);
    });

    it('should refuse two attributes of one local name under different prefixes', () => {
      // a repeated *plain* attribute is a parse error before the mapping is
      // reached, so two prefixes is the only way to get here
      expect(() =>
        value(`<config xmlns:n="urn:x" xmlns:m="urn:y" n:mode="a" m:mode="b"/>`)
      ).toThrow(/two attributes called "mode" under different namespace prefixes/);
    });

    it('should read a prefixed name without its prefix', () => {
      expect(value(`<n:config xmlns:n="urn:x"><n:a>1</n:a></n:config>`)).toStrictEqual({ a: '1' });
    });

    it('should read a namespace declaration as no setting at all', () => {
      // `xmlns:n` has a `localName` of `n`, so matching by spelling rather than
      // by namespace URI would make every prefix declaration a config key
      expect(value(`<config xmlns="urn:d" xmlns:n="urn:x" mode="dev"/>`)).toStrictEqual({
        mode: 'dev',
      });
    });

    it('should read xml:space as no setting at all', () => {
      // the spec's own answer to whitespace, and so the attribute an author is
      // most likely to write here -- it would otherwise be a setting called
      // `space`
      expect(value(`<config xml:space="preserve" mode="dev"/>`)).toStrictEqual({ mode: 'dev' });
    });
  });

  describe('a leaf', () => {
    it('should be its text', () => {
      expect(value(`<config><host>example.com</host></config>`)).toStrictEqual({
        host: 'example.com',
      });
    });

    it('should read a CDATA section as its content', () => {
      expect(value(`<config><banner><![CDATA[<b>hi</b>]]></banner></config>`)).toStrictEqual({
        banner: '<b>hi</b>',
      });
    });

    it('should be trimmed, because whitespace around a value in XML is layout', () => {
      // a user who breaks a long description across lines means the words
      // rather than the indentation, and an untrimmed read gives every
      // pretty-printed leaf its surrounding newlines
      expect(value(`<config>\n  <desc>\n    some text\n  </desc>\n</config>`)).toStrictEqual({
        desc: 'some text',
      });
    });

    it('should trim an attribute too, so the two spellings agree about the value', () => {
      // trimming one and not the other is the format split this mapping exists
      // to refuse, one level in: the same path with two values
      const asAttr = value(`<config><server port=" 8080 "/></config>`);
      const asChild = value(`<config><server><port> 8080 </port></server></config>`);
      expect(asAttr).toStrictEqual({ server: { port: '8080' } });
      expect(asAttr).toStrictEqual(asChild);
    });

    it('should read an element with nothing in it as the empty string', () => {
      // which is what `set('host', '')` writes, so the round trip holds for the
      // value an app can actually set -- and is why `canRepresent()` refuses an
      // empty object, those being the same bytes
      expect(value(`<config><host/></config>`)).toStrictEqual({ host: '' });
    });

    it('should read an element holding only a comment as the empty string', () => {
      expect(value(`<config><host><!-- nothing --></host></config>`)).toStrictEqual({ host: '' });
    });
  });

  describe('mixed content', () => {
    it('should refuse text beside a child element, naming the line', () => {
      expect(() => value(`<config>\n  <name>Chris<title>Mr</title></name>\n</config>`)).toThrow(
        /:2: <name> has text beside its attributes or children/
      );
    });

    it('should refuse text beside an attribute, which is the same rule', () => {
      // a value for the element itself *and* a value for something named inside
      // it, with no path for the first. One rule rather than two
      expect(() => value(`<config>\n  <name sir="yes">Chris</name>\n</config>`)).toThrow(
        /:2: <name> has text beside its attributes or children/
      );
    });

    it('should not read whitespace as mixed content, which every document has', () => {
      expect(
        value(`<config>\n  <server port="1">\n    <host>a</host>\n  </server>\n</config>`)
      ).toStrictEqual({ server: { host: 'a', port: '1' } });
    });
  });

  describe('a list', () => {
    it('should read repeated siblings as an array at their own path', () => {
      expect(value(`<config><plugins>a</plugins><plugins>b</plugins></config>`)).toStrictEqual({
        plugins: ['a', 'b'],
      });
    });

    it('should put that array where the equivalent JSON puts it', () => {
      // the finding a review round reported as a format split, measured the
      // other way: `<plugins><plugin>a</plugin></plugins>` and
      // `{"plugins":["a"]}` are two different *documents*, and each format
      // spells each shape at the same path
      expect(
        value(`<config><plugins><plugin>a</plugin><plugin>b</plugin></plugins></config>`)
      ).toStrictEqual({ plugins: { plugin: ['a', 'b'] } });
    });

    it('should read a single occurrence as a scalar where nothing declared a list', () => {
      // the documented asymmetry, which is fast-xml-parser's answer and is what
      // the schema removes
      expect(value(`<config><plugins>a</plugins></config>`)).toStrictEqual({ plugins: 'a' });
    });

    it('should read a single occurrence as a list of one where the schema says multiple', () => {
      // without which a `multiple: true` setting over an XML layer throws
      // `Expected a list of values` on the **first load**, before anything is
      // written -- a real app failing to start
      expect(
        value(`<config><plugins>a</plugins></config>`, { plugins: { multiple: true } })
      ).toStrictEqual({ plugins: ['a'] });
    });

    it('should read an empty occurrence as an empty list where the schema says multiple', () => {
      // which is what makes `[] -> <plugins/> -> []` hold
      expect(value(`<config><plugins/></config>`, { plugins: { multiple: true } })).toStrictEqual({
        plugins: [],
      });
    });

    it('should leave a repeat alone where the schema says multiple', () => {
      expect(
        value(`<config><plugins>a</plugins><plugins>b</plugins></config>`, {
          plugins: { multiple: true },
        })
      ).toStrictEqual({ plugins: ['a', 'b'] });
    });

    it('should wrap an attribute at a multiple path, so the two spellings still agree', () => {
      // an attribute cannot repeat, so this is the single-occurrence case met
      // through the other spelling -- and refusing it here while wrapping the
      // element form would be the two spellings disagreeing again
      expect(value(`<config plugins="a"/>`, { plugins: { multiple: true } })).toStrictEqual({
        plugins: ['a'],
      });
    });

    it('should wrap at a nested multiple path', () => {
      // the path is built as the walk descends, so a read rooted at each
      // element would have called this one `tags`
      expect(
        value(`<config><server><tags>a</tags></server></config>`, {
          'server.tags': { multiple: true },
        })
      ).toStrictEqual({ server: { tags: ['a'] } });
    });

    it('should read a list of objects', () => {
      expect(value(`<config><plugin name="a"/><plugin name="b"/></config>`)).toStrictEqual({
        plugin: [{ name: 'a' }, { name: 'b' }],
      });
    });
  });

  describe('the document', () => {
    it('should not put the root element name in the path space', () => {
      // the root is the document, so `<cfg>` and `<settings>` hold the same
      // config -- which is what makes a store's format invisible to an app
      expect(value(`<cfg><a>1</a></cfg>`)).toStrictEqual(value(`<settings><a>1</a></settings>`));
    });

    it('should read a root with nothing in it as an empty config', () => {
      // and not as the empty string, which the leaf rule would say: without the
      // root rule, `<config/>` is refused for not holding an object and an app
      // whose config file exists and is empty cannot start
      expect(value(`<config/>`)).toStrictEqual({});
    });

    it('should refuse a root holding a scalar', () => {
      // merging it would make every key of every layer below it vanish, which
      // is the rule `json()` already keeps for a file holding `42`
      expect(() => value(`<config>text</config>`)).toThrow(/must hold an object/);
    });

    it('should read a file that is not there as an empty document', () => {
      // an absent config is the ordinary state of one
      expect(xml('/nonexistent/sigil-xml/config.xml').readSync()).toStrictEqual({ value: {} });
    });

    it('should read a file holding nothing as an empty document', () => {
      // `touch config.xml`, which XML needs saying for rather than falling out:
      // measured, both an empty string and a whitespace-only one throw
      // `missing root element`
      expect(value(``)).toStrictEqual({});
      expect(value(`  \n  `)).toStrictEqual({});
    });

    it('should read a file with a byte order mark', () => {
      // measured: `U+FEFF <a/>` parses, reports an error through `onError`, and
      // the mark survives into the output as a text node outside the root --
      // and `U+FEFF <?xml ...?>` **throws**, because the declaration is no
      // longer at position 0. Stripping it is what makes either readable
      expect(value(`\uFEFF<config><a>1</a></config>`)).toStrictEqual({ a: '1' });
      expect(value(`\uFEFF<?xml version="1.0"?><config><a>1</a></config>`)).toStrictEqual({
        a: '1',
      });
    });

    it('should refuse content outside the root that somebody really wrote', () => {
      // what is left reporting an error once the mark is off: it has no config
      // path, so it would be silently kept or silently dropped either way
      expect(() => value(`<config/>junk`)).toThrow(/Failed to parse/);
    });

    it('should refuse a document that will not parse, naming the file', () => {
      expect(() => value(`<config><a></config>`)).toThrow(/Failed to parse .*config\.xml/);
    });
  });
});
