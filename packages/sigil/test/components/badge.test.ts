import { strip } from '../../src/ansi/index.js';
import { Badge, badge, badgeView } from '../../src/components/badge.js';
import { table } from '../../src/components/table.js';
import {
  box,
  type Element,
  renderToLines,
  renderToString,
  text as textNode,
} from '../../src/element/index.js';
import { createRoot, render } from '../../src/renderer/index.js';
import { Computed, flush, State } from '../../src/signals/index.js';
import { createTestTerminal } from '../../src/testing/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { stringWidth } from '../../src/width/index.js';
import { describe, expect, it } from 'vitest';

const ESC = String.fromCharCode(0x1b);

/** The SGR parameters a string opens with, such as `7;32`. */
function params(value: string): string | undefined {
  return new RegExp(`${ESC}\\[([0-9;]+)m`).exec(value)?.[1];
}

describe('badge()', () => {
  describe('the label', () => {
    it('should pad the label with a column each side where there is colour', () => {
      expect(strip(badge('PASS', { colorLevel: 1 }))).to.equal(' PASS ');
    });

    it('should draw brackets in place of the padding at colour level 0', () => {
      expect(badge('PASS', { colorLevel: 0 })).to.equal('[PASS]');
    });

    it('should be as wide at level 0 as it is with colour', () => {
      expect(stringWidth(badge('PASS', { colorLevel: 0 }))).to.equal(
        stringWidth(strip(badge('PASS', { colorLevel: 3 })))
      );
    });

    it('should keep the label as typed, with no case change', () => {
      expect(badge('beta', { colorLevel: 0 })).to.equal('[beta]');
    });

    it('should drop escape sequences and put a line break on one line', () => {
      expect(badge(`${ESC}[31mPA\nSS${ESC}[0m`, { colorLevel: 0 })).to.equal('[PA SS]');
    });

    it('should be empty for an empty label', () => {
      expect(badge('', { colorLevel: 1 })).to.equal('');
      expect(badge('  \n ', { colorLevel: 0 })).to.equal('');
      expect(badgeView('', { colorLevel: 1 }).width).to.equal(0);
    });

    it('should measure a wide label in columns', () => {
      expect(badgeView('日本', { colorLevel: 1 }).width).to.equal(6);
      expect(stringWidth(badge('日本', { colorLevel: 0 }))).to.equal(6);
    });
  });

  describe('the colour', () => {
    it('should put the variant role behind the label by inverting it', () => {
      expect(params(badge('x', { colorLevel: 1, variant: 'success' }))).to.equal('7;32');
      expect(params(badge('x', { colorLevel: 1, variant: 'error' }))).to.equal('7;31');
      expect(params(badge('x', { colorLevel: 1, variant: 'warning' }))).to.equal('7;33');
      expect(params(badge('x', { colorLevel: 1, variant: 'info' }))).to.equal('7;34');
    });

    it('should invert the terminal foreground for a neutral badge', () => {
      expect(params(badge('x', { colorLevel: 1 }))).to.equal('7');
    });

    it('should paint the padding as well as the label', () => {
      const out = badge('x', { colorLevel: 1, variant: 'success' });

      expect(out.endsWith(`${ESC}[0m`)).to.equal(true);
      expect(out.slice(out.indexOf('m') + 1, out.lastIndexOf(ESC))).to.equal(' x ');
    });

    it('should take a role from a theme rather than from the component', () => {
      const out = badge('x', {
        colorLevel: 1,
        theme: '.sigil-success { color: magenta }',
        variant: 'success',
      });

      expect(params(out)).to.equal('7;35');
    });

    it('should let a theme restyle the badge class alone', () => {
      const out = badge('x', {
        colorLevel: 1,
        theme: '.sigil-badge { inverse: false }',
        variant: 'success',
      });

      expect(params(out)).to.equal('32');
    });

    it('should carry the variant on a class of its own for a theme to reach', () => {
      const theme = '.sigil-badge-error { font-weight: bold }';

      expect(params(badge('x', { colorLevel: 1, theme, variant: 'error' }))).to.contain('1');
      expect(params(badge('x', { colorLevel: 1, theme, variant: 'info' }))).not.to.contain('1;');
    });
  });

  describe('as a table cell', () => {
    const rows = [
      ['build', badgeView('PASS', { colorLevel: 1, variant: 'success' })],
      ['lint', badgeView('FAIL', { colorLevel: 1, variant: 'error' })],
      ['docs', 'n/a'],
    ];

    it('should keep its colour, which a string cell cannot', () => {
      const out = table(rows, { colorLevel: 1 });

      expect(out).to.contain(`${ESC}[7;32m PASS ${ESC}[0m`);
      expect(out).to.contain(`${ESC}[7;31m FAIL ${ESC}[0m`);
    });

    it('should size the column by the badge', () => {
      expect(strip(table(rows, { colorLevel: 1 })).split('\n')).to.deep.equal([
        'build   PASS ',
        'lint    FAIL ',
        'docs   n/a',
      ]);
    });

    it('should align a badge by its column', () => {
      const out = table(
        [
          [badgeView('ok', { colorLevel: 0 }), 'a'],
          [badgeView('failing', { colorLevel: 0 }), 'b'],
        ],
        { colorLevel: 0, columns: [{ align: 'right' }, {}] }
      );

      expect(out.split('\n')).to.deep.equal(['     [ok]  a', '[failing]  b']);
    });

    it('should cut a badge wider than its column at the column', () => {
      const out = table([[badgeView('failing', { colorLevel: 0 })]], {
        colorLevel: 0,
        columns: [{ maxWidth: 5 }],
      });

      expect(out).to.equal('[fail');
    });

    it('should leave a string cell with an escape sequence as plain text', () => {
      expect(table([[`${ESC}[31mred${ESC}[0m`]], { colorLevel: 1 })).not.to.contain(ESC);
    });

    it('should not take a width that is not a number as a view', () => {
      const { element } = badgeView('x', { colorLevel: 0 });

      expect(table([[{ element, width: Number.NaN }]], { colorLevel: 0 })).to.equal(
        '[object Object]'
      );
    });

    it('should read an object that is not a view as a value to print', () => {
      expect(table([[{ width: 3 }]], { colorLevel: 0 })).to.equal('[object Object]');
    });
  });
});

