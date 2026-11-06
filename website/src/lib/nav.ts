import { COMPONENTS_HREF, FAMILIES, familyHref } from './components.ts';

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
  { section: 'components', label: 'Components', href: COMPONENTS_HREF },
  // The generated command reference, `/reference`.
  { section: 'cli', label: 'CLI', href: '/reference' },
  { section: 'examples', label: 'Examples', href: '/examples' },
];

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
  if (under(pathname, COMPONENTS_HREF)) {
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
 * The command reference is in it: its pages have the sidebar and the rail, so
 * they are as wide as the guides are, even though the address is `/reference`
 * and not under `/docs` (SIG-260). The components index is not, though it is
 * under `/docs`: it is a page with no sidebar, 1280px wide (SIG-263), and a
 * header 160px wider than the page under it would line up with nothing. The
 * component pages under it have the sidebar again, and are in.
 */
export function isDocsPath(pathname: string): boolean {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
  if (path === COMPONENTS_HREF) {
    return false;
  }
  return under(pathname, '/docs') || under(pathname, '/reference');
}

/**
 * The guides in `packages/sigil/docs/`, in the order they are read.
 *
 * Here and not discovered from the directory, because the order is the Previous
 * and Next cards and the sidebar's, and a directory listing is alphabetical.
 * `test/guides.test.ts` fails on a guide that is in the directory and not in
 * this list, so adding one is a decision about where it goes rather than
 * something that happens by dropping a file.
 */
export const GUIDE_SLUGS = ['getting-started', 'full-screen-apps', 'parser'] as const;

/** The route of a guide. */
export function guideHref(slug: string): string {
  return `/docs/${slug}`;
}

/** One link in the sidebar. */
export interface SidebarLink {
  label: string;
  /** A path, with a `#fragment` for a place on a page rather than a page. */
  href: string;
  /** Set in the mono face, for a command. */
  mono?: boolean;
}

/** A labelled group of links in the sidebar. */
export interface SidebarSection {
  /** What the section is, for a key and for a test; not shown. */
  id: 'docs' | 'parser' | 'cli' | 'components' | 'about';
  label: string;
  links: SidebarLink[];
}

/** What the sidebar is built from: the parts that are read off disk. */
export interface SidebarSource {
  /** The commands of the generated reference, in the order they are listed. */
  commands: readonly SidebarLink[];
  /** The guides, in reading order. */
  guides: readonly SidebarLink[];
  /** The sections of the parser reference. */
  parser: readonly SidebarLink[];
}

/**
 * The docs sidebar: the one definition of what is in it and in what order.
 *
 * What is read off disk is handed in, so that this file stays something the
 * client can import -- the header and the phone menu already do -- and what is
 * written here is what is not on disk: the Components and About links go to
 * pages other tickets build (SIG-263, SIG-264, SIG-266), and are in the sidebar
 * now because a sidebar that gains a section the day each page lands is one
 * whose layout moves under a reader.
 *
 * @param source - The guides, the parser's sections and the commands.
 * @returns The sections, in order.
 */
export function sidebarSections(source: SidebarSource): SidebarSection[] {
  return [
    { id: 'docs', label: 'Docs', links: [...source.guides] },
    { id: 'parser', label: 'Parser', links: [...source.parser] },
    { id: 'cli', label: 'CLI', links: source.commands.map((link) => ({ ...link, mono: true })) },
    {
      id: 'components',
      label: 'Components',
      links: [
        // the families, as the index's sections, from the one list of them
        ...FAMILIES.map((family) => ({ label: family.title, href: familyHref(family.id) })),
        { label: 'All components', href: COMPONENTS_HREF },
      ],
    },
    { id: 'about', label: 'About', links: [{ label: 'The story of sigil', href: '/docs/about' }] },
  ];
}

/**
 * Whether a sidebar link is the page the reader is on.
 *
 * Only a link to a **page** can be: one with a `#fragment` points at a place on
 * a page, and marking it `aria-current="page"` would say a section is a page.
 * A trailing slash is the same page.
 *
 * @param link - The sidebar link.
 * @param pathname - The current path.
 * @returns Whether it is current.
 */
export function isCurrentLink(link: SidebarLink, pathname: string): boolean {
  if (link.href.includes('#')) {
    return false;
  }
  const path = pathname.length > 1 ? pathname.replace(/\/+$/u, '') : pathname;
  return path === link.href;
}

/** The card at either end of a page: where it goes and what it is called. */
export interface PagerLink {
  title: string;
  href: string;
}

/**
 * The pages either side of one, within its own section.
 *
 * Within the section and not across the whole sidebar: the sidebar names pages
 * that do not exist yet, and a Next card that led to one would be a 404 with a
 * link to it on every guide. A section's pages are all real, so the first has
 * no Previous and the last has no Next; the sections join up as the pages that
 * would join them land.
 *
 * @param links - The section's page links, in order.
 * @param href - The current page.
 * @returns Either side, and nothing where there is no page.
 */
export function pagerAround(
  links: readonly SidebarLink[],
  href: string
): { previous?: PagerLink; next?: PagerLink } {
  const at = links.findIndex((link) => link.href === href);
  const card = (link: SidebarLink | undefined): PagerLink | undefined =>
    link === undefined ? undefined : { title: link.label, href: link.href };

  return at === -1 ? {} : { previous: card(links[at - 1]), next: card(links[at + 1]) };
}
