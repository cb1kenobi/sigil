import { strip } from '../../src/ansi/index.js';
import { BORDER_RUN_MIN, borderRun, fitBorder } from '../../src/components/border-label.js';
import { Panel, type PanelProps } from '../../src/components/panel.js';
import { box, type Element, renderToLines, text } from '../../src/element/index.js';
import { flush, State } from '../../src/signals/index.js';
import { themedCascade } from '../../src/theme/index.js';
import { describe, expect, it } from 'vitest';

/**
 * A panel: labels set into a border, fitted to the width the layout gave it.
 *
 * Every assertion is a picture, for the reason the layout tests are: a failing
 * one prints the two grids, and says what was wrong in the only terms that matter,
 * which is where each character landed.
 */

const ESC = String.fromCharCode(0x1b);

/** The panel as it is drawn, as rows: no colour and no trailing blanks. */
function picture(host: Element, width: number, height?: number): string[] {
  return renderToLines(host, { cascade: themedCascade(), colorLevel: 0, height, width }).map(
    (line) => strip(line).trimEnd()
  );
}

/** A panel over two rows, with the unicode border whatever the machine running this is. */
function panel(props: PanelProps = {}): Element {
  return Panel({ ascii: false, ...props }, text('pid   name'), text('1     init'));
}

/** Every label a panel can carry. */
const FULL = {
  annotation: 'sort: cpu',
  footer: '↑↓ select · s sort',
  footerAnnotation: '1–4 of 340',
  title: 'processes · 12 of 340',
} as const;

