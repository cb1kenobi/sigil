import { Button, describeButton } from '../../src/components/button.js';
import { Checkbox, describeCheckbox } from '../../src/components/checkbox.js';
import { controlCondition, controlFlag, controlState } from '../../src/components/control.js';
import { describeRadioSet, RadioSet } from '../../src/components/radio-set.js';
import { describeSwitch, Switch } from '../../src/components/switch.js';
import { Computed, effect, flush, State } from '../../src/signals/index.js';
import { KEYS } from '../../src/testing/index.js';
import { form, picture, stopForms } from './form-harness.js';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * The four controls together, which is how they are used: a settings form, with
 * a router over it and an Enter handler of the form's own.
 *
 * The per-control files say what each does; this one says what holds across them
 * -- one Tab per control, a disabled one skipped, Enter the form's everywhere but
 * on a button, and a key-help footer that changes with the focus.
 */

afterEach(stopForms);

/** A settings form, whose Enter handler records a submit. */
function settings() {
  const submits: string[] = [];
  const pressed: string[] = [];
  const digest = Checkbox({ checked: true, label: 'Weekly digest' });
  const notify = Switch({ label: 'Notify' });
  const level = RadioSet({
    direction: 'row',
    options: ['quiet', 'normal', 'loud'],
    value: 'normal',
  });
  const reset = Button({ disabled: true, label: 'Reset', onPress: () => pressed.push('reset') });
  const save = Button({ label: 'Save', onPress: () => pressed.push('save') });
  const f = form(digest, notify, level, reset, save);
  const own = f.root.onKey;
  f.root.onKey = (event) => {
    own?.(event);
    if (event.key.name === 'enter') {
      submits.push('submit');
    }
  };
  return { digest, f, level, notify, pressed, reset, save, submits };
}

describe('a form of the four', () => {
  it('should draw each on a line of its own, the focus moving nothing', async () => {
    const { f } = settings();
    const at = picture(f.root);
    expect(at).toEqual([
      '  [x] Weekly digest',
      '  Notify  ◉ off  ◯ on',
      '  ◯ quiet    ◉ normal    ◯ loud',
      '  Reset',
      '  Save',
    ]);
    await f.press(KEYS.tab);
    expect(picture(f.root).map((line) => line.length)).toEqual(at.map((line) => line.length));
  });

  it('should stop once on each control, and not on the disabled one', async () => {
    const { digest, f, level, notify, save } = settings();
    const stops: unknown[] = [];
    for (let i = 0; i < 5; i++) {
      await f.press(KEYS.tab);
      stops.push(f.input.focus.current.get());
    }
    expect(stops).toEqual([digest, notify, level, save, digest]);
  });

  it('should hand Enter to the form from every control but a button, which it presses', async () => {
    const { digest, f, level, notify, pressed, save, submits } = settings();
    for (const control of [digest, notify, level]) {
      f.input.focus.focus(control);
      await f.press(KEYS.enter);
    }
    expect(submits).toHaveLength(3);
    f.input.focus.focus(save);
    await f.press(KEYS.enter);
    expect(submits).toHaveLength(3);
    expect(pressed).toEqual(['save']);
  });

  it('should list the focused control’s keys in a footer, and only that one’s', () => {
    const { digest, f, level, notify, save } = settings();
    describeCheckbox(f.input, digest);
    describeSwitch(f.input, notify);
    describeRadioSet(f.input, level);
    describeButton(f.input, save);
    const footer = () => f.input.bindings().map((b) => `${b.keys} ${b.description}`);

    f.input.focus.focus(digest);
    expect(footer()).toEqual(['space toggle']);
    f.input.focus.focus(notify);
    expect(footer()).toEqual(['space toggle', 'left off', 'right on']);
    f.input.focus.focus(level);
    expect(footer()).toEqual(['left previous', 'right next', 'space select']);
    f.input.focus.focus(save);
    expect(footer()).toEqual(['enter press', 'space press']);
  });
});

