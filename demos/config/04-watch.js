import { createConfig, json, object } from '@ttylabs/sigil/config';
/**
 * Watching a config file: the diff rather than the fact of a change, what a
 * higher layer shadows, and surviving our own atomic write.
 *
 *   node demos/config/04-watch.js
 *
 * Needs no terminal: every line is `console.log`, so this is the same output
 * piped as it is on a screen. It writes its own files and awaits real events,
 * which is why it takes a couple of seconds rather than being instant.
 */
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'sigil-watch-demo-'));
const system = join(root, 'system.json');
const user = join(root, 'config.json');

writeFileSync(system, JSON.stringify({ editor: { theme: 'light' }, server: { port: 80 } }));
writeFileSync(
  user,
  `{
  // the user's own, which wins over the system file
  "editor": { "theme": "dark" },
}`
);

const config = await createConfig({
  layers: [
    { name: 'system', readOnly: true, store: json(system) },
    { name: 'user', store: json(user) },
    // no file behind it, so nothing watches it -- `apply()` is how an object
    // layer gets into the diff
    { name: 'runtime', store: object() },
  ],
  schema: {
    'editor.theme': { choices: ['dark', 'light'], default: 'light' },
    'server.port': { default: 8080, type: 'int' },
  },
  watch: {
    // an app that watches config should pass this: there is no default that can
    // be right, so the floor is a debug log nobody sees
    onError: (e) => console.log(`  ! ${e instanceof Error ? e.message : String(e)}`),
  },
});

/** Replaces a file the way an editor that saves atomically does. */
function atomically(path, text) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, text);
  renameSync(temp, path);
}

/** What the whole-view handler last reported, so a step can say nothing moved. */
let changes = [];

// the path form, which is what "reload when config changes" almost always means
const stopPort = config.watch('server.port', ({ previous, value }) => {
  console.log(`  [server.port] ${previous} -> ${value}`);
});

// and the whole-view form, handed every path that moved. `get(path)` always
// agrees with `value`, so a handler can feed one straight back
const stopAll = config.watch((moved) => {
  changes = [...moved];
  for (const { path, previous, value } of moved) {
    console.log(`  [all] ${path}: ${JSON.stringify(previous)} -> ${JSON.stringify(value)}`);
  }
});

/**
 * Does something and waits for the watcher.
 *
 * A step that expects a change **awaits** it and throws if it never comes,
 * rather than sleeping and reporting "nothing was published": a demo that
 * passes with the watcher wholly dead is a demo that demonstrates nothing, and
 * `demos.test.ts` asks for exit 0 and no stack, so the throw is what makes a
 * dead watcher a failing check. Found by review.
 *
 * A step that expects **silence** can only wait, and what confirms the watcher
 * survived it is the next step's own change arriving -- which is the same
 * sequencing the tests use for a negative, since the steps run in order.
 *
 * @param {string} title - What the step is doing.
 * @param {() => unknown} change - The change to make.
 * @param {'change' | 'silence'} expect - What should happen.
 */
async function step(title, change, expect) {
  console.log(`\n${title}`);
  changes = [];
  await change();

  for (let waited = 0; waited < 2000 && changes.length === 0; waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }

  if (changes.length === 0) {
    if (expect === 'change') {
      throw new Error(`nothing was published for: ${title}`);
    }
    console.log('  (nothing was published)');
  }
}

console.log('watching, with:');
console.log(
  `  editor.theme = ${config.get('editor.theme')}  (the user file's, over the system one)`
);
console.log(
  `  server.port  = ${config.get('server.port')}  (the system file's, over the default 8080)`
);

// a watcher written to in the moment after it is created can lose its event --
// measured -- so the demo makes one throwaway change and waits for it rather
// than printing "nothing was published" about something that did happen
console.log('\nwarming the watcher...');
for (let tries = 0; tries < 20 && changes.length === 0; tries++) {
  atomically(system, JSON.stringify({ editor: { theme: 'light' }, server: { port: 81 } }));
  for (let waited = 0; waited < 200 && changes.length === 0; waited += 10) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

await step(
  'the system file changes server.port, which nothing shadows:',
  () => atomically(system, JSON.stringify({ editor: { theme: 'light' }, server: { port: 3000 } })),
  'change'
);

await step(
  'the system file changes editor.theme, which the user file shadows:',
  () =>
    // the layer really does reload; the merged view does not move, so nothing is
    // published. Which is the one thing a per-file watcher can never tell you
    atomically(system, JSON.stringify({ editor: { theme: 'dark' }, server: { port: 3000 } })),
  'silence'
);

await step(
  'the user file is replaced atomically, the way an editor saves:',
  () =>
    atomically(
      user,
      `{
  // still here: a write edits spans rather than reprinting
  "editor": { "theme": "light" },
}`
    ),
  'change'
);

await step(
  'our own save() writes the user file:',
  async () => {
    // **named**, because `set()` with no layer picks the topmost writable one --
    // which here is `runtime`, an in-memory store. Unnamed, this wrote to memory,
    // the file on disk never moved, and the step printed "nothing was published"
    // for the wrong reason: not the compare, but nothing having been written.
    // Found by review, in the demo for exactly that rule
    config.set('editor.theme', 'dark', 'user');
    await config.save('user');
    // the value read back is the one we just wrote, so the diff is empty. Which
    // is better than suppressing events for a window after a write, because that
    // would also swallow somebody else's write in the same window
  },
  'silence'
);

await step(
  'and the watch is still alive after it, which is the whole point:',
  () => atomically(user, '{ "editor": { "theme": "dark" }, "server": { "port": 9999 } }'),
  'change'
);

await step(
  'the runtime layer is re-applied, which has no file at all:',
  () => config.apply('runtime', { server: { port: 1234 } }),
  'change'
);

stopPort();
stopAll();

console.log('\nstopped. The file can change now and nothing is told:');
atomically(user, '{ "editor": { "theme": "light" } }');
await new Promise((r) => setTimeout(r, 300));
console.log(`  editor.theme is still ${config.get('editor.theme')}`);

rmSync(root, { force: true, recursive: true });
