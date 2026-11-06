import { Callout } from '@/components/callout';
import { CodeBlock } from '@/components/code-block';
import type { CopyEvent } from '@/components/copy-button';
import { InstallCommand } from '@/components/install-command';
import { Seal } from '@/components/seal';
import { TerminalBlock } from '@/components/terminal-block';
import { readFence, type CopyEventName } from '@/lib/fence';
import { sigilVersion } from '@/lib/includes';
import { consoleRows, shellRows, type Lookup } from '@/lib/terminal-rows';
import { lookup } from '@/lib/transcripts';
import type { Element, ElementContent } from 'hast';
import type { Blockquote, Root, RootContent } from 'mdast';
import type { ReactNode } from 'react';
import type { Components, ExtraProps } from 'react-markdown';

/**
 * The markdown hook: what a docs page's fenced blocks and notes are drawn as.
 *
 * Handed to `react-markdown` as `components` beside whatever a page overrides
 * for itself, so every page that renders markdown draws a fence the same way --
 * the command reference now, and the guides once they are on the site:
 *
 * ```tsx
 * <Markdown components={{ ...blockComponents, a: ... }} remarkPlugins={[remarkGfm, remarkCallouts]}>
 * ```
 *
 * `fence.ts` decides what each fence is; this only draws it.
 */

/** What a callout is drawn with on its left: the seal, in the brand colour. */
const CALLOUT_ICON: ReactNode = <Seal size={18} className="text-brand" />;

/** The captured transcripts, read once per build rather than once per block. */
let captured: Lookup | undefined;

/** What `react-markdown` hands a component: the element's props and the node. */
type Renderer<T extends keyof React.JSX.IntrinsicElements> = React.ComponentProps<T> & ExtraProps;

/**
 * The text of a hast node, which for a fence is the code exactly as written.
 *
 * @param node - The node.
 * @returns Its text.
 */
export function textOf(node: ElementContent): string {
  if (node.type === 'text') {
    return node.value;
  }
  return node.type === 'element' ? node.children.map(textOf).join('') : '';
}

/**
 * A fenced block, as the component `fence.ts` says it is.
 *
 * `react-markdown` renders a fence as `<pre><code class="language-ts">`, and
 * the `pre` is the element to replace: replacing `code` would leave a `<pre>`
 * around a block that is not one. The language is the class, and what follows
 * it on the fence line is on the code element as `data.meta`, which is where
 * `mdast-util-to-hast` leaves it.
 */
function Fenced({ children, node }: Renderer<'pre'>) {
  const code = node?.children.find((child): child is Element => child.type === 'element');

  if (!code || code.tagName !== 'code') {
    return <pre>{children}</pre>;
  }

  const classes = code.properties.className;
  const lang = (Array.isArray(classes) ? classes : [])
    .map(String)
    .find((name) => name.startsWith('language-'))
    ?.slice('language-'.length);
  const meta = (code.data as { meta?: string } | undefined)?.meta;
  // markdown ends a fence's text with the newline before the closing fence
  const body = textOf(code).replace(/\n$/u, '');
  const fence = readFence(lang, meta, body);

  if (fence.kind === 'code') {
    return (
      <CodeBlock
        code={fence.code}
        event={fence.event ? copyEvent(fence.event) : undefined}
        lang={fence.lang}
        title={fence.title}
      />
    );
  }

  if (fence.kind === 'install') {
    // the margin a terminal block has, so the box sits in the text as one does
    return (
      <div className="mt-4">
        <InstallCommand location={fence.location} package={fence.package} variant="title-bar" />
      </div>
    );
  }

  if (fence.kind === 'shell') {
    return (
      <TerminalBlock
        copy={fence.text}
        cwd={fence.cwd}
        language={lang}
        rows={shellRows(fence.text)}
      />
    );
  }

  captured ??= lookup();
  return <TerminalBlock cwd={fence.cwd} language={lang} rows={consoleRows(fence.text, captured)} />;
}

/**
 * A copy event with its properties, which are the server's to know: the
 * instructions' version is the one this build read from `packages/sigil`.
 */
function copyEvent(name: CopyEventName): CopyEvent {
  switch (name) {
    case 'agent_instructions_copied':
      return { name, properties: { version: sigilVersion() } };
  }
}

/** A blockquote, or a callout when `remarkCallouts` marked it as one. */
function Quote({ children, node, ...rest }: Renderer<'blockquote'>) {
  if (node?.properties.dataCallout !== undefined) {
    return <Callout icon={CALLOUT_ICON}>{children}</Callout>;
  }
  return <blockquote {...rest}>{children}</blockquote>;
}

/** The components to hand `react-markdown`. */
export const blockComponents: Components = { blockquote: Quote, pre: Fenced };

/** GitHub's alert markers, which are what an author writing markdown already knows. */
const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/u;

/**
 * Marks a blockquote that opens with `[!NOTE]` as a callout.
 *
 * GitHub's alert syntax, so a note written in a guide previews as a note on
 * GitHub too:
 *
 * ```md
 * > [!NOTE]
 * > **Two ways to alias.** A name written `'list, ls'` shows both spellings.
 * ```
 *
 * The marker is taken out of the text and the blockquote is given a
 * `data-callout` the `blockquote` component reads. Every kind is drawn alike,
 * because the design has one callout; the kind is kept on the attribute for a
 * page that wants to tell them apart later. A plugin rather than a component
 * reading its children, because by the time a component sees the quote its
 * first paragraph is React elements, and the marker is text in the tree.
 *
 * @returns The transform.
 */
export function remarkCallouts() {
  const visit = (node: Root | RootContent) => {
    if (node.type === 'blockquote') {
      mark(node);
    }
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };

  return (tree: Root) => visit(tree);
}

function mark(quote: Blockquote): void {
  const first = quote.children[0];
  const text = first?.type === 'paragraph' ? first.children[0] : undefined;
  const match = text?.type === 'text' ? ALERT.exec(text.value) : null;

  if (!first || first.type !== 'paragraph' || !text || text.type !== 'text' || !match) {
    return;
  }

  text.value = text.value.slice(match[0].length);
  if (text.value === '') {
    first.children.shift();
  }
  if (first.children.length === 0) {
    quote.children.shift();
  }

  quote.data = {
    ...quote.data,
    hProperties: { ...quote.data?.hProperties, dataCallout: match[1]!.toLowerCase() },
  };
}
