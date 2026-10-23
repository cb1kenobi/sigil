# `packages/sigil/src/style` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Light and dark

Every default colour sigil shipped was a bet on dark, and there was nothing an
author or a theme could write to make one conditional.
`@media (prefers-color-scheme: light)` is what closes that, and the whole feature
is: get the value, put it on the media context, and let the cascade do what it
already does. `src/style/scheme.ts` is the synchronous half, the truthful half is
an OSC 11 reply through the query mechanism, and the framework sheet is where it
is proved.

- **Nothing new was invented, which is the point.** The feature is one media
  feature, one field on `MediaContext`, and one `if` in `holds()`. No new
  resolution path, no new precedence rule, nothing added to the matching engine --
  the same argument the utility layer is built on, and the reason this was a small
  ticket sitting behind a large one.
- **`MediaContext.colorScheme` is required, not optional.** Every other field on
  that interface is, and an optional one would mean `holds()` carrying a default
  that then disagrees with `DEFAULT_MEDIA`'s. What it costs is a type error at
  every literal in the suite, which is the change being visible rather than a
  problem: a context that does not say is a context that has not decided.
  `reducedMotion` is required for the same reason and paid the same cost, which is
  the precedent working rather than a second argument.
- **`DEFAULT_MEDIA.colorScheme` is `dark`, and that is a default rather than a
  guess at the terminal.** Dark because it is what every default colour in this
  library has always been a bet on, so making the constant anything else would
  change the meaning of every sheet already written against it. It is not where
  detection lives: a frozen constant that read the environment at import is the
  trap `getColorLevel()` avoids by detecting on first read, so the environment
  reaches a live cascade through `themedCascade()` and through the renderer
  instead.
- **A keyword feature refuses a range and refuses the bare form.** There is no
  order on `light` and `dark` for `min-`/`max-` to mean, and a feature that always
  has one of its values makes the bare `(prefers-color-scheme)` always true -- a
  rule inside one reads as conditional while being unconditional, which is worse
  than an error. Both are refused where they are written, which is the rule an
  unknown property in a stylesheet already follows. `MediaCondition.keyword` is a
  field of its own rather than a widened `value`, so nothing downstream has to ask
  which of the two a `number | string` is. There are two keyword features now --
  `prefers-reduced-motion` joined it in SIG-62 -- so `KEYWORD_FEATURES` carries the
  context field beside the values each one accepts, and the one `if` in `holds()`
  is a two-entry lookup rather than a second `if`.
- **The keyword is read in any case and the feature name already was.** The rule
  every keyword in this grammar follows: a property name and `inherit` are
  case-insensitive while a class is not, because one is a CSS keyword and the other
  is a name somebody chose.
- **`COLORFGBG`'s background is the last field, not the second.** The variable has
  two shapes in the wild -- `15;0` and `15;default;0` -- so reading field two gets
  `default` from rxvt and nothing from anybody. A field that is not a palette index
  is _no answer_ rather than a guess, which is the rule an empty environment
  variable already follows in the parser.
- **The palette-index table is a table, because the boundary is not where the
  arithmetic would put it.** `0`-`6` and `8` are dark, `7` and `9`-`15` are light:
  `7` is white and light, `8` is called bright black and is a dark grey, so
  anything written as `bg < 8` is wrong about both of them.
- **It is the floor and never the answer, because it is notoriously wrong under
  tmux.** A multiplexer passes through whatever was in its own environment when the
  _server_ started, which is whichever terminal happened to launch it rather than
  the one attached now -- and the variable is frequently stale or absent besides.
  Being wrong until the reply lands is the price of having a synchronous answer at
  all, which is the same trade the colour level already makes.
- **`SIGIL_COLOR_SCHEME` is the user's override, and it settles the ticket's open
  question in four places rather than two.** Yes, there is an explicit override, and
  it is the user's as well as the app's -- `NO_COLOR`'s direction. The order is
  `RenderOptions.colorScheme`, then `SIGIL_COLOR_SCHEME`, then an OSC 11 reply, then
  `COLORFGBG`, then dark, and each step down is less specific knowledge about the
  same question. An app is on top because it may be _painting its own background_,
  so a named scheme is a fact about its output rather than a guess at the terminal.
  The user is next because what they are correcting is the detection. The reply is
  the terminal itself. `COLORFGBG` is what some terminal put in the environment
  once, which under tmux may not even be this one. A value that is neither `light`
  nor `dark` falls through rather than deciding, because a variable somebody
  exported wrong should not be a decision. Namespaced on purpose: there is no
  cross-tool convention for forcing a scheme the way `NO_COLOR` is one for colour,
  so an unnamespaced name would be claiming a standard that does not exist.
- **The two variables are read by two functions, because one function put the reply
  above the override.** `schemeFromEnv()` reads both and is the right call for
  `themedCascade()` and `renderToString()`, neither of which has a reply to order
  against. A renderer does, and reading both through that one call left
  `SIGIL_COLOR_SCHEME` _inside_ the term that sat under the refinement -- so a
  terminal reporting a black background overrode a user who had said `light`, which
  is the override failing at the one job it has. `forcedScheme()` and
  `schemeFromTerminalEnv()` are the halves, and `readMedia()` puts the reply between
  them. Found by review, and pinned by six tests that walk the chain a source at a
  time.
- **The first background reply that can be _read_ wins, which is not the first.** A
  terminal may legally answer `white`, and giving up there would throw away a second
  reply that does say something -- so an unreadable reply does not close the
  question while a readable one does. It falls out of the guard rather than needing
  anything after it: the branch is only entered while nothing has been read, so
  there is never a value for an unreadable reply to overwrite. A `?? background` was
  written and taken out again, because a line that can be deleted with the suite
  still green reads as load-bearing and is not. What was actually wrong was the
  comment, which said the first reply wins.
- **The `#` form is four widths, not one.** X11 defines `#RGB`, `#RRGGBB`,
  `#RRRGGGBBB` and `#RRRRGGGGBBBB`, and each digit group is a fraction of its _own_
  full scale exactly as in `rgb:` -- so `#fff` is white rather than `#0f0f0f`, and it
  goes through the same `scale()`. Written as one group of 3, 6, 9 or 12 digits split
  in three afterwards, because four alternations of three capture groups is one rule
  said four times. A width that is not a multiple of three is refused.
- **`rgb:8/8/8` and `rgb:08/08/08` are different colours, and that is the spec.**
  136 and 8. One hex digit is a fraction of fifteen, not an eight-bit channel, which
  is surprising enough to pin with a test of its own -- and it is the same property
  that makes the scaling right rather than a quirk of it.
- **A reply is recorded whatever it says, including when it agrees with what is
  already on screen, and that was the bug.** A reply was stored only where it
  _differed_, so a terminal answering light while `COLORFGBG` already said light left
  nothing behind -- and the next resize, once that variable had gone or changed, fell
  through to `COLORFGBG` and then to dark over a terminal that had told us the
  answer. Which is the shape of the whole ticket: the reply is the truthful source
  and the variable is the stale one, so the truthful one has to be the one that is
  kept. `should record a reply that agrees, so a lower source cannot replace it` is
  the guard, and what it does after the reply is delete `COLORFGBG` and resize --
  which is what a tmux client reattaching looks like.
- **Whether a reply is a _change_ is a question about the whole chain, which is why
  `scheme()` is asked twice.** Comparing the reply to `cascade.media.colorScheme`
  gets it wrong in both directions: it misses the agreeing case above, and it spends
  a full re-match and a repaint on every probe for an app or a user who sits above
  the refinement and whose answer therefore cannot move. Asking the chain before and
  after recording is one mechanism where two guards used to be, and it deleted the
  `opts.colorScheme === undefined` conjunct that had been standing in for half of it.
- **The renderer owns the live media context, so a scheme set on a cascade alone is
  lost.** `render(App, { cascade: themedCascade({ colorScheme: 'light' }) })` with no
  `RenderOptions.colorScheme` has that light context overwritten by the first
  `readMedia()`. That is the renderer's rule rather than an oversight -- one thing
  decides what the media queries are asked about, and a cascade handed in is a set of
  sheets rather than a set of answers -- and `mountLive()` is the path that gets it
  right, by passing the scheme to both.
- **A tmux passthrough wrapper is not unwrapped, and that is unverified rather than
  decided.** A review round claimed tmux answers OSC 11 wrapped in
  `DCS tmux; … ST` with the inner escapes doubled, which would mean the reply is
  read as an unrecognised control string and thrown away. That does not match what
  `allow-passthrough` is for -- it is about what an application sends _out_ through
  tmux, not about what comes back -- and it was not verified, so nothing was written
  against it. It is exactly the question `terminal-probe.mjs --detect` exists to
  settle: run it inside tmux and read what came back, byte for byte, off the reply
  list it prints. Implementing an unwrapper on an unchecked claim would be inventing
  a parser for a shape nobody has seen.
- **Luminance is BT.601 and deliberately not the Oklab the degrader uses.** The
  two are asking different questions: the degrader needs perceptual _distance_
  between two colours it is choosing between, which is where Oklab is measurably
  better, and this needs one scalar against a midpoint, where a second colour-space
  conversion buys nothing and costs a reader another thing to hold. The midpoint is
  half of full scale rather than a number fitted to a handful of terminal themes --
  a fitted threshold is wrong about the next theme -- and the test pins the
  _property_, that the boundary sits at half, so a change to how brightness is
  computed fails for the right reason.
- **The components are sixteen bits per channel and are scaled, not truncated.**
  `rgb:RRRR/GGGG/BBBB` is what xterm specifies and what nearly everything writes,
  and truncating to the first two digits happens to be right for `1c1c` only by
  luck: a terminal answering `rgb:1/2/3` is answering in _one_ digit, where `f` is
  full scale, and truncation reads that as almost black. Each component is a
  fraction of the full scale its own digit count implies, which is the one reading
  right for all four widths, and it is rounded rather than floored because the
  midpoint sits between two values.
- **An X11 colour name is no answer rather than a guess.** A terminal may legally
  answer `white`, and resolving one needs a database this does not have -- so
  `parseReportedColor()` returns nothing and the environment's answer stands, which
  is the same shape as a terminal that said nothing.
- **The first background reply wins.** A terminal answers a question once, so
  anything after it is somebody else's answer to the same one -- tmux again, for the
  same reason the version reply has an entry about it. The _colour level_ refines
  off any version reply because refinement only raises there and the permissive
  reading is safe; a scheme has no such asymmetry, so the nearest answer is the one
  taken.
- **`DetectOptions` takes a `colorLevel` and deliberately takes no
  `colorScheme`.** The level one is the _floor a reply may raise_, which is a thing
  a caller can sensibly name; a reply does not raise a scheme, it replaces one, so
  there is no floor to pass. A caller who wants to state the scheme states it to
  `render()`, and passing it here is an excess property TypeScript refuses rather
  than an option that is quietly ignored.
- **A reply beats the environment and a caller beats both, which is the opposite
  way round from the colour level.** That looks inconsistent and is not.
  `opts.colorLevel` is what `mountLive()` fills with `ansi.level` -- the
  environment's own guess wearing the caller's clothes -- so a reply has to be able
  to beat it or no built-in could ever be refined. Nothing fills `opts.colorScheme`
  in on a caller's behalf, so naming one is a _statement_ about what the output is
  drawn against rather than a guess at the terminal, and a reply does not overrule
  it. And the scheme needs no floor of the kind a level of zero is: there is no "no
  scheme", and what the terminal says about its own background is better evidence
  than a possibly-stale variable by definition.
- **`themedCascade()` sets the media context rather than leaving it frozen.** That
  is the one place every built-in's cascade comes from, and the scheme is free to
  learn there: an environment read, no round trip, available before anything
  mounts. Without it `table()` and the help screen would resolve the framework
  sheet at `DEFAULT_MEDIA` and a light terminal would get the dark half -- the bug
  this feature is for, arriving through the door nobody was watching.
- **`renderToString()` takes a scheme and never goes and asks for one.** A string
  being built has no screen, and the media queries are the caller's apart from the
  width and the colour depth this call is the authority on. When nobody says, the
  cascade's own answer stands -- which for `themedCascade()` is what the environment
  knew and for a bare `Cascade` is the frozen dark -- and the context is put back
  exactly as it was found, which is the rule that path already keeps.
