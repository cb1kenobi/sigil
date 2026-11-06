import { jsonLd, pageMetadata, robotsRules, softwareSourceCode } from '../src/lib/seo.ts';
import { REPO_URL, SITE_URL } from '../src/lib/site.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('pageMetadata', () => {
  const meta = pageMetadata({
    path: '/reference/build',
    title: 'sigil build',
    description: 'Build an app.',
  });

  it('should make the tab, the search result and both cards say the same thing', () => {
    assert.equal(meta.title, 'sigil build');
    assert.equal(meta.description, 'Build an app.');
    assert.equal(meta.openGraph?.title, 'sigil build · sigil');
    assert.equal(meta.twitter?.title, 'sigil build · sigil');
    assert.equal(meta.openGraph?.description, 'Build an app.');
    assert.equal(meta.twitter?.description, 'Build an app.');
  });

  it('should point the canonical and the card at the same path', () => {
    assert.equal(meta.alternates?.canonical, '/reference/build');
    assert.equal(meta.openGraph?.url, '/reference/build');
  });

  it('should carry the site-wide Open Graph fields, because a route replaces its parent’s object', () => {
    assert.equal(meta.openGraph?.siteName, 'sigil');
    assert.equal((meta.openGraph as { type?: string }).type, 'website');
  });

  it('should leave the home page’s title to the layout’s default', () => {
    const home = pageMetadata({ path: '/', description: 'x' });
    assert.equal('title' in home, false);
    assert.equal(home.openGraph?.title, 'sigil: command-line apps in TypeScript');
  });
});

describe('robotsRules', () => {
  it('should allow everything on the production host and name the sitemap', () => {
    assert.deepEqual(robotsRules(true), {
      rules: { userAgent: '*', allow: '/' },
      sitemap: `${SITE_URL}/sitemap.xml`,
    });
  });

  it('should disallow everything elsewhere and offer no sitemap', () => {
    const rules = robotsRules(false);
    assert.deepEqual(rules.rules, { userAgent: '*', disallow: '/' });
    assert.equal(rules.sitemap, undefined);
  });
});

describe('softwareSourceCode', () => {
  const data = softwareSourceCode() as Record<string, string>;

  it('should name the repository and the licence', () => {
    assert.equal(data['@type'], 'SoftwareSourceCode');
    assert.equal(data.codeRepository, REPO_URL);
    assert.equal(data.license, 'https://spdx.org/licenses/MIT.html');
  });

  it('should use absolute URLs only', () => {
    for (const key of ['url', 'codeRepository', 'license']) {
      assert.match(data[key] as string, /^https:\/\//, key);
    }
  });
});

describe('jsonLd', () => {
  it('should not let a value end the script element', () => {
    const text = jsonLd({ name: '</script><script>alert(1)</script>' });

    assert.equal(text.includes('<'), false);
    assert.deepEqual(JSON.parse(text), { name: '</script><script>alert(1)</script>' });
  });
});
