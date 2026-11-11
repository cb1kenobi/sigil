# A settings screen and a login form — how it was arrived at

The measurements and the sabotage pass behind "A settings screen and a login
form" in [examples/AGENTS.md](../../examples/AGENTS.md). The decisions are
there; this is the record of how they were reached. SIG-293.

#### The status line that wrapped into the footer

Found by looking at the screen at the harness's 60 by 16 rather than by a test.
With SMS ticked and no phone number the bar says `Can't save: Phone: SMS needs a
phone number`, 43 columns where the bar left the status 37. The status was a
plain `<text>` with `flex-shrink` and `min-width: 0`, so it wrapped, and its
second line, `number`, drew one row down -- over the key-help footer, outside
the height-1 bar, which does not clip. The footer is painted after the bar and
writes its glyphs, not its blanks, so `tab next` covered `number` everywhere but
the blank between the two words, and the screen read `tabmnext`. The bytes said
so: the frame's diff moved down one row from the status and wrote a single `m`
at column 3. `white-space: nowrap`, `overflow: hidden` and `text-overflow:
ellipsis` on the status, and the regression test reads the last two rows at 60
columns.

#### An effect in a dialog opened from a handler outlives the dialog

Measured before SIG-335 was filed, so that the ticket states a fact: an effect
over an app `State`, created with no owner (as a key handler or a button's
`onPress` runs), then `openModal(root, { body, input })` and `close()`. Writing
the state afterwards ran the effect again -- two runs where one belongs. The
login dialog's `touchOnLeave()` reads `input.focus.current`, which outlives
every dialog, so that is the effect it would have leaked; it is built under a
branch of the Account section's owner instead.

#### Sabotage

Twenty-three, against `test/settings.test.ts` and the examples harness, each
applied as a patch, run, and reversed with `git apply -R`, with `git diff` clean
after each.

The first pass, twenty: the status without `nowrap` and the ellipsis; the
Profile fields never touched on leaving; a refused save not touching the form;
Save enabled while the form is invalid; Pause all not disabling the checkboxes;
the login submitting an invalid form; a refused password kept; no focus moved to
Sign out; every section shown at once; the phone check ignoring SMS; no `!` in
the sidebar; Enter not saving; `changed` always false; the dialog built without
its branch; an answer that lands after the dialog closed acted on; an error
shown before its field is touched; `revert()` leaving fields touched; `commit()`
not saving; the `KEYED` entry removed; and the `busy` guard in `submit()`
removed.

Six survived:

- **The Profile fields never touched** was a sabotage that did not compile -- it
  commented out a call across lines and left a dangling argument list -- so the
  file failed to load and vitest reported no tests. Rewritten to drop the name
  field from the map, and caught.
- **Save enabled while invalid.** Pressing it does what Enter does, touches the
  form and returns, so nothing a test checked moved. The SMS test now Tabs from
  the checkbox and expects Cancel, since a disabled Save is not a stop.
- **`revert()` leaving fields touched.** No assertion read `touched` after a
  revert; the `createForm` test does now.
- **The `busy` guard.** The fields take `busy` as their `disabled` and the
  button follows it, so nothing can call `submit()` while one is on its way. The
  guard was deleted, and a comment says why there is none.
- **The dialog built without its branch.** Nothing on screen differs: the leaked
  effect marks a field of a form nobody can see. The measurement above is the
  evidence, and SIG-335 is the fix that would make the branch unnecessary.
- **The `KEYED` entry removed.** It only stops the spawned run pressing Down
  before `q`, so the run still passes. A table of keys the harness knows is
  coverage rather than behaviour, and survives by design.

The second pass, three, re-ran the three that were given an assertion -- the
name field dropped from the map, Save enabled while invalid, `revert()` leaving
fields touched -- and caught all three.
