import { xml } from '../src/index.js';
import { absent, file, read } from './helpers.js';
import { createConfigSync, json } from '@ttylabs/sigil/config';
import type { ConfigSchema } from '@ttylabs/sigil/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The README, asserted rather than described.
 *
 * The one arrangement that says something is the **expectation** read out of the
 * README and the **input** written here: the input is a copy of nothing, so it
 * has nothing to drift from, and the README's own block is then a claim about
 * what this store produces rather than about itself. Deriving the input from the
 * same place is how a document test becomes a test of nothing -- measured in the
 * runtime's own `readme.test.ts`, where four of five sabotages of a quoted block
 * survived.
 */
const readme = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf8');

/**
 * The nth fenced block of a language, as it is written.
 *
 * `''` is a block with no info string, which is what the three `path -> value`
 * listings are. The info string is trimmed because git checks a README out with
 * CRLF on Windows and the `\r` rides along with it -- the Conventions entry this
 * repository records five instances of, which the runtime's own `readme.test.ts`
 * met as `jsonc\r` matching no filter and four tests failing on three Windows
 * jobs and nowhere else.
 */
function fence(lang: string, nth = 0): string {
  const blocks = [...readme.matchAll(/```(\w*)[^\n]*\r?\n([\s\S]*?)```/g)]
    .filter((m) => (m[1] as string).trim() === lang)
    .map((m) => (m[2] as string).replaceAll('\r\n', '\n'));
  expect(blocks.length, `no "${lang}" block ${nth}`).toBeGreaterThan(nth);
  return blocks[nth] as string;
}

