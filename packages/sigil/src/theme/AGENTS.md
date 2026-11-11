# `packages/sigil/src/theme` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Themes

- **A theme is a stylesheet origin, and the framework's own defaults are the
  origin below it.** That settles the question SIG-77 left open. Every built-in
  draws itself with classes and carries no colour in its props, `src/theme/`
  holds the sheet that gives those classes their colours at origin `framework`,
  and an app restyling one writes an ordinary rule with an ordinary selector --
  no `!important`, no specificity contest -- because its own sheet is a later
  origin. A theme sits between the two, so it may restyle every built-in without
  touching what an app said about its own components, and an app may still beat
  the theme. One axis of the cascade doing all three jobs rather than three
  mechanisms to keep in agreement.
- **No built-in carries a colour in its props.** A prop beats a sheet per
  property, so a colour written into a template is one a theme cannot reach
  without `!important` -- which is the trap `!important` exists to get out of
  rather than a thing to walk into.
- **The framework sheet sets no layout property a component did not already ask
  for in props.** A theme that changed a prompt's padding would move the caret,
  and the component is what knows where that goes. Colours and attributes only --
  and that is a rule a _theme_ keeps or does not, because a theme is ordinary CSS
  over an ordinary cascade and nothing enforces it. Where a built-in worked its
  own geometry out, a layout property from a theme is a number the component never
  heard about: `box-sizing` starts at `border-box`, so
  `.sigil-table-cell { padding-left: 3 }` takes three columns _out of_ a width the
  table measured and a narrow column comes out empty. That is what CSS does with a
  border-box width; what the defaults can promise is only that they do not do it.
- **`FRAMEWORK_CSS` is the vocabulary, and it is one string rather than a set of
  files.** Read it as the list of names a theme may restyle. The state classes
  are spelled `is-*` because they are states rather than kinds: `:focus` is the
  cascade's own and is used where it applies, and these are the ones a terminal
  has no pseudo-class for.
