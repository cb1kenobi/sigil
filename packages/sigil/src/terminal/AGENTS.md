# `packages/sigil/src/terminal` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Asking the terminal what it is

Everything sigil knew about its terminal, it inferred from environment
variables. `supportsColor()` reads `TERM`, `COLORTERM` and `NO_COLOR` and the
whole degradation ladder hangs off that one guess.
`scripts/terminal-probe.mjs` exists because the canvas makes claims only a real
terminal can falsify; this is the same idea at run time. `src/input/capabilities.ts`
is the vocabulary and the probe, the framing that makes a reply recognisable is
`src/components/keys.ts`'s, and the one thing that probes is `Renderer.detect()`.

- **A CLI must not pay a round trip to print one line, so detection is a method
  on a mounted renderer rather than a phase in `render()`.** That is the
  constraint that makes this different from a TUI framework's version: OpenTUI and
  Ink probe at startup because they are always an app, and sigil is a parser
  first. So `main()`, `parse()`, the help screen and `renderToString()` write no
  query ever, environment inference stays the default answer and the synchronous
  one, and probing _refines_ it rather than gating it. Measured interleaved over
  fifty pairs of spawns of the same binary built both ways, because the absolute
  numbers on a loaded machine are worthless and the delta is the claim:
  `--version` is min 67.9ms / p25 75.6 / median 90.1 before and 64.9 / 77.5 /
  89.6 after, and `--help` is 112.2 / 129.3 / 144.5 before and 108.4 / 126.5 /
  146.9 after. Identical inside the noise, which is what it has to be, since
  nothing new is on either path. Two tests hold it rather than the measurement:
  one runs a parse, a failing parse, a help screen and a `renderToString()` with
  stdout recorded and asserts that not one of the six query sequences was written,
  and `what importing the package costs` in `test/dist.test.ts` already walks the
  root entry's static import graph -- which is the half that catches somebody
  adding a convenience re-export.
- **`render()` does not build a router, so `detect()` takes one.** One thing owns
  stdin, and which backend and which input an app has are the app's decisions --
  a renderer that built a router would set raw mode and take the stream on its
  own, which is the failure the split between them exists to prevent. `createInput()`
  needs the root element, and `render()` is what produces one, so the order is
  `render()`, then `createInput({ root: view.root })`, then `view.detect(input)`.
  The alternative -- a `RenderOptions.input` with a `detect: true` beside it --
  was rejected for that circularity: it would need the router to exist before the
  tree it dispatches through.
- **Batched, in one write, with DA1 written last as a sentinel.** SIG-108 asked
  batched-or-per-capability and the answer is batched, on arithmetic rather than
  taste: a round trip is one RTT, and five in sequence over a link with a 150ms
  RTT is three quarters of a second where one write is 150ms. The objection --
  that a batch answers questions nobody asked -- is answered by the options rather
  than by the shape, since nothing is written that the caller did not ask for. The
  one thing always written is DA1, and that is what makes the deadline cheap:
  every terminal back to a real VT100 answers it, so its reply means every query
  before it has been answered or never will be. A probe therefore normally ends in
  one round trip and the timeout is only for a terminal that answers nothing at
  all. The sentinel has to be in `until` as well as in the write or it is
  decoration -- `queryMode()` shipped for one draft with only the write, so a
  terminal with no DECRQM waited out the whole deadline to learn something the
  DA1 in front of it had already said.
- **Replies are matched by shape, never by position.** A terminal that does not
  understand one query answers nothing for it, so the second reply is not the
  answer to the second question -- and reading them positionally would attribute
  every reply after the first gap to the wrong thing.
- **250ms, and the asymmetry is not `ESCAPE_TIMEOUT`'s.** Too short there types a
  stray character into somebody's answer; too short _here_ silently reports no
  capabilities, which is a colour level and a colour scheme that are wrong with
  nothing to point at -- and it is easy to be too short, since a transatlantic ssh
  round trip is around 150ms before the terminal has done anything and tmux adds a
  pass of its own. Too long costs nothing a user can see, because the first frame
  does not wait: it costs a timer held open and, while it is open, a `CSI ... R`
  read as a reply rather than as Shift-F3. So the number is set well clear of the
  failure that is invisible and trades against one that is bounded. What this
  repository has **not** measured is a real round trip, because measuring one needs
  a pty and there is no pty here to have; `terminal-probe.mjs --detect` times it
  and prints the number, and a local terminal reporting anything near 250 means
  the default is wrong.
