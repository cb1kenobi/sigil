import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);

/**
 * A view as long as somebody's data, built where an app builds it: on a main
 * thread (SIG-417).
 *
 * `box(props, ...children)` is `new Element('box', props).append(...children)`, so
 * a component that built a child per row of its data and spread them into it put
 * every row on the call stack as an argument, and past about 125,000 of them a main
 * thread threw `RangeError: Maximum call stack size exceeded`. Each of the sites
 * below appends one at a time now; `data-sized.test.ts` is the same defect for the
 * charts and the table (SIG-363), and "A largest or a smallest over data" in
 * `src/components/AGENTS.md` is the rule.
 *
 * In a child process rather than in this file, for the reason that file gives: a
 * vitest worker's stack is four times a main thread's and spreads 300,000 arguments
 * without complaint, so a test written here at 200,000 passes against the code
 * that fails an app. Each case is a process of its own and they run together,
 * since each builds a couple of hundred thousand elements. The children import
 * `dist/`, so they need a build first, which is what `pnpm test` does.
 */
const LONG = 200_000;

/** Each case answers with a few numbers rather than a tree, so that the output is small. */
const CASES: Record<string, { body: string; expected: Record<string, unknown> }> = {
  codeView: {
    body: `
      const { codeView } = await import(dist + 'components/code-view.mjs');
      const element = codeView(Array.from({ length: LONG }, () => 'x').join('\\n'), { width: 20 });
      return { rows: element.children.length };
    `,
    expected: { rows: LONG },
  },
  diff: {
    body: `
      const { diffView } = await import(dist + 'components/diff.mjs');
      const lines = Array.from({ length: LONG }, (_, i) => 'line ' + i).join('\\n');
      const tree = diffView({ new: lines, old: '' }, { layout: 'unified', width: 40 });
      return { rows: tree.element.children.length >= LONG };
    `,
    expected: { rows: true },
  },
  logView: {
    body: `
      const { logView } = await import(dist + 'components/log.mjs');
      const element = logView(Array.from({ length: LONG }, () => 'x').join('\\n'), '*');
      const body = element.children.at(-1);
      return { lines: body.children.length };
    `,
    expected: { lines: LONG },
  },
  markdownBlocks: {
    body: `
      const { markdownView } = await import(dist + 'components/markdown.mjs');
      const { element } = markdownView(Array.from({ length: LONG }, () => 'a').join('\\n\\n'), { width: 20 });
      return { blocks: element.children.length };
    `,
    expected: { blocks: LONG },
  },
  markdownList: {
    body: `
      const { markdownView } = await import(dist + 'components/markdown.mjs');
      const { element } = markdownView(Array.from({ length: LONG }, () => '- a').join('\\n'), { width: 20 });
      return { items: element.children[0].children.length };
    `,
    expected: { items: LONG },
  },
  markdownTable: {
    body: `
      const { markdownView } = await import(dist + 'components/markdown.mjs');
      const source = '| a |\\n| - |\\n' + Array.from({ length: LONG }, () => '| b |').join('\\n');
      const { element } = markdownView(source, { width: 20 });
      return { rows: element.children[0].children.length };
    `,
    expected: { rows: LONG + 2 },
  },
  markdownWords: {
    body: `
      const { markdownView } = await import(dist + 'components/markdown.mjs');
      const { element } = markdownView(Array.from({ length: LONG }, () => 'w').join(' '), { width: 20 });
      return { done: element.children.length > 0 };
    `,
    expected: { done: true },
  },
  outlineView: {
    body: `
      const { outlineView } = await import(dist + 'components/outline.mjs');
      const { element } = outlineView(Array.from({ length: LONG }, () => 'a'), { width: 20 });
      return { rows: element.children[0].children.length };
    `,
    expected: { rows: LONG },
  },
  paragraph: {
    body: `
      const { paragraph } = await import(dist + 'element.mjs');
      const words = Array.from({ length: LONG }, () => 'w').join(' ');
      const lines = Array.from({ length: LONG }, () => 'w').join('\\n');
      return {
        lines: paragraph([lines]).children.length,
        words: paragraph([words]).children.length,
      };
    `,
    expected: { lines: LONG, words: LONG },
  },
  treeView: {
    body: `
      const { treeView } = await import(dist + 'components/tree.mjs');
      const { element } = treeView(Array.from({ length: LONG }, () => 'a'), { width: 20 });
      return { rows: element.children.length };
    `,
    expected: { rows: LONG },
  },
};

type Outcome = { error: string } | { value: Record<string, unknown> };

describe("a view as long as somebody's data, on a main thread", () => {
  const outcomes: Record<string, Outcome> = {};

  beforeAll(async () => {
    const dist = new URL('../../dist/', import.meta.url).href;
    await Promise.all(
      Object.entries(CASES).map(async ([name, { body }]) => {
        const source = `
          const dist = ${JSON.stringify(dist)};
          const LONG = ${LONG};
          try {
            const value = await (async () => {${body}})();
            process.stdout.write(JSON.stringify({ value }));
          } catch (err) {
            process.stdout.write(JSON.stringify({ error: String(err) }));
          }
        `;
        const { stdout } = await run(process.execPath, ['--input-type=module', '-e', source], {
          maxBuffer: 1 << 20,
        });
        outcomes[name] = JSON.parse(stdout) as Outcome;
      })
    );
  }, 120_000);

  it.each(Object.keys(CASES))('should build %s of 200,000 entries', (name) => {
    expect(outcomes[name]).toEqual({ value: CASES[name].expected });
  });
});
