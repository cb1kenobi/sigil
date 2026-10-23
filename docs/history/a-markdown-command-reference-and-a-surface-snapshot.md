# A markdown command reference, and a surface snapshot — how it was arrived at

The review rounds, sabotage passes and by-hand audit passes behind
[packages/cli/AGENTS.md](../../packages/cli/AGENTS.md). The decisions themselves are
there; this is the record of what each round found, which is kept
because a finding nobody wrote down is one somebody re-discovers.

#### What the sabotage pass found, and the litter it left twice

**One hundred and eighteen mutations across six passes, every one caught and
three declared equivalent** -- 47 over the feature, then 26, 17, 7 and 16 over
the guards each review round's own fixes produced, which is the gap every round
leaves, and 5 over the guards **CI's** own two findings produced, which is that
gap one platform along. The first pass is below; each round's is under its own
heading.

**Forty-seven mutations, forty-seven caught, nothing declared** -- counted
against the shipped tree in one run, with a green control first and the four
verdict guards this repository has learned to need. One pattern went **stale**
when the formatter reflowed the line it quoted, and was reported as
`PATTERN MISSED` rather than as a guard that is not load bearing, which is the
seventh time that guard has earned its keep.

Six survived the first pass and every one was a test that could not reach the
branch it was named for. Three were in the walk and the printers: the **short**
spelling filter, whose input is two options declaring `-c` rather than a negated
flag, since the implied positive spelling is always a **long** one; the
snapshot's **command sort**, which coincides with the walk's own pre-order for
every ordinary tree -- space sorts before every character a route name can hold,
measured -- so the input that makes it matter is a _scrambled surface_ rather
than an app, which is available because the surface is plain data; and
`read()`'s **ENOENT-only** rule, whose input is a directory where a file was
named, which is `isMissing()`'s own recorded defect one package along.

The other three are the finding worth keeping, and they are about the **harness**
rather than the code. They were reported as caught on the first pass and
survived on the second, because the first pass's own mutations had written files
into the repository: a `--check writes nothing` mutation left a
`packages/cli/does-not-exist/` behind and a relative-destination mutation left a
`packages/cli/docs/`, and both made a later test pass for the wrong reason. The
control failing is how the first was found and a full-suite run is how the
second was. So three guards -- the `--check` with no destination, the stale
message, and the app-relative destination -- had no test at all and now have
one, and both tests write into a temp directory of their own: a destination
inside the repository is one a sabotage can create.

Which is the rule this file already states about a sabotage verdict said one
level up. A verdict is a statement about the tests, and a harness that mutates a
checkout can change what the tests are statements about. `git status` after a
pass, and a control before every one.

#### What review round 1 found, and the two it was right about by the wrong reason

Pointed at the diff with the ticket's constraints and **not** at the rationale,
so that it could not simply confirm the argument above. **Eleven findings, every
one confirmed against the code before it was believed** -- two of them a wrong
file on disk, five more a wrong value or a message that sends a reader nowhere,
and the rest prose or a test that cannot fail for the reason its name gives.
Plus five weak tests and a coverage list, which is the next round's worklist.

Every one is a shape a pass built out of deletions is blind to by construction:
not one is a dead guard, and nine of the eleven are a guard that was never
written.

- **A command named `../evil` or `a/b` wrote a page outside the destination,
  while the summary said it had written into it.** The severe one. A page's file
  is the path joined flat, so a segment holding a separator -- or spelled `..` --
  escapes: measured, `'../evil'` put `evil.md` one directory **above** `--out`
  with stderr reporting `5 files into ...out2`, and `a/b` wrote into a
  subdirectory the website's own reader never looks in. Neither could be seen
  again either, because the stale sweep reads the destination's top level, so
  `--check` agreed with a file that was not there. Refused in `listed()`, where
  the `-` collision refusal already is, because both are the same question: can
  this path be a file name.

- **A `--check` could pass with a page missing, on the filesystem this is about.**
  The clash key was `file` and the default filesystem on macOS and Windows is
  case-insensitive, so `DB` and `db` are two keys and one file there: the second
  write won and `--check` then compared that one file twice. Folded
  unconditionally rather than per platform, because a committed reference is read
  on every platform -- and the **lookup** fold needed an input the obvious
  fixture cannot reach: the walk is sorted by code unit, so for `DB`/`db` the
  uppercase always arrives first and a folded `set` alone catches it. `Ab`/`aB`
  is the pair where neither is uniformly upper, and it is in the test.

- **The snapshot could not see a command becoming the `default` one, nor a
  namespace gaining a `run`.** Both are a thing argv reaches -- a `default`
  command is dispatched when argv named none, so moving the mark changes what a
  bare invocation does, and a namespace gaining a handler is a path that did
  nothing and now does something -- and neither was recorded. `SurfaceCommand`
  carries `default` and `runnable` now, the snapshot projects both, and the
  README's table has a row for each.

