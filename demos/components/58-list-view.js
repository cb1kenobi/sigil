/**
 * A list view: two thousand packages, filtered, ticked, and updating under you.
 *
 *   node demos/components/58-list-view.js       <- Tab, arrows, PgUp/PgDn, Space, Ctrl-A, Enter, /, q
 *   node demos/components/58-list-view.js | cat
 *
 * One `ListView` over two thousand packages, sorted by their downloads, with a
 * filter field above it. Only the rows on screen are built, so the list costs what
 * twelve rows cost. The list is `multiple`: Space ticks the current row, Ctrl-A
 * ticks every row, a click ticks the row clicked, and Enter "opens" it.
 *
 * Three things to watch, and each is the list's selection being held by **key**:
 *
 * - **The data moves under the cursor, and the cursor stays on its package.** Every
 *   second a handful of packages are downloaded again, which replaces their items
 *   and re-sorts the list. The rows whose items changed are rebuilt, the rest are
 *   kept, and the cursor follows its package to wherever it now sits -- but the
 *   view follows the cursor only when the cursor moves, so a wheel scroll away is
 *   not snapped back by the next update.
 * - **Filtering is the app's.** The field above is a `TextField` and the items are a
 *   `Computed` over it and `rankBy()`: the list knows nothing about a filter, only
 *   that its items changed. `/` puts the focus in the field, from anywhere.
 * - **A tick outlives the filter.** Tick something, filter it out of sight, clear the
 *   filter: it is still ticked, because the selection is never pruned by the rows
 *   it can see -- which is also what a collapsed tree node needs.
 *
 * The footer is `keyHelp()` over `describeListView()`, so it lists the list's keys
 * only while the list has the focus.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree and
 * the demo prints it after each step, with an update standing in for the clock.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import {
  describeListView,
  highlightRuns,
  keyHelp,
  listControl,
  ListView,
  rankBy,
  TextField,
} from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { Computed, State } from '@ttylabs/sigil/signals';
import { createTestTerminal, ctrl, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;
const WIDTH = 48;
const ROWS = 12;

/** A deterministic generator, so a piped run prints the same thing every time. */
function random(seed) {
  let n = seed;
  return () => {
    n = (n * 1_103_515_245 + 12_345) % 2_147_483_648;
    return n / 2_147_483_648;
  };
}

/** Two thousand package names, `@scope/name` and plain, each with a download count. */
function packages() {
  const roll = random(7);
  const parts = ['core', 'cli', 'kit', 'parse', 'color', 'stream', 'path', 'glob', 'test', 'log'];
  const tails = ['', '-js', '-lite', '-utils', '-plus', '2', '-x', '-next'];
  const out = [];
  for (let i = 0; out.length < 2000; i++) {
    const a = parts[i % parts.length];
    const b = parts[Math.floor(i / parts.length) % parts.length];
    const tail = tails[Math.floor(i / 100) % tails.length];
    const scope = i % 3 === 0 ? `@${b}/` : '';
    const name = `${scope}${a}${a === b ? '' : `-${b}`}${tail}${i >= 800 ? i : ''}`;
    out.push({ downloads: Math.floor(roll() * 90_000) + 1000, name });
  }
  return out;
}

