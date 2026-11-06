import { GUIDE_SLUGS, guideHref } from './nav.ts';
import { repoFileUrl } from './site.ts';
import { posix } from 'node:path';

/**
 * Where a link in a guide goes on this site.
 *
 * A guide is written to be read on GitHub, so its links are relative paths
 * between files: `parser.md#commands` to a sibling, `../README.md#typed-argv` to
 * the package's README. `markdown-links.test.ts` is what keeps those true there.
 * Here a file is a route or it is not, and which of the two decides what the
 * link becomes:
 *
 * - another guide is its page, with the fragment kept. The fragment is a
 *   heading's anchor and the site slugs headings as that test does, so one the
 *   test accepts is one that lands.
 * - anything else in the repository -- a README, the toolchain's own README, a
 *   source file -- is that file on GitHub, on `main`.
 * - a fragment on its own, an absolute URL and a `mailto:` are left as written.
 *
 * Left alone rather than rewritten, a `../README.md#typed-argv` would resolve
 * against `/docs/getting-started` as `/README.md`, which is a 404 that no test
 * on the guides would see.
 */

/** Where the guides are in the repository, which relative links resolve from. */
const FROM = 'packages/sigil/docs';

/**
 * @param href - What the markdown said.
 * @returns Where it goes.
 */
export function guideLink(href: string | undefined): string | undefined {
  if (
    href === undefined ||
    href === '' ||
    href.startsWith('#') ||
    /^[a-z][a-z\d+.-]*:/iu.test(href)
  ) {
    return href;
  }
  // `//host/path` is a URL with the scheme left off, and a path that starts
  // with `/` means something different on GitHub and on npm: neither is ours
  if (href.startsWith('/')) {
    return href;
  }

  const hash = href.indexOf('#');
  const path = decodeURI(hash === -1 ? href : href.slice(0, hash));
  const fragment = hash === -1 ? '' : href.slice(hash);
  const resolved = posix.join(FROM, path);
  const slug = posix.basename(resolved, '.md');

  if (posix.dirname(resolved) === FROM && resolved.endsWith('.md') && isGuide(slug)) {
    return `${guideHref(slug)}${fragment}`;
  }

  return `${repoFileUrl(resolved.replace(/\/$/u, ''))}${fragment}`;
}

function isGuide(slug: string): boolean {
  return (GUIDE_SLUGS as readonly string[]).includes(slug);
}
