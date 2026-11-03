import {
  ATTR,
  CellBuffer,
  createCanvas,
  DEFAULT_COLOR,
  Painter,
  palette,
  type Style,
  StyleTable,
} from '../../src/canvas/index.js';
import { TextField } from '../../src/components/text-field.js';
import {
  arrange,
  box,
  type Element,
  paint,
  raw,
  renderToString,
  resolveStyles,
  text,
} from '../../src/element/index.js';
import { flush } from '../../src/signals/index.js';
import { Cascade, parseStylesheet, Restyler } from '../../src/style/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A container's background showing through what is painted inside it.
 *
 * `background-color` does not inherit, so a text's own background is the
 * terminal's, and painting its glyphs with that wiped the box's colour from
 * every cell a character sat on. Read off the cell grid throughout: a string
 * with its colour taken off cannot see a background, which is how it went
 * unnoticed in the debug overlay for as long as it did.
 */

const GRAY = palette(8);
const BLUE = palette(4);

/** Resolves, lays out and paints a tree into a grid, and reads cells back. */
function grid(root: Element, width: number, height: number, cascade = new Cascade([])) {
  const styles = new StyleTable();
  const buffer = new CellBuffer(width, height);
  resolveStyles(root, new Restyler(cascade));
  arrange(root, { height, width });
  paint(root, new Painter(buffer, styles));

  const at = (x: number, y = 0): Style => styles.get(buffer.styleAt(x, y));
  return {
    at,
    /** The background of each cell of a row, as far as `width`. */
    bgs: (y = 0, upTo = width): number[] => Array.from({ length: upTo }, (_, x) => at(x, y).bg),
    line: (y = 0): string => buffer.toLines()[y] ?? '',
  };
}

/** `n` copies of a colour, for a row that should be all one background. */
const run = (n: number, color: number): number[] => Array.from({ length: n }, () => color);

