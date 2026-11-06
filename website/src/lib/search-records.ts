import { docsPages, type DocsPage } from './docs-pages.ts';
import { headingsOf, parseMarkdown, textOf } from './markdown-doc.ts';
import { optionRows } from './reference-options.ts';
import type { Root, RootContent } from 'mdast';

/**
 * What site search (SIG-254) knows about: one record per thing a reader looks
 * for, built from the same files the pages are rendered from.
 *
 * Ported from titaniumsdk.com's `scripts/generate-search-index.ts`, whose
 * finding is the reason for the shape: Pagefind normally indexes rendered
 * HTML and ranks *pages*, and indexing each symbol as its own record took that
 * site's query set from 3/7 to 6/7. Here a symbol is a command or an option, and
 * a guide's unit is its `h2` section, so a phrase lands on the section that says
 * it rather than on the top of a long page.
 *
 * ## Sources
 *
 * One function per part of the site, listed in `SOURCES`, the way
 * `sitemap.ts` lists its `SECTIONS`. Each reads its pages from `docsPages()`,
 * the one loader of the docs as Markdown, which the `.md` copies and
 * `llms-full.txt` read too (SIG-267): a page there is a page its route builds,
 * at the route the site links to, so a record cannot point at a page the site
 * does not have. A new part of the site (the component pages, which
 * `docsPages()` already writes out as Markdown) is one more function here and
 * one more line in `SOURCES`; both generators and the dialog pick it up from
 * there, and a new `kind` gets a group label in `site-search.tsx`.
 *
 * The committed markdown is what is read, never the toolchain: the site does
 * not import `@ttylabs/cli` or its schema at build time (see `reference.ts`).
 */

/** What the results list groups by. */
export type SearchKind = 'guide' | 'command' | 'option';

export interface SearchRecord {
  /** The record's identity as well as its link: two records may not share one. */
  readonly url: string;
  /** What the result says. For a command or an option, the name as typed: `sigil build --out`. */
  readonly title: string;
  readonly kind: SearchKind;
  /** The guide a section is in, shown beside its title. */
  readonly page?: string;
  /**
   * Indexed text. It starts with the title so that a name match outweighs
   * prose, which is also why Pagefind's excerpt opens with the title and
   * `resultDetail()` trims it off again.
   */
  readonly body: string;
  /**
   * The line the name matcher shows under a top match, from `symbols.json`.
   *
   * **It never reaches Pagefind.** titaniumsdk.com's record carried a
   * `summary` whose comment said it was shown instead of Pagefind's excerpt,
   * and nothing passed it on: Pagefind indexes `meta` values as well as
   * content, so a summary there would be indexed twice and dilute name matches,
   * and the excerpt is what `resultDetail()` cleans up instead. Here the field
   * goes where it is read, which is the matcher's payload.
   */
  readonly summary?: string;
  /** Whether the name matcher answers for it: true for the identifiers people type. */
  readonly symbol?: boolean;
}

/**
 * A block's text as indexed prose: inline content as a reader sees it
 * (`textOf()`), and block children joined with a space so a table's cells or
 * a list's items do not run together. A fence is nothing, as titaniumsdk.com
 * left it out: a section is found by what it says, and code is what its
 * matching name records are for.
 */
function prose(node: Root | RootContent): string {
  switch (node.type) {
    case 'code':
      return '';
    case 'paragraph':
    case 'heading':
    case 'tableCell':
      return textOf(node);
    default:
      return 'children' in node ? node.children.map(prose).join(' ') : textOf(node);
  }
}

