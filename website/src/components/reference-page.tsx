import { referenceDocs, referenceHref, type ReferenceDoc } from '@/lib/reference';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import type { ExtraProps } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** What `react-markdown` hands a component: the element's props and the node. */
type Renderer<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps;

/**
 * Where a generated link points on this site.
 *
 * The generator links a page to a **file** -- `add.md`, `index.md` -- because
 * that is what a directory of pages is, and a route here is `/reference/add`.
 * Left alone, every link in a subcommand table resolved to `/reference/add.md`,
 * whose slug is `add.md`, which `referenceDoc()` does not find: `notFound()`.
 * So every link off the index 404'd. Measured. Found by review.
 *
 * Only a relative `.md` is rewritten, so an absolute or external href a page
 * might hold one day is left as it was.
 *
 * @param href - What the markdown said.
 * @returns Where it goes.
 */
function routed(href: string | undefined): string | undefined {
  if (href === undefined || !href.endsWith('.md') || /^[a-z]+:|^\//iu.test(href)) {
    return href;
  }

  return referenceHref(decodeURIComponent(href.slice(0, -'.md'.length)));
}

/**
 * One page of the generated command reference, with the nav beside it.
 *
 * The nav is built from the front matter -- `title` for the label and `path` for
 * the depth -- which is the half that says the generated shape is consumable:
 * a page a site can only render is a page, and a page a site can also *index*
 * is a reference.
 *
 * `remark-gfm` is not optional here. Every argument and option list is a GFM
 * table, so without it they render as paragraphs of pipes.
 */
export function ReferencePage({ doc }: { doc: ReferenceDoc }) {
  const docs = referenceDocs();

  return (
    // `flex-col` below `sm` rather than `hidden`, which is what the nav was: the
    // subcommand table was then the only way off the index on a phone, and
    // every link in it 404'd. Found by review
    <div className="layout-docs flex flex-1 flex-col gap-10 py-12 sm:flex-row">
      <nav aria-label="Commands" className="text-small w-full shrink-0 sm:w-56">
        <p className="sidebar-label mb-3">Commands</p>
        <ul className="space-y-1">
          {docs.map((it) => (
            <li key={it.slug} style={{ paddingLeft: `${it.path.length * 0.75}rem` }}>
              <Link
                // `aria-current` as well as the weight and the colour, so which
                // page this is reaches a reader who is not looking at either
                aria-current={it.slug === doc.slug ? 'page' : undefined}
                className={
                  it.slug === doc.slug ? 'font-medium text-link' : 'text-muted hover:text-fg-strong'
                }
                href={referenceHref(it.slug)}
              >
                <code>{it.title}</code>
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <article className="prose-sigil min-w-0 flex-1">
        <Markdown
          components={{
            // `node` is dropped rather than spread: `react-markdown` passes the
            // mdast node into every component, and spreading it put
            // `node="[object Object]"` on the element -- measured in the
            // rendered HTML. Found by review
            a: ({ href, node: _node, ...rest }: Renderer<'a'>) => (
              <a href={routed(href)} {...rest} />
            ),
            // the overflow is the wrapper's, because `display: block` on a
            // `<table>` takes it out of the accessibility tree
            table: ({ children, node: _node, ...rest }: Renderer<'table'>) => (
              <div className="table-scroll">
                <table {...rest}>{children}</table>
              </div>
            ),
          }}
          remarkPlugins={[remarkGfm]}
        >
          {doc.body}
        </Markdown>
      </article>
    </div>
  );
}