describe('a container background behind its text', () => {
  it('should show a box background through the text inside it', () => {
    // the defect as filed: `hello` on the terminal's own background, with a
    // grey bar after it
    const g = grid(box({ 'background-color': 'gray' }, text('hello')), 20, 1);

    expect(g.line()).toBe('hello               ');
    expect(g.bgs()).toEqual(run(20, GRAY));
  });

  it('should show it through when the background comes from a sheet rule', () => {
    const sheet = new Cascade([parseStylesheet('.pane { background-color: gray }')]);
    const g = grid(box({ class: 'pane' }, text('hello')), 10, 1, sheet);

    expect(g.bgs()).toEqual(run(10, GRAY));
  });

  it('should show it through a nowrap text and a row of two', () => {
    const g = grid(
      box(
        { 'background-color': 'gray', 'column-gap': 1, 'flex-direction': 'row' },
        text('one', { 'white-space': 'nowrap' }),
        text('two')
      ),
      10,
      1
    );

    expect(g.line()).toBe('one two   ');
    expect(g.bgs()).toEqual(run(10, GRAY));
  });

  it('should show the nearest background, not an outer one', () => {
    const g = grid(
      box(
        { 'background-color': 'gray', 'padding-left': 1 },
        box({ 'background-color': 'blue' }, text('ab'))
      ),
      4,
      1
    );

    expect(g.bgs()).toEqual([GRAY, BLUE, BLUE, GRAY]);
  });

  it('should keep the text its own foreground and attributes', () => {
    const g = grid(
      box({ 'background-color': 'gray' }, text('x', { bold: true, color: 'red' })),
      2,
      1
    );

    expect(g.at(0)).toMatchObject({ attrs: ATTR.bold, bg: GRAY, fg: palette(1) });
  });

  it('should let a background the text sets win', () => {
    const g = grid(
      box({ 'background-color': 'gray' }, text('ab', { 'background-color': 'blue' })),
      4,
      1
    );

    expect(g.bgs()).toEqual([BLUE, BLUE, GRAY, GRAY]);
  });

  it('should not punch through for an explicit default, which is the same value as transparent', () => {
    // `default`, `transparent` and `none` all parse to `DEFAULT_COLOR`, so a
    // text that says one of them has said what a text that says nothing has:
    // there is no opaque "terminal background" to ask for, and inventing one is
    // the alpha model the canvas refuses
    for (const value of ['default', 'transparent', 'none']) {
      const g = grid(
        box({ 'background-color': 'gray' }, text('ab', { 'background-color': value })),
        3,
        1
      );

      expect(g.bgs(), value).toEqual(run(3, GRAY));
    }
  });

  it('should show it through a child border with no background of its own', () => {
    const g = grid(
      box(
        { 'background-color': 'gray' },
        box({ 'border-style': 'single', height: 3, width: 4 }, text('x'))
      ),
      4,
      3
    );

    expect(g.line(0)).toBe('┌──┐');
    expect([...g.bgs(0), ...g.bgs(1), ...g.bgs(2)]).toEqual(run(12, GRAY));
  });

  it('should show it through what a raw element paints', () => {
    const g = grid(
      box(
        { 'background-color': 'gray' },
        raw(
          {
            measure: () => ({ height: 1, width: 2 }),
            paint: (painter, area) => {
              painter.text(area.x, area.y, '▲▼', { fg: palette(2) });
            },
          },
          {}
        )
      ),
      3,
      1
    );

    expect(g.bgs()).toEqual(run(3, GRAY));
    expect(g.at(0).fg).toBe(palette(2));
  });

  it('should show it through text painted over a sibling, which is paint order', () => {
    // not the cascade: the absolute text has no ancestor with a background, so
    // only the grid knows what is under it
    const g = grid(
      box(
        { position: 'relative', width: 4 },
        box({ 'background-color': 'gray', height: 1, width: 4 }),
        text('ab', { left: 1, position: 'absolute', top: 0 })
      ),
      4,
      1
    );

    expect(g.line()).toBe(' ab ');
    expect(g.bgs()).toEqual(run(4, GRAY));
  });

  it('should keep the box colour under an inverse text, so the swap draws it as the glyph', () => {
    const g = grid(box({ 'background-color': 'gray' }, text('ab', { inverse: true })), 3, 1);

    expect(g.at(0)).toMatchObject({ attrs: ATTR.inverse, bg: GRAY, fg: DEFAULT_COLOR });
  });

  it("should keep it under a text field's caret, which is an inverse cell", () => {
    // the caret is a text inside the field with `inverse` from the sheet, so it
    // is the inverse case above reached the way every focused field reaches it
    const field = TextField({ value: 'ab' });
    field.setState('focus', true);
    flush();
    const g = grid(box({ 'background-color': 'gray' }, field), 6, 1, themedCascade());

    expect(g.line()).toBe('ab    ');
    expect(g.at(2)).toMatchObject({ bg: GRAY });
    expect(g.at(2).attrs & ATTR.inverse).toBe(ATTR.inverse);
    expect(g.bgs()).toEqual(run(6, GRAY));
  });

  it('should drop the background with every other colour at level 0', () => {
    const tree = (): Element => box({ 'background-color': 'gray' }, text('hello'));
    const plain = new Cascade([]);
    plain.media = { ...plain.media, colorLevel: 0 };

    expect(grid(tree(), 8, 1, plain).bgs()).toEqual(run(8, DEFAULT_COLOR));
    expect(renderToString(tree(), { colorLevel: 0, width: 8 })).toBe('hello');
  });

  it('should repaint the text cells when the box background changes', () => {
    // the background a glyph took is part of its interned style, so the diff
    // sees a different cell and draws it again. Were it read at present time
    // instead, `hello` would stay on the old colour while the blanks moved
    const canvas = createCanvas({ height: 1, width: 10 });
    const frame = (color: string): void => {
      const root = box({ 'background-color': color }, text('hello'));
      resolveStyles(root);
      arrange(root, { height: 1, width: 10 });
      canvas.paint((painter) => paint(root, painter));
    };

    frame('gray');
    canvas.present();
    frame('blue');
    const second = canvas.present();

    expect(second.cells).toBe(10);
    expect(second.output).toContain('hello');
  });
});
