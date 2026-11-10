import { describeSwitch, Switch } from '../../src/components/switch.js';
import { type Element, text } from '../../src/element/index.js';
import { flush, State } from '../../src/signals/index.js';
import { KEYS } from '../../src/testing/index.js';
import { clickOn, form, part, picture, recorder, stopForms } from './form-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A switch: its two named states, the keys that move it and the ones it leaves,
 * a click on a state, the focus with and without a label, and disabled.
 */

afterEach(stopForms);

/** A switch that records what it told the app. */
function switched(extra: Partial<Parameters<typeof Switch>[0]> = {}) {
  const told: boolean[] = [];
  const control = Switch({
    label: 'Notifications',
    onChange: (value) => told.push(value),
    ...extra,
  });
  return { control, told };
}

/** The element drawing one of a switch's two states, `0` for the inactive one. */
const stateOf = (control: Element, i: 0 | 1): Element =>
  control.children.filter((child) => child.classes.includes('sigil-switch-state'))[i] as Element;

describe('Switch', () => {
  it('should draw its label and both states, the inactive one first, as toggle() does', () => {
    expect(picture(switched().control)).toEqual(['  Notifications  ◉ off  ◯ on']);
    expect(picture(switched({ value: true }).control)).toEqual(['  Notifications  ◯ off  ◉ on']);
  });

  it('should take names for its states', () => {
    const { control } = switched({ active: 'dark', inactive: 'light', label: 'Theme' });
    expect(picture(control)).toEqual(['  Theme  ◉ light  ◯ dark']);
  });

  it('should put the current state in the accent and the other muted', () => {
    const { control } = switched({ value: true });
    expect(part(control, 'is-active').text).toBe('◉ on');
    expect(part(control, 'is-active').classes).toContain('sigil-accent');
    expect(stateOf(control, 0).text).toBe('◯ off');
    expect(stateOf(control, 0).classes).toContain('sigil-muted');
    expect(control.states).toContain('checked');
  });

  it('should show the focus with the pointer and the role on the label', async () => {
    const { control } = switched();
    const f = form(control);
    await f.press(KEYS.tab);
    expect(picture(f.root)).toEqual(['❯ Notifications  ◉ off  ◯ on']);
    expect(part(control, 'sigil-switch-label').classes).toContain('sigil-focus');
    expect(part(control, 'is-active').classes).not.toContain('sigil-focus');
    // and the state it moves to does not take the role over from the label
    await f.press(KEYS.right);
    expect(part(control, 'is-active').classes).not.toContain('sigil-focus');
  });

  it('should put the role on the current state when it has no label, and move it with the state', async () => {
    const { control } = switched({ label: undefined });
    const f = form(control);
    expect(picture(f.root)).toEqual(['  ◉ off  ◯ on']);
    f.input.focus.focus(control);
    expect(stateOf(control, 0).classes).toContain('sigil-focus');
    await f.press(KEYS.right);
    expect(stateOf(control, 0).classes).not.toContain('sigil-focus');
    expect(stateOf(control, 1).classes).toContain('sigil-focus');
    f.input.focus.focus(undefined);
    expect(stateOf(control, 1).classes).not.toContain('sigil-focus');
  });

  it('should refuse a blank state name, two states with one name, and a value of the wrong kind', () => {
    expect(() => Switch({ active: ' ' })).toThrow(
      'Expected a switch state name to be a non-empty string'
    );
    expect(() => Switch({ active: 'on', inactive: ' on ' })).toThrow(
      "Expected a switch's two states to have different names"
    );
    expect(() => Switch({ value: 'on' as never })).toThrow(
      'Expected switch value to be a boolean or a State'
    );
    expect(() => Switch({ label: 3 as never })).toThrow('Expected a switch label to be a string');
    expect(() => Switch({ disabled: {} as never })).toThrow(
      'Expected switch disabled to be a boolean or a State'
    );
  });
});

