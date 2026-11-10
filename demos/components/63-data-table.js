/**
 * A data table: three hundred processes, sorted, re-read every second.
 *
 *   node demos/components/63-data-table.js       <- Tab, arrows, PgUp/PgDn, 1-7, a click on a heading, Space, f, q
 *   node demos/components/63-data-table.js | cat
 *
 * One `DataTable` over a made-up process list in the shape htop draws it: a pid, a
 * user, CPU and memory, a resident size, a state and a command. Every second each
 * process gets a new reading, a few exit and a few start -- every row object is
 * replaced -- and the table is sorted by CPU, so the rows trade places on every
 * tick. Only the rows on screen are built.
 *
 * Three things to watch:
 *
 * - **The cursor stays where it is, and `f` makes it follow its process.** By
 *   default the highlight keeps its place on screen and the processes re-sort under
 *   it, which is htop's default and the only readable one for a table that re-sorts
 *   every second. Press `f` and it follows the process instead, wherever the sort
 *   carries it -- htop's `F` -- and `f` again puts it back. The table is keyed on the
 *   pid either way, so a ticked row stays ticked as it moves. Sorted by pid -- press
 *   1 -- nothing moves but the numbers, and the two modes look the same.
 * - **A click on a heading sorts, and so does a digit.** The first press sorts the
 *   column its first way (CPU, memory and size start from the top), the second the
 *   other way, the third puts the rows back as they came. The arrow is drawn in two
 *   columns every sortable heading keeps back, so turning a sort on moves nothing.
 * - **A narrow terminal hides columns rather than scrolling them.** Make the window
 *   narrower: the command column gives way to its minimum first, and then RSS, USER
 *   and STATE go, lowest priority first, while PID, CPU and the command stay. The
 *   footer's digits follow what is on screen.
 *
 * Piped, there is nobody to type, so a scripted keyboard drives the same tree and
 * the demo prints it after each step, with a tick standing in for the clock and two
 * widths standing in for a resize.
 */
import { createInlineCanvas } from '@ttylabs/sigil/canvas';
import {
  badgeView,
  DataTable,
  dataTableControl,
  describeDataTable,
  keyHelp,
} from '@ttylabs/sigil/components';
import { box, renderToString, text } from '@ttylabs/sigil/element';
import { createInput, isAbort } from '@ttylabs/sigil/input';
import { createEffect, render } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';
import { createTestTerminal, KEYS } from '@ttylabs/sigil/testing';
import { themedCascade } from '@ttylabs/sigil/theme';

const live = process.stdin.isTTY && process.stdout.isTTY;
const ROWS = 12;

/** A deterministic generator, so a piped run prints the same thing every time. */
function random(seed) {
  let n = seed;
  return () => {
    n = (n * 1_103_515_245 + 12_345) % 2_147_483_648;
    return n / 2_147_483_648;
  };
}

const USERS = ['root', 'chris', 'postgres', '_windowserver', 'nobody'];
const COMMANDS = [
  'node server.js',
  'postgres: writer',
  'WindowServer -daemon',
  'sshd: chris@pts/0',
  'vim notes.md',
  'cargo build --release',
  'zsh',
  'launchd',
  'kernel_task',
  'Google Chrome Helper (Renderer)',
];

/** The machine: three hundred processes, and a second of time passing over them. */
function machine() {
  const roll = random(17);
  let pid = 100;
  const spawn = () => {
    pid += 1 + Math.floor(roll() * 40);
    return {
      command: COMMANDS[Math.floor(roll() * COMMANDS.length)],
      cpu: 0,
      mem: Math.round(roll() * 40) / 10,
      pid,
      rss: Math.floor(roll() * 900_000_000),
      state: roll() < 0.1 ? 'stopped' : 'running',
      user: USERS[Math.floor(roll() * USERS.length)],
    };
  };
  const reading = (p) => ({
    ...p,
    cpu: p.state === 'stopped' ? 0 : Math.round(roll() ** 3 * 1000) / 10,
    mem: Math.max(0, Math.round((p.mem + (roll() - 0.5) / 5) * 10) / 10),
  });
  const rows = new State(Array.from({ length: 300 }, () => reading(spawn())));
  const tick = (keep) => {
    const survivors = rows.get().filter((p) => keep.has(p.pid) || roll() > 0.01);
    const born = Array.from({ length: 300 - survivors.length }, spawn);
    rows.set([...survivors, ...born].map(reading));
  };
  return { rows, tick };
}

