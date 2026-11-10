import { Checkbox, describeCheckbox } from '../../src/components/checkbox.js';
import { text } from '../../src/element/index.js';
import { flush, State } from '../../src/signals/index.js';
import { KEYS } from '../../src/testing/index.js';
import { clickOn, colored, ESC, form, part, picture, recorder, stopForms } from './form-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A checkbox: the box, the pointer that shows its focus, what ticks it, what it
 * leaves for the form around it, and disabled.
 */

afterEach(stopForms);

/** A checkbox that records what it told the app. */
function ticked(extra: Partial<Parameters<typeof Checkbox>[0]> = {}) {
  const told: boolean[] = [];
  const checkbox = Checkbox({
    label: 'Remember me',
    onChange: (value) => told.push(value),
    ...extra,
  });
  return { checkbox, told };
}

describe('Checkbox', () => {
  it('should draw the box and the label, after a blank the pointer keeps', () => {
    expect(picture(ticked().checkbox)).toEqual(['  [ ] Remember me']);
    expect(picture(ticked({ checked: true }).checkbox)).toEqual(['  [x] Remember me']);
  });

  it('should show the focus with the pointer, moving nothing, and the role on the label', async () => {
    const { checkbox } = ticked({ checked: true });
    const f = form(checkbox);
    await f.press(KEYS.tab);
    expect(picture(f.root)).toEqual(['❯ [x] Remember me']);
    expect(part(checkbox, 'sigil-checkbox-label').classes).toContain('sigil-focus');
    expect(part(checkbox, 'sigil-checkbox-mark').classes).not.toContain('sigil-focus');
    f.input.focus.focus(undefined);
    expect(picture(f.root)).toEqual(['  [x] Remember me']);
    expect(part(checkbox, 'sigil-checkbox-label').classes).not.toContain('sigil-focus');
  });

  it('should draw a ticked box in the accent and an empty one in no role', () => {
    // the colour is closed after the blank beside the box rather than before it,
    // since a blank shows no foreground and closing it there is one sequence fewer
    expect(colored(ticked({ checked: true }).checkbox)).toBe(
      `  ${ESC}[36m[x] ${ESC}[39mRemember me`
    );
    expect(colored(ticked().checkbox)).toBe('  [ ] Remember me');
  });

  it('should say whether it is ticked with a class and the :checked state', async () => {
    const { checkbox } = ticked();
    expect(checkbox.states).not.toContain('checked');
    const f = form(checkbox);
    f.input.focus.focus(checkbox);
    await f.press(KEYS.space);
    expect(checkbox.states).toContain('checked');
    expect(checkbox.classes).toContain('is-checked');
  });

  it('should hang a wrapped label under its own text', () => {
    const { checkbox } = ticked({ label: 'Email me a digest every week' });
    expect(picture(checkbox, 20)).toEqual(['  [ ] Email me a', '      digest every', '      week']);
  });

  it('should take a blank label, and put the focus role on the box', () => {
    const { checkbox } = ticked({ label: '' });
    expect(picture(checkbox)).toEqual(['  [ ]']);
    const f = form(checkbox);
    f.input.focus.focus(checkbox);
    expect(part(checkbox, 'sigil-checkbox-mark').classes).toContain('sigil-focus');
  });

  it('should refuse a label that is not a string, and a checked, disabled or onChange of the wrong kind', () => {
    expect(() => Checkbox({} as never)).toThrow('Expected a checkbox label to be a string');
    expect(() => Checkbox({ checked: 'yes' as never, label: 'x' })).toThrow(
      'Expected checkbox checked to be a boolean or a State'
    );
    expect(() => Checkbox({ disabled: 1 as never, label: 'x' })).toThrow(
      'Expected checkbox disabled to be a boolean or a State'
    );
    expect(() => Checkbox({ label: 'x', onChange: true as never })).toThrow(
      'Expected a checkbox onChange to be a function'
    );
  });
});

