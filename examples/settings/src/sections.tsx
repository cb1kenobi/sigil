/**
 * The four sections the sidebar switches between.
 *
 * Each is a component over the one settings form, and describes its own
 * controls' keys to the router, so the footer lists what the focused control
 * does. All four are built once and the three not showing are `display: none`,
 * which takes them out of the focus ring and keeps what is in them.
 */

import { AccountContext, type Settings } from './account.ts';
import { follow, type Form, touchOnLeave } from './form.ts';
import { openLogin } from './login.tsx';
import { Problem, Row } from './rows.tsx';
import { useApp } from '@ttylabs/sigil/app';
import { Button, describeButton } from '@ttylabs/sigil/components/button';
import { Checkbox, describeCheckbox } from '@ttylabs/sigil/components/checkbox';
import { describeRadioSet, RadioSet } from '@ttylabs/sigil/components/radio-set';
import { describeSlider, Slider } from '@ttylabs/sigil/components/slider';
import { describeSwitch, Switch } from '@ttylabs/sigil/components/switch';
import { TextField } from '@ttylabs/sigil/components/text-field';
import { showToast } from '@ttylabs/sigil/components/toast';
import type { Element } from '@ttylabs/sigil/element';
import type { InputRouter } from '@ttylabs/sigil/input';
import { getOwner, onCleanup, useContext } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';

/** The settings form every section edits. */
export type SettingsForm = Form<Settings>;

/** What a section is handed. */
export interface SectionProps {
  form: SettingsForm;
}

/**
 * The router, which every section describes its keys to. Always there under
 * `runApp()`, which refuses to call a component without a terminal to read keys
 * from -- typed as possibly missing for that.
 *
 * @returns The router.
 */
function router(): InputRouter {
  const { input } = useApp();
  if (input === undefined) {
    throw new Error('The settings screen needs keys: run it with runApp() on a terminal');
  }
  return input;
}

/**
 * Theme, text size, motion and density: a radio set, a slider, a switch and a
 * checkbox, one of each.
 *
 * @param props - The form.
 * @returns The section.
 */
export function Appearance({ form }: SectionProps): Element {
  const input = router();
  const { compact, reduceMotion, textSize, theme } = form.fields;

  const themes = RadioSet<Settings['theme']>({
    options: [
      { label: 'system', value: 'system' },
      { label: 'light', value: 'light' },
      { label: 'dark', value: 'dark' },
    ],
    value: theme.value,
  });
  // `indent` lines the track up with the marks of the controls around it, which
  // each keep a column for the `❯` that says which one has the focus
  const size = Slider({
    format: (pt) => `${pt} pt`,
    max: 24,
    min: 10,
    props: { class: 'indent' },
    value: textSize.value,
  });
  const motion = Switch({ value: reduceMotion.value });
  const density = Checkbox({ checked: compact.value, label: 'Compact rows' });

  onCleanup(describeRadioSet(input, themes));
  onCleanup(describeSlider(input, size));
  onCleanup(describeSwitch(input, motion));
  onCleanup(describeCheckbox(input, density));

  return (
    <box class="section">
      <text class="lede sigil-muted">How the app looks.</text>
      <Row label="Theme">{themes}</Row>
      <Row label="Text size">{size}</Row>
      <Row label="Less motion">{motion}</Row>
      <Row label="Density">{density}</Row>
    </box>
  );
}

/**
 * What to be told about: a switch that pauses everything, and checkboxes that are
 * disabled while it does.
 *
 * @param props - The form.
 * @returns The section.
 */
export function Notifications({ form }: SectionProps): Element {
  const input = router();
  const { digest, direct, mentions, pause, sms } = form.fields;

  const paused = Switch({ value: pause.value });
  // the pause switch's own state is what disables them: a `State<boolean>` is read
  // live, so they grey out and leave the ring the moment it flips
  const boxes = [
    Checkbox({ checked: mentions.value, disabled: pause.value, label: 'Mentions' }),
    Checkbox({ checked: direct.value, disabled: pause.value, label: 'Direct messages' }),
    Checkbox({ checked: digest.value, disabled: pause.value, label: 'Weekly digest' }),
    Checkbox({ checked: sms.value, disabled: pause.value, label: 'By SMS as well' }),
  ];

  onCleanup(describeSwitch(input, paused));
  onCleanup(describeCheckbox(input, ...boxes));

  return (
    <box class="section">
      <text class="lede sigil-muted">What to be told about.</text>
      <Row label="Pause all">{paused}</Row>
      <Row label="Notify me">{boxes}</Row>
    </box>
  );
}

/**
 * Three text fields, each with the line under it that says what is wrong.
 *
 * @param props - The form.
 * @returns The section.
 */
export function Profile({ form }: SectionProps): Element {
  const input = router();
  const { email, name, phone } = form.fields;

  const indent = { class: 'indent' };
  const nameField = TextField({ props: indent, value: name.value });
  const emailField = TextField({
    placeholder: 'name@example.com',
    props: indent,
    value: email.value,
  });
  const phoneField = TextField({ placeholder: 'only for SMS', props: indent, value: phone.value });
  touchOnLeave(
    input.focus.current,
    form,
    new Map<Element, keyof Settings>([
      [nameField, 'name'],
      [emailField, 'email'],
      [phoneField, 'phone'],
    ])
  );

  return (
    <box class="section">
      <text class="lede sigil-muted">Who you are to everyone else.</text>
      <Row label="Name">{nameField}</Row>
      <Problem field={name} />
      <Row label="Email">{emailField}</Row>
      <Problem field={email} />
      <Row label="Phone">{phoneField}</Row>
      <Problem field={phone} />
    </box>
  );
}

/**
 * Signing in and out, which is the session's rather than a setting: it happens
 * at once and is not saved, so it is not in the form.
 *
 * @returns The section.
 */
export function Session(): Element {
  const app = useApp();
  const input = router();
  const account = useContext(AccountContext);
  // the dialog is opened from a key handler, which has no owner, so it borrows
  // this component's
  const owner = getOwner();
  const user = new State<string | undefined>(undefined);

  const signIn = Button({
    disabled: follow(() => user.get() !== undefined),
    label: 'Sign in...',
    onPress: () => {
      const dialog = openLogin({ account, host: app.view, input, owner });
      void dialog.result.then((name) => {
        if (name === undefined) {
          return;
        }
        user.set(name);
        // the button that opened the dialog has the focus back, and is about to
        // be disabled: the next thing to do here is the other one
        input.focus.focus(signOut);
        showToast(app.view, { message: `Signed in as ${name}`, variant: 'success' });
      });
    },
  });
  const signOut = Button({
    disabled: follow(() => user.get() === undefined),
    label: 'Sign out',
    onPress: () => {
      user.set(undefined);
      input.focus.focus(signIn);
      showToast(app.view, { message: 'Signed out', variant: 'info' });
    },
  });

  onCleanup(describeButton(input, signIn, signOut));

  return (
    <box class="section">
      <text class="lede sigil-muted">Your session on this machine.</text>
      <Row label="Account">
        <text>{() => user.get() ?? 'not signed in'}</text>
      </Row>
      <box class="buttons">
        {signIn}
        {signOut}
      </box>
    </box>
  );
}
