import {
  hasMarkdownCopy,
  markdownHref,
  prefersMarkdown,
  proxyAnswer,
} from '../src/lib/markdown-copy.ts';
import { SITE_URL } from '../src/lib/site.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * Where a docs page's Markdown copy is, and what the proxy does with a request
 * for it (SIG-267).
 */

const PRODUCTION = new URL(SITE_URL).host;
const PREVIEW = 'sigil-git-branch-ttylabs.vercel.app';

describe('prefersMarkdown', () => {
  it('should answer Markdown to a client that names it over HTML', () => {
    for (const accept of [
      'text/markdown',
      'text/markdown, text/html;q=0.9',
      'text/markdown, */*',
      'text/markdown;q=0.9, text/*;q=0.5',
      'text/html;q=0.5, text/markdown',
      'TEXT/MARKDOWN',
      'text/markdown; charset=utf-8',
    ]) {
      assert.equal(prefersMarkdown(accept), true, accept);
    }
  });

  it('should answer HTML to a browser, to nothing, and to a client that would rather', () => {
    for (const accept of [
      null,
      '',
      '*/*',
      'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'text/html, text/markdown',
      'text/html, text/markdown;q=0.1',
      'text/markdown;q=0.5, */*',
      'text/markdown;q=0',
      'application/json',
    ]) {
      assert.equal(prefersMarkdown(accept), false, String(accept));
    }
  });
});

describe('the Markdown address', () => {
  it('should be the page’s own, plus .md', () => {
    assert.equal(markdownHref('/docs/parser'), '/docs/parser.md');
    assert.equal(markdownHref('/docs/parser/'), '/docs/parser.md');
    assert.equal(markdownHref('/reference'), '/reference.md');
  });

  it('should exist for docs pages and nothing else, on a segment boundary', () => {
    for (const path of [
      '/docs/parser',
      '/docs/components/select',
      '/reference',
      '/reference/add',
    ]) {
      assert.equal(hasMarkdownCopy(path), true, path);
    }
    for (const path of ['/', '/examples', '/docs-archive', '/references']) {
      assert.equal(hasMarkdownCopy(path), false, path);
    }
  });
});

describe('proxyAnswer', () => {
  const ask = (pathname: string, host: string | null, accept: string | null = null) =>
    proxyAnswer({ pathname, host, accept });

  it('should refuse the rewrite’s destination when it is asked for by name', () => {
    for (const host of [PRODUCTION, PREVIEW]) {
      assert.ok('notFound' in ask('/md/docs/parser', host));
      assert.ok('notFound' in ask('/md', host));
    }
  });

  it('should serve the sitemap on the production host only', () => {
    assert.deepEqual(ask('/sitemap.xml', PRODUCTION), { pass: true });
    assert.ok('notFound' in ask('/sitemap.xml', PREVIEW));
    assert.ok('notFound' in ask('/sitemap.xml', null));
    assert.ok('notFound' in ask('/sitemap.xml', 'localhost:3000'));
  });

  // The corpus is the same documents every host already serves as HTML, so
  // hiding it off production hid nothing and only made it untestable.
  it('should serve the corpus on every host', () => {
    for (const path of [
      '/llms.txt',
      '/llms-full.txt',
      '/docs/parser.md',
      '/reference.md',
      '/reference/add.md',
    ]) {
      for (const host of [PRODUCTION, PREVIEW, 'localhost:3000', null]) {
        assert.deepEqual(ask(path, host), { pass: true }, `${path} on ${host}`);
      }
    }
  });

  it('should answer a docs page with its copy for a client that prefers Markdown, on any host', () => {
    for (const host of [PRODUCTION, PREVIEW, 'localhost:3000']) {
      assert.deepEqual(ask('/docs/parser', host, 'text/markdown'), { rewrite: '/md/docs/parser' });
      assert.deepEqual(ask('/reference/', host, 'text/markdown'), { rewrite: '/md/reference' });
    }
  });

  it('should answer HTML to a browser', () => {
    assert.deepEqual(ask('/docs/parser', PRODUCTION, '*/*'), { pass: true });
    assert.deepEqual(ask('/docs/parser', PREVIEW, 'text/html,*/*;q=0.8'), { pass: true });
  });

  it('should leave a page with no copy alone', () => {
    assert.deepEqual(ask('/examples', PRODUCTION, 'text/markdown'), { pass: true });
  });
});
