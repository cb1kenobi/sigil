import {
  buildSymbolTable,
  lookupSymbols,
  type SymbolPayload,
} from '../src/components/search/symbols.ts';
import { searchRecords } from '../src/lib/search-records.ts';
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

/**
 * A small corpus in the reference's own shape: names shared across commands, and a root.
 *
 * The names are fixtures and not a copy of `sigil new`'s options: `--js` is not a real
 * option any more (`--lang` replaced it), but the tests below need two names a slip
 * apart, `--js` and `--json`, so the corpus keeps them.
 */
const payload: SymbolPayload = {
  s: [
    ['sigil', '/reference'],
    ['sigil build', '/reference/build', 'Build an app into a bundle'],
    ['sigil build --out', '/reference/build#--out', 'Where the bundle goes'],
    ['sigil build --name', '/reference/build#--name'],
    ['sigil package', '/reference/package', 'Build an app and compile it'],
    ['sigil package --out', '/reference/package#--out', 'Where the binaries go'],
    ['sigil package --name', '/reference/package#--name'],
    ['sigil new', '/reference/new'],
    ['sigil new --single', '/reference/new#--single', 'One command'],
    ['sigil new --js', '/reference/new#--js'],
    ['sigil new --json', '/reference/new#--json'],
  ],
};
const table = buildSymbolTable(payload);
const top = (q: string) => lookupSymbols(table, q, 5)[0];
const titles = (q: string) => lookupSymbols(table, q, 8).map((hit) => hit.title);

describe('symbol lookup', () => {
  test('an exact name wins outright', () => {
    const hit = top('sigil package');
    assert.equal(hit?.title, 'sigil package');
    assert.equal(hit?.rule, 'exact');
    assert.equal(hit?.url, '/reference/package');
  });

  test('a bare last word resolves every name ending in it, shortest first', () => {
    assert.deepEqual(titles('--out'), ['sigil build --out', 'sigil package --out']);
    assert.equal(top('--out')?.rule, 'segment');
    assert.equal(top('package')?.title, 'sigil package');
  });

  test('an option matches with or without its dashes, as the parser keys it', () => {
    assert.deepEqual(titles('out'), titles('--out'));
    assert.equal(top('single')?.title, 'sigil new --single');
  });

  test('every word must begin a word of the name, so a command narrows a shared option', () => {
    assert.deepEqual(titles('package --out'), ['sigil package --out']);
    assert.equal(top('package --out')?.rule, 'tokens');
    assert.deepEqual(titles('new j'), ['sigil new --js', 'sigil new --json']);
  });

  test('a typo lands, which is what Pagefind cannot do', () => {
    const hit = top('--singel');
    assert.equal(hit?.title, 'sigil new --single');
    assert.equal(hit?.rule, 'fuzzy');
    assert.equal(top('biuld')?.title, 'sigil build');
    assert.equal(top('nwe')?.title, 'sigil new');
  });

  test('a typo of a shared option lists every command that has it, one answer', () => {
    assert.deepEqual(titles('--uot'), ['sigil build --out', 'sigil package --out']);
  });

  test('a typo still has to fit the other words', () => {
    assert.deepEqual(titles('package --uot'), ['sigil package --out']);
  });

  test('two names equally near is no fuzzy answer, as in the CLI', () => {
    // `jsn` is one slip from `js` and from `json`, which nearMiss() calls a tie
    assert.deepEqual(titles('--jsn'), []);
  });

  test('carries the summary for the line under a top match', () => {
    assert.equal(top('--out')?.summary, 'Where the bundle goes');
    assert.equal(top('--name')?.summary, undefined);
  });

  test('returns nothing for prose, which is Pagefind’s half', () => {
    assert.deepEqual(lookupSymbols(table, 'bundle that depends on nothing', 5), []);
    assert.deepEqual(lookupSymbols(table, '   ', 5), []);
    assert.deepEqual(lookupSymbols(table, '--', 5), []);
  });

  test('respects the limit', () => {
    assert.equal(lookupSymbols(table, 'sigil', 2).length, 1);
    assert.equal(lookupSymbols(table, '--out', 1).length, 1);
  });
});

describe('symbol lookup over the real reference', () => {
  // what `scripts/generate-symbol-index.ts` writes, built in memory
  const real = buildSymbolTable({
    s: searchRecords()
      .filter((record) => record.symbol)
      .map((record) => [record.title, record.url, record.summary]),
  });

  test('finds the identifiers the ticket names', () => {
    assert.equal(lookupSymbols(real, '--single')[0]?.url, '/reference/new#--single');
    assert.equal(lookupSymbols(real, '--singel')[0]?.url, '/reference/new#--single');
    assert.equal(lookupSymbols(real, 'sigil package')[0]?.url, '/reference/package');
    const out = lookupSymbols(real, '--out').map((hit) => hit.title);
    assert.ok(out.includes('sigil build --out') && out.includes('sigil package --out'));
  });
});