describe('controlFlag()', () => {
  it('should hand back a State it was given, and make one of a boolean or of nothing', () => {
    const mine = new State(true);
    expect(controlFlag(mine, 'x')).toBe(mine);
    expect(controlFlag(true, 'x').get()).toBe(true);
    expect(controlFlag(undefined, 'x').get()).toBe(false);
  });

  it('should refuse anything else with the message it was given, a truthy string above all', () => {
    expect(() => controlFlag('true', 'no strings')).toThrow(TypeError);
    expect(() => controlFlag('true', 'no strings')).toThrow('no strings');
    expect(() => controlFlag(1, 'no numbers')).toThrow('no numbers');
  });
});

describe('controlState()', () => {
  it('should hand back a State it was given, and make one of anything else', () => {
    const mine = new State<string | undefined>('info');
    expect(controlState(mine, 'x')).toBe(mine);
    expect(controlState('info', 'x').get()).toBe('info');
    expect(controlState(undefined, 'x').get()).toBeUndefined();
    // the app's own value may have a get of its own, and it is still a value
    const node = { get: () => 'mine' };
    expect(controlState<typeof node>(node, 'x').get()).toBe(node);
  });

  it('should refuse a Computed with the message it was given, since it cannot be written', () => {
    const level = new State('info');
    const derived = new Computed(() => level.get());
    expect(() => controlState(derived, 'no computed')).toThrow(TypeError);
    expect(() => controlState(derived, 'no computed')).toThrow('no computed');
  });
});

describe('controlCondition()', () => {
  it('should read a State, a Computed, anything with get() and a function, live', () => {
    const on = new State(false);
    const shapes = [on, new Computed(() => on.get()), { get: () => on.get() }, () => on.get()];
    const read = shapes.map((shape) => controlCondition(shape, 'x'));
    expect(read.map((flag) => flag.get())).toEqual([false, false, false, false]);
    on.set(true);
    expect(read.map((flag) => flag.get())).toEqual([true, true, true, true]);
  });

  it('should be tracked where it is read, so an effect follows what the condition reads', () => {
    const valid = new State(false);
    const flag = controlCondition(() => !valid.get(), 'x');
    const seen: boolean[] = [];
    const stop = effect(() => {
      seen.push(flag.get());
    });
    valid.set(true);
    flush();
    stop();
    expect(seen).toEqual([true, false]);
  });

  it('should ask again on every read, so a reader that touches no signal is not cached', () => {
    // a `Computed` around these would answer from its cache: neither reads a signal,
    // so nothing would ever tell it to look again
    let ready = false;
    const box = {
      on: false,
      get(): boolean {
        return this.on;
      },
    };
    const byFunction = controlCondition(() => ready, 'x');
    const byGet = controlCondition(box, 'x');
    expect([byFunction.get(), byGet.get()]).toEqual([false, false]);
    ready = true;
    box.on = true;
    expect([byFunction.get(), byGet.get()]).toEqual([true, true]);
  });

  it('should make a boolean or nothing a fixed answer', () => {
    expect(controlCondition(true, 'x').get()).toBe(true);
    expect(controlCondition(false, 'x').get()).toBe(false);
    expect(controlCondition(undefined, 'x').get()).toBe(false);
  });

  it('should read a reading for its truth, so the drawing and the keys agree about it', () => {
    // `toggleClass(name, undefined)` flips the class, so an `undefined` reaching the
    // effect would draw a control disabled that every handler treats as enabled
    expect(controlCondition(() => undefined, 'x').get()).toBe(false);
    expect(controlCondition({ get: () => 'yes' }, 'x').get()).toBe(true);
  });

  it('should refuse anything else with the message it was given', () => {
    expect(() => controlCondition('true', 'no strings')).toThrow(TypeError);
    expect(() => controlCondition('true', 'no strings')).toThrow('no strings');
    expect(() => controlCondition(1, 'no numbers')).toThrow('no numbers');
    expect(() => controlCondition(null, 'no null')).toThrow('no null');
    expect(() => controlCondition({ get: true }, 'no get')).toThrow('no get');
  });
});
