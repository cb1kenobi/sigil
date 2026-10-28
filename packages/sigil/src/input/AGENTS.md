# `packages/sigil/src/input` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Input and focus

- **One thing owns stdin, and it is the router.** Every prompt used to set raw
  mode, attach its own `data` listener, decode, and put it all back -- which
  works exactly as long as there is one prompt. Two at once fight over the
  stream and neither can see what the other consumed. The router reads, decodes
  through `decodeKeys()`, and dispatches; components subscribe rather than
  listen. The holding-a-split-sequence machinery is the prompt's, moved rather
  than rewritten: `pendingLength()` says what could still be the start of a
  longer key and `ESCAPE_TIMEOUT` is what makes a lone Escape a key rather than
  a wait with no end.
- **A router refuses to exist where stdin is not a terminal.** `PromptError`'s
  rule generalized: a prompt with nobody to answer it fails loudly rather than
  hanging, and a router exists to read keys -- so one that never can is a bug in
  the app rather than a state to carry through every dispatch as a branch. An app
  that runs without input does not build one.
- **Bindings, then the focused element, then its ancestors, then the default.**
  A binding sees every key first, which is where quitting belongs: an app that
  cannot be quit because a focused input swallowed Ctrl-C is the failure the
  order exists to prevent. Tab is _last_, so a component that wants it -- a
  completion, a cell in a grid -- keeps it by stopping the event rather than by
  asking to be excluded from something.
- **An event is stoppable, or a text input's Left is also the list's "previous
  item".** The key reaches the focused element and every ancestor after it, and
  the only thing that can know the key was meant for the input is the input.
- **`onKey` is one function on the element, not a list of listeners.** The same
  argument the parser's hooks settled on: a list reads as though order mattered
  between entries nobody wrote, and a component that wants two things to happen
  writes one handler that does both.
- **The ring is rebuilt from the tree on every move rather than kept.** It
  reorders itself as the tree does, and there is nothing to keep in agreement --
  a couple of hundred elements walked on a keystroke is not a cost worth a cache
  that can be wrong. It skips a `display: none` subtree, read off the _resolved_
  style rather than the prop, because there is nothing on screen there to move
  the focus to.
- **Focus is a signal, and the `:focus` state is what it writes.** The signal is
  what a frame reacts to; the state is what the cascade matches, which is what
  makes an input that highlights when focused zero lines of component code. One
  source with the other derived, rather than two things to keep in agreement.
- **Nothing focused is a legitimate state.** An earlier version repaired the
  focus on every key, which also _grabbed_ it when there was none -- so the first
  Tab landed on the second element, because the first key had quietly focused
  the first. Repair is only for the element that has gone.
- **A focused element that is unmounted hands focus on by position.** Dropping it
  into nothing reads as an app that stopped responding: every key then goes to
  the bindings and nowhere else. What is kept is where it sat in the ring, not
  which element it was, because the element is exactly what has gone.
- **`focusable` and `tabindex` are reserved props, and `selectable` joined them.**
  Everything a prop names that this list does not is a style property, and the
  cascade refuses one it does not know -- so a typo is an error rather than a value
  nothing reads. A `tabindex` implies `focusable`, because giving something a place
  in the ring and then leaving it out of the ring is not a thing anybody means. The
  list is `class`, `focusable`, `id`, `key`, `selectable` and `tabindex`; what
  `selectable` is for, and why it is not a style property, is under "Selection and
  the clipboard".
- **A paste arrives whole, and bracketed paste joins the restore list.** Without
  the markers a pasted block arrives as though it had been typed, so a newline in
  the middle of an address is Enter and a text input submits half of it. With
  them the router holds what is between `ESC [ 200 ~` and `ESC [ 201 ~` -- across
  chunk boundaries, since a paste splits like anything else -- and hands it over
  as text. Nobody wanting it whole is not an error: it is then typed in, which is
  what a terminal that cannot bracket a paste sends anyway. `Terminal.restore()`
  turns the mode off for the reason it leaves the alternate screen: a CLI that
  dies with it on hands the user a shell that puts `ESC [ 200 ~` into every
  paste, which has to be reset by hand.
- **A router puts back only the raw mode it turned on.** `setRawMode()` reports
  whether it was the call that changed anything, which is the rule `hideCursor()`
  and `enableBracketedPaste()` already follow -- a prompt inside a full-screen app
  that is already raw must not take the app out of it when the prompt is
  answered, because the app is still reading keys and what it gets back is a
  cooked stream that echoes.
- **One thing owns stdin, and a prompt will borrow it.** `PromptOptions.router`
  is what makes the rule true in an app that prompts: an app that already has a
  router -- a full-screen one, which needed one to have a focus ring at all --
  hands it over, the prompt binds to it, and the prompt takes only its own
  handlers back off. A prompt with no router builds one, which is correct only
  because nothing else is reading at the time; that is the ordinary case and it
  is not every case, and two prompts at once over two routers would both read
  every key.
- **The stream ending is the router's to report, for the reason keys are.** A
  prompt waiting on a key has to be told when none will ever arrive, or it waits
  forever -- and that is a question about stdin, which the router owns. A
  listener of its own for that one event would be the private stdin handling the
  router exists to replace, kept alive for a single case. `onEnd()` fires for the
  stream ending and for it erroring, since what a caller does about either is the
  same thing.
- **Resize is the router's to carry and the renderer's to mean.** The event
  belongs with the other one a terminal produces, so an app subscribes in one
  place for the two halves of one frame. What it _means_ -- re-evaluate the width
  and height media queries, re-lay out, repaint whole rather than diff against a
  grid that described a different screen -- is a frame's, and is deliberately not
  decided here.
- **A handler set is dispatched over a copy _and_ a membership check, because
  the two directions want opposite things.** A handler registered while an event
  is being dispatched does not receive that event, and one removed during it is
  not called -- and a bare `for..of` over the `Set` gives only the second, while a
  snapshot on its own gives only the first. Without the copy, a component that
  binds a key in response to being focused has that new binding see the very key
  that focused it, and whether it does depends on where in the iteration it
  joined. Without the check, the copy re-runs a handler that has just
  unsubscribed: a one-shot binding fires twice, and a dialog torn down by Escape
  still hands Escape to the handlers it was tearing down. The rule reads as the
  copy alone right up until it is written down, which is how the terminal's
  resize notify came to carry a comment justifying the snapshot by the one case
  the snapshot breaks -- both are fixed, and both halves are pinned by a test
  that fails when either is removed. Bindings, paste handlers, resize handlers,
  and `Terminal.onResize()` all say it the same way. See
  `test/input/input.test.ts`.
- **The mouse is the router's too, and the Kitty keyboard protocol is what is
  left of that list.** Two decisions were taken in advance so that the mouse could
  be added without either layer moving -- the event type is `KeyEvent` rather than
  `Event` so a mouse event could join it, and `:hover` parsed and matched nothing on
  the explicit ground that the selector engine must not assume it never will -- and
  both held. The Kitty protocol is the same shape of answer, opt-in by query, and
  worth having the day something needs a key the legacy encoding cannot spell.
- **A binding is a key or a sequence of them, and the order between the two is
  the Ctrl-C guarantee.** `bind(fn)` sees every key before anything else does;
  `bind('g g', fn)` is consulted after every one of those and before the focused
  element. "Key sequences" below has the trie, the pending state, the two
  deadlines and why the alternatives to that ordering are worse.

### Key sequences

A binding was one key, so `g g`, `Ctrl-X Ctrl-S` and a leader key were all
unexpressible. `src/input/sequence.ts` is the grammar and the trie,
`InputRouter.sequence` is the pending state, and the whole of the router's half
is one step inside `dispatch()` between the function bindings and the tree.

SIG-112 was two halves and is now one: the **command palette** went to
SIG-134, because sequences were fully specified and are a prerequisite for a
palette anyway, while the palette had an unresolved packaging question --
runtime or `sigil add` -- that deserved deciding on its own terms. Which is
also why there is no description and no group on a binding: whether bindings
are _listable_ is the same question about the same registry as the palette's,
and deciding it twice is how the two come to disagree. SIG-134 decided it and
**refused** it, under "Bindings are not listable" in `src/components` -- so
the absence here is settled rather than pending.

- **A function binding sees every key, and that is the Ctrl-C rule.** The order
  is function bindings, then the trie, then the focused element, then the Tab
  default -- so **no keystroke whatsoever can make a function binding
  unreachable**, which is the sentence this file already carries about a focused
  input said again about a half-entered sequence. It is the ordering that
  guarantees it rather than anything about Ctrl-C, which is what makes it
  checkable: `should not eat ctrl-c, which a binding sees before any of it` feeds
  a `g` that really is pending and then the abort.

  The two alternatives were both considered and both are worse. **Excluding
  Ctrl-C from sequence consumption** fixes the named instance and not the class:
  it is a special case for one key, it leaves `q`, Ctrl-D, Ctrl-Q and Escape --
  which are how most apps are actually quit -- exactly as swallowable, and it
  makes `ctrl+c ctrl+c` unbindable for an app that wanted a confirm-to-quit.
  **Any bound key winning over a pending prefix** is worse still: `g` bound and
  `g g` bound means the lone `g` would win every time, so the disambiguation the
  ticket is about would be deleted to protect one key, and `<leader> f` would be
  unenterable in any app that also binds `f`. That is the feature being removed
  rather than guarded.

  What the trie guarantees instead, stated positively: **a pending sequence
  claims a key only where the app bound a continuation on it.** Anything else
  ends the sequence and is then offered from the root, so it reaches the
  focused element and the Tab default exactly as it would have. So nothing is
  swallowed that the app did not itself name -- and the one case that _is_
  swallowed, `g ctrl+c`, is the app having written Ctrl-C as the second key of a
  sequence, which it chose. `should claim ctrl-c only where the app bound it as a
  continuation` pins that rather than leaving it to be discovered.

- **And a key that reached the trie and did not continue the sequence _answers_
  the question the deadline was waiting on, rather than throwing it away.** `g`
  bound and `g g` bound, `g` then `x`, means `g` -- which is what vim does and
  the only reading that does not silently lose a keystroke the user deliberately
  made. The first version discarded the pending `g`, so the deadline became the
  **only** way to reach a bound `g` rather than the fallback for when nothing
  follows: pressing anything at all inside half a second lost it. Found by
  following a review finding about unbinding mid-wait down to the commoner case
  underneath it, which is the shape worth recording -- the reviewer's own case
  needs a disposer called mid-sequence, and this one needs two ordinary keys.

  At the node reached and no further. Committing an **ancestor** would mean
  deciding that the keys after it were spent on nothing and then saying what
  becomes of them, which is a typeahead replay rather than a rule -- so `g` bound
  and `g a b` bound, pressed `g a x`, commits nothing, exactly as before. Escape
  and Backspace sit **above** this rather than below it, which is the whole
  distinction: those are the user saying "forget it", where a key is the user
  saying which of the two they meant. So does a key a function binding
  **stopped**, for a second reason as well as that one -- it never reached the
  trie, so the question is still open, and something else has claimed that
  keystroke, so running a binding of ours in the same breath is not what anybody
  asked for. All four are pinned.

- **A key a function binding _stopped_ ends the pending sequence, and only a
  stopped one.** Something else acted on that key, so a `g` after it must not
  complete `g g` across it -- the user typed `g`, then a key that did something,
  then `g`. Found by the first run of the tests rather than by reasoning: the
  Ctrl-C test asserted the sequence was gone and it was not, because a stopped
  event returns before the trie is reached. Only where the binding _stopped_ it,
  because a binding that merely watches every key -- which is what a keystroke log
  or a redraw-on-keypress is -- has observed rather than acted, and cancelling
  there would make a sequence unenterable in any app that has one.