- **The usage line omitted `[options]` for a command that only inherits them,
  four lines above prose saying those options resolve there.** Two sentences on
  one page disagreeing, which is why the fact is passed into `usage()` rather
  than re-derived from the command.

- **`--check`'s diagnostics told the reader to run a command that would not write
  the file being checked.** The refresh was built from the _format_ alone, so a
  destination that came from `--out` was named by a `sigil reference` that writes
  somewhere else -- or, with no `sigil.json` key, refuses outright. It is built
  from the invocation now, with the `--out` quoted where a shell would split it.
  Which is the one shape of wrong message this repository keeps finding, in the
  function whose whole job is to say the thing to do.

- **Four strings a declaration owns broke markdown structure.** A program name
  or a command name holding a backtick ended its own code span, after which the
  rest of the heading was parsed as markdown; an example whose text held a fence
  closed the block it was in; and the front matter had its `|` backslash-escaped,
  so a consumer read a different string than the app declared. `code()` picks a
  delimiter longer than the longest run in the content and pads where it starts
  or ends with one, which is CommonMark's own rule; `fenced()` does the same for
  a verbatim block; and the front matter and the page prose go through
  `oneLine()`, where a bar is an ordinary character.

- **And the bar escaping was in the wrong place, which the fix for that one
  exposed.** It was in `cell()` and in `code()`, so a code span built for a
  _heading_ escaped a bar that is an ordinary character there and rendered a
  visible backslash. It is `table()`'s now -- the one function that knows a cell
  sits between columns -- which is one reader of that rule where there were two.
  The header is **not** escaped, and that is the rule about a guard that cannot
  change an answer: every header this module passes is one of its own literals.

- **Two sorts read the machine's locale.** `localeCompare` for the commands and
  for the options, so the same surface printed different bytes on a German laptop
  and on CI -- which for a committed artifact is a check that fails over who ran
  the generator. Both are by code unit now, and so is the walk in
  `commandSurface()`; `ordered()` was already right, because `Array.sort()` with
  no comparator is specified to compare by UTF-16 code unit. `Zed` before `ant`
  and `--B` before `--a` are the discriminators, each asserted beside a
  `localeCompare` call that says so out loud, so neither test can quietly become
  one about two names the two orders agree about.

- **Reordering a `choices` list -- and only that -- moved the snapshot.** It was
  the one list here that was not sorted, which made reordering it the only
  cosmetic edit that could fail the check. A reordered list accepts exactly the
  same set of values, so what moved was the hint on the screen rather than what
  argv takes.

- **`referenceDocs()` threw where its own caller's comment said it would 404.**
  `/reference`'s `notFound()` says "a reference nobody generated is a 404 rather
  than a crash", and `readdirSync` of a missing directory is `ENOENT` -- so an
  emptied tree was exactly the crash that comment denies. Measured both ways
  against a real `next build`: with the guard the build succeeds and `/reference`
  prerenders as a 404, and with it removed the build fails with
  `Failed to collect page data for /reference/[slug]`. `ENOENT` alone, which is
  the rule the toolchain's own reader keeps.

- **And the README claimed `required` records whether an option has a
  `default`.** It does not: `required` says whether the option has to appear, and
  an optional option may have a default or not. What the snapshot gives up is
  stated now rather than implied -- nothing in it records whether a default
  exists, so adding or removing one is invisible to the check.

##### Two of its findings were right about the symptom and wrong about the cause

Which is worth more than the findings, because both corrections are measurements
and one of them deleted a guard.

- **A hidden `a b` really does make a visible `a`->`b` page vanish, and not for
  the reason given.** The round read it as a path-key ambiguity -- `['a b']` and
  `['a', 'b']` join to one string -- and a path segment **cannot hold a space**:
  `initCommand()`'s label rule reads whitespace as the separator between a name
  and its aliases, so a `commands` key of `'go x'` is a command named `go`
  aliased `x`, and a routed file called `a b.js` is the same. Measured on both.
  What actually happens is a **registry** collision: `a b.js` becomes a command
  named `a`, which collides with the `a/` directory beside it, and the hidden one
  wins or loses by registration order. That is the parser's, it predates this
  feature, and it is recorded rather than worked around here.

  So `key()` stays and its comment says what is true: NUL rather than a space is
  a **statement rather than a guard**, written that way so the key's correctness
  does not rest on the label rule holding. The sabotage of it is declared
  equivalent rather than surviving, and `should read a space in a declared name
  as the separator it is` pins the premise -- which is the premise two other
  decisions here rest on.

- **A link destination does need angle brackets, and not for a space.** Measured,
  `(`, `)`, `<`, `>`, `|` and a backtick all survive into a command name and a
  space does not -- so `go(x` produced `](go(x.md)`, whose unbalanced paren ends
  the link one character early, which is the real reachable case. And the first
  fix for it **stripped** `<` and `>` inside the brackets, so `go<x.md` came out
  as a link to `gox.md`: a page that is not there, which is a wrong value where a
  broken link is merely broken. They are percent-encoded now.