- **`isCapabilityResponse()` is narrow, and the negative table is the feature.**
  Being wrong in one direction puts `[?1006;2$y` in somebody's password; being
  wrong in the other loses a key the user pressed. It claims only shapes no
  keyboard produces: any well-framed OSC or DCS, DECRPM on the `$` intermediate,
  device attributes on the private prefix a bare request does not carry, and a
  three-parameter window-op reply. Refused: an unfinished sequence, a mouse
  report's `<`, a focus report, a Kitty keyboard `u`, a bare `CSI c`, Alt-] and
  Alt-Shift-P, Ctrl-C above all -- thirty-one entries, each named after what it
  really is.
- **A cursor position report is claimed only while one was asked for, and that is
  the honest version of the function rather than a hole in it.** `CSI 1 ; 2 R` is
  a CPR _and_ it is Shift-F3 under xterm's `modifyFunctionKeys`, and nothing about
  the bytes tells them apart. A reply is only ever a reply to a request, so
  `parseCapabilityResponse()` reads one and `isCapabilityResponse()` refuses to
  claim it; the router takes it only while a query with `cursor: true` is
  outstanding. Which means the window in which Shift-F3 is lost is exactly the
  length of a `queryCursor()` call. `queryCursor()` is also the one probe with no
  DA1 sentinel, because a DA1 reply arriving first would end the probe before the
  position did -- the sentinel working against the one query it cannot help.
- **A reply nobody is waiting for is dropped rather than dispatched.** A late
  reply, or one the terminal sent unasked, is still not a key. Putting it in
  somebody's answer is the whole failure, and it does not become a key by being
  unexpected.
- **The decoder frames an OSC and a DCS as one read, and that was a live bug
  rather than groundwork.** Measured on the shipped decoder before any of this:
  an OSC 11 reply arrived as **twenty-three keys, of which a text prompt inserted
  twenty-one**, and XTVersion's arrived as seventeen carrying `Ghostty 1.0.1` into
  the answer. A CSI reply was already safe by accident -- it framed as one read
  named `unknown`, and a text prompt only inserts a key whose name is its own
  sequence -- so the ticket's own example of the failure is the one shape that
  never had it, and OSC and DCS, which nothing framed at all, are where it lived.
- **`ESC ]` is the OSC introducer and it is Alt-], and only the reader knows
  which.** So `DecodeOptions.strings` is what the reader says. Off, a control
  string is claimed only where its payload could not be a typed key -- a digit
  after `ESC ]`, since every OSC command is numeric, and `>` or a digit after
  `ESC P` -- which keeps both keys working and still keeps unsolicited chatter out
  of a prompt. On, which is what the router passes for as long as a query is
  outstanding, an introducer is an answer whatever follows it: that closes a read
  that split between `ESC ]` and its payload, where the default has nothing left
  to go on and reads Alt-] followed by the payload as keys. What it costs is Alt-]
  pressed inside that window. Holding `ESC ]` unconditionally was the obvious
  alternative and is wrong in a way the CSI path hides: Alt-] typed on its own
  _is_ the whole chunk, so nothing will ever follow it and holding it loses the
  key outright rather than delaying it.
- **A held reply waits on the query's deadline, not on the key one, and that was
  the hole the framing left.** Found by review rather than by a test. `ESC ]` alone
  is Alt-] to anything that has not asked a question, so the router holds it while
  a query is open -- and `ESCAPE_TIMEOUT` then flushed it fifty milliseconds later,
  after which the payload arrived as a chunk with _no introducer in front of it_
  and went into the answer a character at a time. `11;rgb:1111/2222/3333` in
  somebody's password, by the one route the framing does not close. The introducer
  itself was never the damage: it decodes as `unknown`, and a prompt inserts only a
  key whose name is its own sequence. Fifty milliseconds is the right number for a
  half-arrived _key_, because what follows an `ESC [` may be the Ctrl-C somebody is
  pressing to get out; none of that is true of a half-arrived reply, which is not a
  key and which nobody is waiting on. So a held control string with a query
  outstanding is not put on a timer at all, the query's own deadline ends the wait,
  and `settle()` arms the key timeout for whatever is left when the last query goes
  -- where it is re-read with `strings` off and the `ESC ]` becomes the Alt-] it
  always was. A held _key_ is untouched, which is what keeps that Ctrl-C at fifty
  milliseconds, and a test asserts it: `should not make a half-arrived key wait on
  a probe`. What the longer hold costs is worth stating precisely: a key typed
  _after_ a held introducer joins the held string, so it is delayed by up to the
  query's deadline rather than lost -- and reaching that at all needs a read to end
  on exactly `ESC ]` or `ESC P` while a probe is open.