- **The framework sheet's light half is two rules, and its size is the finding.** Every colour in that sheet is a palette index, and the basic sixteen
  are whatever the user's terminal theme says they are -- so there is nothing in
  them to fix conditionally, which is the rule working rather than a gap, and it is
  also exactly why an _app_ or a _theme_ needs this: a `#666` somebody wants for
  de-emphasis is legible on one background and invisible on the other, and nothing
  about the sixteen helps there. What does not follow the theme is **`dim`**. SGR 2
  is rendered by blending the foreground _towards the background_, so on a dark
  terminal dim grey sits on black and on a light one it sits on white, and the
  second is the unreadable parenthetical the ticket names. The light half carries
  the de-emphasis on `gray` instead -- palette index 8, which a light theme renders
  dark because it has to render _text_ in it -- so it is still the user's own colour
  and it is still legible. Conservative deliberately: the states, the symbols and
  the bars are left alone, because a palette colour is already right for them and
  changing one would be inventing a problem.

  It is **one** rule for the de-emphasis rather than the five declarations this
  entry used to record, and the role vocabulary is what collapsed it: `dim` is
  `.sigil-muted`'s now, so the one place a light terminal needs a different answer
  is the one rule that says it -- where before it was `.sigil-help-note`,
  `.sigil-prompt-hint`, `.sigil-prompt-answer`, `.sigil-choice-hint` and
  `.sigil-decrypt-cipher` each saying it separately, which is five chances to leave
  one out. That is the argument for the roles stated as a number.

  The second rule is the debug overlay's **background**, which is the one thing in
  this sheet that is not a foreground: index 0 on a dark terminal and index 7 on a
  light one, because the text in that pane is the terminal's own default foreground
  and what it needs behind it is whichever background that foreground was chosen to
  be legible against. Still a palette index, so it is still the user's own colour.

- **`FRAMEWORK_CSS` is a template literal, so it holds no backtick and no
  `${`.** Written down because the failure is not local: a backtick in a comment
  inside that string ends the sheet, and what `tsc` then reports is a syntax error
  twenty lines further down than the character that caused it. Cost one round.
- **`dark:` and `light:` are utilities now, and the line that said otherwise moved
  with them.** AGENTS.md said "not `dark:` -- a terminal has no such mode", and it
  was true until it was not: a terminal has a background, the cascade reads it as
  `prefers-color-scheme`, and the variant is that query said the way people already
  know how to say it. The comment in the generator and the table under it had to
  change together, because a comment saying a feature does not exist, over a table
  that could have generated it, is the shape of stale nothing in a build catches --
  and `should have the ones a terminal can have and not the ones it cannot` had the
  old sentence written into it as an assertion, which is what made this a
  three-place edit rather than a one-place one. Nothing committed changed: the
  committed sheet is the base set, printed with `variants: false`, for the reason
  already recorded -- the variants are 4,996 rules and 7.29ms against the base
  set's 383 and 0.63ms. `hover:` still waits for mouse tracking.
- **The startup measurement was taken again on a quiet machine, and it is the one
  worth quoting.** The figures under "Asking the terminal what it is" in
  `src/terminal` were interleaved but taken while something else was
  compiling, so the absolutes were inflated by three or four times and only
  the delta meant anything. Re-run with the machine idle, over the same fifty
  interleaved pairs, and comparing the binary from before either ticket
  against the binary with both: `--version` is min 24.5ms / p25 25.9 / median
  26.3 before and 24.6 / 25.6 / 26.3 after, and `--help` is 39.3 / 40.5 / 41.4
  before and 39.8 / 40.7 / 41.6 after. Identical, and worth recording for a
  second reason -- those absolutes land on the 24.3ms and ~40ms this file
  wrote down for `--version` and `--help` a long time ago, which is the first
  time either number has been independently reproduced.
- **`terminal-probe.mjs --detect` prints the background and the scheme, because
  that is the claim only a terminal can settle.** A test can assert what
  `rgb:fdfd/f6f6/e3e3` is read as; nothing in a test can say whether _your_
  terminal answers OSC 11, what it answers, or whether the scheme that comes out
  matches what you are looking at. The probe says so in as many words, including
  that a `COLORFGBG` disagreeing with the reply is the variable being stale rather
  than the reply being wrong.

### A quiet axis: one place that decides whether anything may draw

Half of what a `--json` flag is for has nothing to do with JSON -- it is
suppressing everything else, and that is worth having on its own.
`src/style/output.ts` is the fold, `createSinkCanvas()` is what stops the bytes,
`src/parser/quiet.ts` is the flag, and `packages/cli/src/report.ts` is the
toolchain's one reader.

- **Nothing new was invented, which is the point.** The feature is one more
  source folded into the place that already folds the motion preference, one
  value added to what that fold answers, and one backend. No new resolution path
  and nothing a component asks for itself -- which is the argument the colour
  scheme and the utility layer are both built on, and the reason this was a small
  ticket sitting behind a large one.

- **`live`, `reduce`, `quiet` are three states rather than a boolean, because
  reduced motion and quiet are different _answers_ from the same components.**
  Reduced motion means an animation that has **already finished** -- the spinner
  draws its final frame, the bar prints its percentage, the typewriter prints the
  whole string -- which is exactly right for a CI log and exactly wrong for a
  script that asked for nothing. So `OutputLevel` is ordered by how much reaches
  the screen, and `resolveMotion()` came out of `motion()` so that the quiet fold
  reads the motion fold rather than reimplementing its three sources.

- **Collapsing `(live, motion)` into one level fixed a latent defect, which is
  the clearest argument for the fold there is.** The spinner's tick read `live`
  -- the raw terminal fact -- where every other component read the resolved
  answer, so `SIGIL_REDUCED_MOTION=1` **on a terminal** left it spinning at
  eighty milliseconds a frame, which is the one thing that variable exists to
  stop. A pipe hid it, because there `live` is false and the two readings agree;
  it took a terminal with the preference set to separate them. Two readers of one
  rule, found by writing the fold rather than by a report.

- **The screen is a ceiling rather than one more opinion, which is why the last
  two sources are an `||`.** `live` means frames get repainted in place and a
  pipe has nowhere to repaint, so nothing can ask for animation into one -- the
  same asymmetry `refineColorLevel()` is written down for, where a reply may
  raise a level and never lower it off the floor a pipe produced. It is what
  keeps a forced `reducedMotion: 'no-preference'` from writing a line per reveal
  step into a log file, and it answers the ticket's fourth question: the three
  states need an order, and a non-TTY sets the ceiling at `reduce` while `quiet`
  sits under it where anybody asked.

#### Quiet is a backend, because a backend is what decides bytes

- **The sink is not the first thing to reach for and the two cheaper shapes were
  each measured wrong.** Returning an **empty tree** from the build looks like
  the smallest change and leaves a line behind: `mountLive()` writes `"\n"` at
  construction to reserve the row, measured, so a quiet spinner printed a blank
  line per mount. **Not mounting at all** is worse than a line -- `await
  decrypt(text)` is settled by an effect created inside the build, so a mount
  that skipped the build never resolves it and the promise **hangs**, also
  measured. What a component needs in order to finish is to be _told the level_,
  which every built-in already reads as "do not move", so a quiet component takes
  the same path a piped one takes and ends at once.

- **So the tree is still built and its effects still run, and that is not
  waste.** It is what makes a quiet run work at all. What a quiet frame costs is
  a layout against one cell and no paint, and what stops the bytes is the absence
  of a `terminal.write()` anywhere below.

- **A real `Canvas` is kept rather than faked**, because the renderer reads
  `canvas.cells` and `canvas.stats`, and a canvas that lies about its own size is
  a worse thing to hand it than one row of nothing. `active`, `isLive` and
  `origin` all say what is true -- nothing is on screen -- and `locate()` answers
  `false` rather than waiting a round trip for a report about an origin there is
  none of.

- **`render()` invokes no draw, and that half needed its own input.** The
  guarantee is that no method writes through the terminal; the emptiness of the
  canvas is a second guard that was **covering for it**. A sabotage writing
  `canvas.toString()` from `render()` or from `present()` survived, because the
  draw is never invoked so the canvas is blank so the write is the empty string
  -- two guards covering for each other, which is the shape this file records for
  `eaten` and for the `claimed` set. A canvas painted **by hand** separates them,
  and `present()` is the one member only that can reach: the renderer calls
  `render()` and `done()` and never `present()`, measured, so the interface's own
  documented second mode -- "paint it directly and call `present()`" -- is an
  app's path rather than the framework's.

- **What it leaves is `painted: needPaint` true for a frame nothing painted**,
  which a `gatherStats` consumer would read as one. Written down rather than
  fixed: a quiet run has no audience for frame stats either.

#### The three lazy facades write through the terminal, and `mountLevel()` is why

- **`write()` is "a line that stays, above the frame", and with nothing mounted
  there is no frame** -- so the spinner, the typewriter and the decrypt wrote
  straight through the terminal, which bypasses the backend and therefore the
  fold. Reproduced as `"leaked\n"` on all three. Found by the first review round.

- **The second shape is the common one**: `settle()` clears `mounted`, so every
  `write()` after a `succeed()` takes the unmounted branch. A quiet spinner that
  finished and then wrote a line leaked it.

- **So `mountLevel()` is the same fold asked without mounting**, with the same
  inputs `mountLive()` resolves from -- which is the thing that makes it one
  mechanism rather than a second guard: a caller that assembled the inputs itself
  would be the drift this axis exists to remove.

- **It costs 10.2ms per 100,000 calls, and 94% of that is one `process.env`
  read.** Which is the more useful fact than the number: `mountLevel()` passes no
  `env`, so `forcedMotion()` reads `process.env.SIGIL_REDUCED_MOTION`, and
  `process.env` is a proxy over the real environment where each property read is a
  host call. Measured over 100,000 calls after 200,000 of warm-up, five timed runs
  each -- `mountLevel({ terminal })` is **10.17ms** and `resolveOutput({ live:
  false })` is **10.04ms**, so the fold is all of it; the same call with an
  explicit `env: {}` is **0.75ms**. Three fresh processes agree to within half a
  millisecond.

  Written out because a review round could not reproduce the figure and got about
  a millisecond, which is what the last row is: a measurement of this fold that
  passes an `env` is measuring something the real call path does not do. It is
  nothing either way -- the question is asked once per `write()`, and nothing
  writes a hundred thousand lines -- and the shape is worth knowing before
  somebody puts the fold inside a loop.

- **`createProgress` is the one facade that mounts eagerly, so it needs the gate
  twice.** A bar built **before** the request leaked `"Uploading 0%\n"` and every
  update after it; gating `draw()` and `write()` reduces that to the single
  construction frame, measured. Deferring the mount was the obvious fix and is
  refused by a measurement: it deletes the `0%` line a loud bar prints at
  construction, which is a byte an existing app gets today.

- **A mount's level is resolved once, so those gates can only suppress.** Which
  is the recorded design read in the other direction, and it cuts one way: a
  component built **under** a request holds the sink for its life, and lifting the
  request does not start it drawing -- measured, a bar built quiet and then handed
  a `setQuiet(undefined)` goes on writing nothing even where the fold now says
  `reduce`. Right for the lifecycle an app has, one `main()` and one request with
  every component built inside `run()`; what reaches it is a caller lifting the
  request mid-run, which is a test's teardown or a demo. Re-resolving per frame
  would mean swapping a backend out from under the renderer, and nothing has
  asked. Found by the fourth review round and pinned, so it is a decision rather
  than a surprise.

- **`done()` and `stop()` are deliberately not gated, because giving the terminal
  back is not progress.** The inline backend's teardown writes a newline and shows
  the cursor, and `stop()` erases the region and shows it -- and a quiet run that
  left the cursor hidden is the terminal-eating failure `Terminal.restore()` is
  written for. Measured on a terminal for a bar built loud and then asked to be
  quiet: `stop()` is eleven bytes of erase-and-show and `done()` eight of
  newline-and-show, and neither is a percentage or a label. The erase is also what
  takes the construction frame the entry above calls residue back off a screen,
  which is the better answer rather than a cost. `draw()` is gated and the mount's
  own teardown is not, which is one line of asymmetry that needed saying.

#### A result is not a progress report

- **The line is between what a command says and what it says while working**, and
  it is written on `output.ts` where a reader looks for it. `sigil check`'s
  diagnostics are the answer to the question it was asked, and a quiet mode that
  swallowed them would make the command useless; its summary is a report about
  work done. So an error survives, `--help` survives, a `table()` survives, and a
  prompt survives.

- **It is `mountLive()`'s rule and never `render()`'s**, which is where the line
  falls on the drawing side. `mountLive()` is exactly the set of things that draw
  _beside_ an answer; `render()` is an app drawing its own tree, which **is** the
  answer -- a full-screen app is the program, and blanking one because a script
  wanted data on stdout would be absurd. So `RenderOptions` has no `quiet`.

- **The scroll box reads nothing, and that is a decision rather than a gap.** The
  ticket names it, so a reader has to be able to tell the two apart: it is a view
  of content, so it is on `table()`'s side of the line, and the idiomatic
  scroll-box app hands a tree to `render()` rather than to a mount. An app that
  wants a quiet view of its own gives `render()` a `createSinkCanvas()` backend,
  or does not build the tree -- the escape hatch is named for the same reason the
  classification is, because "pass it to the mount" would be offering a spelling
  that app does not have.

- **`table()`, `largeText()` and `qrcode()` are on the result side by their own
  shape**: each returns a string and the caller does the writing, so quiet is the
  caller's statement about its own `write()`. `enableDebugOverlay()` is with them
  -- it is diagnostics about the program, which survive the way an error does.

