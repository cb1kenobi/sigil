/**
 * The login form, in a dialog over the settings screen.
 *
 * Two fields, an error line under each, a line for what the server said, and a
 * Sign in button that stays disabled until both fields are valid. Enter in the
 * user name moves to the password, and Enter in the password signs in -- or,
 * while the form is not valid, shows every error at once, since a submit the
 * form refused has to say why. Tab and Shift-Tab stay inside the dialog, and
 * Escape or Cancel close it with no answer.
 *
 * The buttons are `openModal()`'s `actions`: Sign in is disabled by the form and
 * runs the sign-in itself rather than settling the dialog, since the answer may be
 * no; Cancel settles it with nothing. `initial: 'body'` opens it on the user name
 * (SIG-337).
 */

import type { Account } from './account.ts';
import { type Login, LOGIN_CHECKS } from './checks.ts';
import { createForm, touchOnLeave } from './form.ts';
import { Problem } from './rows.tsx';
import { type ModalHandle, type ModalHost, openModal } from '@ttylabs/sigil/components/modal';
import { TextField } from '@ttylabs/sigil/components/text-field';
import type { Element } from '@ttylabs/sigil/element';
import type { InputRouter } from '@ttylabs/sigil/input';
import { State } from '@ttylabs/sigil/signals';

/** What the dialog needs from the screen that opens it. */
export interface LoginOptions {
  /** Where the password is checked. */
  account: Account;
  /** What the dialog is drawn over: the app's renderer. */
  host: ModalHost;
  /** The app's router. */
  input: InputRouter;
}

/** The hint under the title. There is no server, so a person running this needs to be told. */
export const LOGIN_HINT = 'Any user name; the password is swordfish.';

/** What the last line says when the password was wrong. */
export const LOGIN_REFUSED = 'That user name and password do not match';

/**
 * Opens the login dialog.
 *
 * The form's state is made here, before the dialog: it is signals and nothing
 * else, and the dialog's Sign in has to read whether it is valid while the body
 * that holds the fields is still to be built. What is built by the dialog's `body`
 * function is everything with an effect in it, which `openModal()` disposes when
 * the dialog closes: the fields, and `touchOnLeave()`, which follows the router's
 * focus and would otherwise run for as long as the app does. A button's `onPress`
 * has no owner to build under, which is what a body function is for (SIG-335).
 *
 * @param opts - The account, the renderer and the router.
 * @returns The dialog, whose `result` is the user name signed in, or `undefined`.
 */
export function openLogin({ account, host, input }: LoginOptions): ModalHandle<string> {
  const form = createForm<Login>({ password: '', user: '' }, LOGIN_CHECKS);
  const { password, user } = form.fields;
  /** Whether a sign-in is on its way, which holds the fields and the button. */
  const busy = new State(false);
  /** What the last attempt was told, which is about the form rather than one field. */
  const refused = new State('');
  // the dialog's own handle and the field a refusal moves the focus to, which are
  // made after the handlers that use them
  let dialog: ModalHandle<string> | undefined;
  let passwordField: Element | undefined;

  // no guard against a second submit while one is on its way: the fields and
  // the button are disabled for as long as `busy` is, so nothing can call this
  const submit = async (): Promise<void> => {
    if (!form.valid.get()) {
      // Enter in the password field is a submit the button would not have
      // allowed, and the form says why in every field at once
      form.touch();
      return;
    }
    const { password: secret, user: name } = form.values();
    busy.set(true);
    refused.set('');
    let ok = false;
    try {
      ok = await account.signIn(name.trim(), secret);
    } catch (err) {
      refused.set(`Could not sign in: ${(err as Error).message}`);
    }
    busy.set(false);
    if (dialog?.open !== true) {
      // closed while the answer was on its way: nobody is waiting for it
      return;
    }
    if (ok) {
      dialog.close(name.trim());
      return;
    }
    if (refused.get() === '') {
      refused.set(LOGIN_REFUSED);
    }
    // the password goes and the user name stays, and the focus goes where the
    // next thing to type is
    password.value.set('');
    password.touched.set(false);
    input.focus.focus(passwordField);
  };

  const build = (): Element => {
    const userField = TextField({
      disabled: busy,
      onChange: () => refused.set(''),
      onSubmit: () => input.focus.focus(passwordField),
      placeholder: 'your user name',
      value: user.value,
    });
    passwordField = TextField({
      disabled: busy,
      mask: '•',
      onChange: () => refused.set(''),
      onSubmit: () => void submit(),
      value: password.value,
    });
    touchOnLeave(
      input.focus.current,
      form,
      new Map([
        [userField, 'user'],
        [passwordField, 'password'],
      ])
    );

    return (
      <box class="login">
        <text class="login-hint sigil-muted">{LOGIN_HINT}</text>
        <text>User name</text>
        {userField}
        <Problem field={user} />
        <text>Password</text>
        {passwordField}
        <Problem field={password} />
        <text class={() => (busy.get() ? 'login-status sigil-muted' : 'login-status sigil-error')}>
          {() => (busy.get() ? 'Signing in...' : refused.get())}
        </text>
      </box>
    );
  };

  dialog = openModal<string>(host, {
    actions: [
      {
        disabled: () => busy.get() || !form.valid.get(),
        label: 'Sign in',
        onPress: () => void submit(),
      },
      { label: 'Cancel' },
    ],
    body: build,
    initial: 'body',
    input,
    title: 'Sign in',
    width: 46,
  });
  return dialog;
}
