/**
 * The site's top-level sections: what the header's nav and the phone menu list,
 * and what "the current section" means.
 *
 * Here rather than in the components so the header and the menu cannot come to
 * disagree about either, and so the matching is a function a test can call.
 */

export type Section = 'docs' | 'components' | 'cli' | 'examples';

export interface NavItem {
  section: Section;
  label: string;
  href: string;
}

/** In the order the header shows them. */
export const NAV_ITEMS: readonly NavItem[] = [
  { section: 'docs', label: 'Docs', href: '/docs/getting-started' },
  { section: 'components', label: 'Components', href: '/docs/components' },
  // The generated command reference, `/reference`.
  { section: 'cli', label: 'CLI', href: '/reference' },
  { section: 'examples', label: 'Examples', href: '/examples' },
];

/** The repository, for the header's and the footer's GitHub link. */
export const GITHUB_URL = 'https://github.com/cb1kenobi/sigil';

/**
 * Whether `pathname` is `base` or something under it.
 *
 * On a segment boundary, so `/docs` does not claim `/docs-archive` and
 * `/reference` does not claim `/references`. A trailing slash is the same page.
 */
function under(pathname: string, base: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * Which section a page belongs to, or `undefined` for one that is in none (the
 * home page, a 404).
 *
 * Components are documents under `/docs`, so they are asked first: the Docs
 * item is "the rest of `/docs`", and two items lit at once would say the reader
 * is in two places.
 */
export function activeSection(pathname: string): Section | undefined {
  if (under(pathname, '/docs/components')) {
    return 'components';
  }
  if (under(pathname, '/docs')) {
    return 'docs';
  }
  if (under(pathname, '/reference')) {
    return 'cli';
  }
  if (under(pathname, '/examples')) {
    return 'examples';
  }
  return undefined;
}

/**
 * Whether the page uses the docs layout, which is wider (1440px) than the rest
 * (1280px), and the header follows it so its content lines up with the page's.
 *
 * The command reference is not a docs page: it is a page of its own, and
 * `layout-page` is what it renders in.
 */
export function isDocsPath(pathname: string): boolean {
  return under(pathname, '/docs');
}