/** Collapses whitespace, so a body is one line however the markdown wrapped. */
function squash(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** How many headings a node holds, itself included, for lining up `headingsOf()`. */
function headingCount(node: Root | RootContent): number {
  const own = node.type === 'heading' ? 1 : 0;
  return 'children' in node
    ? own + node.children.reduce((n, child) => n + headingCount(child), 0)
    : own;
}

/**
 * One guide: the page itself for what comes before its first section, and one
 * record per `h2`, linked by the anchor the page renders it with.
 *
 * The anchors are `headingsOf()`'s, over the same parse the page is drawn from,
 * so a repeated heading gets the `-1` the page gives it rather than a second
 * record at the first one's address.
 */
function guideRecords(guide: DocsPage): SearchRecord[] {
  const tree = parseMarkdown(guide.markdown);
  const ids = headingsOf(tree);
  const { href } = guide;
  const records: SearchRecord[] = [];
  let section: { url: string; title: string; text: string[] } = {
    url: href,
    title: guide.title,
    text: [],
  };
  let at = 0;

  const flush = () => {
    records.push({
      url: section.url,
      title: section.title,
      kind: 'guide',
      ...(section.url === href ? {} : { page: guide.title }),
      body: squash(`${section.title} ${section.text.join(' ')}`),
    });
  };

  for (const node of tree.children) {
    if (node.type === 'heading' && node.depth === 1) {
      // the title, which the page record already carries
    } else if (node.type === 'heading' && node.depth === 2 && ids[at]?.id) {
      flush();
      section = { url: `${href}#${ids[at]!.id}`, title: ids[at]!.text, text: [] };
    } else {
      section.text.push(prose(node));
    }
    at += headingCount(node);
  }
  flush();

  return records;
}

/** The guides, one record per section. */
function guideSource(): SearchRecord[] {
  return docsPages()
    .filter((page) => page.kind === 'guide')
    .flatMap(guideRecords);
}

/**
 * One command page: a record for the command, and one per option at its row's
 * anchor (`remarkOptionAnchors()`).
 *
 * The command's body is its page without the option table, which the option
 * records carry. Each body repeats the last word of its title -- `package`,
 * `--out` -- as titaniumsdk.com repeats a member's bare name: it is the word a
 * reader types, and saying it twice is what ranks the record named for it above
 * one that mentions it in passing. `resultDetail()` trims both off the excerpt.
 */
function referenceRecords(doc: DocsPage): SearchRecord[] {
  const tree = parseMarkdown(doc.markdown);
  const options = optionRows(tree);
  const { href } = doc;
  const optionTables = new Set(options.map((row) => row.node));
  const bare = doc.argv?.at(-1) ?? '';
  const text = tree.children
    .filter((node) => !(node.type === 'heading' && node.depth === 1))
    .filter(
      (node) => !(node.type === 'table' && node.children.some((row) => optionTables.has(row)))
    )
    .map(prose);

  return [
    {
      url: href,
      title: doc.title,
      kind: 'command',
      body: squash(`${doc.title} ${bare} ${text.join(' ')}`),
      ...(doc.description ? { summary: doc.description } : {}),
      symbol: true,
    },
    ...options.map((row): SearchRecord => ({
      url: `${href}#${row.name}`,
      title: `${doc.title} ${row.name}`,
      kind: 'option',
      // aliases last, so the excerpt under the title is the description
      body: squash(
        `${doc.title} ${row.name} ${row.name} ${row.description} ${row.aliases.join(' ')}`
      ),
      ...(row.description ? { summary: row.description } : {}),
      symbol: true,
    })),
  ];
}

/** The command reference: the commands and their options. */
function referenceSource(): SearchRecord[] {
  return docsPages()
    .filter((page) => page.kind === 'command')
    .flatMap(referenceRecords);
}

/** Every source. The order the results list groups them in is `GROUPS` in `site-search.tsx`. */
const SOURCES: readonly (() => SearchRecord[])[] = [guideSource, referenceSource];

/**
 * Every record, checked.
 *
 * A URL is a record's identity, so a duplicate would make the second one
 * unreachable; it throws rather than skipping, because on this site it would
 * mean two options on one page with the same name, or an anchor rule that
 * collides, and either is a bug to fix rather than a record to drop.
 *
 * @returns The records.
 */
export function searchRecords(): SearchRecord[] {
  const records = SOURCES.flatMap((source) => source());
  const seen = new Set<string>();

  for (const record of records) {
    if (seen.has(record.url)) {
      throw new Error(`two search records share ${record.url}`);
    }
    seen.add(record.url);
  }

  return records;
}