- **The deadline is ten times `ESCAPE_TIMEOUT`, because the asymmetry points the
  other way.** That one waits for _bytes from a terminal_, which arrive in
  microseconds unless the link is slow, and its failures are "too short types a
  stray character into somebody's answer, too long makes Escape feel late". This
  waits for _a human finger_, two orders of magnitude slower, and its failures
  are: too short and a deliberate `g g` fires `g` twice, which is the silent wrong
  action and the half that entry is written to protect against, while too long
  makes a bound `g` feel broken, which is the annoyance half. Fifty milliseconds
  would fire `g` twice for essentially everybody, so the trade is taken in the
  direction that does not act wrongly.

  Five hundred rather than a number fitted to anything: vim's `timeoutlen` is
  documented at 1000ms and Emacs waits indefinitely, so those are the two poles
  and this sits between them. It arises only where an app bound **both** a key and
  a sequence starting with it, which is the app choosing the ambiguity, so
  `InputOptions.sequenceTimeout` is how one that knows its own bindings picks.

  A value that is not a finite number at or above zero falls back, which is the
  typewriter's own rule, and a **finite** one past 2^31-1 is _clamped_ -- the same
  trap one step along, since node stores a delay as a signed 32-bit integer and
  reads anything larger as `1`. So `sequenceTimeout: 2147483648` asked for 24 days
  and fired in a millisecond. Clamped rather than thrown away, because a caller
  who wrote one meant "as long as possible" and the ceiling is the nearest answer
  there is, where the default would be _shorter_ than what they asked for. Found
  by review.

- **A node that is a prefix and _not_ a binding waits with no deadline at all.**
  Emacs' answer, and the right one for the same reason: there is nothing to
  disambiguate, and any key that does not continue the sequence has already
  cancelled it -- so a deadline there would throw a half-entered sequence away
  while the user was still reaching for the second key. Which means a leader key,
  the shape everybody wants, costs no timer: `should wait indefinitely where there
  is nothing to disambiguate` asserts the timer count rather than the behaviour,
  because the behaviour is the same either way until the clock moves.

  So `take()` has three shapes and only the third waits: no children is an exact
  match with nothing to decide and fires at once, children and no handler is a
  pure prefix, and both is the ambiguous case. Firing the unambiguous case on a
  deadline instead would make `bind('ctrl+s', save)` -- a one-key sequence, which
  is the ordinary ergonomic use of this -- half a second late.

- **Which shape a node is gets asked again when the deadline fires, because the
  _trie_ can move under it.** The node and the keys are captured rather than read
  back, on the ground that the pending state moving is what clears the timer --
  and that comment denied something it should not have: a **disposer** called
  while the deadline is running edits the trie, and taking the handler off the
  very node the timer was armed for leaves a pure prefix, which waits with no
  deadline at all. Firing an empty handler set there threw the pending sequence
  away for nothing, so `g` with `g g` still bound needed starting again. Found by
  review. The pending state and the timer still cannot part, which is why only
  the handlers are re-read.

- **`take()` is handed its trail rather than reading one off the pending state,
  and the ambient version was measurably wrong.** The second call site offers a
  key from the **root**, where the trail has to be empty whatever `entered` holds
  -- and the commit just above it runs the caller's code, which can start a
  sequence by calling `feed()`. Measured: `g` committed, its handler fed a `d`,
  and the outer `d` was then taken with the inner one still in `entered`, so **one
  keystroke left a pending `d d`** and the `d d` binding fired with three keys.
  Found by re-reading the commit path rather than by a review round, and it is the
  shape this file keeps deleting -- two readers of one ambient variable, where
  passing it makes the function answer for its arguments.

- **A pending node whose path was unbound is nothing pending, and the disposer
  cannot say so.** `sequence.ts` knows nothing about the router on purpose, so
  `reaches()` is asked on the next key instead -- a walk of two or three `parent`
  links, and only while something is pending. It has to ask whether each parent
  still **names** the child rather than whether the walk reaches the root, because
  a prune clears the parent's entry and never the `parent` link. Left out, the
  status line went on showing a sequence that no longer existed and the Escape
  after it was swallowed by the ghost. Also found by review.

- **Escape clears and Backspace pops, and both sit _under_ the rule rather than
  over it.** A continuation the app explicitly bound on either one wins, which is
  the same call Tab already gets: a component that wants it keeps it by stopping
  the event. Nothing is stuck either way, which is what makes that safe -- a key
  that does not continue the sequence has already ended it, so there is no state
  to be trapped in and Escape is a convenience for the pending display rather than
  an escape from a trap. Both are consumed when they act, because cancelling was
  the job; a modifier makes it a different key, so Alt-Escape is not the cancel and
  Alt-Backspace is not the pop, which is "delete the word" in a text field.

  A pop is deliberately **not** re-armed even where what is left is a binding as
  well as a prefix: Backspace is the user editing the sequence, and committing the
  shorter binding on a deadline after an explicit undo is the opposite of what they
  asked for.

- **A focus change invalidates, and one caused by a completing sequence costs
  nothing.** A sequence half-entered into a log pane must not complete in the
  editor beside it, because the second key was typed at something else. Cleared in
  `focus.focus()` before the `:focus` states move, so an effect woken by one
  already reads the pending sequence as gone -- and `reconcileFocus()` goes through
  the same call, so a pane unmounting under a half-entered sequence invalidates it
  too. The completing-sequence case is free rather than special: `fire()` is handed
  the keys and the pending state is already clear before a handler can move
  anything, which is `Show`'s own order -- commit, then run the caller's code --
  and it is also what lets a handler that _feeds more keys_ start from a clean
  state.

- **A pasted key neither advances a sequence nor cancels one.** What is between
  the markers is content by definition, which is the rule a capability reply inside
  a paste already follows -- so a pasted `gg` must not fire a `g g` binding, and a
  paste arriving mid-sequence must not be able to cancel one either. Both halves,
  because a guard on the advance alone would let content end a sequence, and content
  must not drive a binding in either direction. The second half is the one a
  careless `!paste` gets wrong and `should not cancel a pending sequence, even typed
  in` is what fails for it.

- **Two pending states, two deadlines, and no byte both could claim.** `held` in
  `keys()` holds **bytes that have not become a key yet** and is owned by
  `ESCAPE_TIMEOUT`, or by a query's deadline for a control string; the pending
  sequence holds **keys that have already been decoded** and is owned by
  `SEQUENCE_TIMEOUT`. A byte is in exactly one of the two and it moves from the
  first to the second by being decoded, so the ownership is structural rather than
  careful -- `ESC [` sitting as half an arrow key is not a key the sequence can be
  offered, and the sequence's own keys are long past the decoder.

  Both deadlines can be armed at once and they are independent, which the tests
  assert as a timer count. What follows from the two **numbers** rather than from
  anything written down is that the key deadline is the shorter, so a held partial
  always becomes a key before a sequence commits -- and the key it becomes is then
  offered to the sequence like any other. That is the right way round: the
  sequence's deadline exists to guess what the user meant, and a key that has
  actually arrived is not a guess. Both orders are pinned, the second by an app
  that chose a shorter `sequenceTimeout`.

  The consequence worth knowing is that a bare Escape costs `ESCAPE_TIMEOUT`
  before it can cancel anything, because a chunk ending in `ESC` is held whatever
  else is true -- a terminal sends Alt-x as `ESC` then `x` in one write. That is
  the existing asymmetry rather than a new one, and it is why every test about
  Escape here needs a clock.

- **The stream _ending_ leaves the pending sequence alone, and `held` is the
  precedent.** `ended()` deliberately does not tear the router down -- `onEnd()`
  exists so the app decides, and the ordinary thing it decides is `stop()`, which
  clears -- and it leaves the half-arrived **key** and its deadline exactly where
  they are too. So a pending sequence is treated the same way: an exact match that
  is also a prefix still commits on its deadline, which is right, because the
  deadline means "nothing followed" and nothing ever will. What is left over is a
  pure prefix held by an app that was told the stream ended and did not stop the
  router, which is one state class rather than a second mechanism for the router
  to decide on the app's behalf.

- **Tab is claimed by a continuation the app bound on it, which is the Tab rule
  one layer along.** `g tab` bound means `g` then Tab fires that binding and the
  focus does **not** move, because the trie is consulted before the tree and the
  Tab default is after both -- which is the same answer "a component that wants it
  keeps it by stopping the event" already gives. With no such binding, Tab ends
  the sequence like any other key and then moves the focus, and the focus move
  finds nothing left to invalidate.

- **There is no fourth place to ask whether the router stopped.** The question is
  asked at `consume()`'s entry, in its paste loop, and between the keys of a chunk,
  and the one timer this added is cleared by `stop()` the way the key timeout is --
  so it cannot fire into a router with no listeners left, which is asserted as a
  timer count of zero. What _did_ need asking is inside `fire()`, where a sequence
  bound twice whose first handler quits must not reach the second; and a completing
  sequence that stops the router stops the chunk it was in, through the check
  `keys()` already makes between keys.

- **The pending state is a signal, and `hovered` is a getter for the reason it
  is not.** That one is a plain getter because the `hover` state it writes already
  marks the tree and asks for a frame; a pending sequence writes no element state at
  all, so nothing else here would ask for the frame that redraws the status line.
  And it has to be a signal rather than a redraw-on-keypress, because **a sequence
  committing on a deadline is not a key** -- which `10-sequences.js` shows: press
  `g`, wait, and the status line clears itself with nothing having been typed.

  The empty value is one shared frozen array, so clearing a sequence that is
  already clear is not a write: `State.set()` compares with `Object.is`, so a fresh
  `[]` would make every focus move ask for a frame to redraw a line that has not
  moved. Frozen for the reason every initial value in the property table is --
  `readonly` is a TypeScript fiction at run time, and one caller splicing what the
  signal published rewrites what every reader sees.

- **One canonical spelling does both jobs, which is what makes the trie a
  `Map`.** `formatKey()` is what a spec parses _to_ and what a decoded key is
  looked up _by_, so a lookup is a string hash rather than a scan over patterns --
  and a status line showing `ctrl+x` and a trie keyed by `ctrl-x` is two
  vocabularies whose parting is a binding that reads correctly and matches nothing.
  Asserted against the **decoder** rather than against literals: what has to hold
  is that `formatKey()` of what the terminal sent equals `formatKey()` of what the
  app wrote, and a pair of literals could agree while both were wrong about the
  bytes. `Key.sequence` is deliberately not part of it, because `ESC [ A` and
  `ESC O A` are the same Up.

- **The modifiers are stripped as prefixes rather than split on `+`.**
  `'ctrl++'.split('+')` is three pieces and two of them are blank, so a splitter
  has to decide which blank is the key; stripping has nothing to decide, so
  `ctrl++` is the `+` key held with Ctrl and `ctrl+-` is the `-` key. The loop ends
  on `indexOf` answering `-1` specifically rather than on `plus < 1`: the second
  reading asks whether the token minus its last character is a modifier, and for
  `ctrlX` it is -- which strips nothing and goes round again. The
  repeated-modifier check happens to turn that into the wrong _error_ rather than a
  hang, which is the masking this file records elsewhere, so the test asserts the
  **message**. A `+` at position zero needs no test of its own, because the lookup
  answers for the empty string.

- **A spec that cannot be a key throws where it is written.** The rule a `...`
  hint on an option and a keyword the layout engine ignores already follow, and two
  of the refusals are the ones somebody will actually type. `shift+a` is refused
  **naming what to write instead**, because the legacy encoding never reports shift
  for a plain character -- Shift-A arrives as `A` with the flag clear -- so it is a
  binding that can never fire; `shift+tab` is kept, because that is the one place a
  terminal really does report it. And `ctrl+X` is **normalized** to `ctrl+x` rather
  than refused, because the byte is the same one either way and `readOne()` names it
  from `code + 0x60`: the two spellings are one key press, so normalizing is what
  they mean rather than a rewrite of what was asked for.

  What it cannot check is whether a terminal can _send_ what a spec names.
  `ctrl+space` is NUL on most terminals, which the decoder reads as
  Ctrl-backtick, and the legacy encoding has no spelling at all for a great many
  pairs -- that is the limit the Kitty keyboard protocol exists to lift rather than
  something this grammar can enumerate, so it is written down rather than
  pretended about.

