import {
  describe as describeLede,
  headingsOf,
  outline,
  parseMarkdown,
  remarkDocPage,
  slugify,
} from '../src/lib/markdown-doc.ts';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const ids = (markdown: string) => headingsOf(parseMarkdown(markdown)).map((heading) => heading.id);

describe('a heading slug', () => {
  it('should be the one GitHub renders, which is what the guides link with', () => {
    // each pair is a heading and the id GitHub gave it, and the first four are
    // read out of `packages/sigil/test/markdown-links.test.ts`, whose own cases
    // were taken from GitHub's rendering of this repository
    assert.deepEqual(ids('### `main(opts)`'), ['mainopts']);
    assert.deepEqual(ids('### `sigil/updates`'), ['sigilupdates']);
    assert.deepEqual(ids('### `errorHandler`, `renderError`, `errorExitCode`'), [
      'errorhandler-rendererror-errorexitcode',
    ]);
    assert.deepEqual(ids('## Deliberate decisions — do not "fix" these'), [
      'deliberate-decisions--do-not-fix-these',
    ]);
    assert.deepEqual(ids('# Café déjà vu 🚀 rocket'), ['café-déjà-vu--rocket']);
    assert.deepEqual(
      ids('## a_b *em* _em2_ __strong__ [link](x) ![img](y.png) & <b>bold</b> -- dash'),
      ['a_b-em-em2-strong-link---bold----dash']
    );
    assert.deepEqual(ids('## `__proto__` and _options_ and snake_case_name'), [
      '__proto__-and-options-and-snake_case_name',
    ]);
    assert.deepEqual(ids('## Trailing hashes ##'), ['trailing-hashes']);
  });

  it('should be the one a heading names for itself with an anchor', () => {
    assert.deepEqual(ids('## <a id="agents"></a>Use sigil with an agent'), ['agents']);
    assert.deepEqual(ids('## <a name="top"></a>Top'), ['top']);
    // and a heading that would have slugged to it later steps aside
    assert.deepEqual(ids('## <a id="agents"></a>Use\n\n## Agents'), ['agents', 'agents-1']);
  });

  it('should keep each space as a hyphen, so a dash that was dropped leaves two', () => {
    assert.equal(slugify('A — b'), 'a--b');
  });

  it('should number a repeat the way GitHub does, skipping a suffix already taken', () => {
    assert.deepEqual(ids('## Dup\n\n## Dup\n\n## Dup-1'), ['dup', 'dup-1', 'dup-1-1']);
    assert.deepEqual(ids('## Dup\n\n## Dup-1\n\n## Dup'), ['dup', 'dup-1', 'dup-2']);
    assert.deepEqual(ids('## Dup\n\n## Dup\n\n## Dup'), ['dup', 'dup-1', 'dup-2']);
  });

  it('should count the title, which is why it is removed after the ids are settled', () => {
    assert.deepEqual(ids('# Parser\n\n## Parser'), ['parser', 'parser-1']);
  });

  it('should not read a heading out of a fence', () => {
    assert.deepEqual(ids('```sh\n# a comment\n```\n\n## Real'), ['real']);
  });
});

describe('an outline', () => {
  const source = '# The `parser`\n\nIt parses. It is fast.\n\n## One\n\n### Inner\n\n## Two\n';

  it('should find the title, the lede and every heading below the title', () => {
    const found = outline(source);

    assert.equal(found.title, 'The parser');
    assert.equal(found.lede, 'It parses. It is fast.');
    assert.deepEqual(
      found.headings.map((heading) => [heading.depth, heading.id, heading.text]),
      [
        [2, 'one', 'One'],
        [3, 'inner', 'Inner'],
        [2, 'two', 'Two'],
      ]
    );
  });

  it('should have no lede where the title is not followed by a paragraph', () => {
    assert.equal(outline('# T\n\n## Usage\n\nA paragraph further down.\n').lede, undefined);
  });

  it('should read inline markup as the text a reader sees', () => {
    assert.equal(
      outline('# T\n\nUse `x` and [a link](y.md) here.\n').lede,
      'Use x and a link here.'
    );
  });
});

describe('a description', () => {
  it('should take whole sentences while they fit', () => {
    assert.equal(describeLede('One. Two. Three.', 12), 'One. Two.');
  });

  it('should keep the first sentence however long it is', () => {
    assert.equal(
      describeLede('A very long first sentence indeed. Short.', 10),
      'A very long first sentence indeed.'
    );
  });

  it('should not split on a dot inside a name', () => {
    assert.equal(
      describeLede('Node.js 22.19.0 is needed. Then go.', 40),
      'Node.js 22.19.0 is needed. Then go.'
    );
  });
});

describe('the markdown plugin', () => {
  it('should give every heading its id, remove the title and mark the lede', () => {
    const tree = parseMarkdown('# Title\n\nLede.\n\n## One\n');
    remarkDocPage()(tree);

    assert.deepEqual(
      tree.children.map((node) => node.type),
      ['paragraph', 'heading']
    );
    assert.deepEqual(tree.children[0]?.data?.hProperties?.className, ['lede-docs']);
    assert.equal(tree.children[1]?.data?.hProperties?.id, 'one');
  });

  it('should take the anchor that named a heading out of what is drawn', () => {
    const tree = parseMarkdown('## <a id="agents"></a>Use sigil with an agent\n');
    remarkDocPage()(tree);
    const heading = tree.children[0];

    assert.equal(heading?.data?.hProperties?.id, 'agents');
    assert.deepEqual(
      heading?.type === 'heading'
        ? heading.children.map((child) => [child.type, 'value' in child ? child.value : ''])
        : [],
      [['text', 'Use sigil with an agent']]
    );
  });

  it('should leave a paragraph that is not directly under the title unmarked', () => {
    const tree = parseMarkdown('# Title\n\n## One\n\nBody.\n');
    remarkDocPage()(tree);

    assert.equal(tree.children[1]?.data?.hProperties?.className, undefined);
  });
});
