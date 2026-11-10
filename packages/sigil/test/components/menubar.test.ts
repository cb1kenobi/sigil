import { type MenuItem } from '../../src/components/menu.js';
import { Menubar, menubarControl, type MenubarMenu } from '../../src/components/menubar.js';
import { TextField } from '../../src/components/text-field.js';
import { box, type Element, text } from '../../src/element/index.js';
import { createInput, type InputRouter } from '../../src/input/index.js';
import { createRoot } from '../../src/renderer/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import {
  click,
  drag,
  escape,
  HEIGHT,
  move,
  picture,
  press,
  release,
  rowOf,
  surface,
  WIDTH,
} from './menu-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A menubar: the titles, the keys that open them from anywhere, and the moves
 * between them while one is open.
 *
 * Through a real router over a test terminal, as the menu's own tests are, and
 * inside an owner so that the bar's fallbacks come off the router at the end.
 */

const ESC = String.fromCharCode(0x1b);

const MENUS: MenubarMenu<string>[] = [
  {
    items: [
      { label: '&New', value: 'new' },
      { label: '&Open', value: 'open' },
      { items: [{ label: 'a.txt', value: 'a' }], label: 'Open &Recent' },
    ],
    label: '&File',
  },
  { items: [{ label: '&Undo', value: 'undo' }], label: '&Edit' },
  { disabled: true, items: [{ label: 'x', value: 'x' }], label: '&Tools' },
  { items: [{ label: '&About', value: 'about' }], label: '&Help' },
];

const routers: InputRouter[] = [];
const disposers: Array<() => void> = [];

afterEach(() => {
  for (const dispose of disposers.splice(0)) {
    dispose();
  }
  for (const input of routers.splice(0)) {
    input.stop();
  }
});

/** An app with a menubar across the top and a field under it, which has the focus. */
function scene(
  opts: { body?: (input: InputRouter) => Element; keys?: boolean; menuClass?: string } = {}
) {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const chosen: string[] = [];
  const holder = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH });
  const input = createInput({
    mouse: { motion: true, surface: surface() },
    root: holder,
    terminal: term.terminal,
  });
  routers.push(input);
  const field = opts.body?.(input) ?? text('Body', { focusable: true });
  const bar = createRoot((dispose) => {
    disposers.push(dispose);
    return Menubar<string>({
      ascii: false,
      input,
      keys: opts.keys,
      menuClass: opts.menuClass,
      menus: MENUS,
      onSelect: (item: MenuItem<string>) => chosen.push(item.value as string),
    });
  });
  holder.append(bar, field);
  picture(holder);
  input.focus.focus(field);
  const control = menubarControl(bar);
  if (control === undefined) {
    throw new Error('no control');
  }
  return { bar, chosen, control, field, input, root: holder, term };
}

describe('Menubar()', () => {
  it('should draw its titles in a row, the disabled one muted', () => {
    const s = scene();
    expect(picture(s.root)[0]).to.equal(' File  Edit  Tools  Help');
    expect(s.bar.children[2]?.classes).toContain('sigil-muted');
  });

  it('should open the first menu on F10, bracket its title, and give back the focus after', async () => {
    const s = scene();
    await s.term.press(`${ESC}[21~`);
    expect(s.control.openIndex).to.equal(0);
    const lines = picture(s.root);
    expect(lines[0]).to.equal('[File] Edit  Tools  Help');
    expect(lines[2]).toContain('❯ New');
    const face = s.bar.children[0]?.children[1];
    expect(face?.classes).toContain('sigil-focus');
    expect(s.input.focus.current.get()).to.equal(s.field);
    await escape(s.term);
    expect(s.control.openIndex).to.equal(undefined);
    expect(face?.classes).not.toContain('sigil-focus');
    expect(picture(s.root)[0]).to.equal(' File  Edit  Tools  Help');
    expect(s.input.focus.current.get()).to.equal(s.field);
  });

  it('should move between the titles with Left and Right, past a disabled one, wrapping', async () => {
    const s = scene();
    await s.term.press(`${ESC}[21~`, KEYS.right);
    expect(s.control.openIndex).to.equal(1);
    await s.term.press(KEYS.right);
    expect(s.control.openIndex, 'Tools is disabled').to.equal(3);
    await s.term.press(KEYS.right);
    expect(s.control.openIndex).to.equal(0);
    await s.term.press(KEYS.left);
    expect(s.control.openIndex).to.equal(3);
    expect(picture(s.root).join('\n')).toContain('❯ About');
  });

  it('should open a submenu with Right, and move to the next title from a plain item', async () => {
    const s = scene();
    await s.term.press(`${ESC}[21~`, KEYS.up, KEYS.right);
    expect(picture(s.root).join('\n')).toContain('a.txt');
    expect(s.control.openIndex).to.equal(0);
    await s.term.press(KEYS.left, KEYS.up, KEYS.right);
    expect(s.control.openIndex).to.equal(1);
  });

  it('should open the menu an Alt-letter names, and choose from it', async () => {
    const s = scene();
    await s.term.press(`${ESC}e`);
    expect(s.control.openIndex).to.equal(1);
    await s.term.press('u');
    expect(s.chosen).toEqual(['undo']);
    expect(s.control.openIndex).to.equal(undefined);
  });

  it('should switch menus on an Alt-letter while one is open, and close on F10', async () => {
    const s = scene();
    await s.term.press(`${ESC}[21~`, `${ESC}h`);
    expect(s.control.openIndex).to.equal(3);
    await s.term.press(`${ESC}[21~`);
    expect(s.control.openIndex).to.equal(undefined);
  });

  it('should leave an Alt-letter to a focused field that reads it', async () => {
    const value = { field: undefined as Element | undefined };
    const s = scene({
      body: () => {
        value.field = createRoot((dispose) => {
          disposers.push(dispose);
          return TextField({ value: 'one two' });
        });
        return value.field;
      },
    });
    // Alt-F is a word to the right in a text field, and the field outranks the
    // bar's fallback; Alt-E is nothing to the field, so it reaches the bar
    await s.term.press(`${ESC}f`);
    expect(s.control.openIndex).to.equal(undefined);
    await s.term.press(`${ESC}e`);
    expect(s.control.openIndex).to.equal(1);
  });

  it('should list F10 in the key help, and nothing with keys: false', () => {
    const s = scene();
    expect(s.input.bindings().map((it) => `${it.keys} ${it.description}`)).toContain('f10 menu');
    disposers.splice(0).forEach((dispose) => dispose());
    expect(s.input.bindings()).toEqual([]);
    const t = scene({ keys: false });
    expect(t.input.bindings()).toEqual([]);
  });

  it('should take its keys off the router when the component goes', async () => {
    const s = scene();
    disposers.splice(0).forEach((dispose) => dispose());
    await s.term.press(`${ESC}[21~`, `${ESC}e`);
    expect(s.control.openIndex).to.equal(undefined);
  });
});