- **Which needed `pendingIsString()`, because the deadline depends on what is
  held.** Answered by the same `readOne()` walk `pendingLength()` uses rather than
  by looking at the first two bytes, for the reason that function exists at all: a
  second reader with its own idea of what an introducer is, is a second reader to
  disagree with. `Read` carries a `string` flag now, set in one place.
- **A stopped router reads nothing, which was not true and cost a timer.** Also
  found by review, and pre-existing rather than new: `stop()` clears the held tail
  and the escape timer, and `consume()` then carried on through the rest of the
  chunk it was part way through -- arming a new one, and flushing a paste bracketed
  later in that same chunk. A Ctrl-C binding that calls `stop()` is the ordinary way
  to reach it, and what it left behind was a timer firing into a router with no
  stream listeners, dispatching to the bindings `stop()` does not remove. The
  question is asked at the entry _and_ in the loop, because the chunk being read is
  what stops it; both are pinned, the second by a paste, since a suite that stays
  green with a guard deleted is a suite that says the guard is decoration.
- **A capability reply inside a bracketed paste is content, deliberately.**
  `flushPaste()` dispatches without consulting `takeReply()`, so
  `PASTE_START ESC ] 11 ; rgb:... BEL PASTE_END` puts the payload in the answer.
  That is right twice over: what is between the markers is content by definition,
  and the ordinary way to meet those bytes is a user pasting text that happens to
  contain them, where inserting it is the whole job. A terminal that bracketed its
  own reply would be a terminal with a bug, and reading a reply out of a paste would
  mean a user could never paste one.
- **`pendingLength()` was widened, and it had to be.** It and `decodeKeys()` are
  one walk on purpose, so the second reader had to learn control strings too or
  the two would disagree about where the last key starts -- which is the bug that
  function exists to prevent. Both take the same options and the router passes one
  object to both; a test asserts they agree about a split reply.
- **An abort byte does not end a control string here, unlike in `strip.ts`.** That
  module reads CAN and SUB as terminators, and it is right to: a stripper only has
  to get _past_ a sequence. This has to say where the reply is, and a reply
  truncated by an abort byte is better read as one that never finished arriving
  than as one that ended early.
- **A refined colour level goes up, never down, and never off a floor of zero.**
  Zero is what `NO_COLOR` and a pipe produce, so raising it would override a
  choice the user or the destination already made -- the same rule the degrader
  keeps for a declared palette colour. Lowering is refused because
  `COLORTERM=truecolor` is a thing people export on purpose, often precisely
  because their terminal sits behind a multiplexer that under-reports: a reply
  saying `tmux` would otherwise undo it.
- **It is evidence rather than proof, and the proof was rejected with a reason.**
  The truthful probe is to set `SGR 38;2;1;2;3` and read it back with DECRQSS --
  a terminal that quantizes answers `38;5;N` -- and it means writing a colour to
  the screen mid-frame and depending on DECRQSS, which fewer terminals implement
  than XTVersion. A name is weaker evidence that costs nothing to be wrong about,
  because the table only ever raises: a name that is not in it changes nothing, so
  the failure mode of the table going stale is the status quo. `xterm` is the
  instructive omission -- it answers XTVersion from patch 331, which is exactly the
  temptation, and renders direct colour only with the `-direct` terminfo that
  `supportsColor()` already reads, so including it would raise the level for every
  ordinary `xterm-256color` session on the strength of a reply about something
  else. `konsole` and `wayst` are out for the weaker version: whether they answer
  at all is not something measured here.
- **A refinement lives above `opts.colorLevel`, and that took a second look.** A
  caller that names a level reads like a caller who has decided, and `mountLive()`
  is why it is not: every built-in passes `opts.colorLevel ?? ansi.level`, which is
  the environment's own guess wearing the caller's clothes -- so treating a named
  level as final would mean no spinner, prompt or table could ever be refined.
  What needs protecting is a level of _zero_, and `refineColorLevel()` protects
  that by refusing to raise off the floor rather than by any precedence here.