/** A count as a reader takes it in: `12.3k`. */
const count = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** The list, the filter over it, and the line under it that says what happened. */
function scene() {
  const all = new State(packages());
  const query = new State('');
  const status = text('', { class: 'sigil-muted', height: 1 });

  // filtering is the app's: the items are a Computed over the field and the data.
  // Each item is a new object whenever the query changes, because the highlight is
  // part of what a row draws -- and a new object is what tells the list to rebuild
  const items = new Computed(() => {
    const q = query.get();
    const sorted = all
      .get()
      .toSorted((a, b) => b.downloads - a.downloads || (a.name < b.name ? -1 : 1));
    if (q === '') {
      return sorted.map((pkg) => ({ matched: [], pkg }));
    }
    return rankBy(q, sorted, (pkg) => pkg.name).map(({ item, match }) => ({
      matched: match.matched,
      pkg: item,
    }));
  });

  const list = ListView({
    empty: 'No package matches',
    items,
    key: (it) => it.pkg.name,
    label: (it) => it.pkg.name,
    multiple: true,
    onActivate: (name) => status.setText(`opened ${name}`),
    props: { height: ROWS },
    row: ({ matched, pkg }) =>
      box(
        { 'flex-direction': 'row' },
        box(
          { 'flex-direction': 'row', 'flex-grow': 1, 'min-width': 0 },
          ...highlightRuns(pkg.name, matched).map((run) =>
            text(run.text, { class: run.on ? 'match' : '', 'white-space': 'pre' })
          )
        ),
        text(count(pkg.downloads), { class: 'sigil-muted', 'flex-shrink': 0, 'margin-left': 1 })
      ),
  });

  const field = TextField({
    placeholder: 'filter, or / from anywhere',
    value: query,
    width: WIDTH - 2,
  });
  const tally = text('', { class: 'sigil-muted' });
  const { selection } = listControl(list);
  // where the cursor goes when the filter changes is the app's call too: left
  // alone it stays on its package, or on the row that took its place, and a
  // filter wants the best match -- so a new query puts it on the first row
  createEffect(() => {
    query.get();
    selection.first();
  });
  createEffect(() => {
    const ticked = selection.selected.get().size;
    tally.setText(`${items.get().length} shown · ${ticked} ticked`);
  });

  /** A second of downloads: a few packages are fetched again, which re-sorts the list. */
  const roll = random(99);
  const tick = () => {
    const next = all.get().slice();
    for (let n = 0; n < 6; n++) {
      const at = Math.floor(roll() * 40);
      const pkg = next[at];
      next[at] = { ...pkg, downloads: pkg.downloads + Math.floor(roll() * 9000) };
    }
    all.set(next);
  };

  const root = box(
    { 'flex-direction': 'column', width: WIDTH },
    box(
      { 'flex-direction': 'row' },
      text('/ ', { class: 'sigil-accent', 'white-space': 'pre' }),
      field
    ),
    list,
    tally,
    status
  );
  return { field, list, root, selection, tick };
}

const sheet = '.match { color: yellow; font-weight: bold }';

if (live) {
  const ui = scene();
  const canvas = createInlineCanvas({ height: ROWS + 6 });
  /** The footer, appended once the router it reads exists. */
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade({ sheets: [sheet] }),
    height: ROWS + 6,
    width: 'auto',
  });
  const input = createInput({ mouse: { surface: canvas }, root: view.root });
  const timer = setInterval(ui.tick, 1000);

  const quit = () => {
    clearInterval(timer);
    view.dispose();
    input.stop();
  };
  // a fallback rather than a binding, so `q` typed into the filter is a letter
  input.fallback('q', quit, { description: 'quit', priority: 9 });
  input.fallback('/', () => input.focus.focus(ui.field), { description: 'filter', priority: 8 });
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
  input.describe('tab', { description: 'next', priority: 7 });
  describeListView(input, ui.list);
  footer.append(keyHelp(input, { width: 72 }));
  input.focus.focus(ui.list);
} else {
  const term = createTestTerminal({ columns: WIDTH });
  const ui = scene();
  const input = createInput({ root: ui.root, terminal: term.terminal });
  input.fallback('/', () => input.focus.focus(ui.field));
  describeListView(input, ui.list);
  const footer = keyHelp(input, { width: 72 });
  const cascade = themedCascade({ sheets: [sheet] });

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the tree and the footer under a heading. */
  const show = async (label) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width: WIDTH });
    const keys = renderToString(footer, { cascade, colorLevel: 0, width: 72 }).trimEnd();
    const at = input.focus.current.get();
    const focused = at === ui.list ? 'the list' : at === undefined ? 'nothing' : 'the filter';
    const current = ui.selection.current.get();
    console.log(
      `-- ${label}\n${body}\nfocus: ${focused}, cursor on ${current}\nkeys:  ${keys || '(none listed)'}\n`
    );
  };

  input.focus.focus(ui.list);
  await show('as built: two thousand packages, twelve rows of them built');

  await term.press(KEYS.down, KEYS.down, ' ', KEYS.down, ' ');
  await show('Down, Space, Down, Space: two ticked');

  ui.tick();
  ui.tick();
  ui.tick();
  await show('three seconds of downloads: the list re-sorts, the cursor stays on its package');

  await term.press(KEYS.pageDown, KEYS.pageDown);
  await show('Page Down twice: a page is the view less one row');

  await term.press('/', 'core-x');
  await show('/ and "core-x": the filter is the app\'s, a Computed over rankBy()');

  await term.press(KEYS.tab, KEYS.end, ' ', KEYS.enter);
  await show('Tab, End, Space, Enter: the last match ticked and opened');

  await term.press('/', ctrl('u'), 'zzz');
  await show('a filter that matches nothing: the empty state');

  await term.press(ctrl('u'));
  await show('the filter cleared: all three ticks survived it');

  input.stop();
}
