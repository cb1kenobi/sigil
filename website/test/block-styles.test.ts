import { remarkBlockStyles } from '../src/lib/block-styles.ts';
import { parseMarkdown } from '../src/lib/markdown-doc.ts';
import { REPO_URL } from '../src/lib/site.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/** A page, parsed and styled, as `DocsMarkdown` would hand it on to be drawn. */
function styled(source: string) {
  const tree = parseMarkdown(source);
  remarkBlockStyles()(tree);
  return tree;
}

describe('a block named by <!-- as … -->', () => {
  it('should give a list of points its marker style and keep it announced as a list', () => {
    const [list] = styled('<!-- as points -->\n- **One.** a\n- **Two.** b\n').children;

    assert.equal(list?.type, 'list');
    assert.deepEqual(list?.data?.hProperties, { dataBlock: 'points', role: 'list' });
  });

  it('should make a paragraph that is one link to the repository the GitHub button', () => {
    const [paragraph] = styled(
      `<!-- as github -->\n\n[github.com/cb1kenobi/sigil](${REPO_URL})\n`
    ).children;
    const link = paragraph?.type === 'paragraph' ? paragraph.children[0] : undefined;

    assert.equal(link?.type, 'link');
    assert.deepEqual(link?.data?.hProperties, { dataButton: 'github' });
  });

  it('should leave every other comment, and a page with no directive, as it was', () => {
    const source = '<!-- a note -->\n\n- one\n';
    const tree = styled(source);

    assert.deepEqual(tree, parseMarkdown(source));
  });

  it('should fail the build on a style it does not know, or a block of the wrong shape', () => {
    assert.throws(() => styled('<!-- as carousel -->\n\n- a\n'), /names no block style/);
    assert.throws(() => styled('<!-- as points -->\n\nA paragraph.\n'), /bulleted list/);
    assert.throws(() => styled('<!-- as points -->\n\n1. one\n'), /bulleted list/);
    assert.throws(() => styled('<!-- as points -->\n'), /followed by nothing/);
    assert.throws(
      () => styled('<!-- as github -->\n\n[elsewhere](https://example.com)\n'),
      /one link to/
    );
    assert.throws(
      () => styled(`<!-- as github -->\n\nSee [the repo](${REPO_URL}).\n`),
      /one link to/
    );
  });
});
