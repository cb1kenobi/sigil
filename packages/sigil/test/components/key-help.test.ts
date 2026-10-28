import { strip } from '../../src/ansi/strip.js';
import {
  fitKeyHelp,
  keyHelp,
  type KeyHelpEntry,
  keyHelpEntries,
  keyLabel,
} from '../../src/components/index.js';
import { box, type Element, renderToString, text } from '../../src/element/index.js';
import { __, type Catalog, loadCatalog } from '../../src/i18n/index.js';
import { createInput } from '../../src/input/index.js';
import { State } from '../../src/signals/index.js';
import { createTestTerminal, tick } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { stringWidth } from '../../src/width/index.js';
import { afterEach, describe, expect, it } from 'vitest';

/** Back to English with no loader map, which is the state every case starts from. */
afterEach(async () => {
  await loadCatalog(undefined, {});
});

/** Activates a catalog under a tag, the way an app's own loader map would. */
async function translated(catalog: Catalog, tag = 'de'): Promise<void> {
  await loadCatalog({ [tag]: async () => catalog }, {}, tag);
}

/**
 * The key-help footer: lines read off the router's bindings, fitted to a width.
 *
 * Rendered through `renderToString()` at level 0 so that what is asserted is the
 * text on the row, and measured with `stringWidth()` so that "fits" means what
 * the terminal means by it rather than what `.length` does.
 */

function entry(label: string, description: string, priority = 0): KeyHelpEntry {
  return { description, group: undefined, label, priority };
}

function paint(el: Element, width: number): string[] {
  return strip(renderToString(el, { cascade: themedCascade(), width })).split('\n');
}

function setup(columns = 60): {
  a: Element;
  b: Element;
  input: ReturnType<typeof createInput>;
  width: State<number>;
} {
  const a = box({ focusable: true }, text('a'));
  const b = box({ focusable: true }, text('b'));
  const root = box({}, a, b);
  const term = createTestTerminal({ columns });
  const input = createInput({ root, terminal: term.terminal });
  return { a, b, input, width: new State(columns) };
}

describe('keyLabel', () => {
  it('should print arrows as glyphs and the names that are words as themselves', () => {
    expect(keyLabel('up')).toBe('↑');
    expect(keyLabel('right')).toBe('→');
    expect(keyLabel('enter')).toBe('enter');
    expect(keyLabel('escape')).toBe('esc');
    expect(keyLabel('pagedown')).toBe('pgdn');
    expect(keyLabel('q')).toBe('q');
  });

  it('should put modifiers in front, one at a time, and a sequence a space apart', () => {
    expect(keyLabel('ctrl+s')).toBe('ctrl-s');
    expect(keyLabel('ctrl+alt+delete')).toBe('ctrl-alt-delete');
    expect(keyLabel('shift+tab')).toBe('shift-tab');
    expect(keyLabel('g g')).toBe('g g');
    expect(keyLabel('ctrl+x ctrl+s')).toBe('ctrl-x ctrl-s');
  });

  it('should read a plus key and a key named like a modifier as the keys they are', () => {
    expect(keyLabel('+')).toBe('+');
    expect(keyLabel('ctrl++')).toBe('ctrl-+');
  });

  it('should go through the catalog for a name that is a word', async () => {
    await translated({ enter: 'Eingabe', 'ctrl-{0}': 'Strg+{0}' });

    expect(keyLabel('ctrl+enter')).toBe('Strg+Eingabe');
    // and the arrow is a glyph, which no catalog is asked about
    expect(keyLabel('up')).toBe('↑');
    expect(__`enter`).toBe('Eingabe');
  });
});

