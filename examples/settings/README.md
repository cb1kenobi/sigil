# Settings

A settings screen and a login form: the two blocks a web developer looks for
first, in a terminal. Sections in a sidebar; a radio set, a slider, a switch,
checkboxes and text fields; Save and Cancel that wait until there is something
to save; and a login form in a dialog, with a message under each field and a
Sign in button that stays disabled until the form is valid.

```
pnpm build
node examples/settings/dist/settings.mjs
```

Or `pnpm start` from this directory. It is written in JSX, so it runs as
`sigil build` compiled it; `pnpm build` from the repository root builds
`@ttylabs/sigil` and this together. `q` exits 0 and Ctrl-C exits 130. Without a
terminal on both ends, `runApp()` refuses: one line on stderr, exit 1.

There is no server behind it. Saving keeps the settings in memory for as long
as the screen is open, and the login form takes any user name with the password
`swordfish`, after a pause long enough to see the dialog wait.

| Key            | Does                                                                  |
| -------------- | --------------------------------------------------------------------- |
| ↑ ↓, Home End  | In the sidebar, show another section                                  |
| Tab, Shift-Tab | Move through the section's controls; the radio set is one stop        |
| Space          | Tick a checkbox, flip a switch, select a radio option, press a button |
| ← →            | Pick a radio option or a switch state; move the slider a step         |
| PgUp PgDn      | Move the slider a tenth of its range                                  |
| Enter          | Save, from anywhere but a button, which Enter presses                 |
| Escape         | Close the login dialog without signing in                             |
| `q`            | Quit, with 0, unless a text field has the focus and takes the `q`     |
| Ctrl-C         | Quit, with 130                                                        |

The mouse works throughout: a click picks a section, ticks a checkbox, selects
an option or a switch state, presses a button and puts the focus in a field,
and a press on the slider's track moves the thumb there and drags it.

## What it shows

- **Unsaved changes.** The bar under the sections says `Unsaved changes` while
  anything differs from what was saved, and the sidebar marks each section that
  has a change in it. Putting a value back by hand makes it clean again; nothing
  counts edits. Save and Cancel are disabled while there is nothing to save, and
  a disabled button is out of the Tab order.
- **Where an error goes.** A text field does not own its error line (SIG-215
  decided that), so the form does: one row under each field, blank until the
  focus has left the field once, and then the error, following each key so a
  fix takes it away at once. Whatever stops a save is also in the bar, at once
  and whichever section it is in -- ticking SMS with no phone number says
  `Can't save: Phone: SMS needs a phone number` from the Notifications section,
  and marks Profile with `!`. Enter on a form that cannot be saved shows every
  error it has.
- **Disabled controls.** Pause all disables the four checkboxes under it, which
  leave the Tab order while it is on. Save, Cancel, Sign in and Sign out are each
  disabled while they have nothing to do.
- **A dialog that is a form.** The login dialog opens on the user name. Enter
  there moves to the password, and Enter in the password signs in. Sign in is
  disabled until both fields are valid, and while the answer is on its way the
  fields and the button are disabled and the dialog says `Signing in...`. A
  refused password clears it and keeps the user name. Tab stays inside the
  dialog, and `q` is a letter in a field there rather than a way out.

## Layout

| File               | What it is                                                               |
| ------------------ | ------------------------------------------------------------------------ |
| `src/index.ts`     | The schema `sigil build` compiles: `runApp()` as its `run`, mouse on     |
| `src/root.tsx`     | `App`, the whole screen: the sidebar, the save bar, and `stylesheet`     |
| `src/sections.tsx` | The four sections, each a component over the one form                    |
| `src/login.tsx`    | The login dialog                                                         |
| `src/rows.tsx`     | A labelled row, and the error line under a field                         |
| `src/form.ts`      | `createForm()`: values, what was saved, checks, touched, dirty and valid |
| `src/checks.ts`    | What can be wrong with each value, as plain functions                    |
| `src/account.ts`   | `AccountContext`: loading, saving and signing in, replaceable in tests   |
| `test/`            | The form and the checks on their own, and the app over a fake terminal   |

`App` takes no props. It reaches the router and `exit()` through `useApp()`,
and the account through `AccountContext`, so `test/settings.test.ts` runs it
with `runApp()` over `createTestTerminal()` behind a fake account whose sign-in
answers when the test says.

## What it works around

Each is marked in the source and has a ticket.

- **`follow()`** mirrors a `Computed` into a `State`, because every control's
  `disabled` takes a `State` and not a `Computed` (SIG-334).
- **The login dialog's buttons are in its body**, with `actions: []`, because a
  modal's actions cannot be disabled and the dialog would open on a button
  rather than on the user name (SIG-337).
- **The login dialog borrows an owner.** It is opened from a button's
  `onPress`, which has no owner, so its body is built under a branch of the
  Account section's owner and disposed when the dialog settles; otherwise the
  effect that follows the focus would go on running after it closed (SIG-335).
- **`createForm()` is the example's own.** Whether it becomes a published module
  waits for a second app that wants one (SIG-338).