- **A prompt says `quiet: false`, which is the one statement above the request.**
  A dialogue is not progress, and a silenced one waits forever for an answer to a
  question nobody was shown. It is set after the caller's options rather than
  before, so it cannot be overridden: a prompt that could be silenced is a hang.
  What that costs is that a prompt **discards** the value, so it cannot refuse a
  bad one -- `text({ quiet: 'nope' })` asks its question where
  `createSpinner({ quiet: 'nope' })` throws, which is the throw timing differing
  rather than the strictness.

#### The flag: where it lives, and the four questions

- **It is the framework's, on the root, the way `--help` and `--version` are --
  and that answers the ticket's first question.** Every CLI that reports progress
  wants a way to stop, and before this each had to pass the answer by hand into
  every spinner, bar and note it builds. Passing it by hand is the half that
  cannot work: a built-in is built inside a command's `run()`, so one missed call
  site is a flag that parses and does nothing. And it survives `sigil build` for
  the reason `--version` is written down for -- the build generates the executable
  and calls `main()`, so whatever an app wrapped around `main()` is not in the
  bundle, and the schema is the one thing carried across whole.

- **Its value never reaches `argv`, which is `parserOwned`.** A flag always has a
  value, and an app that never declared `--quiet` should not find `quiet: false`
  on one of its own destinations. What a command that wants to know asks is
  `resolveOutput()`, which is the resolved answer rather than one of its four
  sources -- a mount told `quiet: false` would make `argv.quiet` a lie.

- **There is no environment variable, and that is the second question's
  answer.** `SIGIL_COLOR_SCHEME` and `SIGIL_REDUCED_MOTION` are each the user's
  override of a **detection** -- the framework guessed and the variable corrects
  the guess. Quiet is not guessed: it is asked for, and the place to ask is argv.
  A variable would also break the declaration-respecting rule from behind: an app
  whose `--quiet` means something of its own keeps it and gets no flag from the
  framework, and a variable would silence its built-ins anyway without going
  through the declaration it owns. `setQuiet()` is the programmatic door and
  `MountOptions.quiet` is the per-component one.

- **It is `setQuiet()` rather than `requestQuiet()`, because nothing receives a
  request.** The function assigns a module-level slot; there is no recipient, and
  the one thing that outranks it -- a mount's own `quiet: false` -- is the next
  rung of the precedence chain rather than a refusal. `request` also already
  means something else in this package: `requestMode()` writes a DECRQM query
  the terminal answers, so it has a respondent, a reply and the possibility of
  silence, and one verb doing both jobs a few modules apart is the drift this
  file deletes everywhere else. `setColorLevel()` is the structural twin down to
  the details -- a process-wide slot, a value or `undefined` for "nobody said",
  a `void` return, validated on the way in, overriding what the framework would
  otherwise work out -- so `setQuiet()`/`getQuiet()` is `setColorLevel()`/
  `getColorLevel()`'s pairing rather than a new convention. What `request` is
  left meaning here is what the **user** does through `--quiet`, which is why
  the prose still says it and the private slot is still `requested`.

- **`--verbose` is not the same axis, which is the third.** Verbosity is how much
  a command says about its **answer**, which is the command's own business: the
  framework cannot know what "more" means for an app's output, so a `--verbose` it
  added would be a flag no built-in could read -- the same defect in the other
  direction. The framework's own half of that question is already `DEBUG` and
  `src/debug/`. One numeric knob with quiet at the bottom would mean inventing the
  middle of a scale nobody has asked for.

- **Nothing is added over the top of a declaration, and the asymmetry is the
  surprising half.** `find()` answers about spellings and `has()` about the
  registry key, which is an option's name, and **both** have to be free. A taken
  `-q` costs the app only the short form; a merely-_named_ `quiet` costs it the
  flag **entirely**, because replacing a registry key is a worse thing to do to an
  app than declining to add a spelling. The two halves are not the same check and
  a sabotage said so: an option declared `--quiet` is also _named_ `quiet`, so
  `has()` covers for `find()` until the name is explicit --
  `{ hush: { format: '--quiet [level]', name: 'hush' } }` is the input that
  separates them, and left to `has()` alone the framework's own `add()` replaces
  the spelling and the app's option becomes unreachable.

- **A subcommand that declares its own reaches backwards over the root's**, which
  is the parser's context rule rather than anything here and is worth saying
  because it is not what "shadows it for itself alone" sounds like: options
  resolve across the whole chain, so a nearer valued declaration owns the
  destination a bare root use wrote -- and `mycli --quiet work`, on an app whose
  `work` declares `--quiet <level>`, is `Missing required options: --quiet` rather
  than a quiet run. Confirmed by probe. The app claimed the spelling, so it owns
  what every use of it means.