describe('Panel', () => {
  describe('the labels', () => {
    it('should set a title into the top border, at the left', () => {
      expect(picture(panel({ title: 'processes' }), 24)).toEqual([
        '╭─ processes ──────────╮',
        '│ pid   name           │',
        '│ 1     init           │',
        '╰──────────────────────╯',
      ]);
    });

    it('should set an annotation at the top right, and a footer along the bottom', () => {
      expect(picture(panel(FULL), 44)).toEqual([
        '╭─ processes · 12 of 340 ────── sort: cpu ─╮',
        '│ pid   name                               │',
        '│ 1     init                               │',
        '╰─ ↑↓ select · s sort ──────── 1–4 of 340 ─╯',
      ]);
    });

    it('should place a title left, centered or right', () => {
      const at = (titleAlign: 'center' | 'left' | 'right') =>
        picture(panel({ title: 'files', titleAlign }), 24)[0];

      expect(at('left')).toBe('╭─ files ──────────────╮');
      expect(at('center')).toBe('╭─────── files ────────╮');
      expect(at('right')).toBe('╭────────────── files ─╮');
    });

    it('should pack a right-aligned title against the annotation instead of under it', () => {
      expect(
        picture(panel({ annotation: 'cpu', title: 'files', titleAlign: 'right' }), 28)[0]
      ).toBe('╭──────────── files ─ cpu ─╮');
    });

    it('should draw no label for a blank one, and leave the border plain', () => {
      expect(picture(panel({ footer: '  ', title: '' }), 12)).toEqual(picture(panel(), 12));
    });

    it('should read a label as one line without escape sequences', () => {
      const messy = `${ESC}[1mFirst${ESC}[22m\n  second`;

      expect(picture(panel({ title: messy }), 24)[0]).toBe(
        picture(panel({ title: 'First second' }), 24)[0]
      );
    });

    it('should keep a wide character whole', () => {
      expect(picture(panel({ title: '日本語' }), 20)[0]).toBe('╭─ 日本語 ─────────╮');
    });
  });

  describe('a border too narrow for what it was given', () => {
    it('should drop the annotation before it touches the title', () => {
      // together at 44; the title alone at 30
      expect(picture(panel(FULL), 30)).toEqual([
        '╭─ processes · 12 of 340 ────╮',
        '│ pid   name                 │',
        '│ 1     init                 │',
        '╰─ ↑↓ select · s sort ───────╯',
      ]);
    });

    it('should leave a rule cell between the title and the annotation, and not fewer', () => {
      // 'abcd' and 'efgh' are six cells each with their spaces: twelve and a gap
      // of one is thirteen, which is the run of a border seventeen wide
      const at = (width: number) => picture(panel({ annotation: 'efgh', title: 'abcd' }), width)[0];

      expect(at(17)).toBe('╭─ abcd ─ efgh ─╮');
      expect(at(16)).toBe('╭─ abcd ───────╮');
    });

    it('should cut the title with an ellipsis once the annotation is gone', () => {
      expect(picture(panel(FULL), 24)).toEqual([
        '╭─ processes · 12 of… ─╮',
        '│ pid   name           │',
        '│ 1     init           │',
        '╰─ ↑↓ select · s sort ─╯',
      ]);
    });

    it('should cut each border on its own', () => {
      // the top is cut while the bottom, which has less to say, is whole
      expect(picture(panel({ footer: 'ok', title: 'a long title for a small box' }), 16)).toEqual([
        '╭─ a long ti… ─╮',
        '│ pid   name   │',
        '│ 1     init   │',
        '╰─ ok ─────────╯',
      ]);
    });

    it('should cut an annotation that has no title to stand in for, rather than drop it', () => {
      expect(picture(panel({ annotation: 'sort: cpu and more' }), 16)[0]).toBe('╭─ sort: cpu… ─╮');
    });

    it('should go plain when a label would have no column of its own', () => {
      // a corner, a rule cell, a space, one column, a space, a rule cell and a corner
      expect(borderRun(7)).toBe(BORDER_RUN_MIN);
      expect(picture(panel({ title: 'f' }), 7)[0]).toBe('╭─ f ─╮');
      // and a label cut to nothing but the mark that says it was cut says nothing
      expect(picture(panel({ title: 'files' }), 7)[0]).toBe('╭─────╮');
      expect(picture(panel({ title: 'files' }), 6)[0]).toBe('╭────╮');
      expect(picture(panel({ title: 'files' }), 5)[0]).toBe('╭───╮');
    });
  });

  describe('a label that follows a signal', () => {
    it('should redraw when what it reads changes, and fit again', () => {
      const shown = new State(12);
      const host = panel({ title: () => `processes · ${shown.get()} of 340` });

      expect(picture(host, 40)[0]).toBe('╭─ processes · 12 of 340 ──────────────╮');

      // and it was laid out again: the new label is wider than the old
      shown.set(340);
      flush();
      expect(picture(host, 40)[0]).toBe('╭─ processes · 340 of 340 ─────────────╮');
    });

    it('should bring an annotation back when a label gets short enough to leave it room', () => {
      const title = new State('a title that is far too long to share a border');
      const host = panel({ annotation: 'cpu', title: () => title.get() });

      expect(picture(host, 30)[0]).toBe('╭─ a title that is far too… ─╮');

      title.set('short');
      flush();
      expect(picture(host, 30)[0]).toBe('╭─ short ────────────── cpu ─╮');
    });

    it('should fit to a new width without being told', () => {
      const host = panel(FULL);

      expect(picture(host, 44)[0]).toBe('╭─ processes · 12 of 340 ────── sort: cpu ─╮');
      expect(picture(host, 30)[0]).toBe('╭─ processes · 12 of 340 ────╮');
      expect(picture(host, 44)[0]).toBe('╭─ processes · 12 of 340 ────── sort: cpu ─╮');
    });
  });

  describe('the box', () => {
    it('should clip its content in a box of its own, so the labels are not clipped with it', () => {
      const host = Panel(
        { ascii: false, footer: 'foot', props: { height: 4 }, title: 'title' },
        text('one'),
        text('two'),
        text('three'),
        text('four')
      );

      expect(picture(host, 14)).toEqual([
        '╭─ title ────╮',
        '│ one        │',
        '│ two        │',
        '╰─ foot ─────╯',
      ]);
    });

    it('should draw the border from the cascade, so a theme can restyle it', () => {
      const host = panel({ class: 'files', title: 'x' });
      const themed = (theme: string) =>
        renderToLines(host, {
          cascade: themedCascade({ theme }),
          colorLevel: 1,
          width: 12,
        })[0];

      expect(themed('')).not.toContain(`${ESC}[31m`);
      expect(themed('.sigil-panel { border-color: red }')).toContain(`${ESC}[31m╭`);
      // and by the app's own class as well as the framework's
      expect(themed('.files { border-color: red }')).toContain(`${ESC}[31m╭`);
    });

    it('should carry a class for every part, for a theme to write against', () => {
      const classes = (el: Element): string[] => [
        ...el.classes,
        ...el.children.flatMap((child) => classes(child)),
      ];

      expect(classes(panel(FULL))).toEqual(
        expect.arrayContaining([
          'sigil-panel',
          'sigil-panel-annotation',
          'sigil-panel-body',
          'sigil-panel-footer',
          'sigil-panel-footer-annotation',
          'sigil-panel-title',
        ])
      );
    });

    it('should draw the title in the heading role and the rest in the muted one', () => {
      const lines = renderToLines(panel(FULL), {
        cascade: themedCascade(),
        colorLevel: 1,
        width: 44,
      });

      // bold is the heading role's, and dim is the muted one's
      expect(lines[0]).toContain(`${ESC}[1mprocesses`);
      expect(lines[0]).toContain(`${ESC}[2msort: cpu`);
    });

    it('should fall back to an ASCII border where the terminal cannot be trusted with box drawing', () => {
      const host = Panel({ ascii: true, footer: 'f', title: 'files' }, text('x'));

      expect(picture(host, 14)).toEqual(['+- files ----+', '| x          |', '+- f --------+']);
    });

    it('should take an explicit border over a detected one', () => {
      expect(picture(panel({ border: 'double', title: 't' }), 8)[0]).toBe('╔═ t ══╗');
    });

    it('should take its content as arguments or as children, which is how a template hands it over', () => {
      const asChildren = Panel({ ascii: false, children: [text('a'), text('b')], title: 't' });
      const asArguments = Panel({ ascii: false, title: 't' }, text('a'), text('b'));

      expect(picture(asChildren, 10)).toEqual(picture(asArguments, 10));
      expect(picture(asChildren, 10)).toEqual([
        '╭─ t ────╮',
        '│ a      │',
        '│ b      │',
        '╰────────╯',
      ]);
    });

    it('should grow to fill its slot, and let the host say otherwise', () => {
      const tall = (props: PanelProps['props']) => {
        const host = panel({ props, title: 'x' });
        picture(box({ 'flex-direction': 'column', height: 10 }, host), 20, 10);
        return host.box?.height;
      };

      expect(tall(undefined)).toBe(10);
      expect(tall({ 'flex-grow': 0 })).toBe(4);
    });
  });

  describe('growing', () => {
    const height = (theme: string, props: PanelProps = {}) => {
      const host = panel({ title: 'x', ...props });
      renderToLines(box({ 'flex-direction': 'column', height: 10 }, host), {
        cascade: themedCascade({ theme }),
        colorLevel: 0,
        height: 10,
        width: 20,
      });
      return host.box?.height;
    };

    it('should fill its slot by a rule in the framework sheet', () => {
      expect(height('')).toBe(10);
    });

    it('should let a stylesheet say otherwise, as well as a prop', () => {
      // it was an inline prop, which a stylesheet cannot beat: a panel used as a card in
      // a column could only be made to stop growing from the call site
      expect(height('.card { flex-grow: 0 }', { class: 'card' })).toBe(4);
      expect(height('', { props: { 'flex-grow': 0 } })).toBe(4);
    });
  });

  describe('what it refuses', () => {
    it('should refuse a label that is neither a string nor a function', () => {
      expect(() => Panel({ title: 5 as never })).toThrow(/title to be a string or a function/);
      expect(() => Panel({ footerAnnotation: {} as never })).toThrow(
        /footerAnnotation to be a string or a function/
      );
    });

    it('should refuse an alignment it does not have', () => {
      expect(() => Panel({ titleAlign: 'middle' as never })).toThrow(/titleAlign/);
    });
  });
});

describe('fitBorder()', () => {
  it('should lay out nothing when there is nothing to lay out', () => {
    expect(fitBorder(40, '', '', 'left')).toMatchObject({ end: { text: '' }, start: { text: '' } });
  });

  it('should center a title on the whole border, not on what the annotation leaves', () => {
    const fit = fitBorder(24, 'title', '', 'center');

    // seven cells with its spaces, in a run of twenty
    expect(fit.start.offset).toBe(Math.floor((borderRun(24) - 7) / 2));
  });

  it('should drop the annotation of a centered title that would touch it', () => {
    expect(fitBorder(44, 'processes · 12 of 340', 'sort: cpu', 'center').end.text).toBe('');
    expect(fitBorder(60, 'files', 'sort: cpu', 'center').end.text).not.toBe('');
  });
});
