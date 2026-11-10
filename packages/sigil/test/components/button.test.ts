import { Button, describeButton } from '../../src/components/button.js';
import { text } from '../../src/element/index.js';
import { ESCAPE_TIMEOUT } from '../../src/input/index.js';
import { flush, State } from '../../src/signals/index.js';
import { KEYS } from '../../src/testing/index.js';
import { clickOn, colored, ESC, form, part, picture, recorder, stopForms } from './form-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A button: what it draws with and without the focus, what presses it, what it
 * leaves for the form around it, and disabled.
 */

afterEach(stopForms);

/** A button that counts its presses. */
function counted(extra: Partial<Parameters<typeof Button>[0]> = {}) {
  const presses: number[] = [];
  const button = Button({ label: 'Save', onPress: () => presses.push(1), ...extra });
  return { button, presses };
}

describe('Button', () => {
  it('should draw its label padded, and bracketed in the padding while it has the focus', async () => {
    const { button } = counted();
    const f = form(button);
    expect(picture(f.root)).toEqual(['  Save']);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(button);
    expect(picture(f.root)).toEqual(['[ Save ]']);
    f.input.focus.focus(undefined);
    flush();
    expect(picture(f.root)).toEqual(['  Save']);
  });

  it('should put the focus role on the label and not on the brackets', () => {
    const { button } = counted();
    const f = form(button);
    f.input.focus.focus(button);
    expect(part(button, 'sigil-button-label').classes).toContain('sigil-focus');
    expect(part(button, 'sigil-button-bracket').classes).not.toContain('sigil-focus');
    // inverse on the four letters alone: the brackets either side are plain
    expect(colored(button)).toBe(`[ ${ESC}[7mSave${ESC}[27m ]`);
    f.input.focus.focus(undefined);
    expect(part(button, 'sigil-button-label').classes).not.toContain('sigil-focus');
  });

  it('should keep its width whether or not it has the focus', () => {
    const { button } = counted();
    const f = form(text('a'), button, text('b'));
    const before = picture(f.root);
    f.input.focus.focus(button);
    flush();
    expect(picture(f.root)[1]?.length).toBe('[ Save ]'.length);
    expect(before[1]?.trimEnd()).toBe('  Save');
  });

  it('should take escape sequences and line breaks out of its label', () => {
    const button = Button({ label: `${ESC}[31mSave\nall${ESC}[0m` });
    expect(picture(button)).toEqual(['  Save all']);
  });

  it('should keep the host class and an app class beside it', () => {
    const button = Button({ label: 'OK', props: { class: 'mine' } });
    expect(button.classes).toEqual(['mine', 'sigil-button']);
  });

  it('should refuse a label that is missing or blank, an onPress that is not a function, and a bad disabled', () => {
    expect(() => Button({ label: '' })).toThrow('Expected a button label to be a non-empty string');
    expect(() => Button({ label: '   ' })).toThrow('non-empty string');
    expect(() => Button({} as never)).toThrow('non-empty string');
    expect(() => Button({ label: 'x', onPress: 'go' as never })).toThrow(
      'Expected a button onPress to be a function'
    );
    expect(() => Button({ disabled: 'yes' as never, label: 'x' })).toThrow(
      'Expected button disabled to be a boolean or a State'
    );
  });

  it("should refuse a hook it sets itself in its props, rather than drop the caller's", () => {
    expect(() => Button({ label: 'x', props: { onKey: () => {} } as never })).toThrow(
      'Button sets onKey itself'
    );
  });
});

