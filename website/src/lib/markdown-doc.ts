import type { Heading as HeadingNode, Root, RootContent } from 'mdast';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

/**
 * What the site needs to know about a markdown page before it renders it: its
 * title, its first paragraph, and the anchor of every heading.
 *
 * ## One slug
 *
 * A heading's anchor is the slug **GitHub** gives it, because the guides are
 * read on GitHub as well as here and link to themselves with fragments that
 * only have to be true there: `packages/sigil/test/markdown-links.test.ts`
 * fails a link whose `#fragment` is no heading, using GitHub's rule, which that
 * file's `slug()` records and which was read off GitHub's own rendering. A link
 * the test accepts therefore lands on this site if, and only if, this function
 * says what that one does -- so it says the same thing, written against the
 * parsed tree rather than the source text.
 *
 * One function builds the id and every reader goes through it: the heading that
 * is drawn, the rail that lists it, the sidebar that links to it, and the test
 * that follows the links in the guides.
 *
 * ## A heading's own address
 *
 * A heading may name its id, with an anchor at its start:
 * `## <a id="agents"></a>Use sigil with an agent`. GitHub answers `#agents` for
 * that anchor and still gives the heading its slug, and `markdown-links.test.ts`
 * reads both; here the anchor **is** the heading's id, so the rail and the `#`
 * beside the heading say the short address that other pages link to, and the
 * anchor itself is taken out of what is drawn.
 */

/** An anchor that names a heading's id: `<a id="agents">` or `<a name="agents">`. */
const ANCHOR = /^<a\s+(?:id|name)="([^"]+)"\s*>$/u;

