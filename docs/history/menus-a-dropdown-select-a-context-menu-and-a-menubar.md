# Menus: a dropdown select, a context menu and a menubar — how it was arrived at

The sabotage pass and the defects found while building "Menus: a dropdown select,
a context menu and a menubar" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached. SIG-285.

#### The four questions, in the order the code answered them

The ticket asked whether to reuse `placeTooltip()`, whether a menu traps the
focus as the modal does, what the menubar's keys are, and where the dropdown
belongs. The last was settled before any code: Chris put the dropdown here and
told SIG-199, which was running alongside. The other three were settled by
writing the session first and seeing what it needed.

- `placeTooltip()` was reused as it stands. The first drawing of a submenu, opened
  against its row's own box, put the submenu's top **border** level with the row,
  so its first item sat one row below the item that opened it and its left border
  touched the parent's right one. Growing the row's box by one cell on every side
  before handing it to `placeTooltip()` fixed both, and is the one thing the menu
  adds to the arithmetic; the flip to the left side came with it for free.
- The focus was never moved, from the first version. What decided it was the
  dropdown: a field that keeps the focus while its list is open is the field the
  reader is looking at, and its `.sigil-focus` stays on. Moving the focus into the
  menu would have needed the modal's whole restore path for a box that lives a
  second -- and a Tab trap, where letting Tab close the menu and go on is what a
  desktop does.
- The modal's per-router stack had to be shared: the dialog's binding is
  registered before any menu opened inside it and sees every key first, so on its
  own it would take every key from the list. The stack moved to `overlay.ts` as
  `holdInput()`, and the dropdown-in-a-dialog tests are what fail without the
  dialog standing aside. The `trap` flag is for the focus restore of a dialog
  closed under an open menu: `mine.at(-1)` would be the menu's backdrop, which has
  nothing focusable in it, and the focus would go nowhere. Its test was written for
  the sabotage pass below.

#### Found along the way

- **F10 had no name.** `keys.ts` named the arrows, the paging keys and the editing
  keys, so a menubar's own key came through as `unknown`. Teaching it the function
  keys turned up the second half: the `~` family was looked up by its whole
  parameter string, so `ESC [ 21 ; 2 ~` -- Shift-F10, the other context-menu key --
  was unknown too, as was Ctrl-Delete. The lookup reads the first parameter now.
- **The dropdown was eight rows tall in the website's capture.** Its example put
  it in a row with `height: 8`, the row stretched it, and the list opened under
  the eighth row. No unit test had a row with a height. `align-self: flex-start`
  before the caller's props, and a test that puts it in such a row.
- **A second press on a menubar title, before a frame, re-opened instead of
  closing.** Once a frame has drawn the backdrop it covers the bar and the
  backdrop's own click handler does the toggle, so every test that laid out
  between the two presses passed. The title's handler toggles too now, for the
  press that lands before the frame.
- **The ampersand in a dropdown choice.** `R&D` as a choice would have been read
  as a label with a mnemonic and drawn `RD`. A choice's `&` is escaped on the way
  into the menu.

#### The sabotage pass

Each sabotage type-checks, was applied by hand, and the named test files run.
Eighteen in all; sixteen caught on the first pass.

| sabotage                                                     | caught by                                                        |
| ------------------------------------------------------------ | ---------------------------------------------------------------- |
| the modal's binding ignores `isTop()`                        | both dialog tests, menu and dropdown                             |
| the menu's binding does not stop a key                       | `should keep every key from the app while it is open`            |
| the backdrop does not stop a mouse event                     | **survived**; now `should dismiss on a click outside`            |
| `nextEnabled()` steps onto a disabled item                   | `should step past a separator and a disabled item`               |
| Tab is stopped after closing                                 | `should close on Tab and let the Tab move the focus on`          |
| a submenu's anchor is not grown by the border                | both submenu placement tests                                     |
| the decoder looks up the whole parameter string              | the modifier test in `keys.test.ts`, and Shift-F10               |
| the menubar's Alt-letters are bindings rather than fallbacks | `should leave an Alt-letter to a focused field that reads it`    |
| a dropdown choice's `&` is not escaped                       | `should take an ampersand in a choice as an ampersand`           |
| `nearestTrap()` returns any layer                            | `should hand the focus back to the dialog below`                 |
| the context menu's Shift-F10 does not defer to the top layer | `should leave Shift-F10 to a menu that is already open`          |
| a shared mnemonic chooses the first item                     | `should step through the items that share a mnemonic`            |
| the title's own handler re-opens instead of closing          | **survived**; now `should close for a second press on the title` |
| a menu taller than the screen is not cut                     | `should cut a menu taller than the screen to it`                 |
| a resize does not close the menu                             | `should close on a resize`                                       |
| a dropdown letter lands on a disabled choice                 | `should pick the next choice a letter starts`                    |
| a drag released over an item chooses nothing                 | the menubar's and the dropdown's drag tests                      |
| the dropdown is not `align-self: flex-start`                 | `should stay one row tall in a row that has a height`            |

The two survivors are worth the sentence each. The backdrop's `stop()` survived
because the click outside landed on the backdrop rather than on `other` -- the
backdrop covers the screen, so `other` was never in the event's path whether or
not anything stopped it. What the stop keeps out is the root's and the router's
own handlers, so the test listens there now. The title's toggle survived because
every test laid the tree out between the two presses, which is the frame that
puts the backdrop over the bar.
