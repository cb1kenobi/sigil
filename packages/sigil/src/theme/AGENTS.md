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
  `.sigil-error`, `.sigil-warn`, `.sigil-info` -- and an element carries its
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

  `.sigil-caret`, `.sigil-scroll-track`, `.sigil-debug` and `.sigil-qrcode-paint`
  are the four declared exceptions: no role is inversion; the track is the one
  grey here that is not de-emphasised _text_, so it must not be `.sigil-muted` --
  that role is `dim` on a dark terminal, and a dim track is not a track;
  `.sigil-debug` is a **background** rather than a foreground, which no role is
  either; and the QR code's is a foreground and a background _together_, because a
  scanner wants dark modules on a light one and a terminal is usually the other
  way round, so neither of the two is de-emphasis, a state or an accent. `should
  declare on a role, bar four exceptions that say why` is the invariant, and it
  reads the **parsed** sheet rather than the source, because the comment listing
  the component classes as hooks would otherwise be mistaken for a rule. It was
  three until SIG-136, and the sentence here still said three for a commit after
  the test had been renamed -- which a review round pointed at by asking what
  counts elsewhere in this file the change had made false.

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

- **Switching a theme at runtime needs a reset prelude, and an app picking one does
  not.** A `Cascade` has `add` and no `remove`, so a switch layers a sheet over the
  last one and a property the new theme does not mention keeps whatever the old one
  said. Measured: going from `MONO` to `VIOLET` left MONO's `underline` on the
  heading, its `inverse` on the error and its `italic` on the info line, because a
  colour theme has no reason to mention any of them. A switcher prepends a rule
  turning every role's properties off, which is what
  `demos/style/04-theme-switcher.js` does; it is also why the demo restates the
  framework's own defaults as a theme rather than removing a sheet to get back to
  them. This is a switcher's problem alone -- an app picks one theme at startup and
  never meets it.
- **Parsed once, and a cascade built per call.** A `Stylesheet` is frozen and a
  `Cascade` only reads it, so parsing per spinner would be the same work per
  component per process; the cascade differs per call because the sheets do, and
  it holds a bucket index over them.
