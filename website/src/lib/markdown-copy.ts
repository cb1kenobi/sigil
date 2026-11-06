/**
 * Where a docs page's Markdown copy is, and when a request is asking for it
 * (SIG-267).
 *
 * Every page under `/docs` and `/reference` has one, at its own address plus
 * `.md`, and the page's own address answers with it for a request whose
 * `Accept` header prefers `text/markdown`. Both are said here and nowhere else,
 * because three readers have to agree on them: `proxy.ts`, which negotiates,
 * `seo.ts`, which puts the `alternate` link in each page's head, and `llms.ts`,
 * which writes the addresses into `llms.txt`.
 *
 * Imported by the proxy, so it reads no file and imports nothing that does.
 */

import { SITE_URL, isIndexableHost } from './site.ts';

/** The prefixes whose pages have a Markdown copy. */
const ROOTS = ['/docs', '/reference'] as const;

/**
 * Whether a path is a docs page's, and so has a Markdown copy beside it.
 *
 * On a segment boundary, as `nav.ts` matches a section, so `/docs-archive` is
 * not one. Whether the page itself exists is the route's question: this is
 * about which addresses are offered, and a path that is no page is a 404 in
 * either form.
 *
 * @param path - A pathname, with no `.md`.
 * @returns Whether it is under `/docs` or `/reference`.
 */
