import { guideLink } from '../src/lib/guide-links.ts';
import { GUIDES_DIR, guide, guides } from '../src/lib/guides.ts';
import { includesOf } from '../src/lib/includes.ts';
import { headingsOf, parseMarkdown } from '../src/lib/markdown-doc.ts';
import { GUIDE_SLUGS, guideHref } from '../src/lib/nav.ts';
import { REPO_URL } from '../src/lib/site.ts';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The guides are `packages/sigil/docs/*.md`, rendered in place, and
 * `markdown-links.test.ts` in that package is what says their links are true on
 * GitHub. What this holds is that they are true here as well: a link that test
 * accepts has to land on a route and on a heading this site renders.
 */

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

describe('the guides', () => {
  it('should be every markdown file in packages/sigil/docs, so a new one is placed on purpose', () => {
    // or a file a guide includes, which is a block on that guide's page and no
    // page of its own: the agent instructions
    const included = GUIDE_SLUGS.flatMap((slug) =>
      includesOf(readFileSync(join(GUIDES_DIR, `${slug}.md`), 'utf-8'))
    );
    const files = readdirSync(GUIDES_DIR)
      .filter((name) => name.endsWith('.md') && !included.includes(name))
      .map((name) => name.slice(0, -'.md'.length))
      .toSorted();

    assert.deepEqual(included, ['agents.md']);
    assert.deepEqual(files, [...GUIDE_SLUGS].toSorted());
  });

  it('should each have a title, a description and sections', () => {
    for (const it of guides()) {
      assert.notEqual(it.title, it.slug, it.slug);
      assert.ok(it.description.length > 20 && it.description.length <= 200, it.slug);
      assert.ok(it.sections.length > 1, it.slug);
      assert.ok(
        it.sections.every((section) => section.id !== '' && section.depth === 2),
        it.slug
      );
    }
  });

  it('should have the parser reference as one page of its 17 sections', () => {
    assert.equal(guide('parser')?.sections.length, 17);
  });

  it('should have a description that is the first sentence and not a cut-off one', () => {
    assert.match(guide('getting-started')?.description ?? '', /^This guide builds a small CLI/);
    assert.match(guide('parser')?.description ?? '', /^The parser is a multi-pass/);
    for (const it of guides()) {
      assert.match(it.description, /[.!?]$/, it.slug);
    }
  });

  it('should end Getting started with the agent instructions, at the address the home page links to', () => {
    const it = guide('getting-started')!;
    const at = it.sections.findIndex((section) => section.id === 'agents');

    assert.equal(it.sections[at]?.text, 'Use sigil with an agent');
    assert.equal(it.sections[at + 1]?.id, 'where-next');
    // the block itself, filled in, and nothing of the directive left over
    assert.match(
      it.source,
      /^```md title="AGENTS\.md · sigil v\d+\.\d+\.\d+[^"]*" event=agent_instructions_copied$/m
    );
    assert.doesNotMatch(it.source, /<!--\s*\/?include|\{\{/);
  });

  it('should open Getting started with the install box, for the command the guide shows', () => {
    assert.match(
      guide('getting-started')!.source,
      /^```sh install=cli location=getting-started\nnpx @ttylabs\/cli new my-cli\n```$/m
    );
  });

  it('should say nothing for a slug that is not a guide', () => {
    assert.equal(guide('nope'), undefined);
    assert.equal(guide('../README'), undefined);
  });
});

describe('a link in a guide', () => {
  const headings = new Map(
    guides().map((it) => [it.slug, new Set(headingsOf(parseMarkdown(it.source)).map((h) => h.id))])
  );

  it('should have been found, so that this is testing something', () => {
    const all = guides().flatMap((it) => linksOf(it.source));

    assert.ok(all.length > 20);
    assert.ok(all.some((href) => href.startsWith('#')));
    assert.ok(all.some((href) => href.startsWith('../README.md#')));
    assert.ok(all.some((href) => href.startsWith('parser.md')));
  });

  it('should land on a route of this site or a file on GitHub, never on a relative path', () => {
    for (const it of guides()) {
      for (const href of linksOf(it.source)) {
        const to = guideLink(href);

        assert.ok(
          to !== undefined &&
            (to.startsWith('#') ||
              to.startsWith('/docs/') ||
              to.startsWith(`${REPO_URL}/blob/main/`) ||
              /^https?:/.test(to)),
          `${it.slug}: ${href} -> ${to}`
        );
      }
    }
  });

  it('should land on a heading the site renders, for every fragment the guides use', () => {
    let checked = 0;

    for (const it of guides()) {
      for (const href of linksOf(it.source)) {
        const to = guideLink(href) ?? '';
        const fragment = to.includes('#') ? to.slice(to.indexOf('#') + 1) : undefined;
        const page = to.startsWith('#') ? it.slug : /^\/docs\/([^#/]+)/.exec(to)?.[1];

        if (fragment === undefined || page === undefined) {
          continue;
        }

        checked++;
        assert.ok(
          headings.get(page)?.has(decodeURIComponent(fragment)),
          `${it.slug}: ${href} -> ${to} is no heading on /docs/${page}`
        );
      }
    }

    assert.ok(checked > 5, 'a reader that found nothing would pass every case above');
  });

  it('should turn a link to a sibling guide into its page, keeping the fragment', () => {
    assert.equal(guideLink('parser.md'), guideHref('parser'));
    assert.equal(guideLink('./parser.md#data-types'), '/docs/parser#data-types');
    assert.equal(guideLink('getting-started.md#build-it'), '/docs/getting-started#build-it');
  });

  it('should turn a link to anything else in the repository into that file on GitHub', () => {
    assert.equal(
      guideLink('../README.md#typed-argv'),
      `${REPO_URL}/blob/main/packages/sigil/README.md#typed-argv`
    );
    assert.equal(guideLink('../../cli/README.md'), `${REPO_URL}/blob/main/packages/cli/README.md`);
    assert.equal(guideLink('../src/'), `${REPO_URL}/blob/main/packages/sigil/src`);
  });

  it('should leave a fragment, an absolute URL and an absolute path as they were written', () => {
    assert.equal(guideLink('#build-it'), '#build-it');
    assert.equal(guideLink('https://example.com/a#b'), 'https://example.com/a#b');
    assert.equal(guideLink('mailto:a@example.com'), 'mailto:a@example.com');
    assert.equal(guideLink('/docs/parser'), '/docs/parser');
    assert.equal(guideLink(undefined), undefined);
  });

  it('should not turn a markdown file that is not a guide into a route', () => {
    assert.equal(guideLink('nope.md'), `${REPO_URL}/blob/main/packages/sigil/docs/nope.md`);
  });
});
