/**
 * A treemap: a made-up bundle as nested rectangles, each as big as its share.
 *
 *   node demos/components/67-treemap.js      <- point, click, arrows, h/j/k/l, Enter, Backspace
 *   node demos/components/67-treemap.js 1    <- the same map at 16 colors; 2 is 256, 0 is none
 *   node demos/components/67-treemap.js | cat
 *
 * One `Treemap` over the modules of a web app's bundle, sized in kilobytes and
 * colored by kind: the app's own code, its dependencies, its styles and its
 * assets. The tree is the demo's own nodes, read through `size`, `children` and
 * `key`, so nothing is copied. Four things to watch:
 *
 * - **A directory with room is divided**: `node_modules/` is drawn as its
 *   packages inside its box, and `react-dom/` as its files inside that.
 *   `lodash-es/` is three hundred modules of about a kilobyte, too small to divide,
 *   so it is drawn whole, as a checker.
 * - **Items too small to draw are gathered**: the smaller files of
 *   `src/components/` are one tile that says `32 more`, a checker too. A click on
 *   it picks the largest of them, and `onPick` is handed them all.
 * - **A click or an arrow moves `current` and calls `onPick`**; with `vim: true`,
 *   `h`, `j`, `k` and `l` move as the arrows do. Enter and a double click call
 *   `onActivate`, which is the app's: here it maps the directory activated, or the
 *   one a file is in, by writing a new `root`, and Backspace -- the app's own
 *   binding -- maps the one above.
 * - **The pointer is reported, and selects nothing**: `onHover` says what a click
 *   would pick, which is how a tile too small for its name gets one. It needs
 *   `mouse: { motion: true }` in `runApp()`'s options.
 *
 * The colors are the app's, asked for at the level the frame is drawn at: an RGB
 * the map degrades itself, and at 16 colors a palette index of the app's choosing,
 * which is how four kinds stay four hues. At level 0 the map is shapes in the
 * terminal's own colors: one item solid, many a checker. A level given as the
 * argument is drawn at as it is, without asking the terminal, whose reply may
 * raise the level the environment named but never lower it. The footer is
 * `keyHelp()` over `describeTreemap()`.
 *
 * Piped, there is nobody to type or point, so a scripted keyboard and pointer
 * drive the same app on a test terminal and the demo prints the screen after each
 * step, then what each kind's color comes to at each level.
 */
import { runApp, useApp } from '@ttylabs/sigil/app';
import { palette, rgb, rgbChannels } from '@ttylabs/sigil/canvas';
import { describeTreemap, keyHelp, Treemap } from '@ttylabs/sigil/components';
import { box, text } from '@ttylabs/sigil/element';
import { State } from '@ttylabs/sigil/signals';
import { quantizeColor } from '@ttylabs/sigil/style';
import { createTestTerminal, frame, KEYS } from '@ttylabs/sigil/testing';

const live = process.stdin.isTTY && process.stdout.isTTY;

/**
 * Each kind's color: an RGB for 256 colors and up, and one of the sixteen at
 * 16, where quantizing four RGBs could put two of them on one hue.
 */
const KINDS = {
  app: { ansi: 4, rgb: rgb(78, 128, 226) },
  vendor: { ansi: 2, rgb: rgb(92, 178, 96) },
  style: { ansi: 5, rgb: rgb(190, 96, 200) },
  asset: { ansi: 3, rgb: rgb(206, 170, 64) },
};

/** What the map is told an item's color is, at the level it is drawing at. */
const colorOf = (kind, level) => (level === 1 ? palette(KINDS[kind].ansi) : KINDS[kind].rgb);

/** A deterministic generator, so a piped run prints the same thing every time. */
function random(seed) {
  let n = seed;
  return () => {
    n = (n * 1_103_515_245 + 12_345) % 2_147_483_648;
    return n / 2_147_483_648;
  };
}

const roll = random(11);
const file = (name, kb) => ({ kb, name });
const dir = (name, children) => ({ children, name });
/** `count` files named after `stem`, each between `low` and `high` kilobytes. */
const many = (stem, count, low, high) =>
  Array.from({ length: count }, (_, i) =>
    file(`${stem}${i + 1}.js`, Math.round((low + roll() * (high - low)) * 10) / 10)
  );

