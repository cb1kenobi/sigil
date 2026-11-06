import { COMPONENTS, componentHref } from '../src/lib/components.ts';
import { docsPage, docsPages, docsSections } from '../src/lib/docs-pages.ts';
import { docsSidebar } from '../src/lib/docs-sidebar.ts';
import { corpusUrl, llmsFullTxt, llmsTxt, markdownFor } from '../src/lib/llms.ts';
import { headingsOf, parseMarkdown, rewriteLinks } from '../src/lib/markdown-doc.ts';
import { REPO_BRANCH, REPO_URL, SITE_URL } from '../src/lib/site.ts';
import { sitemapEntries } from '../src/lib/sitemap.ts';
import type { Root, RootContent } from 'mdast';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

/**
 * The Markdown corpus (SIG-267), over the real docs.
 *
 * Ported from titaniumsdk.com's `src/lib/docs/llms.test.ts`. No fixtures:
 * `llms.txt` is a claim about what this site serves, and a fixture would let it
 * be right about a tree nobody visits. The guides, the reference and the
 * captures are all committed, so the real thing is deterministic.
 */

/** The version, read here rather than through the code under test. */
const VERSION = (
  JSON.parse(
    readFileSync(join(process.cwd(), '..', 'packages', 'sigil', 'package.json'), 'utf-8')
  ) as { version: string }
).version;

const pages = docsPages();
const files = new Map(pages.map((page) => [page.href, markdownFor(page.href)!]));
const index = llmsTxt();
const full = llmsFullTxt();

/** The docs pages the site builds, by the sitemap's list of them. */
const built = sitemapEntries()
  .map(({ url }) => new URL(url).pathname)
  .filter((path) => /^\/(docs|reference)(\/|$)/u.test(path));

/** Every link destination in a piece of markdown, code left alone. */
function linksOf(markdown: string): string[] {
  const found: string[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === 'link' || node.type === 'definition' || node.type === 'image') {
      found.push(node.url);
    }
    if ('children' in node) {
      node.children.forEach(visit);
    }
  };
  visit(parseMarkdown(markdown));
  return found;
}

/** A piece of markdown with its code blocks and code spans taken out: what a reader sees as prose. */
function outsideCode(markdown: string): string {
  const cuts: [number, number][] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === 'code' || node.type === 'inlineCode') {
      cuts.push([node.position!.start.offset!, node.position!.end.offset!]);
    } else if ('children' in node) {
      node.children.forEach(visit);
    }
  };
  visit(parseMarkdown(markdown));
  return cuts.reduceRight((out, [from, to]) => out.slice(0, from) + out.slice(to), markdown);
}

/** Whether a link on the site lands: a `.md` that resolves, at an anchor its page has. */
function lands(url: string): boolean {
  const { pathname, hash } = new URL(url);
  if (!pathname.endsWith('.md')) {
    return ['/llms.txt', '/llms-full.txt'].includes(pathname) || built.includes(pathname);
  }
  const page = docsPage(pathname.slice(0, -'.md'.length));
  if (!page) {
    return false;
  }
  return hash === '' || headingsOf(parseMarkdown(page.markdown)).some((h) => `#${h.id}` === hash);
}

describe('every docs page has a .md', () => {
  it('should have one for every docs page the site builds', () => {
    // The sitemap is built from what each route's `generateStaticParams` reads,
    // so a page added another way -- About, if SIG-266 builds it as anything but
    // a guide -- fails here until `docsPage()` can answer for it.
    assert.ok(built.length > 60);
    for (const path of built) {
      assert.ok(markdownFor(path), `${path} has no .md`);
    }
  });

  it('should have one for every page in the sidebar that exists', () => {
    const linked = docsSidebar()
      .flatMap((section) => section.links)
      .map((link) => link.href.split('#')[0]!)
      .filter((href) => built.includes(href));
    for (const href of linked) {
      assert.ok(files.has(href), `${href} is in the sidebar and not in docsPages()`);
    }
  });

  it('should have one for every component', () => {
    for (const entry of COMPONENTS) {
      assert.ok(files.has(componentHref(entry.slug)), entry.slug);
    }
  });

  it('should list each page once', () => {
    assert.equal(new Set(pages.map((page) => page.href)).size, pages.length);
  });

  it('should refuse a path that is not a page', () => {
    for (const path of [
      '/',
      '/docs',
      '/docs/nope',
      '/docs/parser/extra',
      '/docs/../package',
      '/docs/components/nope',
      '/docs/components/select/extra',
      '/reference/index',
      '/reference/nope',
      '/reference/add/extra',
      '/md/docs/parser',
      '/examples',
    ]) {
      assert.equal(markdownFor(path), undefined, path);
    }
  });
});