/** A size as `ps` reads it: `812M`. */
const size = (bytes) =>
  bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)}G`
    : bytes >= 1e6
      ? `${Math.round(bytes / 1e6)}M`
      : `${Math.round(bytes / 1e3)}K`;

/** The table, and the line under it that says what happened. */
function scene() {
  const { rows, tick } = machine();
  const status = text('', { class: 'sigil-muted', height: 1 });
  // whether the cursor rides with its process or keeps its place: `f` toggles it
  const follow = new State(false);

  const table = DataTable({
    columns: [
      { align: 'right', header: 'PID', key: 'pid', priority: 2 },
      { header: 'USER', key: 'user', maxWidth: 8, priority: -1 },
      {
        align: 'right',
        descendingFirst: true,
        format: (cpu) => cpu.toFixed(1),
        header: 'CPU%',
        key: 'cpu',
        priority: 2,
      },
      {
        align: 'right',
        descendingFirst: true,
        format: (mem) => mem.toFixed(1),
        header: 'MEM%',
        key: 'mem',
      },
      {
        align: 'right',
        descendingFirst: true,
        format: size,
        header: 'RSS',
        key: 'rss',
        priority: -2,
      },
      {
        // a badge is a view, so its width is declared: a measured column would
        // build a badge for every row it had not seen, to learn it is 7 wide
        format: (state) =>
          badgeView(state === 'running' ? 'RUN' : 'STOP', {
            kind: state === 'running' ? 'success' : 'warn',
          }),
        header: 'STATE',
        key: 'state',
        priority: -1,
        width: 7,
      },
      { grow: 1, header: 'COMMAND', key: 'command', minWidth: 10, priority: 1 },
    ],
    follow,
    key: (p) => p.pid,
    multiple: true,
    onActivate: (pid, p) => status.setText(`opened ${pid}: ${p.command}`),
    props: { height: ROWS },
    rows,
    sort: { column: 'cpu', descending: true },
  });
  const control = dataTableControl(table);
  const tally = text('', { class: 'sigil-muted' });
  createEffect(() => {
    const by = control.sort.get();
    const ticked = control.selection.selected.get().size;
    tally.setText(
      `${rows.get().length} processes · ${ticked} ticked · ` +
        (by ? `sorted by ${by.column}${by.descending ? ', from the top' : ''}` : 'unsorted') +
        (follow.get() ? ' · following' : '')
    );
  });

  const root = box({ 'flex-direction': 'column' }, table, tally, status);
  return {
    control,
    follow,
    root,
    table,
    tick: () =>
      tick(new Set([control.selection.current.get(), ...control.selection.selected.get()])),
  };
}

if (live) {
  const ui = scene();
  const canvas = createInlineCanvas({ height: ROWS + 5 });
  const footer = box({ 'margin-top': 1 });
  const view = render(() => box({ 'flex-direction': 'column' }, ui.root, footer), {
    backend: canvas,
    cascade: themedCascade(),
    height: ROWS + 5,
    width: 'auto',
  });
  const input = createInput({ mouse: { surface: canvas }, root: view.root });
  const timer = setInterval(ui.tick, 1000);

  const quit = () => {
    clearInterval(timer);
    view.dispose();
    input.stop();
  };
  input.fallback('q', quit, { description: 'quit', priority: 9 });
  input.fallback('f', () => ui.follow.set(!ui.follow.get()), {
    description: 'follow',
    priority: 7,
  });
  input.bind((event) => {
    if (isAbort(event.key)) {
      event.stop();
      quit();
    }
  });
  describeDataTable(input, ui.table);
  footer.append(keyHelp(input, { width: 80 }));
  input.focus.focus(ui.control.list);
} else {
  const term = createTestTerminal({ columns: 80 });
  const ui = scene();
  const input = createInput({ root: ui.root, terminal: term.terminal });
  input.fallback('f', () => ui.follow.set(!ui.follow.get()), {
    description: 'follow',
    priority: 7,
  });
  describeDataTable(input, ui.table);
  const footer = keyHelp(input, { width: 80 });
  const cascade = themedCascade();

  // an effect runs on the microtask after the write that wakes it
  const settle = () => new Promise((resolve) => setImmediate(resolve));

  /** Prints the tree and the footer under a heading, at a width. */
  const show = async (label, width = 80) => {
    await settle();
    const body = renderToString(ui.root, { cascade, colorLevel: 0, width });
    await settle();
    const keys = renderToString(footer, { cascade, colorLevel: 0, width: 80 }).trimEnd();
    const current = ui.control.selection.current.get();
    console.log(
      `-- ${label}\n${body}\ncursor on pid ${current} · columns: ${ui.control.shown().join(' ')}\nkeys:  ${keys}\n`
    );
  };

  input.focus.focus(ui.control.list);
  await show('as built: three hundred processes, sorted by CPU, eleven rows of them built');

  await term.press(KEYS.down, KEYS.down, ' ');
  await show('Down, Down, Space: the third busiest process ticked');

  ui.tick();
  ui.tick();
  ui.tick();
  await show('three seconds: re-sorted under the cursor, which keeps its place on the third row');

  await term.press('f');
  ui.tick();
  ui.tick();
  await show('f, two seconds: following now -- the cursor rides with its process');

  await term.press('1');
  await show('1: sorted by pid, and the cursor still on its process');

  ui.tick();
  await show('a second more, sorted by pid: the numbers change and nothing moves');

  await term.press('4', '4');
  await show('4 twice: memory from the top, then from the bottom');

  await show('narrower: the command gives way, then RSS, USER and STATE go', 46);

  await term.press('2');
  await show('2 at that width: USER is hidden, so its digit does nothing', 46);

  await term.press(KEYS.enter);
  await show('Enter: the current row opened');

  input.stop();
}
