import { errorRows, notFoundRows } from '../src/lib/failure-rows.ts';
import { brokenLinkUrl, errorReportUrl } from '../src/lib/report.ts';
import { REPO_URL } from '../src/lib/site.ts';
import { plainText } from '../src/lib/terminal-rows.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('the 404 terminal', () => {
  it('should read like sigil failing, with the suggestion under the error', () => {
    assert.equal(
      plainText(notFoundRows('/docs/getting-startd', '/docs/getting-started')),
      [
        '$ sigil open /docs/getting-startd',
        '✖ No page at /docs/getting-startd',
        '  Did you mean /docs/getting-started?',
      ].join('\n')
    );
  });

  it('should leave the suggestion line out when nothing is close', () => {
    assert.equal(
      plainText(notFoundRows('/pricing')),
      '$ sigil open /pricing\n✖ No page at /pricing'
    );
  });

  it('should colour the glyph like the CLI and dim the hint', () => {
    const [, failure, hint] = notFoundRows('/a', '/b');

    assert.equal(failure!.spans[0]!.className, 'text-term-red');
    assert.equal(hint!.spans[0]!.className, 'text-dim');
  });

  it('should render a placeholder until the address is known', () => {
    assert.equal(
      plainText(notFoundRows(null)),
      '$ sigil open <address>\n✖ No page at that address'
    );
  });
});

describe('the error terminal', () => {
  it('should show the digest and nothing else', () => {
    assert.equal(
      plainText(errorRows('/reference/build', '1234567890')),
      [
        '$ sigil open /reference/build',
        '✖ Something went wrong rendering this page.',
        '  digest 1234567890',
      ].join('\n')
    );
  });

  it('should show no digest row for an error that began in the browser', () => {
    assert.equal(plainText(errorRows('/x')).split('\n').length, 2);
  });

  it('should show the message only when it is handed one', () => {
    assert.match(plainText(errorRows('/x', 'd', 'boom')), /boom/u);
    assert.doesNotMatch(plainText(errorRows('/x', 'd')), /boom/u);
  });
});

describe('the report links', () => {
  it('should put the missed address in the title, encoded, on the repository', () => {
    const url = new URL(brokenLinkUrl('/docs/a b?x=1&y=#z'));

    assert.equal(url.origin + url.pathname, `${REPO_URL}/issues/new`);
    assert.equal(url.searchParams.get('title'), 'Broken link: /docs/a b?x=1&y=#z');
    assert.equal(url.search.includes(' '), false);
    assert.equal(url.search.includes('&y='), false);
  });

  it('should say where the reader came from, when the browser said', () => {
    const body = new URL(brokenLinkUrl('/a', 'https://example.com/x')).searchParams.get('body');

    assert.match(body!, /https:\/\/example\.com\/x/u);
    assert.doesNotMatch(new URL(brokenLinkUrl('/a')).searchParams.get('body')!, /came from/u);
  });

  it('should cut an enormous address short rather than fill the form with it', () => {
    const title = new URL(brokenLinkUrl(`/${'a'.repeat(5000)}`)).searchParams.get('title')!;

    assert.equal(title.length < 200, true);
  });

  it('should carry the digest and the path of an error', () => {
    const url = new URL(errorReportUrl('/reference/build', 'abc123'));

    assert.equal(url.searchParams.get('title'), 'Error rendering /reference/build');
    assert.match(url.searchParams.get('body')!, /abc123/u);
    assert.match(url.searchParams.get('body')!, /\/reference\/build/u);
  });

  it('should still make a form before the address is known', () => {
    assert.equal(new URL(brokenLinkUrl(null)).searchParams.get('title'), 'Broken link');
  });
});
