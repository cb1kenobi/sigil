import { remarkBlockStyles } from '../src/lib/block-styles.ts';
import { docsSidebar } from '../src/lib/docs-sidebar.ts';
import { guideLink } from '../src/lib/guide-links.ts';
import { ABOUT_REPO_PATH, about, guides, markdownPages } from '../src/lib/guides.ts';
import { headingsOf, parseMarkdown } from '../src/lib/markdown-doc.ts';
import { ABOUT_HREF, ABOUT_SLUG, guideHref } from '../src/lib/nav.ts';
import { REPO_URL } from '../src/lib/site.ts';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * `/docs/about` (SIG-266): its markdown is `docs/about.md`, its route is a page
 * of its own beside `/docs/[slug]`, and the sidebar's last section and the
 * footer's "TTY Labs" both go to it.
 */

const page = about();

/** Every link and definition in a markdown file, outside code. */
function linksOf(source: string): string[] {
  const found: string[] = [];
  const visit = (node: { type: string; url?: string; children?: unknown[] }) => {
    if (node.type === 'link' || node.type === 'definition') {
      found.push(node.url ?? '');
    }
    for (const child of node.children ?? []) {
      visit(child as Parameters<typeof visit>[0]);
    }
  };
  visit(parseMarkdown(source));
  return found;
}

describe('the About page', () => {
  it('should be docs/about.md, at /docs/about', () => {
    assert.equal(ABOUT_HREF, '/docs/about');
    assert.equal(ABOUT_HREF, guideHref(ABOUT_SLUG));
    assert.equal(page.slug, ABOUT_SLUG);
    assert.equal(page.repoPath, ABOUT_REPO_PATH);
    // the file it reads is the one the repository path names
    assert.equal(
      resolve(page.file),
      fileURLToPath(new URL(`../../${ABOUT_REPO_PATH}`, import.meta.url))
    );
    assert.equal(page.title, 'The story of sigil');
  });

  it('should have a route of its own, and not be a guide', () => {
    assert.ok(existsSync(new URL('../src/app/(sidebar)/docs/about/page.tsx', import.meta.url)));
    assert.ok(
      existsSync(new URL('../src/app/(sidebar)/docs/about/opengraph-image.tsx', import.meta.url))
    );
    // so `/docs/[slug]` builds no page for it and it is not in the Docs section's order
    assert.equal(
      guides().some((it) => it.slug === ABOUT_SLUG),
      false
    );
    assert.deepEqual(
      markdownPages().map((it) => it.slug),
      [...guides().map((it) => it.slug), ABOUT_SLUG]
    );
  });

  it("should have the ticket's sections, in order, each with an anchor for the rail", () => {
    assert.deepEqual(
      page.sections.map((section) => section.text),
      ['Where it came from', 'Timeline', "How it's made", 'Where AI fits', 'TTY Labs']
    );
    assert.ok(page.sections.every((section) => section.id !== ''));
  });

  it('should have a lede, which is its description', () => {
    assert.ok(page.description.length > 20 && page.description.length <= 200);
    assert.match(page.description, /[.!?]$/);
  });

  it('should draw the timeline, the points and the GitHub button', () => {
    const tree = parseMarkdown(page.source);
    remarkBlockStyles()(tree);
    const styled = tree.children.flatMap((node) => {
      const block = node.data?.hProperties?.dataBlock;
      return node.type === 'list' && typeof block === 'string'
        ? [[block, node.children.length] as const]
        : [];
    });

    assert.deepEqual(styled, [
      ['timeline', 5],
      ['points', 4],
    ]);
    assert.ok(
      tree.children.some(
        (node) =>
          node.type === 'paragraph' &&
          node.children[0]?.type === 'link' &&
          node.children[0].url === REPO_URL &&
          node.children[0].data?.hProperties?.dataButton === 'github'
      )
    );
  });

  it('should be the last section of the sidebar', () => {
    const last = docsSidebar().at(-1);

    assert.equal(last?.id, 'about');
    assert.equal(last?.label, 'About');
    assert.deepEqual(last?.links, [{ label: 'The story of sigil', href: ABOUT_HREF }]);
  });

  it('should be where the footer\'s "TTY Labs" goes', () => {
    // the footer is a component, which a test run under plain node cannot
    // render, so this reads it as fonts.test.ts reads the layout
    const footer = readFileSync(
      new URL('../src/components/site-footer.tsx', import.meta.url),
      'utf8'
    );

    assert.match(footer, /<Link\s+href=\{ABOUT_HREF\}[^>]*>\s*TTY Labs\s*<\/Link>/u);
  });

  it('should be an input of the build, so a cache hit cannot restore a stale page', () => {
    const turbo = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8')) as {
      tasks: { build: { inputs: string[] } };
    };

    assert.ok(turbo.tasks.build.inputs.includes(`../${ABOUT_REPO_PATH}`));
  });
});

describe('a link on the About page', () => {
  const from = posix.dirname(ABOUT_REPO_PATH);
  const links = linksOf(page.source);

  it('should land on a route of this site or a file on GitHub, never on a relative path', () => {
    assert.ok(links.length > 5, 'a reader that found nothing would pass this');

    for (const href of links) {
      const to = guideLink(href, from);

      assert.ok(
        to !== undefined &&
          (to.startsWith('/docs/') ||
            to.startsWith(`${REPO_URL}/blob/main/`) ||
            /^https?:/.test(to)),
        `${href} -> ${to}`
      );
    }
  });

  it('should resolve from docs/, so a link to a guide is its page and the rest is GitHub', () => {
    assert.equal(
      guideLink('../packages/sigil/docs/getting-started.md', from),
      '/docs/getting-started'
    );
    assert.equal(guideLink('history/', from), `${REPO_URL}/blob/main/docs/history`);
    assert.equal(
      guideLink('../AGENTS.md#deliberate-decisions--do-not-fix-these', from),
      `${REPO_URL}/blob/main/AGENTS.md#deliberate-decisions--do-not-fix-these`
    );
  });

  it('should land on a heading the site renders, for a fragment on a guide', () => {
    const headings = new Map(
      markdownPages().map((it) => [
        it.slug,
        new Set(headingsOf(parseMarkdown(it.source)).map((h) => h.id)),
      ])
    );

    for (const href of links) {
      const to = guideLink(href, from) ?? '';
      const match = /^\/docs\/([^#/]+)#(.+)$/.exec(to);
      if (match) {
        assert.ok(headings.get(match[1]!)?.has(decodeURIComponent(match[2]!)), `${href} -> ${to}`);
      }
    }
  });
});
