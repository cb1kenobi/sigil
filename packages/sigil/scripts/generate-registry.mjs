/**
 * Builds `registry/`: the component sources `sigil add` copies into an app.
 *
 * Run as part of this package's `build`, and the output is shipped rather than
 * committed -- it is derived from `src/components/` in full, so a committed
 * copy would be a second spelling of those files with nothing keeping the two
 * in agreement.
 *
 * ## Why the package has to carry sources at all
 *
 * `files` is `["dist", "registry"]`, and `dist` is bundled, minified, and
 * chunked by something other than module boundaries -- there is no
 * `spinner.mjs` in it to copy, and if there were it would be minified output
 * rather than something anybody wants in their source tree. So the ejectable
 * form is generated here.
 *
 * It ships in `@ttylabs/sigil` rather than in the toolchain on purpose: the app
 * depends on the runtime at an exact version, so the source it ejects always
 * matches the API it is ejected from. In `@ttylabs/cli` -- a devDependency, on
 * its own version line -- a copy of `spinner.ts` could be a release ahead of
 * the runtime the app actually imports.
 *
 * ## The rewrite, and why it can happen here
 *
 * A component imports its neighbours relatively (`../element/index.js`), and
 * those paths mean nothing once the file is in somebody's app. Each one is
 * rewritten to the published subpath that answers for it, which is a mapping
 * this package already writes down twice -- the `exports` map and the tsdown
 * entry list, which `test/exports.test.ts` keeps in agreement.
 *
 * The rewrite does **not** depend on where the file lands, which is the
 * property that lets it happen at build time rather than inside `sigil add`. A
 * sibling import goes to that sibling's own subpath -- `./mount.js` is
 * `@ttylabs/sigil/components/mount` -- rather than to a copy of the sibling, so
 * ejecting a spinner does not drag `mount.ts` along: what those siblings export
 * is public API, and the whole point of ejecting is to own the *component*, not
 * the plumbing under it. Its own subpath rather than the barrel since SIG-330,
 * because an ejected spinner that imported the barrel would load every other
 * component to draw itself -- more than the built-in spinner it replaced.
 *
 * So what ships is exactly what lands in the app, byte for byte, and `add` is a
 * copy anybody can audit rather than a transform they have to trust.
 */

import { readFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const out = join(root, 'registry');

const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));

/**
 * The entries, and nothing else in `src/components/`.
 *
 * `index.ts` is the barrel, and `mount.ts` and `keys.ts` are the plumbing the
 * rule above says stays in the package. What is listed here is what somebody
 * would want to *edit*: a spinner whose frames should be different, a table
 * that should draw its own borders, a prompt that should take another key.
 *
 * One entry per file rather than one per export. `prompt.ts` holds all five
 * prompts and splitting it into five entries means splitting the source, which
 * is a refactor of the runtime rather than a decision about a registry.
 */
