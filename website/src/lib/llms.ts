import { docsPage, docsPages, docsSections, type DocsPage } from './docs-pages.ts';
import { HOME_LEDE } from './home.ts';
import { sigilVersion } from './includes.ts';
import { hasMarkdownCopy, markdownHref } from './markdown-copy.ts';
import { rewriteLinks } from './markdown-doc.ts';
import { REPO_URL, SITE_NAME, TAGLINE, absoluteUrl } from './site.ts';

/**
 * The machine-readable corpus: `/llms.txt`, `/llms-full.txt`, and a `.md`
 * beside every docs page (SIG-267).
 *
 * Ported from titaniumsdk.com's `src/lib/docs/llms.ts` (TI-57). Agents read
 * documentation by fetching URLs, and a docs page as HTML is mostly navigation;
 * the Markdown copy is the page's content alone, at an address an agent can
 * guess.
 *
 * ## The version line
 *
 * Every file starts by naming the release it documents, read from
 * `packages/sigil/package.json` when the site is built, never typed. A model
 * trained on an older release otherwise answers with an API that has since
 * changed, and quoting a version-less page is exactly how that happens.
 *
 * ## Generated, never written
 *
 * `llms.txt` is built from the docs sidebar (`docsSections()`), the same thing
 * the site's navigation is built from, so it cannot describe a page the site
 * does not have, and a page the sidebar gains -- About, when SIG-266 builds it --
 * is in it without anything here changing. A hand-maintained index would be
 * correct for about a week.
 *
 * ## No cap on `llms-full.txt`
 *
 * titaniumsdk.com caps its full corpus at 1MB and drops pages from the back,
 * because its API reference is 13MB of YAML. sigil's docs are a few hundred KB
 * end to end, so every page goes in and `test/llms.test.ts` fails if the file
 * grows past the size a reader can still take in one fetch -- at which point
 * the cap, and deciding what falls off, is the next ticket rather than a
 * surprise.
 */

/**
 * The line every Markdown file starts with: the version, and the page's own
 * address on the site.
 *
 * An HTML comment, so a renderer shows nothing and an agent reads it first.
 *
 * @param href - The page's route.
 * @returns The line.
 */
export function versionLine(href: string): string {
  return `<!-- ${SITE_NAME} v${sigilVersion()} · ${absoluteUrl(href)} -->`;
}

/**
 * Where a link on the site goes once the page is read away from it.
 *
 * A corpus is read off the site, where `/docs/parser` resolves to nothing. A
 * docs page's link points at its `.md` rather than its HTML, which keeps a model
 * inside the machine-readable tree once it follows one link; any other path on
 * the site is made absolute; a fragment on its own and a URL with a scheme are
 * left as they are.
 *
 * Whether a path is a docs page is asked of `docsPage()`, not of its prefix: a
 * link to a page that is not there would otherwise become a `.md` that is not
 * there either.
 *
 * @param href - A link as the site resolves it: a route, a fragment or a URL.
 * @param isPage - Whether a route is a docs page.
 * @returns The absolute address.
 */
export function corpusUrl(href: string, isPage: (path: string) => boolean): string {
  if (!href.startsWith('/') || href.startsWith('//')) {
    return href;
  }

  const at = href.indexOf('#');
  const path = at === -1 ? href : href.slice(0, at);
  const fragment = at === -1 ? '' : href.slice(at);

  return hasMarkdownCopy(path) && isPage(path)
    ? `${absoluteUrl(markdownHref(path))}${fragment}`
    : `${absoluteUrl(path)}${fragment}`;
}

/** Whether a route is a docs page, each route asked once. */
function pageCheck(): (path: string) => boolean {
  const known = new Map<string, boolean>();

  return (path) => {
    if (!known.has(path)) {
      known.set(path, docsPage(path) !== undefined);
    }
    return known.get(path)!;
  };
}

/**
 * One page as its `.md` serves it: the version line, then its Markdown with
 * every link made absolute.
 *
 * @param page - The page.
 * @param isPage - Whether a route is a docs page, shared across a run of pages.
 * @returns The file.
 */
