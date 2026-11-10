import { Button, describeButton } from '../../src/components/button.js';
import { Checkbox, describeCheckbox } from '../../src/components/checkbox.js';
import { controlFlag } from '../../src/components/control.js';
import { describeRadioSet, RadioSet } from '../../src/components/radio-set.js';
import { describeSwitch, Switch } from '../../src/components/switch.js';
import { State } from '../../src/signals/index.js';
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
