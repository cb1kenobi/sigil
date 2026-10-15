import { lossesOf } from '../src/fidelity.js';
import { xml } from '../src/index.js';
import { file } from './helpers.js';
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
      expect(kinds(`<config><a>&quot;</a></config>`)).toContain('formatting');
    });

    it('should report an empty paired tag', () => {
      expect(kinds(`<config><a></a></config>`)).toStrictEqual(['formatting']);
    });

    it('should report a single-quoted attribute value', () => {
      expect(kinds(`<config a='1'/>`)).toContain('formatting');
    });

    it('should report whitespace around an attribute’s =', () => {
      expect(kinds(`<config a = "1"/>`)).toContain('formatting');
    });

    it('should report a numeric character reference', () => {
      expect(kinds(`<config><a>&#38;</a></config>`)).toContain('formatting');
    });

    it('should report an &apos; reference', () => {
      expect(kinds(`<config><a>&apos;</a></config>`)).toContain('formatting');
    });

    it('should report a bare > in text', () => {
      expect(kinds(`<config><a>1 > 2</a></config>`)).toContain('formatting');
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
      const path = file(`<config>\n  <a></a>\n</config>\n`);
      const config = createConfigSync({ layers: [{ name: 'f', store: xml(path) }] });
      config.set('a', '1');
      expect(() => config.saveSync({ lossy: true })).not.toThrow();
    });

    it('should write without being asked where the document loses nothing', () => {
      const path = file(`<config>\n  <a>0</a>\n</config>\n`);
      const config = createConfigSync({ layers: [{ name: 'f', store: xml(path) }] });
      config.set('a', '1');
      expect(() => config.saveSync()).not.toThrow();
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
