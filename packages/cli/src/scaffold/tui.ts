/**
 * `sigil new`: the full-screen app a scaffold can include.
 *
 * A TUI is something a command does rather than a third layout, so nothing here
 * decides how an app's commands are arranged. `index.ts` still asks that, and
 * this file answers the questions that follow it: where the app is launched
 * from, which template syntax it is written in, and what the files are.
 *
 * ## Where the component lives, and how it is loaded
 *
 * `src/ui/`, never `commands/`. A route is a `.js`, `.mjs`, `.cjs`, `.ts`, `.mts`
 * or `.cts` file and `.tsx` is none of those, so a component in `commands/`
 * would not be a command at all -- and Node cannot import it from source either,
 * which is what makes a JSX app a built one.
 *
 * Whatever launches it loads it with a dynamic `import()` **inside** `run`.
 * That is the point of a command tree being lazy: a static import would put the
 * renderer behind `myapp login`, which is a command that has nothing to draw.
 *
 * The specifier names the file as it is, `app.tsx` and not `app.js`. A `.js`
 * would build -- measured, rolldown resolves `.js` to `.tsx` -- but the `ui`-tag
 * scaffold runs unbuilt, and Node does not map a `.js` to the `.ts` that is
 * there. One spelling that works under every runner beats two that are each
 * right for one.
 */

import type { Language, Layout } from './index.ts';

/** The template syntax the component is written in. */
export type Syntax = 'jsx' | 'ui';

/** The syntaxes, which is `--syntax`'s `choices` and the prompt's list. */
export const SYNTAXES: readonly Syntax[] = ['jsx', 'ui'];

/** Where the full-screen app is launched from. */
export type Tui = { readonly at: 'command'; readonly command: string } | { readonly at: 'root' };

/** The command a TUI placed on one is called, unless it is told otherwise. */
export const DEFAULT_TUI_COMMAND = 'dashboard';

/**
 * The names a command that launches the app may not take, and why, from one list.
 *
 * `hello` is the example the scaffold writes beside it and `index` is the
 * directory itself. `help` and `completion` are the two commands the runtime adds
 * to every app: declaring one replaces the framework's, so `myapp help` would
 * open the screen and lose its description, and `completion` would break shell
 * completion install. Those two are what `registerHelp()` and the completion
 * command in `@ttylabs/sigil` register under `builtIn`.
 */
const RESERVED_COMMANDS: Readonly<Record<string, string>> = Object.assign(Object.create(null), {
  completion: 'the command every app has for installing shell completion',
  hello: 'the example command the scaffold already writes',
  help: 'the command every app has for describing its commands',
  index: 'the directory itself, and not a command called index',
});

/**
 * What is wrong with a name for the command that launches the app.
 *
 * The name becomes a file, `commands/<name>.ts`, and the command argv spells, so
 * it has to be both at once: lowercase letters, digits and hyphens, starting
 * with a letter, and not one of the {@link RESERVED_COMMANDS}.
 *
 * @param name - The proposed name.
 * @returns What is wrong with it, or `undefined`.
 */
export function commandNameProblem(name: string): string | undefined {
  if (name.length === 0) {
    return 'A command name is required';
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return 'A command name may only hold lowercase letters, digits and hyphens, and must start with a letter';
  }
  const reserved = RESERVED_COMMANDS[name];
  if (reserved !== undefined) {
    return `That name is ${reserved}`;
  }
  return undefined;
}

/** The extension the component takes: the syntax decides whether it is a template or JSX. */
export function componentExt(language: Language, syntax: Syntax): string {
  if (syntax === 'jsx') {
    return language === 'ts' ? 'tsx' : 'jsx';
  }
  return language === 'ts' ? 'ts' : 'js';
}

/** Where the component is, relative to the app root. */
export function componentPath(language: Language, syntax: Syntax): string {
  return `src/ui/app.${componentExt(language, syntax)}`;
}

/**
 * The `run` that opens the app, as a member of an object literal.
 *
 * Both launchers -- the schema's own and a command's -- are the same four lines,
 * so this is one function and the specifier is its only argument.
 *
 * @param language - The language the app is written in.
 * @param specifier - Where the component is, from the file this is written into.
 * @returns The method, indented two spaces.
 */
export function launcher(language: Language, specifier: string): string {
  const typed = language === 'ts';

  return `  // Opens the full-screen app. The component is imported here, inside \`run\`,
  // and not at the top of the file: a static import would load the renderer for
  // every command and for \`--help\`, where this way only the run that draws
  // anything pays for it.
  //
  // \`runApp()\` resolves an exit code and leaves \`process.exitCode\` alone, so
  // making it the process's is this line's job. Nothing is returned, because what
  // \`run()\` returns is the command's answer and is printed.
  async run()${typed ? ': Promise<void>' : ''} {
    const { runApp } = await import('@ttylabs/sigil/app');
    const { App, stylesheet } = await import('${specifier}');

    process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited;
  },
`;
}