##### The five weak tests, and the helper that made one of them weaker

Each got the input that makes the guard it names load bearing, reasoned backwards
from "what would make this matter" rather than forwards from "no test failed".

- **The table test counted columns and not rows**, so a row _torn in half by a
  newline_ passed it: the first line still has the right column count and the
  continuation line is filtered out for not starting with a bar. It asserts both
  now -- and writing the count half found `tableUnder()` itself over-broad: it
  took every bar-leading line to the end of the file, so a count over
  `## Arguments` picked up the `## Options` rows as well and a column assertion
  read two tables as one. It takes the contiguous run.
- **The option sort asserted one spelling per option**, so a declaration's
  internal order was unpinned -- which is how `choices` came to be the one list
  that was not sorted. It asserts `long`, `short`, `env` and `choices` of one
  option now.
- **The stability test called `commandSurface()` twice in one process**, which
  cannot speak to the cross-machine stability the snapshot exists for. The two
  locale discriminators above are what do.
- **The differential compared two sorted path sets**, so a command both walks
  dropped satisfied it, and sorting destroyed the one thing the surface's own
  order is: it asserts what the set _is_ and the pre-order as well.
- **The framework-absence test substring-matched four quoted strings**, which a
  snapshot that had lost every command it ever had also satisfies. It parses the
  JSON, asks the token and spelling sets, and has a presence half.

##### What the pass over round 1's own fixes found

Twenty-six mutations over the guards those fixes produced, **twenty-six caught**,
nought survived and the harness missed nothing -- after ten survivors and four
stale patterns on the first run, which is the gap every round leaves: code
written in answer to a review is code no review and no pass has seen.

Of the ten, **seven were a guard whose fixture could not reach the branch** and
each got the input named above. **Two were not guards at all**: the NUL path key
is equivalent to the obvious spelling for every reachable input, and the header
escape was **deleted**.

The third was recorded as equivalent and is not, which round 2 corrected: the
segment-wise path comparison was argued to agree with a joined one for every
name, and that is true of the _order two paths come out in_ and false of what the
sort does with a **tie**. `['a', 'b']` and `['a b']` join to one string, so a
joined comparator leaves them in whichever order the input had -- and the
assertion was on the joined form, which cannot tell the two apart from either
input. Asserted as arrays, the joined comparator fails. Which is this file's own
lesson about a sabotage survivor arriving one level in: the mutation survived
because the test could not see it, and the forward reading was that the code did
not matter.

Two things about the harness, both of which this file has had to record before.
Four patterns went **stale** when `oxfmt` reflowed the lines they quoted, and
were reported as `PATTERN MISSED` rather than as passes. And three sigil-source
mutations **survived every cli test**, because `@ttylabs/cli` imports
`@ttylabs/sigil` through the published `exports` map, which points at `dist/` --
so a mutation in that package's source is invisible to a test in this one unless
something rebuilds. The answer is a test in the _sigil_ suite for each guard the
sigil source holds, which is where those three now are; the alternative is a
rebuild per mutation, which is the stale-`dist` trap paid for twenty-six times
over.

#### What review round 2 found, pointed at round 1's fixes and round 1's skipped list

Code written in answer to a review is code no review has seen, and that gap grows
with every round -- so this one was given two things and nothing else: the regions
round 1's own fixes changed, and the eleven items round 1 listed as not examined.
**Sixteen findings, every one confirmed before it was believed**, two of them
severe. Six were in round 1's fixes; the rest came from the files nobody had
opened, which is the distribution this file keeps recording.

- **A case-only rename made `--check` fail for ever, and the message told the
  reader to delete the page.** The severe one, and it is round 1's own fix half
  applied: `listed()` folds the case when it refuses two pages that want one
  file, and `stale()` compared names **exactly** -- two readers of "the same
  file". Measured on this Mac: renaming a command `DB` to `db` writes the new
  bytes into the entry still called `DB.md`, after which every `--check` reports
  that entry stale, and the diagnostic for a stale page says to delete it by
  hand. Deleting it deletes the only copy.

  The fix is **not** a second fold, which would be wrong on Linux -- there the two
  really are two files and the old one really is stale. What the sweep wants to
  know is whether a directory entry _is_ a file this run wrote, and a name cannot
  answer that: `dev:ino` can, and answers correctly on both kinds of volume.
  Measured: `statSync('db.md')` returns `DB.md`'s inode here. One mechanism where
  a name comparison would have to be the fold in one place and exact in the
  other.

