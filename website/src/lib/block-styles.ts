import { REPO_URL } from './site.ts';
import type { Link, List, Paragraph, Root, RootContent } from 'mdast';

/**
 * A block of markdown drawn as something other than what markdown calls it,
 * named by a comment on the line before it:
 *
 * ```md
 * <!-- as points -->
 *
 * - **Decisions are recorded.** …
 * ```
 *
 * A comment, because it is the one piece of markup that GitHub, a `.md` copy of
 * the page and a reader of the raw file all leave out: the block is an ordinary
 * list or link there, and only this site draws it differently. The same shape
 * as `<!-- include … -->` (`includes.ts`), which is the other thing a comment
 * says to this site.
 *
 * - `points`: a bulleted list drawn with a square marker.
 * - `github`: a paragraph that is one link to the repository, drawn as the
 *   bordered GitHub button.
 *
 * A comment that names no style here, or a block that is not the shape its
 * style needs, fails the build: a style that silently did nothing would be a
 * page that looked right in the diff and wrong on the site.
 */

/** The styles a block can be given. */
export const BLOCK_STYLES = ['points', 'github'] as const;

export type BlockStyle = (typeof BLOCK_STYLES)[number];

/** `<!-- as points -->`. */
const DIRECTIVE = /^<!--\s*as\s+(\S+)\s*-->$/u;

/**
 * Gives each block named by an `<!-- as … -->` comment its style, and takes the
 * comment out.
 *
 * What a style becomes is on the tree, for the renderer and the stylesheet:
 * a list gets `data-block`, and the GitHub link gets `data-button="github"`, which
 * `docs-markdown.tsx` draws as `GithubLink`. A list keeps `role="list"`,
 * because a list with its bullets styled away is no longer announced as one
 * by Safari.
 *
 * Only top-level blocks: a directive inside a list item or a quote is left
 * alone.
 *
 * @returns The transform.
 */
export function remarkBlockStyles() {
  return (tree: Root) => {
    const kept: RootContent[] = [];

    tree.children.forEach((node, index) => {
      const match = node.type === 'html' ? DIRECTIVE.exec(node.value.trim()) : null;
      if (!match) {
        kept.push(node);
        return;
      }
      style(match[1]!, tree.children[index + 1]);
    });

    tree.children = kept;
  };
}

/** Whether a name is one of `BLOCK_STYLES`. */
function isBlockStyle(name: string): name is BlockStyle {
  return (BLOCK_STYLES as readonly string[]).includes(name);
}

function style(name: string, node: RootContent | undefined): void {
  if (!isBlockStyle(name)) {
    throw new Error(
      `<!-- as ${name} --> names no block style; there are ${BLOCK_STYLES.join(', ')}`
    );
  }

  switch (name) {
    case 'points':
      mark(bulleted(name, node), name);
      return;
    case 'github':
      github(node);
      return;
  }
}

/** The list a list style was given to, or an error saying it was not one. */
function bulleted(name: BlockStyle, node: RootContent | undefined): List {
  if (node?.type !== 'list' || node.ordered) {
    throw new Error(
      `<!-- as ${name} --> is for a bulleted list, and is followed by ${node ? `a ${node.type}` : 'nothing'}`
    );
  }
  return node;
}

function mark(list: List, name: BlockStyle): void {
  list.data = {
    ...list.data,
    hProperties: { ...list.data?.hProperties, dataBlock: name, role: 'list' },
  };
}

/** The GitHub button: a paragraph that is one link, to the repository. */
function github(node: RootContent | undefined): void {
  const link = node?.type === 'paragraph' ? onlyLink(node) : undefined;

  if (!link || link.url !== REPO_URL) {
    throw new Error(`<!-- as github --> is for a paragraph that is one link to ${REPO_URL}`);
  }

  link.data = { ...link.data, hProperties: { ...link.data?.hProperties, dataButton: 'github' } };
}

function onlyLink(paragraph: Paragraph): Link | undefined {
  const [only, ...rest] = paragraph.children;
  return only?.type === 'link' && rest.length === 0 ? only : undefined;
}
