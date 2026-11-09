import {
  attachContextMenu,
  type MenuEntry,
  type MenuItem,
  type MenuOptions,
  openMenu,
  parseMnemonic,
} from '../../src/components/menu.js';
import { openModal } from '../../src/components/modal.js';
import { holdInput, topLayer } from '../../src/components/overlay.js';
import { box, text } from '../../src/element/index.js';
import { createInput, type InputRouter } from '../../src/input/index.js';
import { createTestTerminal, ctrl, KEYS } from '../../src/testing/index.js';
import {
  click,
  escape,
  HEIGHT,
  move,
  picture,
  rowOf,
  settle,
  surface,
  WIDTH,
} from './menu-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A menu: what it draws, where it goes, and who has the keys and the mouse while
 * it is open.
 *
 * Driven through a real router over a test terminal, with mouse reports fed as
 * the bytes a terminal sends, because the claims are about the router's order: a
 * binding that sees every key first, a backdrop the hit test finds before
 * anything under it, click-to-focus after a press nothing stopped. A handler
 * called by hand would be in none of them.
 */

const ESC = String.fromCharCode(0x1b);

const routers: InputRouter[] = [];
const handles: Array<{ dispose(): void }> = [];

afterEach(() => {
  for (const handle of handles.splice(0)) {
    handle.dispose();
  }
  for (const input of routers.splice(0)) {
    input.stop();
  }
});

/**
 * An app with a field somewhere on it, another focusable thing, and a router.
 *
 * `at` puts the field's top-left corner on a cell, which is how a test reaches an
 * edge of the screen.
 */
function scene(opts: { at?: { x: number; y: number } } = {}) {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const seen: string[] = [];
  const field = text('Field', { focusable: true, id: 'field' });
  const other = text('Other', { focusable: true, id: 'other' });
  field.onKey = (event) => {
    seen.push(`field:${event.key.name}`);
  };
  other.onMouse = (event) => {
    seen.push(`other:${event.kind}`);
  };
  const at = opts.at ?? { x: 2, y: 1 };
  const root = box(
    { height: HEIGHT, position: 'relative', width: WIDTH },
    box({ left: at.x, position: 'absolute', top: at.y }, field),
    box({ left: 30, position: 'absolute', top: 10 }, other)
  );
  const input = createInput({
    mouse: { motion: true, surface: surface() },
    root,
    terminal: term.terminal,
  });
  routers.push(input);
  picture(root);
  input.focus.focus(field);
  return { field, input, other, root, seen, term };
}

const ITEMS: MenuEntry<string>[] = [
  { hint: 'ctrl+s', label: '&Save', value: 'save' },
  { label: 'Save &As', value: 'save-as' },
  { separator: '' },
  {
    items: [
      { label: 'PDF', value: 'pdf' },
      { label: 'HTML', value: 'html' },
    ],
    label: 'E&xport',
  },
  { disabled: 'Nothing to revert', label: '&Revert', value: 'revert' },
];

/** Opens a menu on a scene and registers it for cleanup. */
function menuOn(s: ReturnType<typeof scene>, opts: Partial<MenuOptions<string>> = {}) {
  const handle = openMenu<string>(s.root, {
    ascii: false,
    at: s.field,
    input: s.input,
    items: ITEMS,
    ...opts,
  });
  handles.push(handle);
  picture(s.root);
  return handle;
}

describe('parseMnemonic()', () => {
  it('should read the letter after an ampersand, and the first letter without one', () => {
    expect(parseMnemonic('Save &As')).toEqual({ at: 5, mnemonic: 'a', text: 'Save As' });
    expect(parseMnemonic('&File')).toEqual({ at: 0, mnemonic: 'f', text: 'File' });
    expect(parseMnemonic('Open')).toEqual({ at: undefined, mnemonic: 'o', text: 'Open' });
  });

  it('should read two ampersands as one, and a trailing one as nothing', () => {
    expect(parseMnemonic('R&&D')).toEqual({ at: undefined, mnemonic: 'r', text: 'R&D' });
    expect(parseMnemonic('Fish && &Chips')).toMatchObject({ mnemonic: 'c', text: 'Fish & Chips' });
    expect(parseMnemonic('Go&')).toEqual({ at: undefined, mnemonic: 'g', text: 'Go&' });
  });
});

