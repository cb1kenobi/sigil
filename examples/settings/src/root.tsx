/**
 * The settings screen: sections in a sidebar, the section's controls beside it,
 * and Save and Cancel under both.
 *
 * Written in JSX, so `sigil build` compiles it and an editor checks every prop.
 * `App` is the whole screen, mounted by `runApp()`: `src/index.ts` runs it on the
 * real terminal, and the tests run it over a fake one with a fake account behind
 * `AccountContext`.
 *
 * The form is one `createForm()` over every setting, so what is saved, what has
 * changed and what is wrong are each one signal the whole screen reads: the
 * sidebar marks a section with a change or a problem in it, the bar under the
 * sections says what stops a save, and Save and Cancel are disabled until there
 * is something for them to do. `examples/AGENTS.md` has the reasons, under "A
 * settings screen".
 */

import { AccountContext, type Settings } from './account.ts';
import { SETTINGS_CHECKS } from './checks.ts';
import { createForm, follow } from './form.ts';
import { Appearance, Notifications, Profile, Session } from './sections.tsx';
import { useApp } from '@ttylabs/sigil/app';
import { Button, describeButton } from '@ttylabs/sigil/components/button';
import { keyHelp } from '@ttylabs/sigil/components/key-help';
import { describeListView, ListView } from '@ttylabs/sigil/components/list-view';
import { unicodeSupported } from '@ttylabs/sigil/components/note';
import { Panel } from '@ttylabs/sigil/components/panel';
import { showToast } from '@ttylabs/sigil/components/toast';
import type { Element } from '@ttylabs/sigil/element';
import type { KeyEvent } from '@ttylabs/sigil/input';
import { onCleanup, onMount, useContext } from '@ttylabs/sigil/renderer';
import { State } from '@ttylabs/sigil/signals';

/** One entry in the sidebar. */
interface Section {
  /** The settings it edits, which is what its mark in the sidebar is about. */
  readonly fields: readonly (keyof Settings)[];
  readonly id: 'account' | 'appearance' | 'notifications' | 'profile';
  readonly label: string;
}

/**
 * The sections, in the order the sidebar lists them.
 *
 * Appearance is first, so the screen opens on controls rather than on text
 * fields: a field keeps the `q` typed into it, and the examples' smoke test
 * quits with `q` after four Tabs from the sidebar.
 */
export const SECTIONS: readonly Section[] = [
  {
    fields: ['theme', 'textSize', 'reduceMotion', 'compact'],
    id: 'appearance',
    label: 'Appearance',
  },
  {
    fields: ['pause', 'mentions', 'direct', 'digest', 'sms'],
    id: 'notifications',
    label: 'Notifications',
  },
  { fields: ['name', 'email', 'phone'], id: 'profile', label: 'Profile' },
  { fields: [], id: 'account', label: 'Account' },
];

/** What each setting is called where the bar names one with a problem. */
const NAMES: Readonly<Record<keyof Settings, string>> = {
  compact: 'Density',
  digest: 'Weekly digest',
  direct: 'Direct messages',
  email: 'Email',
  mentions: 'Mentions',
  name: 'Name',
  pause: 'Pause all',
  phone: 'Phone',
  reduceMotion: 'Less motion',
  sms: 'SMS',
  textSize: 'Text size',
  theme: 'Theme',
};

/**
 * The layout, and no colour at all: every colour comes from a role class, so a
 * theme restyles the whole screen.
 */
export const stylesheet = `
  .app { flex-direction: column; flex-grow: 1 }
  .main { flex-direction: row; flex-grow: 1; min-height: 0 }
  .nav { flex-grow: 0; flex-shrink: 0; width: 19 }
  .sections { flex-grow: 1 }
  .nav-row { flex-direction: row }
  .nav-name { flex-grow: 1 }
  .content { flex-basis: 0; min-width: 0 }
  .page { flex-direction: column; flex-grow: 1 }
  .section { flex-direction: column; flex-grow: 1; padding: 0 1 }
  .lede { margin-bottom: 1 }
  .setting { flex-direction: row; column-gap: 1 }
  .label { width: 11; flex-shrink: 0 }
  .control { flex-direction: column; flex-grow: 1; min-width: 0 }
  .indent { margin-left: 2 }
  .problem { height: 1; margin-left: 14 }
  .buttons { flex-direction: row; column-gap: 1; margin-top: 1; margin-left: 12 }
  .bar { flex-direction: row; column-gap: 1; padding: 0 1; height: 1 }
  .status { flex-grow: 1; flex-shrink: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis }
  .login { flex-direction: column }
  .login .problem { margin-left: 0 }
  .login-hint { margin-bottom: 1 }
  .login-status { height: 1 }
  .login-actions { flex-direction: row; justify-content: flex-end; column-gap: 1; margin-top: 1 }
`;