- **Its description is one key, because an app's user reads it.** `Suppress
  progress, not results` joins `SIGIL_KEYS` beside `Show help for a command` and
  `Print the version`, which is the line the i18n work drew: the framework's own
  developer-facing errors stay English, and a free flag's row on the help screen
  is read by the app's user. `SIGIL_KEYS.length` is the figure.

- **Any typed true wins, in either order, and `--no-quiet` is not a negation.**
  `--quiet --quiet=false` is quiet, which is `--help`'s own rule rather than a
  decision taken here -- the three flags of this shape read argv the same way, and
  changing one inside a ticket about another is how they come to disagree. The
  spelling somebody reaches for to undo it is `--no-quiet`, and a `no-` twin is
  created by _declaring_ one, so it lands on `argv` as an undeclared option
  instead. Both are pinned rather than argued.

#### `main()` restores what it attached, and the restore is an undo

- **A boolean has no identity, so the slot carries a token.** `main()` records
  the request and puts it back on the way out, and the first version compared the
  **value** -- which cannot tell "nobody wrote since" from "a command asked for
  the same thing", so a command that called `setQuiet(true)` through the
  documented door had its own statement reversed when the run ended. Found by the
  second review round. `quietGeneration()` is the answer and it is the shape of
  check `unanchor()` gives a reply about an anchor that has moved: a token that no
  longer matches is stale and is not acted on. `captureConsole()`'s own
  `restoreOne()` can compare the function it installed; a `true` cannot be
  compared to a `true`.

- **And the restore is a _rewind_ rather than a write, which took a fourth round
  to find.** Spelled `setQuiet(before)`, the restore moves the token -- so a
  **nested** `main()` whose argv also asked for quiet made the outer run's own
  token stale _by putting the outer's value back_, and the outer `finally` then
  declined to clear what it had attached. Measured on the shape the README
  documents, `await main({ argv, schema })` inside a `run()`: after both returned
  the process was still quiet, and the next run with nothing in argv was silenced
  by it -- which is exactly the leak the restore exists for, reached through the
  one door nobody had tried. `rewindQuiet()` puts the value _and_ the token back,
  so the two runs unwind as a stack.

  Rewinding the token is as safe as rewinding the value and for the same reason:
  the caller only reaches it where the token still matches, so nothing has
  happened since and what goes back is the whole state that token named. The token
  may therefore go down and be allocated again, which is benign -- a later write
  that reuses a number is a different statement, and the run whose token it was
  has gone. Pinned at two levels and at three, with the cost asserted as well as
  the flag: the run _after_ the nested pair is what the leak is paid for in.

- **A statement made inside a run outlives it, deliberately.** This is a
  statement about the process, so the consequence worth knowing is that a nested
  run can countermand the outer one's flag for the rest of it: there is one slot
  and the inner statement is the more recent. One process, one intent.

- **The generation counter is not in the `style` barrel.** `main()` is the only
  reader and a counter is nobody's business outside the package.

- **Strictness is about the two values and deliberately not about
  `schema.quiet`.** Truthiness is wrong in the direction that costs: `'false'`
  and `new Boolean(false)` are both truthy, so `setQuiet('false')` silenced
  the whole process and `createSpinner({ quiet: 'false' })` silenced the spinner,
  each measured. Neither is a value anybody meant and there is no third answer to
  fall back to, so it is refused where it was written -- the call a non-boolean
  `hidden` already gets. `schema.quiet` keeps `schema.help`'s and
  `schema.completion`'s `=== false` posture instead: a garbage value there offers
  a flag nobody wanted, where a garbage value in a mount loses output somebody
  did, and the three free flags agreeing with each other is worth more than this
  one being the strictest.

#### The toolchain has one reader, and the piped bytes did not move

- **`isQuiet()` in `report.ts` is it**, and it reads `getQuiet()` rather
  than calling the fold with a destination that could not change the answer. The
  summary and the note are suppressed and a **diagnostic never is**: that is the
  rule said in the one place both writers pass through, rather than at each call
  site.

- **`sigil build` printed two tables of what it produced**, which is the summary's
  own subject at greater length, straight to stdout. Found by the second review
  round -- so a quiet build lost its one-line summary and kept the same thing
  spread over twenty. Asked once around both printers rather than inside each,
  because the question is "is this progress" and a printer answers "here is a
  table".

- **`sigil add`'s separators go with the notes they precede**, which took three
  instances: a quiet `add` that dropped a note and kept its blank line is one
  where "nothing" is not nothing. The separator above the **confirm** stays,
  because it is a separator before a _prompt_. The declined note goes through
  `writeNote()` rather than a raw write, so the two outcomes of one dialogue are
  treated the same way -- and that one is only reachable with a terminal on both
  streams and a key, which is why nothing pinned it until a sabotage said so.

- **Piped output with quiet off is byte-identical, measured against `main`'s own
  built binary.** `check` over three fixtures, `check --tree`, a bare run and
  `--version` are identical on stdout, on stderr and in the exit code. What
  differs is exactly three screens plus the completion script -- `--help`, `help
  check` and the bare help screen each gained the row `-q, --quiet    Suppress
  progress, not results`, and the script offers two more candidates. Which is the
  flag existing rather than a byte moving, and it is the honest form of the claim:
  nothing that reports got quieter or louder.

> Moved: _What the four review rounds found_, _What the sabotage pass found, and the two declared survivors_ — see [docs/history/a-quiet-axis-one-place-that-decides-whether-anything-may-dra.md](../../../../docs/history/a-quiet-axis-one-place-that-decides-whether-anything-may-dra.md).

#### What is deliberately out

- **A `RenderOptions.quiet`**, for the reason the scroll box is a result: quiet is
  the mount's rule and `render()` is an app drawing the answer.
- **An environment variable**, with its reason above.
- **`--verbose`**, likewise.
- **Validating `schema.quiet`**, which is a change to `schema.help` and
  `schema.completion` taken inside a ticket about a third flag.
- **A numeric level**, which would mean inventing the middle of a scale.
- **Suppressing a prompt**, which is a hang.

### Style

- **The property table is the single source of truth.** Every property's initial
  value, whether it inherits, and how it is read all live in one object, and
  everything downstream -- the cascade, the layout engine, invalidation,
  animation -- reads it rather than carrying a list of its own. A property is
  added in one place or it is added wrong.
- **An element's style before the cascade has spoken is one shared frozen
  object.** `LayoutNode` needs a style so that a tree can be laid out before
  anything has resolved one, and building a fifty-property one per element meant
  every element paid for two -- the one its constructor made and the one the
  cascade replaced it with. Frozen for the reason the initial values are: a style
  is the cascade's to write, and an element that mutated a shared one would be
  rewriting what every unsettled element in the process looks like.
- **Every `Length` is frozen, and so is every initial value.** `readonly` is a
  TypeScript fiction at runtime, and one shared `AUTO` was the initial value of
  ten properties -- so a single in-place mutation anywhere downstream, which is
  the obvious optimization in a layout resolver, rewrote `width`, `height`, every
  `min` and `max`, `flex-basis`, and all four insets on every style in the
  process. `canvas/style.ts` freezes interned styles for exactly this reason.
- **`auto` and `none` are different answers.** `width: auto` means size to
  content; `max-width: none` means unbounded. One sentinel for both made
  `max-width: none` -- an ordinary declaration -- impossible to write.
- **A number is read against a CSS `<number>` grammar, not by `Number()`.**
  `Number('0x10')` is 16, and hex is not CSS syntax; the parser's own `int` takes
  it deliberately for CLI arguments and should not leak in here by accident of
  reaching for the same function. An integer past 2^53-1 is refused for the
  reason the parser's data types already record: it comes back as a _different_
  integer, which is the one failure a caller cannot detect.
- **A boolean property reads the same vocabulary as the parser's `bool`** --
  `yes`, `on`, `1`, and the empty string all mean there what they mean here. A
  second, narrower spelling of one idea is how two parts of one library come to
  disagree about what `on` means.
- **A shorthand resets every longhand it covers, including the ones a given use
  did not mention.** That is CSS, and it is why `border: red` famously draws
  nothing there. `border` and `flex-flow` were leaving the omitted half alone, so
  `border: single` after a `border-color: red` kept the red.
- **Initial values follow CSS except where a terminal changes the answer, and
  each exception is written down.** `box-sizing` starts at `border-box`, because
  `width: 20` meaning twenty columns on screen is what everybody means and a
  border silently making it twenty-two is the surprise. `display` starts at
  `flex`. `z-index` starts at `0` rather than `auto`, since the paint order is
  flat enough that "does not establish a stacking context" has nothing to bite
  on. `position` starts at `static` and that is _not_ an exception: the insets
  are read only on a `relative` box, so defaulting to `relative` would make every
  stray `top` in a stylesheet move something.
- **`background-color` and `text-overflow` do not inherit**, as in CSS. A
  container's background showing through its children is paint order, not the
  cascade; pushing the value down would make every descendant _own_ that colour.
  The text decorations do inherit here, which CSS reaches by propagating lines
  across descendants rather than by inheritance -- a cell grid has no box
  structure to do that with, so this is the deliberate simplification.
- **A property name resolves in both spellings, and in any case for the kebab
  one.** `background-color` in a stylesheet and `backgroundColor` in a props
  object are both written; aliases and shorthands resolve both ways too, which
  they did not at first. Lowercasing is what a case-insensitive kebab lookup
  needs and exactly what destroys the camelCase one, so the two are tried
  separately rather than funnelled through one normalization that cannot serve
  both. `BackgroundColor` is not recognised and is not meant to be -- the
  camelCase spelling is a JavaScript identifier, and identifiers have a case.
- **One unit, and it is a cell.** A bare number is cells; `ch` is accepted as a
  synonym because people type it. A fractional length is _refused_ rather than
  rounded: rounding silently is how a layout ends up a column out with nobody
  able to say which declaration did it.
- **A named colour stays a palette index.** The basic sixteen are whatever the
  user's terminal theme says they are, so resolving `red` to a specific RGB
  overrides a choice they already made.
- **`text-overflow` is read off the text's own box and bites only where a line
  does not fit.** It parsed and did nothing for as long as there was nothing
  that had to fit text into a column, which is the rule about a property the
  engine ignores said one layer along -- and the table's `truncateCell()` was
  what it was supposed to be. It applies to a line wider than the box it was
  given, which for wrapped text never happens, so in practice it is what
  `white-space: nowrap` costs: exactly as in CSS. Read off the text element
  rather than inherited, so a container setting it does not silently cut every
  descendant. The cut itself is `truncate()` in `@ttylabs/sigil/wrap`, which
  is one implementation with four modes rather than a helper per caller -- and
  the _arithmetic_ under it is `cutAt()`, which is one step further and is
  there because `truncate()` is not the only reader. A `raw` that paints text
  honours the same property and cannot use the same walk, since a cell is not
  a cluster; what the two share is which columns survive and what goes between
  them. See "A decrypt effect" in `src/components` for the reader that forced
  the split.
- **The attribute properties are derived from the table, like the colour ones.**
  `flag()` is used for the terminal's seven attributes and for nothing else, so
  what it was asked to build is the answer -- and a hand-written list is a second
  list to keep in agreement, which is the entry `COLOR_PROPERTIES` already
  carries.
- **Every numeric parser refuses an empty value.** `Number('')` and `Number(' ')`
  are both `0`, so an empty declaration reads back as a real-looking zero -- the
  same trap the parser's `number` and `int` data types already carry an entry
  for. `50%` minus its sign is exactly the string that reaches this.
- **`font-weight`, `font-style`, and `text-decoration` map onto the attributes a
  terminal has.** They are the spellings people reach for, and refusing them to
  insist on `bold: true` would be pedantry. A _numeric_ weight is still an error,
  because there is no axis between bold and normal to put `600` on.
- **A border given only a colour is still a border.** CSS draws nothing for a
  `border-color` with no `border-style`, which surprises everyone; this defaults
  the style to `single`. It is the one deliberate divergence in the shorthands.
- **A shorthand reports against the longhand that could not take the value.**
  Shorthands expand to source text and the longhand parsers do the reading, so
  `padding: 1 nonsense` fails at `padding-right` rather than at `padding` -- the
  shorthand could not have said which part was wrong. That means each longhand
  has to carry its _own_ name; the padding parsers all said "padding", which is
  the message the shorthand would have given anyway.
- **Every lookup table here is null-prototype, and every lookup uses
  `Object.hasOwn`.** The same entry Conventions already carries for the parser's
  registries, rediscovered: on a plain object `constructor` and `toString` read
  back truthy, so `isKnownProperty('constructor')` was true and
  `declare({ constructor: 'red' })` was a `TypeError` from somewhere inside
  rather than an error anybody could act on.
- **A CSS property that maps onto two longhands resets both.** `font-weight:
  normal` did and `font-weight: bold` did not, so a `bold` left an earlier `dim`
  standing. Same rule as `border` and `flex-flow`, and the same bug in a third
  place.
- **`none` parses only where "no limit" is a thing to say.** Accepting it on all
  fourteen length properties made `width: none` and `margin: none` parse and then
  behave as `auto` or as zero -- not CSS, and not what the author meant.
- **A keyword list is frozen too, not just the slot holding it.** `Object.freeze`
  on a definition freezes the reference, and `parseKeyword` closes over the same
  array -- so a push onto `PROPERTIES.display.keywords` made `display: grid`
  parse. Same hole as the one below, one level further in.
- **The property table is frozen, definitions included.** The initial values were
  frozen and the slots holding them were not, which is the same TypeScript
  fiction one level up: `PROPERTIES.width.initial = cells(7)` changed what
  `declare()` returned for every style in the process.
- **Margins take a length and paddings take a count.** `auto` is how a box is
  centred and how it is pushed to one end, and a negative margin is a real
  thing; neither is true of padding.
- **`position` takes all four keywords, and the insets are a length.** `absolute`
  was a parse error for as long as there was no out-of-flow engine, on the rule
  that a keyword which parses and does nothing is worse than one that does not
  exist -- and the same rule admits it, and `fixed`, now that there is one. What
  the table offers is what the engine honours, which is also what the utility
  generator builds a rule per entry from, so `absolute` returning to `keywords`
  is what puts `absolute` in the utility set. The insets are a length rather than
  a count because pushing a box back the way it came is the ordinary use and a
  negative value is how CSS says it.

### Stylesheets and the cascade

- **The sheet supplies defaults and props win, per property.** A sheet setting
  `color` and a prop setting `padding` both apply, and the prop only beats the
  sheet on properties it actually names -- which is where `style=""` sits in a
  browser, so it is the familiar rule rather than a new one. The useful
  consequence is a fast path: a prop write cannot change any _other_ element's
  resolved style, so it skips the cascade entirely. `resolveSheets()` hands back
  a `CascadeResult` that a caller keeps, and `applyProps()` re-applies props over
  it with no selector matched and nothing else touched.
- **No attribute selectors.** They were in the original sketch and are
  deliberately out: if a rule can match on a prop, then writing a prop can
  restyle some other element and the fast path above disappears. State a
  component would have expressed as `[disabled]` goes through a class or a state
  pseudo-class instead. Cheap trade for a clean invalidation boundary, and the
  error message says so rather than reading as an unimplemented feature.
- **The selector engine takes a `StyleNode`, not an element**, for the reason
  the layout engine takes a `LayoutNode`: this is the layer testable with no
  terminal, no renderer, and no reactivity, and it keeps that only by not
  knowing what an element is. There is no bag of attributes on it, which is the
  same decision as the one above seen from the other side.
- **The cascade sorts by layer, then origin, then specificity, then source
  order.** The standard algorithm with the one axis a terminal UI needs added;
  inventing a different one buys nothing and costs everyone's intuition. The
  layer axis is what the utility layer (SIG-80) proves is necessary:
  `.button { padding: 4 }` and `.p-2 { padding: 2 }` are both `(0,1,0)`, so
  without layers the winner is whichever sheet happened to be concatenated last.
  It is here now rather than later because retrofitting an ordering axis into a
  shipped cascade changes the meaning of every stylesheet written against it.
- **The three layers are fixed and an author cannot declare more.** `base`, then
  `components`, then `utilities`. Fixed is smaller and nobody has a case for a
  fourth; `@layer mine` and the bare `@layer a, b;` ordering statement are both
  refused rather than quietly accepted, since the second would be a lie.
- **A rule outside an `@layer` block is in `components`.** That is where a
  hand-written app or component sheet belongs -- it is precisely what the
  utilities layer has to be able to beat -- and it is why the default is not the
  CSS answer, where unlayered rules outrank every layer.
- **`!important` inverts origin and layer, and nothing else.** Specificity and
  source order are never inverted, which is CSS. The inversion is the whole
  reason `!important` is retained: a component copied in by `sigil add` that
  bakes `color="red"` into its template would otherwise be unthemeable with no
  recourse. The convention that goes with it is that component templates set
  classes, not style props.
- **Props are the band between normal and important, and they never carry a
  precedence.** Applying them last and skipping the properties an important
  declaration won says exactly the same thing as giving them a band of their
  own, and it is the fast path rather than a second pass over the rules.
  `CascadeResult.locked` is how that survives being cached.
- **The cascade hands back a plain resolved style per element; interning is the
  canvas's business.** That settles the question the ticket left open. A
  resolved `Style` is fifty-odd properties that mostly differ per element, while
  a canvas cell style is a foreground, a background, and some attributes
  repeated across thousands of cells -- interning pays there and not here, and
  the renderer maps one to the other at paint time.
- **A rule's selector list reports the highest specificity that matched.** A
  rule written `#go, box { ... }` behaves as though it were written once per
  selector, which is CSS; matching it once per bucket and keeping the best is
  how one rule with several selectors avoids being counted twice.
- **Matching is right-to-left and rules are bucketed by their rightmost simple
  selector** -- an id, else the last class, else the type, else the universal
  bucket -- so an element only tests rules that could possibly match it. Worth
  keeping in proportion: browsers optimize this hard because they have ten
  thousand elements and ten thousand rules, and a terminal UI has a couple of
  hundred of each. Naive may simply be the permanent answer; see SIG-65.
- **An element with no parent is a first child.** It has no siblings, so it is
  the first of them, which is what browsers answer for the root element.
- **`:hover` parses and matches nothing.** Mouse tracking does not exist yet and
  the selector engine must not assume it never will; a selector that reads
  correctly and matches nothing is an answer, and one that throws is a missing
  feature somebody works around with a class they then cannot remove.
- **Types, classes, and ids match case-sensitively; keywords do not.** They are
  JavaScript-land names rather than CSS keywords, so `Box` and `box` are
  different elements, while `:FOCUS` and `inherit` are read in any case the way
  every property name already is.
- **`inherit`, `initial`, and `unset` are cascade-level and a value parser never
  sees one.** `inherit` is not a colour, and it is not fourteen other things
  either, so they are recognised once rather than added to every grammar --
  which is also why `readDeclarations()` refuses them: "what does this
  declaration set" has no answer for `inherit` without a parent, and only
  `declare()` and the cascade have one. `currentcolor` is deliberately not among
  them: it needs a resolution order of its own -- a value depending on another
  property of the same element, resolved after the winners are picked -- and
  nothing needs it yet.
- **A shorthand carries the longhands it covers, next to its expander.** The
  cascade asks for the set before there is a value to expand, since
  `padding: inherit` has to reach all four edges, and a list kept in a second
  table is a list that drifts. The three multi-longhand aliases -- `font-weight`,
  `font-style`, `text-decoration` -- carry theirs the same way.
- **One scale for colour in a media query, and it is `ColorLevel`'s 0-3.** CSS's
  `color` feature counts bits per component; a second, narrower spelling of a
  scale the library already has is how two parts of one library come to disagree
  about what `2` means. Media types and `not`/`only` are out: there is one
  medium, and the other two exist to hide queries from parsers that predate them.
- **An unknown property in a stylesheet is an error, not a skipped
  declaration.** CSS skips because the web has to survive a sheet written for a
  browser that does not exist yet; a CLI ships its sheet with its runtime, so a
  typo is a bug and reporting it where it was written is worth more than
  forward-compatibility nobody needs.
- **A stylesheet error says which line, and the line is counted only when one is
  thrown.** The parser carries indices rather than lines, because counting
  newlines per rule makes parsing a sheet with nothing wrong with it quadratic
  in its own length.
- **Comments are removed by the cursor, not by each reader.** A comment may sit
  anywhere, mid-selector included, and every reader downstream would otherwise
  have to know that -- and a semicolon inside one is not a declaration boundary.
- **A backslash escapes the next character in an identifier, and the name that
  comes back is unescaped.** `.md\:flex-row` is how a class _called_
  `md:flex-row` is written, because the colon means something else to this
  grammar -- which is what Tailwind does and why its class names are legal CSS.
  What the name is compared against is the class an element carries, so it is
  the unescaped form that is stored. CSS's hex escapes (`\3a `) are deliberately
  not read: nothing generates them and they carry a trailing-space rule that is
  its own source of surprises.