describe('openMenu()', () => {
  it('should draw its items under the anchor, with the first on offer pointed at', () => {
    const s = scene();
    menuOn(s);
    expect(picture(s.root).slice(1, 9)).toEqual([
      '  Field',
      '  ╭────────────────────────────╮',
      '  │❯ Save               ctrl+s │',
      '  │  Save As                   │',
      '  │────────────────────────────│',
      '  │  Export                  ▸ │',
      '  │  Revert  Nothing to revert │',
      '  ╰────────────────────────────╯',
    ]);
  });

  it('should put the focus role on the highlighted row and nowhere else', async () => {
    const s = scene();
    const menu = menuOn(s);
    const rows = menu.element.children[0]?.children[1]?.children ?? [];
    const focused = () => rows.map((row) => row.classes.includes('sigil-focus'));
    expect(focused()).toEqual([true, false, false, false, false]);
    await s.term.press(KEYS.down);
    expect(focused()).toEqual([false, true, false, false, false]);
  });

  it('should step past a separator and a disabled item, and wrap', async () => {
    const s = scene();
    menuOn(s);
    const pointed = () => picture(s.root).find((line) => line.includes('❯')) ?? '';
    await s.term.press(KEYS.down);
    expect(pointed()).toContain('Save As');
    await s.term.press(KEYS.down);
    expect(pointed()).toContain('Export');
    await s.term.press(KEYS.down);
    expect(pointed()).toContain('Save ');
    await s.term.press(KEYS.up);
    expect(pointed()).toContain('Export');
    await s.term.press(KEYS.end);
    expect(pointed()).toContain('Export');
    await s.term.press(KEYS.home);
    expect(pointed()).toContain('ctrl+s');
  });

  it('should answer with the item chosen, and close', async () => {
    const s = scene();
    const chosen: string[] = [];
    const menu = menuOn(s, { onSelect: (item) => chosen.push(item.value as string) });
    await s.term.press(KEYS.down, KEYS.enter);
    expect((await menu.result)?.value).to.equal('save-as');
    expect(chosen).toEqual(['save-as']);
    expect(menu.open).to.equal(false);
    expect(menu.element.parent).to.equal(undefined);
    expect(picture(s.root).join('\n')).not.toContain('Save');
  });

  it('should answer nothing for Escape, and leave the focus where it was the whole time', async () => {
    const s = scene();
    const menu = menuOn(s);
    expect(s.input.focus.current.get()).to.equal(s.field);
    await s.term.press(KEYS.down);
    expect(s.input.focus.current.get()).to.equal(s.field);
    await escape(s.term);
    expect(await menu.result).to.equal(undefined);
    expect(s.input.focus.current.get()).to.equal(s.field);
  });

  it('should keep every key from the app while it is open, but never the abort', async () => {
    const s = scene();
    const quits: string[] = [];
    const sequence: string[] = [];
    s.input.bind('q', () => sequence.push('q'));
    menuOn(s);
    // made after the menu opened, so it runs after the menu's binding: the abort
    // still reaches it, which is the modal's rule
    s.input.bind((event) => {
      if (event.key.ctrl && event.key.name === 'c') {
        quits.push('quit');
      }
    });
    await s.term.press('q', KEYS.down, 'z');
    expect(s.seen).toEqual([]);
    expect(sequence).toEqual([]);
    await s.term.press(ctrl('c'));
    expect(quits).toEqual(['quit']);
  });

  it('should close on Tab and let the Tab move the focus on', async () => {
    const s = scene();
    const menu = menuOn(s);
    await s.term.press(KEYS.tab);
    expect(menu.open).to.equal(false);
    expect(await menu.result).to.equal(undefined);
    expect(s.input.focus.current.get()).to.equal(s.other);
  });

  it('should choose the item a letter is the mnemonic of, past a disabled one', async () => {
    const s = scene();
    const menu = menuOn(s);
    await s.term.press('r');
    expect(menu.open, 'the disabled Revert is not chosen').to.equal(true);
    await s.term.press('a');
    expect((await menu.result)?.value).to.equal('save-as');
  });

  it('should step through the items that share a mnemonic rather than choose one', async () => {
    const s = scene();
    const menu = menuOn(s, {
      items: [
        { label: 'Copy', value: 'copy' },
        { label: 'Cut', value: 'cut' },
        { label: 'Paste', value: 'paste' },
      ],
    });
    await s.term.press('c');
    expect(menu.open).to.equal(true);
    expect(picture(s.root).find((line) => line.includes('❯'))).toContain('Cut');
    await s.term.press(KEYS.enter);
    expect((await menu.result)?.value).to.equal('cut');
  });

  it('should open a submenu beside its row with Right, and close it with Left and Escape', async () => {
    const s = scene({ at: { x: 0, y: 1 } });
    const menu = menuOn(s);
    await s.term.press(KEYS.down, KEYS.down, KEYS.right);
    let lines = picture(s.root);
    const at = rowOf(lines, 'Export');
    // the submenu's first item is level with the row that opened it
    expect(lines[at]).toMatch(/Export\s+▸ ││❯ PDF/);
    await s.term.press(KEYS.left);
    lines = picture(s.root);
    expect(lines.join('\n')).not.toContain('PDF');
    expect(lines.find((line) => line.includes('❯'))).toContain('Export');
    await s.term.press(KEYS.right);
    await escape(s.term);
    expect(menu.open, 'Escape closes the submenu only').to.equal(true);
    expect(picture(s.root).join('\n')).not.toContain('PDF');
    await s.term.press(KEYS.right, KEYS.down, KEYS.enter);
    expect((await menu.result)?.value).to.equal('html');
  });

  it('should open a submenu on the left where there is no room on the right', async () => {
    const s = scene({ at: { x: 10, y: 1 } });
    menuOn(s, { minWidth: 30 });
    await s.term.press(KEYS.down, KEYS.down, KEYS.right);
    const lines = picture(s.root);
    expect(lines[rowOf(lines, 'Export')]).toMatch(/❯ PDF\s+││❯ Export/);
  });

  it('should flip above an anchor at the bottom of the screen', () => {
    const s = scene({ at: { x: 2, y: 9 } });
    menuOn(s);
    const lines = picture(s.root);
    expect(rowOf(lines, 'Field')).to.equal(9);
    expect(lines[8]).toMatch(/^\s+╰─+╯$/);
    expect(rowOf(lines, 'ctrl+s')).to.equal(3);
  });

  it('should open at a cell with its corner on it, and end at the cell near the far edges', () => {
    const s = scene();
    menuOn(s, { at: { x: 5, y: 3 } });
    let lines = picture(s.root);
    expect(lines[3]?.indexOf('╭')).to.equal(5);
    handles.pop()?.dispose();
    menuOn(s, { at: { x: 38, y: 10 } });
    lines = picture(s.root);
    // flipped on both axes: its bottom-right corner is beside the cell
    expect(lines[9]?.endsWith('╯')).to.equal(true);
    expect(lines[9]?.length).to.equal(38);
  });

  it("should set a separator's words into its line, and be wide enough for them", () => {
    const s = scene();
    menuOn(s, { items: [{ label: 'A' }, { separator: 'Recent files' }, { label: 'B' }] });
    expect(picture(s.root)[4]).to.equal('  │─ Recent files ─│');
  });

  it('should be at least as wide as it was asked to be', () => {
    const s = scene();
    menuOn(s, { items: [{ label: 'A' }], minWidth: 20 });
    expect(picture(s.root)[2]).to.equal(`  ╭${'─'.repeat(18)}╮`);
  });

  it('should cut a menu taller than the screen to it, and scroll to the highlight', async () => {
    const s = scene();
    const items = Array.from({ length: 30 }, (_, i) => ({ label: `Item ${i}`, value: `${i}` }));
    menuOn(s, { items });
    let lines = picture(s.root);
    expect(lines[0]).toMatch(/╭/);
    expect(lines[11]).toMatch(/╰/);
    await s.term.press(KEYS.end);
    lines = picture(s.root);
    expect(lines[10]).toContain('❯ Item 29');
    await s.term.press(KEYS.home);
    lines = picture(s.root);
    expect(lines[1]).toContain('❯ Item 0');
  });

  it('should close on a resize', async () => {
    const s = scene();
    const menu = menuOn(s);
    s.term.resize(30, 10);
    await settle();
    expect(menu.open).to.equal(false);
  });

  it('should close when the renderer it was opened over goes', () => {
    const s = scene();
    let goes: (() => void) | undefined;
    const host = {
      onDispose(handler: () => void) {
        goes = handler;
        return () => {
          goes = undefined;
        };
      },
      root: s.root,
    };
    const menu = openMenu(host, { at: s.field, input: s.input, items: ITEMS });
    goes?.();
    expect(menu.open).to.equal(false);
  });

  it('should refuse what it cannot draw', () => {
    const s = scene();
    const base = { at: s.field, input: s.input, items: ITEMS };
    expect(() => openMenu(s.root, { ...base, items: 'no' as never })).toThrow(/array/);
    expect(() => openMenu(s.root, { ...base, items: [{ label: '' }] })).toThrow(/label/);
    expect(() =>
      openMenu(s.root, { ...base, items: [{ items: [{} as MenuItem], label: 'x' }] })
    ).toThrow(/label/);
    expect(() => openMenu(s.root, { ...base, at: {} as never })).toThrow(/element or a cell/);
    expect(() => openMenu(s.root, { ...base, side: 'up' as never })).toThrow(/side/);
    expect(() => openMenu(s.root, { ...base, initial: 9 })).toThrow(/initial/);
    expect(() => openMenu(s.root, { ...base, input: {} as never })).toThrow(/router/);
    expect(() => openMenu({} as never, base)).toThrow(/host/);
    expect(topLayer(s.input), 'nothing refused was left holding the input').to.equal(undefined);
  });
});

