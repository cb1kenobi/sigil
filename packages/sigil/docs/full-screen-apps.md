# Building a full-screen app

This guide builds `hello`, the smallest full-screen sigil app: three rows you
move between with Tab or the arrows, a count you raise with Enter, and `q` to
quit. It takes the whole terminal, like an editor or `htop` does, and gives it
back exactly as it was when it exits.

It is built twice, once in each template syntax, because sigil treats them as
equals:

- **JSX**, compiled by a build. Your editor type-checks every prop.
- **The `ui` tag**, run by plain `node`, with nothing compiled.

Nothing here is invented for the page. Every file shown is an excerpt of
[`examples/hello`](../../../examples/hello), headed by the path it is from, and
`packages/cli/test/guides.test.ts` fails if an excerpt stops matching it or a
block of code appears without one. The example itself is mounted, driven and
quit by `packages/cli/test/examples.test.ts`, and the test file shown at the
end is the example's own, so the code below is code that runs.

You need Node.js 22.19.0 or newer, and the app depends on `@ttylabs/sigil`.
The JSX half also needs `@ttylabs/cli`, which provides `sigil build`, and
`typescript`, which that build type-checks with.

`hello` is small on purpose. Once it makes sense,
[Lists, trees and other views](#lists-trees-and-other-views) introduces the
components a larger app is built from, and
[Which example to read](#which-example-to-read) points you to a complete app
in the shape of the one you are writing.

## How the pieces fit

A full-screen app is four things, and `runApp()` from `@ttylabs/sigil/app`
puts them together in one call. It helps to know which does what before
writing one:

- **An element tree**, built by a component. A component is a function that
  runs **once** and returns elements. Nothing re-renders: the parts that change
  are functions the tree calls again when a signal they read changes.
- **A cascade**: the framework's own stylesheet, a theme, and yours, matched
  against the tree the way CSS is matched against HTML.
- **A renderer** over a **full-screen canvas**, which lays the tree out with
  flexbox, paints it into a grid of cells, and writes only the cells that
  changed. The canvas switches the terminal to its alternate screen, which has
  no scrollback, so whatever was there before is untouched.
- **An input router**, which owns the keyboard: app-wide bindings, a focus ring
  that Tab walks, and keys delivered to whatever has the focus.

A component reaches the running app, and its router, through `useApp()`.

## The stylesheet

Styling is CSS over the cell grid. Lengths are whole cells, and `border` draws
box-drawing characters:

```ts
// src/common.ts
export const stylesheet = `
  .app { flex-direction: column; flex-grow: 1; border: round; border-color: gray; padding: 0 1 }
  .title { font-weight: bold }
  .hint { color: gray }
  .rows { flex-direction: column; flex-grow: 1; margin-top: 1 }
  .row { flex-direction: row; padding: 0 1 }
  .row:focus { background-color: blue; color: white }
  .name { flex-grow: 1 }
  .status { color: gray }
`;
```

`.row:focus` is the whole of the focus highlight. The router sets `:focus` on
whatever element has the focus, so no component code is needed for it.

`:focus-within` is its partner for an app with more than one pane. It matches
the focused element and every element that contains it, so a pane can show that
the focus is somewhere inside it. `hello` has one pane and does not need it. The
git client, the file manager and the disk usage example frame each pane in a
[`Panel`](../src/components/panel.ts) and add one rule to their stylesheets,
`.sigil-panel:focus-within { border-color: green }`. The border of whichever
pane holds the focus turns green, so the reader can see where the keys will go.

## The root component, in JSX

```tsx
// src/root.tsx
export function App(): Element {
  // the app this is running under: its router, and the way to end it. Read in
  // the body, since a handler that runs later has no owner to ask
  const app = useApp();
  const counts = ITEMS.map(() => new State(0));

  const rows = ITEMS.map((name, index) => {
    const count = counts[index] as State<number>;
    const row = (
      <box class="row" focusable>
        <text class="name">{name}</text>
        <text>{() => String(count.get())}</text>
      </box>
    );
    // Enter and Space belong to whichever row has the focus, so they are the
    // row's rather than the app's
    row.onKey = (event) => {
      if (event.key.name === 'enter' || event.key.name === 'space') {
        event.stop();
        count.set(count.get() + 1);
      }
    };
    return row;
  });

  app.input?.bind('up', () => app.input?.focus.previous());
  app.input?.bind('down', () => app.input?.focus.next());
  app.input?.bind('q', () => app.exit());

  // after the first frame, which is when the ring has something in it
  onMount(() => app.input?.focus.focus(rows[0]));
```

Five things in there are worth reading twice:

- **`App` takes no props.** `useApp()` hands it the app it is running under:
  `input` is the router, and `exit()` ends the app. Call `useApp()` in the
  body, as here, and keep what it returns, because a handler that runs later
  has no component around it to ask. `input` is typed as possibly undefined
  only because an app that refused to start has none, and that app never calls
  `App` at all.
- **JSX makes elements, not descriptions of them.** `<box>` returns a real
  element, so `row.onKey = ...` on the next line sets a handler on the row that
  will be drawn. There is no virtual DOM. A handler can also be written where
  the element is, as a prop: `<box onKey={(event) => ...}>` -- one of seven
  `on*` hooks, in JSX and in the `ui` tag alike -- and `ref={(el) => ...}` is
  how a template hands back an element it built.
- **`{() => String(count.get())}` is the reactive part.** A function child is
  called again whenever a signal it read changes, and only that text is
  updated. `{count.get()}` would be read once, and the number would never move.
- **`focusable` puts an element in the focus ring**, which Tab and Shift-Tab
  walk in document order. A key goes to the focused element first and then up
  through its ancestors, so a row handles its own Enter.
- **`app.input?.bind('q', ...)` is an app-wide binding.** It fires wherever
  the focus is. `app.exit()` ends the app with exit code `0`. Ctrl-C needs no
  binding: the runner ends the app on it, with `130`. Nor does a bare `q`, which
  the runner's `quitKey` ends it on with `0` -- as a fallback, so a text field
  that takes `q` keeps it; this example binds it itself, ahead of that.

Writing each row out as its own box is right for three rows that never change.
Rows that come from data, and may number in the thousands, want a component
that builds only the rows on screen;
[Lists, trees and other views](#lists-trees-and-other-views) has them.

The rest of the component is the screen itself:

```tsx
// src/root.tsx
return (
  <box class="app">
    <text class="title">hello, full screen</text>
    <text class="hint">Tab or the arrows move, Enter counts, q quits</text>
    <box class="rows">{rows}</box>
    <text class="status">
      {() => `${counts.reduce((sum, count) => sum + count.get(), 0)} presses`}
    </text>
  </box>
);
```

For the compiler to read that, `tsconfig.json` names sigil as the JSX source.
`allowImportingTsExtensions` is there because the imports name the files they
mean, `./root.tsx` included, and it needs `noEmit`, since `sigil build` is what
writes the output:

```json
// tsconfig.json
{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "jsx": "react-jsx",
    "jsxImportSource": "@ttylabs/sigil",
    "noEmit": true
  }
}
```

`sigil new` writes all four for you.

## Running it

The app is still a sigil CLI. Its entry is a schema whose `run` opens the
screen, so `hello --help` prints help like any other command:

```ts
// src/index.ts
export default {
  name: 'hello',
  desc: 'The smallest full-screen sigil app',

  async run(): Promise<void> {
    process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited;
  },
};
```

`runApp()` builds the router, takes the alternate screen, cascades your
stylesheet over the framework's, and renders `App` into it. When the app ends
-- `exit()`, Ctrl-C, or an error -- it gives the terminal back exactly as it
was, and `exited` resolves with the exit code: `0` from `exit()`, `130` for
Ctrl-C, `1` for a failure. `runApp()` never sets the process's exit code itself,
so the `process.exitCode = ...` line is yours to write. Nothing is returned
from `run()`, because what a command's `run()` returns is printed as its
answer.

Without a terminal on both ends, piped into `cat` for example, `runApp()`
refuses: it draws nothing, writes one line to stderr, and resolves `1`.

While the app runs, `console.log()` is captured rather than written into the
screen, so a stray log line from your code or a library cannot leave garbage in
a frame. The lines are kept in `app.logs`. If the app fails -- a throw or a
failed frame, an uncaught error or `process.exit(n)`, or an exit code other than
`0` and `130` -- they are written to the main screen once it is back, ahead of
the error: `log`, `info` and `debug` to stdout, `warn` and `error` to stderr. A
clean exit throws them away, and so does Ctrl-C, which exits `130`. Pass `console:
false` to leave the console alone. A bare `process.stdout.write()` and a child
process's stderr are not the console and still write straight to the screen.

With `"bin": { "hello": "./dist/hello.mjs" }` in `package.json`, `sigil build`
type-checks the app, compiles the JSX, and writes the bundle:

```console
$ sigil build
$ node dist/hello.mjs
```

## The same app, without a build

Here is the same component in the `ui` tag. Node runs it as it is, because it
strips the types and there is no JSX to compile:

```ts
// src/root.ui.ts
return ui`
    <box class="app">
      <text class="title">hello, full screen</text>
      <text class="hint">Tab or the arrows move, Enter counts, q quits</text>
      <box class="rows">${rows}</box>
      <text class="status">${() => `${counts.reduce((sum, count) => sum + count.get(), 0)} presses`}</text>
    </box>
  `;
```

The markup is the same and only the interpolation differs: `${...}` where JSX
has `{...}`, because a template literal has no other kind. A component goes in
as `<${Row} />`, since a tag function has no scope to look a name up in. What
you give up is the checking. A misspelt prop is refused when the template runs,
not underlined in your editor.

The unbuilt entry, `src/ui.ts`, is the same schema over this component, run by
`main()`. It also names a `version`, read from `package.json`, which the JSX
entry has no need to: `sigil build` writes the package's version into the
bundle, and nothing builds `src/ui.ts`.

```console
$ node src/ui.ts
```

Both twins draw exactly the same screen, and `examples.test.ts` checks that
they do. They compile to one intermediate representation, so neither syntax is
a second-class spelling of the other. Use the one that suits the file: JSX for
an app with a build, the tag for a script or a prototype that must run as it is.

## Testing it

`@ttylabs/sigil/testing` has a terminal that is a screen in memory, so an app
can be mounted, typed at, and read back with no terminal and no child process.
Here it is in a [vitest](https://vitest.dev) test, which needs `vitest` as a
devDependency:

```ts
// test/hello.test.ts
import { App, stylesheet } from '../src/root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { createTestTerminal, frame, KEYS } from '@ttylabs/sigil/testing';
import { expect, it } from 'vitest';

it('should count what Enter presses and quit on q', async () => {
  const term = createTestTerminal({ columns: 60, rows: 16 });
  const app = runApp(App, { detect: false, sheets: [stylesheet], terminal: term.terminal });

  await term.press(KEYS.enter, KEYS.down, KEYS.enter);
  // frames are drawn on a clock, about 30 a second, rather than once per key:
  // frame() paints the next one now instead of waiting for it
  await frame(app);
  // the screen row by row; the last is the bottom border
  expect(term.viewport.at(-2)).toMatch(/^│ 2 presses +│$/);

  await term.press('q');
  expect(await app.exited).toBe(0);
  expect(term.screen.alternate).toBe(false);
});
```

That is the example's whole test file, and the repository's suite runs it.
The renderer draws on its own clock, about thirty frames a second, and not once
per key — so a key leaves the screen as it was until the next tick, and a test
that read it straight away would see the old count. `frame(app)` paints the next
frame now instead of waiting for it, so the screen is read as the keys left it
and not after a timer sized by guessing. `detect: false` skips asking the
terminal what it is, which a test terminal cannot answer.

## Starting from the scaffold

`sigil new` writes this app for you. Answer yes to "Include a full-screen app
(TUI)?", or pass `--tui`, and the app gets `src/ui/app.tsx`, a `test/tui.test.ts`
that runs it over a fake terminal like the one above, and a `dev` script that
builds it and runs the bundle. A full-screen app is something a command does, so
it is asked after whether the app has one command or several, and an app with
several is then asked where to launch it from: the app itself, where `myapp` with
no command opens it, or a command of its own, where `myapp <command>` does (it
is asked for, and `dashboard` would be one example) and `myapp` still shows help. `--tui-command <name>` picks the second without the
questions, and `--tui-command` with `--layout single` is refused, since a single
command has nowhere to put one. `--no-tui` says there is none, which is how a
script that passes every other flag avoids the question.

The component lives in `src/ui/` and never in `commands/`, because a `.tsx` is
not a route and Node cannot import one from source. Whatever opens it loads it
with a dynamic `import()` inside `run`, so `myapp login` never loads the
renderer.

The syntax is a question of its own, "Which template syntax?", and `--syntax
jsx|ui` answers it. JSX is the default: it type-checks every prop, and what it
costs is a build, which is why its `dev` script is `sigil build --quiet && node
dist/myapp.mjs`. `--syntax ui` writes the same app in the Sigil UI template (the `ui` tag), whose `dev`
is plain `node dev.ts` with nothing to build.

To drive the whole process instead — its own `main()`, its schema, a real stdin —
`runOnTerminal({ run, stdin: true })` spawns it with a terminal on all three
streams and hands back `press()` and `waitFor()`;
[Testing](testing.md#a-full-screen-app) has it.

## Lists, trees and other views

`hello` builds every row by hand. A real app usually shows data: files, log
lines, a table of processes, a diff. sigil has a component for each of these
shapes. Each one takes the focus and handles its own keys, so it joins the
focus ring the way `hello`'s rows do, and Tab moves to it and away.
Import each from its own subpath, such as `@ttylabs/sigil/components/list-view`.
The link on each name goes to the component's page, with its options and a
capture of it running.

**A list.** [`ListView`](../src/components/list-view.ts) takes `items`, an array
or a `State` or `Computed` of one, and a `key` that names each item. It builds
only the rows in view, so ten thousand rows cost what twenty do. Up, Down, Page
Up, Page Down, Home and End move the cursor, and Enter calls `onActivate(key,
item)`. The cursor holds a key rather than a position, so it stays on its row
when new data arrives in another order.

A list can also follow its newest row, the way `tail -f` does. Pass `tail`, and
every change of the items moves the cursor to the last row. Moving off the last
row stops following, and so does scrolling it out of view, so a reader is not
pulled back down while reading. End, or a move back onto the last row, starts it
again. Pass a `State<boolean>` as `tail` to show "following" or "paused": the
list writes it as the reader moves, and the app can write it too. The [log
browser](../../../examples/log-browser) follows a log of 50,000 lines this way.

**A tree.** [`TreeListView`](../src/components/tree-list-view.ts) is a list of a
tree's open rows. Right opens a closed branch. Left closes an open branch, or
steps up to the branch the row is in. A branch whose `items` is a function is read the first time it
opens, and what it returned is kept, so opening it again is instant. The tree
cannot tell when the data behind a branch changes, so the app says so through
`treeListControl(tree)`: `reload(value)` marks one branch out of date,
`reload(value, { subtree: true })` marks the branches under it too, and
`reloadAll()` marks every one. What was on screen stays there until the new read
lands, so the cursor does not jump. The [editor](../../../examples/editor)'s
file tree and the [disk usage](../../../examples/disk-usage) example's tree are
both one.

**A table.** [`DataTable`](../src/components/data-table.ts) is a list with
columns. The digits 1 to 9 sort by the column with that number, and a click
on a heading sorts by that column.
When the rows update, the cursor stays where it is on screen by default, as it
does in `htop`, since a table sorted by a live column re-sorts on every update.
Pass `follow: true` to keep it on its row instead, wherever that row goes. The
log browser's pods and the [dashboard](../../../examples/dashboard)'s projects
are tables.

**A diff.** [`DiffView`](../src/components/diff-view.ts) shows a diff, from two
texts or from a patch `git diff` printed, with a cursor that stops on each
hunk. `]` and `[` move between hunks. Long lines wrap at words. `w` puts each
line on one row instead, cut at the edge, and then Left and Right scroll every
line sideways together. `diffStops()` and `hunkPatch()` from
`@ttylabs/sigil/components/diff` find the hunk under the cursor and write it
out as a patch of its own, which is how the
[git client](../../../examples/git-client) stages a single hunk.

**A treemap.** [`Treemap`](../src/components/treemap.ts) draws a tree of sizes
as nested rectangles, each as big as its share, so the largest items stand out
at a glance. It reads your own nodes through `size`, `children` and `key`, so
nothing is copied. A click on a rectangle, or an arrow key while the map has
the focus, sets its `current` and calls `onPick`. The current rectangle is
outlined in bright white, and in green while the map has the focus, so you can
see where the arrows go. Enter, or a double click on a rectangle, calls
`onActivate(key)`: the disk usage example uses it to show that directory on its
own. `onHover` names the rectangle under the pointer without moving `current`,
so a status line can say what a rectangle too small for a label is. It needs
mouse motion, which an app turns on with `mouse: { motion: true }` in
`runApp()`'s options. A list or a tree beside the map can write the same
`current`: the disk usage example pairs it with a `TreeListView` this way, so
the two always show one selection.

Around these, every example but `hello` frames its panes in a
[`Panel`](../src/components/panel.ts) with a title, and uses
[`keyHelp()`](../src/components/key-help.ts) for a footer that lists the keys of
whatever has the focus. Most also ask with
[`confirmModal()`](../src/components/modal.ts) before anything that cannot be
undone, and say what happened with [`showToast()`](../src/components/toast.ts).
These are the components a full-screen app is most often built from, not all
of them. [The rest](../src/components/) include tabs, text fields, buttons, a
scroll box, and the prompts and spinners a command line uses.

### Drawing cells of your own

When no component fits, a `raw` element from `@ttylabs/sigil/element` paints its
cells itself. Its paint and its measure run during the frame and are not
tracked, so a signal either reads does not repaint it or resize it when it
changes. Build it with `trackedRaw()` from `@ttylabs/sigil/renderer` instead, as
the treemap is built. It takes what `raw()` takes, repaints the element whenever
a signal its last paint read changes, and lays it out again whenever a signal its
measure read changes. Build it inside a component, so that it stops listening when the
component goes away.

## Names and files from outside the app

**Show a name as it is.** File names, log lines and the output of other
programs can hold control characters. A `text` element drops them before it
paints, so none reaches the terminal. But dropping one changes what the reader
sees: a file named `bad<ESC>[31mname` is drawn as `bad[31mname`, which is not
its name. `printable()` from `@ttylabs/sigil/element` draws each control
character as `�` instead, so the name shows that it holds something. Pass text
you did not write through it before you draw it. For a file's contents, pass
`'\n\t'` as its second argument to keep the line breaks and tabs. The file
manager and the disk usage example draw every name this way.

**Offer the trash.** A reader can take an item back out of the trash, so an
app that removes files should usually offer it. `trash(path)` from
`@ttylabs/sigil/trash` moves a file or a directory to the Finder's trash on
macOS, the Recycle Bin on Windows, and the freedesktop.org trash that Linux
file managers read everywhere else. It never deletes: if the trash will not
take the item, the item stays where it is and the promise rejects with an error that
says why. The file manager and the disk usage example offer `t` for the trash
beside `d` for a delete. Each asks first with `confirmModal()`, which starts on
Yes unless it is passed `initial: 'no'`. The trash's question starts on Yes and
the delete's on No, because only the trash can be undone.

## Which example to read

The [examples](../../../examples) are complete apps built the way `hello` is,
each in the shape of a tool you may know. Each has a README that lists its keys
and what it shows. Read the one closest to what you are building:

| You are building                         | Read                                               | What it shows                                                                                                            |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| A form or a settings screen              | [settings](../../../examples/settings)             | Text fields, a radio set, a slider, a switch and checkboxes; a dialog whose button waits for valid input                 |
| A front end for another tool, like `git` | [git-client](../../../examples/git-client)         | Panes of lists beside a `DiffView`, staging single hunks, a text area in a dialog, confirms and toasts                   |
| A viewer for live data or logs           | [log-browser](../../../examples/log-browser)       | Tables of pods and deployments that update every second, a `:` command bar, and a log that follows, filters and searches |
| A file browser                           | [file-manager](../../../examples/file-manager)     | Miller columns of lists, previews of text, Markdown and PNG pictures, file operations, the trash                         |
| A dashboard                              | [dashboard](../../../examples/dashboard)           | A collapsible sidebar, cards, a chart, a table that sorts and pages, a row menu, light and dark themes                   |
| An editor, or anything people type into  | [editor](../../../examples/editor)                 | A file tree, tabs over text areas with highlighting, a Markdown preview, a command palette, unsaved changes              |
| A picture of sizes                       | [disk-usage](../../../examples/disk-usage)         | A tree beside a `Treemap` with one selection between them, a scan that runs as you watch, the trash                      |
| A monitor that refreshes on a clock      | [system-monitor](../../../examples/system-monitor) | Sparklines and charts, a process table that refreshes every second, a filter, themes                                     |

The git client, the log browser and the file manager are written twice, like
`hello`: once in JSX and once in the `ui` tag. The system monitor is written in
the `ui` tag, and the others in JSX.

Each example is a member of this repository's workspace. To run one, clone the
repository and, from its root:

```console
$ pnpm install
$ pnpm build
$ pnpm --filter @ttylabs/example-git-client start
```

Every example quits on Ctrl-C. Each also quits on `q`, except while a dialog
is open or the focus is in a field that types the letter. The editor's `q`
asks first while a file is unsaved; Ctrl-C does not ask. [Testing](testing.md)
covers the rest of `@ttylabs/sigil/testing`, which every example's own tests are
written with.