describe('a menubar and the mouse', () => {
  it('should open a title that is pressed, and close it when it is pressed again', async () => {
    const s = scene();
    await s.term.press(...click(8, 0));
    expect(s.control.openIndex).to.equal(1);
    // opened by the pointer, so nothing is highlighted until it is pointed at
    expect(picture(s.root).join('\n')).not.toContain('❯');
    await s.term.press(...click(8, 0));
    expect(s.control.openIndex).to.equal(undefined);
    expect(s.input.focus.current.get()).to.equal(s.field);
  });

  it('should close for a second press on the title before a frame has drawn the menu', async () => {
    const s = scene();
    // no layout between the two: the backdrop has no box yet, so the second press
    // lands on the title itself, and is the same toggle
    await s.term.press(...click(2, 0), ...click(2, 0));
    expect(s.control.openIndex).to.equal(undefined);
  });

  it('should open the title the pointer moves onto while one is open', async () => {
    const s = scene();
    await s.term.press(...click(2, 0));
    picture(s.root);
    await s.term.press(move(21, 0));
    expect(s.control.openIndex).to.equal(3);
    await s.term.press(move(15, 0));
    expect(s.control.openIndex, 'not onto a disabled one').to.equal(3);
  });

  it('should choose an item a drag from its title is released over', async () => {
    const s = scene();
    await s.term.press(press(2, 0));
    const lines = picture(s.root);
    const row = rowOf(lines, 'Open');
    await s.term.press(drag(3, row));
    expect(picture(s.root)[row]).toContain('❯ Open');
    await s.term.press(release(3, row));
    expect(s.chosen).toEqual(['open']);
    expect(s.control.openIndex).to.equal(undefined);
  });

  it('should keep the menu open for a press and release on its own title', async () => {
    const s = scene();
    await s.term.press(press(2, 0), release(2, 0));
    expect(s.control.openIndex).to.equal(0);
    picture(s.root);
    await s.term.press(...click(30, 8));
    expect(s.control.openIndex).to.equal(undefined);
    expect(s.chosen).toEqual([]);
  });

  it('should open nothing for a press on a disabled title', async () => {
    const s = scene();
    await s.term.press(...click(15, 0));
    expect(s.control.openIndex).to.equal(undefined);
  });
});

describe('menubarControl()', () => {
  it('should open, report and close the menus', () => {
    const s = scene();
    s.control.open(3);
    expect(s.control.openIndex).to.equal(3);
    s.control.open();
    expect(s.control.openIndex).to.equal(0);
    s.control.close();
    expect(s.control.openIndex).to.equal(undefined);
  });

  it('should put menuClass on the menus its titles open, which are drawn on the root', async () => {
    const s = scene({ menuClass: 'files' });
    await s.term.press(`${ESC}[21~`);
    picture(s.root);
    const panels = s.root.children
      .at(-1)
      ?.children.filter((el) => el.classes.includes('sigil-menu'));
    expect(panels?.map((el) => el.classes)).toEqual([['sigil-menu', 'files']]);
    expect(s.bar.classes).not.toContain('files');
  });

  it('should answer undefined for an element no menubar built', () => {
    expect(menubarControl(box())).to.equal(undefined);
  });

  it('should refuse what it cannot draw', () => {
    const input = createInput({ terminal: createTestTerminal().terminal });
    routers.push(input);
    expect(() => Menubar({ input: {} as never, menus: [] })).toThrow(/router/);
    expect(() => Menubar({ input, menus: 'x' as never })).toThrow(/array/);
    expect(() => Menubar({ input, menuClass: 3 as never, menus: [] })).toThrow(/menuClass/);
    expect(() => Menubar({ input, menus: [{ items: [], label: '' }] })).toThrow(/label/);
    expect(() => Menubar({ input, menus: [{ items: 'x' as never, label: 'A' }] })).toThrow(/array/);
    // all the way down, where it is built rather than where a key opens it
    expect(() =>
      Menubar({ input, menus: [{ items: [{ items: [{ label: '' }], label: 'B' }], label: 'A' }] })
    ).toThrow(/label/);
  });
});