- **The refusal printed the control character it exists to keep out of a
  page.** The other severe one, and the shape is this repository's own rule
  arriving through the one path that is supposed to be the safe one:
  `commandSurface({ name: '\u001b]8;;x\u0007' })` threw an `Error` whose message
  holds the raw bytes, and `errorHandler()` writes a message to stderr -- so the
  sequence ran on the terminal of whoever built the app. Measured. The message
  names what is wrong with the name now and does not show it.

  And the comment above it claimed this is "the same refusal `completionSpec()`
  makes" and that the two "answer the same". They do not, measured both ways:
  that one cleans the name with `oneLine()` first, so a control character is
  _stripped_ there and the name is **accepted**, and it refuses a leading dash,
  which this accepts. Neither transfers -- a reference prints the name into a code
  span, a fence and a JSON string, where a dash is ordinary, and it must refuse
  what completion merely cleans, because what reaches a page is the name rather
  than a cleaned copy. Two questions, two checks, said out loud where the previous
  sentence claimed the opposite.

- **A grandparent's options were inherited and the page said they were not.**
  Round 1 fixed the usage line for options inherited from the **root**, and
  `findOption()` walks the whole context chain -- measured through a real
  `main()`, `mycli db migrate --conn x` lands on `argv.conn` where `--conn` is
  `db`'s. So a nested page said `mycli db migrate` on its usage line over an
  option the parse accepts, and nothing on it pointed at `db`. The page now names
  **each** ancestor that declares one, linked, because a reader looking for
  `--conn` has to know which page to open -- and AGENTS.md already said "each page
  that has an ancestor with options", so the prose was written for the general
  case and the code was not.

- **Reordering an argument's `choices` still moved the snapshot.** Round 1 sorted
  an option's and left an argument's in declaration order, so that was the one
  cosmetic edit left that could fail the check -- and
  `should never sort the arguments` pins the order of the arguments themselves
  rather than the choices inside one, so nothing could see it.

- **The refresh command omitted `[dir]` and `--entry`, and under-quoted the
  path.** Round 1's own fix, two thirds done: pasting its command in this
  repository writes **this** toolchain's reference into the app's docs directory,
  and without `--entry` the command it prints regenerates the conventional entry
  and puts back the page it has just reported as stale. And the quoting class was
  an enumeration of what a shell splits on, which left `;`, `&`, `|`, `(`, `)`
  and `<` out -- so a destination called `docs/foo;rm` printed a command whose
  second half is a second command. It is built from the whole invocation now, and
  what is matched is the set a shell treats as **ordinary**, which is small and
  known.

- **A description was parsed as markdown.** `desc: '# of files to keep'`
  rendered as an `<h1>`, measured through `react-markdown` and `remark-gfm`, and
  one beginning `- `, `1. `, `>` or `---` is a list, a quote or a rule. A `desc`
  is spliced in as its own paragraph, so whatever it starts with is at the start
  of a line after a blank one -- which is where every block opener in CommonMark
  lives -- and "every string a declaration owns is escaped on the way out" is this
  module's own claim. `paragraph()` escapes the opener, with the **punctuation**
  escaped for an ordered marker rather than the digit, since `\1` is not an
  escape.

- **An indented fence inside an example still closed the block.** Round 1 sized
  the fence from runs at column 0 and CommonMark lets a closing fence be indented
  up to three spaces, so `see\n   ```\ndone` closed the block at the indented run
  and `done` came out as a paragraph of the page.

- **`#` and `?` in a command name were each a different wrong link.**
  `](go#x.md)` is a link to `go` with a fragment of `x.md` and `](go?x.md)` one
  with a query -- a _wrong_ answer rather than a broken one, where round 1's
  angle-bracketing fixed only the unbalanced paren. The destination is a URL, so
  it is encoded as one: `encodeURIComponent()` makes the href resolve to the file,
  and what it leaves is a paren, which is exactly what the angle brackets are
  still for.

- **Every link on the website 404'd, and below 640px they were the only
  navigation.** The generator links to a **file** -- `add.md` -- because that is
  what a directory of pages is, and a route there is `/reference/add`: left alone,
  `add.md` resolved to `/reference/add.md`, whose slug is `add.md`, which
  `referenceDoc()` does not find. Measured in the built HTML. And the nav was
  `hidden` until the `sm` breakpoint, so on a phone the subcommand table was the
  only way off the index and every link in it was one of those. A `routed()`
  mapping in the one place that renders a link, the nav on every viewport, and
  `aria-current` on the page that is open.

- **`display: block` on the table took it out of the accessibility tree.** Every
  argument list and option list is a GFM table, which is why `remark-gfm` is
  there, and `display: block` on the `<table>` itself stops its rows and column
  headers being announced as a table at all. The overflow is a wrapper's now.

- **`default` and `runnable` were recorded in the snapshot and printed
  nowhere**, which is a field the reference parses and does nothing with. Each is
  a thing a reader of the page needs: `mycli <entry>` runs the default command, so
  the page describing that command is the page that has to say so, and a namespace
  lists its children and does nothing of its own -- otherwise indistinguishable
  from a command whose usage line happens to take no arguments. Both are one line
  beside the usage block, because that is what each is about.

- **The segment-wise sort test could not see the swap it names**, which is the
  entry above: asserted as joined strings it passed for a joined comparator, and
  asserted as arrays it fails. So the comparison is a real guard with a test
  rather than the declared equivalence this file had recorded.