/** The tree as it is drawn at a colour level, one string per row. */
function drawn(root: Element, colorLevel: 0 | 1, width = 20): string[] {
  return renderToLines(root, { cascade: themedCascade(), colorLevel, width });
}

/** The two texts a badge holds, the padded form and then the bracketed one. */
function formsOf(el: Element): [Element, Element] {
  return [el.children[0], el.children[1]];
}

describe('Badge()', () => {
  it('should draw what badgeView() draws for the same label and variant', () => {
    for (const colorLevel of [0, 1] as const) {
      const live = drawn(
        box({}, Badge({ colorLevel, label: 'PASS', variant: 'success' })),
        colorLevel
      );
      const fixed = drawn(
        box({}, badgeView('PASS', { colorLevel, variant: 'success' }).element),
        colorLevel
      );

      expect(live).to.deep.equal(fixed);
    }
  });

  it('should be a box of two texts, with no effect, when given plain values', () => {
    let effects = 0;
    const el = createRoot(
      () => Badge({ colorLevel: 1, label: 'beta', variant: 'info' }),
      (fn) => {
        effects++;
        return fn() ?? (() => {});
      }
    );

    expect(effects).to.equal(0);
    expect(el.type).to.equal('box');
    for (const form of formsOf(el)) {
      expect(form.type).to.equal('text');
      expect(form.classes).to.include.members(['sigil-badge', 'sigil-badge-info', 'sigil-info']);
    }
    expect(
      formsOf(el).map((form) => form.classes.find((c) => /-(padded|bracketed)$/.test(c)))
    ).to.deep.equal(['sigil-badge-padded', 'sigil-badge-bracketed']);
  });

  it('should follow a State for its label and its variant', async () => {
    const label = new State('PASS');
    const variant = new State<'success' | 'error'>('success');
    const root = box({}, Badge({ colorLevel: 1, label, variant }));

    expect(strip(drawn(root, 1)[0] as string).trimEnd()).to.equal(' PASS');
    expect(drawn(root, 1)[0]).to.contain(`${ESC}[7;32m`);

    label.set('FAIL');
    variant.set('error');
    await flush();

    expect(strip(drawn(root, 1)[0] as string).trimEnd()).to.equal(' FAIL');
    expect(drawn(root, 1)[0]).to.contain(`${ESC}[7;31m`);
    expect(drawn(root, 1)[0]).not.to.contain(`${ESC}[7;32m`);
  });

  it('should follow a Computed and a function, which it only reads', async () => {
    const change = new State(4);
    const el = Badge({
      colorLevel: 0,
      label: new Computed(() => `${change.get() > 0 ? '+' : ''}${change.get()}%`),
      variant: () => (change.get() >= 0 ? 'success' : 'error'),
    });
    const root = box({}, el);

    expect(drawn(root, 0)[0]?.trimEnd()).to.equal('[+4%]');
    expect(formsOf(el)[0].classes).to.include('sigil-success');

    change.set(-2);
    await flush();

    expect(drawn(root, 0)[0]?.trimEnd()).to.equal('[-2%]');
    for (const form of formsOf(el)) {
      expect(form.classes).to.include('sigil-error');
      expect(form.classes).not.to.include('sigil-success');
      expect(form.classes).not.to.include('sigil-badge-success');
    }
  });

  it('should leave the variant a function does not change as it was', async () => {
    const label = new State('a');
    const el = Badge({ colorLevel: 1, label, variant: 'info' });
    label.set('b');
    await flush();

    for (const form of formsOf(el)) {
      expect(form.classes).to.include.members(['sigil-badge', 'sigil-badge-info', 'sigil-info']);
    }
  });

  it('should draw nothing for a label that becomes empty, and a badge again after', async () => {
    const label = new State('x');
    const root = box({}, Badge({ colorLevel: 0, label }));
    label.set('');
    await flush();
    expect(drawn(root, 0)[0]?.trimEnd()).to.equal('');

    label.set('y');
    await flush();
    expect(drawn(root, 0)[0]?.trimEnd()).to.equal('[y]');
  });

  it('should keep the classes and props an app gave it through a change', async () => {
    const variant = new State<'success' | 'error'>('success');
    const el = Badge({
      class: 'trend wide',
      colorLevel: 1,
      label: 'x',
      props: { 'flex-shrink': 1 },
      variant,
    });
    variant.set('error');
    await flush();

    expect(el.classes).to.include.members(['trend', 'wide']);
    expect(formsOf(el)[0].classes).to.include('sigil-error');
    expect(el.props['flex-shrink']).to.equal(1);
  });

  it('should read an undefined variant from a signal as neutral, like an omitted one', () => {
    const el = Badge({ colorLevel: 1, label: 'x', variant: () => undefined as never });

    expect(formsOf(el)[1].classes).to.include('sigil-badge-neutral');
  });

  it('should refuse a variant it does not know', () => {
    expect(() => Badge({ label: 'x', variant: 'loud' as never })).to.throw(TypeError, /variant/);
    expect(() => Badge({ label: 'x', variant: 'toString' as never })).to.throw(
      TypeError,
      /variant/
    );
  });

  it('should stop following its signals when the owner that made it is disposed', async () => {
    const label = new State('a');
    let el: Element | undefined;
    createRoot((dispose) => {
      el = Badge({ colorLevel: 0, label });
      dispose();
    });
    label.set('b');
    await flush();

    expect(drawn(box({}, el as Element), 0)[0]?.trimEnd()).to.equal('[a]');
  });
});