/**
 * The whole screen.
 *
 * @returns The root.
 */
export function App(): Element {
  const app = useApp();
  const input = app.input;
  if (input === undefined) {
    throw new Error('The settings screen needs keys: run it with runApp() on a terminal');
  }
  const account = useContext(AccountContext);
  const form = createForm(account.load(), SETTINGS_CHECKS);
  const section = new State<Section['id'] | undefined>('appearance');

  // -- saving -----------------------------------------------------------------

  const save = (): void => {
    if (!form.valid.get()) {
      // a save the form refused says why, in every field at once
      form.touch();
      return;
    }
    if (!form.dirty.get()) {
      return;
    }
    account.save(form.commit());
    showToast(app.view, { message: 'Settings saved', variant: 'success' });
  };
  const cancel = (): void => {
    if (!form.dirty.get()) {
      return;
    }
    form.revert();
    showToast(app.view, { message: 'Changes discarded', variant: 'info' });
  };

  const saveButton = Button({
    disabled: follow(() => !form.dirty.get() || !form.valid.get()),
    label: 'Save',
    onPress: save,
  });
  const cancelButton = Button({
    disabled: follow(() => !form.dirty.get()),
    label: 'Cancel',
    onPress: cancel,
  });

  /** What the bar says: what stops a save, else whether there is anything to save. */
  const status = (): { role: string; text: string } => {
    const [first, ...rest] = form.errors.get();
    if (first !== undefined) {
      const more = rest.length === 0 ? '' : ` (and ${rest.length} more)`;
      const why = form.fields[first].error.get() ?? '';
      return { role: 'sigil-error', text: `Can't save: ${NAMES[first]}: ${why}${more}` };
    }
    return form.dirty.get()
      ? { role: 'sigil-warn', text: 'Unsaved changes' }
      : { role: 'sigil-muted', text: 'No unsaved changes' };
  };

  // -- the sidebar ------------------------------------------------------------

  const marks = unicodeSupported()
    ? { changed: '•', problem: '!' }
    : { changed: '*', problem: '!' };
  /** A section's mark: a problem first, since it is what stops a save, then a change. */
  const mark = (each: Section): { role: string; text: string } => {
    const errors = form.errors.get();
    if (each.fields.some((key) => errors.includes(key))) {
      return { role: 'sigil-error', text: marks.problem };
    }
    return each.fields.some((key) => form.fields[key].changed.get())
      ? { role: 'sigil-warn', text: marks.changed }
      : { role: '', text: ' ' };
  };

  const sidebar = ListView<Section, Section['id']>({
    current: section,
    items: SECTIONS,
    key: (each) => each.id,
    props: { class: 'sections' },
    row: (each) => (
      <box class="nav-row">
        <text class="nav-name">{each.label}</text>
        <text class={() => mark(each).role}>{() => mark(each).text}</text>
      </box>
    ),
    scrollbar: false,
  });

  const showing = (id: Section['id']) => (): 'flex' | 'none' =>
    (section.get() ?? 'appearance') === id ? 'flex' : 'none';
  const title = (): string =>
    SECTIONS.find((each) => each.id === (section.get() ?? 'appearance'))?.label ?? '';

  // -- the keys ---------------------------------------------------------------

  // Enter is the form's everywhere but on a button, which claims its own: what
  // reaches the root is an Enter no control took, and here it saves
  const onKey = (event: KeyEvent): void => {
    const k = event.key;
    if (k.name === 'enter' && !event.paste && !k.ctrl && !k.meta && !k.shift) {
      event.stop();
      save();
    }
  };

  // Tab is the router's own default, so it is described rather than bound
  onCleanup(input.describe('tab', { description: 'next', priority: 8 }));
  onCleanup(describeListView(input, sidebar));
  onCleanup(describeButton(input, saveButton, cancelButton));

  // the sidebar starts with the focus, so the arrows move between sections and
  // Tab goes into the one showing
  onMount(() => input.focus.focus(sidebar));

  return (
    <box class="app" onKey={onKey}>
      <box class="main">
        <Panel class="nav" title="Settings">
          {sidebar}
        </Panel>
        <Panel class="content" title={title}>
          <box class="page" display={showing('appearance')}>
            <Appearance form={form} />
          </box>
          <box class="page" display={showing('notifications')}>
            <Notifications form={form} />
          </box>
          <box class="page" display={showing('profile')}>
            <Profile form={form} />
          </box>
          <box class="page" display={showing('account')}>
            <Session />
          </box>
        </Panel>
      </box>
      <box class="bar">
        <text class={() => `status ${status().role}`}>{() => status().text}</text>
        {saveButton}
        {cancelButton}
      </box>
      {keyHelp(input)}
    </box>
  );
}
