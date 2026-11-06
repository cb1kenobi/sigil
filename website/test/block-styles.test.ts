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
  it('should make a timeline of a list: a tight panel of rows, each a date and an event', () => {
    const tree = styled(
      '<!-- as timeline -->\n\n- **2015** The `first` release\n\n- **2020** Another\n'
    );
    const [list] = tree.children;

    assert.equal(list?.type, 'list');
    assert.equal(tree.children.length, 1, 'the comment is taken out');
    if (list?.type !== 'list') {
      return;
    }
    assert.deepEqual(list.data?.hProperties, { dataBlock: 'timeline', role: 'list' });
    assert.equal(list.spread, false);

    const row = list.children[0]!.children[0];
    assert.equal(row?.type, 'paragraph');
    if (row?.type !== 'paragraph') {
      return;
    }
    const [date, event] = row.children;
    assert.equal(row.children.length, 2);
    assert.deepEqual(date?.data, { hName: 'span', hProperties: { className: ['timeline-date'] } });
    assert.deepEqual(event?.data, {
      hName: 'span',
      hProperties: { className: ['timeline-event'] },
    });
    // the event keeps its markup, and loses the space that followed the date
    assert.deepEqual(event && 'children' in event ? event.children.map((node) => node.type) : [], [
      'text',
      'inlineCode',
      'text',
    ]);
    assert.equal(
      event && 'children' in event && event.children[0]?.type === 'text'
        ? event.children[0].value
        : undefined,
      'The '
    );
  });

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
    assert.throws(() => styled('<!-- as timeline -->\n\nA paragraph.\n'), /bulleted list/);
    assert.throws(() => styled('<!-- as points -->\n\n1. one\n'), /bulleted list/);
    assert.throws(() => styled('<!-- as timeline -->\n'), /followed by nothing/);
    assert.throws(() => styled('<!-- as timeline -->\n\n- 2015 no bold\n'), /date in bold/);
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