- **The README said one `--check` catches both artifacts.** One invocation checks
  one destination -- `--json` is what says which -- so with both keys set
  `sigil reference --check` compares the markdown and never opens
  `command-surface.json`. A CI step written from that line cannot see a snapshot
  change. It names the pair now, which is what `package.json`'s own script
  already was.

- **And three stale sentences**: `code()`'s `@returns` still said it escapes the
  bars, which is the behaviour from before round 1 moved that into `table()` --
  aligning the function with it puts a visible backslash back in a heading; the
  `reference.mjs` byte figure was the pre-fix bundle; and a test comment named a
  `nested/deep.ts` where the fixture is `.js`, which is the extension `top.js`'s
  own comment explains and beside which a `.ts` is the two-routes-one-name error.

##### What it refuted, and the one edge nobody here can settle

Twelve suspicions disproved, each with the probe: a trailing backslash in a
description does not break a row, because a cell is never flush against the
delimiter; `\|` inside a link destination renders as `go%7Cx.md`, which is the
file; the built toolchain's `reference` and the source-run one produce identical
bytes, markdown and JSON alike, and `dist/sigil.mjs` bakes `reference` beside the
other four with `@ttylabs/sigil/reference` externalized; `--entry` pointing at a
directory fails closed through `isFile`; an app with only a `sigil.jsonc` is read,
and both files at once is refused naming both; neither config package reads
`commandSurface`; and the lockfile keeps `react-markdown` and `remark-gfm` in the
website alone.

What it could not settle is **a page whose file name is a Windows reserved device
name** -- `con.md`, `nul.md`, `aux.md`, which a routed `con.js` asks for. On
Windows those names are devices whatever the extension, so writing one writes to
the console rather than to a file. It is left alone deliberately: it is a claim
about a platform nobody here can test, and a refusal invented on an unverified
claim is the thing this repository refuses -- which is the same call the tmux
passthrough entry records. Recorded so that whoever meets it finds the mechanism
named rather than reported.

##### What the pass over round 2's own fixes found

Seventeen mutations over the guards those fixes produced, **seventeen caught**,
nothing survived and the harness missed nothing -- after one survivor, which was
the quoting class and was the reviewer's own observation read one step further:
the test used `foo;rm -rf`, and the old pattern catches that **because of the
space**. `foo;rm` is the input that separates them, and `;` is the character that
turns a printed command into two.

#### What review round 3 found, pointed at round 2's fixes and round 2's skipped list

**Nine findings, every one confirmed**, and not one of them severe -- which after
two rounds that each produced two severe is the useful shape of a third. Five
were in round 2's own fixes, which is the third round running to find something
in its predecessor's output, and the rest came from the files nobody had opened.

- **A description that opens an HTML block swallowed the rest of the page**, and
  it is the character the comment left out while calling the set "the whole of
  what opens a block at the start of a line". CommonMark's type 1 and type 2
  blocks -- `<pre`, `<script`, `<style`, `<textarea`, `<!--` -- do **not** end at
  a blank line, and a `desc` is written as its own paragraph: measured,
  `desc: '<pre>keep this'` made `## Usage` literal text and put the usage fence
  and every example inside one raw HTML run. `<div>` is type 6 and stops at the
  blank line, which is why the obvious probe looks fine. A backslash-escaped `<`
  opens nothing, and the claim about the set is gone with the fix.

- **The parent's page said the program does nothing, on the page for the
  invocation that dispatches the default child.** Round 2 put the sentence on the
  **child's** page and left the parent's `else if (!cmd.runnable)` branch saying
  "Lists the commands under it and takes no action of its own" -- measured over a
  `default: true` `build`, where `main({ argv: ['out.js'] })` runs it. A page
  contradicting itself about the one thing it is for, and the test for that
  sentence never read `index.md`, so it could not fail. The parent names which
  child runs now, linked, and the namespace line fires only where there is no
  default child at all.

- **And the default sentence was a raw code span**, which every other name on the
  page goes through `code()` to avoid: a program called ``my`cli`` produced
  `` `my`cli` ``, which renders as a code span of `my` followed by prose. A
  backtick in a name is reachable -- the heading test already uses ``tick`x``.

- **`word()` quoted with `JSON.stringify`, and bash expands inside double
  quotes.** Round 2's own fix, which widened the _set_ that gets quoted and left
  the _quoting_ unsafe: measured by handing the printed command to bash, a
  destination ending `foo$HOME` was passed as `foo/Users/chris` and one ending
  `` foo`echo PWNED` `` ran the `echo`. Single quotes expand nothing, and the one
  character they cannot hold is closed, escaped and reopened.

  The test could not have seen it either, and that is the sharper half: it
  asserted that stderr contains `JSON.stringify(docs)` -- a string compare
  against the unsafe spelling, under a name about a shell. It hands the line to
  **bash** now, with the program defined as a function that prints its own
  arguments, and asserts the argument the shell built. Which found a property of
  the message worth knowing on the way: the command is wrapped in a pair of
  backticks for a human, and the stale page's own path is printed in front of it,
  so a destination holding a backtick means the helper has to find the backtick
  that opens the **command** rather than the first one on the line.

- **The website's nav was a second, unencoded reader of where a page is.**
  `routed()` was taught to encode and the nav interpolated the slug raw -- so a
  command called `go#x`, whose page is `go#x.md`, gave `/reference/go#x`, which a
  URL parser reads as `/reference/go` with a fragment. `?` is the same one query
  along. One `referenceHref()` now, used by both, which is the rule those two
  broke by being two.

