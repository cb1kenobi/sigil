import { referenceDocs, type ReferenceDoc } from '@/lib/reference';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import type { ExtraProps } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** What `react-markdown` hands a component: the element's props and the node. */
type Renderer<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps;

/**
 * The route one page's slug is at.
 *
 * One function, because the nav and the links inside a page are two readers of
 * "where is this page" and they came to disagree: the nav interpolated the slug
 * raw, so a command called `go#x` -- a legal route whose page is `go#x.md` --
 * gave `/reference/go#x`, which a URL parser reads as `/reference/go` with a
 * fragment of `#x`. `?` is the same one query along. The links inside a page had
 * just been taught to encode and the nav had not. Measured. Found by review.
 *
 * @param slug - The page's slug, which is its file name without the extension.
 * @returns The route.
 */
export function referenceHref(slug: string): string {
  return slug === 'index' ? '/reference' : `/reference/${encodeURIComponent(slug)}`;
}

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
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-10 px-6 py-12 sm:flex-row">
      <nav aria-label="Commands" className="w-full shrink-0 text-sm sm:w-56">
        <p className="mb-3 font-semibold text-zinc-500 dark:text-zinc-400">Commands</p>
        <ul className="space-y-1">
          {docs.map((it) => (
            <li key={it.slug} style={{ paddingLeft: `${it.path.length * 0.75}rem` }}>
              <Link
                // `aria-current` as well as the weight and the colour, so which
                // page this is reaches a reader who is not looking at either
                aria-current={it.slug === doc.slug ? 'page' : undefined}
                className={
                  it.slug === doc.slug
                    ? 'font-medium text-black dark:text-zinc-50'
                    : 'text-zinc-600 hover:text-black dark:text-zinc-400 dark:hover:text-zinc-50'
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