describe('keyHelpEntries', () => {
  it('should merge bindings that do the same thing into one line', () => {
    const lines = keyHelpEntries([
      { description: 'move', group: undefined, keys: 'up', priority: 1, scope: undefined },
      { description: 'select', group: undefined, keys: 'enter', priority: 0, scope: undefined },
      { description: 'move', group: undefined, keys: 'down', priority: 5, scope: undefined },
    ]);

    expect(lines.map((l) => `${l.label} ${l.description}`)).toEqual(['↑/↓ move', 'enter select']);
    // a line is as important as the most important key on it
    expect(lines[0]?.priority).toBe(5);
  });

  it('should keep the same description in two groups as two lines', () => {
    const lines = keyHelpEntries([
      { description: 'open', group: 'file', keys: 'o', priority: 0, scope: undefined },
      { description: 'open', group: 'tabs', keys: 't', priority: 0, scope: undefined },
    ]);

    expect(lines).toHaveLength(2);
  });

  it('should fold whitespace in a description so one line stays one line', () => {
    const [line] = keyHelpEntries([
      { description: ' two\n lines ', group: undefined, keys: 'x', priority: 0, scope: undefined },
    ]);

    expect(line?.description).toBe('two lines');
  });
});

describe('fitKeyHelp', () => {
  const lines = [
    entry('↑/↓', 'move', 5),
    entry('enter', 'select', 4),
    entry('?', 'help', 1),
    entry('q', 'quit', 3),
  ];

  it('should keep everything that fits and say nothing was left out', () => {
    expect(fitKeyHelp(lines, 100)).toEqual({ shown: lines, truncated: false });
  });

  it('should drop the lowest priority first and keep the order of the rest', () => {
    // all four are 41 columns; dropping help needs 41 - 3 - 6 = 32 plus the mark
    const { shown, truncated } = fitKeyHelp(lines, 36);

    expect(shown.map((l) => l.label)).toEqual(['↑/↓', 'enter', 'q']);
    expect(truncated).toBe(true);
  });

  it('should drop the later of two equals', () => {
    const tie = [entry('a', 'one'), entry('b', 'two'), entry('c', 'three')];
    const { shown } = fitKeyHelp(tie, 20);

    expect(shown.map((l) => l.label)).toEqual(['a', 'b']);
  });

  it('should reserve the ellipsis before judging what fits', () => {
    // 'a one · b two' is 13 columns and fits in 13 -- but not with the mark that
    // says a third was left out
    const three = [entry('a', 'one'), entry('b', 'two'), entry('c', 'three')];
    const { shown } = fitKeyHelp(three, 14);

    expect(shown.map((l) => l.label)).toEqual(['a']);
  });

  it('should drop a whole line rather than cut one in half', () => {
    for (let width = 0; width <= 45; width++) {
      const { shown, truncated } = fitKeyHelp(lines, width);
      const used =
        shown.reduce((n, l) => n + stringWidth(l.label) + 1 + stringWidth(l.description), 0) +
        3 * Math.max(0, shown.length - 1) +
        (truncated ? 2 : 0);

      // every line that is left is a whole one from the input, and the row fits
      for (const line of shown) {
        expect(lines, `at ${width}`).toContain(line);
      }
      if (shown.length > 0) {
        expect(used, `at ${width}`).toBeLessThanOrEqual(width);
      }
      expect(truncated, `at ${width}`).toBe(shown.length < lines.length);
    }
  });

  it('should measure in columns, so a wide description does not overflow', () => {
    const wide = [entry('q', '終了'), entry('x', 'ok')];
    // 'q 終了' is 6 columns, and the second line cannot join it in 12 with the mark
    const { shown, truncated } = fitKeyHelp(wide, 12);

    expect(shown.map((l) => l.label)).toEqual(['q']);
    expect(truncated).toBe(true);
  });
});