- **And the `a` and `table` renderers put `node="[object Object]"` on the
  element**, because `react-markdown` passes the mdast node into every component
  and both spread the rest of their props. Measured in the rendered HTML.

- **Two figures in this file did not match the tree**, counted from the build
  rather than from memory: it said ten prerendered routes where there are
  **eight** -- `/`, `/_not-found`, `/reference` and one per command -- and a table
  with eleven rows where `build.html` holds **two tables over twelve `<tr>`**,
  because a markdown table's `| --- |` separator is not a row in the HTML. The
  byte figures on the same page were re-measured and do match.

- **And two stale sentences**: `readSection`'s comment still described the
  dropped keys as "a typo for one of these six" after it grew a second section
  with two fields, and a test comment still called the program-name refusal "the
  same refusal `completionSpec()` makes" -- which is the sentence the source
  comment had just been corrected to withdraw.

##### What the pass over round 3's own fixes found

Seven mutations, **seven caught**, after one survivor and one harness verdict.

The survivor is the one worth recording: reading the default child off
`children` rather than off the whole surface is **equivalent for a visible
child**, so every fixture had it. A **hidden** default child is the input --
there the parent still acts, and the `children` reading made it say "takes no
action of its own" instead, with the name spelled as code rather than linked
because a hidden command has no page to point at.

And the harness refused a verdict rather than reporting a pass: the first
mutation of the `code()` call put a nested backtick inside a template literal, so
the tree did not compile and the run found 21 suites where the control had 26.
Which is the fourth distinct way this repository has had a sabotage round turn
out to be saying nothing, and the guard that caught it is the one that compares
the suite count.

#### What review round 4 found, and the pattern across four of them

**Nine findings, every one confirmed**, two of them severe -- and the shape across
the four rounds is worth as much as any one of them: **every round found a defect
in its predecessor's own output**, four times running. Round 2 found round 1's
case fold half applied and its refresh command two thirds built; round 3 found
round 2's HTML opener and its double-quote shell quoting; round 4 found round 3's
default sentence over-claiming. Code written in answer to a review is code no
review has seen, and the cheapest round to arrange is the one aimed at the last
round's fixes.

- **The page said a bare invocation runs a command its own default supersedes,
  and said a command token was required.** `dispatchDefaultCommand()` adopts a
  default and then asks **that** command for a default of its own, so with a
  nested default the leaf is what runs -- measured through `main()`, root ->
  `build` -> `fast` runs `fast` for `[]`, `['build']` and `['build', 'fast']`
  alike, so `build.md`'s "`mycli` on its own is this command" was false of
  exactly that schema. A default command with a **required argument** is the same
  over-claim one step shorter: `mycli` alone exits 1 there with
  `Missing required arguments`.

  What is true of every one of those is which parent dispatches the command, so
  that is what it says -- "Runs when no command is named at `mycli`" -- and the
  parent's own sentence names the child, which is where a reader following the
  chain goes next. Both sentences are then true at every depth, with no chain
  walk to keep in agreement with the parser's.

  And the usage line said `<command>` where `usageLine()` says `[command]`: a
  command token is not required when something runs without one, and bare `mycli`
  exits 0. One more place the page disagreed with help about the same schema.

- **The snapshot sorted `env`, and `env` order is precedence.** `envValue()`
  answers with the **first** variable that is set, so swapping
  `['SERVER_PORT', 'PORT']` for `['PORT', 'SERVER_PORT']` changes which one wins
  -- and the sorted list made that identical bytes, so a pull request that moved
  it did not fail `--check` and the file told a reader the wrong winner.
  Measured. `ordered()` is for a **set**: `long`, `short` and `choices` are sets,
  because a spelling reaches the option and a choice is accepted whichever order
  the declaration wrote them in. `env` is not one, and the test locked the defect
  in by expecting the sorted form under a comment about choices and spellings.

- **An argument's environment variables were recorded nowhere.** `initArg()`
  stores `envs` and `envValue()` reads them with the same first-wins rule, so
  `ENTRY=x mycli` filling a positional is a contract a script relies on -- and
  renaming the variable could not fail `--check`. `optionOf()` copied `env` and
  `argumentOf()` did not.