- **`KEY_NAMES` is derived from the decoder's own two tables.** The rule
  `COLOR_PROPERTIES` and `INHERITED` already follow: a hand-written list beside
  `SEQUENCES` and `CONTROLS` is a second list to keep in agreement, and a name
  added to one without the other is a key no spec can bind with nothing to say so.
  Filtered to the names of more than one character, because `CONTROLS` maps
  Ctrl-C's byte to `'c'`, which is the letter rather than a name -- a one-character
  name and a character are the same answer reached two ways. A single token is a
  **character** by code point rather than by code unit, so an emoji is one key and
  not two halves of one, which is `readOne()`'s own rule.

  A guard refusing `unknown` by name was written and **deleted for being
  unreachable**: it is produced inline rather than out of either table, so it is
  not in `KEY_NAMES` and the name check already refuses it. The property is
  asserted instead, so the day somebody puts it in a table it fails rather than
  going quiet.

- **The disposer prunes, which is not tidiness.** A node left behind with no
  handler and no children is still a child of its parent, so it is still a prefix
  -- and a prefix is what holds a key back, so unbinding `g g` would leave `g`
  waiting for a second key for the life of the process. Asserted through the
  _timing_: with `g g` gone, `g` fires at once rather than after a deadline. A
  second call does nothing, and the fixture that shows why is the one where the
  path is **partly** pruned and then rebuilt -- with `g a` and `g b` bound,
  removing `g a` leaves the `g` node alive for `b`, so rebinding `g a` hangs a new
  node off that same live parent and a stale disposer called again would delete the
  rebinding. The obvious bind-off-off fixture cannot see it, because there the whole
  path is pruned and the stale node's parent is detached from the trie.

- **A leader is one key, declared once, and it joins _patterns_ rather than
  strings.** What the helper buys over writing ``bind(`${leader} f`, …)`` is that
  an app moving it from Space to Comma edits one line rather than every binding,
  and that the spec is checked as a single key where it is named rather than as the
  first token of each sequence. `dispose()` is "put back what you attached", which
  is worth having because the point of a leader is that one object holds many
  bindings.

  Joining the patterns is what makes `leader.bind('', fn)` an error rather than a
  binding on the leader **by itself**, which is what shipped for a round: built by
  interpolation the spec is `"space "`, whose blank token `parseKeys()` drops, so
  one key is left and the "names no key" error that `parseKeys('')` raises never
  happens -- and pressing Space fired the handler at once. Found by review, and the
  fix removes the re-parse rather than guarding it, which is the shape to prefer:
  there is no longer a string for a token to vanish out of.

- **A sequence handler is handed the keys and nothing else.** A value rather than
  a stoppable event, which is what `onResize()` and `onEnd()` already take: there is
  nothing for it to stop, because the key that completed the sequence was consumed
  by the sequence and the tree never sees it, and a second binding of the same
  sequence is a second thing the app asked for rather than something to cancel. It
  is still dispatched over a copy **and** a membership check, which is the rule
  every handler set in this module follows -- a sequence whose handler rebinds the
  same sequence is exactly the case that rule exists for, and both halves are
  pinned.

- **`bind()` is one method with two signatures rather than two methods.** The
  function form is the one that must stay ahead of everything, and putting the
  sequence form on the same name is what makes that order readable at the call site:
  an app writes `bind(fn)` for the key it must never lose and `bind('g g', fn)` for
  the rest. A spec with the handler forgotten throws a `TypeError`, because
  registering a sequence that consumes the key and does nothing with it is strictly
  worse than the binding not existing -- and the overload refuses it at the call
  site, which is the better half of that.

- **Forty-two sabotages, forty-two caught, and five of them needed a test written
  for them.** Thirty-nine deletions -- twenty-nine over the first version and ten
  more over the guards the review rounds and the re-read added -- plus the three
  **reorderings** round two's own list named, which a pass built out of deletions
  could not express: firing before the reset in each of the two places the
  caller's code runs, and a re-arm after a pop, which is a line _added_ rather
  than removed. Every one of the ten and all three of those were caught first
  time, which is what arriving with a test does. The harness reported two patterns
  as **stale** on the way through, which is the guard this file records it for
  earning its keep a third time: both went stale when `take()` grew a parameter,
  and a pattern that silently matches nothing is a green suite reading as "the
  guard is not load bearing". Every one of the five was a guard whose _fixture_ could not
  reach the branch it was named for, which is the shape this file keeps recording:
  the loop's `-1`, the second removal, the deadline taken off when a key extends a
  sequence, a modified Backspace, and a pop of the only key leaving nothing pending
  rather than leaving the root as the node. That last pair is the subtlest, because
  the two readings publish the same empty list and look up the next key in the same
  place -- they differ only in whether the Escape and Backspace defaults still
  apply, so an Escape after the pop is swallowed by a sequence that had ended. One
  guard was **deleted** rather than tested, which is the `unknown` entry above, and
  one condition was simplified for the same reason -- `plus <= 0`'s zero half,
  whose answer the modifier lookup already gives.

