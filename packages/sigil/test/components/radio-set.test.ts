import { describeRadioSet, RadioSet } from '../../src/components/radio-set.js';
import { type Element, text } from '../../src/element/index.js';
import { flush, State } from '../../src/signals/index.js';
import { KEYS } from '../../src/testing/index.js';
import { clickOn, form, picture, recorder, stopForms } from './form-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * A radio set: one stop in the ring, the arrows selecting inside it, a disabled
 * option stepped over, Space and a click, what it leaves for the form, and the
 * value as a state.
 */

afterEach(stopForms);

const LEVELS = ['debug', 'info', { disabled: 'needs a debug build', label: 'trace' }, 'warn'];

/** A radio set over the log levels, recording what it told the app. */
function levels(extra: Partial<Parameters<typeof RadioSet<string>>[0]> = {}) {
  const told: string[] = [];
  const set = RadioSet<string>({
    onChange: (value) => told.push(value),
    options: LEVELS,
    ...extra,
  });
  return { set, told };
}

/** The option rows of a set. */
const rows = (set: Element): readonly Element[] => set.children;

describe('RadioSet', () => {
  it('should draw one option a line, the selected one marked, a disabled one with its reason', () => {
    expect(picture(levels({ value: 'info' }).set)).toEqual([
      '  ◯ debug',
      '  ◉ info',
      '  ◯ trace needs a debug build',
      '  ◯ warn',
    ]);
  });

  it('should say a disabled option is disabled when it gives no reason, and draw a hint', () => {
    const set = RadioSet({
      options: [
        { label: 'a', disabled: true },
        { label: 'b', hint: '(default)' },
      ],
    });
    expect(picture(set)).toEqual(['  ◯ a disabled', '  ◯ b (default)']);
  });

  it('should draw its options in a row when asked to', () => {
    const { set } = levels({ direction: 'row', options: ['S', 'M', 'L'], value: 'M' });
    expect(picture(set)).toEqual(['  ◯ S    ◉ M    ◯ L']);
  });

  it('should mark the selected option with the accent, a class and :checked, and a disabled one muted', () => {
    const { set } = levels({ value: 'info' });
    const [debug, info, trace] = rows(set) as [Element, Element, Element];
    expect(info.classes).toContain('is-selected');
    expect(info.states).toContain('checked');
    expect(info.children[1]?.classes).toContain('sigil-accent');
    expect(debug.states).not.toContain('checked');
    expect(trace.classes).toContain('is-disabled');
    expect(trace.states).toContain('disabled');
    expect(trace.children[2]?.classes).toContain('sigil-muted');
  });

  it('should select nothing for a value no option holds', () => {
    expect(picture(levels({ value: 'fatal' }).set).join('\n')).not.toContain('◉');
  });

  it('should compare values the way a Map compares keys', () => {
    const set = RadioSet({ options: [{ label: 'none', value: Number.NaN }], value: Number.NaN });
    expect(picture(set)).toEqual(['  ◉ none']);
  });

  it('should refuse no options, an option with no label, two with one value, and a bad direction', () => {
    expect(() => RadioSet({ options: [] })).toThrow(
      'Expected radio set options to be a non-empty array'
    );
    expect(() => RadioSet({ options: [{} as never] })).toThrow(
      'Expected every radio option to be a string or have a label'
    );
    expect(() => RadioSet({ options: ['a', { label: 'A', value: 'a' }] })).toThrow(
      'Expected every radio option to have a different value'
    );
    expect(() => RadioSet({ direction: 'grid' as never, options: ['a'] })).toThrow(
      'Expected a radio set direction to be column or row'
    );
    expect(() => RadioSet({ disabled: 'no' as never, options: ['a'] })).toThrow(
      'Expected radio set disabled to be a boolean or a State'
    );
  });
});

describe('the focus on a radio set', () => {
  it('should be one stop in the ring, however many options it has', async () => {
    const before = text('before', { focusable: true });
    const after = text('after', { focusable: true });
    const { set } = levels();
    const f = form(before, set, after);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(before);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(set);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(after);
  });

  it('should show the pointer and the role on the selected option while it has the focus', () => {
    const { set } = levels({ value: 'warn' });
    const f = form(set);
    f.input.focus.focus(set);
    expect(picture(f.root)).toEqual([
      '  ◯ debug',
      '  ◯ info',
      '  ◯ trace needs a debug build',
      '❯ ◉ warn',
    ]);
    const label = (rows(set)[3] as Element).children[2] as Element;
    expect(label.classes).toContain('sigil-focus');
    f.input.focus.focus(undefined);
    expect(label.classes).not.toContain('sigil-focus');
    expect(picture(f.root)[3]).toBe('  ◉ warn');
  });

  it('should show it on the first option on offer when nothing is selected', () => {
    const { set } = levels({ options: [{ disabled: true, label: 'x' }, 'y', 'z'] });
    const f = form(set);
    f.input.focus.focus(set);
    expect(picture(f.root)).toEqual(['  ◯ x disabled', '❯ ◯ y', '  ◯ z']);
  });
});