/** The command that launches the app, when it is a command of its own. */
export function tuiCommand(
  language: Language,
  syntax: Syntax,
  name: string,
  command: string
): string {
  return `// \`${name} ${command}\` opens the full-screen app, and the app is in
// \`src/ui/\`: a command is a file here, and a file here is loaded as a module,
// which is not something a \`.tsx\` can be.
export default {
  desc: 'Open the full-screen app',

${launcher(language, `../ui/app.${componentExt(language, syntax)}`)}};
`;
}

/** What a full-screen app's files are written from. */
export interface TuiApp {
  /** The language. */
  readonly language: Language;
  /** The layout, which `--single` is. */
  readonly layout: Layout;
  /** The app's name. */
  readonly name: string;
  /** The syntax it was written in. */
  readonly syntax: Syntax;
  /** Where it is launched from. */
  readonly tui: Tui;
}

/**
 * The command that scaffolds this same app in the other template syntax.
 *
 * Runnable as written, which is the whole of why it is built from the flags
 * rather than from prose: `--syntax` alone is refused under `--yes` and asks the
 * TUI question again interactively, so the hint has to carry the TUI flag, and
 * the command form when the app was launched from one.
 *
 * @param app - The app that was written.
 * @returns The command line, for a person to run.
 */
export function otherSyntaxCommand(app: TuiApp): string {
  const flags = [
    ...(app.language === 'js' ? ['--js'] : []),
    ...(app.layout === 'single' ? ['--single'] : []),
    ...(app.tui.at === 'command' ? ['--tui-command', app.tui.command] : ['--tui']),
    '--syntax',
    app.syntax === 'jsx' ? 'ui' : 'jsx',
  ];
  return `sigil new ${app.name} ${flags.join(' ')}`;
}

/** The app's own sheet, over the framework's. */
const STYLESHEET = `  .app { flex-direction: column; flex-grow: 1 }
  .title { font-weight: bold; padding: 0 1 }
  .rows { flex-direction: column }
  .row { padding: 0 1 }
  .row:focus { background-color: blue; color: white }
  .status { flex-direction: row; padding: 0 1 }
  .keys { flex-grow: 1 }
  .chosen { flex-shrink: 0; font-weight: bold; margin-left: 1; white-space: nowrap }`;

/**
 * The component, in whichever syntax was chosen.
 *
 * It is small on purpose: enough to show the runner, a layout, the focus ring,
 * an `onKey` prop and the key-help footer, and no more. It is the file an author
 * deletes the contents of, so anything in it that is not teaching something is
 * something to delete first.
 *
 * @param app - What was chosen.
 * @returns The module.
 */
