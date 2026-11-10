import { Dropdown, type DropdownProps } from '../../src/components/dropdown.js';
import { openModal } from '../../src/components/modal.js';
import { box, text } from '../../src/element/index.js';
import { createInput, type InputRouter } from '../../src/input/index.js';
import { createRoot } from '../../src/renderer/index.js';
import { flush, State } from '../../src/signals/index.js';
import { createTestTerminal, KEYS } from '../../src/testing/index.js';
import {
  click,
  drag,
  escape,
  HEIGHT,
  picture,
  press,
  release,
  rowOf,
  surface,
  WIDTH,
} from './menu-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A dropdown select: the field, the list it opens, and what a pick writes.
 *
 * Through a real router over a test terminal, inside an owner, as the menu's own
 * tests are.
 */

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

const OPTIONS = [
  'debug',
  'info',
  { label: 'warn', value: 'warn' },
  { separator: '' },
  { disabled: 'Not in this build', label: 'trace', value: 'trace' },
  { label: 'error', value: 'error' },
];

/** An app with a label, a dropdown beside it, and another focusable thing. */
function scene(props: Partial<DropdownProps<string>> = {}) {
  const term = createTestTerminal({ columns: WIDTH, rows: HEIGHT });
  const changes: string[] = [];
  const value = props.value instanceof State ? props.value : new State<string | undefined>('info');
  const other = text('Other', { focusable: true });
  const root = box({ 'flex-direction': 'column', height: HEIGHT, width: WIDTH });
  const input = createInput({
    mouse: { motion: true, surface: surface() },
    root,
    terminal: term.terminal,
  });
  routers.push(input);
  const field = createRoot((dispose) => {
    disposers.push(dispose);
    return Dropdown<string>({
      ascii: false,
      input,
      onChange: (to) => changes.push(to),
      options: OPTIONS,
      ...props,
      value,
    });
  });
  root.append(box({ 'column-gap': 1, 'flex-direction': 'row' }, text('Level'), field), other);
  picture(root);
  return { changes, field, input, other, root, term, value };
}

