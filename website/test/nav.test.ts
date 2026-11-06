import { NAV_ITEMS, activeSection, isDocsPath } from '../src/lib/nav.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('the current section', () => {
  it('should be Docs on getting started and on any other docs page', () => {
    assert.equal(activeSection('/docs/getting-started'), 'docs');
    assert.equal(activeSection('/docs/parser/options'), 'docs');
    assert.equal(activeSection('/docs/about'), 'docs');
    assert.equal(activeSection('/docs'), 'docs');
  });

  it('should be Components under /docs/components, and not Docs as well', () => {
    assert.equal(activeSection('/docs/components'), 'components');
    assert.equal(activeSection('/docs/components/spinner'), 'components');
  });

  it('should be CLI for the command reference and its pages', () => {
    assert.equal(activeSection('/reference'), 'cli');
    assert.equal(activeSection('/reference/add'), 'cli');
  });

  it('should be Examples for the examples page', () => {
    assert.equal(activeSection('/examples'), 'examples');
    assert.equal(activeSection('/examples/spinner'), 'examples');
  });

  it('should be none on the home page and on a page outside every section', () => {
    assert.equal(activeSection('/'), undefined);
    assert.equal(activeSection('/nope'), undefined);
  });

  it('should match on a path segment, not on a prefix', () => {
    assert.equal(activeSection('/docs-archive'), undefined);
    assert.equal(activeSection('/references'), undefined);
    assert.equal(activeSection('/docs/components-old'), 'docs');
    assert.equal(activeSection('/examples2'), undefined);
  });

  it('should ignore a trailing slash', () => {
    assert.equal(activeSection('/docs/components/'), 'components');
    assert.equal(activeSection('/reference/'), 'cli');
  });

  it('should be reachable from every nav item, and from no two', () => {
    for (const item of NAV_ITEMS) {
      assert.equal(activeSection(item.href), item.section, item.href);
    }
    assert.equal(new Set(NAV_ITEMS.map((item) => item.section)).size, NAV_ITEMS.length);
  });
});

describe('the header width', () => {
  it('should follow the docs layout for docs pages and no others', () => {
    assert.equal(isDocsPath('/docs/getting-started'), true);
    assert.equal(isDocsPath('/docs/components/spinner'), true);
    assert.equal(isDocsPath('/'), false);
    assert.equal(isDocsPath('/reference'), false);
    assert.equal(isDocsPath('/examples'), false);
    assert.equal(isDocsPath('/docs-archive'), false);
  });
});