export function component(app: TuiApp): string {
  const { language, name, syntax } = app;
  const typed = language === 'ts';
  const jsx = syntax === 'jsx';

  const imports = [
    "import { useApp } from '@ttylabs/sigil/app';",
    "import { keyHelp } from '@ttylabs/sigil/components/key-help';",
    "import { Panel } from '@ttylabs/sigil/components/panel';",
    ...(typed ? ["import type { Element } from '@ttylabs/sigil/element';"] : []),
    ...(typed && !jsx ? ["import type { KeyEvent } from '@ttylabs/sigil/input';"] : []),
    "import { onMount } from '@ttylabs/sigil/renderer';",
    "import { State } from '@ttylabs/sigil/signals';",
    ...(jsx ? [] : ["import { ui } from '@ttylabs/sigil/template';"]),
  ].join('\n');

  const other = otherSyntaxCommand(app);
  const how = jsx
    ? `// JSX makes real elements, so \`<box>\` is an element and not a description of
// one. Node strips types and does not compile JSX, which is why this app is
// built: the \`dev\` script runs \`sigil build\` first, and the build type-checks.
// The \`ui\` tag is the same program with nothing to build, and what it gives up
// is the editor checking every prop. To write it that way:
//
//   ${other}`
    : `// The \`ui\` tag makes real elements out of a template, and it runs as it is:
// Node strips the types and there is no JSX to compile, so there is no build
// between an edit and the \`dev\` script. What that gives up is the editor checking
// every prop. To write the same program in JSX:
//
//   ${other}`;

  const rows = jsx
    ? `  // one row per item. \`focusable\` puts it in the focus ring, and \`:focus\` in the
  // sheet above is the whole of the highlight
  const rows = ITEMS.map((item) => (
    <box
      class="row"
      focusable
      // a handler can be written where the element is. It sees a key while the
      // row, or anything inside it, has the focus
      onKey={(event) => {
        if (event.key.name === 'enter') {
          // Enter is this row's, so it stops here rather than reaching the app
          event.stop();
          chosen.set(item);
        }
      }}
    >
      <text>{item}</text>
    </box>
  ));`
    : `  // a template has no scope to write a handler into, so the handler is
  // interpolated -- and named, so that its type is written once
  const onEnter = (item${typed ? ': string' : ''}) => (event${typed ? ': KeyEvent' : ''}) => {
    if (event.key.name === 'enter') {
      // Enter is this row's, so it stops here rather than reaching the app
      event.stop();
      chosen.set(item);
    }
  };

  // one row per item. \`focusable\` puts it in the focus ring, and \`:focus\` in the
  // sheet above is the whole of the highlight
  const rows = ITEMS.map(
    (item) => ui\`
      <box class="row" focusable onKey=\${onEnter(item)}>
        <text>\${item}</text>
      </box>
    \`
  );`;

  const list = jsx
    ? '  const list = <box class="rows">{rows}</box>;'
    : '  const list = ui`<box class="rows">${rows}</box>`;';

  const screen = jsx
    ? `  return (
    <box class="app">
      <text class="title">{NAME}</text>
      <Panel title="Sections">{list}</Panel>
      <box class="status">
        <box class="keys">{keys}</box>
        <text class="chosen">{status}</text>
      </box>
    </box>
  );`
    : `  // a component is interpolated rather than named, because a tag has no scope
  // to look a name up in. Host elements stay bare
  return ui\`
    <box class="app">
      <text class="title">\${NAME}</text>
      <\${Panel} title="Sections">\${list}</\${Panel}>
      <box class="status">
        <box class="keys">\${keys}</box>
        <text class="chosen">\${status}</text>
      </box>
    </box>
  \`;`;

  return `// ${name}'s full-screen app.
//
${how}
//
// \`App\` takes no props: \`useApp()\` hands it the app it is running under.
${imports}

const NAME = '${name}';

const ITEMS = ['Overview', 'Tasks', 'Logs', 'Settings'];

/** The app's own sheet, over the framework's: CSS, over cells. */
export const stylesheet = \`
${STYLESHEET}
\`;

/**
 * A list to move through and choose from, and a status bar.
 *
 * @returns The screen.
 */
export function App()${typed ? ': Element' : ''} {
  // the app this is running under: its router, and the way to end it. Read in
  // the body, since a handler that runs later has no owner to ask
  const app = useApp();
  const { input } = app;
  if (input === undefined) {
    // an app that refused to start has no router, and never builds a component
    throw new Error('The app has no input router');
  }

  // what Enter chose, and what the status bar says. A component runs once and
  // nothing re-renders: a function in the tree is called again when a signal it
  // reads changes, and only that text is redrawn
  const chosen = new State('');

${rows}

${list}

  // what the status bar says: nothing until Enter has chosen something. A function,
  // so that it is read again when \`chosen\` changes
  const status = () => (chosen.get() === '' ? '' : \`selected: \${chosen.get()}\`);

  // the key-help footer, from the bindings below. It is told how wide it may be:
  // the terminal less what the status says now and the bar's own padding and margin,
  // so the two share a row and neither wraps. Reading \`status()\` here is what makes
  // it follow the choice
  const keys = keyHelp(input, {
    width: () => Math.max(0, app.terminal.width - status().length - 3),
  });

  // up and down move the focus round the ring, and what they are described as is
  // what the footer lists. Bound once for the whole app, so they work wherever
  // the focus is
  input.bind('up', () => input.focus.previous(), { description: 'move', priority: 3 });
  input.bind('down', () => input.focus.next(), { description: 'move', priority: 3 });
  // Enter is the row's \`onKey\`, which is a function and so says nothing about
  // which keys it is for. This is what lists it, while a row has the focus
  input.describe('enter', { description: 'select', priority: 2, scope: list });
  // \`q\` quits with 0 and Ctrl-C with 130, and both are \`runApp()\`'s own, so there
  // is nothing to bind and the footer already lists the first

  // after the first frame, which is when the ring has something in it
  onMount(() => input.focus.focus(rows[0]));

${screen}
}
`;
}

/** What a test is told about the terminal it runs over. */
export interface TuiTestOptions {
  /** The language. */
  readonly language: Language;
  /** The app's name. */
  readonly name: string;
  /** Where it is launched from. */
  readonly tui: Tui;
  /** The syntax, which decides the component's extension. */
  readonly syntax: Syntax;
}

