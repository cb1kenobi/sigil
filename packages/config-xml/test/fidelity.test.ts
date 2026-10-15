import { lossesOf } from '../src/fidelity.js';
import { xml } from '../src/index.js';
import { file, read } from './helpers.js';
import type { Loss } from '@ttylabs/sigil/config';
import { createConfigSync } from '@ttylabs/sigil/config';
import { describe, expect, it } from 'vitest';

/** What a write of this document would lose. */
function losses(text: string): readonly Loss[] | undefined {
  return xml(file(text)).readSync().wouldLose;
}

/** The kinds, so a test can name what it means rather than a whole sentence. */
function kinds(text: string): string[] {
  return (losses(text) ?? []).map((it) => it.kind);
}

/**
 * What each loss says, and where.
 *
 * Asserted rather than the **kind**, which every row of one kind shares with
 * the unexplained-difference fallback -- so `kinds(...).toContain('formatting')`
 * held for a document whose row was missing, which is how `&quot;` came to have
 * a test and no row. Found by review round 2, and it was true of all six
 * `formatting` rows rather than that one.
 */
function said(text: string): string[] {
  return (losses(text) ?? []).map((it) => `${it.kind}:${it.detail}@${String(it.line)}`);
}

describe('what a write would lose', () => {
  describe('asked of the document rather than of the format', () => {
    it('should be absent for a document that round-trips', () => {
      // `WriteOptions.lossy`'s own rule, and this is the store it was written
      // for: a DOM store writing a file with no trivia in it loses nothing, and
      // refusing that write would be a guard firing on correct code.
      //
      // **Absent** rather than `[]`, which is how `layer.wouldLose?.length`
      // reads it and is what makes `layer.wouldLose.length` a `TypeError`
      expect(losses(`<config><a>1</a></config>`)).toBeUndefined();
    });

    it('should be absent for a comment-rich document, which is the whole point', () => {
      // six of the eight losses a reprinting writer has come through untouched
      expect(
        losses(
          `<?xml version="1.0" encoding="UTF-8"?>\n<!-- top -->\n<!DOCTYPE config>\n<config mode="dev">\n  <!-- inner -->\n  <banner><![CDATA[<b>&</b>]]></banner>\n</config>\n`
        )
      ).toBeUndefined();
    });

    it('should be absent for a CRLF document, which is detect-and-reapply', () => {
      // the contradiction a review round found: CRLF is in the residual table
      // *and* in the reapply, so a check run on the raw serialize reports a
      // loss every CRLF config does not actually suffer and refuses unless
      // somebody said `lossy`. `reshape()` runs first and then this compares
      expect(losses(`<config>\r\n  <a>1</a>\r\n</config>\r\n`)).toBeUndefined();
    });

    it('should be absent for a document with no trailing newline', () => {
      expect(losses(`<config><a>1</a></config>`)).toBeUndefined();
    });

    it('should be absent for a carriage-return-only document, and for a blank last line', () => {
      // both found by probing: each reported a loss it need not suffer, which is
      // the guard firing on correct code this whole check is written against
      expect(losses(`<config>\r  <a>1</a>\r</config>\r`)).toBeUndefined();
      expect(losses(`<config><a>1</a></config>\n\n`)).toBeUndefined();
      expect(losses(`<config><a>1</a></config>\r\n`)).toBeUndefined();
    });

    it('should report a document whose line endings really are mixed', () => {
      // which genuinely changes, so it is a loss rather than a reapply
      expect(losses(`<config>\n  <a>1</a>\r\n</config>\n`)).toBeDefined();
    });

    it('should be absent for a document with a byte order mark', () => {
      expect(losses(`\uFEFF<config><a>1</a></config>`)).toBeUndefined();
    });

    it('should be absent for a prefixed document', () => {
      expect(losses(`<n:config xmlns:n="urn:x"><n:a>1</n:a></n:config>`)).toBeUndefined();
    });
  });

  describe('the residual, each measured against this serializer', () => {
    it('should refuse an internal DTD entity reference rather than reporting it', () => {
      // a review round named this as the residual that matters, and it is not a
      // loss case at all: measured, `@xmldom/xmldom` reports `entity not found`
      // at the `error` level, so the document is refused where it was written.
      // Which is the stronger answer, because the loss is not cosmetic -- the
      // parser cannot expand the entity, so the *value* would be the four
      // characters `&e;` where the document says `hi`
      expect(() =>
        kinds(`<!DOCTYPE config [<!ENTITY e "hi">]><config><a>&e;</a></config>`)
      ).toThrow(/entity not found/);
    });

    it('should leave a declaration nothing references alone', () => {
      // so a document is refused for the *reference* rather than for the
      // DOCTYPE, which is what keeps a DOCTYPE-bearing config readable
      expect(
        losses(`<!DOCTYPE config [<!ENTITY e "hi">]><config><a>x</a></config>`)
      ).toBeUndefined();
    });

    it('should report a named reference for a quote', () => {
      // both spellings, which the table has always claimed and the row did not
      expect(said(`<config>\n  <a>&quot;</a>\n</config>`)).toStrictEqual([
        'formatting:an &apos; or &quot; reference is rewritten as a literal quote@2',
      ]);
    });

    it('should report an empty paired tag', () => {
      expect(said(`<config>\n  <a></a>\n</config>`)).toStrictEqual([
        'formatting:an empty paired tag becomes self-closing@2',
      ]);
    });

    it('should report a single-quoted attribute value', () => {
      expect(said(`<config>\n  <a b='1'/>\n</config>`)).toStrictEqual([
        'formatting:a single-quoted attribute value is rewritten with double quotes@2',
      ]);
    });

    it('should report whitespace around an attribute’s =', () => {
      expect(said(`<config>\n  <a b = "1"/>\n</config>`)).toStrictEqual([
        'formatting:whitespace around an attribute’s = is dropped@2',
      ]);
    });

    it('should report a numeric character reference', () => {
      expect(said(`<config>\n  <a>&#38;</a></config>`)).toStrictEqual([
        'formatting:a numeric character reference is rewritten by name@2',
      ]);
    });

    it('should report an &apos; reference', () => {
      expect(said(`<config>\n  <a>&apos;</a>\n</config>`)).toStrictEqual([
        'formatting:an &apos; or &quot; reference is rewritten as a literal quote@2',
      ]);
    });

    it('should report a bare > in text', () => {
      expect(said(`<config>\n  <a>1 > 2</a>\n</config>`)).toStrictEqual([
        'formatting:a bare > in text is escaped@2',
      ]);
    });

    describe('matched against element content rather than the whole source', () => {
      // every row but one misfired inside a comment or a CDATA section, each
      // naming a `kind`, a `detail` and a `line` that sends the author to a
      // construct with nothing wrong with it -- which is worse than no table,
      // since the table is the whole of what makes the message actionable.
      // Review round 2 reported one of the seven and measuring it found the
      // rest. Each document holds one **real** loss plus a comment holding
      // what a row looks for, so a misfire is a second entry
      const real = 'formatting:an empty paired tag becomes self-closing@3';

      it.each([
        ['a bare >', 'a > b'],
        ['an &apos;', 'it &apos;s'],
        ['a &quot;', 'say &quot;hi&quot;'],
        ['a numeric reference', '&#65;'],
        ['a single-quoted attribute', `x='1'`],
        ['whitespace around an =', 'x = 1'],
        ['an empty paired tag', '<z></z>'],
      ])('should not report %s inside a comment', (_what, held) => {
        expect(said(`<!-- ${held} -->\n<config>\n  <a></a>\n</config>`)).toStrictEqual([real]);
      });

      it.each([
        ['an &apos;', '&apos;'],
        ['a bare >', '1 > 0'],
      ])('should not report %s inside a CDATA section', (_what, held) => {
        expect(
          said(`<config>\n  <keep><![CDATA[${held}]]></keep>\n  <a></a>\n</config>`)
        ).toStrictEqual([real]);
      });

      it('should report the whitespace in a single-quoted attribute too', () => {
        // the row hardcoded `="`, so a single-quoted attribute reported the
        // quote rewrite and not the normalization -- which is the half that
        // matters, since it is required of every conforming parser. Both are
        // true of this document and both are reported
        expect(said(`<config>\n  <a b='x\ty'/>\n</config>`)).toStrictEqual([
          'formatting:a single-quoted attribute value is rewritten with double quotes@2',
          'spec:whitespace in an attribute value is normalized to a space, which the XML spec requires@2',
        ]);
      });

      it('should not read a DOCTYPE internal subset as a bare > in text', () => {
        // arbitrary markup, so `<!ELEMENT a (#PCDATA)>` read as one
        // two declarations rather than one, so that a scan ending at the
        // **first** `>` leaves the rest of the subset unblanked -- with one,
        // what is left is `]>` and the pattern needs a second `>` before the
        // next `<`, so a single-declaration subset cannot tell the two apart
        expect(
          said(
            `<!DOCTYPE config [<!ELEMENT a (#PCDATA)><!ELEMENT b (#PCDATA)>]>\n<config>\n  <a></a>\n</config>`
          )
        ).toStrictEqual([real]);
      });

      it('should not read a > in a DOCTYPE system literal as one in text', () => {
        // a quoted literal may hold one and an internal subset may hold
        // several, so the first `>` closes neither -- which made a document
        // with a real loss report a second, spurious one at line 1
        expect(
          said(`<!DOCTYPE config SYSTEM "a>b>c.dtd">\n<config>\n  <a></a>\n</config>`)
        ).toStrictEqual([real]);
      });

      it('should not read a > in an internal subset literal as one in text', () => {
        expect(
          said(`<!DOCTYPE c [<!ENTITY x "a>b>c">]>\n<config>\n  <a></a>\n</config>`)
        ).toStrictEqual([real]);
      });

      it('should end a DOCTYPE at its own > rather than running on', () => {
        // the other direction: what follows the declaration is content, so a
        // row has to be able to match there
        expect(said(`<!DOCTYPE config>\n<config>\n  <a>1 > 2</a>\n</config>`)).toStrictEqual([
          'formatting:a bare > in text is escaped@3',
        ]);
      });

      it('should report a NEL inside a comment, which really is normalized', () => {
        // the one row matched against the raw source: a comment holding a NEL
        // comes back holding a newline, so blanking it would suppress a true
        // positive. Which is why this is per row rather than one rule
        expect(said(`<!-- a\u0085b -->\n<config>\n  <a></a>\n</config>`)).toStrictEqual([
          real,
          'spec:NEL is normalized to a newline, which the XML spec requires@1',
        ]);
      });

      it('should point at the real one rather than the one in a comment', () => {
        // the line is the source's either way, which is what the blanking
        // keeps the newlines for
        expect(said(`<!-- <z></z> -->\n<config>\n  <a>1</a>\n  <b></b>\n</config>`)).toStrictEqual([
          'formatting:an empty paired tag becomes self-closing@4',
        ]);
      });
    });

    it('should report attribute-value whitespace as the spec’s rather than ours', () => {
      // required of every conforming parser, so a reader who hits one is
      // reading a document whose own bytes no conforming tool would preserve
      expect(kinds(`<config a="1\n2"/>`)).toStrictEqual(['spec']);
      expect(kinds(`<config a="1\t2"/>`)).toStrictEqual(['spec']);
    });

    it('should report NEL in text as the spec’s', () => {
      expect(kinds(`<config><a>1\u00852</a></config>`)).toStrictEqual(['spec']);
    });

    it('should say something for a difference the table has not met', () => {
      // the table is what makes a message actionable rather than what makes the
      // answer true, so a normalization nothing above names is still reported.
      // Asked of `lossesOf()` directly, because a document that differs and
      // matches no pattern is one this table does not know how to build -- the
      // branch is a tripwire for a serializer that grows a normalization, and a
      // test over the store could only reach it by predicting one
      expect(lossesOf('<a>x</a>', '<a>y</a>')).toStrictEqual([
        {
          detail: 'the document does not survive a round trip through this parser unchanged',
          kind: 'formatting',
        },
      ]);
    });

    it('should name a line a report can point at', () => {
      const found = losses(`<config>\n  <a></a>\n</config>`);
      expect(found?.[0]?.line).toBe(2);
    });
  });

  describe('what the lossless rule does with it', () => {
    it('should refuse a write to a document that would lose something', () => {
      const path = file(`<config>\n  <a></a>\n</config>\n`);
      const config = createConfigSync({ layers: [{ name: 'f', store: xml(path) }] });
      config.set('a', '1');
      expect(() => config.saveSync()).toThrow(/would be lost/);
    });

    it('should write it anyway where the caller said lossy', () => {
      // and **what** it wrote, rather than only that it did not throw: a save
      // that silently did nothing satisfies a `not.toThrow` just as well, which
      // is the shape this package has already had four of
      const path = file(`<config>\n  <a></a>\n</config>\n`);
      const config = createConfigSync({ layers: [{ name: 'f', store: xml(path) }] });
      config.set('a', '1');

      config.saveSync({ lossy: true });

      expect(read(path)).toBe(`<config>\n  <a>1</a>\n</config>\n`);
    });

    it('should write without being asked where the document loses nothing', () => {
      const path = file(`<config>\n  <a>0</a>\n</config>\n`);
      const config = createConfigSync({ layers: [{ name: 'f', store: xml(path) }] });
      config.set('a', '1');

      config.saveSync();

      expect(read(path)).toBe(`<config>\n  <a>1</a>\n</config>\n`);
    });
  });

  describe('what it cannot see, which is stated rather than guarded', () => {
    it('should not claim to bound what a set will do', () => {
      // a read-time round trip answers "would re-serializing this document as
      // it stands lose anything", which is not a bound on an edit. The two
      // edit-induced losses are closed in `write.ts` rather than reported here
      // -- an unprefixed insert by `createElementNS`, a CDATA section written
      // over by diffing first -- because a loss a store can avoid is one it
      // should avoid rather than report
      const path = file(`<n:config xmlns:n="urn:x"><n:a>1</n:a></n:config>`);
      expect(xml(path).readSync().wouldLose).toBeUndefined();
      xml(path).writeSync({ a: '1', b: '2' });
      expect(xml(path).readSync().value).toStrictEqual({ a: '1', b: '2' });
    });
  });
});