- **And the second round found prose and fixtures, which is what pointing it at
  the skipped files is for.** It was told not to re-attack round one's premises
  and to go at round one's own "not examined" list first, and every finding came
  from there. **Three were sentences**: the demo and the `demos/README.md` both
  said that with `g` and `g g` bound, _anything_ else inside the window fires `g`
  -- which is false of the three keys that are the whole of the exception, Escape,
  Backspace and a key a function binding stopped; `sequenceStep()`'s own docblock
  still said "anything else **cancels** the sequence", describing the version
  before the commit landed; and the sequence timer's comment justified not
  unref'ing it with "the router holds stdin resumed for as long as it runs", which
  stops being true between the stream ending and a `stop()` that never came. The
  first and second are the exact hazard this file keeps naming -- a body aligned to
  that docblock is the discarded-keystroke defect put back -- so that paragraph now
  says it is load bearing.

  **And four fixtures that could not reach the branch they were named for**, each
  verified by running the sabotage round two said would survive. The paste test
  stopped the paste in its handler, and a stopped paste returns before any key is
  dispatched, so deleting the `!paste` on the advance left it green -- nobody
  taking the paste whole is what puts the keys through the dispatch. The
  focus-handler test asserted the keys the handler was **handed**, which are
  captured either way, so firing before the reset passed; what bites is a handler
  that reads the **signal**. The deeper-pop test bound no ambiguous leftover, so a
  re-arm written as "only where there is a handler" survived it. And the
  stopped-key test asserted only the absence of a commit, not that the sequence was
  cleared. All five of those sabotages now fail a named test.

  One of round two's claims was **wrong** and is worth recording as the cost of a
  round: it read a pending `ctrl+x` as a binding and a prefix "via `ctrl+x
  ctrl+s`". Being the prefix of a binding does not make a node a binding, which is
  the distinction the three shapes are about -- so the demo's note was right and
  only its comment overclaimed.

- **What two review rounds found, which the sabotage pass could not.** The first
  round produced three confirmed findings and a coverage list, and every one
  of the three is a shape a pass built out of deletions is blind to by
  construction: a comment that **denied** something true -- the timer's "the
  two cannot part", where the trie can -- a guard whose **ceiling** was wrong
  rather than absent, and a validation that was **bypassed** by the one caller
  that built its spec by interpolation. None is a deletion of a line that is
  there, which is the boundary this file records from the selection work and
  the windowing work both. Following the first of them down found the worse
  case underneath it, which is the commit-on-cancel entry above, and that one
  was a defect in the **behaviour** rather than in a guard. The pre-existing
  re-entrancy finding is the entry under "Asking the terminal what it is" in
  `src/terminal`, since it is reachable from a bare `bind()` handler and has
  nothing to do with sequences.

### The mouse

Enable `1002` plus `1006`, translate the report into the canvas, hit-test the
arranged tree, and dispatch target-then-ancestors. `src/input/mouse.ts` is the
report, `src/element/hit.ts` is the hit test, `Terminal.enableMouse()` is the
mode, and the routing is the router's.

- **Only SGR (`1006`) is read.** The legacy X10 encoding writes a coordinate as one
  byte of `32 + n`, so it runs out at column 223 -- an ordinary width on a wide
  monitor, and a failure that looks like the app ignoring clicks down the
  right-hand side. There is no reason to accept an encoding that cannot describe
  the screen it is reporting about, so a terminal too old for SGR reports nothing
  rather than reporting the left two thirds of itself.
- **The decoder already framed a report as one read, and that was not luck.**
  `isParameter()` reads the private-use `<` because it was widened to, for exactly
  this: ended at the `<`, `ESC [ < 0 ; 1 ; 1 M` left `0;1;1M` to be typed into
  somebody's answer a character at a time. Nothing in the decoder had to change.
- **A report is dropped whether or not anybody asked for tracking**, which is the
  rule a reply nobody is waiting for already follows: it is not a key. A terminal
  some other program left in a tracking mode, or one still reporting after this
  router turned the mode off, would otherwise put `<35;40;12M` in an answer.
- **`1003` is opt-in and `:hover` costs it or nothing.** `1002` reports presses,
  releases and motion while a button is held; `1003` reports **every cell the
  pointer crosses**, for as long as the app runs, over what may be an ssh link. So
  `:hover`, `mouseenter` and `mouseleave` are tracked only under `motion: true`.
  Writing them from a press instead would be worse than not writing them: with no
  motion to clear it, a hover set by a click sticks to whatever was clicked until
  something else is. With it off, `:hover` matches nothing -- exactly what it did
  before there was a mouse, so no sheet changes meaning by turning tracking on.
  The alternative was turning `1003` on by itself wherever some rule uses `:hover`,
  and it is refused: a sheet is one of two consumers, since a `mousemove` handler
  wants motion just as much and no scan can see one, and sheets are swapped at
  runtime, so the wire cost would come and go underneath the app.
- **Translation is the backend's, because a canvas does not know where it sits.**
  Every coordinate a canvas deals in is relative to its own top-left and a report
  is absolute. Full screen is free: the alternate buffer starts at the origin.
  Inline knows how many rows it reserved and not which screen rows those are --
  the log above it moves -- so it asks, with a cursor position report, and
  `origin` is `undefined` until it has. What it costs is one report per re-anchor,
  which is the invalidation list the anchor already had: a resize, a line written
  above the region, an eviction. The router asks once at the start so the common
  case never loses a click, and lazily after that; one probe is outstanding at a
  time, or a pointer dragged across a canvas that has forgotten itself would write
  a cursor query per cell.
- **A reply is checked against the anchor it was asked about.** A cursor report
  comes back a round trip later, so the position it names is where the cursor was
  when the query went out -- which is why `locate()` captures the row rather than
  reading it after the await, since frames in between move the cursor. A
  _re-anchor_ in between moves the origin too, and then the answer describes a
  canvas that is somewhere else, so `unanchor()` bumps a generation and a reply
  that does not match it is thrown away. Both halves are sabotage-checked.
- **`origin`, `toCanvas()` and `locate()` are required on `CanvasBackend`, not
  optional.** Optional members mean a router that branches on their absence, and a
  backend that silently cannot translate is a mouse that silently does not work.
  There are two backends and both answer; an app with a custom one gets a compile
  error naming what to add, which is the loud failure. It costs such an app nothing
  to satisfy the router on its own either, since `MouseSurface` is structural.
- **The asking is the router's and the arithmetic is the backend's**, because one
  thing owns stdin: a reply arrives interleaved with what the user is typing. So
  `locate()` takes the probe rather than making the query, and `MouseSurface` is a
  structural interface naming the four things the router wants from a canvas rather
  than an import of `CanvasBackend` -- the shape `InputStream` and `OutputStream`
  already take there.
- **The clip is carried on the arranged tree rather than computed during paint.**
  A box clipped by an ancestor's `overflow` is not hittable where it is clipped,
  and the hit test needs the _same_ rectangle paint drew inside -- two walks
  intersecting one chain is two answers to one question. So `arrange()` writes
  `element.clip`, and paint draws each element inside it. That reads as though it
  needed `Painter.clip()` to replace rather than intersect, and it does not:
  nothing in the paint walk leaves a clip in effect between elements, so the
  ambient clip is always empty when it asks, and intersecting with nothing is what
  an already-intersected rectangle wants. `undefined` where no ancestor clips,
  which is the common case, so it costs no allocation.
- **`paintOrder()` and `contains()` live in `hit.ts`, though `paint.ts` is paint
  order's primary reader, and the reason is a bundle.** The mouse gave the router a
  reason to reach into the element tree, and reaching it through `element/paint.js`
  for two lines of arithmetic put the layout engine, the cascade and the canvas
  behind `@ttylabs/sigil/input`: measured at **29.4 kB of static import graph before
  and 92.9 kB after**, paid by an app that wanted a key router and no rendering at
  all. `hit.ts` imports nothing but a type, so it was 33.0 kB and the 3.6 kB of
  that is the mouse itself. The import therefore points from paint to hit rather
  than the other way round, which reads backwards and is the lighter module
  winning. One
  implementation either way, which is the part that matters. `should not drag the
  drawing stack in to import the key router` is the ceiling, at about 3x, with the
  markers chosen for what survives minification -- an exported name and a string
  literal, never a name that is only ever called.
- **The hit test is reverse paint order, and `paintOrder()` is exported for it.**
  Topmost first is that list backwards, and a second implementation of "which
  child is on top" is a hit test that disagrees with the screen. Children are
  asked before the element's own box and _not_ gated on the point being inside it,
  because a child with `overflow: visible` is drawn outside its parent and is
  hittable there. `visibility: hidden` skips the element and not the subtree, the
  way paint does, because it inherits. A box with no background is hittable, which
  is CSS -- transparent is not absent -- and there is no `pointer-events` to say
  otherwise, deliberately: nothing needs one, and a property that parses and does
  nothing is worse than one that does not exist.
- **A press captures the pointer, and that is what makes "dropped rather than
  clamped" affordable.** A report outside the canvas rect really is dropped -- a
  click on the log above the region is not the app's -- and on its own that
  strands every component that tracks a press: the release arrives outside, is
  dropped, and a drag waits for a `mouseup` forever. So while a button is held,
  the motion and the release go to whatever the press landed on wherever the
  pointer got to, which is the web's implicit capture and is what makes a
  draggable scrollbar possible. The consequence is that `x` and `y` may be outside
  the canvas on a captured event, exactly as `clientX` is during a drag.
- **A press is never a captured event**, which is not pedantry: it is what
  _creates_ the capture, so reading one sent a second press for a button already
  held to whatever the first one landed on rather than to what is under the
  pointer now. Found by a test, and it is the only bug this ticket's own tests
  turned up in it.
- **A drag is not an event, and the wheel needed no motion.** Press, move and
  release are three events a component already gets, and what a drag _means_ -- a
  threshold, an axis lock, a grabbed handle -- differs per component. The wheel
  turns over whatever is under the pointer, and the ticket's worry that this
  needed `1002` motion to know was unfounded: a report _is_ a position, so a turn
  carries its own coordinates and is hit-tested with no tracking at all.
- **`mouseenter` and `mouseleave` are dispatched along the difference between two
  chains, not bubbled.** It is the one place the dispatch differs by kind, and it
  has to: moving from a child to its sibling leaves the child and enters the
  sibling and does not leave their parent, which the pointer never left -- a
  bubbling leave would say it did, which is precisely why the DOM has two
  spellings of this event. Leave fires innermost first and enter outermost first,
  which is the DOM's order.
- **`:hover` is set on the whole chain, and it is derived rather than stored
  twice.** In CSS the pointer is inside every box that contains it, so a
  `.row:hover` rule has to match the row when the pointer is over the text inside
  it. One source -- the hit test -- with the state derived from it, which is
  exactly how focus works. The states are written before any handler is told, so a
  handler reading `element.states` sees the answer rather than the question.
- **There is no bindings-first step.** That ordering exists for keys so a focused
  input cannot swallow Ctrl-C, and there is no mouse analogue of being unable to
  quit -- so `onMouse()` runs **after** the tree, which is the useful position
  anyway: everything the tree did not claim, _including_ the reports that landed on
  no element at all, which nothing in the tree can see. Stopping a `mousedown`
  there suppresses click-to-focus, which is the mouse's default action the way Tab
  is a key's. `current` is `undefined` for those handlers, because the event is
  past the tree.
- **Click-to-focus leaves the focus alone where nothing under the pointer is
  focusable.** A browser blurs there; this does not, because what that comes to in
  a terminal is the keyboard stopping working because the pointer brushed a
  border, and a click that landed on nothing focusable said nothing about focus.
  Moving focus is what the ring is for.
- **A stopped `mouseup` does not cancel the derived `click`, and finding that out
  took a demo.** Stopping an event stops it _bubbling_; it does not cancel a
  different event, which is the DOM's rule. The first version gated the click on the
  mouseup, and `05-drag.js` walked straight into it: a slider stops the mouseup
  because it owns the drag, and then silently lost the clicks it also wanted -- with
  nothing to point at, since the two spellings look identical from outside. A
  component that wants neither stops both, which is discoverable in a way the other
  way round is not. `should follow a release that something stopped, because they are
  two events` is the guard, and its sibling asserts the click is still stoppable
  itself.
- **A click lands on the nearest box containing both ends.** A press on the text
  inside a button and a release on the button's padding is a click on the button,
  which is the DOM's rule and what everybody expects. A release off the canvas
  needs no guard of its own: there is nothing under it to have anything in common
  with, and an `inside` conjunct written here was deleted again because the suite
  stayed green without it.
- **The hover states are cleared when the router stops, and the focus is not.**
  Nothing will ever clear them otherwise -- the reports have stopped -- so a
  highlight would outlive the tracking that produced it, which is a wrong cell on
  screen forever. Silently, because dispatching into a component while the router
  is being torn down is a worse rule. The asymmetry with focus is the point: focus
  is the app's and survives a prompt borrowing the stream, while hover is the
  pointer's and the pointer has gone.
- **The tracking mode is the loudest entry on the restore list.** A shell left in
  one puts `ESC [ < 35 ; 40 ; 12 M` into whatever the user types next every time
  they move the pointer over the window, which has to be reset by hand -- worse
  than the paste markers and much worse than a hidden cursor. `1006` goes on
  before the tracking mode and off after it, so there is never a moment in which
  the mouse is being reported in an encoding nothing reads, and the mode that was
  turned on is the mode that is turned off.
- **What turning it on takes away is text selection**, and that is stated in the
  demo and in the module docs rather than left to be discovered. A terminal
  reporting the mouse stops doing its own selection, so an app that enables
  tracking has, from the user's point of view, broken copy and paste; shift-drag
  overrides it in most terminals and not all. That was the argument for the
  selection ticket being a follow-on rather than an independent nice-to-have, and
  it is now answered under "Selection and the clipboard" -- `enableSelection()` is
  how an app gives it back, and the iTerm2 alt/option entry below is why the escape
  hatch was never enough on its own.
- **An inline app's mouse is a profile setting away from being switched off
  entirely, and nothing can detect that.** iTerm2 has
  `KEY_RESTRICT_MOUSE_REPORTING_TO_ALTERNATE_SCREEN_MODE` -- "Restrict Mouse
  Reporting to Alternate Screen Mode", default `@NO`
  (`sources/Settings/iTermProfilePreferences.m:1204`) -- and
  `-[PTYSession xtermMouseReporting]` (`PTYSession.m:7076-7084`) reads it: off the
  alternate screen, a profile with that on reports **nothing**, whatever modes the
  app set. So an inline mouse canvas can come up with tracking enabled, the modes
  acknowledged by DECRQM, and not one report ever arriving -- which looks exactly
  like a broken app and is a setting. Found while reading iTerm2 for SIG-128,
  unverified against a real terminal because it is a preference rather than a
  claim about bytes; `terminal-probe.mjs --mouse` is where somebody can settle it,
  since a probe that reports nothing at all in step three on one profile and
  everything on another is the A/B. The full-screen backend is the answer for an
  app that cannot live without the pointer.
- **A write that failed is swallowed along with a terminal that said nothing**, and
  the two are not the same thing. `InputRouter.query()` rejects over a failed write
  on the ground that a broken stream is not a quiet terminal; `relocate()` runs
  inside the stream's `data` listener, where there is nobody to tell and a frame
  must not come down over a mouse move -- so a stream fault costs the mouse and
  nothing else, silently. Written down because it cost a debugging round: the
  screen model in the test suite threw over the `CSI 6 n` it had not been taught,
  and that is where the throw went. The model now models the request as nothing,
  which is what it is -- it changes no cell, and the answer arrives on the input
  stream.
- **`terminal-probe.mjs --mouse` is where the claims only a terminal can settle
  went, and there are more of them here than anywhere else in the stack.** Every
  one is about what a terminal _sends_ rather than about what this reads: whether
  yours answers in SGR at all, whether `1003` is implemented here, whether a click
  past column 223 survives, whether DECRQM will say the modes took, and whether the
  inline origin arithmetic comes out right on a screen nothing simulated. Eight
  steps, each with its own `the claim:` line, and the last of them is the one no
  test can reach: a real inline canvas learns its row from a real cursor report,
  and clicking the target it drew has to report the cell it is drawn in.

  Two things it can say that are worth knowing before reading it. The X10 fallback
  is worse than "breaks past 223" here, because stdin is decoded as UTF-8 and a
  byte past 127 is not a character at all -- so it breaks at column 95. And the
  `1002`-against-`1003` step is an A/B rather than a description: it counts the
  motion reports each mode produces, which is what `:hover`'s wire cost looks like
  as a number on the terminal you are actually using.

  Driving it found a bug in itself, which is the argument for driving it: it read
  `backend.origin` _after_ `backend.done()`, and giving the rows back is exactly
  what makes the origin unknown again -- so it printed `<unknown>` beside a press
  that had translated perfectly, two lines contradicting each other.

- **A router chooses its surface and its tracking mode when it is built, and one
  router per step is a mode that flickers.** The first version of `--mouse` built
  seven, and what that came to on the wire was **fourteen mode changes in under two
  seconds**, twice inside the same millisecond -- measured by capturing every
  `ESC [ ? 100n h/l` the probe wrote. A mode that goes on and off seven times is
  indistinguishable from an app that has lost track of whether it turned one on,
  so it was worth fixing whatever else was true. Reported from a real terminal,
  which is the only place it could have been.

  What this entry used to say next, and what SIG-128 took out, is that iTerm2's
  offer to turn mouse reporting off was iTerm2 spotting the churn. It was not:
  there is no mode-churn heuristic anywhere in iTerm2, the dialog is an echo
  detector, and the entry below is where that is settled with a citation. The
  giveaway was already written down -- the dialog survived this fix -- and it
  should have been read as the attribution failing rather than as a second cause.

  The fix separates the two halves. The **surface** does not need a new router, so
  it delegates to a `target` the probe swaps -- which is what lets the
  inline-origin step share the router every other step uses. The **tracking mode**
  genuinely does change once, so the `1003` step moved to the end. Four mode
  changes now: on, the one switch, off. An app has no such problem, because an app
  has one router; a probe that demonstrates every mode is the one caller that has
  to think about it.

  The step that swaps the surface asks `backend.locate()` itself rather than
  letting the router find out lazily. That is the documented contract rather than
  reaching past it -- `locate(probe)` takes the probe because the router owns stdin
  -- and it is what keeps the step honest: the lazy path costs the report that
  discovers the origin is unknown, and a step whose first click does nothing is a
  step nobody trusts the rest of.

- **A write that does not go through the backend moves an inline canvas and not
  its origin, and with the mouse on that is silently wrong coordinates.** The
  anchor is a row the canvas learnt once; a `console.log()` or a bare
  `process.stdout.write()` underneath it scrolls the screen, so the frame walks up
  while the canvas goes on believing where it started -- and every report then
  translates to a cell a few rows below the one you clicked. `backend.write()` is
  the way to put a line above a live region precisely because it erases, writes and
  reserves the rows again, which throws the anchor away and makes the next report
  re-learn it.

  This is the already-recorded `console.log()`-after-`dispose()` hazard with a
  sharper edge: there the _erase_ was wrong and you could see it, here the
  arithmetic is wrong and everything looks fine. Reported from iTerm2 against the
  probe's own origin step, in the exact words the mechanism predicts -- the target
  stopped taking clicks and the last few printed lines took them instead, because
  that is where the canvas still thought it was. The step paints its feedback into
  the frame now, which is what a live region is for.

- **iTerm2 overrides mouse reporting with alt/option, not shift.** Which key gets
  selection back is the terminal's own and is nothing an app can influence or
  detect, so the probe asks rather than asserting: shift in xterm and most of what
  followed it, and **alt/option in iTerm2, where shift does nothing at all**. Worth
  having written down because the first person to hit it assumes the app broke, and
  because the "shift-drag overrides it in most terminals and not all" this file
  already said turns out to have iTerm2 on the wrong side of it.
- **Every report that arrives prints something, and that is enforced in `live()`
  rather than left to each step.** It was reported three separate times before it
  was taken as a rule, which is the part worth recording: both motion steps
  summarised at the end and printed nothing while they ran, and the wheel step
  printed only the _first_ turn of each direction, so it went quiet after up and
  down however much anybody scrolled. All three were reported as doing nothing,
  which is the correct reading of a screen with nothing on it -- and all three were
  working perfectly.

  Fixing them one at a time was the wrong shape, because the next step to go quiet
  would have been the next report. So what a step's own `render` declines to
  describe now gets a fallback line, and silence means what it should: that no
  report arrived at all, which is itself a finding. The `1003` step is unreadably
  fast on purpose -- that is what the wire is carrying, and a step that summarised
  it would be describing the cost rather than showing it.

  One step opts out, and it is the one that must: the inline-origin step holds an
  anchored canvas, and a write underneath it scrolls the frame out from under the
  origin it learnt. It draws its feedback into the frame instead, which is the
  entry above, seen from the other side.

- **iTerm2's offer to turn mouse reporting off is an _echo_ detector, and it was
  the probe printing the report that armed it.** The entry this replaces said the
  dialog -- "Looks like mouse reporting was left on when an ssh session ended
  unexpectedly or an app misbehaved. Turn it off?" -- was unresolved, and guessed at
  the **main screen**, on the theory that an app which legitimately wants the mouse
  is almost always on the alternate buffer. The guess was wrong in both directions
  and the source settles it (iTerm2 master `91411f5`, 2026-09-30):

  - `-[PTYSession writeMouseReport:]` (`sources/PTYSession/PTYSession.m:14245`)
    calls `detectTurdsForReportData:type:` for **every report iTerm2 sends**, gated
    on the `AutodetectMouseReportingStuck` advanced setting -- **default `YES`**,
    and its own description is the whole answer:
    _"Automatically detect when mouse reporting got stuck on? This watches for
    parts of mouse reporting control sequences being printed to the screen"_
    (`sources/Settings/iTermAdvancedSettingsModel.m:373`).
  - `detectTurdsForReportData:type:` (`PTYSession.m:14258`) reduces the report to
    its **printable residue**: drop the `ESC` and the two bytes after it --
    `if (c == 27) { // Shells generally swallow esc and two characters after it,
    then echo the rest. ignoreCount = 3; }` -- then every byte under 32, keep the
    last 32 of what survives, accumulating onto the previous detector's residue
    while that is under 100ms old. For `ESC [ < 0 ; 41 ; 13 M` the residue is
    `0;41;13M`.
  - `if (string.length > 6)` it arms `[_expect expectRegularExpression:[string
    it_escapedForRegex] ... deadline:[NSDate dateWithTimeIntervalSinceNow:0.1]]`
    (`PTYSession.m:14300-14312`).
  - Expectations are matched by
    `-[PTYTriggerEvaluator reallyCheckTriggersOnPartialLine:...]`
    (`sources/Triggers/PTYTriggerEvaluator.m:173-183`) against
    `stringLine.stringValue`, unanchored -- the **text the program printed**. Only
    printable characters reach that line, through `terminalAppendString:` and
    `terminalAppendAsciiData:`
    (`sources/VT100Screen/VT100ScreenMutableState+TerminalDelegate.m:58,84`), so
    the escape sequences an app writes never count.
  - A match reaches `didDetectTurdOfType:` (`PTYSession.m:14320`), and if
    `_xtermMouseReportingEverAllowed && terminal.mouseMode != MOUSE_REPORTING_NONE`
    it offers (`turnOffMouseReportingOrOffer:`, `PTYSession.m:18243`).

  So the condition is: **the program prints a mouse report's own digits within
  100ms of iTerm2 sending it.** Nothing in that chain reads the alternate screen.
  The one place it could have -- `triggerEvaluatorShouldUseTriggers`
  (`VT100ScreenMutableState.m:7567`), which turns triggers off in interactive apps
  -- falls through to the profile's `Enable Triggers in Interactive Apps`, which
  **defaults to `@YES`** (`iTermProfilePreferences.m:1281`), so the detector runs
  on the alternate buffer too. Nor is it a rate: one armed report is enough, and a
  press in the very corner is never armed at all, because `0;1;1M` is six
  characters and the guard is `> 6`.

  The probe was doing exactly the thing that defines a stuck mouse. Its raw step
  printed `"ESC [<0;41;13M"`, which holds `0;41;13M` verbatim, inside the 50ms its
  own drain timer takes -- so iTerm2 was reading the stream correctly and the one
  caller entitled to print a report was the one caller that must not. It prints
  `"ESC [ < 0 ; 41 ; 13 M"` now, which is how this file spells a sequence anyway.
  `should not be printed verbatim by the probe, which iTerm2 reads as a stuck
  mouse` in `packages/cli/test/mouse-echo.test.ts` is the guard, and it
  **transcribes** the residue rule rather than hard-coding it -- with both sides
  of each boundary asserted, which the first version was not: it had length 6
  false and length 8 true and nothing at 7, so `> 6` could have become `>= 8`
  with the suite green, and no fixture reached the 32-byte cap at all. A
  threshold asserted on one side is the same defect as a test that passes with
  the thing it is named for deleted; it just takes a boundary value rather than a
  deletion to see it.

  That change also claimed the step's own line (`every raw line holds "ESC [ <"`)
  was now literally true of the lines under it, and it was not. `tap` records
  every chunk, and the chunk holding the `q` that _ends_ the step is one -- so
  every raw step on every run printed `raw "q"` last, which holds neither
  `ESC [ <` nor the legacy `ESC [ M`. Two halves to that. The quit chunk is not
  recorded, through an `onMatch` on `untilKey()` that runs inside the router's
  dispatch -- which precedes the tap on that chunk, because the router's `data`
  listener was attached first, and is why it cannot be done after the await. And
  the claim is narrowed to a raw line **of a report**, because a key the reader
  presses mid-step is still shown and no suppression should hide it: an arrow key
  prints `ESC [ A`, which is a line the unqualified claim could never have been
  true of either.

  Measured rather than reasoned, by stripping the escape sequences out of each
  one's real output and searching it for the residue: `04-mouse.js`, `05-drag.js`
  and `06-panes.js` put **no** residue on screen -- they print `(39, 11)` -- and
  the probe's raw step put one there for **every** report that arrived. Which also
  retires the discriminator the old entry proposed: `06-panes.js` being quiet would
  have proved nothing, since it is quiet for printing coordinates rather than for
  being full screen.

  What it leaves for an app author is a real constraint rather than a sigil bug: a
  debug overlay, a log line or a `--verbose` dump that writes a report's bytes
  where the user can see them will be offered this dialog, on any iTerm2 with the
  default settings, and the terminal is right to offer it. Print what the report
  _meant_, not what it _was_; if the bytes are the point, space them out.

- **"Never" on that dialog is stored under a key nobody would have looked for, and
  the catalog it was looked for in is the wrong mechanism.** The dialog's three
  buttons are Yes / Always / Never, and Never writes
  `[[iTermUserDefaults userDefaults] setBool:NO forKey:@"NoSyncTurnOffMouseReportingOnHostChange"]`
  (`PTYSession.m:18405-18408`, with the key at `PTYSession.m:247`) -- in
  `com.googlecode.iterm2`, since `+[iTermUserDefaults userDefaults]` is
  `NSUserDefaults standardUserDefaults` unless a custom suite is in play
  (`sources/Settings/iTermUserDefaults.m:99-113`). So **clearing it is
  `defaults delete com.googlecode.iterm2 NoSyncTurnOffMouseReportingOnHostChange`,
  with iTerm2 quit first**, because it writes prefs on the way out and would
  otherwise put the value back; or Settings → Advanced → "Always turn off mouse
  reporting when host changes?" → back to **Unspecified**, which is the same key
  exposed as a tri-state (`iTermAdvancedSettingsModel.m:777`). `nil` there is what
  means "ask", which is why deleting the key is the un-suppress rather than setting
  it to anything. The _other_ key worth clearing is
  `NoSyncNeverAskAboutMouseReportingFrustration`, because it is read as a gate on
  this dialog too (`PTYSession.m:14248` and `14324`) even though it is set by a
  different nag about Cmd-C.

  It is not in `NoSyncSuppressedAlertsCatalog`, and that is a fact about the
  mechanism rather than a flush that had not happened: that catalog tracks
  `iTermWarning` modals -- "Tracks alerts (iTermWarning) that were auto-answered
  because the user previously chose 'remember my choice'"
  (`sources/Infrastructure/iTermSuppressedAlerts.swift:5-8`) -- and this is an
  `iTermAnnouncementViewController`, the banner that slides down inside the
  session. Announcements keep their suppression in their own keys and appear in no
  catalog, so the right place to look for any of them is the `kTurnOff...UserDefaultsKey`
  constants at the top of `PTYSession.m`.

- **The same dialog has a second door, and no sigil app can reach it.**
  `maybeResetTerminalStateOnHostChange:` (`PTYSession.m:18280`) offers it when
  shell integration reports a **host change** with tracking still on -- the
  genuinely stuck case the wording is written for. It is gated on
  `previousHostName && ![previousHostName isEqualToString:host.hostname] &&
  !viaSSHIntegration && !bothLocalhost` (`PTYSession.m:18226-18229`), so a local run
  never reaches it. Worth writing down because it is why the wording mentions ssh
  at all, and because it means a sigil app that really does leave tracking on after
  dying over ssh gets told -- which is the restore list working from the far side.
  iTerm2 says the two doors itself, in the comment over the announcement's
  identifier: _"This used to be only for host change but now it also runs off an
  expectation"_ (`PTYSession.m:251`). The expectation is the echo detector, and the
  stale name is why the user-defaults key reads `OnHostChange` for a dialog that a
  local run with no shell integration can still raise.

- **There is no mode-churn heuristic in iTerm2, so the churn entry above was right
  about the bug and wrong about the dialog.** Grepping every user-facing string
  that mentions mouse reporting finds three and only three:
  `PTYSession.MouseReportingLeftOn`, which is this one and whose only two triggers
  are the echo detector and the host change; `NaggingController.MouseReportingFrustration`
  (`sources/PTYSession/iTermNaggingController.m:501`), a different sentence about a
  drag followed by Cmd-C; and `PTYSession.HorizontalScrollInfo`
  (`PTYSession.m:21988`), which is informational. Nothing counts mode changes. So
  fourteen mode changes in two seconds was a real bug and worth the fix on its own
  terms -- a mode that flickers is a mode nobody can reason about -- but the
  sentence attributing the dialog to it was a guess, and the fact that the dialog
  survived the fix is what should have been read as the guess failing rather than
  as a second cause.

- **The mode-transition discipline was audited on the wire and is exactly what this
  file claims.** Not read and reasoned about: each demo and the probe were spawned
  over streams that answer `isTTY`, with `process.stdout.write` wrapped to record
  every `CSI ? Ps h` and `CSI ? Ps l` with the millisecond it was written at.
  `04-mouse.js`, `05-drag.js` and `06-panes.js` each write **four** mouse-related
  transitions and no more -- `1006h`, `1003h`, then `1003l`, `1006l` -- so `1006`
  goes on before the tracking mode and off after it, nothing is turned on twice,
  and nothing is turned off that was not on. `06-panes.js` adds `1049h`/`1049l`
  around them and asks for no cursor report, which is the full-screen origin being
  free. The probe writes **eight**, because it builds two routers: `1006h 1002h`,
  then `1002l 1006l 1006h 1003h` inside one millisecond for the `1003` switch, then
  `1003l 1006l`. That is the "four mode changes" this file already records, counted
  the way the fourteen were counted -- **tracking**-mode changes, two per router --
  and the encoding's four ride along with them. Written out because the two counts
  are of different things and the next reader should not have to work out which.
- **The end-to-end test is the half nothing else can say.**
  `test/input/mouse-router.test.ts` hands the router a canvas that already knows
  where it sits, which is the only way to test the routing rules on their own;
  `test/renderer/mouse.test.ts` puts a real renderer over a real inline backend
  over the screen model, answers a real cursor report from the model's own cursor,
  and asserts that a report naming a screen cell reaches the element painted
  there. Neither replaces the other.
- **The demo's own `q` key is the interaction worth showing.** `03-focus.js` quits
  on `q` only when nothing is focused, because there it is a character somebody
  may be typing into a field. `04-mouse.js` cannot afford that guard: click-to-focus
  means a click leaves something focused, so the guard made `q` stop working the
  moment you clicked anything -- which it did, until it was run.
- **Three demos, and each one is for a claim the others cannot make.**
  `04-mouse.js` is hover, click-to-focus and the wheel over an inline canvas.
  `05-drag.js` is the capture, which is invisible until something is dragged past
  the edge of the region -- and it is the demo that found the `mouseup`/`click`
  conflation above. `06-panes.js` is the full-screen backend, where translating a
  report is free, spent on the three things the hit test claims: a scrolled box is
  where it is drawn, a clipped one is not hittable where it is clipped, and a
  `z-index` overlay is hit before what it covers. None of them can be driven by the
  demos test, which spawns with stdin ignored, so each takes the no-terminal branch
  there and was exercised by hand through a faked TTY that answers the cursor
  request -- without that answer the canvas never learns its row and every report is
  dropped, which is the demo behaving correctly and looks exactly like a broken one.
- **An overlay whose only opacity is a background is transparent at colour level
  zero**, which is degradation working and reads as a broken demo. `06-panes.js`
  fills its overlay with three lines of text as well, so the stacking order is
  legible on a terminal with `NO_COLOR` set. Worth knowing before drawing anything
  that has to cover what is behind it: the fill is a `background-color`, and level 0
  drops colour.

### Selection and the clipboard

What SIG-106 took away, SIG-107 gives back. The argument is not that selection is
a nice feature: **mouse tracking removes the terminal's own selection**, so an
app that enabled it has, from the user's point of view, broken copy and paste --
and the escape hatch is weaker than the ticket assumed, because this file already
records that **iTerm2 overrides tracking with alt/option and shift does nothing
there at all**. Which key gets selection back is the terminal's own and is nothing
an app can influence or detect, so an app that wants it has to have its own.

`src/canvas/selection.ts` is the model, `src/element/selection.ts` is which cells
may be copied, `src/terminal/clipboard.ts` is OSC 52, and
`src/renderer/selection.ts` is the gesture.

- **A selection is two cells over the painted grid, not a range over the element
  tree.** The tree version is to walk the texts between two elements and
  concatenate, which gives semantically tidy text and needs a **reading order for a
  flexbox tree**, which flexbox has not got: a `row-reverse` of three texts has no
  answer, and an absolutely positioned overlay sitting on top of a paragraph has a
  worse one. The grid is what the user is pointing at, it already knows what a wide
  cluster is and where its continuation went, `toLines()` was already here, and one
  cell pair gives both a linear and a rectangular selection with no second model.
  What it costs is that the text is **laid-out** text -- a wrapped paragraph copies
  with its wrap points in it -- which is what selecting from a terminal has always
  given you.
- **It spans the whole canvas rather than the nearest clipping box, which is the
  first question the ticket left open.** Scoped is more useful in a two-pane layout
  and is also where the grid model stops being a grid model: an anchor that belongs
  to a box has to carry an element identity, and then the selection is a tree
  reference after all -- with no answer for an anchor in one pane and a focus in
  another, or for a box that scrolls or unmounts mid-drag. What scoping was _for_
  is already answered twice over from the same two coordinates. **Block mode** is
  the real need: a rectangular drag down one pane copies exactly that pane's
  columns, which is asserted end to end -- an alt-drag down the demo's left pane
  copies `alpha\nbravo\ncharlie` and none of the right one. And
  `selectable={false}` is the answer for a pane that must never be copied at all.
  So: the whole canvas, with two narrower mechanisms doing the job scoping was
  wanted for.
- **There is no default binding for copy, which is the second question.** Ctrl-C
  is the abort, and the binding order exists precisely so that an app cannot become
  unquittable -- a framework that made Ctrl-C mean copy _whenever something was
  selected_ would be that failure wearing a condition, which is worse than the
  unconditional version because the same key then does two things depending on
  invisible state. Ctrl-Shift-C reaches a terminal as the same `0x03` Ctrl-C does
  without the Kitty keyboard protocol, which is explicitly out of scope: a
  framework claiming it would be claiming a key it cannot hear. And there is no
  third convention a terminal app can rely on. So `enableSelection()` binds nothing
  for it and `handle.copy()` is what an app calls; the demo picks Ctrl-Y, which is
  the app's choice rather than the framework's. It keeps vi's yank mnemonic while
  being a chord a text field cannot swallow, which a bare `y` is not, and it
  arrives on every layout with nothing configured -- which the two keys nano uses
  do not. nano's `^6` is _Set Mark_ rather than copy, and it reaches a terminal as
  `0x1E` only because `^` sits on the 6 key, so a layout that moves `^` sends
  something else or nothing; nano's copy is `M-6`, which decodes cleanly here as
  meta with a name of `6` and then depends on the terminal mapping Option to Esc+,
  a per-profile setting on macOS. Both are hearable and neither is portable.
- **Shift-arrow _is_ bound, and the asymmetry is about what can be heard.** A
  shift-arrow is a distinct sequence -- `CSI 1 ; 2 A` -- that nothing else claims,
  where no copy chord is; so the keyboard half is real and the copy half cannot be.
  It acts **only while nothing is focused**, which is the rule `03-focus.js`
  already follows for its own `q`: a binding is ahead of the focused element, and
  shift-arrow inside a text field is that field's. With no selection it starts one
  at the canvas's own origin, which is the only cell this layer can name without
  inventing a caret nothing else reads.
- **The highlight is a style override applied at paint time, and nothing is ever
  written into the cells.** `Painter.overlay()` re-styles a run of cells the tree
  has already drawn, and it is called last inside the same `backend.render()` -- so
  the highlight is recomputed from the live selection on every frame and `paint()`'s
  own `clear()` is what removes the last one. The alternative is to write it in as
  though something had painted it, after which it survives into the next frame's
  diff and a selection that moved leaves the old one behind.
- **`CellBuffer.restyle()` carries a style to the other half of a wide cluster,
  and that is the grid's rather than a caller's.** `put()` writes one index to both
  halves and the **diff draws the lead and skips the continuation**, so a style
  written to one half alone is a style the terminal is never told about: the glyph
  comes out in the other half's style and the highlight vanishes. Reading it from
  either half gives the same answer for the same reason, so a selection that
  touched either cell highlights the cluster whole -- which is also what extraction
  does, by growing a run left onto its lead. Pinned twice: as a unit, and by a
  **replay against the model terminal** in `diff.test.ts`, which is the only place
  the overlay meets the diff.
- **`overlay()` takes a run rather than a rectangle, because the one rule it needs
  is about a row.** Visiting a continuation after its lead applies the transform
  twice, and the transform is **not idempotent**: it toggles. A selected wide
  cluster therefore came out _not_ highlighted. So a continuation is skipped unless
  it is the run's first cell, where its lead sits outside the run and `restyle()` is
  what reaches it. `should not invert a wide cluster twice` is the guard.
- **The highlight toggles reverse video rather than setting it.** Setting the bit
  makes a selection over a run an app already drew `inverse` invisible, which is the
  one case a highlight exists for; toggling it un-inverts that run, which is what a
  terminal's own selection does to one.
- **Nothing is drawn at colour level 0, and the selection still copies.** The rule
  the prompt caret already follows said one layer along: at level 0 the seven
  attributes go too, so a reverse-video highlight would be the one sequence
  `NO_COLOR` could not switch off. The two ways to reach level 0 are a pipe and
  `NO_COLOR`; the first has no interactive selection and the second is a user who
  asked for no attributes. What is lost is the highlight and nothing else --
  `selectionText()` and `copy()` answer the same either way, which is asserted as a
  pair in one test, because a vitest worker's own level is 0 and a test that only
  asserted the absence would pass with the guard deleted. Inventing something else
  at level 0 -- brackets, a marker glyph -- is refused for a sharper reason than the
  degrader's: it would write _characters_ into the grid, which the selection would
  then copy.
- **The level is read in the renderer rather than in the canvas, which keeps the
  canvas ignorant of colour the way it already is.** `canvas/selection.ts` emits
  whatever style it was handed, exactly as `colorParams()` does; the renderer is
  where `cascade.media.colorLevel` already lives.
- **A selection change is a repaint and not a layout, so it is its own flag.** The
  restyler answers for what a _style_ change implies and `Marks` for what the tree
  recorded; a selection is neither an element nor a style, so nothing either of them
  holds can say it moved -- and `full` is the wrong flag, because it forces a layout
  and no box has moved. `repaint` is the third input to `needPaint`, beside
  `marks.paint` and `update.paint`.
- **A resize throws the selection away.** The cells it named describe a screen that
  no longer exists, which is exactly why the canvas discards both buffers there --
  so keeping a cell pair across one would name whatever the re-layout happens to put
  at those coordinates. Dropped rather than mapped, because there is nothing to map
  it through: the content moved and may have rewrapped.
- **The _gesture_ has to go with it, and clearing one and not the other put the
  selection straight back.** The renderer holds the selection and the driver holds
  the anchor, which is a cell of the same grid -- so a resize that cleared only the
  renderer's half left a drag still in progress writing the selection back from the
  pre-resize cell on its very next motion report, with the highlight and
  `selectionText()` both returning and anchored where nothing is any more.
  `extend()` read the same stale anchor. So `enableSelection()` subscribes to
  `input.onResize()` and clears the anchor, which ends the gesture: `mousemove` is
  gated on the anchor existing, and a release is a `mouseup` the driver ignores. The
  **anchor and nothing else** -- a `view.setSelection(undefined)` here as well would
  be a second mechanism for a thing the renderer already owns, which is the masking
  recorded two entries below. The unsubscribe is "put back what you attached", the
  rule the `EPIPE` guard and every restore-list entry already follow, and it has an
  assertion of its own because what it leaves behind is a handler rather than a wrong
  pixel.

  **"Every other path is gated on the anchor" is one path wider than the code, and
  the honest version names the way out.** `extend()` falls back to
  `view.selection?.anchor`, which is what makes it work after a bare
  `view.setSelection()` and is worth keeping for that -- so during the resize
  fan-out itself, an **app** handler on `input.onResize` that calls `extend()`
  before the renderer's own clear has run reads the stale selection and writes it
  back, and the `anchor ??=` beside it resurrects the anchor too. Nothing in the
  framework calls `extend()` in that window, and once both clears have run there is
  neither an anchor nor a selection to fall back to, so the next shift-arrow calls
  `begin(0, 0)` rather than reading a cell of the old grid -- which is the half that
  is guaranteed and is pinned by `should begin fresh rather than from a stale anchor
  when extend follows a resize`. The other half is an app doing it to itself, and is
  recorded rather than guarded: the alternative is clearing the renderer's half from
  the driver as well, which is exactly the second mechanism the paragraph above
  refuses.

- **The sabotage pass found none of that, and the reason is the method's own
  boundary rather than a slip.** Twenty-six guards were each deleted and each
  failed a named test, which is a true statement about the guards that **exist** --
  and a pass built out of deletions cannot find a guard nobody wrote. This one was
  found by review. The near miss is sharper than a missing test, and worth knowing
  as a shape: `should clear the selection on a resize` is **correct for what it
  claims** -- it is the renderer's rule, it calls `view.setSelection()` directly,
  and sabotaging `selected = undefined` fails it. What it cannot see is the
  _driver_, because it installs none; the gap was the **crossover**, one layer's
  event against another layer's state, and neither file's tests had a reason to
  reach for it. The audit that followed is the useful half: every test in the
  overlay block asserts a renderer claim through a renderer call, and every test in
  the driver block asserts a gesture through `input`, so the scopes were right and
  the crossing was simply absent. A sabotage pass answers "is this guard load
  bearing"; it never answers "is a guard missing", and reading it as the second is
  how a review round finds something a green suite did not.

  Three more rounds of review found four more of exactly that shape, which is what
  makes it a rule rather than one anecdote: `inSelection()` against
  `selectionRuns()`, `selectable` asked at a cluster's two halves, `extend()`'s
  fallback against the gesture's anchor, and `visibility: hidden` on the mask with
  no test. Every one is either two readers of one rule or a rule with no reader at
  all, and a deletion-based pass can see neither -- it asks whether the code that is
  there is load bearing, and all four were about code that agreed with itself.

- **Trailing blanks go per line, and a cell nothing may copy comes out as a
  blank.** The first is the reason `renderToString()` already gives: a region padded
  out to the pane's width is one nobody can paste anywhere useful. The second is the
  less obvious half -- dropping an uncopyable cell would pull the text on either side
  together and misalign every line that crossed one, while a blank keeps the shape
  and the trailing-blank rule removes it where it was at the end anyway. A wide
  cluster nothing may copy becomes two blanks, for the same reason.
- **`selectable` is a reserved prop, which changes the list this file records.** It
  was `class`, `focusable`, `id`, `key` and `tabindex`; it is six now, and
  `template/props.ts` says so in the same place. It is _not_ a style property, and
  that is the decision rather than an omission: nothing about it changes what a cell
  looks like, so it is not in the cascade's vocabulary -- and putting it there would
  let a **theme** decide what the user may copy, which is not a thing a colour sheet
  should be able to say. It costs the inheritance the cascade would have given for
  free, which is the walk below.
- **It defaults to true on `text` and false on `raw`, and it inherits.** A
  sparkline or a half-block image is a wall of block characters nobody wants in
  their clipboard, which is the whole reason the prop exists; an explicit value wins
  for the element and everything under it, so a `selectable={false}` on a pane means
  the pane.
- **And a `raw` that really does draw characters says so where it is built, through
  `RawOptions.drawsText`, which changes that default rather than answering over the
  top of it.** The decrypt component is the reader and the entry under "A decrypt
  effect" has the measurement: `selectable: true` on such an element is an _answer_,
  so it beats everything above it and a pane marked `selectable={false}` had its
  decrypt copied anyway. On the options rather than as a third prop value because it
  is a property of what the painter draws rather than of what a caller wants -- a
  raw cannot forget what it is, and it keeps a sheet out of deciding what may be
  copied, which is why `selectable` is a reserved prop rather than a style property
  at all.
- **Only `text` and `raw` write to the mask, which is the part that reads as a gap
  and is not.** They are the two host types that draw _content_, so in paint order
  the last one painted at a cell decides. Every element stamping its own box is the
  obvious alternative and is wrong for a transparent `box` overlapping a `raw`: it
  paints nothing there, the sparkline is still what is on screen, and it would have
  marked those cells copyable. What that leaves outside the question is a box's
  background and its border, which stay copyable -- they are blanks and box-drawing
  characters, which a terminal's own selection hands over too, so `selectable` means
  content rather than decoration.
- **`selectableAt()` answers `undefined` where there is nothing to exclude, and
  that is a fast path rather than a claim.** A tree with no `raw` and no
  `selectable` has a mask of all ones, which is an allocation and a lookup per cell
  to say what `undefined` says for free. It is pinned anyway, because the predicate
  being absent is observable. The `display: none` skip beside it **is** a fast path:
  measured, `arrange()` gives such a node a zero-area box and gives its children no
  box at all, so the walk writes nothing either way -- it is kept for the cost and
  because paint and the hit test ask the same question in the same place.
- **OSC 52 is a write and not a mode, so it is not on the restore list.** That
  settles the other thing the ticket flagged. Nothing is turned on, so there is
  nothing for `restore()` to put back -- unlike the paste markers and the tracking
  modes beside it, which a CLI that dies leaves a shell wearing. Asserted rather
  than reasoned: a copy followed by `restore()` writes nothing.
- **There is no success to claim, and `written` is named for what it can say.** A
  terminal does not answer an OSC 52 -- no reply, no DECRQM, no second query that
  says whether the first landed -- several refuse it by default, and tmux needs
  `set -g set-clipboard on` and may put the text in a tmux buffer instead. So
  `ClipboardCopy.written` means the bytes reached the stream, which is the strongest
  true statement available, and it is false only for a refusal or a stream whose far
  end has gone.
- **"Several refuse it by default" is iTerm2 out of the box, which is the sharpest
  form of the entry above.** `AllowClipboardAccess` defaults to `@NO`
  (`iTermPreferences.m:726`), and `screenCopyStringToPasteboard:`
  (`PTYSession.m:20258`) notes the attempt and _then_ reads it, returning without
  copying when it is off -- so the refusal is silent to the app: the bytes went out,
  `written` is true, and nothing reached the pasteboard. That is `written` doing the
  job it is named for rather than a hole in it, and it is why the demo's answer is
  to paste somewhere and find out. iTerm2 does announce the denial itself, behind
  `noSyncSuppressClipboardAccessDeniedWarning` (`PTYSession.m:19895`), which is the
  diagnostic worth having: a copy that never arrives _and_ no denial banner is that
  warning having been suppressed earlier, not a write that was allowed. Read out of
  the source at `91411f5` and deliberately not claimed of any running profile --
  what a given one has set is a question only that machine answers, which is what
  `--clipboard` is for.
- **iTerm2 nags on a drag followed by Cmd-C, and copying is what disarms it.** A
  third announcement, separate from the two the mouse section catalogues: a state
  machine of its own, `iTermMouseReportingFrustrationDetector`
  (`sources/TryingTooHard/iTermMouseReportingFrustrationDetector.m`), arms on a
  **reported** mouse-down, a reported drag, and a reported mouse-up with
  `clickCount == 0`, and fires on Cmd-C from there -- "mouse reporting has prevented
  making a selection. Disable mouse reporting?" (`iTermNaggingController.m:497`).
  Any other keypress resets it to Ground, so the trigger is exactly a drag and then
  Cmd-C with nothing in between, and it is iTerm2 being right again: with tracking
  on there is no selection for Cmd-C to take. What makes it worth recording rather
  than merely surviving is that **iTerm2 offers a cooperation hook and this feature
  already satisfies it** -- `screenTerminalAttemptedPasteboardAccess`
  (`PTYSession.m:19890`) calls `didCopyToPasteboardWithControlSequence`, which puts
  the detector back to Ground, and it runs _before_ the permission gate, so even a
  refused OSC 52 disarms the nag. An app that copies the way this one does is
  rewarded for doing it, and the answer to the banner is the app's own copy key
  rather than Cmd-C. Reported from a real iTerm2; the condition is read from the
  source.
- **A key binding cannot get round that one, so do not reach for one.** Remapping
  Cmd-C to send the app's copy key looks like the fix and is not: `keyDown:` on
  `PTYTextView` feeds the mouse handler before the keyboard handler
  (`PTYTextView.m:767-768`), so the detector sees the Cmd-C whatever the bindings
  say, and the app's OSC 52 arrives a round trip later -- after the banner. The
  remap makes Cmd-C copy and still nags. An option-drag is the way out that works,
  because a drag the terminal keeps for itself is never reported and the detector
  never arms at all.
- **That banner's "Stop Asking" is shared with the echo detector's.** It sets
  `NoSyncNeverAskAboutMouseReportingFrustration` (`iTermNaggingController.m:523`),
  which is the key `PTYSession.m:14248` and `14324` also read as a gate on the
  "mouse reporting was left on" dialog -- so suppressing this one suppresses that
  one too. The mouse section records the sharing from the other end; this is the end
  that sets it.
- **The control-character guard is in the encoder, not in the caller.** An OSC runs
  until its terminator, so a control character in the payload ends the sequence
  early and the rest reaches the terminal as commands -- the same injection
  `assertLink()` refuses for a hyperlink URI. Base64 closes it by construction,
  which is _why_ OSC 52 is base64; the point of putting it in the encoder is that
  there is one way to build the sequence and it always encodes, so a caller cannot
  opt out of the safety by handing over something raw. The assertion under it is a
  tripwire for the day somebody adds a verbatim option, and is unreachable today.
  `ESC \` terminates rather than BEL, which is the rule `canvas/style.ts` already
  keeps for OSC 8.
- **Over the cap it refuses by default and truncates only when asked.** A terminal
  handed too much drops the **whole** sequence silently, so sending and hoping is the
  one answer that cannot be observed: a caller who asked for 80 kB and got nothing
  has no way to find out. The refusal is visible; `truncate: true` is the deliberate
  other half, and it cuts on **grapheme cluster** boundaries, because a cut inside a
  cluster is a lone regional indicator or an orphaned mark -- not what anybody
  selected, and in the surrogate case bytes no decoder can read. Code points are not
  the unit and a test says so: a flag is two four-byte indicators, and a five-byte
  budget takes neither.
- **An empty text writes nothing rather than an empty payload.** OSC 52 with an
  empty payload _clears_ the clipboard on most terminals, and "copy nothing" is not
  a request to throw away what the user copied an hour ago. So it is a refusal the
  caller can see, which is also what makes Ctrl-Y with nothing selected say so in
  the demo rather than silently wiping.
- **`CLIPBOARD_LIMIT` is 74,994 and the probe found the derivation to be one byte
  out.** It is what every other OSC 52 tool uses, derived as a 100,000-byte ceiling
  over base64's 4-for-3 -- and the nine bytes of `ESC ] 5 2 ; c ;` and `ESC \` put
  the whole sequence at **100,001**, which `--clipboard` printed on its first run.
  Kept anyway, because being the same number as every other tool is worth more than
  nine bytes against a cap nobody will state: it is a guess about other people's
  software, several of them capping far lower, and `limit` is there for a caller who
  has measured their own. Pinned at 100,001 rather than at the ceiling, so the
  comment and the test say the same true thing.
- **Reading is not implemented and is not an omission.** `ESC ] 52 ; c ; ? ST` asks
  the terminal to send the clipboard back on stdin, which is a remote process
  exfiltrating whatever the user last copied -- which is why it is disabled by
  default nearly everywhere and why it should be. Paste arrives through bracketed
  paste, which the router already reads and which the user has to actually perform.
- **A shift-drag is left alone.** Where a terminal honours shift as the override
  this never sees the report at all; where it forwards one with the bit set, acting
  on it would put a selection of ours underneath the terminal's own. Either way the
  user's muscle memory is the terminal's to serve. Alt is what makes a drag
  rectangular, which is Windows Terminal's and iTerm2's spelling -- and in iTerm2 an
  alt-drag never reaches the app, because alt is what gives you the terminal's own
  selection there, which is the terminal doing the job rather than this failing to.
  `block: 'ctrl'` is xterm's spelling, for an app that wants the mode reachable
  everywhere.
- **A press clears and records; the first drag report is what selects.** A click
  with no drag therefore leaves nothing selected, which is what a terminal does --
  and it is why the anchor is kept in the driver rather than as a one-cell selection
  nobody asked for. Selection needs no `motion: true`: a held button's motion is
  what `1002` already reports, so this costs no `1003` and gives up only `:hover`.
- **A keyboard extension is clamped and a drag is not.** A press captures the
  pointer, so a drag's focus may legitimately be outside the canvas and
  `selectionRuns()` clamps it to the edge -- which is what the user means by it. An
  arrow key has no capture to honour, and an unclamped focus walking further off the
  edge every keystroke is a selection that looks stuck for as many presses as it
  took to get there.
- **`inSelection()` is asked of `selectionRuns()`, because two readers of that
  clamp disagreed.** It had arithmetic of its own over the raw endpoints, and what
  it did not have is the clamp in the entry above: on a 10x4 grid an anchor at
  `(5,2)` with a focus at `(3,-5)` makes row 0 the selection's **first** row, so
  its run starts at column 3 -- while the predicate still read row 0 as a _middle_
  row, since `y > start.y && y < end.y` is true of a row the clamp promoted, and
  filled it edge to edge. Measured over every cell rather than argued: three cells
  on that selection, two more for a focus _below_ the grid, and one in each mode
  for a same-row pair whose two ends both sit right of the edge, where the runs
  cover the last column and the predicate covers nothing at all.

  **Kept rather than deleted, and derived rather than taught the clamp.** Nothing
  in `src/` calls it, which is the decision to take rather than a reason to
  dismiss it: `Command.file` and `BundleResult.generated` were both removed for
  being exported, unread and wrong if read, and what separates this from those is
  that the question has one right answer which `selectionRuns()` already holds. So
  the fix is not to copy the clamp into the second reader, which is the shape that
  drifted in the first place -- it is to stop having a second reader. Membership is
  a walk over the runs now, which is the rule `isSgr()` and `readRoutes()` already
  follow and is what makes the agreement structural instead of a coincidence. It
  costs a run list per point query, which at terminal scale is nothing, and it
  costs the signature a `height`: the grid is what membership needs, because the
  height is what decides which row is first. The `Cell` is truncated the way
  `createSelection()` truncates its own, so the type means one thing at both entry
  points, and `NaN` matches no run.

  **Whether a drag can reach it was disputed, and the trace says yes.** The
  reviewer's narrowing -- that the disagreement needs both ends past the same edge,
  since a press outside the canvas is dropped -- is right about the press and wrong
  about the conclusion: a press _inside_ is the ordinary case, so the anchor is
  always on the grid, and the first counterexample above is exactly an on-grid
  anchor with an off-grid focus. Three links, each already pinned or documented: a
  captured move is dispatched while `!inside`, which `should report a captured
  position even where it is off the canvas` asserts; `toCanvas()` is a subtraction
  with no clamp, so an inline canvas anchored at row 10 reads a report at screen
  row 3 as `y = -8`; and a drag is deliberately unclamped where a keyboard
  extension is not. What is **not** claimed is that any of it was user-visible --
  with no caller, the divergence was a wrong answer waiting for its first one,
  which is the whole argument for fixing the contract rather than the symptom.

  **And its test was vacuous at the boundary, which is the third instance of that
  shape on this branch.** `should agree with the runs it is the per-cell form of`
  built both endpoints inside the grid, which is the one case the clamp cannot
  matter in, so it stayed green with the clamp removed _and_ with the old
  predicate in place. It walks five off-grid pairs now, in both modes, over every
  cell. The sabotage is worth reading for what it says about the fix: the old
  predicate fails the off-grid test on the reported cell, while removing the clamp
  fails `should clamp a focus the capture let wander off the canvas` and **not**
  the agreement test -- which is the fix working rather than a gap, since with one
  implementation a clamp both readers share cannot be caught by asking whether
  they agree.

- **A run that begins on a continuation is asked about its lead, and that was the
  same two-reader shape one layer down.** `selectionText()` grows such a run left
  onto the lead and asks `selectable` there, because a cluster is one character and
  that is where it is; `overlay()` asked its transform at the continuation the run
  began on. They agree wherever a wide cluster's two cells share a bit, which is
  the ordinary case -- `put()` refuses a cluster whose continuation does not fit, so
  one cannot straddle a clip edge -- and the mask is written per element over
  rectangles that _can_ part them: a `raw` whose box covers the continuation's
  column and which paints nothing there, which is exactly what `Dots` and `Pixels`
  do with a cell nothing was drawn in, leaves the cluster on screen with the lead
  marked copyable and the continuation not. Copied and not highlighted, or the
  reverse. So `overlay()` names the cluster's lead to the transform -- `restyle()`
  already carries the style to both halves from either, so nothing else had to
  move -- and the test asserts the two readers _agree_ for both spellings of a
  disagreeing mask rather than asserting either answer, because which cell is asked
  is the claim.
- **`visibility: hidden` is the mask's rule as well as paint's, and it had no test
  of its own.** It inherits, so paint skips the element rather than the subtree and
  a descendant that sets `visible` is drawn -- which the mask has to do too, or
  copying and drawing disagree about a hidden box's visible child. Both halves are
  pinned now: a hidden `raw` excludes nothing, because there is no wall of block
  characters on screen to keep out of the clipboard, and a `raw` that sets
  `visible` inside a hidden box excludes its cells however hidden the box said it
  was. A coverage gap rather than a wrong answer, and the one-line kind worth
  closing because the rule is not what anybody guesses.
- **A canvas resize the _frame_ asked for keeps the selection, and for an
  auto-width canvas that is a known limit.** `terminal.onResize` is what drops it,
  while `layoutInto()` calls `backend.resize()` -- which discards both grids --
  without going near it. For the auto-height second pass that is right: the pass
  repaints the same frame at a taller canvas, so the cells a selection named are
  where they were. The leftover is an **auto-width** canvas whose content width
  changes while a selection is held, where the coordinates then name whatever the
  reflow put there. Left alone deliberately: clearing on every canvas resize would
  drop selections that are still perfectly correct, and the frame has no way to say
  which of the two it just did. Recorded because it is the kind of thing the next
  person rediscovers as a bug.
- **`Canvas.cells` is exposed for reading, and extraction is why.** A selection is
  text read back off the frame that was painted, and `toString()` is the wrong shape
  for it: it trims and joins, where extracting a region has to ask cell by cell and
  know which half of a wide cluster it is looking at. It is the back buffer, which
  `paint()` clears and fills, so between frames it is what is on screen. Nothing
  stops a caller painting through it -- the grid is a class with public methods --
  and what that costs is a frame the next `paint()` wipes with the diff never having
  been told, which is the trap `present()` copying forward rather than swapping
  already records.
- **The two lookup tables here are null-prototype and nothing else, which is one
  half of a convention rather than both -- and a sabotage pass is what settled
  it.** `ARROWS` maps an arrow key's name to a step and `TARGETS` maps a selection
  to its `Pc`, and both had a prototype **and** an `Object.hasOwn` beside them,
  which is what Conventions asks for. Removing either failed nothing: with the
  prototype gone the `hasOwn` still refused `constructor`, and with the `hasOwn`
  gone a falsy check over a null-prototype table answered the same. That is the
  masking this file already records from the JSX source-type pinning, and the
  reason the convention does not apply whole is that its second half is about the
  **write** side -- `lookup['__proto__'] = name` going through an accessor and
  being dropped -- which a constant nobody writes to cannot have. So one
  mechanism, and removing it now fails a named test in each file. What it closes
  is worth knowing: `constructor` is a truthy function, so a key of that name was
  a step whose `x` is `undefined` and a focus of `NaN`, and a target of that name
  would have put `function Object() { ... }` inside an OSC sequence.
- **`terminal-probe.mjs --clipboard` is the whole of what only a terminal can
  settle, and this is the layer with the least left over.** Every other probe mode
  checks something a model could be wrong about; here **nothing at all** can be
  verified from inside the process, because there is no reply. A test can assert what
  `clipboardSequence()` builds; nothing in a test can say whether your terminal
  honours it, where it caps the payload, whether tmux passes it through or swallows
  it into a buffer, or whether the primary selection means anything where you are.
  Seven steps, each with its own `the claim:` line and each writing one payload for
  a human to paste: the environment that decides the rest, an ordinary copy, a
  payload full of control characters that must arrive literally with no title
  changed and no beep, three sizes to find the real cap by hand, the refusal and the
  truncation over it, the primary selection, and the read that is not implemented.
  It needs no `finally`, which is the restore-list entry above read from the other
  side.
- **The screen model learnt OSC 52 rather than being worked around.** It
  swallowed every control string, which is right for the ones that change no cell and
  wrong for the one a test has a reason to assert -- so it decodes the payload and
  records it per selection, which is what makes the model say what the _user_ would
  get rather than what the sequence looked like. It models a terminal that honours
  the write, which is the half only the probe can check.
- **The end-to-end test is the half nothing else can say, and it is the mouse
  file's.** `test/renderer/mouse.test.ts` already has a real renderer over a real
  inline canvas over the screen model with a real cursor report answered from the
  model's own cursor; a drag is one more thing to feed it. So a report naming a
  _screen_ cell translates through the learnt origin, selects the cells that were
  painted there, and the bytes reach a terminal that decodes them -- `world`, from
  `ESC [ < 0 ; 7 ; 2 M` and a drag to column 11.
- **The demo is `demos/element/07-selection.js`, and it is the answer to the
  warning the other three carry.** `04-mouse.js`, `05-drag.js` and `06-panes.js` each
  say that turning tracking on takes text selection away; this one gives it back,
  and it is the fourth demo that cannot be driven by `demos.test.ts` for the reason
  the others cannot. Driven by hand through a faked TTY that answers the cursor
  report, which is also how the two claims a reader would doubt were checked: an
  alt-drag down one pane copies `alpha\nbravo\ncharlie`, and a drag across the
  braille sparkline copies **nothing at all** -- every cell of it is unselectable, so
  the line comes out as blanks, the trailing-blank rule empties it, and the copy is
  refused as empty. Which is the `selectable` default doing exactly what it is for,
  and reads as a broken demo until you know that.

### Describing a binding

- **A description is read by a listing and by nothing in dispatch.**
  `bind(keys, handler, { description, group, priority })` and `describe(keys, {
  description, scope })` add a record to a set that `bindings()` reads; the trie,
  the function bindings and `onKey` are exactly what they were, so no existing
  binding or test moved. A binding with no description is not recorded. The
  records are frozen and the key is stored as `formatKeys()` prints it, the one
  spelling the trie and `sequence` already use.
- **`bindings()` is the focus-scoped read, and it is reactive.** It reads the
  focus signal and a revision counter, so an effect or a computed that calls it
  re-runs when the focus moves or a description is added or removed. Order is
  dispatch order: unscoped entries, then scoped ones from the focused element
  outwards, registration order within a tie (`sort` is stable). A scope the focus
  is not inside is not listed, and with nothing focused only unscoped entries are.
- **There is no scoping on `bind()` itself, and `scope` on `describe()` is
  documentation.** Only an element's `onKey` is focus-scoped today, and it is a
  function; `describe()` is the declaration of what it handles and can drift from
  it. Making a _binding_ fire only inside an element would change dispatch, and
  would need an answer for a pending sequence whose focus moves.
- **A refused description leaves nothing registered.** The handler is added to
  the trie first so the spec is parsed once, and taken back off if the
  description throws -- otherwise `bind('q', fn, { description: '' })` would throw
  and still quit the app. The disposer of a described binding removes both.
- **Measured: the `input` entry grew by 861 B (13,272 to 14,133 B for its chunk)
  as of this change.** The ceiling in `test/dist.test.ts` is 100 KiB over the whole
  graph and is untouched.