- **Every declaration a built-in shares with another built-in is on a _role_, and
  the component classes are the narrower hooks beside it.** Seven roles --
  `.sigil-accent`, `.sigil-muted`, `.sigil-heading`, `.sigil-success`,
  `.sigil-error`, `.sigil-warn`, `.sigil-info` -- and since SIG-278 an eighth,
  `.sigil-focus`, which is below; and an element carries its
  component class and its role together, so `.sigil-muted { color: blue }` reaches
  a help note, a prompt hint, a placeholder, an answer, a choice hint and a
  decrypt's cipher cells, which were six rules to find before. A role beats a
  component rule by **origin** rather than by specificity, which is what lets one
  `(0,1,0)` role rule override whatever the framework wrote.

  Which seven is the evidence's answer rather than the ticket's, and it differs
  from the ticket in three places. `label` and `description` are **out**: nothing
  in the sheet ever set them, and a role nothing sets is the empty rule this file
  already refuses. `accent` is **in**, unnamed by the ticket and the most repeated
  colour there is -- the question mark, the spinner's frame, the progress bar's
  fill, the active choice and the scroll thumb are all cyan because they are all
  the live part of a frame. And it is `warn` rather than `warning` so that
  `sigil-${outcome}` lands on a role for all four values of `SpinnerOutcome`,
  which is the one emission that computes its class.

  The exceptions are numbered in the order they were added, and three of them --
  the sixth, eighth and ninth -- are retired, the entry below; what follows says
  of those three what they were. The first five were `.sigil-caret`,
  `.sigil-scroll-track`, `.sigil-debug`, `.sigil-qrcode-paint` and `.sigil-badge`.
  The caret's reason was written as "no role is inversion", which was true until
  SIG-278 made `.sigil-focus` one; what keeps the prompt's caret off that role is
  that it is a cursor, drawn on the one prompt there is whether or not anything has
  the focus, so a theme restyling the focus must not move it. The track is the one
  grey here that is not de-emphasised _text_, so it must not be `.sigil-muted` --
  that role is `dim` on a dark terminal, and a dim track is not a track;
  `.sigil-debug` is a **background** rather than a foreground, which no role is
  either; and the QR code's is a foreground and a background _together_, because a
  scanner wants dark modules on a light one and a terminal is usually the other
  way round, so neither of the two is de-emphasis, a state or an accent. The sixth
  (SIG-192) was the one rule keyed on a state rather than a class,
  `.sigil-collapsible-title:focus`: a focused collapsible title was drawn inverse,
  because nothing else says which title the keys go to. The seventh (SIG-195) is
  `.sigil-pager-match`, `inverse` a third time: a search highlight is standout,
  the terminal's own two colours swapped, rather than a colour anybody picked, and
  it is a match rather than a focus. The eighth (SIG-189) was the active tab's,
  `.sigil-tabs-row:focus .sigil-tabs-active`, `inverse` a fourth time and a
  descendant of the row's `:focus`: the row is the focusable element and the
  active label is the one thing its keys change, so only that label shows the
  focus. The ninth (SIG-215) was the text field's caret, `inverse` a fifth time
  under the field's `:focus`: a form holds several fields and only the one the
  keys go to may show a caret. The tenth
  (SIG-218) is the text field's **background**, `.sigil-text-field`, the overlay's
  reason a second time -- no role is a background -- with a different pair for a
  different job: the overlay has to be opaque over the app, a field has to be
  distinct from the box around it, so it is index 8 on a dark terminal and 7 on a
  light one where the overlay is 0 and 7. The decisions and the measurement behind
  the pair are under "A text field at rest" in `src/components`. The eleventh,
  twelfth and thirteenth (SIG-197) are markdown's `.sigil-markdown-em`,
  `-strong` and `-link` -- italic, bold and underline -- and they share one reason
  that none of the ten before them has: they are what the words _mean_, which the
  author of the document wrote, rather than a colour anybody picked, and that is
  the user-agent sheet's answer to `<em>` and `<strong>` too. Strong is not
  `.sigil-heading` though both are bold, because a role is restyled whole and a
  theme that coloured headings would have coloured every strong word in a
  paragraph. The fourteenth (SIG-224) is `.sigil-markdown-strike`, the same
  reason a fourth time: struck-out words are what the author wrote. It is the
  `strikethrough` longhand rather than `text-decoration: line-through`, because that
  shorthand resets `underline` as well and a struck link would lose its underline.
  Everything else markdown draws is on a role. `should
  declare on a role, bar twelve exceptions that say why` is the invariant, and it
  reads the **parsed** sheet rather than the source, because the comment listing
  the component classes as hooks would otherwise be mistaken for a rule. It was
  three until SIG-136, and the sentence here still said three for a commit after
  the test had been renamed -- which a review round pointed at by asking what
  counts elsewhere in this file the change had made false. It was fourteen until
  SIG-278, the entry below, and it is twelve with the fifteenth. The fifteenth (SIG-277)
  is `.sigil-panel { flex-grow: 1 }`, and it is the one exception that is a layout default
  and not a look: a panel fills its slot. It is in the sheet because the first version had
  it inline in the component's props, where a stylesheet could not undo it -- a prop beats
  a sheet -- and a panel used as a card in a column had no way to stop growing but a prop.
  The border's colour is deliberately not here; it is the theme's, and the default is the
  terminal's foreground.