/**
 * The test a full-screen app starts with.
 *
 * This is the one a new TUI author copies, so it explains why it is built the
 * way it is. Two facts a test of a screen cannot derive from outside:
 *
 * - `runApp()` takes the terminal as an option, and `createTestTerminal()` is one
 *   -- a screen of a size the test chose, which keys can be pressed into and which
 *   can be read back row by row. Nothing is drawn anywhere and nothing waits for a
 *   person.
 * - It asserts on **text**. A panel draws box-drawing characters where the
 *   terminal can show them and ASCII where it cannot, which is every Windows CI
 *   runner, so a border character in an assertion is a test that passes on the
 *   machine it was written on.
 *
 * @param opts - What was chosen.
 * @returns The file.
 */
export function tuiTest(opts: TuiTestOptions): string {
  const { language, name, syntax, tui } = opts;
  const typed = language === 'ts';
  const component = `../${componentPath(language, syntax)}`;
  const argv = tui.at === 'command' ? `['${tui.command}']` : '[]';

  return `// A full-screen app, tested without a screen.
//
// \`runApp()\` takes the terminal it draws on as an option, and
// \`createTestTerminal()\` is one: a screen of the size the test asks for, which
// keys can be pressed into and which can be read back a row at a time. Nothing
// is drawn anywhere and nothing waits for a person to type.
//
// Assert on the text on the screen, and leave the border out of it. A panel draws
// box-drawing characters where the terminal can show them and plain ASCII where it
// cannot -- every Windows CI runner is one -- so a border in an assertion is a
// test that passes on the machine it was written on and nowhere else.
//
// \`frame()\` is there because frames are drawn on a clock, about thirty a second,
// and not once per key: it paints the next one now instead of waiting for it.
import schema from '../src/index.${language === 'ts' ? 'ts' : 'js'}';
import { App, stylesheet } from '${component}';
import { runApp } from '@ttylabs/sigil/app';
import { createTestTerminal, ctrl, frame, KEYS, runCommand } from '@ttylabs/sigil/testing';
import { describe, expect, it } from 'vitest';

/** Opens the app on a terminal that is 14 rows high and, unless it is told, 60 columns wide. */
function open(columns = 60) {
  const term = createTestTerminal({ columns, rows: 14 });
  const app = runApp(App, { detect: false, sheets: [stylesheet], terminal: term.terminal });

  return { app, term };
}

describe('${name} full-screen app', () => {
  it('lists one item to a row', async () => {
    const { app, term } = open();
    await frame(app);

    const row = (item${typed ? ': string' : ''}) => term.viewport.findIndex((line) => line.includes(item));
    expect(row('Overview')).toBeGreaterThanOrEqual(0);
    expect(row('Tasks')).toBeGreaterThan(row('Overview'));

    await term.press('q');
    await app.exited;
  });

  it('shows what Enter chose', async () => {
    const { app, term } = open();

    // the first row has the focus once the app is up, so down moves to the second
    await term.press(KEYS.down, KEYS.enter);
    await frame(app);

    expect(term.viewport.join('\\n')).toContain('selected: Tasks');

    await term.press('q');
    await app.exited;
  });

  it('keeps what Enter chose on one line in a narrow terminal', async () => {
    // the footer is given the width the status leaves it, so the two share a row.
    // Left to take the terminal's whole width it pushed the status onto a second
    // line, which is how the text of a status gets cut in half
    const { app, term } = open(30);

    await term.press(KEYS.down, KEYS.down, KEYS.down, KEYS.enter);
    await frame(app);

    expect(term.viewport.some((line) => line.includes('selected: Settings'))).toBe(true);

    await term.press('q');
    await app.exited;
  });

  it('quits with 0 on q, and gives the screen back', async () => {
    const { app, term } = open();

    await term.press('q');

    expect(await app.exited).toBe(0);
    expect(term.screen.alternate).toBe(false);
  });

  it('quits with 130 on Ctrl-C, which is what a shell reports for an interrupt', async () => {
    const { app, term } = open();

    await term.press(ctrl('c'));

    expect(await app.exited).toBe(130);
  });

  it('refuses without a terminal, which is what a pipe is', async () => {
    // \`runCommand()\` runs the real \`main()\`, so this is the app as a script
    // meets it: one line on stderr and a non-zero exit, and nothing drawn.
    //
    // A test runner's streams are pipes, which is what makes this refuse, and a
    // runner that hands its own terminal down would open the real app instead and
    // wait for a key nobody is going to press. So the one thing \`runApp()\` asks of
    // stdin is pinned rather than assumed
    const was = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    try {
      const ran = await runCommand({ argv: ${argv}, schema });

      expect(ran.code).toBe(1);
      expect(ran.out).toBe('');
      expect(ran.err).toContain('not a terminal');
    } finally {
      if (was) {
        Object.defineProperty(process.stdin, 'isTTY', was);
      } else {
        Reflect.deleteProperty(process.stdin, 'isTTY');
      }
    }
  });
});
`;
}
