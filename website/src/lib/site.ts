/**
 * What the site calls itself and where it lives, in one file.
 *
 * `llms.txt`, the sitemap, `robots.txt`, the canonical URLs, the structured
 * data and the README all read these, so that settling the domain is a
 * one-line change here and nothing else.
 */

export const SITE_NAME = 'sigil';

/**
 * The production origin, with no trailing slash and no path.
 *
 * **A placeholder until SIG-271 settles the domain.** `ttylabs.dev` is the likely
 * one, and whether sigil sits at its root or at `sigil.ttylabs.dev` is still
 * open; either is a change to this line and to nothing that reads it. It is
 * also what makes `isIndexableHost()` say yes, so until the real domain is set
 * here, a deployment on it is treated as a preview: closed to crawlers, with no
 * sitemap. That is the safe way round to be wrong.
 */
export const SITE_URL = 'https://ttylabs.dev';

/** The repository, for the structured data and anything else that links to the source. */
export const REPO_URL = 'https://github.com/cb1kenobi/sigil';

/** The branch every link into the repository points at. */
export const REPO_BRANCH = 'main';

/**
 * A file in the repository, on `main`.
 *
 * What "Edit on GitHub" and a link out of a guide to the README it was written
 * beside are built from, so the repository's address and its branch are spelled
 * in this file and nowhere else.
 *
 * @param path - The file or directory, relative to the repository root, `/`-separated.
 * @returns Its address on GitHub.
 */
export function repoFileUrl(path: string): string {
  return `${REPO_URL}/blob/${REPO_BRANCH}/${path}`;
}

/** Where a reader reports a problem with a page. */
export const REPO_NEW_ISSUE_URL = `${REPO_URL}/issues/new`;

/** What sigil is in one line: the social cards' tagline and the site's description. */
export const TAGLINE = 'Command-line apps in TypeScript, with nothing else to install.';

/** The home page's title, which is also the default for any route that sets none. */
export const HOME_TITLE = 'sigil: command-line apps in TypeScript';

/** Every other page's title is its own, followed by the site's name. */
export const TITLE_TEMPLATE = `%s · ${SITE_NAME}`;

/**
 * A page's title as the template renders it, for the places the template does
 * not reach: Open Graph and Twitter fields are plain strings, not metadata that
 * gets a template applied.
 *
 * @param title - The page's own title, or nothing for the home page.
 * @returns What the tab, the card and the search result should all say.
 */
export function fullTitle(title?: string): string {
  return title === undefined ? HOME_TITLE : TITLE_TEMPLATE.replace('%s', title);
}

/**
 * The address of a path on the production site.
 *
 * Absolute on purpose: a sitemap and structured data cannot be relative, and
 * resolving against the production origin rather than the request's is what
 * keeps a preview's canonical pointing at the page that should rank.
 *
 * @param path - A path starting with `/`.
 * @returns The URL. The home page has no trailing slash, as a canonical does.
 */
export function absoluteUrl(path: string): string {
  return path === '/' ? SITE_URL : `${SITE_URL}${path}`;
}

/**
 * Whether a request's `Host` header identifies the production site.
 *
 * **Keyed on the host, and that is a different question from
 * `isProductionDeploy()` in `analytics-env.ts`.** That one asks whether _this
 * build_ is the production deployment, from `VERCEL_ENV`, and answers it once at
 * build time to refuse a build that is missing its analytics variables. This
 * one asks whether _this request_ is for the public address, and answers it per
 * request: a preview deployment, a `*.vercel.app` URL, a custom domain pointed
 * at a branch and `localhost` are all hosts that are not the production host,
 * and the production deployment is reachable at some of them too (the project's
 * own `*.vercel.app` URL), where `VERCEL_ENV` says `production` and the page
 * still must not compete with the real one. The two agree wherever both apply,
 * which is why neither needs the other.
 *
 * Exactly one host is indexable, the one `SITE_URL` names. A `www.` or any other
 * alias is not, since an alias that is crawlable is a second copy of the site.
 *
 * @param host - The `Host` header: a name and optionally a port.
 * @returns Whether to let crawlers in.
 */
export function isIndexableHost(host: string | null | undefined): boolean {
  if (!host) {
    return false;
  }

  // a port is not part of the name, and a trailing dot is a legal spelling of it
  const name = host.split(':')[0]?.toLowerCase().replace(/\.$/, '');
  return name === new URL(SITE_URL).hostname;
}