describe('a menu and the mouse', () => {
  it('should choose an item that is clicked', async () => {
    const s = scene();
    const menu = menuOn(s);
    const lines = picture(s.root);
    await s.term.press(...click(6, rowOf(lines, 'Save As')));
    expect((await menu.result)?.value).to.equal('save-as');
  });

  it('should leave a disabled item and a separator alone when clicked', async () => {
    const s = scene();
    const menu = menuOn(s);
    const lines = picture(s.root);
    await s.term.press(...click(6, rowOf(lines, 'Revert')));
    await s.term.press(...click(6, rowOf(lines, '│───')));
    expect(menu.open).to.equal(true);
  });

  it('should dismiss on a click outside, which reaches nothing under it', async () => {
    const s = scene();
    const heard: string[] = [];
    s.root.onMouse = (event) => {
      heard.push(`root:${event.kind}`);
    };
    s.input.onMouse((event) => {
      heard.push(`router:${event.kind}`);
    });
    const menu = menuOn(s);
    await s.term.press(...click(31, 10));
    // the press, the release and the click all ended at the backdrop: neither the
    // root nor the router's own handlers heard any of the three
    // (the hover moving onto the root is not a press, and is not a menu's to keep)
    expect(heard.filter((it) => !it.endsWith('enter') && !it.endsWith('leave'))).toEqual([]);
    expect(menu.open).to.equal(false);
    expect(await menu.result).to.equal(undefined);
    expect(s.seen).toEqual([]);
    // and the press moved no focus onto what was under it
    expect(s.input.focus.current.get()).to.equal(s.field);
  });

  it('should highlight what the pointer is over, and open a submenu it rests on', async () => {
    const s = scene();
    menuOn(s);
    let lines = picture(s.root);
    await s.term.press(move(6, rowOf(lines, 'Save As')));
    lines = picture(s.root);
    expect(lines.find((line) => line.includes('❯'))).toContain('Save As');
    await s.term.press(move(6, rowOf(lines, 'Export')));
    lines = picture(s.root);
    expect(lines.join('\n')).toContain('PDF');
    // opened by the pointer, so nothing in it is highlighted until it is pointed at
    expect(lines.filter((line) => line.includes('❯'))).toHaveLength(1);
    await s.term.press(move(6, rowOf(lines, 'Save As')));
    expect(picture(s.root).join('\n')).not.toContain('PDF');
  });

  it('should choose from a submenu with the pointer', async () => {
    const s = scene();
    const menu = menuOn(s);
    let lines = picture(s.root);
    await s.term.press(...click(6, rowOf(lines, 'Export')));
    lines = picture(s.root);
    const row = rowOf(lines, 'HTML');
    await s.term.press(...click(lines[row]?.indexOf('HTML') ?? 0, row));
    expect((await menu.result)?.value).to.equal('html');
  });
});

