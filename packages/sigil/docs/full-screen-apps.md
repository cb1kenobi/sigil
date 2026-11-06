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
  will be drawn. There is no virtual DOM.
- **`{() => String(count.get())}` is the reactive part.** A function child is
  called again whenever a signal it read changes, and only that text is
  updated. `{count.get()}` would be read once, and the number would never move.
- **`focusable` puts an element in the focus ring**, which Tab and Shift-Tab
  walk in document order. A key goes to the focused element first and then up
  through its ancestors, so a row handles its own Enter.
- **`app.input?.bind('q', ...)` is an app-wide binding.** It fires wherever
  the focus is. `app.exit()` ends the app with exit code `0`. Ctrl-C needs no
  binding: the runner ends the app on it, with `130`.

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

For the compiler to read that, `tsconfig.json` names sigil as the JSX source:

```json
// tsconfig.json
{
  "compilerOptions": {
    "jsx": "react-jsx",
    "jsxImportSource": "@ttylabs/sigil"
  }
}
```

`sigil new` writes those two lines for you.

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
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { expect, it } from 'vitest';

// frames are drawn on a clock, about 30 a second, rather than once per key.
// SIG-309 is a helper that waits for the next one; until then, a timer
const frame = () => new Promise((resolve) => setTimeout(resolve, 50));

it('should count what Enter presses and quit on q', async () => {
  const term = createTestTerminal({ columns: 60, rows: 16 });
  const done = runApp(App, { detect: false, sheets: [stylesheet], terminal: term.terminal }).exited;
  await frame();

  await term.press(KEYS.enter, KEYS.down, KEYS.enter);
  await frame();
  // the screen row by row; the last is the bottom border
  expect(term.viewport.at(-2)).toMatch(/^│ 2 presses +│$/);

  await term.press('q');
  expect(await done).toBe(0);
  expect(term.screen.alternate).toBe(false);
});
```

That is the example's whole test file, and the repository's suite runs it.
The first `frame()` matters: the first row takes the focus once the first frame
has drawn, so a key pressed before then has no row to go to. `detect: false`
skips asking the terminal what it is, which a test terminal cannot answer.

The [examples](../../../examples) are complete apps built this way.