describe('each .md', () => {
  it('should start by naming the version and the page', () => {
    for (const [href, text] of files) {
      assert.equal(text.split('\n')[0], `<!-- sigil v${VERSION} · ${SITE_URL}${href} -->`, href);
    }
  });

  it('should carry nothing from the site chrome', () => {
    const chrome =
      /<(nav|header|footer|aside|div|span|script|style|button|svg)\b|class(Name)?=|Edit on GitHub|View source|Report a problem|On this page|_next\//u;
    // a guide's own examples are sigil templates, which have `class=` in them
    for (const [href, text] of files) {
      assert.doesNotMatch(outsideCode(text), chrome, href);
    }
    assert.doesNotMatch(outsideCode(index), chrome);
    assert.doesNotMatch(outsideCode(full), chrome);
  });

  it('should hold no colour codes', () => {
    for (const [href, text] of files) {
      assert.equal(text.includes('\u001b'), false, href);
    }
  });

  it('should leave no link relative, and every link to the site should land', () => {
    for (const [href, text] of files) {
      for (const url of linksOf(text)) {
        assert.match(url, /^(https?:|mailto:|#)/u, `${href}: ${url} is relative`);
        if (url.startsWith(`${SITE_URL}/`)) {
          assert.ok(lands(url), `${href}: ${url} does not land`);
        }
      }
    }
  });

  it('should point every link into the repository at a file that is there', () => {
    // a relative link resolved from the wrong directory still makes a GitHub URL,
    // just one to nothing -- which only this can see
    const blob = `${REPO_URL}/blob/${REPO_BRANCH}/`;
    for (const [href, text] of files) {
      for (const url of linksOf(text).filter((it) => it.startsWith(blob))) {
        const path = decodeURIComponent(url.slice(blob.length).split('#')[0]!);
        assert.ok(existsSync(join(process.cwd(), '..', path)), `${href}: ${url} is no file`);
      }
    }
  });

  it('should keep a guide whole, with its includes resolved', () => {
    const text = files.get('/docs/getting-started')!;
    assert.match(text, /^# Getting started$/mu);
    assert.doesNotMatch(text, /<!--\s*include/u);
    // the agent instructions, filled in with the version and the site
    assert.ok(text.includes(`This project uses sigil v${VERSION}`));
    assert.ok(text.includes(`${SITE_URL}/llms.txt`));
  });

  it('should point a guide link at the guide’s .md and a repository link at GitHub', () => {
    const text = files.get('/docs/getting-started')!;
    assert.ok(text.includes(`](${SITE_URL}/docs/parser.md)`));
    assert.match(text, /\]\(https:\/\/github\.com\/[^)]+\/README\.md#/u);
  });

  it('should point a command’s subcommand table at each command’s .md', () => {
    assert.ok(files.get('/reference')!.includes(`(${SITE_URL}/reference/add.md)`));
  });

  it('should write a component’s output as console blocks and its options as a table', () => {
    const text = files.get('/docs/components/select')!;
    assert.match(text, /^# select\(\)$/mu);
    assert.match(text, /```console\n\? Template\n/u);
    assert.match(text, /^\| Option \| Type \| Default \| What it does \|$/mu);
    assert.match(text, /^\| `choices` \| `readonly ChoiceEntry<T>\[\]` \| required \|/mu);
    assert.match(text, /^\| Keys \| What they do \|$/mu);
    assert.match(text, /^## Use a default after a timeout$/mu);
    assert.match(text, /```console\n\$ node deploy\.mjs\n/u);
  });

  it('should escape a `|` inside a table cell', () => {
    // a type like `string | undefined` would otherwise split the row in two
    const rows = pages
      .filter((page) => page.kind === 'component')
      .flatMap((page) => files.get(page.href)!.split('\n'))
      .filter((line) => line.startsWith('| `'));
    assert.ok(rows.some((row) => row.includes('\\|')));
    for (const row of rows) {
      // an options row has four cells, a keys row two
      assert.ok([4, 6].includes(row.split(/(?<!\\)\|/u).length), row);
    }
  });
});

describe('llms.txt', () => {
  const lines = index.split('\n');

  it('should follow the llmstxt.org shape: H1, blockquote, then linked sections', () => {
    assert.equal(lines[0], '# sigil');
    assert.ok(lines.some((line) => line.startsWith('> ')));
    assert.ok(lines.some((line) => line.startsWith('## ')));
  });

  it('should have the sidebar’s sections in its order, and About only once it has a page', () => {
    const headings = lines.filter((line) => line.startsWith('## ')).map((line) => line.slice(3));
    const about = docsPage('/docs/about') !== undefined;
    assert.deepEqual(headings, [
      'Docs',
      'Parser',
      'CLI',
      'Components',
      ...(about ? ['About'] : []),
      'Optional',
    ]);
    assert.deepEqual(
      docsSections().map((section) => section.label),
      headings.slice(0, -1)
    );
  });

  it('should name the version and link the agent instructions near the top', () => {
    const top = lines.slice(0, 8).join('\n');
    assert.ok(top.includes(`v${VERSION}`));
    assert.ok(top.includes(`(${SITE_URL}/docs/getting-started.md#agents)`));
  });

  it('should link only to pages that resolve, at anchors they have', () => {
    for (const url of linksOf(index)) {
      if (url.startsWith(SITE_URL)) {
        assert.ok(lands(url), url);
      } else {
        assert.match(url, /^https:\/\//u, url);
      }
    }
  });

  it('should link every docs page by its .md', () => {
    for (const page of pages) {
      assert.ok(index.includes(`(${SITE_URL}${page.href}.md)`), page.href);
    }
  });
});

describe('llms-full.txt', () => {
  it('should hold every page, in the order the sidebar has them', () => {
    let from = 0;
    for (const page of pages) {
      const at = full.indexOf(`<!-- sigil v${VERSION} · ${SITE_URL}${page.href} -->`, from);
      assert.ok(at >= from, `${page.href} is missing or out of order`);
      from = at;
    }
  });

  it('should be one fetch’s worth', () => {
    // titaniumsdk.com's cap. Crossing it is when this file needs one too.
    assert.ok(Buffer.byteLength(full, 'utf8') < 1_000_000);
  });
});

describe('corpusUrl', () => {
  const isPage = (path: string) => path === '/docs/parser';

  it('should send a docs page to its .md and keep the fragment', () => {
    assert.equal(corpusUrl('/docs/parser#options', isPage), `${SITE_URL}/docs/parser.md#options`);
  });

  it('should not invent a .md for a page that is not there', () => {
    assert.equal(corpusUrl('/docs/about', isPage), `${SITE_URL}/docs/about`);
  });

  it('should leave a fragment, a URL and a protocol-relative URL alone', () => {
    for (const href of ['#x', 'https://example.com/a', '//example.com/a', 'mailto:a@b.c']) {
      assert.equal(corpusUrl(href, isPage), href);
    }
  });
});

describe('rewriteLinks', () => {
  const to = (href: string) => `/to/${href}`;

  it('should rewrite inline links and definitions, and nothing in code', () => {
    const source = '[a](x.md) `[b](y.md)`\n\n```md\n[c](z.md)\n```\n\n[d]: w.md\n';
    assert.equal(
      rewriteLinks(source, to),
      '[a](/to/x.md) `[b](y.md)`\n\n```md\n[c](z.md)\n```\n\n[d]: /to/w.md\n'
    );
  });

  it('should keep a title and an angle-bracketed destination', () => {
    assert.equal(rewriteLinks('[a](<x y.md> "t")', to), '[a](</to/x y.md> "t")');
    assert.equal(rewriteLinks('[a](x.md "t")', to), '[a](/to/x.md "t")');
  });

  it('should leave a link it is told to leave', () => {
    assert.equal(
      rewriteLinks('[a](x.md)', () => undefined),
      '[a](x.md)'
    );
  });
});