- **A late reply is published as a media-context change, which is what a resize
  already is.** One `publishMedia()` does the three things a resize does --
  `readMedia()`, a full re-match, a frame -- rather than two copies of them, for
  the reason this file gives everywhere else: the day they part is the day a reply
  restyles and a resize does not. The refinement is kept on the renderer rather
  than only in `cascade.media`, because `readMedia()` rebuilds the context from
  scratch and a level the terminal told us about would otherwise last exactly
  until the window changed by a column. Both halves are sabotage-checked: dropping
  the `publishMedia()` call fails two tests, and dropping the kept refinement
  fails the resize one.
- **`Restyler.touchSize()` is `touchMedia()` now.** The body never changed. A
  capability reply is a second thing that moves the media context, so a doc saying
  "the media context changed" under a method called `touchSize` would be a correct
  comment turned false by what grew around it -- the one failure nothing in a
  build catches, and a thing this file has an entry about from the other side.
- **DECRPM does not make `restore()` put back what was actually set, and that is
  unreachable rather than deferred.** The ticket wanted the stronger version of
  "put back what you attached" and it cannot exist: `restore()` runs from an
  `exit` handler and from a signal handler, where there is no turn of the event
  loop left to await a reply in. A restore can only ever put back what it knows it
  set. What DECRPM is genuinely for is a _read_ -- `queryMode()` says whether a
  mode took, and distinguishes "off" from "never heard of it", which is the
  distinction an app that turned mouse tracking on actually needs.
- **A query is written before anything is armed, which reads backwards and is the
  point.** `terminal.write()` swallows the far end going away and returns `false`,
  and it _throws_ for a fault that is not that -- so a write placed after the
  deadline was armed would reject the promise with a timer still running and the
  decoder still reading an `ESC ]` as an answer. Asking first means the one thing a
  failed write can cost is the answer. There is no synchronous reply to race for:
  a terminal answers on a later turn of the loop, and a harness that feeds bytes
  does it after the call returns. A write that reports the far end gone resolves
  with nothing rather than waiting out the deadline for an answer that cannot come.
- **An `until()` that throws ends its own probe, not the process.** The predicate
  runs inside the stream's `data` listener, so letting it escape is an uncaught
  exception -- and it would leave the query outstanding with its deadline armed and
  the decoder still in "an introducer is an answer" mode. The caller gets what had
  arrived, which is what a deadline would have given it anyway. Rejecting instead
  is refused for the reason `query()` never rejects over a quiet terminal.
- **Eight-bit C1 introducers are out of scope, and that is a boundary rather than
  a hole.** A terminal told to use them sends `0x9b` for CSI, `0x9d` for OSC and
  `0x90` for DCS, none of which this decoder reads -- and it never has, so an arrow
  key in that mode has always been typed in as a character. Worth knowing exactly
  how it fails, because it is not the obvious way: the router sets
  `setEncoding('utf8')`, and a lone `0x9b` is not valid UTF-8, so node hands over
  U+FFFD and then the parameters as characters -- and U+FFFD is not `\p{Cc}`, so a
  prompt inserts the replacement character along with `?64;1;2c`. Nothing here asks for
  it: a terminal only sends C1 controls when the application has enabled S8C1T, and
  sigil never does. Reading them means teaching every key path a second introducer
  for a mode nothing turns on, and the honest version of that is a sentence here
  rather than a half-done one in the decoder. `src/ansi/strip.ts` reads `0x9b`
  because a stripper is handed text from anywhere, which is a different job.
- **Every probe puts its timer back, on all three paths.** A reply, the deadline,
  and the router stopping all settle a query, `settle()` is idempotent because two
  of those can race, and the deadline is unref'd so a probe nobody is blocking on
  cannot be what keeps a process alive. `stop()` and the stream ending both settle
  everything outstanding, because a query left open is a promise nobody will ever
  settle and the caller of a probe is usually a frame. A test asserts
  `vi.getTimerCount()` is zero after a reply and after a stop.