describe('the keys on a radio set', () => {
  it('should select the next and previous option with Down and Up, straight away', async () => {
    const { set, told } = levels({ value: 'debug' });
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.down);
    expect(picture(f.root)[1]).toBe('❯ ◉ info');
    await f.press(KEYS.up);
    expect(told).toEqual(['info', 'debug']);
    expect(f.seen).toEqual([]);
  });

  it('should step over a disabled option', async () => {
    const { set, told } = levels({ value: 'info' });
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.down);
    expect(told).toEqual(['warn']);
    await f.press(KEYS.up);
    expect(told).toEqual(['warn', 'info']);
  });

  it('should take Left and Right as well, whichever way it runs', async () => {
    const { set, told } = levels({ value: 'debug' });
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.right, KEYS.left);
    expect(told).toEqual(['info', 'debug']);
  });

  it('should go to the first and last option on offer with Home and End', async () => {
    const { set, told } = levels({
      options: [{ disabled: true, label: 'a' }, 'b', 'c', { disabled: true, label: 'd' }],
      value: 'b',
    });
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.end, KEYS.home);
    expect(told).toEqual(['c', 'b']);
  });

  it('should leave an arrow, Home or End that would select nothing new to the form', async () => {
    const { set, told } = levels({ value: 'debug' });
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.up, KEYS.left, KEYS.home);
    await f.press(KEYS.end, KEYS.down, KEYS.right);
    expect(told).toEqual(['warn']);
    expect(f.seen).toEqual(['up', 'left', 'home', 'down', 'right']);
  });

  it('should select the highlighted option on Space when nothing was selected, and claim Space either way', async () => {
    const { set, told } = levels();
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.space);
    expect(told).toEqual(['debug']);
    await f.press(KEYS.space);
    expect(told).toEqual(['debug']);
    expect(f.seen).toEqual([]);
  });

  it('should step from the highlighted option when nothing was selected', async () => {
    const { set, told } = levels();
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.down);
    expect(told).toEqual(['info']);
  });

  it('should leave Enter to the form and Tab to the ring', async () => {
    const after = text('after', { focusable: true });
    const { set, told } = levels({ value: 'info' });
    const f = form(set, after);
    f.input.focus.focus(set);
    await f.press(KEYS.enter);
    expect(f.seen).toEqual(['enter']);
    await f.press(KEYS.tab);
    expect(f.input.focus.current.get()).toBe(after);
    expect(told).toEqual([]);
  });

  it('should leave a pasted space and an arrow with a modifier alone', async () => {
    const { set, told } = levels({ value: 'info' });
    const f = form(set);
    f.input.focus.focus(set);
    await f.press('\u001b[200~ \u001b[201~', '\u001b[1;5B');
    expect(told).toEqual([]);
  });
});

describe('the mouse on a radio set', () => {
  it('should select the option that was clicked, and leave the press for the focus', () => {
    const { set, told } = levels();
    const warn = rows(set)[3] as Element;
    expect(clickOn(warn.children[2] as Element, 'mousedown').claimed()).toBe(false);
    expect(clickOn(warn.children[2] as Element).claimed()).toBe(true);
    expect(told).toEqual(['warn']);
  });

  it('should do nothing for a click on a disabled option, or a right click', () => {
    const { set, told } = levels();
    expect(clickOn(rows(set)[2] as Element).claimed()).toBe(false);
    expect(clickOn(rows(set)[0] as Element, 'click', 'right').claimed()).toBe(false);
    expect(told).toEqual([]);
  });
});

describe('a radio set over a State', () => {
  it('should write the state, and follow a write the app made without telling it', async () => {
    const value = new State<string | undefined>('debug');
    const { set, told } = levels({ value });
    const f = form(set);
    f.input.focus.focus(set);
    await f.press(KEYS.down);
    expect(value.get()).toBe('info');
    value.set('warn');
    flush();
    // the pointer follows the selection, and the next arrow starts from it
    expect(picture(f.root)[3]).toBe('❯ ◉ warn');
    await f.press(KEYS.up);
    expect(told).toEqual(['info', 'info']);
    value.set(undefined);
    flush();
    expect(picture(f.root).join('\n')).not.toContain('◉');
  });
});

describe('a disabled radio set', () => {
  it('should be out of the ring, and ignore keys and clicks, keeping a focus it already had', async () => {
    const disabled = new State(false);
    const { set, told } = levels({ disabled, value: 'debug' });
    const f = form(set);
    f.input.focus.focus(set);
    disabled.set(true);
    flush();
    expect(set.focusable).toBe(false);
    expect(set.classes).toEqual(expect.arrayContaining(['is-disabled', 'sigil-muted']));
    expect(f.input.focus.current.get()).toBe(set);
    await f.press(KEYS.down, KEYS.space);
    expect(clickOn(rows(set)[1] as Element).claimed()).toBe(false);
    expect(told).toEqual([]);
    expect(f.seen).toEqual(['down', 'space']);
  });

  it('should be disabled when every option is, since nothing in it can be chosen', () => {
    const set = RadioSet({ options: [{ disabled: true, label: 'a' }] });
    expect(set.focusable).toBe(false);
    expect(set.classes).toContain('is-disabled');
  });
});

describe('describeRadioSet()', () => {
  it('should describe the arrows along a column, and Space', () => {
    const { live, router } = recorder();
    const { set } = levels();
    const off = describeRadioSet(router, set);
    expect(live.map((e) => `${e.keys} ${e.opts.description}`)).toEqual([
      'up previous',
      'down next',
      'space select',
    ]);
    expect(live.every((e) => e.opts.scope === set)).toBe(true);
    off();
    expect(live).toHaveLength(0);
  });

  it('should describe the arrows along a row', () => {
    const { live, router } = recorder();
    describeRadioSet(router, levels({ direction: 'row' }).set);
    expect(live.map((e) => e.keys)).toEqual(['left', 'right', 'space']);
  });

  it('should refuse an element that is not a radio set', () => {
    const { router } = recorder();
    expect(() => describeRadioSet(router, text('x'))).toThrow(
      'Expected an element that RadioSet() returned'
    );
  });
});