describe('keyHelp', () => {
  it('should draw the short form from the bindings that are live', async () => {
    const { input } = setup();
    input.bind('up', () => {}, { description: 'move', priority: 5 });
    input.bind('down', () => {}, { description: 'move', priority: 5 });
    input.bind('enter', () => {}, { description: 'select' });
    input.bind('q', () => {}, { description: 'quit' });
    input.bind('x', () => {});

    const footer = keyHelp(input, { width: 60 });
    await tick();

    expect(paint(footer, 60)).toEqual(['↑/↓ move · enter select · q quit']);
  });

  it('should follow the focus', async () => {
    const { a, b, input } = setup();
    input.bind('q', () => {}, { description: 'quit' });
    input.describe('enter', { description: 'open', scope: a });
    input.describe('space', { description: 'toggle', scope: b });

    const footer = keyHelp(input, { width: 60 });
    await tick();
    expect(paint(footer, 60)).toEqual(['q quit']);

    input.focus.focus(a);
    await tick();
    expect(paint(footer, 60)).toEqual(['q quit · enter open']);

    input.focus.focus(b);
    await tick();
    expect(paint(footer, 60)).toEqual(['q quit · space toggle']);
  });

  it('should follow a binding being added and removed', async () => {
    const { input } = setup();
    const footer = keyHelp(input, { width: 60 });
    await tick();
    expect(paint(footer, 60)).toEqual(['']);

    const off = input.bind('q', () => {}, { description: 'quit' });
    await tick();
    expect(paint(footer, 60)).toEqual(['q quit']);

    off();
    await tick();
    expect(paint(footer, 60)).toEqual(['']);
  });

  it('should truncate to the width, lowest priority first, ending in an ellipsis', async () => {
    const { input } = setup();
    input.bind('up', () => {}, { description: 'move', priority: 5 });
    input.bind('?', () => {}, { description: 'help', priority: 1 });
    input.bind('q', () => {}, { description: 'quit', priority: 3 });

    const footer = keyHelp(input, { width: 17 });
    await tick();
    const [row] = paint(footer, 40);

    expect(row).toBe('↑ move · q quit …');
    expect(stringWidth(row as string)).toBeLessThanOrEqual(17);

    // one column fewer and `q quit` goes, then the mark moves up behind `move`
    const narrow = keyHelp(input, { width: 16 });
    await tick();
    expect(paint(narrow, 40)).toEqual(['↑ move …']);
  });

  it('should never wrap, even when the row is wider than the box it is laid out in', async () => {
    const { input } = setup();
    input.bind('a', () => {}, { description: 'alpha beta gamma delta' });
    input.bind('b', () => {}, { description: 'epsilon zeta eta theta' });
    const footer = keyHelp(input, { width: 30 });
    await tick();

    expect(paint(footer, 30)).toHaveLength(1);
  });

  it('should list every binding under its group in the expanded form', async () => {
    const { input } = setup();
    const expanded = new State(false);
    input.bind('up', () => {}, { description: 'move up', group: 'navigate' });
    input.bind('down', () => {}, { description: 'move down', group: 'navigate' });
    input.bind('ctrl+s', () => {}, { description: 'save', group: 'file' });
    input.bind('q', () => {}, { description: 'quit' });

    const footer = keyHelp(input, { expanded, width: 60 });
    await tick();
    expect(paint(footer, 60)).toHaveLength(1);

    expanded.set(true);
    await tick();

    expect(paint(footer, 60)).toEqual([
      'q       quit',
      '',
      'navigate',
      '↑       move up',
      '↓       move down',
      '',
      'file',
      'ctrl-s  save',
    ]);

    expanded.set(false);
    await tick();
    expect(paint(footer, 60)).toHaveLength(1);
  });

  it('should show nothing for a binding with no description', async () => {
    const { input } = setup();
    input.bind('q', () => {});
    const footer = keyHelp(input, { width: 60 });
    await tick();

    expect(paint(footer, 60)).toEqual(['']);
  });

  it('should translate the key names through the catalog it is built under', async () => {
    const { input } = setup();
    input.bind('enter', () => {}, { description: 'wählen' });
    await translated({ enter: 'Eingabe' });

    const footer = keyHelp(input, { width: 60 });
    await tick();

    expect(paint(footer, 60)).toEqual(['Eingabe wählen']);
  });
});