### Colour degradation

- **Degradation happens at resolve time, not at paint time.** The cascade
  produces a resolved style and degradation is the last pass over it, so the
  canvas only ever holds colours the terminal can actually emit and the diff
  never compares a colour against its own approximation. The depth it degrades
  to is `media.colorLevel` -- the same number `@media (color-level: N)` reads, so
  an author's override and the automatic ladder cannot disagree about what depth
  they are on.
- **Level 2 never _lands_ on `0`-`15`, and level 2 never _rewrites_ them
  either.** Those sixteen are whatever the user's theme says they are, so
  quantizing an ordinary colour onto one makes the answer depend on a setting
  nothing here can read -- the cube and the grey ramp are fixed by the spec and
  are the only targets. A colour _declared_ as one of the sixteen is the other
  half of the same rule and passes through untouched, because AGENTS.md already
  records that a named colour stays a palette index. Getting this backwards
  turned a declared `blue` into the cube's `#0000ff` and overrode a choice the
  user had already made.
- **Matching is in Oklab, not in RGB.** The sixteen are perceptually scattered
  rather than evenly spaced, so RGB distance picks visibly wrong answers --
  `#ff8800` is numerically nearer xterm's green than its red, and perceptually
  nowhere near it. Oklab over CIELAB because it is simpler and better behaved
  around blues; either beats RGB, which is the thing actually worth avoiding.
- **Nothing is invented at level 0.** Colour is dropped and no attribute is
  synthesised to carry what it meant: turning red into bold makes red and blue
  both bold, which preserves the emphasis while destroying the distinction it is
  pretending to keep. The rule that follows is a rule for components rather than
  for the degrader -- do not encode meaning in colour alone -- and it is an
  accessibility argument as much as a compatibility one.
- **Level 0 is plain text, attributes included.** Not only the colours: the seven
  attributes go too, which is what the styler has always meant by it -- at level
  0 `ansi.bold()` hands back the string it was given, so this is parity with the
  library's own behaviour rather than a new rule. The two ways a process arrives
  at level 0 are a pipe and `NO_COLOR`, and neither wants `ESC[1m` in the file it
  is writing. It is also what makes a prompt asked for plain text plain: the
  caret is `inverse`, and a caret drawn at level 0 would be the one sequence
  nothing could switch off. Done in `degradeInto()` rather than at emission, so
  the canvas and the string renderer cannot come to disagree about it -- the same
  reason degradation happens at resolve time at all.
- **A background degrades exactly like a foreground.** The argument for treating
  it differently is that a wrong background is more visible, and that argues for
  a _better_ match rather than a _different_ one; Oklab is already the better
  match, and a second metric would be two tables and two sets of surprises.
- **`NO_COLOR` comes through this path rather than short-circuiting.**
  `supportsColor()` already reads it and answers `0`, the renderer puts that on
  `media.colorLevel`, and level 0 drops colour. One mechanism is easier to
  reason about than two, and it means `@media (color-level: 0)` is a thing an
  author can write.
- **A `CascadeResult` carries the depth it was resolved at.** A prop can name a
  colour, so the fast path has to degrade too -- and a `level` argument on
  `applyProps()` defaulting to truecolor is a fast path that silently disagrees
  with `resolve()` on exactly the terminals degradation exists for. The depth
  travels with the result that was resolved at it.
- **The colour properties are read off the property table, not listed again.**
  A hand-written list is a second list to keep in agreement, and a fourth colour
  property that it missed would parse and cascade and then quietly skip
  degradation -- a wrong colour on screen with nothing to point at. Same rule
  `INHERITED` already follows.
- **The Oklab `b` row is the value that sums to zero, not the published
  transcription.** For D65 white the LMS rows each sum to one, so `l`, `m` and
  `s` are all 1 and the `a` and `b` rows have to sum to exactly zero or a grey
  acquires chroma. The `a` row does; the published `b` row leaves a residue of
  3.7e-8, a bias in one direction on every neutral colour there is. The test
  pins the property rather than the digits.
- **The memo is never evicted, because what reaches it is a declared colour.** An
  app has a few dozen of those, not the 16.7 million a cap would be protecting
  against -- a gradient painted cell by cell goes to the canvas directly and
  never passes through the cascade at all.
- **The basic sixteen are matched against the xterm defaults.** Terminal themes
  make them unknowable, and being wrong for somebody running Solarized is a
  smaller failure than refusing to degrade.

### The utility layer

The generator lives in `packages/cli/src/utilities/`; its output lives in
`packages/sigil/src/style/utilities.ts`, generated and committed. That split is
the `east-asian-width.ts` one and it is what the original wording -- "a
generator and a stylesheet rather than anything the runtime knows about" --
turns into once an app actually has to get the sheet from somewhere. Reading
`PROPERTIES` and parsing every declaration on the way out is toolchain work; a
few hundred rules of CSS is a string constant, and a string constant is not a
dependency. Regenerate with `node scripts/generate-utilities.mjs` from inside
`packages/cli`, then `pnpm fmt`; `the committed sheet` in
`packages/cli/test/utilities.test.ts` fails if the two have come apart.

- **A utility is a generated stylesheet rule, and nothing in the runtime knows
  the difference.** `p-2` is `.p-2 { padding: 2 }` -- the same class selector,
  the same specificity, the same cascade. No new resolution path, no new
  precedence rule, nothing added to the matching engine. It is a rule rather
  than an implementation detail because the obvious optimization breaks it: the
  moment somebody special-cases `class="p-2"` into a direct property write it
  becomes a parallel mechanism with its own precedence, its own bugs, and a
  divergence from the cascade that only shows up where nobody tested.
- **The keyword lists live on the property table, not in the generator.** They
  used to be reachable only inside each parser's closure, so the table could say
  whether a string was accepted but not what a property accepts -- and a
  generator had to carry a second copy of all sixteen lists and go quietly out
  of date. `fromKeywords()` puts one list where both the parser and the
  generator read it, so a keyword added to a property gets its utility free.
  What that list holds is what the engine accepts rather than what CSS has, and
  `position` is where the two part: `absolute` is a parse error, so it is out of
  the list as well, and the two utilities generated are the two that do
  something. Leaving it in would have generated a rule that the generator's own
  parse-on-the-way-out then refuses -- the build failing closed, which is that
  check working, and still not a table worth shipping.
- **What the table cannot supply is the naming, and that is the honest split.**
  The table knows `justify-content` takes `space-between`; that the utility is
  spelled `justify-between` is ours to decide, and every invented name is one
  somebody has to learn. Tailwind's spelling wherever it exists, ours only where
  a terminal has no web analogue -- `border` meaning one cell of single-line
  border, because a terminal border has exactly one width and `border-2` has
  nothing to mean here.
- **Every generated declaration is parsed on the way out.** A utility that names
  a property the table does not have, or a value the property would refuse,
  fails the build rather than shipping a rule that silently matches nothing.
  This caught `bright-black` on the first run: a fine class name and not a
  colour `parseColor()` takes, which is the hyphenated-class/unhyphenated-value
  split this file is built on.
- **Two utilities of one name is an error.** A class that quietly applies both
  is the failure a generated vocabulary is most prone to, and it happened
  immediately: `hidden` was `display: none` and `visibility: hidden` at the same
  time. Visibility's is `invisible` now, which is Tailwind's spelling anyway.
- **The whole base set ships; there is no scanner.** Tailwind's central problem
  is that the utility space is combinatorially enormous, so it cannot ship them
  all. Here the scale is bounded by the medium -- spacing is a handful of cells
  because there is nothing between one cell and two, there are sixteen colours,
  and the property set is fifty-odd entries -- so the base set is a few hundred
  rules and shipping it whole is much simpler than deciding what to leave out.
- **The base set ships and the variants do not, which is a measurement rather
  than a preference.** `md:` and its fifteen siblings multiply the base set by
  the number of variants: 383 rules and 13 KB become 4,996 and 215 KB, which is
  7.29ms to parse against the base set's 0.63ms. A CLI's whole startup is around
  35ms, so that is a fifth of it spent on rules almost no app names one of.
  `generateUtilities()` still emits them for a caller that asks; what is
  committed is the base set. Style shaking has since landed and does **not**
  change this: `shakeUtilities()` filters the _base_ set by name and then prints
  it with `variants: false`, because what a build shakes has to be a subset of
  the sheet `utilitySheet()` already returns -- a shake that quietly added 4,613
  rules would not be a shake. Shipping the variants means the evidence naming
  `md:flex-row` rather than `flex-row`, which is a separate decision about the
  vocabulary and not one to take inside a size optimization.
- **The sheet is opt-in, and `FRAMEWORK_CSS` is not.** Every app draws a
  built-in eventually and that sheet is the vocabulary a theme restyles, so it
  is parsed for everyone. This one is 383 rules an app may never name a single
  one of, and a CLI that answers `--version` and exits should not pay to find
  that out -- so an app says `utilitySheet()` once. It is an ordinary sheet at
  the ordinary origin either way: the `@layer utilities` it is written in is
  what puts a `p-2` above an app's own `.panel { padding: 4 }`, not anything
  about how it arrived.
- **A generated declaration is spelled the way a stylesheet spells it.** The
  property table's keys are camelCase and a name resolves in both spellings,
  which is exactly what let the two printers in one generator come apart:
  `@apply` emitted `padding-top` while `generateUtilities()` emitted
  `flexDirection`, both parsed, and nobody could see it while the output was an
  intermediate nobody read. It is committed and documented now, so it goes
  through one function that kebabs it -- and that function is the runtime's
  `kebab()` rather than a local copy, which is the same rule `COLOR_PROPERTIES`
  and `INHERITED` already follow. `kebab()` takes a `string` rather than a
  `PropertyName` for a reason worth knowing: `isProperty()` is true of the
  aliases as well as the longhands, so it narrows to nothing, and the body never
  needed the narrowing -- it lowercases capitals, so a name already in kebab
  passes through as itself.
- **Arbitrary values are deliberately out.** `p-[13]` and `text-[#ff8800]` are
  what make the space unbounded again, and they are the reason a scanner has to
  exist at all. They are SIG-81's, along with the question of what a computed
  `class` expression does, which should be answered once rather than twice.
- **Nothing is generated for the animation properties, and the exception is
  explicit.** `animation-direction` and `animation-fill-mode` are keyword
  properties, so the rule above would have handed them a family each; they are
  named in `UNGENERATED` instead, with the reason under "Transitions and keyframe
  animations". The short of it is that both are half a vocabulary without the
  name and the duration beside them, and those are open-ended.
- **Two variants are better here than on the web, and one that was missing is
  not any more.** `md:flex-row` is the responsive problem a TUI actually has and
  nothing solves well today; `c16:text-red` is SIG-61's "give the author control"
  in a shape people already know. `dark:` and `light:` are there now, and the
  sentence they replace said a terminal has no such mode -- it did not until
  `prefers-color-scheme` shipped, and the reason that line and the generator's
  table had to move together is under "Light and dark". Not `hover:` until mouse
  tracking exists.
- **`@apply` is one statement, and an `@apply` in a comment is not one.** The
  name list stops at `;`, `{` or `}`: a regex of `[^;}]+` also matched a brace,
  so `@apply foo { bar: 1; }` swallowed the block after it and a missing
  semicolon ran the list on into the next declaration. Whatever followed the
  last name is put back, since a source transform that eats the space before a
  `}` is one whose output nobody can diff.
- **A comment inside an `@apply` is trivia, not a boundary.** The first fix
  split the source on comments and expanded each side, which made
  `@apply p-1 /* and */ mt-2;` expand half of itself and leave the rest behind
  as a declaration the parser then choked on. Comments are trivia everywhere
  else in a stylesheet -- `#trivia()` and `#until()` in the parser already treat
  them that way -- and this reads them the same. An `@apply` that lives wholly
  inside a comment is still just a note about `@apply`, and an unterminated
  comment is an error rather than a hole to walk through.
- **`@apply` expands at build time into the component layer.** That is where the
  cascade's layer ordering puts a component rule, so an app can still override
  it with a utility -- which is the whole reason `@apply` works in Tailwind.
  Expanding at build time is also what keeps the runtime ignorant: what it sees
  is a component rule with ordinary declarations in it. A _variant_ cannot be
  applied and says so, because it is a rule in another context rather than a set
  of declarations.

### Style invalidation

- **Props do not participate in invalidation.** Props override the sheet per
  property and there are no attribute selectors, so writing a prop cannot change
  any _other_ element's resolved style -- there is no rule that could have
  matched differently. A prop write therefore skips style resolution entirely,
  re-applies props over the kept `CascadeResult`, and marks paint. That is the
  common case for a component updating itself and it costs nothing. It only
  holds because attribute selectors are out, which is why those two decisions
  are one decision.
- **Three dirty bits, each implying the ones after it.** `style`, `layout`,
  `paint`. A style change can move a box so it implies layout; a layout change
  moves what is on screen so it implies paint. `DIRTY_ORDER` is the order a
  frame settles them in and the order they imply each other in.
