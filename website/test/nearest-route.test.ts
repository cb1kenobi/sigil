import { knownPaths } from '../src/lib/known-paths.ts';
import { nearestRoute } from '../src/lib/nearest-route.ts';
import { SITE_URL } from '../src/lib/site.ts';
import { sitemapEntries } from '../src/lib/sitemap.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** A realistic mix: a section, its children, and pages that are alike. */
const ROUTES = [
  '/',
  '/docs/getting-started',
  '/docs/components',
  '/docs/components/spinner',
  '/docs/components/progress',
  '/reference',
  '/reference/build',
  '/reference/add',
  '/reference/check',
  '/reference/package',
];

describe('the nearest route', () => {
  it('should suggest the page for the typo the ticket shows', () => {
    assert.equal(nearestRoute('/docs/getting-startd', ROUTES), '/docs/getting-started');
  });

  it('should suggest for a transposition, a missing letter and a stray one', () => {
    assert.equal(nearestRoute('/reference/biuld', ROUTES), '/reference/build');
    assert.equal(nearestRoute('/docs/gettin-started', ROUTES), '/docs/getting-started');
    assert.equal(nearestRoute('/docs/getting-starteed', ROUTES), '/docs/getting-started');
    assert.equal(nearestRoute('/refrence', ROUTES), '/reference');
  });

  it('should name the page it means in the spelling the site uses, whatever the case typed', () => {
    assert.equal(nearestRoute('/Reference/Build', ROUTES), '/reference/build');
  });

  it('should suggest nothing when nothing is close', () => {
    assert.equal(nearestRoute('/pricing', ROUTES), undefined);
    assert.equal(nearestRoute('/blog/2024/a-very-long-post', ROUTES), undefined);
    assert.equal(nearestRoute('/x', ROUTES), undefined);
    assert.equal(nearestRoute('/', ROUTES), undefined);
  });

  it('should suggest nothing when two pages are equally near, rather than pick one', () => {
    // one letter from both `/reference/add` and `/reference/ado`
    assert.equal(nearestRoute('/reference/adb', ['/reference/add', '/reference/ado']), undefined);
  });

  it('should not offer the home page for a short address that shares nothing with it', () => {
    assert.equal(nearestRoute('/ab', ['/']), undefined);
  });

  it('should ignore a leading slash on both sides, which every address has', () => {
    // with the slash counted `/a` and `/b` are one slip in two characters, which
    // the rate allows; without it they are one character that differs and share nothing
    assert.equal(nearestRoute('/a', ['/b']), undefined);
  });

  it('should answer an enormous address without comparing it', () => {
    const started = performance.now();
    assert.equal(nearestRoute(`/${'a'.repeat(100_000)}`, ROUTES), undefined);
    assert.ok(performance.now() - started < 500);
  });

  it('should suggest from the real sitemap, with no list of its own', () => {
    const real = knownPaths();

    assert.deepEqual(
      real,
      sitemapEntries().map(({ url }) => new URL(url, SITE_URL).pathname)
    );
    assert.equal(
      real.every((path) => path.startsWith('/')),
      true
    );
    assert.equal(nearestRoute('/refrence', real), '/reference');
  });
});
