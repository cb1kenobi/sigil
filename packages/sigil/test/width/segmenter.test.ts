import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Plain ASCII is measured, split and wrapped without an `Intl.Segmenter`.
 *
 * Building the first segmenter in a process loads ICU, which is about 4 ms, and
 * every all-ASCII `--help` paid it because the wrapper split its text through
 * the segmenter even though `stringWidth()` already knew better (SIG-243). The
 * shortcut lives in one place -- `graphemes()` and `stringWidth()` both ask the
 * module's `asciiOnly` -- so two things are held here: that the shortcut is
 * taken, and that it never gives an answer the segmenter would not.
 */

type Width = typeof import('../../src/width/index.js');
type Wrap = typeof import('../../src/wrap/index.js');
type ElementModule = typeof import('../../src/element/index.js');

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const DEL = String.fromCharCode(0x7f);
const NUL = String.fromCharCode(0x00);

// named, because the formatter turns a `\u` escape into the character itself
const ACUTE = String.fromCodePoint(0x301);
const ZWJ = String.fromCodePoint(0x200d);
const ZWSP = String.fromCodePoint(0x200b);
const VS16 = String.fromCodePoint(0xfe0f);
const KEYCAP = String.fromCodePoint(0x20e3);
const TONE = String.fromCodePoint(0x1f3fd);
const LONE_SURROGATE = String.fromCharCode(0xd800);

const MAN = String.fromCodePoint(0x1f468);
const WOMAN = String.fromCodePoint(0x1f469);
const GIRL = String.fromCodePoint(0x1f467);
const THUMB = String.fromCodePoint(0x1f44d);
const FLAG_JP = String.fromCodePoint(0x1f1ef, 0x1f1f5);

