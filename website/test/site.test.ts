import { isIndexableHost } from '../src/lib/site.ts';
import {
  REPO_NEW_ISSUE_URL,
  REPO_URL,
  SITE_URL,
  TITLE_TEMPLATE,
  absoluteUrl,
  fullTitle,
  repoFileUrl,
} from '../src/lib/site.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const production = new URL(SITE_URL).hostname;

describe('isIndexableHost', () => {
  it('should let the production host in, with or without a port or a case', () => {
    assert.equal(isIndexableHost(production), true);
    assert.equal(isIndexableHost(`${production}:443`), true);
    assert.equal(isIndexableHost(production.toUpperCase()), true);
    assert.equal(isIndexableHost(`${production}.`), true);
  });

  it('should keep every other host out', () => {
    for (const host of [
      'localhost',
      'localhost:3000',
      'sigil-git-branch-ttylabs.vercel.app',
      `preview.${production}`,
      `www.${production}`,
      `${production}.evil.example`,
      `evil-${production}`,
    ]) {
      assert.equal(isIndexableHost(host), false, host);
    }
  });

  it('should keep a request with no host out', () => {
    assert.equal(isIndexableHost(null), false);
    assert.equal(isIndexableHost(undefined), false);
    assert.equal(isIndexableHost(''), false);
  });
});

describe('absoluteUrl', () => {
  it('should give the home page the form a canonical has, without a trailing slash', () => {
    assert.equal(absoluteUrl('/'), SITE_URL);
    assert.equal(absoluteUrl('/reference'), `${SITE_URL}/reference`);
  });

  it('should take the origin from SITE_URL, which has no trailing slash to double', () => {
    assert.equal(SITE_URL.endsWith('/'), false);
    assert.equal(new URL(SITE_URL).pathname, '/');
  });
});

describe('fullTitle', () => {
  it('should render a page title the way the layout template does', () => {
    assert.equal(fullTitle('CLI reference'), TITLE_TEMPLATE.replace('%s', 'CLI reference'));
    assert.equal(fullTitle('CLI reference'), 'CLI reference · sigil');
  });

  it('should give the home page the site tagline title', () => {
    assert.equal(fullTitle(), 'sigil: command-line apps in TypeScript');
  });
});

describe('a link into the repository', () => {
  it('should be the file on main, built from the repository the site names', () => {
    assert.equal(
      repoFileUrl('packages/sigil/docs/parser.md'),
      `${REPO_URL}/blob/main/packages/sigil/docs/parser.md`
    );
  });

  it('should open a new issue on the same repository', () => {
    assert.equal(REPO_NEW_ISSUE_URL, 'https://github.com/cb1kenobi/sigil/issues/new');
  });
});
