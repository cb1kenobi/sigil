import { GithubLink } from '@/components/github-link';
import { blockComponents, remarkCallouts, textOf } from '@/components/markdown-blocks';
import { remarkBlockStyles } from '@/lib/block-styles';
import { remarkDocPage } from '@/lib/markdown-doc';
import Link from 'next/link';
import type { ComponentProps } from 'react';
import type { ExtraProps, Options } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/** What `react-markdown` hands a component: the element's props and the node. */
type Renderer<T extends keyof React.JSX.IntrinsicElements> = ComponentProps<T> & ExtraProps;

/**
 * A heading, with a link to itself that shows on hover and on focus.
 *
 * The anchor is the heading's `id`, which `remarkDocPage()` settled from the
 * text. The link is a sibling of the text rather than wrapped around it, so the
 * heading reads as itself and the `#` is the only thing that is a link; its
 * name says which section it is the link to, since a bare "#" says nothing to a
 * list of links.
 *
 * `scroll-mt` is the distance a jump to an anchor leaves above the heading, and
 * the rail's idea of where a section starts (`LINE` in `docs-rail.tsx`) is built
 * on it: both clear the 65px header with room to spare.
 */
function heading(Tag: 'h2' | 'h3') {
  return function Heading({ children, id, node, ...rest }: Renderer<'h2'>) {
    return (
      <Tag {...rest} id={id} className="group scroll-mt-24">
        {children}
        {id ? (
          <a
            href={`#${id}`}
            aria-label={`Link to ${node ? textOf(node) : 'this section'}`}
            className="ml-2 font-mono text-[0.8em] font-normal text-dim no-underline opacity-0 transition-opacity group-hover:opacity-100 hover:text-link focus-visible:opacity-100"
          >
            #
          </a>
        ) : null}
      </Tag>
    );
  };
}

/**
 * An internal link goes through `Link`, so following it does not reload the page.
 *
 * A link marked `<!-- as github -->` is the GitHub button, which is
 * `GithubLink` with its visible text: `remarkBlockStyles()` has already checked
 * that it goes to the repository, which is the one place `GithubLink` goes.
 */
function anchor(resolve: (href: string | undefined) => string | undefined) {
  return function Anchor({ href, node, ...rest }: Renderer<'a'>) {
    if (node?.properties.dataButton === 'github') {
      return (
        <GithubLink location="about" name={textOf(node)} className="github-button h-11 w-fit px-4">
          <span>{rest.children}</span>
        </GithubLink>
      );
    }

    const to = resolve(href);

    return to?.startsWith('/') && !to.startsWith('//') ? (
      <Link href={to} {...rest} />
    ) : (
      <a href={to} {...rest} />
    );
  };
}

/**
 * A page of markdown, drawn as a docs page's content.
 *
 * Fences are code and terminal blocks and `> [!NOTE]` is a callout
 * (`markdown-blocks.tsx`), a block after `<!-- as … -->` is drawn in that style
 * (`block-styles.ts`); the title is not drawn, because the layout draws it,
 * and the paragraph after it is the lede (`remarkDocPage()`).
 *
 * `remark-gfm` is not optional. A guide's options and a reference's arguments
 * are GFM tables, and without it they render as paragraphs of pipes.
 *
 * @param props.source - The markdown, title included.
 * @param props.link - Where a relative link in it goes on this site.
 * @param props.plugins - Remark plugins a kind of page adds after these: the command reference's
 *   option anchors.
 * @param props.wide - The About page's type: its `h2`s at `about-h2` rather than `docs-h2`.
 */
export function DocsMarkdown({
  link,
  plugins,
  source,
  wide = false,
}: {
  link: (href: string | undefined) => string | undefined;
  plugins?: Options['remarkPlugins'];
  source: string;
  wide?: boolean;
}) {
  return (
    <article className={wide ? 'prose-sigil prose-wide min-w-0' : 'prose-sigil min-w-0'}>
      <Markdown
        components={{
          ...blockComponents,
          a: anchor(link),
          h2: heading('h2'),
          h3: heading('h3'),
          // the overflow is the wrapper's, because `display: block` on a
          // `<table>` takes it out of the accessibility tree
          table: ({ children, node: _node, ...rest }: Renderer<'table'>) => (
            <div className="table-scroll">
              <table {...rest}>{children}</table>
            </div>
          ),
        }}
        remarkPlugins={[
          remarkGfm,
          remarkCallouts,
          remarkDocPage,
          remarkBlockStyles,
          ...(plugins ?? []),
        ]}
      >
        {source}
      </Markdown>
    </article>
  );
}