describe('Dropdown()', () => {
  it('should show its value at the width of the widest choice, with an arrow', () => {
    const s = scene();
    expect(picture(s.root)[0]).to.equal('Level  info  ▾');
    s.value.set('error');
    flush();
    expect(picture(s.root)[0]).to.equal('Level  error ▾');
  });

  it('should bracket itself and take the focus role while it has the focus', () => {
    const s = scene();
    s.input.focus.focus(s.field);
    expect(picture(s.root)[0]).to.equal('Level [info  ▾]');
    expect(s.field.children[1]?.classes).toContain('sigil-focus');
    s.input.focus.focus(s.other);
    expect(s.field.children[1]?.classes).not.toContain('sigil-focus');
  });

  it('should open under itself on Enter with the value highlighted, and pick with the keys', async () => {
    const s = scene();
    s.input.focus.focus(s.field);
    await s.term.press(KEYS.enter);
    let lines = picture(s.root);
    expect(lines[1]?.indexOf('╭')).to.equal(s.field.box?.x);
    expect(lines.find((line) => line.includes('❯'))).toContain('info');
    // past the separator and the disabled trace
    await s.term.press(KEYS.down, KEYS.down);
    lines = picture(s.root);
    expect(lines.find((line) => line.includes('❯'))).toContain('error');
    await s.term.press(KEYS.enter);
    expect(s.value.get()).to.equal('error');
    expect(s.changes).toEqual(['error']);
    expect(s.input.focus.current.get()).to.equal(s.field);
    expect(picture(s.root).join('\n')).not.toContain('debug');
  });

  it('should put menuClass on the list it opens, and not on the field', async () => {
    const s = scene({ menuClass: 'tinted' });
    s.input.focus.focus(s.field);
    await s.term.press(KEYS.enter);
    picture(s.root);
    const list = s.root.children.at(-1)?.children.find((el) => el.classes.includes('sigil-menu'));
    expect(list?.classes).toEqual(['sigil-menu', 'tinted']);
    expect(s.field.classes).not.toContain('tinted');
  });

  it('should open on Space, Up, Down and Alt-Down, and leave the value alone on Escape', async () => {
    const s = scene();
    s.input.focus.focus(s.field);
    for (const key of [KEYS.space, KEYS.up, KEYS.down, '\u001b\u001b[B']) {
      await s.term.press(key);
      picture(s.root);
      expect(picture(s.root).join('\n'), JSON.stringify(key)).toContain('debug');
      await escape(s.term);
      expect(picture(s.root).join('\n')).not.toContain('debug');
    }
    expect(s.value.get()).to.equal('info');
    expect(s.changes).toEqual([]);
  });

  it('should be at least as wide as the field, and the field no wider than its widest choice', async () => {
    const s = scene();
    s.input.focus.focus(s.field);
    await s.term.press(KEYS.enter);
    const lines = picture(s.root);
    // the field is eight columns of label and chrome; the list is the label column
    // and its own, which here is wider than the field
    expect(s.field.box?.width).to.equal(9);
    const top = lines[1] ?? '';
    expect(top.length - top.indexOf('╭')).to.be.at.least(9);
  });

  it('should pick the next choice a letter starts, without opening anything', async () => {
    const s = scene();
    s.input.focus.focus(s.field);
    await s.term.press('e');
    expect(s.value.get()).to.equal('error');
    await s.term.press('t');
    expect(s.value.get(), 'trace is disabled').to.equal('error');
    await s.term.press('d', 'i');
    expect(s.value.get()).to.equal('info');
    expect(s.changes).toEqual(['error', 'debug', 'info']);
    expect(picture(s.root).join('\n')).not.toContain('warn');
  });

  it('should open on a press, and pick what a click lands on', async () => {
    const s = scene();
    await s.term.press(...click(8, 0));
    expect(s.input.focus.current.get(), 'the press focused it').to.equal(s.field);
    const lines = picture(s.root);
    await s.term.press(...click(9, rowOf(lines, 'warn')));
    expect(s.value.get()).to.equal('warn');
  });

  it('should pick what a press dragged onto and released over', async () => {
    const s = scene();
    await s.term.press(press(8, 0));
    const lines = picture(s.root);
    const row = rowOf(lines, 'debug');
    await s.term.press(drag(9, row), release(9, row));
    expect(s.value.get()).to.equal('debug');
  });

  it('should show the placeholder, muted, for a value no choice has', () => {
    const s = scene({
      placeholder: 'pick a level',
      value: new State<string | undefined>(undefined),
    });
    expect(picture(s.root)[0]).to.equal('Level  pick a level ▾');
    expect(s.field.children[1]?.children[0]?.classes).toContain('sigil-muted');
  });

  it('should take an ampersand in a choice as an ampersand', async () => {
    const s = scene({ options: ['R&D', 'Ops'], value: new State<string | undefined>('R&D') });
    expect(picture(s.root)[0]).to.equal('Level  R&D ▾');
    s.input.focus.focus(s.field);
    await s.term.press(KEYS.enter);
    expect(picture(s.root).join('\n')).toContain('❯ R&D');
  });

  it('should stay one row tall in a row that has a height, and open under that row', async () => {
    const s = scene();
    const tall = createRoot((dispose) => {
      disposers.push(dispose);
      return Dropdown({ ascii: false, input: s.input, options: ['a', 'b'], value: 'a' });
    });
    s.root.append(box({ 'flex-direction': 'row', height: 4 }, tall));
    picture(s.root);
    expect(tall.box?.height).to.equal(1);
    s.input.focus.focus(tall);
    await s.term.press(KEYS.enter);
    const lines = picture(s.root);
    expect(lines[(tall.box?.y ?? 0) + 1]).toContain('╭');
  });

  it('should cut its label to a declared width', () => {
    const s = scene({ width: 7 });
    s.value.set('error');
    flush();
    expect(picture(s.root)[0]).to.equal('Level  er… ▾');
  });

  it('should refuse the focus and open nothing while disabled', async () => {
    const disabled = new State(true);
    const s = scene({ disabled });
    expect(s.field.focusable).to.equal(false);
    await s.term.press(...click(8, 0));
    expect(picture(s.root).join('\n')).not.toContain('debug');
    disabled.set(false);
    flush();
    expect(s.field.focusable).to.equal(true);
  });

  it('should open over a dialog it is in, and leave the dialog open on Escape', async () => {
    const s = scene();
    const inner = createRoot((dispose) => {
      disposers.push(dispose);
      return Dropdown({ input: s.input, options: ['a', 'b'], value: 'a' });
    });
    const dialog = openModal(s.root, { actions: [], body: inner, input: s.input });
    disposers.push(() => dialog.dispose());
    picture(s.root);
    expect(s.input.focus.current.get()).to.equal(inner);
    await s.term.press(KEYS.down);
    picture(s.root);
    await s.term.press(KEYS.down, KEYS.enter);
    expect(inner.children[1]?.children[0]?.text.trim()).to.equal('b');
    expect(dialog.open).to.equal(true);
    await s.term.press(KEYS.enter);
    picture(s.root);
    await escape(s.term);
    expect(dialog.open, 'the first Escape closed the list').to.equal(true);
    await escape(s.term);
    expect(dialog.open).to.equal(false);
  });

  it('should refuse what it cannot draw', () => {
    const s = scene();
    const base = { input: s.input, options: ['a'] };
    expect(() => Dropdown({ ...base, input: {} as never })).toThrow(/router/);
    expect(() => Dropdown({ ...base, options: 'a' as never })).toThrow(/array/);
    expect(() => Dropdown({ ...base, options: [{} as never] })).toThrow(/label/);
    // refused when built, not by the menu when a key opens it (which held the keys)
    expect(() => Dropdown({ ...base, options: ['', 'a'] })).toThrow(/label/);
    expect(() => Dropdown({ ...base, options: [{ label: '', value: 'x' }] })).toThrow(/label/);
    expect(() => Dropdown({ ...base, width: 4 })).toThrow(/width/);
    expect(() => Dropdown({ ...base, menuClass: {} as never })).toThrow(/menuClass/);
    expect(() => Dropdown({ ...base, disabled: 'yes' as never })).toThrow(/disabled/);
    expect(() => Dropdown({ ...base, props: { onKey: () => {} } as never })).toThrow(/onKey/);
  });
});
