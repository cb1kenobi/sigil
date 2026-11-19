import { COMPONENTS, COMPONENTS_HREF, componentHref } from './components.ts';
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
 * - a component's own source file, `../src/components/list-view.ts`, is that
 *   component's page, when the file is named after a component and the link
 *   carries no fragment. On GitHub the same link opens the file the page is
 *   generated from, so it is true in both places; a link with a fragment, such
 *   as a line, means the source and stays on GitHub.
 * - the directory those files are in, `../src/components/`, is the components
 *   index, with or without its trailing slash and, as above, without a
 *   fragment. GitHub shows the directory as a list of the files, one per
 *   component and the helpers beside them, so "see all the components" is
 *   true there too, and it is the only spelling of the index that is: an
 *   absolute `/docs/components` is a path GitHub cannot follow, and the link
 *   check refuses it.
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

/** Where the components' source files are, each named after its page. */
const COMPONENT_SOURCES = 'packages/sigil/src/components';

/**
 * @param href - What the markdown said.
 * @param from - The directory of the file it is in, from the repository's root: a guide's by
 *   default, and `docs` for About, which is `docs/about.md`.
 * @returns Where it goes.
 */
export function guideLink(href: string | undefined, from: string = FROM): string | undefined {
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
  const resolved = posix.join(from, path);
  const slug = posix.basename(resolved, '.md');

  if (posix.dirname(resolved) === FROM && resolved.endsWith('.md') && isGuide(slug)) {
    return `${guideHref(slug)}${fragment}`;
  }

  const component = posix.basename(resolved, '.ts');
  if (
    fragment === '' &&
    posix.dirname(resolved) === COMPONENT_SOURCES &&
    resolved.endsWith('.ts') &&
    COMPONENTS.some((entry) => entry.slug === component)
  ) {
    return componentHref(component);
  }

  if (fragment === '' && resolved.replace(/\/$/u, '') === COMPONENT_SOURCES) {
    return COMPONENTS_HREF;
  }

  return `${repoFileUrl(resolved.replace(/\/$/u, ''))}${fragment}`;
}

function isGuide(slug: string): boolean {
  return (GUIDE_SLUGS as readonly string[]).includes(slug);
}
