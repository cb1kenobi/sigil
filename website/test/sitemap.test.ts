import { COMPONENTS, componentHref } from '../src/lib/components.ts';
import { markdownPages } from '../src/lib/guides.ts';
import { ABOUT_HREF } from '../src/lib/nav.ts';
import { referenceDocs, referenceHref } from '../src/lib/reference.ts';
import { robotsRules } from '../src/lib/seo.ts';
import { SITE_URL } from '../src/lib/site.ts';
import { sitemapEntries } from '../src/lib/sitemap.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The invariants, over the real pages rather than a fixture.
 *
 * A sitemap is wrong in ways that never throw: a duplicate, a relative URL, a
 * page that is not there. None of those break a build and all of them cost
 * traffic, so they are asserted here rather than reviewed by eye.
 */

const entries = sitemapEntries();
const urls = entries.map((entry) => entry.url);

describe('the sitemap', () => {
  it('should be absolute, on the production origin, and free of duplicates', () => {
    for (const url of urls) {
      assert.equal(url === SITE_URL || url.startsWith(`${SITE_URL}/`), true, url);
    }
    assert.equal(new Set(urls).size, urls.length);
  });

  it('should list the home page, the components index and the reference index', () => {
    assert.equal(urls.includes(SITE_URL), true);
    assert.equal(urls.includes(`${SITE_URL}/docs/components`), true);
    assert.equal(urls.includes(`${SITE_URL}/reference`), true);
  });

  it('should list exactly the reference pages the site links to, each at its own address', () => {
    const listed = urls.filter((url) => url.startsWith(`${SITE_URL}/reference`)).toSorted();
    const wanted = referenceDocs()
      .map((doc) => `${SITE_URL}${referenceHref(doc.slug)}`)
      .toSorted();

    assert.notEqual(wanted.length, 0);
    assert.deepEqual(listed, wanted);
  });

  it('should list every component page, at the address the index links to', () => {
    const listed = urls.filter((url) => url.startsWith(`${SITE_URL}/docs/components/`)).toSorted();
    const wanted = COMPONENTS.map((entry) => `${SITE_URL}${componentHref(entry.slug)}`).toSorted();

    assert.notEqual(wanted.length, 0);
    assert.deepEqual(listed, wanted);
  });

  it('should list exactly the guides and About the site renders, each at its own address', () => {
    const listed = urls
      .filter((url) => url.startsWith(`${SITE_URL}/docs/`))
      .filter((url) => !url.startsWith(`${SITE_URL}/docs/components`))
      .toSorted();
    const wanted = markdownPages()
      .map((page) => `${SITE_URL}/docs/${page.slug}`)
      .toSorted();

    assert.notEqual(wanted.length, 0);
    assert.ok(wanted.includes(`${SITE_URL}${ABOUT_HREF}`));
    assert.deepEqual(listed, wanted);
  });

  it('should not list the /docs redirect', () => {
    assert.equal(urls.includes(`${SITE_URL}/docs`), false);
  });

  it('should list the root command once, at /reference and not at /reference/index', () => {
    assert.equal(urls.includes(`${SITE_URL}/reference/index`), false);
  });

  it('should carry a date only where it is a real one', () => {
    for (const entry of entries) {
      if (entry.lastModified !== undefined) {
        assert.match(String(entry.lastModified), /^\d{4}-\d{2}-\d{2}$/, entry.url);
      }
    }
  });

  it('should list nothing robots.txt blocks', () => {
    // contradictory instructions, and a crawler handed both trusts neither
    const rules = robotsRules(true).rules;
    const disallow = [rules].flat().flatMap((rule) => [rule.disallow ?? []].flat());

    for (const url of urls) {
      const path = url.slice(SITE_URL.length) || '/';
      assert.equal(
        disallow.some((prefix) => prefix !== '' && path.startsWith(prefix)),
        false,
        path
      );
    }
  });

  it('should leave the sitemap out of itself', () => {
    assert.equal(urls.includes(`${SITE_URL}/sitemap.xml`), false);
  });
});