- **A repeated option was spelled like a variadic argument.** `multiple` appended
  `...` to the hint and to the type, so the committed page said
  `--external [pkg...]` with a type of `string...` -- and an option **never**
  consumes the rest: measured, `sigil build --external a b` is
  `{ external: ['a'], dir: 'b' }`, where the second token is the positional
  `[dir]`. `[pkg...]` is the spelling of an argument like `[components...]`,
  which does. And `string...` is not a data type the parser has. Help prints
  `--external [pkg]`, so that is what this prints, with "may be repeated" in the
  description -- one spelling where there were two, and the one help already
  uses. `...` stays on an **argument**, where it is the `...` in the name.

- **An example help prints was absent from the reference**, and an option's
  `default` was too. Both are the artifact that is _for reading_ saying less than
  `--help` about the same declaration, which is the wrong way round:
  `examplesOf()` required a `label` where help's `exampleList()` keeps any entry
  with a truthy `text` and prints the label only where there is one, and
  `SurfaceOption` carried no `default` at all. Both now follow help's own rule,
  down to `impliedDefault` -- a flag's implied `false` is noise rather than
  information. The **snapshot** still drops the default, deliberately and for the
  reason recorded above, and `should hold what argv accepts and not what the
  screen says` now declares one so that stays a check rather than a sentence.

  `CommandExample.label` is **required** in the declaration type, so an example
  with no label is reachable from JavaScript rather than from TypeScript. The
  tests cast rather than the type being widened: that is a change to `Command`'s
  own public types, and what is being fixed is that help tolerates the shape and
  the reference did not.

- **`word()` left a leading `=` bare, and zsh expands one.** Measured in both
  shells: `=ls` unquoted is `/bin/ls` in zsh and `=ls` in bash, and zsh is the
  default shell on the platform this diagnostic is pasted into. So a destination
  called `=out` -- a legal directory name -- printed a command that becomes a
  path to a program when pasted. `=` is out of the safe class, which costs
  `foo=bar` two characters. The probe spawns **both** shells now, because a
  bash-only one could not see it.

- **And two more sentences**: `readSection`'s summary line still said it is the
  `build` section's reader after it grew a second one, and this file's own route
  and table counts were off -- eight prerendered routes rather than ten, and two
  tables over twelve `<tr>` rather than one table of eleven rows, because a
  markdown table's `| --- |` separator is not a row in the HTML.

##### What it refuted, and the one defect left out of scope

Thirteen suspicions disproved with a probe, the most useful being a line-by-line
check of the committed `command-surface.json` against the declarations -- every
`multiple`, `required`, `takesValue`, `type` and `choices` of every command,
`_inspect.ts` correctly absent as a `_`-prefixed route, every lone negated flag
recording both spellings -- and a re-read of all six committed pages as the
website's own reader parses them. Both came back clean.

**A cycle of plain command objects overflows the stack inside `initCommand()`,
and that is left alone.** Measured: two plain objects naming each other in their
`commands` maps throw `RangeError: Maximum call stack size exceeded` before
`commandSurface()`'s own `seen` guard is reached, because `initCommand()`
initializes a declaration that already has a `name` in place. The walk's guard is
for a cycle built out of commands `initCommand()` has already returned, which is
the shape a registry holds and the shape the test builds.

It is the **parser's** and it predates this feature, the failure is loud rather
than silent, and the fix the reviewer names is a bound inside `initCommand()` --
which is a change to how every app's schema is built, taken inside a ticket about
a documentation printer. That is the shape this repository refuses, so it is
recorded here with the measurement rather than fixed here.

##### What the pass over round 4's own fixes found

Sixteen mutations, **sixteen caught**, after four survivors and one stale
pattern.

All four survivors were in `packages/sigil/src/reference/surface.ts` and all four
are the same thing, which is now the second time this pass has met it:
`@ttylabs/cli` imports `@ttylabs/sigil` through the published `exports` map,
which points at `dist/`, so a mutation in that package's **source** is invisible
to every test in this one until something rebuilds. The answer is a test in the
_sigil_ suite for each guard the sigil source holds -- which is where the
argument's `env`, the option's `default`, the implied-default test and the
example filter now each have one.

#### What CI found that four review rounds and five sabotage passes did not

Nine jobs, and the three Windows ones failed on two tests in one file while
macOS and Linux were green -- which is this repository's own recorded signature,
and it is the **sixth** instance of the entry under Conventions. Neither failure
was the code, and that is the point worth keeping: four rounds reading a diff and
113 mutations over it cannot see a fixture that spells a path, because on the
platform it was written on the spelling is right.

- **A summary asserted against a backslashed path, where `shown()` ends in
  `displayPath()`.** So `toContain(out)` could not match on Windows -- and the
  `not.toContain(dir)` beside it could not **fail** there, which is the same slip
  pointing the other way and is the more dangerous half: an assertion that cannot
  fail on a platform is one that silently stops covering it. Both go through
  `displayPath()` now, which is the function the subject uses.

