import { directoryTree, PromptError, selectTree, tree } from '@ttylabs/sigil/components';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
/**
 * A tree: nested data printed with guides, and the same shape as a prompt.
 *
 *   node demos/components/39-tree.js
 *   node demos/components/39-tree.js | cat    <- a scripted run, no terminal needed
 *
 * `tree()` takes `outline()`'s items -- a string, or `{ text, items }` -- and draws
 * them with `├──` and `└──`. `selectTree()` asks for a node of one: Right opens a
 * branch and Left closes it, and a branch whose `items` is a function is read the
 * first time it opens. `directoryTree()` is that prompt over a directory.
 *
 * Piped, there is nobody to press keys, so the prompts are driven by a scripted
 * keyboard over a throwaway directory and the screen is printed after each step.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

// a fixed width and terminal, so the printed half is the same anywhere
const here = { env: {}, platform: 'linux', width: 44 };

const project = {
  text: 'my-app',
  items: [
    'package.json',
    {
      text: 'src',
      items: ['index.ts', { text: 'commands', items: ['build.ts', 'deploy.ts'] }],
    },
    { text: 'test', items: ['build.test.ts'] },
  ],
};

console.log('a root, with its children hung from it:\n');
console.log(tree(project, here));

console.log('\n\nrounded, and numbered with outline()’s enumerators:\n');
console.log(tree(project.items, { ...here, guide: 'rounded', enumerator: ['arabic', 'alpha'] }));

console.log('\n\na long item wraps, and the guide carries on beside it:\n');
console.log(
  tree(
    [
      { text: 'notes', items: ['a sentence long enough that it has to wrap onto the next line'] },
      'done',
    ],
    here
  )
);

console.log('\n\nwhere box drawing is not safe:\n');
console.log(tree(project, { ...here, ascii: true }));
console.log();

/** A branch read on demand: what Textual calls lazy children. */
const slowly = (names) => async () => {
  await new Promise((resolve) => setTimeout(resolve, 20));
  return names;
};

async function interactive() {
  try {
    const region = await selectTree({
      message: 'Which region?',
      items: [
        { text: 'Americas', items: slowly(['us-east', 'us-west', 'sa-east']) },
        { text: 'Europe', items: slowly(['eu-west', 'eu-central']) },
        { text: 'Asia Pacific', items: slowly(['ap-south', 'ap-northeast']) },
      ],
      // a continent is a way to a region, not an answer
      leaves: true,
    });
    const file = await directoryTree({ message: 'Which file?' });

    console.log('\n---');
    console.log({ region, file });
  } catch (err) {
    if (err instanceof PromptError) {
      // a prompt with nobody to answer it rejects, and Ctrl-C is the abort
      console.error(err.aborted ? '\nCancelled.' : `\n${err.message}`);
      process.exitCode = 1;
    } else {
      throw err;
    }
  }
}

/** Lets a read land: real I/O and a timer, which a tick does not wait for. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

async function scripted() {
  const ui = createTestTerminal({ columns: 60, rows: 10 });
  const show = async (label, ...keys) => {
    await ui.press(...keys);
    await settle();
    console.log(`-- ${label}`);
    console.log(ui.lines.join('\n'));
    console.log();
  };

  const region = selectTree({
    message: 'Which region?',
    terminal: ui.terminal,
    env: {},
    platform: 'linux',
    leaves: true,
    items: [
      { text: 'Americas', items: slowly(['us-east', 'us-west', 'sa-east']) },
      { text: 'Europe', items: slowly(['eu-west', 'eu-central']) },
    ],
  });
  await settle();
  console.log('-- opened: every branch closed, nothing read yet');
  console.log(ui.lines.join('\n'));
  console.log();

  await show('Down, Right: Europe opens, and its children are read', KEYS.down, KEYS.right);
  await show('Right again: onto its first child', KEYS.right);
  await show('Left, Left: back to Europe, then closed', KEYS.left, KEYS.left);
  await ui.press(KEYS.enter);
  await settle();
  await ui.press(KEYS.down, KEYS.down, KEYS.enter);
  console.log(`answer: ${await region}\n`);

  const scratch = mkdtempSync(join(tmpdir(), 'sigil-tree-demo-'));
  // a directory of a known name inside the throwaway one, so the root row reads the same every run
  const root = join(scratch, 'my-app');
  try {
    mkdirSync(join(root, 'src', 'commands'), { recursive: true });
    mkdirSync(join(root, 'docs'));
    for (const file of ['package.json', 'src/index.ts', 'src/commands/build.ts', 'docs/intro.md']) {
      writeFileSync(join(root, file), '');
    }

    const file = directoryTree({
      message: 'Which file?',
      terminal: ui.terminal,
      env: {},
      platform: 'linux',
      root,
    });
    await settle();
    console.log('-- a directory tree: the root open, each directory read when it opens');
    console.log(ui.lines.join('\n'));
    console.log();

    await show('Down, Down, Enter: src opens', KEYS.down, KEYS.down, KEYS.enter);
    await ui.press(KEYS.down, KEYS.enter);
    await settle();
    await ui.press(KEYS.down, KEYS.enter);
    console.log(`answer: ${relative(root, await file)}`);
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

// both sides, because keys are read off stdin and the tree is drawn to the terminal's output
if (process.stdin.isTTY && process.stdout.isTTY) {
  await interactive();
} else {
  await scripted();
}