describe('a menu over a dialog', () => {
  it('should take the keys from the dialog it opened in, and give them back', async () => {
    const s = scene();
    const inside = text('Inside', { focusable: true });
    const dialog = openModal(s.root, { actions: [], body: inside, input: s.input, title: 'D' });
    handles.push(dialog);
    picture(s.root);
    expect(s.input.focus.current.get()).to.equal(inside);
    const menu = openMenu<string>(s.root, { at: inside, input: s.input, items: ITEMS });
    handles.push(menu);
    picture(s.root);
    await escape(s.term);
    expect(menu.open, 'the menu took the Escape').to.equal(false);
    expect(dialog.open, 'and the dialog did not').to.equal(true);
    expect(s.input.focus.current.get()).to.equal(inside);
    await escape(s.term);
    expect(dialog.open).to.equal(false);
  });

  it('should hand the focus back to the dialog below when a dialog closes under a menu', () => {
    const s = scene();
    const opener = text('Opener', { focusable: true });
    const lower = openModal(s.root, { actions: [], body: opener, input: s.input });
    handles.push(lower);
    picture(s.root);
    const inner = text('Inner', { focusable: true });
    const upper = openModal(s.root, { actions: [], body: inner, input: s.input });
    handles.push(upper);
    picture(s.root);
    const menu = openMenu(s.root, { at: inner, input: s.input, items: ITEMS });
    handles.push(menu);
    // the app closes the upper dialog with the menu still open over it: the
    // focus goes to the dialog below, which is the nearest trap -- not to the
    // menu, which holds the keys and never the focus
    upper.close();
    expect(s.input.focus.current.get()).to.equal(opener);
  });

  it('should be the layer on top while it is open, and none once it is not', () => {
    const s = scene();
    const below = holdInput(s.input, { element: s.root, trap: true });
    const menu = menuOn(s);
    expect(topLayer(s.input)?.element).to.equal(menu.element);
    expect(below.isTop()).to.equal(false);
    menu.close();
    expect(below.isTop()).to.equal(true);
    below.release();
    expect(topLayer(s.input)).to.equal(undefined);
  });
});