- **The sixth, eighth and ninth are retired into an eighth role, `.sigil-focus`
  (SIG-278).** They were three `:focus` rules saying `inverse` -- the collapsible
  title, the focused tab row's active label, the focused field's caret -- which is
  one declaration three built-ins share, and so a role by this file's own rule. A
  component puts the class on the part that shows its focus from the element's
  `onFocusChange`, since a selector cannot find that part without also finding the
  same part of every control nested inside a focused one. The rest of the
  exceptions keep their ordinals, because the ordinals are the order they were
  added and are how this file, the sheet and the history name them; eleven were
  left, and the fifteenth below makes twelve. The shipped themes do not restate it -- a palette is a value for the seven
  roles that colour a surface, and the focus is the terminal's own two colours
  swapped under any of them. The reasoning, and what every Phase 9 widget does
  under it, is "Focus on a control" in `src/components`.

  The fifth is `.sigil-badge` (SIG-178), and it is `inverse` again -- the same
  declaration as the caret, for a different reason: it is how a role becomes a
  background. A badge is a label on a coloured ground, the colour is the variant's
  role, and `inverse` on a text that already has the role's `color` paints that
  colour behind the label. Declaring `background-color` on each variant instead
  would be four more rules that restate the four roles' colours, and a theme that
  recoloured `.sigil-success` would have to be told again; this way it is one
  rule and the roles stay the only place a state has a colour.

- **The toolchain has no sheet of its own, and deleting it fixed a bug rather than
  tidying one.** `TOOLCHAIN_CSS` was seven declarations under a `cli-` prefix at
  origin `app`, on the argument that the toolchain is an app and has no business
  in the `sigil-*` vocabulary. Four of the seven were a framework role said again
  under another name -- and the repetition is where it cost something, because
  three of them were `dim` with **no light half**, which this file records as the
  one declaration whose legibility depends on which way the background goes. So a
  report's location prefixes, entries and notes were grey on white: `sigil check`
  over a broken fixture came out byte for byte identical under
  `SIGIL_COLOR_SCHEME=light` and `=dark`, in the framework's own acceptance test,
  while the framework sheet beside it switched `ESC[2m` to `ESC[90m`. It is the
  roles now, and the fix is visible in the built binary rather than only in a test.

  What that left is the trap worth keeping: every `cli-*` emission names its role
  as a **literal** except the severity label, which interpolated -- and
  interpolating the role does not work either, because a `Severity` is `warning`
  while the role is `.sigil-warn`, so `sigil-${severity}` asks for a class no
  sheet defines and the label comes out unstyled with nothing to say so. Hence
  `SEVERITY_ROLE`, a map keyed by the union so that a severity added without a
  role is a type error rather than a colour nobody notices is missing. The
  invariant over it reads every file under `packages/cli/src/` rather than
  `report.ts` alone, because the first version read one file and a sabotage
  dropping the role from `cli-app` in `_inspect.ts` survived it.

  `render()` reads the colour scheme off `dest.env` for the same reason it reads
  the width and the colour level there. It always fell back to the process, which
  is the same object for the CLI, so nothing about a real run moved -- what it
  buys is that a report's light half is reachable from a test at all.

- **The themes sigil ships are their own subpath, and every colour in them is a
  palette index.** `@ttylabs/sigil/themes` holds `MONO`, `VIOLET`, `PHOSPHOR`,
  `AMBER` and `NEON` as CSS string constants, each a value for all seven roles. Two
  measurements shaped it and both were taken rather than assumed.

  **A separate subpath, because `./theme` is on everyone's path.**
  `components.mjs` and `help` both import it -- it is where `themedCascade()` is,
  which is the one place every built-in's cascade comes from -- so putting the
  themes there taxes every unbundled app for themes most of them never name. On
  their own subpath they cost nothing unless imported: `themes.mjs` is **4,119
  bytes** of string constants and **imports nothing at all**, so an app that names
  one drags in no module behind it. The figure here used to read 1.26 kB, which was
  four themes with a base half each and went stale when the second palette and
  `NEON` landed.

  **Named exports rather than a subpath each, because that is what shakes.** An
  app importing `VIOLET` alone bundles `VIOLET` and drops the other **four**,
  verified by bundling a fixture and grepping the chunks for a marker unique to
  each -- re-measured when the fifth theme landed: a one-import entry comes out at
  **938 bytes** with four of the five markers absent, against 4,023 bytes of CSS in
  the module. So `sigil/themes/violet` would buy nothing a named export does not --
  which is worth knowing, because a subpath per theme is the obvious shape to
  reach for.

  **And there is deliberately no map of them.** The first version shipped a frozen
  `Record` of all four beside them, which defeated the whole point: the map
  references each one, so nothing is unreachable and the same app bundled all four.
  Caught by measuring, not by reading. An app offering a `--theme` option writes its
  own map of the themes it chose to offer, which is the honest version anyway, since
  which themes an app offers is the app's decision.

