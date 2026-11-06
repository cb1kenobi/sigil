import { DocsPage } from '@/components/docs-page';
import { InstallCommand } from '@/components/install-command';
import { commandLinks } from '@/lib/docs-sidebar';
import { outline } from '@/lib/markdown-doc';
import { pagerAround } from '@/lib/nav';
import {
  referenceHref,
  referenceLink,
  referenceRepoPath,
  type ReferenceDoc,
} from '@/lib/reference';
import { remarkReferenceTables, remarkUsageTerminal } from '@/lib/reference-blocks';
import { remarkOptionAnchors } from '@/lib/reference-options';

/** What a reference page's markdown adds to a guide's. */
const PLUGINS = [remarkOptionAnchors, remarkReferenceTables, remarkUsageTerminal];

/** A command named in the introduction: mono, without the chip prose gives code. */
const CODE = 'font-mono text-[0.9em] text-fg-strong';

/**
 * What the index says before the root command's own page: what the toolchain
 * is, and the box that starts an app with it.
 *
 * Here and not in `src/reference/index.md`, which `sigil reference` writes and
 * the drift test holds to the schema: the generator documents commands, and
 * this is the site introducing them.
 */
const INTRO = (
  <>
    <p className="lede-docs mt-5">
      <code className={CODE}>sigil</code> is the toolchain a sigil app is made with.{' '}
      <code className={CODE}>new</code> starts one, <code className={CODE}>check</code> and{' '}
      <code className={CODE}>build</code> turn it into a bundle that depends on nothing,{' '}
      <code className={CODE}>package</code> compiles that into a single executable, and{' '}
      <code className={CODE}>add</code> copies a component in for the app to own. An app has it as a
      dev dependency, so none of it ships. Start one straight from the registry:
    </p>
    <div className="mt-6">
      <InstallCommand location="reference" package="cli" variant="title-bar" />
    </div>
  </>
);

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
 * is where a search result for one lands. The usage line is a terminal block
 * and the tables' names and types are marked for their styles
 * (`reference-blocks.ts`), which leaves the committed markdown as GitHub shows it.
 *
 * The index opens with an introduction and the CLI's install box, which the
 * generated page has no place for.
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
      intro={root ? INTRO : undefined}
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