describe('attachContextMenu()', () => {
  const items: MenuEntry<string>[] = [
    { label: 'Rename', value: 'rename' },
    { label: 'Delete', value: 'delete' },
  ];

  it('should open at the pointer on a right click inside the element', async () => {
    const s = scene();
    const chosen: string[] = [];
    const ctx = attachContextMenu<string>(s.field, {
      ascii: false,
      input: s.input,
      items,
      onSelect: (item, target) => chosen.push(`${item.value}@${target.id}`),
    });
    handles.push(ctx);
    await s.term.press(...click(3, 1, 2));
    expect(ctx.menu?.open).to.equal(true);
    const lines = picture(s.root);
    expect(lines[1]?.indexOf('╭')).to.equal(3);
    await s.term.press(KEYS.down, KEYS.enter);
    expect(chosen).toEqual(['delete@field']);
    expect(ctx.menu).to.equal(undefined);
  });

  it('should not open for a right click outside the element, or a left click inside it', async () => {
    const s = scene();
    const ctx = attachContextMenu(s.field, { input: s.input, items });
    handles.push(ctx);
    await s.term.press(...click(31, 10, 2));
    await s.term.press(...click(3, 1));
    expect(ctx.menu).to.equal(undefined);
  });

  it('should open at the focused element on Shift-F10 and on the Menu key', async () => {
    const s = scene();
    const ctx = attachContextMenu(s.field, { ascii: false, input: s.input, items });
    handles.push(ctx);
    await s.term.press(`${ESC}[21;2~`);
    expect(ctx.menu?.open).to.equal(true);
    const lines = picture(s.root);
    expect(rowOf(lines, 'Rename')).to.equal(3);
    await escape(s.term);
    expect(ctx.menu).to.equal(undefined);
    await s.term.press(`${ESC}[29~`);
    expect(ctx.menu?.open).to.equal(true);
  });

  it('should leave Shift-F10 to a menu that is already open', async () => {
    const s = scene();
    const ctx = attachContextMenu(s.field, { input: s.input, items });
    handles.push(ctx);
    await s.term.press(`${ESC}[21;2~`);
    const first = ctx.menu;
    picture(s.root);
    await s.term.press(`${ESC}[21;2~`);
    expect(ctx.menu).to.equal(first);
    expect(topLayer(s.input)?.element).to.equal(first?.element);
  });

  it('should leave the keys alone while the focus is elsewhere', async () => {
    const s = scene();
    const ctx = attachContextMenu(s.field, { input: s.input, items });
    handles.push(ctx);
    s.input.focus.focus(s.other);
    await s.term.press(`${ESC}[21;2~`);
    expect(ctx.menu).to.equal(undefined);
  });

  it('should ask a function for its items, with what it was opened on', async () => {
    const s = scene();
    const asked: string[] = [];
    const ctx = attachContextMenu(s.field, {
      input: s.input,
      items: (target) => {
        asked.push(target.id ?? '');
        return items;
      },
    });
    handles.push(ctx);
    await s.term.press(`${ESC}[29~`);
    expect(asked).toEqual(['field']);
  });

  it('should list Shift-F10 in the key help while the focus is inside', () => {
    const s = scene();
    handles.push(attachContextMenu(s.field, { input: s.input, items }));
    expect(s.input.bindings().map((it) => `${it.keys} ${it.description}`)).toContain(
      'shift+f10 menu'
    );
    s.input.focus.focus(s.other);
    expect(s.input.bindings().map((it) => it.keys)).not.toContain('shift+f10');
  });

  it('should take everything off the router when disposed', async () => {
    const s = scene();
    const ctx = attachContextMenu(s.field, { input: s.input, items });
    ctx.dispose();
    await s.term.press(`${ESC}[29~`);
    await s.term.press(...click(3, 1, 2));
    expect(ctx.menu).to.equal(undefined);
    expect(s.input.bindings()).toEqual([]);
  });
});