- **A shipped theme names palette indices because there is no hex value that is
  safe on an unknown background.** The tension is arithmetic rather than
  aesthetic: a colour bright enough to read on black is usually too light to read
  on white. Measured with WCAG contrast against both `#000` and `#fff` over the
  obvious candidates, **every** truecolor palette has entries below 3:1 on one side
  -- `#ffd166` is 1.44:1 on white and `#1a1a1a` is 1.21:1 on black. The sixteen are
  not colours but indices the user's own terminal theme resolves, so the choice goes
  to the only actor that knows the background. That is not a guarantee, since yellow
  on white is hard for any theme, and it is strictly better than this package
  guessing. An **app's** theme may use truecolor freely and owes the other scheme a
  light half when it does.

  Found by shipping the defect first: a demo theme picked for a light terminal had
  a near-black heading, which on the dark default was text nobody could see. The
  guards are in `test/themes.test.ts` -- every role set in the base half, no hex,
  `rgb(` or `palette(n > 15)` in it, a light half wherever a theme sets `dim`, every
  role saying _something_ in both schemes, and a richer half that resolves to
  something outside the sixteen where one exists.

  **Two of those are written against the source rather than against a resolved
  style, and a sabotage is what said they had to be.** Degradation happens at
  _resolve_ time, so asking the cascade at level 1 hands back an index whatever was
  written -- `#ff00ff` resolves to 13 there -- and a guard built on that can never
  fail. The same pass found the role check passing on a role set **only** inside the
  richer half, which is a role absent everywhere a sixteen-colour terminal looks.
  Both read `withoutRichHalf()` now. The one deliberate survivor is a richer half
  that drops a role: the base rule still applies at level 2, so it falls back rather
  than going quiet, and there is nothing to catch.

- **Switching a theme at runtime is a swap, so it needs no reset prelude and
  restates no defaults (SIG-307).** It used to: a `Cascade` had `add` and no
  `remove`, so a switch layered a sheet over the last one and a property the new
  theme did not mention kept whatever the old one said. Measured, going from `MONO`
  to `VIOLET` left MONO's `underline` on the heading, its `inverse` on the error
  and its `italic` on the info line, because a colour theme has no reason to
  mention any of them -- so `demos/style/04-theme-switcher.js` prepended a rule
  turning every role's properties off, and restated the framework's own defaults
  as a theme to get back to them. `cascade.replace(old, next)` puts the new theme
  in the old one's place and `cascade.remove(theme)` is the framework's defaults,
  so all of that is deleted; the cascade section in `src/style` has the rest. The
  system monitor had worked around the same limit by scoping every theme under a
  `.theme-<name>` class and toggling it on the host, which is gone too.

  In `runApp()` it is `app.setTheme(theme)`, and the decisions that left room are
  these. It takes a `Stylesheet`, source text (read by `parseTheme()`, as the
  `theme` option is) or `undefined` for none. The runner holds the theme sheet it
  put in the cascade -- parsed in `runApp()` and handed to `themedCascade()` as a
  sheet rather than as text, because a cascade finds a sheet by identity -- and
  replaces it in place; with none, setting one **adds** it, and the origin puts it
  between the framework's sheet and the app's wherever it arrives. `undefined`
  removes it. Source that does not parse **throws before anything is swapped**, so
  the old theme stays on screen. The same sheet again does nothing, rather than
  paying a full re-match for no change. With the `cascade` option it **throws**,
  naming `cascade.replace()`: the runner did not build that cascade and cannot
  know which of its sheets is the theme, and guessing the first `theme`-origin
  sheet would swap the wrong one for an app that has two. A refused app is asked
  about its refusal first: with no terminal there is no cascade whatever option it
  was given, and "you passed a cascade" would be the wrong thing to be told.

  **A `Stylesheet` that is not at origin `theme` is refused**, by `setTheme()` and
  by the `theme` option alike, with a message naming `parseTheme()`. It was used as
  given, and the origin is what places a sheet -- so the same call did two things
  depending on history: an app-origin sheet handed to `setTheme()` with no theme
  yet was added after the app's sheets and beat them, while with a theme already
  there it replaced into the theme's slot and lost to them (measured: `green` won
  at origin app and `blue` at origin theme, for one call on one sheet). Source text
  has no origin to get wrong and always goes through `parseTheme()`.
  `themedCascade()` is left as it was: it has no setter, so there is no second
  history for its answer to disagree with.

  **`setTheme()` owns the one sheet it set, and nothing else.** An app that edits
  the cascade itself has taken that sheet back, and `setTheme()` checks whether the
  sheet it recorded is still in the cascade rather than assuming. If it is gone --
  removed, or replaced by `app.cascade.replace()` -- the next `setTheme()` **adds**
  a new one instead of throwing the cascade's "Cannot replace" from inside the
  runner, and `setTheme(undefined)` has nothing of its own to remove; whatever the
  app put there is the app's. What the cascade finds by identity cannot be two
  things at once, so one `Stylesheet` object is refused as both the `theme` and one
  of `sheets` (at `runApp()`), and a sheet the cascade already holds as another
  sheet is refused by `setTheme()` -- otherwise `setTheme(undefined)` would remove
  the app's sheet along with the theme, which it did.

