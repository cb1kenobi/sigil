import { guides } from '../src/lib/guides.ts';
import { headingsOf, parseMarkdown } from '../src/lib/markdown-doc.ts';
import { guideHref } from '../src/lib/nav.ts';
import { optionNames, optionRows, remarkOptionAnchors } from '../src/lib/reference-options.ts';
import { referenceDocs, referenceHref } from '../src/lib/reference.ts';
import { searchRecords } from '../src/lib/search-records.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Search is only as good as where a result lands. Every record's URL has to be
 * a page the site renders and, where it has a fragment, an anchor that page
 * draws -- and the records have to cover what the ticket says to index.
 */

const records = searchRecords();

/** Every anchor a page draws: its headings, and on a reference page its option rows. */
function anchorsOf(source: string, reference: boolean): Set<string> {
  const tree = parseMarkdown(source);
  const ids = headingsOf(tree).map((heading) => heading.id);

  if (reference) {
    remarkOptionAnchors()(tree);
    for (const row of optionRows(tree)) {
      ids.push(String(row.node.data?.hProperties?.id));
    }
  }

  return new Set(ids);
}

const pages = new Map<string, Set<string>>([
  ...guides().map((g) => [guideHref(g.slug), anchorsOf(g.source, false)] as const),
  ...referenceDocs().map((d) => [referenceHref(d.slug), anchorsOf(d.body, true)] as const),
]);

describe('search records', () => {
  it('should give every record a URL of its own', () => {
    assert.equal(new Set(records.map((r) => r.url)).size, records.length);
  });

  it('should link every record to a page the site renders, at an anchor it draws', () => {
    for (const record of records) {
      const [path, fragment] = record.url.split('#') as [string, string | undefined];
      const anchors = pages.get(path);
      assert.ok(anchors, `${record.url}: no such page`);
      if (fragment !== undefined) {
        assert.ok(anchors.has(fragment), `${record.url}: no such anchor`);
      }
    }
  });

  it('should index every command and every option of the reference', () => {
    for (const doc of referenceDocs()) {
      const href = referenceHref(doc.slug);
      assert.ok(
        records.some((r) => r.url === href && r.kind === 'command'),
        href
      );
      for (const row of optionRows(parseMarkdown(doc.body))) {
        const option = records.find((r) => r.url === `${href}#${row.name}`);
        assert.equal(option?.kind, 'option', `${href} ${row.name}`);
        assert.equal(option?.title, `${doc.title} ${row.name}`);
      }
    }
  });

  it('should index every section of the guides at its own anchor', () => {
    for (const guide of guides()) {
      const href = guideHref(guide.slug);
      assert.ok(
        records.some((r) => r.url === href && r.title === guide.title),
        href
      );
      for (const section of guide.sections) {
        const record = records.find((r) => r.url === `${href}#${section.id}`);
        assert.equal(record?.kind, 'guide', `${href}#${section.id}`);
        assert.equal(record?.title, section.text);
        assert.equal(record?.page, guide.title);
      }
    }
  });

  it('should lead every body with the title, which is what makes a name match outrank prose', () => {
    for (const record of records) {
      assert.ok(record.body.startsWith(record.title), record.url);
    }
  });

  it('should keep a fence out of a section and an option table out of its command', () => {
    const build = records.find((r) => r.url === '/reference/build');
    assert.ok(build && !build.body.includes('sigil build [options]'), 'the usage fence');
    assert.ok(build && !build.body.includes('Keep what is already in the output directory'));
  });

  it('should mark the commands and options as names and nothing else', () => {
    for (const record of records) {
      assert.equal(record.symbol === true, record.kind !== 'guide', record.url);
    }
  });
});

describe('an option row', () => {
  it('should be known by its long name, with its other spellings as aliases', () => {
    assert.deepEqual(optionNames('--out [dir]'), { name: '--out', aliases: [] });
    assert.deepEqual(optionNames('-y, --yes'), { name: '--yes', aliases: ['-y'] });
    assert.deepEqual(optionNames('--lint [oxlint|eslint]'), { name: '--lint', aliases: [] });
    assert.deepEqual(optionNames('-v'), { name: '-v', aliases: [] });
    assert.equal(optionNames('[dir]'), undefined);
  });

  it('should be drawn with its name as its anchor, clear of the sticky header', () => {
    const tree = parseMarkdown(
      '## Options\n\n| Option | Type | Description |\n| --- | --- | --- |\n| `--out [dir]` | `string` | Where |\n'
    );
    remarkOptionAnchors()(tree);
    const [row] = optionRows(tree);
    assert.equal(row?.node.data?.hProperties?.id, '--out');
    assert.ok(String(row?.node.data?.hProperties?.className).includes('scroll-mt-24'));
  });

  it('should leave a table that is not a list of options alone', () => {
    const tree = parseMarkdown(
      '| Argument | Type |\n| --- | --- |\n| `[dir]` | `string` |\n\n| Option | Type |\n| --- | --- |\n| prose | x |\n'
    );
    assert.deepEqual(optionRows(tree), []);
  });
});