- **Naive, and measured rather than asserted.** A full re-match of 201 elements
  against 100 rules is 0.67ms median, 1.05ms at p95 -- once per frame at most.
  Browsers build invalidation sets because they have two orders of magnitude
  more of both. Start naive, expect naive to win permanently, and measure before
  believing otherwise. What must not happen is an architecture where the
  optimization could not be added: the seam is the set of elements `update()`
  re-resolves, and narrowing that set is the whole of what an invalidation set
  would do.
- **The guard around that measurement reads the median, not the slowest pass.**
  It took `Math.max` of twenty and compared it to 50ms, which makes a guard
  against _quadratic_ behaviour maximally sensitive to the one thing that says
  nothing about complexity: a single pass stalling because something else on
  the machine wanted the CPU. A macOS CI runner reported 59ms for one iteration
  against a local median of 1.0ms and a slowest of 1.7ms, and failed a build
  over it. A re-match that had gone quadratic is slow on _every_ pass, so the
  median catches it with the same fifty-fold headroom while an outlier no longer
  decides the colour of the build. The threshold did not move, because the
  threshold was never the problem.
- **A class change restyles the subtree and the siblings, not the tree.** A
  combinator reaches downwards and sideways from an element, never up, so those
  are the only elements whose match can depend on it. Sideways is the half that
  is easy to forget and visible immediately when wrong: `:nth-child()` and
  `+`/`~` mean inserting a child changes what its siblings match, and none of
  those siblings changed in any way an element-level check would see.
- **The walk is in document order, because a child's inherited values come from
  its parent's _resolved_ style.** The parent has to have been resolved first,
  which is also why the prop path is a branch inside the walk rather than a pass
  after it. _When_ a parent forces its children is the entry below, and it is
  not "whenever it was restyled" -- that wording is what both of the misses
  below were compatible with.
- **Styles are compared by value, not by identity.** A `Length` is an object and
  two resolutions of `width: 4` produce two equal objects, so comparing by
  identity reports every property as changed on every restyle and makes the
  dirty bits mean nothing. Shallow is enough -- the only non-primitive a style
  holds is a `Length`, and `JSON.stringify` on this path is not.
- **`LAYOUT_PROPERTIES` sits next to the property table.** It is the one thing
  about the property set that cannot be derived from the definitions: the table
  knows what `white-space` accepts and cannot know that changing it re-wraps
  text. Three that surprise people -- `borderStyle` is layout because a border
  takes a cell on each edge while its _colour_ does not, and `textTransform` and
  `whiteSpace` are layout because both change how wide a text measures. One that
  surprises the other way: `visibility` is paint-only, because hidden content
  still takes its space, which is the layout engine's own recorded decision.
- **The resolved style does not live in a `Computed`, and that is settled rather
  than deferred.** It would make invalidation fall out of the signal graph for
  free, and it costs a graph node per element per property -- thousands for a
  tree of hundreds -- against a full re-match already measured at well under a
  millisecond. It also lands on the signals layer's own known limitation: edges
  are strong and bidirectional, so every element ever removed stays reachable
  until its sources die. Elegance that buys nothing measurable and costs a
  lifecycle problem.
- **An animation writes through to paint rather than marking style dirty, and
  it is built now.** The decision was taken here in advance and it holds exactly:
  `Animator` never calls into the `Restyler`, so the cascade is not re-run for a
  frame of an animation -- what it holds is a _presented_ style per animating
  element, built over the base style the cascade resolved. The reason is the
  measurement two entries up: a full re-match is 0.67ms per 201 elements, which
  is affordable once per frame when something changed and is not something to
  drag behind every frame of an animation. The one refinement it needed is
  **layout**, which is a different bit: an animated geometry property is in
  `LAYOUT_PROPERTIES` and the boxes really do have to be placed again, so
  `tick()` reports layout and paint separately and the frame folds the first into
  `needLayout`. See the section below for what makes that affordable.
- **The signal wiring is the renderer's, and it is now written.** `Restyler`
  still takes marks from whatever calls it -- that seam did not move -- and
  `render()` is what calls it, draining `Tree.take()` into `touchClasses()`,
  `touchProps()` and `touchChildren()` once per frame. Before it existed, an app
  that kept a `Restyler` across frames got one that re-resolved _nothing_ after
  the first, silently: the state really did change, the selector really would
  match, and the frame was never asked. `demos/element/03-focus.js` is what found
  it -- Tab moved the focus ring and the `:focus` highlight stayed where it
  started -- and it still writes the bridge out by hand, because it predates the
  renderer and demonstrates the layer below it.

### Transitions and keyframe animations

A terminal is a frame loop, so CSS animation works here -- and it turns a
category of thing that was hand-written imperative code into declarative style.
Two mechanisms, both CSS's: a `transition` animates a style change caused by
anything at all, and `@keyframes` plus `animation` runs a named sequence.
`src/style/easing.ts` is the timing functions, `src/style/interpolate.ts` is what
a value is part way between two of itself, `src/style/animate.ts` is the
`Animator`, `@keyframes` is the stylesheet parser's, `prefers-reduced-motion` is
one more field on `MediaContext`, and the wiring is one block inside the
renderer's `settle()`.

- **What eleven more properties cost, measured, is 8% of a layout and nothing
  else.** The table went from 55 properties to 66, and `initialStyle()` builds
  every one of them per element -- so the question is what that does to the two
  things that call it in a loop. Measured against the same tree corpus:
  `initialStyle()` 20,000 times is **88.2ms to 95.1ms**, `declare({ width: '4' })`
  20,000 times is **100.3ms to 124.2ms**, and 200 random trees laid out at 80x24
  is **218.8ms to 235.7ms** -- +8%, +24% and +8%. The `declare()` number is the
  one that moved and it is the one that matters least: what an app declares per
  element is a handful of properties and the 24% is the fixed cost of the fifty-odd
  it does not.

  Worth writing down because the first reading of it was wrong. The layout fuzzer
  blew its ten-second per-seed timeout twice in a row while this was being written
  and the obvious conclusion was the property count; measured against `main`'s
  `src/` in the same worktree, both sides run each seed in 1.0-1.5s and the full
  suite had gone from 7s to 24s because three other agents were on the machine.
  That is the batched-against-interleaved failure this file records for the style
  shaking, met in a suite with a per-test deadline -- and the check is the same
  one: does the baseline agree with the baseline.

- **Two maps, and the split is the whole of what makes a transition start.** A
  transition animates from the value an element had _before_ the change, so the
  last base style has to be kept for every element the animator has been shown.
  The first version kept it on the same entry as the running state -- and `tick()`
  drops an entry with nothing left to say, which is exactly when there is nothing
  to animate yet, so the entry was gone by the time the change arrived and **no
  transition ever started**: every change looked like an element's first style.
  So `#base` is a record per element, the size of the tree and cleaned by
  `forget()` the way the restyler's caches are, and `#entries` holds only what is
  in flight -- which is what `tick()` and `active` walk, so the per-frame cost is
  proportional to the animation rather than to the tree.
- **The from-value is the value on _screen_, which is not the same as the base.**
  `observe()` writes the new base before it diffs, so a `#startTransition()` that
  read `entry.base` would start every transition where it was meant to end -- which
  is to say it would start nothing. It reads the running override where there is
  one, the presented style where there is one, and the style the cascade had before
  this change otherwise. All three are the same question asked of whatever is
  nearest to the screen.
- **An animated value is presented, not inherited.** A `color` transition on a
  container does not drag its text with it. Inheriting a presented value means
  re-resolving the subtree every frame, which is the one thing the recorded
  architecture rules out and which the 0.67ms re-match is the measurement for. What
  it costs is small, because the _base_ value still inherits: a selector covering
  the container and its text gives every element its own transition, all starting
  at the same moment with the same duration, so they stay in lockstep. Making
  `transition-*` **inherit** was considered for exactly that -- it would make
  `.panel { transition: color 200ms }` cover the subtree -- and refused, because a
  surprise transition on every descendant is still a surprise and a divergence from
  CSS costs everyone's intuition.
- **Geometry interpolates in whole cells, and that is what makes a frame
  skippable at all.** A box going from 10 to 20 columns has eleven visible states
  however long it takes, and the timing function decides which frames land on
  which integer. So the interpolator rounds rather than truncating -- truncating
  biases every frame downwards and leaves the last frame before the end a whole
  cell short -- and the declaration's own rule, that a fractional length is refused
  rather than rounded, is about a value somebody _wrote_ rather than one nobody
  did.
- **The frame skip is "do not set a timer", not "wake up and return early".** The
  ticket asked for the saving to be measured rather than asserted, and the
  measurement is also the argument for the shape: a loop that woke at `frameMs` and
  compared would paint exactly as often as this one does, so counting paints says
  nothing. `Animator.nextChange()` probes the interpolation forward at `frameMs`
  granularity, up to a bounded horizon of 64 probes, and answers how long until
  something would quantize differently; the renderer spends that as a longer sleep.
  Measured by counting wakes against a loop pacing itself at thirty a second:

  | what is animating                  | naive wakes | wakes |
  | ---------------------------------- | ----------- | ----- |
  | `width` 10 to 20 over 300ms        | 10          | 10    |
  | `width` 2 to 4 over 1000ms         | 31          | 4     |
  | `width` 0 to 40 over 2000ms        | 61          | 41    |
  | a colour over 1000ms, truecolor    | 31          | 31    |
  | a colour over 1000ms, 256 colours  | 31          | 11    |
  | a colour over 1000ms, 16 colours   | 31          | 6     |
  | `steps(10)` over 800ms, two cycles | 49          | 20    |

  Which says the honest thing rather than the flattering one: the saving is
  exactly `frames - distinct quantized states`, so it is **nothing** where the
  animation changes every frame -- a fast geometry change has more states than
  there are frames, and a truecolor ramp is a different colour every time -- and it
  is large exactly where a terminal animation usually lives. A stepped animation,
  which is the shape a spinner is, wakes 20 times where a paced loop wakes 49, and
  a slow small geometry change wakes 4 times where it wakes 31.

- **The horizon is bounded, and a running animation's end is woken for.** 64
  probes at thirty frames a second is about two seconds, so a transition whose next
  cell is five seconds away wakes once per two seconds rather than being solved
  exactly -- the search is linear in the probes and the point of it is to not wake
  up. The end of every running transition and animation clamps the limit, because
  the entry has to be _retired_ for `active` to go false and `active` going false
  is what stops the timer.
- **A frame asked for sooner than one already pending replaces it.** The deadline
  is a floor on the animation's own next frame and must not become a floor on
  everything else: without the `dueAt` comparison a keystroke waited out the
  quarter of a second a slow animation's next change was away. That is why the
  scheduled _time_ is tracked rather than only the fact of a timer.
- **The presented style is the same object where nothing quantized differently.**
  A text's measurement is cached per width and keyed on the resolved style
  _object_, so a new one per frame would re-wrap every string in an animating
  subtree thirty times a second -- which is the most expensive thing in the stack,
  measured at 24% of a render in grapheme segmentation alone. The object is rebuilt
  only when an override moved, or when the _base_ moved under it: a colour changing
  while a width eases has to reach the screen, and `builtFrom` answers "is the
  presented style still built over the current base" by identity, which is free and
  exact for the same reason the measurement cache keys that way.
- **A transition is interruptible, and it animates from the current interpolated
  value.** That is the first question the ticket left open and the answer is CSS's,
  because it is the only one that does not look broken: a focus ring half way
  through easing in and then unfocused has to ease back from where it is, not jump
  to the full value and ease from there. The alternative -- restart from the
  declared value -- is cheaper by nothing and visibly wrong on exactly the input
  this feature exists for, a state that toggles faster than the duration.
- **Reversal shortening is out.** CSS has a reversing-shortening factor so that
  reversing a half-done transition takes half the time rather than the full
  duration, which matters at 60fps over 200ms in a browser. At whole-cell
  quantization it changes _which_ of a handful of states you see rather than
  whether the result looks right, and it is a second timing rule to hold. Noted and
  skipped.
- **A transition whose declaration has gone is cancelled, which the diff cannot
  see.** Removing `transition: width 100ms` changes the transition longhands and
  leaves `width` exactly where it was, so nothing in the property diff is ever
  asked about the property that is running. CSS cancels there and so does this: a
  transition still easing on a rule nobody declares any more is one with no live
  writer, which is the parser's own phrase for the same shape.
- **There is no `onfinish`, and `Renderer.animating` is the one observable.**
  That is the second open question and the answer is "declarative for now, with a
  reason". An event needs a target identity, a delivery point inside the frame --
  where a handler writing a signal is the re-entrancy `runFrame()` already refuses
  -- and a story for an element unmounted mid-flight. All three have answers and
  none of them has a caller, which is the rule `which` waited on for eighteen
  months. What a caller genuinely cannot observe any other way is whether the loop
  will keep going, so that is what is exposed; a fade on the way out is the use that
  will ask for the event, and it should bring the delivery rule with it.