- **Parsed once, and a cascade built per call.** A `Stylesheet` is frozen and a
  `Cascade` only reads it, so parsing per spinner would be the same work per
  component per process; the cascade differs per call because the sheets do, and
  it holds a bucket index over them.

- **A syntax token's role is the theme's table, `TOKEN_ROLE` (SIG-289).** It was
  in `components/prompt.ts`, where the first highlight seam happened to be, and
  it moved here because what it says is a theme's business: which role a
  `keyword` or a `string` is drawn in. A highlighter names tokens and knows no
  colour, a component puts `sigil-token-<token>` and the token's role on the cells,
  and a theme colours the roles -- so a theme that has never heard of code colours
  it, which is what the ticket asked for. `prompt.ts` re-exports it, so the old
  import and the new one are one `Map`.

  It grew from seven names to eighteen when `highlightCode()` arrived, and **every
  one of the eleven is a role rather than a declaration**, so `FRAMEWORK_CSS`
  gained a vocabulary comment and no rule, and `should declare on a role, bar twelve
  exceptions that say why` is untouched. Each new name takes the role of the thing
  it is most like rather than a role of its own: `constant` and `hunk` are info, as
  a number and the diff view's hunk header are; `regexp` and `inserted` success, as
  a string and an added line are; `deleted` the error role, as a removed line is;
  `property`, `link` and `code` the accent, as markdown draws a link and code;
  `heading` and `meta` the heading role, as the diff view draws a file header; and
  `variable` warning. The cost is the role rule's usual one, said once more: a
  theme that recolours `.sigil-accent` recolours JSON keys and Markdown links with
  every keyword and every focus mark, and `.sigil-token-property` is the narrower
  hook for a theme that wants them apart.

  **Markdown's `emphasis` and `strong` have no role**, and that is the reasoning
  the twelfth exception, `.sigil-markdown-strong`, already records rather than a
  gap. The only bold role is `.sigil-heading`, and strong text drawn in it is what
  that exception was written to avoid: a theme that coloured headings would colour
  every strong word. An exception for a source highlighter's tokens would be the
  sixteenth, for a look nothing asked for, so they are hooks.
  `should give a role to every token it emits but the two Markdown leaves to a
  sheet` in `test/components/highlight.test.ts` holds the table to what the
  highlighter emits, and `should name only roles the framework sheet declares` holds
  it to the roles that exist.