/** The bundle, as a tree of plain nodes: a directory is its files, in any order. */
function bundle() {
  const tree = dir('bundle', [
    dir('node_modules', [
      dir('react-dom', [
        file('react-dom.production.js', 372),
        file('server.js', 118),
        file('client.js', 26),
      ]),
      dir('three', [
        file('three.module.js', 286),
        file('GLTFLoader.js', 44),
        file('OrbitControls.js', 18),
      ]),
      dir('lodash-es', many('fn', 300, 0.4, 1.6)),
      dir('date-fns', [
        file('format.js', 22),
        file('parse.js', 30),
        dir('locale', many('locale', 60, 1, 2)),
        ...many('fn', 120, 0.2, 0.6),
      ]),
      file('zod.js', 58),
      ...['clsx', 'nanoid', 'mitt', 'immer', 'ky', 'dayjs', 'zustand', 'idb', 'fflate', 'yaml'].map(
        (name) => file(`${name}.js`, Math.round(2 + roll() * 14))
      ),
    ]),
    dir('src', [
      dir('pages', many('page', 6, 12, 38)),
      dir('components', many('component', 36, 1.5, 9)),
      dir('store', many('slice', 8, 1, 4)),
      file('main.ts', 14),
      file('router.ts', 9),
    ]),
    dir('assets', [
      file('hero.webp', 184),
      dir('fonts', [file('inter-400.woff2', 96), file('inter-700.woff2', 98)]),
      file('logo.svg', 22),
      dir('icons', many('icon', 40, 0.6, 2)),
    ]),
    dir('styles', [file('app.css', 46), file('vendor.css', 31), file('print.css', 4)]),
  ]);

  // the size of a directory is its files', and each node learns its path and kind
  const byPath = new Map();
  const walk = (node, parent, kind) => {
    // a path inside the bundle, so the root's is empty and a line has room for it
    node.path =
      parent === undefined ? '' : parent.path === '' ? node.name : `${parent.path}/${node.name}`;
    node.kind =
      kind ??
      { assets: 'asset', node_modules: 'vendor', src: 'app', styles: 'style' }[node.name] ??
      'app';
    byPath.set(node.path, node);
    if (node.children) {
      node.kb = 0;
      for (const child of node.children) {
        walk(child, node, parent === undefined ? undefined : node.kind);
        node.kb += child.kb;
      }
    }
  };
  walk(tree, undefined, undefined);
  return { byPath, tree };
}