- **Colour interpolates in Oklab, and only between two 24-bit colours.** The
  first half is the degrader's own argument read forwards: a ramp through
  gamma-encoded sRGB dips in perceived lightness in the middle, so a red easing to
  a blue goes visibly dark half way. Measured, red is L=0.628 and blue L=0.452, so
  their average is 0.540 -- the Oklab midpoint comes to 0.539 and the sRGB midpoint
  `#800080` to 0.421. The second half is the refusal: a **palette** colour does not
  interpolate, because AGENTS.md already records that a named colour stays a palette
  index -- the basic sixteen are whatever the user's terminal theme says they are,
  so a mix through the xterm defaults would draw a first frame in a red the user
  never chose, and `DEFAULT_COLOR` has no channels at all. A pair with no path
  between them snaps at the midpoint, which is what CSS does with any value it
  cannot interpolate.
- **A mix is degraded at the level the cascade resolved at.** Degradation happens
  at resolve time, so what the animator was handed is already degraded and a mix of
  two degraded colours is an off-cube colour nothing would degrade again -- which
  would make an animation the one path in the library that emits truecolor on a
  256-colour terminal. The level is read off `cascade.media` rather than captured,
  for the reason the colour level is kept on the renderer: a resize re-reads
  `NO_COLOR`.
- **How a property interpolates is derived from the table, with two exceptions
  named and the parsers as the cross-check.** The shape of the _initial value_
  answers it -- a `Length` interpolates as a length, a colour as a colour, a number
  as a whole number, and a keyword or a flag snaps -- which is the rule
  `COLOR_PROPERTIES` and `ATTRIBUTE_PROPERTIES` already follow and is why a new
  `Length` property animates for free. `INTERPOLATION_EXCEPTIONS` names what the
  value cannot say: `flexGrow` and `flexShrink` are ratios and keep their
  fractions, and the eleven transition and animation longhands are `none`, which is
  CSS's "not animatable" and is a different thing from `discrete`. The cross-check
  is a fact about the parsers rather than about the table: a property classified
  `integer` has to **refuse** `0.5` and one classified `number` has to accept it, so
  a fractional property added without being named fails rather than being quietly
  rounded on every frame of every animation.
- **An easing is interned by its canonical shape, not by its source.** Interning
  at all is so that `difference()` answers with `===`: it compares two resolved
  styles with identity plus one branch for a `Length`, and a value type that is
  neither would mean a third branch and a list to keep in agreement. Keying on the
  _source_ is the half that was wrong: `steps(4, end)` and `steps(4,end)` are one
  timing function written two ways, and two objects meant a sheet that wrote one and
  a theme that wrote the other reported a changed property -- so the frame after
  repainted to draw exactly what was already on screen. `source` is then the first
  spelling that produced the entry, and `ease-out` and the bezier it stands for stay
  separate on purpose, because those are different things to have written.
- **A cubic-bezier may not overshoot, which is a deliberate divergence from
  CSS.** The y coordinates are held to `[0, 1]` as well as the x ones. On the web an
  overshoot curve is the point of letting y leave the unit interval; here every
  geometry property is whole cells with a grammar of its own -- a padding is a count
  and a gap cannot be negative -- so an overshoot resolves to a value no declaration
  could have written, and nothing on the property table says where to clamp it back
  to. What it would buy at whole-cell quantization is one cell of spring on a
  ten-cell box. Refused where it is written, which is the rule a fractional length
  already follows.
- **And its four components go through the `<number>` grammar, which is the one
  reader in this file that had never kept that rule.** They were read with
  `Number()`, so every trap the Style entry above exists for was open here: `Number('')`
  and `Number(' ')` are `0`, which made `cubic-bezier(0.4, 0.0, 0.2,)` the curve
  `(0.4, 0, 0.2, 0)` -- one that ends **flat** rather than at 1, so an animation ran
  a different shape from the one that was written with nothing to say so -- and
  `Number('0x1')` is `1`, so the hex that entry refuses was taken. Found by review
  in a file no earlier round had read, which is the argument for pointing a round at
  the files the previous ones skipped rather than at the diff again. `readNumber()`
  is **exported** for it rather than copied, and deliberately not re-exported by the
  barrel, so the grammar stays one implementation without becoming API -- a second
  spelling of `<number>` beside this one is how the two come to disagree about
  `1e0`, which CSS allows and a tighter pattern would have taken with it. The
  component **count** is a separate check and is load bearing on its own, which a
  sabotage had to say: `cubic-bezier(0, 0, 1, 1,)` has all four numbers it needs and
  is still malformed, and a stylesheet reports that rather than reading past it.
- **`steps()` takes at least one step, and the position hid the count that did
  not.** `parseCount()` accepts zero because every other count in this grammar
  legitimately may be, so the floor is this caller's -- and the guard next to it,
  which refuses a count and a position that leave no jumps, is exactly what hid the
  gap: `jumpsFor(0, 'jump-both')` is `1`, so three of the four positions came out
  empty and were refused while `steps(0, jump-both)` parsed. What it then did is the
  part worth writing down, because it is not a crash: `floor(t * 0) + 1` is `1` at
  **every** fraction, so it is a timing function that reports finished for the whole
  of the duration -- an animation that shows its end state and never moves. The
  existing test asserted `steps(0)`, which is `jump-end` and was refused all along,
  which is the shape this file keeps rediscovering -- a rule pinned by the spelling
  the reporter happened to write. Its own guard rather than a widened one, so the
  comment on the other stays true: with a count of one or more, `steps(1, jump-none)`
  really is the only place the count and the position are not independent.
- **A time carries its unit in a shorthand and not in a longhand, and that is
  forced rather than chosen.** `transition-duration: 300` is milliseconds, because
  there is one time unit here the way there is one length unit and spelling it every
  time is noise. In the `animation` shorthand a bare number is CSS's iteration
  count, so one grammar cannot have both -- and the two shorthands agreeing about it
  is worth more than `transition: width 300` saving two characters. The error says
  so by name, because a bare number where a time was meant is the mistake the rule
  creates.
- **A comma-separated list of transitions or animations is refused where it is
  written.** CSS lets both take a list, where every longhand holds a list of its own
  and the shorter ones repeat to the length of the first. What that costs here is
  eleven array-valued properties, a second comparison path in `difference()` and a
  repetition rule; what it buys is a per-property duration, which in a terminal is
  rare enough that nobody has asked. Several properties at one duration is still
  expressible, because `transition-property` is itself a list -- and it expands a
  **shorthand**, so `transition-property: padding` watches all four edges. Taken as
  its first entry instead, a declaration whose second half was silently dropped is
  worse than one that did not parse.
- **A `transition-property` naming something that cannot animate is refused.** The
  rule a keyword the engine ignores already follows: a
  `transition-property: transition-duration` that parsed and did nothing is a
  declaration whose author has no way to find out it was wrong. The same question
  inside a `@keyframes` is **skipped** rather than refused, because a keyframe block
  is read before anything knows it will be used as one -- and an animation that
  animated its own duration would be asking what the duration is in order to find
  out what it is.
- **`@keyframes` is parsed eagerly, resolved by name, and refused inside
  `@media`.** Eagerly because an unknown property in a stylesheet is an error
  reported where it was written, which is the rule this parser already follows and
  which deferring the read to the first frame would give up; `!important` and a
  cascade keyword are both refused there for the reason `readDeclarations()` refuses
  one, since there is no cascade to invert and no parent to inherit from. By name,
  with the last declaration of a name replacing the earlier one whole, which is CSS
  -- resolved across sheets by origin and then by the order they were added, with
  **layers and specificity left out** because a `@keyframes` is not a declaration
  and a name is matched rather than selected. Inside `@media` it is refused:
  `animation-name` resolves with no media context to hand, so a conditional block
  needs a rule for which of two matching blocks of one name wins, and inventing a
  resolution order nothing needs is how a feature that parses comes to mean
  something nobody wrote. The use that looks like it wants it --
  `@media (prefers-reduced-motion: reduce)` -- is already answered by the feature
  itself.
- **A `@keyframes` endpoint nothing declares is the element's own value.** CSS's
  implicit 0% and 100% keyframes take the underlying value, which is what makes
  `@keyframes fade { from { color: red } }` ease into whatever the element's colour
  is rather than holding red forever. Two blocks at one offset keep the later one
  per property, which is what writing them in order comes to.
- **`prefers-reduced-motion` has a real analogue here and is added the way the
  colour scheme was: one media feature, one field, one lookup.** No new resolution
  path and nothing added to the matching engine, which is the argument the utility
  layer and the colour scheme are both built on. `MediaContext.reducedMotion` is
  **required** rather than optional for the reason `colorScheme` is -- a context
  that does not say is a context that has not decided, and the type error at every
  literal in the suite is the change being visible. `DEFAULT_MEDIA.reducedMotion` is
  `no-preference`, which is CSS's initial value and means "nothing has said
  otherwise": it is deliberately not where the non-TTY rule lives, because a frozen
  constant cannot know whether there is a terminal and because the same constant is
  what `renderToString()` and a bare `Cascade` resolve against.
- **The one `if` in `holds()` became a two-entry lookup, and that is still one
  mechanism.** A second keyword feature has to say which _field_ of the context it
  compares, so `KEYWORD_FEATURES` carries the field beside the values it accepts and
  the parser and the match read the same entry. Two `if`s would be two places to
  disagree about which field goes with which feature, which is what a test named for
  it now fails over.
- **The chain is the app, then the user, then whether there is a terminal at
  all.** `RenderOptions.reducedMotion`, then `SIGIL_REDUCED_MOTION`, then
  `terminal.isTTY && !terminal.closed`. The shape is the colour scheme's and so is
  each reason: an app that names one is stating a fact about its output, the variable
  is the user correcting the detection, and a pipe, a file or a CI log has no frames
  at all -- so an animation there would write a line per tick into something nobody
  will watch play. That last term is the live region's own rule for a spinner,
  generalized from one component to the cascade, and it is why a piped app needs no
  option to behave. The variable is namespaced for the reason `SIGIL_COLOR_SCHEME`
  is, it reads the vocabulary a boolean property reads plus the feature's own two
  keywords, and a value that is neither falls through rather than deciding.
  `themedCascade()` reads it too, because that is the one place every built-in's
  cascade comes from and a sheet with a reduced-motion half would otherwise resolve
  at the frozen default for every table and every help screen there is.
- **Reduced motion is an animation that has already finished.** One sentence
  rather than two: an infinite animation has no end state to collapse to and does
  not run, and a finite one leaves behind exactly what its fill mode says it leaves
  behind -- the final frame for `forwards` or `both`, and the element's own style for
  anything else. Transitions do not start at all, which is what a style change
  looked like before any of this existed.
- **Whether an animation runs is `#syncAnimation()`'s single decision, and the
  first version took it in three places that disagreed.** A review round found all
  three, and they are one shape: that function had early exits which did not consult
  what the rest of the class consults. Under reduced motion it stored the animation
  anyway and left the _collapse_ to the per-frame arithmetic, so an infinite one kept
  `active` true and the frame loop woke every two seconds **for the life of the
  process** -- by the plainest route there is, since a non-TTY resolves to `reduce`
  and a non-TTY is the CI log the requirement was written for. With a zero duration
  it dropped the animation outright, which is right for a fill of `none` and loses the
  100% keyframe CSS applies for `forwards` -- and `animation: slide forwards` is that
  input, since an omitted duration defaults to `0s`. And a fill once left behind was
  never taken away, so it survived `animation-name: none` and a _finished_ animation
  restarted on the next unrelated style change.

  So `#commit()` names the four answers -- **runs**, **settled** at the state it
  would have left behind, **refused**, or none -- and only the first makes `active`
  true. The fill carries the name of the animation that left it, because a fill
  belongs to its animation: that is what takes it away with the name and what stops
  a finished animation restarting. And `prefers-reduced-motion` is a media query, so
  the decision is re-taken when the query's answer moves: `Animator.touchMedia()` is
  the same method name the `Restyler` carries, called from the same
  `publishMedia()`, over every element the animator has a _base_ for -- because an
  animation the preference refused left no entry behind and turning the preference
  off has to be able to start it.