- **`ESCAPE_TIMEOUT` still owns a half-arrived CSI, and what that costs is the
  asymmetry already written down rather than a new one.** A reply that is a CSI --
  DA1, DECRPM, a window-op, CPR -- split before its final byte with more than fifty
  milliseconds between the halves is flushed as an unfinished sequence, and the
  suffix then arrives as ordinary characters: `\x1b[?64;1;2` held and flushed, then
  `c` typed into somebody's answer. Three more shapes of the same thing: a
  printable byte in `@`-`~` _completes_ a partial CSI, so `ESC [` followed by a
  typed `a` ends the sequence and leaves `?64;1;2c` to be typed; a Ctrl-G in the
  middle of a half-arrived OSC is a BEL and ends it early, leaving the rest; and the
  same holds for Alt-`\` as an ST. None of these is new -- every one of them is
  reachable on `main` with an arrow key in place of a reply, and it is exactly what
  "too short types a stray character into somebody's answer" already says.

  Holding **everything** while a probe is open closes all of them and is refused,
  because the thing `ESCAPE_TIMEOUT` protects is not a key that is followed by more
  bytes. Any byte that arrives re-decodes the held tail immediately, so `ESC [` then
  Ctrl-C in a later chunk already delivers the Ctrl-C at once; what the timeout is
  for is a tail that _nothing will ever follow_, which is a lone Escape. Widening
  the hold to 250ms therefore does not delay Ctrl-C -- it makes Escape-then-a-letter
  read as Alt-letter for a quarter of a second, and pressing Escape and then a
  command key inside 250ms is ordinary human typing. That is a usability regression
  in exchange for a byte sequence that needs a read to split mid-CSI _and_ a fifty
  millisecond stall. A control string is different and is held, because `ESC ]`
  followed by another key is not something anybody types.

- **A reply split at its introducer _after_ the probe settled is the one the
  framing cannot reach.** With nothing outstanding, `strings` is off and `ESC ]`
  alone is Alt-], so a payload arriving in the next chunk is typed. It needs a read
  that ends on exactly the two introducer bytes and a reply arriving after the DA1
  sentinel -- which for a terminal that answers in the order it was asked cannot
  happen, since DA1 is written last. Keeping `strings` on for a grace period after
  the last query was the obvious answer and is refused: "the probe is over" has to
  mean something, and an open-ended grace period is Alt-] lost permanently. A
  _whole_ reply arriving after the probe is still dropped rather than typed, because
  `takeReply()` claims one whether or not anybody asked.
- **A satisfied query is settled at the end of the chunk, not in the middle of
  it.** The sentinel is written last so its reply normally arrives last -- but a
  multiplexer that answers XTVersion for itself, or any terminal that reorders, can
  put the DA1 _in front of_ another reply in the same chunk. A probe that settled on
  the spot had stopped collecting by the time the next key was routed, and
  `takeReply()` drops a reply either way, so the version was thrown away rather
  than read. `satisfied` holds them and `settleSatisfied()` runs after the decode
  loop, which costs nothing and is what "matched by shape rather than by position"
  was supposed to mean in the first place. It also removed a `clearTimeout()`:
  settling inside the routing armed a key timer that `armExpiry()` then assigned
  over, orphaning it, and with the settle deferred nothing can arm one before
  `armExpiry()` runs.
- **Except a handler that calls `feed()` can, which made that last clause false
  until SIG-112 measured it.** `keys()` is re-entered by a `feed()` from inside
  the routing -- an ordinary `bind()` handler is enough and no sequence is
  involved, so this was reachable from the day `feed()` existed -- and the inner
  call leaves **its own** remainder in `held` while the outer call goes on to arm
  from its own `joined`. Measured: a binding that feeds a trailing `ESC` mid-chunk
  left **two** timers armed where one is correct. The wasted timer is the lesser
  half of it, since the second `expire()` finds `held` empty and routes nothing.
  The half that matters is a held control **string**: where the inner remainder is
  one and the outer chunk's was not, `pendingIsString(joined)` is false, so the
  second timer is the key deadline over a held reply -- which is the one thing
  `armExpiry()` exists to refuse, and whose cost is
  `11;rgb:1111/2222/3333` in somebody's answer. So `keys()` keeps the tail it
  computed and arms only while `held` is still that tail: where the two differ the
  inner call has already armed for what is really held, or correctly declined to.
  A `clearTimeout()` in `armExpiry()` would close the orphan and not the string,
  which is why the guard is where the two values can be compared.
- **A key that stops the router stops the chunk it was in.** `keys()` asks
  `stopped` between decoded keys as well as at the entry to `consume()`, because
  `feed('\x03hello')` with a Ctrl-C binding that calls `stop()` went on routing
  `hello` to the bindings `stop()` does not remove. Pre-existing, found by review,
  and the third place this question has to be asked -- the entry, the paste loop, and
  the keys.
- **Alt held over a reply carries the control-string flag with it.** `readEscape()`
  wraps the inner read and rebuilt the result without `string`, so `ESC` followed by
  a reply still arriving reported itself as a half-arrived _key_ -- and a caller
  reading that picks the key deadline for something that is not a key. One field,
  and the reason it matters is that `pendingIsString()` is what chooses the deadline.
- **A terminal name is matched whole, not by prefix.** `name` is already the first
  token with any `(version)` taken off, so a prefix test buys nothing and reads a
  terminal called `footer` as `foot`. Loose in the direction that costs, on a table
  whose only job is to raise a level.
- **A colour level is refined off _any_ version reply, and `name` is still the
  first.** tmux answers XTVersion itself and can pass the outer terminal's answer
  through as well, so taking the first would let a `tmux 3.4` hide the
  `ghostty 1.1.0` behind it. Since a refinement only ever raises, the permissive
  reading is the safe one; what a caller reads back as `name` stays the first,
  because that is what "what is this terminal" means.
- **The publish asks again against the level that is on screen, not the one the
  probe captured.** `refineColorLevel()` is asked before the await and only ever
  sees the floor as it was then, so a level that was 2 when the query went out can be
  0 by the time the reply lands -- a resize re-reads `NO_COLOR` -- and a publish that
  only compared the two would put colour back on a screen that had just been told not
  to have any. `level > 0` is the guard and has a test; `> level` rather than `!==`
  is the raise-only invariant said where it is enforced, and today it cannot differ,
  since the only level a reply produces is 3.
- **`queryMode()` answers `undefined` for a reply it cannot read as well as for
  silence, deliberately.** A DECRPM with no second parameter, or a `Ps` outside
  DEC's five states, is not an answer a caller can act on -- and neither is silence,
  so they are not told apart. What _is_ told apart is `'unrecognised'`, which is the
  reply that says the mode does not exist, and is the whole reason to ask.
- **`demos/terminal/01-capabilities.js` prints both columns, and the third
  section is the whole reason it exists.** A dump of what the terminal answered
  is worth little on its own; what is worth having is it beside what the
  environment guessed, with a line naming each place they part. `COLORTERM=truecolor`
  on a terminal where `NO_COLOR` is also set resolves to level 0, and one column
  cannot show that -- the demo says `NO_COLOR=1 outranks it`, naming the variable
  rather than listing the three candidates, because a dump that hands the reader
  three things to check has not answered. It also reads the capabilities back
  through the published `exports` map, which is what makes it prove the API is
  usable from outside the package; `terminal-probe.mjs` imports `dist/` directly
  and is not replaced by it.
- **A demo that probes needs a terminal on _both_ sides, and asking about one is
  the bug.** `createInput()` refuses to exist unless `stdin` **and** the
  terminal's output are TTYs, because the reply arrives on one and the query is
  written to the other -- so a guard that asked only about `process.stdin.isTTY`
  let `node demos/terminal/01-capabilities.js | cat` through _from a terminal_,
  where stdin is a TTY and stdout is a pipe. It threw an uncaught `InputError`,
  and what reached the screen was a stack over a minified module over the dump.
  `demos.test.ts` could not have caught it: it spawns with `stdio[0]` as
  `'ignore'`, so every demo it runs takes the no-terminal branch, and the one
  command the README documents is the one nothing tests. Found by review and then
  reproduced over a real pty with stdout piped, which is the only way to see it.
- **And no `process.exit(0)` on that branch.** `console.log` to a pipe is
  asynchronous, so exiting forces the process down with the write still queued.
  Falling off the end of the module lets node drain it -- and the demos test would
  have passed either way, because it asserts an exit code and an empty stderr
  rather than that anything was printed. `03-focus.js` has the same shape and its
  output is small enough not to have been bitten yet.
- **`terminal-probe.mjs` grew a `--detect` mode, and then a `--mouse` one, and
  they are the only things that could.** SIG-108 asked and the answer is yes. Everything else in that file paints
  a frame and asks a human to read it; this prints what the terminal answered, byte
  for byte, with the round trip timed. The claims it exists for are the ones no test
  can make: whether a given terminal sends XTVersion at all, whether it sends it
  before the DA1 written after it, whether DECRQM is implemented, what a real round
  trip costs, and whether `mode 9999` comes back `unrecognised` rather than silent
  -- which is DECRPM's whole value in one line.