- **A refresh command asserted as a literal concatenation, where a Windows path
  is correctly quoted.** `word()`'s safe class is `[\w./@:+-]`, which holds no
  `\`, so the message quoted the path and the test demanded the bare form. It is
  asserted as the argument array a real shell builds now, which needs no
  separator spelled and is **stronger** than what it replaced: the subcommand and
  every argument, as a shell reads them.

Both were found by reading the failure rather than guessing at it, and the five
sabotages over the fixes are all caught: `shown()` taking the relative form
unconditionally, the refresh command dropping `[dir]`, `word()` not quoting at
all, and both directions of the spelling-and-round-trip split -- `=` back in the
safe class **with no shell reachable**, which is the Windows case and which the
spelling assertion catches, and `~'...'` prepended, which passes the spelling
assertion and fails the parse.

The class was then closed rather than the two instances: every assertion in the
three test files was swept for a path it spelled itself, and the only other uses
of `join()` are locating a file for the filesystem -- which wants the platform
separator -- or comparing two lengths `shown()` compares before either is
forward-slashed. The website's own reader was checked for the sibling rule and
already normalizes CRLF before it looks for a fence.

**And `parsed()` had become three claims in one function**, which is what the fix
split: `commandLine()` extracts the printed command, `passed()` answers with the
arguments a shell built, and `parsed()` asserts the quoting and reads `--out`
back. The spelling is asserted **before** the shell is reached and the round trip
after, so a missing shell costs only the half that needs one -- `zsh` is on no
Windows runner, and there the quoting is still asserted for every hostile name.
The two halves are not redundant, which a sabotage had to establish rather than a
sentence: `~'...'` still holds the single-quoted form, passes the spelling
assertion and fails the round trip.

**It also found `run()`'s doc comment orphaned above `parsed()`'s**, two blocks
stacked over one function, so the file documented `parsed()` twice and `run()`
nowhere. Caused by inserting a helper between a doc and its body, invisible to
`tsc`, to the linter and to every one of the five sabotage passes -- and it is
the detached-comment hazard this file records for a suppression a formatter can
move, arriving in prose. Reattached.

#### What the PR review round found: the one string never cleaned

One defect, reported twice -- once against a commit before CI's own finding
landed and once against the tip, so the second report is what says it was still
live. And it is **round 4's own output**: that round is where an option's
`default` started being printed at all, so the pattern its own entry records
holds for a fifth time, this time between a reading round and the PR. What makes
it worth more than the count is where the defect is: four reading rounds, five
sabotage passes and CI had each read this module, and the thing they missed is
one string that goes into a cell without passing the function the module's own
header is written about.

- **An option's `default` went into a table cell without being cleaned, so a
  newline in one tore the row in two.** `described()` runs `cell()` over the
  description and the note beside it is `scalarText(opt.default)` raw -- and
  `table()` escapes only the bar. Measured in all four shapes before anything
  was changed: `default: 'a\nb'` passes `scalarText()`'s `value === value.trim()`
  test, which is about _leading and trailing_ whitespace, and comes back
  unchanged; `default: () => {\n  return process.cwd();\n}` prints through
  `String(fn)`, which is the function's own source. Each left a first line with
  **two columns where the header has three** and a continuation line GFM reads
  as a stray paragraph, so the website rendered a broken table. A bar in a
  default is the one of the four that was already safe, because that is
  `table()`'s.

- **And a control character in one reached the committed page raw**, which is
  this module's own rule broken at the one string it does not apply to: an ESC
  is not whitespace, so `'\x1b[31mred'` is its own trimmed form and came through
  whole. No column check can see that one, because an ESC takes no column --
  which is why it is pinned by its own test rather than by the row count.

- **The clean goes at the boundary rather than on the note, and that retires a
  call rather than adding one.** `described()` documents itself as returning _a
  cell_, so `cell()` wraps the whole of it and the inner `cell(opt.desc)` --
  which was the only cleaning there was -- goes. One pass where there were two
  readers of "a cell is one line", and a note added later is clean without
  anybody having to remember. `oneLine()` is idempotent, so the narrower fix on
  the note alone works too; what decided it is that the wider one cannot be got
  wrong by a later edit.

- **The row-count test had no default in its fixture, which is exactly why it
  could not see this** -- the shape this file keeps recording, in the test
  written for the sibling defect. It carries both tearing shapes now, and the
  sabotage is what says the pair is load bearing: with the fix removed, **two**
  tests fail, that one and the control-character one, and no others. Clearing
  `CONTROL` out of `oneLine()` fails the new test and the description's own,
  which is what says the two halves are pinned separately.

- **It moved no committed artifact**, checked rather than assumed: no option in
  this toolchain has a default with whitespace in it, so
  `sigil reference --check` is still up to date and the snapshot drops `default`
  anyway.

**And the review body's own finding was already closed**, which is worth saying
rather than quietly not acting on: it is CI's two Windows fixtures, reported
against the commit _before_ the fix for them, and all nine jobs are green on the
tip. Verified by reading the two tests rather than by the commit message -- both
build their expectation with `displayPath()` and with the argument array a shell
builds.