describe('the keys on a switch', () => {
  it('should go to a state with each arrow, and leave an arrow that changes nothing to the form', async () => {
    const { control, told } = switched();
    const f = form(control);
    f.input.focus.focus(control);
    await f.press(KEYS.left);
    await f.press(KEYS.right);
    await f.press(KEYS.right);
    await f.press(KEYS.left);
    expect(told).toEqual([true, false]);
    // Left on off, and Right on on, are not the switch's
    expect(f.seen).toEqual(['left', 'right']);
  });

  it('should flip on Space', async () => {
    const { control, told } = switched();
    const f = form(control);
    f.input.focus.focus(control);
    await f.press(KEYS.space, KEYS.space);
    expect(told).toEqual([true, false]);
    expect(f.seen).toEqual([]);
  });

  it('should leave Tab to the ring, which toggle() does not, and Enter to the form', async () => {
    const { control, told } = switched();
    const other = text('next', { focusable: true });
    const f = form(control, other);
    f.input.focus.focus(control);
    await f.press(KEYS.enter, KEYS.up, KEYS.down);
    expect(f.seen).toEqual(['enter', 'up', 'down']);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(other);
    expect(told).toEqual([]);
  });

  it('should leave a pasted space, and an arrow with a modifier, alone', async () => {
    const { control, told } = switched();
    const f = form(control);
    f.input.focus.focus(control);
    await f.press('\u001b[200~ \u001b[201~', '\u001b[1;5C');
    expect(told).toEqual([]);
  });
});

describe('the mouse on a switch', () => {
  it('should pick the state that was clicked, and do nothing for the one it is in', () => {
    const { control, told } = switched();
    // off already: a click on `off` is claimed and changes nothing
    expect(clickOn(stateOf(control, 0)).claimed()).toBe(true);
    expect(told).toEqual([]);
    expect(clickOn(stateOf(control, 1)).claimed()).toBe(true);
    expect(clickOn(stateOf(control, 1)).claimed()).toBe(true);
    expect(told).toEqual([true]);
    clickOn(stateOf(control, 0));
    expect(told).toEqual([true, false]);
  });

  it('should flip on a click on its label, and leave the press for the focus', () => {
    const { control, told } = switched();
    expect(clickOn(part(control, 'sigil-switch-label'), 'mousedown').claimed()).toBe(false);
    expect(clickOn(part(control, 'sigil-switch-label')).claimed()).toBe(true);
    expect(clickOn(control).claimed()).toBe(true);
    expect(clickOn(control, 'click', 'right').claimed()).toBe(false);
    expect(told).toEqual([true, false]);
  });
});

describe('a switch over a State', () => {
  it('should write the state, and redraw without telling the app on a write it made', async () => {
    const value = new State(false);
    const { control, told } = switched({ value });
    const f = form(control);
    f.input.focus.focus(control);
    await f.press(KEYS.right);
    expect(value.get()).toBe(true);
    value.set(false);
    flush();
    expect(picture(control)).toEqual(['❯ Notifications  ◉ off  ◯ on']);
    expect(told).toEqual([true]);
  });
});

describe('a disabled switch', () => {
  it('should be out of the ring, and ignore keys and clicks, keeping a focus it already had', async () => {
    const disabled = new State(false);
    const { control, told } = switched({ disabled });
    const f = form(control);
    f.input.focus.focus(control);
    disabled.set(true);
    flush();
    expect(control.focusable).toBe(false);
    expect(control.classes).toEqual(expect.arrayContaining(['is-disabled', 'sigil-muted']));
    expect(f.input.focus.current.get()).toBe(control);
    await f.press(KEYS.right, KEYS.space);
    expect(clickOn(stateOf(control, 1)).claimed()).toBe(false);
    expect(clickOn(control).claimed()).toBe(false);
    expect(told).toEqual([]);
    expect(f.seen).toEqual(['right', 'space']);
  });

  it('should draw the current state without the accent while disabled, and give it back', () => {
    const disabled = new State(true);
    const { control } = switched({ disabled, value: true });
    expect(part(control, 'is-active').classes).not.toContain('sigil-accent');
    disabled.set(false);
    flush();
    expect(part(control, 'is-active').classes).toContain('sigil-accent');
  });
});

describe('describeSwitch()', () => {
  it('should describe Space, and each arrow by the name of the state it picks', () => {
    const { live, router } = recorder();
    const { control } = switched({ active: 'dark', inactive: 'light' });
    const off = describeSwitch(router, control);
    expect(live.map((e) => `${e.keys} ${e.opts.description}`)).toEqual([
      'space toggle',
      'left light',
      'right dark',
    ]);
    expect(live.every((e) => e.opts.scope === control)).toBe(true);
    off();
    expect(live).toHaveLength(0);
  });

  it('should refuse an element that is not a switch', () => {
    const { router } = recorder();
    expect(() => describeSwitch(router, text('x'))).toThrow(
      'Expected an element that Switch() returned'
    );
  });
});