/** A size as a reader takes it in: `372.0 kB`, `1.2 MB`. */
const kb = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)} MB` : `${n.toFixed(1)} kB`);

/** The path a node's is under, or nothing at the top: `parent` for the map. */
const parentOf = (path) =>
  path === '' ? undefined : path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** The whole app: a heading, the map, two lines about it, and the footer. */
function TreemapDemo() {
  const app = useApp();
  const input = app.input;
  const { byPath, tree } = bundle();
  const root = new State(tree);
  const current = new State(undefined);

  const heading = text('', { class: 'sigil-heading', height: 1, 'white-space': 'pre' });
  const picked = text('', { height: 1, 'white-space': 'pre' });
  const pointer = text('', { class: 'sigil-muted', height: 1, 'white-space': 'pre' });

  /** A node's share of what is drawn. */
  const share = (node) => `${((node.kb / root.get().kb) * 100).toFixed(1)}%`;
  const say = (node) => `${node.path}${node.children ? '/' : ''} · ${kb(node.kb)} · ${share(node)}`;
  const sayGathered = (items) =>
    `${items.length} in ${parentOf(items[0].path)}/ · ${kb(items.reduce((n, it) => n + it.kb, 0))}`;
  const mapped = (node) => {
    root.set(node);
    const where = node === tree ? 'bundle/' : `bundle/${node.path}/`;
    heading.setText(`${where} · ${kb(node.kb)}${node === tree ? '' : ' · Backspace goes up'}`);
  };
  mapped(tree);
  picked.setText('onPick      nothing yet: click a tile, or press an arrow');
  pointer.setText('onHover     the pointer is not on the map');

  const map = Treemap({
    children: (node) => node.children,
    color: (node, level) => colorOf(node.kind, level),
    current,
    key: (node) => node.path,
    label: (node) => node.name + (node.children ? '/' : ''),
    // what Enter and a double click do is the app's: this one maps the directory
    // activated, or the one a file is in -- a new root, which the map lays out
    // again -- and opens a file whose directory is already the map
    onActivate: (path) => {
      const node = byPath.get(path);
      const dir = node.children ? node : byPath.get(parentOf(path));
      if (dir === root.get()) {
        picked.setText(`onActivate  opened ${path}`);
      } else {
        mapped(dir);
        picked.setText(`onActivate  mapped ${dir.path}/`);
      }
    },
    onHover: (_path, node, gathered) =>
      pointer.setText(
        node === undefined
          ? 'onHover     the pointer is not on the map'
          : `onHover     ${gathered ? sayGathered(gathered) : say(node)}`
      ),
    onPick: (_path, node, gathered) =>
      picked.setText(
        gathered
          ? `onPick      ${node.name}, the largest of ${sayGathered(gathered)}`
          : `onPick      ${say(node)}`
      ),
    parent: parentOf,
    props: { 'flex-grow': 1, 'min-height': 0 },
    root,
    size: (node) => node.kb,
    vim: true,
  });

  // going back up is the app's too: the map does not know where its root came from
  input.fallback(
    'backspace',
    () => {
      const up = byPath.get(parentOf(root.get().path));
      if (up !== undefined) {
        mapped(up);
      }
    },
    { description: 'up', priority: 3 }
  );
  describeTreemap(input, map);
  input.focus.focus(map);

  return box(
    { 'flex-direction': 'column', 'flex-grow': 1 },
    heading,
    map,
    picked,
    pointer,
    keyHelp(input)
  );
}

if (live) {
  const level = ['0', '1', '2', '3'].includes(process.argv[2])
    ? Number(process.argv[2])
    : undefined;
  const app = runApp(TreemapDemo, {
    // a level named here is drawn at as it is, so the terminal is not asked
    ...(level === undefined ? {} : { colorLevel: level, detect: false }),
    // motion, so the pointer is reported with no button held: what onHover reads
    mouse: { motion: true },
  });
  process.exitCode = await app.exited;
} else {
  const WIDTH = 80;
  const HEIGHT = 22;
  const term = createTestTerminal({ colorLevel: 0, columns: WIDTH, rows: HEIGHT });
  const app = runApp(TreemapDemo, {
    // the console is the demo's own output here, not something to keep off a screen
    console: false,
    detect: false,
    mouse: { motion: true },
    terminal: term.terminal,
  });
  await frame(app);

  /** Prints the screen under a heading. */
  const show = async (label) => {
    await frame(app);
    const screen = term.viewport.map((line) => line.trimEnd()).join('\n');
    console.log(`-- ${label}\n${screen}\n`);
  };

  // the pointer, aimed at what the screen shows rather than at fixed cells; an
  // SGR report counts from 1, and 35 is a move with no button held
  const ESC = String.fromCharCode(0x1b);
  const find = (words) => {
    for (const [y, line] of term.viewport.entries()) {
      const x = line.indexOf(words);
      if (x >= 0) {
        return { x: x + 1, y: y + 1 };
      }
    }
    throw new Error(`Nothing on screen says ${words}`);
  };
  const click = (p) => [`${ESC}[<0;${p.x};${p.y}M`, `${ESC}[<0;${p.x};${p.y}m`];
  const move = (p) => `${ESC}[<35;${p.x};${p.y}M`;

  await show('as built: the bundle, nothing picked, the map focused');

  await term.press(KEYS.right);
  await show('Right: from nothing picked, an arrow goes to the first tile, top left');

  await term.press(KEYS.down, 'l');
  await show('Down, then l: vim: true moves as the arrows do');

  await term.press(move(find('32 more')));
  await show('the pointer on "32 more": onHover says what a click there would pick');

  await term.press(...click(find('32 more')));
  await show('a click there: the largest of the 32, and onPick is handed all of them');

  await term.press(...click(find('lodash-es/')));
  await show('a click on lodash-es/: 300 modules with no room to divide, drawn whole');

  await term.press(...click(find('react-dom.prod')), KEYS.enter);
  await show('a click on a file in react-dom/, and Enter: onActivate maps its directory');

  await term.press(...click(find('server.js')), ...click(find('server.js')));
  await show('a double click on server.js: onActivate again, which opens it');

  await term.press(move({ x: 1, y: HEIGHT }));
  await show('the pointer off the map: onHover is told so');

  await term.press(KEYS.backspace, KEYS.backspace);
  await show('Backspace twice: the app writes the root back, and the outline stays');

  app.exit(0);
  await app.exited;

  // what the map paints each kind's tile with, at each level: the app's answer,
  // degraded by the library's quantizer, which is what the paint does with it
  const name = (color) => {
    const channels = rgbChannels(color);
    return channels
      ? `#${channels.map((c) => c.toString(16).padStart(2, '0')).join('')}`
      : `palette(${color})`;
  };
  const kinds = Object.keys(KINDS);
  const row = (label, cells) =>
    `${label.padEnd(14)}${cells.map((c) => c.padEnd(14)).join('')}`.trimEnd();
  console.log('-- each kind, as the map paints its tiles at each color level');
  console.log(row('', kinds));
  for (const [level, label] of [
    [3, 'truecolor'],
    [2, '256 colors'],
    [1, '16 colors'],
  ]) {
    console.log(
      row(
        label,
        kinds.map((kind) => name(quantizeColor(colorOf(kind, level), level)))
      )
    );
  }
  console.log(
    "no color      the terminal's own colors, one item solid and many a checker\n" +
      '\nAn RGB is quantized by the map at 256 colors. At 16 the app hands over its own\n' +
      'palette index, so four kinds stay four hues; the map shades a tile at truecolor.'
  );
}