const ENTRIES = [
  {
    desc: 'An animated spinner that settles into a success or failure line',
    name: 'spinner',
  },
  {
    desc: 'More spinner frame sets -- dots variants, a star, a triangle, sand and the rest -- as data to copy in',
    name: 'spinner-frames',
  },
  {
    desc: 'A progress bar that falls back to a percentage where there is no terminal',
    name: 'progress',
  },
  {
    desc: 'Several progress bars in one live region, each with a rate and a time remaining',
    name: 'multi-progress',
  },
  {
    desc: 'A stopwatch and a timer: a count as signals, with a readout that ticks only where it can draw',
    name: 'clock',
  },
  {
    desc: 'A table with measured column widths, alignment and truncation',
    name: 'table',
  },
  {
    desc: 'Banner text: a FIGlet renderer and the .flf format',
    name: 'large-text',
  },
  {
    desc: 'The six prompts: text, multiline, password, confirm, select and multiselect',
    name: 'prompt',
  },
  {
    desc: 'An editor prompt: write the answer in $VISUAL or $EDITOR, from a temporary file removed on every exit',
    name: 'editor',
  },
  {
    desc: 'autocomplete() and autocompleteMultiselect(): type to filter a list, or search an async source',
    name: 'autocomplete',
  },
  {
    desc: 'A multiselect with its choices under named groups, where a group ticks its children',
    name: 'group-multiselect',
  },
  {
    desc: "A select-by-key prompt: press a choice's key, number the choices, or expand a compact line",
    name: 'select-key',
  },
  {
    desc: 'A path prompt: a text field that completes against the file system',
    name: 'path',
  },
  {
    desc: 'A file picker: browse a directory tree with the arrows, and answer the entry you land on',
    name: 'file-picker',
  },
  {
    desc: 'A sort prompt: pick a row up and move it to put a list in order',
    name: 'sort',
  },
  {
    desc: 'A table prompt: a cursor over rows, a sticky heading, and a sort by column',
    name: 'select-row',
  },
  {
    desc: 'A toggle prompt: a setting with two named states, flipped with the arrows, Tab or Space',
    name: 'toggle',
  },
  {
    desc: 'A list prompt: one line split on a separator and returned as an array',
    name: 'list',
  },
  {
    desc: 'A masked text prompt: a line that follows a template, with fixed characters skipped',
    name: 'masked-text',
  },
  {
    desc: 'A number prompt: min, max, step, and arrows that change the value',
    name: 'number',
  },
  {
    desc: 'A date prompt: year, month and day segments, with min and max',
    name: 'date',
  },
  {
    desc: 'A command palette generated from the command registry, answering with an argv',
    name: 'palette',
  },
  {
    desc: 'A scrolling viewport with a scrollbar, keyboard, wheel and a draggable thumb',
    name: 'scroll-box',
  },
  {
    desc: 'A collapsible section: a focusable title that opens and closes its body, alone or as an accordion',
    name: 'collapsible',
  },
  {
    desc: 'Tabs: a row of labels with one active, and the panels it switches',
    name: 'tabs',
  },
  {
    desc: 'A list view: a focusable, virtualized list of rows with a current row and single or multiple selection by key',
    name: 'list-view',
  },
  {
    desc: 'A tree list view: a focusable tree that opens and closes, selects by value, and reads children lazily',
    name: 'tree-list-view',
  },
  {
    desc: 'A data table: a list view with a sortable heading, columns fitted to the width, and live rows that keep the selection',
    name: 'data-table',
  },
  {
    desc: 'A pager over a scroll box: less keys, line numbers, and / search with highlighted matches',
    name: 'pager',
  },
  {
    desc: 'A typewriter that reveals text a grapheme, word or line at a time',
    name: 'typewriter',
  },
  {
    desc: 'A decrypt effect: text that jumbles and then resolves into itself',
    name: 'decrypt',
  },
  {
    desc: 'A modal: a dialog over the screen with a focus trap, Escape to dismiss, and a yes-or-no helper',
    name: 'modal',
  },
  {
    desc: 'A text field: one editable line as an element, for a form or a dialog',
    name: 'text-field',
  },
  {
    desc: 'A button: a label that Enter, Space or a click presses, bracketed while it has the focus',
    name: 'button',
  },
  {
    desc: 'A checkbox: [x] or [ ] beside a label, ticked with Space or a click, for a form',
    name: 'checkbox',
  },
  {
    desc: 'A radio set: one of several options as one focus stop, the arrows selecting inside it',
    name: 'radio-set',
  },
  {
    desc: 'A slider: a value on a track, moved a step or a page by the keys and dragged by the pointer, with an optional readout',
    name: 'slider',
  },
  {
    desc: 'A switch: two named states, moved with Left, Right, Space or a click, for a form',
    name: 'switch',
  },
  {
    desc: 'A text area: several editable lines as an element, scrolled both ways, with line numbers, a selection and a highlight seam',
    name: 'text-area',
  },
  {
    desc: 'A toast: a timed message in a corner of the screen that stacks, never takes the focus, and stays out of --quiet',
    name: 'toast',
  },
  {
    desc: 'A tooltip: text anchored to an element, shown on hover or focus, flipped to stay on screen',
    name: 'tooltip',
  },
  {
    desc: 'A menu anchored to an element or to the pointer, with submenus, disabled items and separators, and a context menu on right click or Shift-F10',
    name: 'menu',
  },
  {
    desc: 'A menubar: titles across the top that open menus, from F10, an Alt-letter or the pointer',
    name: 'menubar',
  },
  {
    desc: 'A dropdown select: a field showing one choice that opens a list of the others',
    name: 'dropdown',
  },
  {
    desc: 'Markdown drawn as styled text: headings, emphasis, code, lists, quotes, tables and OSC 8 links, wrapped to the terminal',
    name: 'markdown',
  },
  {
    desc: 'A debug overlay: captured console output and frame stats, inside the app',
    name: 'debug-overlay',
  },
  {
    desc: 'group() to run prompts as one flow, and intro, outro and cancel to frame the session',
    name: 'group',
  },
  {
    desc: "tasks() and taskLog(): a list of work under spinners, and a subprocess's output in a window",
    name: 'tasks',
  },
  {
    desc: 'A QR code, encoded here and drawn in half blocks or in full cells',
    name: 'qrcode',
  },
  {
    desc: 'A titled, bordered block that shrinks to its message, in a state role colour',
    name: 'note',
  },
  {
    desc: 'A panel: a bordered region with a title, an annotation, a footer and a footer annotation set into its border, fitted to its width',
    name: 'panel',
  },
  {
    desc: 'A pane: a region sized in cells, with an edge to drag, nudge from the keyboard, or double-click to collapse',
    name: 'pane',
  },
  {
    desc: 'A key-help footer generated from the key bindings that are live',
    name: 'key-help',
  },
  {
    desc: 'A short status label: PASS, FAIL or beta, in a state role colour, usable as a table cell',
    name: 'badge',
  },
  {
    desc: 'Leveled status lines: info, success, warn, error and step, above any live region',
    name: 'log',
  },
  {
    desc: 'Bulleted, numbered and nested lists, with a function for an enumerator and a hanging indent',
    name: 'outline',
  },
  {
    desc: 'A tree: nested data printed with ├── and └──, a prompt that opens and closes branches read on demand, and a directory tree',
    name: 'tree',
  },
  {
    desc: 'Charts: a sparkline, bars, a braille line chart and a gauge, printed or live -- fed from signals and sized by the layout -- and the Series ring buffer that feeds them',
    name: 'chart',
  },
  {
    desc: 'A horizontal divider across the terminal, with an optional label set into it',
    name: 'rule',
  },
  {
    desc: 'A diff view: unified or side by side, over two texts or a unified patch, with the edited words set apart',
    name: 'diff',
  },
  {
    desc: 'An image: a picture resampled to the box layout gave it and drawn in half blocks, alpha mixed over what is under it',
    name: 'image',
  },
];