describe('pressing a button', () => {
  it('should press it on Enter and on Space, and keep both from the form', async () => {
    const { button, presses } = counted();
    const f = form(button);
    f.input.focus.focus(button);
    await f.press(KEYS.enter);
    await f.press(KEYS.space);
    expect(presses).toHaveLength(2);
    expect(f.seen).toEqual([]);
  });

  it('should press it on a left click, and leave the press for the focus', () => {
    const { button, presses } = counted();
    expect(clickOn(button, 'mousedown').claimed()).toBe(false);
    expect(presses).toHaveLength(0);
    // the click lands on the label, and is the button's on the way up
    expect(clickOn(part(button, 'sigil-button-label')).claimed()).toBe(true);
    expect(presses).toHaveLength(1);
  });

  it('should leave a right click and the wheel alone', () => {
    const { button, presses } = counted();
    expect(clickOn(button, 'click', 'right').claimed()).toBe(false);
    expect(clickOn(button, 'wheel', undefined as never).claimed()).toBe(false);
    expect(presses).toHaveLength(0);
  });

  it('should hand Tab, Escape, the arrows and a letter on to the form', async () => {
    const { button, presses } = counted();
    const other = text('next', { focusable: true });
    const f = form(button, other);
    f.input.focus.focus(button);
    await f.press(KEYS.left, KEYS.down, 'x', KEYS.escape);
    // a lone Escape is held until nothing follows it
    await new Promise((resolve) => setTimeout(resolve, ESCAPE_TIMEOUT + 30));
    expect(f.seen).toEqual(['left', 'down', 'x', 'escape']);
    // Tab is the ring's: it moves on, and pressed nothing on its way
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(other);
    expect(presses).toHaveLength(0);
  });

  it('should not read a pasted newline, or Enter with a modifier, as a press', async () => {
    const { button, presses } = counted();
    const f = form(button);
    f.input.focus.focus(button);
    await f.press(`${ESC}[200~a\r${ESC}[201~`);
    await f.press(`${ESC}\r`);
    expect(presses).toHaveLength(0);
  });

  it('should press with no onPress at all, and still claim the key', async () => {
    const button = Button({ label: 'Nothing' });
    const f = form(button);
    f.input.focus.focus(button);
    await f.press(KEYS.enter);
    expect(f.seen).toEqual([]);
  });
});

describe('a disabled button', () => {
  it('should be out of the ring, muted, and :disabled', async () => {
    const { button } = counted({ disabled: true });
    const other = text('next', { focusable: true });
    const f = form(button, other);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(other);
    expect(button.focusable).toBe(false);
    expect(button.classes).toEqual(expect.arrayContaining(['is-disabled', 'sigil-muted']));
    expect(button.states.includes('disabled')).toBe(true);
  });

  it('should ignore keys and clicks, which then go on to the form', async () => {
    const disabled = new State(false);
    const { button, presses } = counted({ disabled });
    const f = form(button);
    f.input.focus.focus(button);
    disabled.set(true);
    flush();
    // disabled while it has the focus: it keeps it, and does nothing with it
    expect(f.input.focus.current.get()).toBe(button);
    await f.press(KEYS.enter, KEYS.space);
    expect(clickOn(button).claimed()).toBe(false);
    expect(presses).toHaveLength(0);
    expect(f.seen).toEqual(['enter', 'space']);
  });

  it('should take keys again once the app enables it', async () => {
    const disabled = new State(true);
    const { button, presses } = counted({ disabled });
    const f = form(button);
    disabled.set(false);
    flush();
    expect(button.focusable).toBe(true);
    expect(button.states.includes('disabled')).toBe(false);
    f.input.focus.focus(button);
    await f.press(KEYS.enter);
    expect(presses).toHaveLength(1);
  });
});

describe('describeButton()', () => {
  it('should describe Enter and Space, scoped to the button', () => {
    const { live, router } = recorder();
    const { button } = counted();
    describeButton(router, button);
    expect(live.map((e) => `${e.keys} ${e.opts.description}`)).toEqual([
      'enter press',
      'space press',
    ]);
    expect(live.every((e) => e.opts.scope === button)).toBe(true);
  });

  it('should take every description back off', () => {
    const { live, router } = recorder();
    const off = describeButton(router, counted().button, counted().button);
    expect(live).toHaveLength(4);
    off();
    expect(live).toHaveLength(0);
  });

  it('should refuse an element that is not a button, describing nothing', () => {
    const { live, router } = recorder();
    expect(() => describeButton(router, counted().button, text('x'))).toThrow(
      'Expected an element that Button() returned'
    );
    expect(live).toHaveLength(0);
  });
});