// SIG-644. A badge's form is the level the renderer draws at, not the one it was
// built at: both forms are in the tree and the framework's sheet shows one by
// `@media (color-level: 0)`.
describe('a badge given an href in its props', () => {
  const url = 'https://example.com/build/1';
  const open = (to: string): string => `${ESC}]8;;${to}${ESC}\\`;

  // before SIG-656 the prop went on the row, which is a box and paints no link, so
  // the badge built without a throw and drew plain text
  it('should draw its label as a link', () => {
    const out = renderToString(Badge({ label: 'PASS', props: { href: url } }), {
      cascade: themedCascade(),
      colorLevel: 3,
      width: 20,
    });

    expect(out).to.contain(`${open(url)} PASS ${open('')}`);
  });

  it('should put the link on both forms, so it holds at whichever level draws', () => {
    const el = Badge({ label: 'PASS', props: { href: url } });

    expect(formsOf(el).map((form) => form.href)).to.deep.equal([url, url]);
    expect(el.href).to.equal('');
  });

  it('should keep the rest of its props on the row', () => {
    const el = Badge({ label: 'PASS', props: { href: url, 'flex-shrink': 1 } });

    expect(el.props['flex-shrink']).to.equal(1);
    expect(el.props.href).to.equal(undefined);
  });

  it('should draw no link when it is given none', () => {
    const out = renderToString(Badge({ label: 'PASS' }), {
      cascade: themedCascade(),
      colorLevel: 3,
      width: 20,
    });

    expect(out).to.not.contain(`${ESC}]8`);
  });

  it('should refuse a URL with a control character, as a text does', () => {
    expect(() => Badge({ label: 'PASS', props: { href: `https://x${ESC}\\` } })).to.throw(
      /Invalid href/
    );
  });
});