export function pageMarkdown(page: DocsPage, isPage = pageCheck()): string {
  const body = rewriteLinks(page.markdown, (href) => {
    const site = page.link(href);
    return site === undefined ? undefined : corpusUrl(site, isPage);
  });

  return `${versionLine(page.href)}\n\n${body.replace(/\s+$/u, '')}\n`;
}

/**
 * The Markdown for a docs page's route, or nothing where there is none.
 *
 * One resolver, for the route that serves `.md` and for the tests that check
 * `llms.txt`. Sharing it is the point: an entry is checked by asking for the
 * same bytes a reader would get, so the two cannot disagree.
 *
 * @param path - The page's route, without `.md`.
 * @returns The file.
 */
export function markdownFor(path: string): string | undefined {
  const page = docsPage(path);
  return page && pageMarkdown(page);
}

/** What `llms.txt` says sigil is, before anything else. */
const SUMMARY = `${SITE_NAME} is a framework for command-line apps in TypeScript and JavaScript on Node.js, with no runtime dependencies: \`@ttylabs/sigil\` is the hierarchical argument parser, help, prompts, components and full-screen app runtime, and \`@ttylabs/cli\` is the \`sigil\` toolchain that scaffolds, checks, builds and packages an app. ${HOME_LEDE}`;

/**
 * `/llms.txt`, to the llmstxt.org convention: an H1, a blockquote summary,
 * notes, then H2 sections of linked entries.
 *
 * The sections are the docs sidebar's -- Docs, Parser, CLI, Components, and
 * About once it has a page -- and every link is a page's `.md`. A client that
 * follows one is asking for text, and handing it HTML with a navigation sidebar
 * in it is the thing this file exists to avoid.
 *
 * @returns The file.
 */
export function llmsTxt(): string {
  const isPage = pageCheck();
  const link = (href: string) => corpusUrl(href, isPage);
  const version = sigilVersion();

  const out = [
    `# ${SITE_NAME}`,
    '',
    `> ${SUMMARY}`,
    '',
    `- This index documents ${SITE_NAME} v${version}. Every file it links to starts with the version it describes; an API remembered from an older release may have changed since.`,
    `- Working in a ${SITE_NAME} app? Paste the agent instructions into the project's AGENTS.md or CLAUDE.md first: [Use sigil with an agent](${link('/docs/getting-started#agents')}).`,
    `- Each link below is a page's Markdown. The page itself is the same address without \`.md\`, and every page in one file is ${absoluteUrl('/llms-full.txt')}.`,
    '',
  ];

  for (const section of docsSections()) {
    out.push(`## ${section.label}`, '');
    for (const entry of section.links) {
      // a link to a place on a page says what the place is; a page says what it is
      const blurb = entry.href.includes('#') ? '' : entry.page.description;
      out.push(`- [${entry.label}](${link(entry.href)})${blurb ? `: ${blurb}` : ''}`);
    }
    out.push('');
  }

  out.push(
    '## Optional',
    '',
    `- [Every page in one file](${absoluteUrl('/llms-full.txt')}): the Markdown of every page above, concatenated in this order.`,
    `- [Source](${REPO_URL}): the repository, and where to file an issue.`,
    `- [@ttylabs/sigil on npm](https://www.npmjs.com/package/@ttylabs/sigil): ${TAGLINE}`,
    ''
  );

  return out.join('\n');
}

/**
 * `/llms-full.txt`: every docs page's Markdown, in the sidebar's order, each
 * with its own version line, so a page cut out of the file still says what it
 * describes.
 *
 * @returns The file.
 */
export function llmsFullTxt(): string {
  const isPage = pageCheck();
  const header = [
    `# ${SITE_NAME}: every docs page`,
    '',
    `> Every page of the ${SITE_NAME} docs as Markdown, concatenated in the order the site lists them, ${SITE_NAME} v${sigilVersion()}. The index is ${absoluteUrl('/llms.txt')}.`,
    '',
  ].join('\n');

  return [header, ...docsPages().map((page) => pageMarkdown(page, isPage))].join('\n---\n\n');
}