/** `./src/element/index.ts` -> `element`, read off the build's own entry list. */
const subpaths = new Map();
for (const [name, source] of Object.entries(entryMap())) {
  subpaths.set(source.replace(/^\.\//, ''), name);
}

/**
 * The tsdown entry map, read as text rather than imported.
 *
 * Importing it would pull tsdown in, and this script runs after the build has
 * already finished with it. The shape is a flat object literal of
 * `name: './src/...'`, which is the whole of what is needed.
 *
 * @returns The entry name for each source path.
 */
function entryMap() {
  const source = readFileSync(join(root, 'tsdown.config.ts'), 'utf-8');
  const block = source.slice(source.indexOf('entry: {'), source.indexOf('format:'));
  const found = {};

  for (const [, name, path] of block.matchAll(/([\w'-]+):\s*'([^']+)'/g)) {
    found[name.replaceAll("'", '')] = path;
  }

  if (Object.keys(found).length === 0) {
    throw new Error('Read no entries out of tsdown.config.ts');
  }

  return found;
}

/**
 * Source paths that are published by a barrel rather than by an entry of their own.
 *
 * `src/types.ts` is re-exported whole by the root entry (`export * from
 * './types.js'`), so a type a component imports from it is on `@ttylabs/sigil`
 * even though no tsdown entry names the file. The map above is built from the
 * entry list and cannot see that; this is the one place it is written down.
 *
 * `src/util/by-code-unit.ts` is the same shape for one function: `byCodeUnit()`
 * is published from `@ttylabs/sigil/reference`, and the path and table prompts
 * import the module itself rather than that entry, because the entry is the
 * whole command surface and importing it put about 29 kB on the components
 * graph for a three-token comparison. An ejected copy imports it from the
 * subpath, where an app's own bundler shakes the rest.
 *
 * `src/util/escape-regexp.ts` is the same shape again: `escapeRegExp()` is
 * published beside `byCodeUnit()` for the toolchain, and the pager's literal
 * search imports the module itself for the same reason.
 *
 * `src/util/error-message.ts` is that shape too: `errorMessage()` is
 * published from `@ttylabs/sigil/error-handler`, and lives in a leaf module so
 * that the signals graph can ask it without importing the error handler. The
 * components import the leaf, for the same reason the signals do.
 */
const BARRELLED = new Map([
  ['src/types.ts', 'index'],
  ['src/util/by-code-unit.ts', 'reference'],
  ['src/util/escape-regexp.ts', 'reference'],
  ['src/util/error-message.ts', 'error-handler'],
]);

/**
 * One import specifier, as the ejected copy should spell it.
 *
 * @param spec - The specifier as the source writes it.
 * @returns The published specifier, or `undefined` if it is already one.
 */
function rewrite(spec) {
  if (!spec.startsWith('.')) {
    return undefined;
  }

  // a sibling: `./mount.js` is `src/components/mount.ts`, and what it exports
  // is reached through its own subpath, `@ttylabs/sigil/components/mount`
  if (spec.startsWith('./')) {
    const sibling = `components/${spec.slice(2).replace(/\.js$/, '')}`;
    if (!(`./${sibling}` in manifest.exports)) {
      throw new Error(
        `"${spec}" is a sibling with no subpath of its own. ` +
          `A registry component may only import what the package exports.`
      );
    }
    return `${manifest.name}/${sibling}`;
  }

  // `../element/index.js` -> `src/element/index.ts`
  const source = `src/${spec.replace(/^\.\.\//, '').replace(/\.js$/, '.ts')}`;
  const subpath = subpaths.get(source) ?? BARRELLED.get(source);

  if (!subpath) {
    throw new Error(
      `"${spec}" resolves to ${source}, which no published subpath answers for. ` +
        `A registry component may only import what the package exports.`
    );
  }

  return subpath === 'index' ? manifest.name : `${manifest.name}/${subpath}`;
}

/** Every `from '...'` in a source file, rewritten. */
function rewriteImports(source) {
  return source.replaceAll(/(\bfrom\s*)'([^']+)'/g, (whole, from, spec) => {
    const to = rewrite(spec);
    return to === undefined ? whole : `${from}'${to}'`;
  });
}

rmSync(out, { force: true, recursive: true });
mkdirSync(out, { recursive: true });

const entries = {};

for (const { desc, name } of ENTRIES) {
  const file = `${name}.ts`;
  const source = rewriteImports(readFileSync(join(root, 'src', 'components', file), 'utf-8'));

  // the check that the rewrite is total. A relative specifier left behind is a
  // file that will not resolve once it is in somebody's app, and it would fail
  // for them rather than here
  const leftover = [...source.matchAll(/\bfrom\s*'(\.[^']*)'/g)].map(([, spec]) => spec);
  if (leftover.length > 0) {
    throw new Error(`${file} still imports ${leftover.join(', ')} relatively`);
  }

  writeFileSync(join(out, file), source);

  entries[name] = {
    classes: [...new Set(source.match(/sigil-[a-z-]+/g) ?? [])].sort(),
    desc,
    files: [{ from: file, to: file }],
    imports: [...new Set([...source.matchAll(/\bfrom\s*'(@[^']+)'/g)].map(([, s]) => s))].sort(),
    // nothing in the seed registry needs another entry: every import a
    // built-in makes is answered by a published subpath, so there is no file
    // to drag along. The field is here because a third-party registry will
    // have them, and a shape that only describes the easy case is one that
    // gets discovered to be wrong by somebody else
    registryDeps: [],
  };
}

writeFileSync(
  join(out, 'registry.json'),
  `${JSON.stringify({ entries, name: manifest.name, version: manifest.version }, undefined, 2)}\n`
);

process.stdout.write(`Wrote ${ENTRIES.length} registry entries to ${out}\n`);