export function hasMarkdownCopy(path: string): boolean {
  return ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * A docs page's Markdown address: its own, plus `.md`.
 *
 * A trailing slash is the same page, so it is dropped rather than giving
 * `/docs/parser/.md`.
 *
 * @param path - The page's path, starting with `/`.
 * @returns The `.md` path.
 */
export function markdownHref(path: string): string {
  return `${path.replace(/\/+$/u, '')}.md`;
}

/** One media range of an `Accept` header. */
interface Range {
  /** `type/subtype`, lowercase. */
  readonly type: string;
  /** Its weight, 0 to 1. */
  readonly q: number;
  /** Where it was in the header, for a tie. */
  readonly at: number;
}

/** The media ranges of an `Accept` header, malformed weights read as 1. */
function ranges(accept: string): Range[] {
  return accept.split(',').map((part, at) => {
    const [type = '', ...params] = part.split(';').map((it) => it.trim());
    const weight = params.find((param) => /^q\s*=/iu.test(param));
    const q = weight === undefined ? 1 : Number(weight.split('=')[1]);

    return {
      type: type.toLowerCase(),
      q: Number.isFinite(q) ? Math.min(Math.max(q, 0), 1) : 1,
      at,
    };
  });
}

/**
 * Whether an `Accept` header prefers Markdown to HTML.
 *
 * **Markdown has to be named.** A browser sends a wildcard and a fetch library
 * sends nothing at all, and both get the page they always got; only a client
 * that says `text/markdown` is asking for it. Then it wins when it weighs more
 * than HTML does -- HTML's weight being `text/html`'s if that is named, else
 * the weight of `text/*` or of the any-type wildcard -- and a tie goes to
 * whichever the client named, or listed first where it named both. So
 * `text/markdown, text/html;q=0.9` and `text/markdown` beside a wildcard are
 * Markdown, `text/html, text/markdown` is HTML, and `text/markdown;q=0` is a
 * refusal of it. `test/markdown-copy.test.ts` has the cases.
 *
 * Not a substring test, which is what a `has` rule in `next.config.ts` can do:
 * that answers Markdown to `text/html, text/markdown;q=0.1`, a client that said
 * it would rather have HTML.
 *
 * @param accept - The header, if there is one.
 * @returns Whether to answer with the Markdown copy.
 */
export function prefersMarkdown(accept: string | null | undefined): boolean {
  if (!accept) {
    return false;
  }

  const all = ranges(accept);
  const markdown = all.find((range) => range.type === 'text/markdown');
  if (!markdown || markdown.q === 0) {
    return false;
  }

  const html = all.find((range) => range.type === 'text/html');
  if (html) {
    return markdown.q > html.q || (markdown.q === html.q && markdown.at < html.at);
  }

  const wildcard =
    all.find((range) => range.type === 'text/*') ?? all.find((range) => range.type === '*/*');
  return markdown.q >= (wildcard?.q ?? 0);
}

/**
 * The cache policy of every file in the corpus: ten minutes in a browser, an
 * hour at the edge, and a day of serving the last copy while a new one is
 * fetched. titaniumsdk.com's, for the same reason: the files change only when a
 * deploy replaces them, so a stale one is never wrong for long and nobody waits
 * on a miss.
 */
export const CORPUS_CACHE_CONTROL =
  'public, max-age=600, s-maxage=3600, stale-while-revalidate=86400';

/** The files that are published on the production host and nowhere else, besides the `.md` copies. */
const PRODUCTION_ONLY = new Set(['/sitemap.xml', '/llms.txt', '/llms-full.txt']);

/** What `proxy.ts` does with a request. */
export type ProxyAnswer =
  /** Serve it as the route would. */
  | { readonly pass: true }
  /** Answer 404 with this text. */
  | { readonly notFound: string }
  /** Serve this path instead: a page's Markdown copy, for a client that asked for one. */
  | { readonly rewrite: string };

/**
 * What the proxy does with a request, as a function a test can call.
 *
 * Three rules, in order:
 *
 * - `/md/...` is the `.md` rewrite's destination, and is never an address: a
 *   request that names it is refused, so each document keeps one. The proxy
 *   runs before `next.config.ts`'s rewrites, so it only ever sees the path that
 *   was asked for -- `/docs/parser.md`, not where that was sent.
 * - The sitemap, `llms.txt`, `llms-full.txt` and every `.md` copy exist on the
 *   production host and are a 404 everywhere else: a sitemap is a list of
 *   production addresses a preview has no business offering, and a corpus on a
 *   preview is one nothing tells a model not to read. `robots.txt` shares
 *   `isIndexableHost()` with this, so the two cannot disagree about which host
 *   that is. Answering here keeps every one of those routes static.
 * - A docs page asked for with an `Accept` that prefers Markdown is its copy,
 *   on the production host. Off it the copy does not exist, so the page is what
 *   there is.
 *
 * **The Markdown says `Vary: Accept` and the HTML cannot.** Next's app-page
 * runtime sets a page's `Vary` outright (`res.setHeader`, in
 * `app-page-runtime.js`), over whatever the proxy or `next.config.ts` set, so a
 * page's own HTML never names `Accept`. The direction that matters is still
 * covered: the Markdown answer at a page's address carries `Vary: Accept` from
 * its route, so no cache hands it to a browser, and the worst a cache that kept
 * the HTML can do is give an agent the page instead of its copy, which the
 * `.md` address and the `alternate` link are there for. Measured with
 * `next start`; the proxy runs ahead of Vercel's cache, so there the rewritten
 * request is cached at the Markdown's own path.
 *
 * @param request - What was asked for.
 * @param request.pathname - The path, as asked for.
 * @param request.host - The `Host` header.
 * @param request.accept - The `Accept` header.
 * @returns What to do.
 */
export function proxyAnswer({
  pathname,
  host,
  accept,
}: {
  pathname: string;
  host: string | null;
  accept: string | null;
}): ProxyAnswer {
  if (pathname === '/md' || pathname.startsWith('/md/')) {
    return { notFound: 'Not found.\n' };
  }

  const production = isIndexableHost(host);
  const copy = pathname.endsWith('.md') && hasMarkdownCopy(pathname.slice(0, -'.md'.length));

  if (copy || PRODUCTION_ONLY.has(pathname)) {
    return production
      ? { pass: true }
      : { notFound: `Not found. This is published on ${new URL(SITE_URL).host} only.\n` };
  }

  return production && hasMarkdownCopy(pathname) && prefersMarkdown(accept)
    ? { rewrite: `/md${pathname.replace(/\/+$/u, '')}` }
    : { pass: true };
}