- **And the `isFinite` guard the first write-up called a statement rather than a
  claim was load-bearing all along, which is the entry worth reading twice.** That
  paragraph said deleting it changed no test because `Infinity % 1` is `NaN`,
  `ease()` hands `NaN` back, every comparison in `valueAt()` is then false, both
  endpoints fall back to the underlying value, and the override is dropped for
  equalling the base -- "right by five accidents in a row". The chain breaks at the
  last link, and a review round traced it: `valueAt()` does fall back to the base at
  both ends, so `interpolate(base, base, NaN)` is what runs, and for a `Length` in
  **cells** that is `cells(Math.round(NaN))`, which is `cells(NaN)` -- and
  `sameValue()` compares `NaN === 0` as false, so the override is **kept** and a
  width of `NaN` reaches the layout engine.

  Why the sabotage reported otherwise is the part to keep: the harness was sound --
  it patched the source, ran the **whole** suite, and read every failed assertion --
  and the _fixture_ was not. The one test exercising that branch animated `left` on
  an element that declared none, so the base was `auto`, and `mixLength()` hands an
  `auto` back untouched for want of a `cells` or `percent` branch to take. On a base
  of `cells(0)` the same deletion fails the same test. A sabotage result is only as
  strong as the fixture's coverage of the branch, and the write-up compounded it by
  reasoning _forward_ from "no test failed" to a five-step justification instead of
  asking what input would make the guard matter. The branch is gone rather than
  better commented: `progressOf()` is pure timing arithmetic now. The review also
  predicted a
  `TypeError` out of `rgb()` for a colour on the same path, and that one does not
  reach: both of `valueAt()`'s endpoints degrade to the _same_ base value, so
  `mixColors()` returns early and never builds a channel. A test covers the class
  anyway, over both motion settings and every frame, because a `Length` of `NaN` is
  a wrong layout and a colour of `NaN` would be a throw from inside the painter.

- **"There is no path left that can produce a `NaN`" was the next sentence, and a
  second review round falsified it -- so the claim is an enumeration now rather
  than a sentence.** The input is the one nobody writes on purpose and it is sitting
  in this repository's own property table: **`animation-duration` starts at `0`**. So
  `animation: slide infinite` -- and equally the bare longhands `animation-name`
  plus `animation-iteration-count: infinite` -- is an endless animation with no play
  time, `#commit` tested the zero duration _before_ the non-finite count, and
  `endOf()` for it is `0 * Infinity`, which is `NaN`. Settling at `NaN` walked
  `progressOf()` straight past both of its guards, because `NaN < 0` and
  `NaN >= NaN` are each false, and the fill mode was never consulted at all. What it
  presented was `flexGrow: NaN` through `mix()` and `cells(NaN)` through
  `mixLength()`, with `active` **false** -- so no timer ran and nothing on screen
  said anything. `finalOffset(Infinity)` is `NaN` for the same reason, so "settle at
  the end" is not an answer for that input either: it is refused outright, which is
  the rule an endless animation already follows under reduced motion.

  The lesson is the one two rounds have now taught in three places, and it is not
  that the reasoning was sloppy. **A negative claim about all inputs or all callers
  cannot be established by tracing the route you had in mind.** "No path can produce
  a `NaN`" and "`tick()` drops it before anything can read it" are both of that
  kind and both were false -- the first because a default made an input nobody
  writes reachable, the second because `touchMedia()` is a reader that does not
  tick. When the fix is "this is now impossible", the thing to do is enumerate the
  defaults and the callers. So `should present a finite value for every defaulted
  and degenerate input` walks the two values that can be left out against five
  iteration counts, every fill mode and direction, three keyframe bodies and both
  motion settings, and asserts a finite presented value at six moments of each --
  about fifteen hundred assertions in place of a sentence. `easing.test.ts` and
  `interpolate.test.ts` grew the same shape of walk over their own grammars, since
  a timing function and an interpolator are what every animated value passes
  through.

- **The clock is injectable and the frame timer is unref'd.** `RenderOptions.now`
  is one function asked by the pacing, by the transitions and by the frame-skip
  arithmetic, so none of the three can come to disagree about what time it is -- and
  an animation test that waits for wall time is flaky forever, which is the same
  reason `frameMs` is an option. The `unref()` is the spinner's own rule moved up a
  layer: a frame pending is not a reason for a finished process to stay alive, and
  what keeps a real app running is stdin rather than the loop that draws for it.
- **Nothing animating still means no timer, and that took a fix rather than
  holding by itself.** The animation asks for its next frame from inside `settle()`
  rather than running a timer of its own, so `animator.active` going false is what
  stops the loop -- and for the first version that was true of a transition and
  false of an animation, which is the defect two entries up. Under reduced motion
  an infinite animation stayed `active` forever: `endOf()` is `Infinity`, so
  `#retire()` never cleared it, `nextChange()`'s `Math.min` against `Infinity`
  stayed at the horizon, the probe found no change and the loop woke every two
  seconds to present nothing. The tests could not see it because the reduced-motion
  ones asserted what was _presented_ and never `active`, while the `active` and
  timer ones were all transitions -- which the other clear in `observe()` does
  retire. Both halves are asserted now, for an infinite animation and for a finite
  one with a long duration. An element that leaves the tree mid-transition is
  **forgotten**, and what that buys is not only the leak `Restyler.forget()` exists
  for -- a transition still running on a box nobody can see goes on asking for
  frames, so the loop would spin for the rest of its duration over nothing at all.
- **A `@keyframes` with no stops in it runs nothing, which is the same rule met by
  a different input.** An empty body parses, lands in the map, and is **truthy** --
  so a found name was taken for an animation, and one with `infinite` held the frame
  loop open at the horizon forever to present nothing. It touches no property, so it
  can never change what is on screen, which is exactly what `#commit()` already
  refuses to run. Found while checking the three test files two review rounds had
  never opened, which is where it should have been found: `keyframes.test.ts` had no
  empty body, no single-ended body and no stop that sets nothing.
- **A `forwards` fill outlives its animation without keeping the loop awake, and
  it carries the name of the animation that left it.** The override is held after
  the animation is retired, so the last frame stays on screen; `active` is false,
  because nothing more will change. That is the one state where the animator is
  presenting a style and the frame loop may stop. The **name** on it is what makes
  the field's two other jobs possible: a fill belongs to its animation, so
  `animation-name: none` takes it away rather than leaving it on screen for the life
  of the element, and a _finished_ animation whose name is still declared is left
  alone rather than restarting because some unrelated property moved. Both were
  wrong while the field was a bare value map -- a colour write half a second after a
  fade finished replayed the whole fade.
- **`Settled` carries the whole animation and a `ran` flag, and both halves were
  found by a review round after the first fix looked right.** The flag is the
  distinction one field was doing two jobs without: an animation that **ran and
  finished** must not restart, and one that was **collapsed** -- by reduced motion,
  or by having no play time -- never ran, so it has to be able to start if the thing
  that collapsed it moves. Those are opposite answers to "is this finished", so
  whichever was written last was wrong. The first fix refused the restart, and the
  cost was an animation collapsed under `reduce` that could never start again across
  two `touchMedia()` calls with no frame between them -- which a resize and a
  capability reply can produce back to back.

  Two inputs also reached the restart through `tick()`'s drop condition and a test
  covered neither: a `forwards` fill whose value **equals the base**, which
  `#overridesAt()` drops for being equal, and a fill of **`none`**, which holds
  nothing to begin with. Either way the entry held no override, was dropped, and
  took the record of what had finished with it. So the drop condition keeps an entry
  whose animation ran, and `#settle()` records whatever it finds, empty map
  included -- which deleted the `values.size > 0` guard the first fix had argued was
  unreachable rather than keeping a guard with a false reason attached to it.

  And the animation is on there rather than only its name because a **sheet swap**
  is a third reader: `cascade.keyframes()` answers with new frames the moment a
  sheet is added, so a `touchSheets()` that rewrites `@keyframes slide` while
  `animation-name` stays `slide` has to reach both a running animation and a
  finished one's fill. `timing()` deliberately does not carry the stops -- correct
  for the path it was written for, a timing change, and wrong for the one that grew
  beside it -- so the keep path passes `stops` explicitly and the settled path
  recomputes when they have moved. `index()` is memoised on the `Keyframes` object
  for it, which is the right question by identity: the cascade hands back the same
  frozen array while its sheets do not move and a different one the moment they do.

- **The toolchain generates no utilities for the animation properties, and the
  exception is an explicit list.** `animation-direction` and `animation-fill-mode`
  are keyword properties, so the rule that a keyword added to a property gets its
  utility for free would have produced four and three classes. They are refused in
  `UNGENERATED` with the reason: both are half a vocabulary on their own, because
  the **name** and the **duration** are open-ended and a utility set cannot
  enumerate them -- an `animate-alternate` with no way to spell either is a class
  that cannot express an animation however many of them you write. What a utility
  layer would want instead is Tailwind's answer, a handful of named composites with
  their own `@keyframes`, which means the generator emitting an at-rule and somebody
  inventing a vocabulary of animations. Neither has a caller. The list is explicit
  for the reason the raw-control-character exceptions are one: the next property
  added to it should be a decision somebody makes.

#### The spinner port was measured and refused

SIG-62 called the spinner the strongest evidence the feature belongs -- "`steps(10,
end)` over a `@keyframes` cycling ten Braille frames _is_ the spinner, declared
rather than driven by a `setInterval`" -- and asked for the port or a concrete
reason it does not pay. It does not pay, and the reason is one sentence with three
costs under it: **the spinner animates _content_, and there is no animatable content
property.**

`content` is not in the property table and cannot be: a cell grid draws a style per
cell, and what a `text` holds is the element's own. CSS's answer for stepping
through content is a sprite reel behind a clip -- a wide strip of all ten frames
inside a one-column window with `overflow: hidden`, stepping `left` from `0` to
`-10` with `steps(10, end)` -- and every piece of that exists here. What it costs is
what decided it.

- **A reel necessarily overflows its window, and `arrangedExtent()` did not
  intersect the clip. SIG-130 closed that, so this cost is gone and the other two
  stand.** The strip has to be its natural width or `text-overflow` cuts it to the
  one column the window gives, which is the whole mechanism gone -- and the extent
  walk took `box.x + box.width` of every node with no reference to `element.clip`,
  so an auto-width canvas would have claimed the reel's full width. Every live
  spinner frame would have been nine columns wider than it needs, which is the one
  thing `width: 'auto'` exists to prevent. That walk stops at a clipping box now,
  measured on the reel's own shape: a ten-column text inside a one-column
  `overflow: hidden` window reports a width of one where it reported ten. The enabling change was correctly **not** taken here -- it is
  in the layout and paint layer and it changes `renderToString()` for every
  clipped tree -- and it got the ticket of its own this paragraph asked for. The
  name still matters when reading this: it was `arrangedExtent()` specifically,
  not extents in general, since SIG-110's `Element.extent` already stopped at a
  clipping box.
- **The keyframes cannot be static, because the travel is a runtime argument.**
  `createSpinner({ frames })` takes its own frames, so the reel's travel is
  `-frames.length` and the step count is `frames.length`. A sheet cannot say that,
  so every spinner would parse a stylesheet of its own -- which means plumbing a
  `sheets` option through `mountLive()` and `themedCascade()` for one component.
- **The frames would have to be padded to a common width.** `frames[frame %
  frames.length]` handles any frame content today; a reel with a uniform step offset
  does not, so a caller passing frames of differing widths gets half a glyph.

Against that, what the port deletes is the `setInterval`, its `unref()` and its
cleanup: fifteen lines, replaced by more than fifteen. And the ticket's own
constraint is the clearest argument of the three, because a wider live canvas is
observable: it says the facade's behaviour must not change, "including the
piped/non-TTY behaviour, which AGENTS.md says is byte for byte what it was".

So the line under "The built-in components" in `src/components` has been
corrected rather than left: the spinner's `setInterval` is where a `steps()`
keyframe animation goes **when there is a content property**, which there is
still not -- the clip-aware extent walk the first version of this sentence
also waited on arrived with SIG-130, and on its own it is not enough, because
the two costs below are about the keyframes rather than about the grid. What
the feature is proved on instead is `demos/style/03-animation.js`, which
transitions a width, two colours at one duration and a focus ring, runs an
infinite `@keyframes` with `alternate`, and prints frames painted against the
thirty a second a loop without the frame skip would have drawn.

> Moved: _What the sabotage pass caught, and what it got wrong_ — see [docs/history/transitions-and-keyframe-animations.md](../../../../docs/history/transitions-and-keyframe-animations.md).

#### What is deliberately out

Each of these is a decision rather than an omission, and each is one somebody will
reach for.

- **Per-keyframe timing functions.** `animation-timing-function` inside a keyframe
  block means the easing changes between stops, which is a second timing rule and a
  second place for the measure and the paint to disagree about where a value is.
  The animation's own easing covers the whole iteration.
- **`animation-play-state`.** Pausing needs a second clock -- elapsed time has to
  stop accumulating while the state is `paused` and resume from where it was -- and
  nothing asks for it. A component that wants it today sets `animation-name: none`,
  which stops the animation and loses its phase.
- **More than one animation or transition per element.** The comma list above, read
  from the other side.
- **`animation-composition`, `@starting-style`, and `currentcolor`.** The first two
  are CSS features that depend on a composite ordering this cascade does not have;
  the third already has a recorded entry saying it needs a resolution order of its
  own.
- **An interpolation that can produce a value the property would refuse.** The
  overshoot refusal above is the general form: there is no clamp table, so the
  grammar is held where the value is read.
