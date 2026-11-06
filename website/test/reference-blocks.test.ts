import { readFence } from '../src/lib/fence.ts';
import { parseMarkdown, textOf } from '../src/lib/markdown-doc.ts';
import {
  NAME_CELL,
  TYPE_CELL,
  remarkReferenceTables,
  remarkUsageTerminal,
} from '../src/lib/reference-blocks.ts';
import { referenceDocs } from '../src/lib/reference.ts';
import type { Code, Root, Table } from 'mdast';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

/**
 * The command reference's blocks, decided from the committed pages as
 * `sigil reference` writes them: a change to the generator that moves the usage
 * fence or renames a column fails here rather than quietly drawing the page as a
 * guide.
 */

function usage(source: string): Root {
  const tree = parseMarkdown(source);
  remarkUsageTerminal()(tree);
  return tree;
}

function fences(tree: Root): Code[] {
  return tree.children.filter((node): node is Code => node.type === 'code');
}

function tablesOf(source: string): Table[] {
  const tree = parseMarkdown(source);
  remarkReferenceTables()(tree);
  return tree.children.filter((node): node is Table => node.type === 'table');
}

function classOf(cell: Table['children'][number]['children'][number]): unknown {
  return (cell.data?.hProperties as { className?: unknown } | undefined)?.className;
}

describe("a reference page's usage line", () => {
  it('should be a terminal block with no working directory on every committed page', () => {
    const docs = referenceDocs();
    assert.ok(docs.length > 0);

    for (const doc of docs) {
      const [first] = fences(usage(doc.body));
      assert.ok(first, `${doc.slug}: no usage fence`);
      assert.deepEqual(
        readFence(first.lang ?? undefined, first.meta ?? undefined, first.value),
        { cwd: '', kind: 'shell', text: first.value },
        doc.slug
      );
      assert.match(first.value, /^sigil\b/u, doc.slug);
    }
  });

  it('should leave a fence that is not directly under Usage, or that names a language', () => {
    const tree = usage(
      '# x\n\n## Usage\n\n```ts\nlet a;\n```\n\n## Other\n\n```\nsigil x\n```\n\nText\n\n```\nsigil y\n```\n'
    );
    assert.deepEqual(
      fences(tree).map((node) => [node.lang, node.meta]),
      [
        ['ts', null],
        [null, null],
        [null, null],
      ]
    );
  });
});

describe("a reference page's tables", () => {
  it('should mark every argument and option as a name and its type as a type', () => {
    let rows = 0;

    for (const doc of referenceDocs()) {
      for (const table of tablesOf(doc.body)) {
        const head = table.children[0]!.children.map((cell) => textOf(cell).trim());

        if (head[0] !== 'Argument' && head[0] !== 'Option') {
          continue;
        }
        assert.equal(head[1], 'Type', doc.slug);

        for (const row of table.children.slice(1)) {
          const [name, type, description] = row.children;
          assert.deepEqual(classOf(name!), [NAME_CELL], doc.slug);
          assert.deepEqual(classOf(type!), [TYPE_CELL], doc.slug);
          assert.equal(classOf(description!), undefined, doc.slug);
          rows += 1;
        }
      }
    }

    // `sigil build` alone has nine options, so a count this low means none were read
    assert.ok(rows > 20, `${rows} rows`);
  });

  it("should mark the index's commands as names", () => {
    const index = referenceDocs().find((doc) => doc.slug === 'index');
    const [table] = tablesOf(index!.body);
    assert.equal(textOf(table!.children[0]!.children[0]!).trim(), 'Command');

    for (const row of table!.children.slice(1)) {
      assert.deepEqual(classOf(row.children[0]!), [NAME_CELL]);
      assert.equal(classOf(row.children[1]!), undefined);
    }
  });

  it('should leave the header row, and a table with none of these columns, alone', () => {
    const [table] = tablesOf('| Key | Does |\n| --- | --- |\n| `q` | Quits |\n');
    for (const row of table!.children) {
      for (const cell of row.children) {
        assert.equal(classOf(cell), undefined);
      }
    }

    const [option] = tablesOf('| Option | Type |\n| --- | --- |\n| `--x` | `bool` |\n');
    assert.deepEqual(option!.children[0]!.children.map(classOf), [undefined, undefined]);
  });
});
