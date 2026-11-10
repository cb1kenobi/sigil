# Form controls — how they were arrived at

The alternatives weighed, the measurements and the sabotage pass behind "Form
controls: a button, a checkbox, a radio set and a switch" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached. SIG-199.

#### The ticket's open questions, and what each one was weighed against

**Does `Button` replace the modal's inline buttons?** The case against was risk:
the modal is the most-tested component in the directory and its focus trap is
delicate. The case for was that the modal's buttons _were_ a button -- a text
node with the bracket rule, an `onKey` for Enter and Space, an `onMouse` for the
click -- written inline, so leaving them would ship two definitions of one
control on the day the second was written. SIG-278 had already decided the
visible half (the focused button moves from the accent to `.sigil-focus`) and
recorded the move as SIG-199's. Done, and the modal's 50 tests were the check:
49 passed untouched, and the one that failed read `.text` off the focused
element, which a box does not have. It now reads the button's parts and asserts
`[ B ]` exactly.

What the modal lost is an effect over `input.focus.current` that rewrote every
button's text on each focus move. A button learns its own focus from
`onFocusChange`, so nothing in the modal reads the focus signal for drawing any
more -- the trap and the restore still read it, as before.

**The checkbox marker.** `◉`/`◯` was the obvious reuse: the multiselect's marks,
already in `PROMPT_SYMBOLS`, and readable at colour level 0. `[x]`/`[ ]` won on
one argument: a form holds checkboxes and a radio set side by side, and the
reader tells "any of" from "one of" by shape. The radio set wants the round marks
for the same reason the `toggle()` prompt uses them -- one of a few states -- so
the checkbox has to be the square one. The multiselect is not a counter-example:
it is a list of many-of with nothing round beside it.

**The switch's keys.** `toggle()` takes Left, Right, Tab, Shift-Tab and Space.
Tab came out because in a form it belongs to the ring -- a switch that flipped on
Tab would trap the focus on itself. Shift-Tab went with it for the same reason.
What remained was whether the arrows flip or go somewhere. `toggle()`'s answer
(Left is always the inactive state, Right the active one) was kept, with the
collapsible's rule added on top: an arrow that would change nothing is not
claimed. That is what lets Right on a switch that is already on reach a pane or
a tab row around the form.

The mouse was not in `toggle()` at all. Two answers were considered: a click
anywhere flips, or a click on a state picks it. Flipping everywhere is Textual's,
but a switch here draws both names, and a reader pointing at `off` while it is
off means "off", not "on". So a click on a state picks it and a click anywhere
else -- the label, the pointer's column -- flips.

**The radio set's shape.** One ring stop per option was rejected first: Tab
through a form of five fields and a ten-option set would be fifteen presses, and
the tab row had already settled that a group is one stop with the arrows inside
it.

Highlight-then-commit (Textual's `RadioSet`, where the arrows move a highlight
and Enter or Space selects) against select-on-arrow (the web's radio group) took
longer. For the highlight: `onChange` fires only on a decision, and a reader can
look without choosing. Against it, and decisive: Enter belongs to the form in
this design (see below), so under highlight-then-commit "Down, Down, Enter"
submits the value from before the arrows, with the highlight showing something
else -- a trap nobody can see the cause of. The switch's and the tab row's arrows
both act at once, so a set whose arrows did not would be the odd one out. And
browsers do it this way. The cost, `onChange` per arrow, is the browser's cost
too, and an app that applies settings only on submit reads the state then.

**Can a single option be disabled?** Yes, because the options are `select()`'s
choices and those can be. It cost one extra rule: a set whose every option is
disabled is itself disabled, since otherwise Tab stops on a control where no key
does anything.

#### Enter, which the ticket did not ask about

It came up while writing the checkbox: Enter on a checkbox could toggle it, as
Enter toggles a collapsible. It was left unclaimed instead, on the
browser-form rule and on `TextField`'s precedent (Enter is the field's only with
`onSubmit`), so that an app's Enter handler on the column around the controls is
a submit that works from every field. A button claims Enter, because pressing a
focused Cancel is the point. That rule is what decided the radio set above.

#### Measured

Bytes are `graphBytes(staticGraph())` from `packages/sigil/test/static-graph.ts`
over this branch's `dist/`, the readers `dist.test.ts` sets its ceilings with.

| subpath                | bytes   | ceiling (KiB) |
| ---------------------- | ------- | ------------- |
| `components/button`    | 197,258 | 388           |
| `components/checkbox`  | 248,863 | 488           |
| `components/control`   | 168,553 | 332           |
| `components/radio-set` | 250,508 | 492           |
| `components/switch`    | 249,814 | 488           |
| `components/modal`     | 204,473 | 388 (as was)  |

The modal was 198,373 B on `main`. The ~50 KB between `button` and the other
three is `prompt.ts`, which they import for `PROMPT_SYMBOLS` and the choice
helpers and `button` does not -- which is why the pointer cell was kept out of
`control.ts`.

#### The sabotage pass

Twenty, each a one-line edit to the source with the suite for that control run
against it. Nineteen type-check; the sixteenth widens a type and does not, and is
caught by the test regardless.

1. Button brackets never drawn: 2 failures.
2. Button's focus role on the host rather than the label: 1.
3. A disabled button still pressed by a key: 1.
4. `controlDisabled()` leaving a disabled control focusable: 6, across all four.
5. Checkbox toggling on Enter: 1.
6. Checkbox calling `onChange` for a write the app made: 7.
7. Switch claiming a Left that changes nothing: 1.
8. Switch flipping on Tab: 1.
9. A click on the switch's current state flipping it: **survived**, because no
   test clicked `off` while off. The test now does: 1.
10. Radio arrows landing on a disabled option: 2.
11. Radio Space let through when the option is already selected: 1.
12. Radio focus role drawn while unfocused: 1.
13. A ring stop per radio option: 2.
14. Two options with one value allowed: 1.
15. A set of only disabled options still a stop: 1.
16. `controlFlag()` taking a truthy string: 1.
17. `describeControls()` describing hosts before checking all of them: 1.
18. Radio arrows moving the highlight without selecting: 7.
19. A modal button whose press settles nothing: 7.
20. A labelled switch putting the role on its current state too: **survived**,
    because the state is redrawn only when it moves and the test never moved it
    while focused. It now presses Right first: 1.