describe("the README's own claims", () => {
  it('should name every export', () => {
    // an export nobody can find is an export nobody uses. Read off the barrel so
    // a name added without a sentence fails here, which is the class rather than
    // the instance
    const barrel = readFileSync(join(import.meta.dirname, '../src/index.ts'), 'utf8');
    const names = new Set<string>();

    for (const block of barrel.matchAll(/^export (?:type )?\{([^}]*)\}/gm)) {
      for (const name of (block[1] as string).split(',')) {
        if (name.trim()) {
          names.add(name.trim());
        }
      }
    }

    expect(names.size).toBeGreaterThan(1);
    expect([...names].filter((name) => !readme.includes(name))).toStrictEqual([]);
  });

  it('should map the first example the way it says', () => {
    // the mapping block, which is the whole of the design: the XML is the first
    // `xml` fence and the three paths are the `text` fence after it
    const doc = fence('xml', 0);
    const paths = fence('', 0)
      .trim()
      .split('\n')
      .map((line) => line.split('->').map((half) => half.trim()) as [string, string]);

    expect(paths).toHaveLength(3);

    const config = createConfigSync({ layers: [{ name: 'f', store: xml(file(doc)) }] });
    for (const [path, want] of paths) {
      expect(config.get(path), path).toBe(want.replace(/^'|'$/g, ''));
    }
  });

  it('should break the precedence chain under a sentinel, which is the table', () => {
    // the table is the argument rather than an example, so what is asserted is
    // the behaviour it claims: one path, and the default reachable again once the
    // override goes
    const config = createConfigSync({
      layers: [
        { name: 'system', store: xml(file(`<config><server port="8080"/></config>`)) },
        { name: 'user', store: json(file(`{"server":{"port":9090}}`)) },
      ],
    });

    expect(config.get('server.port')).toBe(9090);
    config.delete('server.port', 'user');
    expect(config.get('server.port')).toBe('8080');
  });

  it('should refuse the collision it prints, with the message it prints', () => {
    const doc = fence('xml', 1);
    const shown = fence('', 1).trim();
    const path = file(doc.replace('<server', '<config>\n  <server').trimEnd() + '\n</config>');

    // the README shows the message with a placeholder path, so what is compared
    // is everything after the colon that follows it
    const said = shown.slice(shown.indexOf(': ') + 2);
    expect(() => xml(path).readSync()).toThrow(said);
  });

  it('should read the list example at the path it prints', () => {
    const doc = fence('xml', 2);
    const shown = fence('', 2).trim();
    const [path, want] = shown.split('->').map((half) => half.trim()) as [string, string];

    expect(path).toBe('plugins');
    expect(xml(file(doc)).readSync().value).toStrictEqual({
      [path]: JSON.parse(want.replaceAll("'", '"')),
    });
  });

  it('should change one key and leave every other byte identical, as the example says', () => {
    // the acceptance test, with the **expectation** read out of the README and
    // the edit written here
    const src = fence('xml', 3);
    const config = createConfigSync({ layers: [{ name: 'f', store: xml(file(src)) }] });
    const path = (config.layers[0] as { source?: string }).source as string;

    config.set('server.port', '9090');
    config.saveSync();

    expect(read(path)).toBe(src.replace('8080', '9090'));
  });

  it('should really lose every row of the residual table and no more', () => {
    // the table is a measurement, so a row that stopped being a residual -- or a
    // residual the table stopped naming -- is a README that lies about what a
    // write costs
    const rows = [
      [`<config><a></a></config>`, 'an empty paired tag'],
      [`<config a='1'/>`, 'a single-quoted attribute value'],
      [`<config a = "1"/>`, 'whitespace around an attribute'],
      [`<config><a>&#38;</a></config>`, 'a numeric character reference'],
      [`<config><a>&apos;</a></config>`, 'an apos reference'],
      [`<config><a>&quot;</a></config>`, 'a quot reference'],
      [`<config><a>1 > 2</a></config>`, 'a bare > in text'],
      [`<config a="1\n2"/>`, 'whitespace in an attribute value'],
      [`<config><a>1\u00852</a></config>`, 'NEL in text'],
    ] as const;

    for (const [doc, what] of rows) {
      expect(xml(file(doc)).readSync().wouldLose, what).toBeDefined();
    }

    // and the three the README says are **not** losses, because they are
    // detect-and-reapply rather than normalizations
    for (const doc of [
      `<config>\r\n  <a>1</a>\r\n</config>\r\n`,
      `﻿<config><a>1</a></config>`,
      `<config><a>1</a></config>\n`,
    ]) {
      expect(xml(file(doc)).readSync().wouldLose, doc).toBeUndefined();
    }
  });

  it('should refuse each thing it says XML cannot hold', () => {
    const store = xml(file(`<config/>`));
    const refuse = (value: unknown): string =>
      String((store.canRepresent as (v: unknown, p: string) => true | string)(value, 'x'));

    expect(refuse(null)).toContain('XML has no null');
    expect(refuse(undefined)).toContain('XML has no undefined');
    expect(refuse(() => 1)).toContain('function');
    expect(refuse(Symbol('x'))).toContain('symbol');
    expect(refuse(new Map())).toContain('Map');
    expect(refuse(' padded ')).toContain('trims');
    expect(refuse({})).toContain('empty object');
    expect(refuse([''])).toContain('empty string');
  });

  it('should take the options it documents, with the defaults it documents', () => {
    const table = readme.slice(readme.indexOf('| option'), readme.indexOf('Both are constructor'));
    expect(table).toContain('`root`');
    expect(table).toContain("`'config'`");
    expect(table).toContain('`schema`');

    const fresh = absent();
    xml(fresh).writeSync({ a: '1' });
    expect(read(fresh)).toContain('<config>');

    const named = absent();
    xml(named, { root: 'settings' }).writeSync({ a: '1' });
    expect(read(named)).toContain('<settings>');
  });

  it('should read an absent and a blank file as an empty document, as it says', () => {
    expect(xml(absent()).readSync().value).toStrictEqual({});
    expect(xml(file('   \n')).readSync().value).toStrictEqual({});
  });

  it('should need the schema for a multiple setting, which it calls not optional', () => {
    const schema: ConfigSchema = { plugins: { multiple: true } };
    const doc = `<config><plugins>a</plugins></config>`;

    // with it
    expect(
      createConfigSync({
        layers: [{ name: 'f', store: xml(file(doc), { schema }) }],
        schema,
      }).get('plugins')
    ).toStrictEqual(['a']);

    // and without it, which is the app failing to start that the README names
    expect(() =>
      createConfigSync({ layers: [{ name: 'f', store: xml(file(doc)) }], schema })
    ).toThrow(/Expected a list of values/);
  });

  it('should quote the orphan warning the way sigil check prints it', () => {
    // the one gap the README records, and what makes it checkable is that the
    // sentence is the toolchain's rather than this package's
    expect(readme).toContain('which nothing asks for; the English may have been reworded');
  });
});
