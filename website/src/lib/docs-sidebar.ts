import { guides } from './guides.ts';
import { guideHref, sidebarSections, type SidebarLink, type SidebarSection } from './nav.ts';
import { referenceDocs, referenceHref } from './reference.ts';

/**
 * What the sidebar is built from, read off disk.
 *
 * The half of `sidebarSections()` that is not in `nav.ts`, because it reads
 * files and `nav.ts` is imported by the header, which is a client component.
 */

/** The guides' links, in reading order. */
export function guideLinks(): SidebarLink[] {
  return guides().map((guide) => ({ label: guide.title, href: guideHref(guide.slug) }));
}

/** The commands' links, in the order of the commands they document. */
export function commandLinks(): SidebarLink[] {
  return referenceDocs().map((doc) => ({ label: doc.title, href: referenceHref(doc.slug) }));
}

/**
 * The parser reference's sections, as links to them.
 *
 * Every `h2` of `parser.md`, so the sidebar and the rail say the same sixteen
 * things, and a heading renamed in the guide is renamed here with it.
 */
export function parserLinks(): SidebarLink[] {
  const parser = guides().find((guide) => guide.slug === 'parser');

  return (parser?.sections ?? [])
    .filter((section) => section.id !== '')
    .map((section) => ({ label: section.text, href: `${guideHref('parser')}#${section.id}` }));
}

/** The whole sidebar. */
export function docsSidebar(): SidebarSection[] {
  return sidebarSections({
    commands: commandLinks(),
    guides: guideLinks(),
    parser: parserLinks(),
  });
}