describe('ticking a checkbox', () => {
  it('should flip it on Space, tell the app each time, and keep Space from the form', async () => {
    const { checkbox, told } = ticked();
    const f = form(checkbox);
    f.input.focus.focus(checkbox);
    await f.press(KEYS.space);
    expect(picture(f.root)).toEqual(['❯ [x] Remember me']);
    await f.press(KEYS.space);
    expect(told).toEqual([true, false]);
    expect(f.seen).toEqual([]);
  });

  it('should leave Enter to the form, which is where a submit lives', async () => {
    const { checkbox, told } = ticked();
    const f = form(checkbox);
    f.input.focus.focus(checkbox);
    await f.press(KEYS.enter);
    expect(told).toEqual([]);
    expect(f.seen).toEqual(['enter']);
  });

  it('should leave Tab to the ring, and the arrows to the form', async () => {
    const { checkbox, told } = ticked();
    const other = text('next', { focusable: true });
    const f = form(checkbox, other);
    f.input.focus.focus(checkbox);
    await f.press(KEYS.left, KEYS.right, KEYS.up, KEYS.down);
    expect(f.seen).toEqual(['left', 'right', 'up', 'down']);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(other);
    expect(told).toEqual([]);
  });

  it('should not tick on a pasted space or a Space with a modifier', async () => {
    const { checkbox, told } = ticked();
    const f = form(checkbox);
    f.input.focus.focus(checkbox);
    await f.press(`${ESC}[200~ ${ESC}[201~`);
    await f.press(`${ESC} `);
    expect(told).toEqual([]);
  });

  it('should flip it on a left click anywhere on it, and leave the press for the focus', () => {
    const { checkbox, told } = ticked();
    expect(clickOn(checkbox, 'mousedown').claimed()).toBe(false);
    expect(clickOn(part(checkbox, 'sigil-checkbox-label')).claimed()).toBe(true);
    expect(clickOn(part(checkbox, 'sigil-checkbox-mark')).claimed()).toBe(true);
    expect(clickOn(checkbox, 'click', 'right').claimed()).toBe(false);
    expect(told).toEqual([true, false]);
  });
});

describe('a checkbox over a State', () => {
  it('should write the state when Space flips it', async () => {
    const checked = new State(false);
    const { checkbox } = ticked({ checked });
    const f = form(checkbox);
    f.input.focus.focus(checkbox);
    await f.press(KEYS.space);
    expect(checked.get()).toBe(true);
  });

  it('should redraw on a write the app made, and not tell the app about it', () => {
    const checked = new State(false);
    const { checkbox, told } = ticked({ checked });
    checked.set(true);
    flush();
    expect(picture(checkbox)).toEqual(['  [x] Remember me']);
    expect(told).toEqual([]);
  });
});

describe('a disabled checkbox', () => {
  it('should be out of the ring, muted and :disabled, and its value still drawn', async () => {
    const { checkbox } = ticked({ checked: true, disabled: true });
    const other = text('next', { focusable: true });
    const f = form(checkbox, other);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(other);
    expect(checkbox.classes).toEqual(expect.arrayContaining(['is-disabled', 'sigil-muted']));
    expect(checkbox.states).toContain('disabled');
    expect(picture(checkbox)).toEqual(['  [x] Remember me']);
  });

  it('should draw a ticked box without the accent while disabled, and give it back', () => {
    const disabled = new State(true);
    const { checkbox } = ticked({ checked: true, disabled });
    const mark = part(checkbox, 'sigil-checkbox-mark');
    expect(mark.text).toBe('[x]');
    expect(mark.classes).not.toContain('sigil-accent');
    disabled.set(false);
    flush();
    expect(mark.classes).toContain('sigil-accent');
  });

  it('should keep the focus it had, and ignore Space and clicks, which go on', async () => {
    const disabled = new State(false);
    const { checkbox, told } = ticked({ disabled });
    const f = form(checkbox);
    f.input.focus.focus(checkbox);
    disabled.set(true);
    flush();
    expect(f.input.focus.current.get()).toBe(checkbox);
    await f.press(KEYS.space);
    expect(clickOn(checkbox).claimed()).toBe(false);
    expect(told).toEqual([]);
    expect(f.seen).toEqual(['space']);
  });
});

describe('describeCheckbox()', () => {
  it('should describe Space, scoped to the checkbox', () => {
    const { live, router } = recorder();
    const { checkbox } = ticked();
    const off = describeCheckbox(router, checkbox);
    expect(live.map((e) => `${e.keys} ${e.opts.description}`)).toEqual(['space toggle']);
    expect(live[0]?.opts.scope).toBe(checkbox);
    off();
    expect(live).toHaveLength(0);
  });

  it('should refuse an element that is not a checkbox', () => {
    const { router } = recorder();
    expect(() => describeCheckbox(router, text('x'))).toThrow(
      'Expected an element that Checkbox() returned'
    );
  });
});
