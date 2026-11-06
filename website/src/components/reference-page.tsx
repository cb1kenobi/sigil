import { DocsPage } from '@/components/docs-page';
import { commandLinks } from '@/lib/docs-sidebar';
import { outline } from '@/lib/markdown-doc';
import { pagerAround } from '@/lib/nav';
import {
  referenceHref,
  referenceLink,
  referenceRepoPath,
  type ReferenceDoc,
} from '@/lib/reference';
import { remarkOptionAnchors } from '@/lib/reference-options';

/** What a reference page's markdown adds to a guide's. */
const PLUGINS = [remarkOptionAnchors];

/**
 * One page of the generated command reference, in the docs layout.
 *
 * The nav is the layout's, built from each page's front matter -- `title` for
 * the label and `path` for the order -- which is the half that says the
 * generated shape is consumable: a page a site can only render is a page, and a
 * page a site can also *index* is a reference. The rail is the page's own `h2`s
 * (Usage, Arguments, Options), found the way a guide's are.
 *
 * `remark-gfm` is not optional here. Every argument and option list is a GFM
 * table, so without it they render as paragraphs of pipes -- and it is in
 * `DocsMarkdown`, which is what this renders through.
 *
 * Each option's row is its own anchor, `#--out` (`remarkOptionAnchors()`), which
 * is where a search result for one lands.
 *
 * "Edit on GitHub" points at the generated page, which is the file the page is
 * made from; a change made there is overwritten by the next `sigil reference`,
 * and the page's own text says where the generator is.
 */
export function ReferencePage({ doc }: { doc: ReferenceDoc }) {
  const href = referenceHref(doc.slug);
  const { headings } = outline(doc.body);
  const root = doc.slug === 'index';

  return (
    <DocsPage
      crumbs={
        root
          ? [{ label: 'CLI' }]
          : [{ label: 'CLI', href: referenceHref('index') }, { label: doc.title }]
      }
      headings={headings.filter((it) => it.depth === 2 && it.id !== '')}
      link={referenceLink}
      mono
      pager={pagerAround(commandLinks(), href)}
      plugins={PLUGINS}
      repoPath={referenceRepoPath(doc.slug)}
      source={doc.body}
      title={doc.title}
    />
  );
}