/** The id a heading names for itself with an anchor, if it does. */
function explicitId(node: HeadingNode): string | undefined {
  for (const child of node.children) {
    const match = child.type === 'html' ? ANCHOR.exec(child.value.trim()) : null;
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** One heading of a page, with the anchor it is rendered with. */
export interface Heading {
  /** 1 to 6. */
  readonly depth: number;
  /** The anchor, unique within the page; empty for a heading with no word in it. */
  readonly id: string;
  /** The heading as plain text: code spans without their backticks, links as their text. */
  readonly text: string;
}

/**
 * GitHub's heading slug: lowercase, then everything dropped but what Unicode
 * calls a word character -- alphabetic, a mark, a decimal digit, connector
 * punctuation, a joiner -- and `-` and the space, and each space a `-`.
 *
 * Each space, not each run of them, so `` `x` — y `` is `x--y` once the dash
 * has gone. That is GitHub's behaviour and a link written against it has the
 * double hyphen in it.
 *
 * @param text - A heading as plain text.
 * @returns The anchor, before it is made unique.
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}\- ]/gu, '')
    .replace(/ /g, '-');
}

/**
 * The text of a node as a reader of the rendered page would see it.
 *
 * A code span is its content, a link is its text, and an image and a piece of
 * inline HTML are nothing -- which is what GitHub slugs, and what a rail entry
 * should say. Not `mdast-util-to-string`, which reads `html` and `image` as
 * their source.
 *
 * @param node - Any mdast node.
 * @returns Its text.
 */
export function textOf(node: Root | RootContent): string {
  switch (node.type) {
    case 'text':
    case 'inlineCode':
      return node.value;
    case 'break':
      return ' ';
    case 'html':
    case 'image':
    case 'imageReference':
    case 'footnoteReference':
      return '';
    default:
      return 'children' in node ? node.children.map(textOf).join('') : '';
  }
}

/** The headings of a tree, in document order, each with the node it came from. */
function headingNodes(tree: Root): HeadingNode[] {
  const found: HeadingNode[] = [];
  const visit = (node: Root | RootContent) => {
    if (node.type === 'heading') {
      found.push(node);
    }
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(tree);
  return found;
}

/**
 * Every heading of a tree with its anchor.
 *
 * A repeat gets `-1`, `-2`, skipping any suffix a heading already claimed, so
 * `Dup`, `Dup-1`, `Dup` is `dup`, `dup-1`, `dup-2` and `Dup`, `Dup`, `Dup-1` is
 * `dup`, `dup-1`, `dup-1-1`. That is GitHub's rule too, and it counts the
 * page's own `h1`, which is why the title is taken out of the tree *after* this
 * has run rather than before.
 *
 * @param tree - A parsed page.
 * @returns The headings, in the order they appear.
 */
export function headingsOf(tree: Root): Heading[] {
  const taken = new Map<string, number>();

  return headingNodes(tree).map((node) => {
    const text = textOf(node).replace(/\s+/g, ' ').trim();
    const named = explicitId(node);
    if (named !== undefined) {
      taken.set(named, 0);
      return { depth: node.depth, id: named, text };
    }

    const base = slugify(textOf(node));
    let id = base;

    while (taken.has(id)) {
      const count = taken.get(base)! + 1;
      taken.set(base, count);
      id = `${base}-${count}`;
    }
    taken.set(id, 0);

    return { depth: node.depth, id, text };
  });
}

/**
 * The parser `react-markdown` runs, which is what makes a tree read here the
 * tree rendered there.
 */
const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * A page's markdown as a tree.
 *
 * Line endings are normalized first, for the reason `reference.ts` gives:
 * `.gitattributes` leaves `*.md` to `text=auto`, so a Windows checkout is CRLF.
 *
 * @param source - The markdown.
 * @returns The tree.
 */
export function parseMarkdown(source: string): Root {
  return parser.parse(source.replaceAll('\r\n', '\n'));
}

/** What a page says about itself, read from its tree. */
export interface Outline {
  /** Every heading but the title, in order. */
  readonly headings: Heading[];
  /** The first paragraph, when it directly follows the title, as plain text. */
  readonly lede?: string;
  /** The first `h1`, as plain text. */
  readonly title?: string;
}

/**
 * A page's title, first paragraph and headings.
 *
 * The paragraph counts as the lede only when it **follows the title directly**:
 * a page whose title is followed by a fence or a heading has no lede, and
 * borrowing a paragraph from further down would put a sentence in a place
 * nobody wrote it for.
 *
 * @param source - The markdown.
 * @returns The outline.
 */
export function outline(source: string): Outline {
  const tree = parseMarkdown(source);
  const all = headingsOf(tree);
  const at = tree.children.findIndex((node) => node.type === 'heading' && node.depth === 1);
  const title = at === -1 ? undefined : tree.children[at];
  const next = at === -1 ? undefined : tree.children[at + 1];

  return {
    headings: all.filter((heading) => heading !== all.find((it) => it.depth === 1)),
    lede: next?.type === 'paragraph' ? textOf(next).replace(/\s+/g, ' ').trim() : undefined,
    title: title?.type === 'heading' ? textOf(title).replace(/\s+/g, ' ').trim() : undefined,
  };
}

/**
 * What a search result says: the lede's first sentences, up to a length a
 * search result shows.
 *
 * Whole sentences, so the snippet ends where a sentence does, and at least the
 * first one however long it is: a description cut mid-word reads as broken.
 *
 * @param lede - A paragraph as plain text.
 * @param max - The length to stay under where there is more than one sentence.
 * @returns The description.
 */
export function describe(lede: string, max = 160): string {
  // a sentence ends at a stop that is followed by space, so `Node.js` and `22.19.0` are whole
  const sentences = lede.split(/(?<=[.!?])\s+/u);
  let out = sentences[0] ?? lede;

  for (const sentence of sentences.slice(1)) {
    if (`${out} ${sentence}`.length > max) {
      break;
    }
    out = `${out} ${sentence}`;
  }

  return out;
}

/**
 * Makes a page of markdown into the page the site draws.
 *
 * - every heading gets its anchor, as `id`, and loses an `<a id>` that named it
 * - the title is taken out, because the layout draws it above the content
 * - the paragraph after it is marked as the lede, which is the larger type
 *
 * A remark plugin rather than a component, because a component sees the
 * heading as React elements and the anchor has to be settled from the text
 * before any of it is drawn.
 *
 * @returns The transform.
 */
export function remarkDocPage() {
  return (tree: Root) => {
    const ids = headingsOf(tree).map((heading) => heading.id);
    const nodes = headingNodes(tree);

    nodes.forEach((node, index) => {
      if (ids[index]) {
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, id: ids[index] } };
      }
      // the anchor and its closing tag, which are markup with nothing to draw
      if (explicitId(node) !== undefined) {
        node.children = node.children.filter(
          (child) => child.type !== 'html' || !/^<\/?a\b[^>]*>$/u.test(child.value.trim())
        );
        const first = node.children[0];
        if (first?.type === 'text') {
          first.value = first.value.replace(/^\s+/u, '');
        }
      }
    });

    const at = tree.children.findIndex((node) => node.type === 'heading' && node.depth === 1);
    if (at === -1) {
      return;
    }

    const next = tree.children[at + 1];
    if (next?.type === 'paragraph') {
      next.data = {
        ...next.data,
        hProperties: { ...next.data?.hProperties, className: ['lede-docs'] },
      };
    }
    tree.children.splice(at, 1);
  };
}

/**
 * A page's markdown with every link's destination replaced, and nothing else
 * touched.
 *
 * What a link means depends on where the markdown is read: a guide links to a
 * sibling as `parser.md`, which the site draws as `/docs/parser` through
 * `guideLink()`, and the Markdown copy of the page has to give as an address an
 * agent can fetch. The text is edited at each link's own position in the parsed
 * tree rather than by a pattern over the source, so a fence that happens to
 * hold `](` is code and stays code.
 *
 * A link's destination is handed over as the tree has it -- which is what
 * `react-markdown` hands the page's own `urlTransform` -- so one function can
 * answer for both.
 *
 * @param source - The markdown.
 * @param to - Where a destination goes; `undefined` or the same string leaves it.
 * @returns The markdown, line endings normalized.
 */
export function rewriteLinks(source: string, to: (href: string) => string | undefined): string {
  const text = source.replaceAll('\r\n', '\n');
  const edits: { start: number; end: number; value: string }[] = [];

  const visit = (node: Root | RootContent) => {
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      const next = to(node.url);

      if (start !== undefined && end !== undefined && next !== undefined && next !== node.url) {
        const raw = text.slice(start, end);
        // an inline link's destination follows its last `](`, a definition's its `]:`
        const opener = node.type === 'definition' ? raw.indexOf(']:') : raw.lastIndexOf('](');
        // a reference (`[text][id]`) or an autolink has none, and nothing to edit here
        if (opener !== -1) {
          const from = opener + 2 + (/^\s*/u.exec(raw.slice(opener + 2))?.[0].length ?? 0);
          const rest = raw.slice(from);
          const length = rest.startsWith('<')
            ? rest.indexOf('>') + 1
            : /^[^\s)]*/u.exec(rest)![0].length;
          const value = /[\s()<>]/u.test(next) ? `<${next}>` : next;
          edits.push({ start: start + from, end: start + from + length, value });
        }
      }
    }
    if ('children' in node) {
      for (const child of node.children) {
        visit(child);
      }
    }
  };
  visit(parseMarkdown(text));

  return edits
    .toSorted((a, b) => b.start - a.start)
    .reduce((out, edit) => out.slice(0, edit.start) + edit.value + out.slice(edit.end), text);
}

/**
 * A block of text as a fenced code block.
 *
 * The fence is longer than any run of backticks inside it, so none of them
 * closes it: an included file or an example may well hold a fence of its own.
 *
 * @param body - What goes inside, with no trailing newline.
 * @param info - The info string: the language and any meta after it.
 * @returns The block.
 */
export function fence(body: string, info = ''): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((run) => run[0].length));
  const marks = '`'.repeat(Math.max(3, longest + 1));

  return `${marks}${info}\n${body}\n${marks}`;
}