describe('a badge built at one level and shown at another', () => {
  /** What a renderer drawing at `shownAt` shows of a badge made by `make`. */
  function shown(make: () => Element, shownAt: 0 | 3): string {
    const ui = createTestTerminal({ columns: 20, colorLevel: shownAt, rows: 3 });
    const view = render(make, {
      cascade: themedCascade(),
      colorLevel: shownAt,
      frameMs: 0,
      terminal: ui.terminal,
    });
    const first = strip(ui.viewport[0] ?? '').trimEnd();
    view.dispose();
    return first;
  }

  it.each([
    [0, 3, ' PASS'],
    [3, 0, '[PASS]'],
    [0, 0, '[PASS]'],
    [3, 3, ' PASS'],
  ] as const)('should draw badgeView() built at %i as the form for %i', (built, shownAt, line) => {
    expect(
      shown(() => badgeView('PASS', { colorLevel: built, variant: 'success' }).element, shownAt)
    ).to.equal(line);
  });

  it.each([
    [0, 3, ' PASS'],
    [3, 0, '[PASS]'],
  ] as const)('should draw Badge() built at %i as the form for %i', (built, shownAt, line) => {
    expect(
      shown(() => Badge({ colorLevel: built, label: 'PASS', variant: 'success' }), shownAt)
    ).to.equal(line);
  });

  it('should draw one form and never both, and be as wide at either level', () => {
    const { element, width } = badgeView('PASS');
    for (const colorLevel of [0, 3] as const) {
      const [line] = renderToLines(element, { cascade: themedCascade(), colorLevel, width: 20 });
      expect(stringWidth(line.trimEnd()), `level ${colorLevel}`).to.equal(width);
    }
  });

  it('should clip the label at a width its props give, as one text did', () => {
    const row = box(
      { 'flex-direction': 'row' },
      Badge({ label: 'PASS', props: { width: 3 } }),
      textNode('|')
    );
    expect(
      renderToLines(row, { cascade: themedCascade(), colorLevel: 0, width: 20 })[0]?.trimEnd()
    ).to.equal('[PA|');
  });

  it('should draw both forms where the cascade has no sheet', () => {
    const { element } = badgeView('PASS');
    const [line] = renderToLines(element, { colorLevel: 0, width: 20 });
    expect(line.trimEnd()).to.equal(' PASS [PASS]');
  });
});