describe('an all-ASCII screen', () => {
  const Original = Intl.Segmenter;
  let built = 0;

  beforeEach(() => {
    built = 0;
    // a fresh module graph, so the segmenter the module keeps is not one an
    // earlier test in this worker already built
    vi.resetModules();
    class Counting extends Original {
      constructor(...args: ConstructorParameters<typeof Intl.Segmenter>) {
        super(...args);
        built++;
      }
    }
    Object.defineProperty(Intl, 'Segmenter', {
      configurable: true,
      value: Counting,
      writable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(Intl, 'Segmenter', {
      configurable: true,
      value: Original,
      writable: true,
    });
  });

  it('should build no segmenter to measure, split, wrap or truncate plain ASCII', async () => {
    const { graphemes, stringWidth } = await import('../../src/width/index.js');
    const { tokenize, truncate, wrap } = await import('../../src/wrap/index.js');

    const styled = `${ESC}[1mUsage:${ESC}[22m mycli [options] <command> -- ${ESC}[36mrun the dev server${ESC}[39m`;

    expect(stringWidth('Compile the project')).toBe(19);
    expect(stringWidth(styled)).toBe(54);
    expect(graphemes('build')).toEqual(['b', 'u', 'i', 'l', 'd']);
    expect(tokenize(styled).filter((token) => token.type === 'sequence')).toHaveLength(4);
    expect(wrap(styled, { hangingIndent: 4, width: 12 }).split('\n')).toHaveLength(7);
    expect(truncate('Remove what a build wrote', 10)).toBe('Remove wh…');
    expect(truncate('Remove what a build wrote', 10, 'ellipsis-middle')).toBe('Remov…rote');

    expect(built).toBe(0);
  });

  it('should build no segmenter to lay out and render an all-ASCII help screen', async () => {
    const { parse } = await import('../../src/parser/parse.js');
    const { renderHelp } = await import('../../src/help/index.js');
    const run = () => {};

    const state = await parse({
      argv: [],
      schema: {
        commands: {
          build: { desc: 'Compile the project', run },
          clean: { desc: 'Remove what a build wrote', run },
          deploy: { desc: 'Ship it to wherever the configuration says it goes', run },
          serve: { desc: 'Run the dev server', run },
        },
        completion: false,
        desc: 'An app with commands, and a description long enough to wrap',
        name: 'mycli',
        options: { '--port [n]': { desc: 'The port to listen on', type: 'int' } },
      },
    });

    // narrow enough that the descriptions wrap, and in colour so the wrapper
    // splits styled text rather than plain
    const screen = renderHelp(state, { colorLevel: 3, width: 32 });

    expect(screen).toContain('Compile the');
    expect(screen).toContain(`${ESC}[`);
    expect(built).toBe(0);
  });

  it('should build no segmenter to split one code unit, which is how a border is painted', async () => {
    const { graphemes } = await import('../../src/width/index.js');
    const { box, renderToString, text } = await import('../../src/element/index.js');

    // one code unit has nothing to join, whatever it is: a box-drawing line, a
    // block, a braille cell, a combining mark on its own, half a surrogate pair
    for (const one of ['─', '╭', '█', '⣿', ACUTE, ZWJ, LONE_SURROGATE, 'é']) {
      expect(graphemes(one)).toEqual([one]);
    }

    // a border is painted a cell at a time, so a frame of panels split each cell
    // of every edge with a segmenter (SIG-290)
    const panel = box({ 'border-style': 'round', height: 4, width: 30 }, text('cpu 42%'));
    expect(renderToString(panel, { colorLevel: 3, width: 30 })).toContain('╭');

    expect(built).toBe(0);
  });

  it('should build one segmenter the first time text that is not plain ASCII is measured', async () => {
    // the control: without it, a counter that never counted would pass both of
    // the tests above
    const { graphemes, stringWidth } = await import('../../src/width/index.js');
    expect(built).toBe(0);

    expect(stringWidth('日本')).toBe(4);
    expect(built).toBe(1);

    expect(graphemes(`e${ACUTE}`)).toEqual([`e${ACUTE}`]);
    expect(stringWidth('語')).toBe(2);
    expect(built).toBe(1);
  });
});

/**
 * The shortcut and the full path, over the same strings, giving the same
 * answers -- through every reader of them rather than only the two functions the
 * shortcut is in, since the wrapper, the truncation and the element's layout are
 * where a difference would actually show.
 *
 * The full path is a second module graph whose `width` module has no shortcut:
 * `graphemes()` is the segmenter whatever it is handed, and `stringWidth()`
 * strips and sums clusters whatever it is handed.
 */
describe('the plain ASCII shortcut', () => {
  let fast: { element: ElementModule; width: Width; wrap: Wrap };
  let full: { element: ElementModule; width: Width; wrap: Wrap };
  let segment: (str: string) => string[];

  const load = async () => ({
    element: await import('../../src/element/index.js'),
    width: await import('../../src/width/index.js'),
    wrap: await import('../../src/wrap/index.js'),
  });

  beforeAll(async () => {
    vi.resetModules();
    vi.doMock('../../src/width/index.js', async (importOriginal) => {
      const real = await importOriginal<Width>();
      const { segment: split } = await import('../../src/width/segment.js');
      const { strip } = await import('../../src/ansi/strip.js');
      return {
        ...real,
        graphemes: split,
        stringWidth: (str: string) =>
          split(strip(str)).reduce((sum, cluster) => sum + real.graphemeWidth(cluster), 0),
      };
    });
    full = await load();

    vi.resetModules();
    vi.doUnmock('../../src/width/index.js');
    fast = await load();
    ({ segment } = await import('../../src/width/segment.js'));
  });

  const named = [
    '',
    ' ',
    '─',
    '⣿',
    ACUTE,
    ZWJ,
    LONE_SURROGATE,
    '\r',
    'Compile the project',
    '  indented, with  two spaces',
    'a-very-long-word-with-no-break-in-it-anywhere',
    '~!@#$%^&*()_+{}|:"<>?`-=[]\\;\',./',
    '0123456789#*',
    `tab${'\t'}separated${'\t'}`,
    `line one\nline two\r\nline three\rcarriage`,
    `nul${NUL}bell${BEL}del${DEL}`,
    `lone ${ESC} escape`,
    `${ESC}[31mred${ESC}[39m and ${ESC}[1mbold${ESC}[22m`,
    `${ESC}[38;2;255;0;0mtruecolor${ESC}[0m words after it`,
    `${ESC}]8;;https://example.com${BEL}a link${ESC}]8;;${BEL} and more`,
    '日本語のテキスト',
    'mixed 日本 and ASCII',
    '한국어 한글',
    String.fromCodePoint(0x1100, 0x1161, 0x11a8),
    `cafe${ACUTE} and e${ACUTE}${ACUTE}`,
    `${ACUTE}leading mark`,
    `${MAN}${ZWJ}${WOMAN}${ZWJ}${GIRL} family`,
    `thumb ${THUMB}${TONE} up`,
    `flag ${FLAG_JP} here`,
    `keycap 1${VS16}${KEYCAP} and #${VS16}`,
    `zero${ZWSP}width`,
    'का हिन्दी',
    `half ${LONE_SURROGATE} a pair`,
    'ellipsis … and é',
  ];

  /** A deterministic generator, so a failure names a string that can be found again. */
  function random(seed: number): () => number {
    return () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const pieces = [
    'a',
    'Z',
    'word',
    ' ',
    ' ',
    ' ',
    '-',
    '\t',
    '\n',
    '\r',
    '\r\n',
    NUL,
    BEL,
    DEL,
    ESC,
    `${ESC}[31m`,
    `${ESC}[0m`,
    `${ESC}[38;5;39m`,
    `${ESC}]8;;https://x.test${BEL}`,
    `${ESC}]8;;${BEL}`,
    '日本',
    '한',
    String.fromCodePoint(0x1161),
    ACUTE,
    ZWJ,
    ZWSP,
    VS16,
    TONE,
    THUMB,
    FLAG_JP,
    `1${VS16}${KEYCAP}`,
    `${MAN}${ZWJ}${WOMAN}`,
    'का',
    'é',
    LONE_SURROGATE,
  ];

  const next = random(243);
  const generated = Array.from({ length: 400 }, () => {
    let str = '';
    const count = Math.floor(next() * 14);
    for (let i = 0; i < count; i++) {
      str += pieces[Math.floor(next() * pieces.length)];
    }
    return str;
  });

  const corpus = [...named, ...generated];

  /** What a call returned, or what it threw, so the two paths can fail alike. */
  function outcome<T>(fn: () => T): { value: T } | { error: string } {
    try {
      return { value: fn() };
    } catch (err) {
      return { error: String(err) };
    }
  }

  it('should split every string into the clusters the segmenter does', () => {
    for (const str of corpus) {
      expect(fast.width.graphemes(str), JSON.stringify(str)).toEqual(segment(str));
    }
  });

  it('should measure every string as wide as the full path does', () => {
    for (const str of corpus) {
      expect(fast.width.stringWidth(str), JSON.stringify(str)).toBe(full.width.stringWidth(str));
    }
  });

  it('should tokenize every string as the full path does', () => {
    for (const str of corpus) {
      expect(fast.wrap.tokenize(str), JSON.stringify(str)).toEqual(full.wrap.tokenize(str));
    }
  });

  it('should wrap and truncate every string as the full path does', () => {
    const modes = ['clip', 'ellipsis', 'ellipsis-start', 'ellipsis-middle'] as const;

    for (const str of corpus) {
      const label = JSON.stringify(str);
      for (const width of [1, 4, 9, 30]) {
        expect(
          outcome(() => fast.wrap.wrap(str, { hangingIndent: 2, width })),
          label
        ).toEqual(outcome(() => full.wrap.wrap(str, { hangingIndent: 2, width })));
        expect(
          outcome(() => fast.wrap.wrap(str, { hard: false, width })),
          label
        ).toEqual(outcome(() => full.wrap.wrap(str, { hard: false, width })));
        for (const mode of modes) {
          expect(
            outcome(() => fast.wrap.truncate(str, width, mode)),
            label
          ).toEqual(outcome(() => full.wrap.truncate(str, width, mode)));
        }
      }
    }
  });

  it('should lay out and render every string as the full path does', () => {
    for (const str of corpus) {
      const label = JSON.stringify(str);
      for (const width of [6, 20]) {
        const render = (graph: typeof fast) => () => [
          graph.element.renderToString(graph.element.text(str), { colorLevel: 3, width }),
          graph.element.renderToString(graph.element.paragraph([str]), { colorLevel: 3, width }),
        ];
        expect(outcome(render(fast)), label).toEqual(outcome(render(full)));
      }
    }
  });
});
