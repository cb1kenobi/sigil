# `packages/config-yaml` — deliberate decisions

These are the entries from [../../AGENTS.md](../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### A YAML config store, and the second time an outsider implemented `ConfigStore`

SIG-148 kept YAML out of core and said why: `ConfigStore` is public API, so
adding a format later changes no interface. SIG-152 is the test of that claim,
and it passed -- **not one line of `@ttylabs/sigil` changed**, and the only thing
`packages/config-yaml` needed that was not already published is nothing at all.
Which is more than the XML store could establish on its own: one implementation
proves an interface is writable, two prove it is not shaped around the first one.

`src/options.ts` is the pinned schema, `src/shape.ts` is the detect-and-reapply
plus the layout detection, `src/read.ts` is the refusal walk, `src/write.ts` is
the diff and the three write refusals, `src/fidelity.ts` is `wouldLose`,
`src/represent.ts` is `canRepresent()`, and `src/store.ts` is the store.

- **`yaml` rather than `js-yaml`, and the deciding reason is the lossless
  rule.** `js-yaml` parses to a plain value and dumps from one, so every comment
  in the file is gone on the first write -- which under SIG-154's rule is not a
  quality gap but a store whose writes are **refused by default, always**, which
  is a read-only store wearing a write method. `yaml` has a document model that
  keeps comments, anchors, quoting styles and block scalars through a round trip,
  and it has no dependencies of its own.

#### The version is pinned, and the famous row is not the one that matters

- **YAML 1.1 and 1.2 do not read the same scalars the same way, and every row is
  measured against `yaml` 2.9.1 rather than read off a spec.** `verbose: yes` is
  the string `'yes'` under 1.2's core schema and the boolean `true` under 1.1 --
  the Norway problem, `NO` for Norway becoming `false`.

  **The two that would actually bite a CLI config are `017` and `12:30`**, and
  neither is in the ticket's own table: a file mode written the way every shell
  writes one is **17** under 1.2 and **15** under 1.1, and a time is `'12:30'`
  under 1.2 and the number **750** under 1.1. `1:2:3` is 3723. `1_000` is a
  string under 1.2 and 1000 under 1.1. `2026-10-19` is a string under 1.2 and a
  `Date` under 1.1. All silent.

- **On this library's own `bool` the two versions happen to agree, and the
  ticket's table was right about that and wrong about one row.**
  `transformValue()`'s `bool` takes `true`/`t`/`yes`/`y`/`on`/`1` and their
  negatives, so `verbose: yes` reaches a `bool` setting as `true` whichever the
  parser handed over -- measured through a real `createConfigSync()`. The
  agreement is **luck rather than design**: the two vocabularies were settled
  independently, and a narrower `bool` -- minimist's "anything but `'false'`", or
  yargs-parser's "only `'true'`", both of which this file records refusing --
  would have made the YAML version decide what `verbose: no` means. Which is the
  argument for pinning rather than taking the parser's default.

  The wrong row is `port: 08080`, which the ticket gives as the string `'08080'`
  under 1.2 core and is the **number 8080**: 1.2's core int is `[-+]?[0-9]+`, so
  a leading zero is a decimal number. Which is the lossy guess this file records
  refusing for the parser's `auto` type -- `007` becoming `7` -- arriving from
  the file's own grammar rather than from a coercion this library chose. The
  _outcome_ is unchanged, because `'08080'` on an `int` is 8080 too.

- **What the pin costs is nothing today**, which is measured: `yaml` 2.9.1
  already defaults to `version: '1.2'` with the core schema. What it buys is that
  a `yaml` major that moved its default would not move what a user's file means,
  which is the one thing a store must not let a dependency decide.

- **`merge: true` is the one thing that is deliberately not 1.2 core.** Without
  it a `<<` is a literal key spelled `<<` -- a file that reads **wrong** rather
  than one that errors, which is the worst of the three outcomes available.

- **The key-uniqueness comparator is widened to "the same path segment", which
  is a collision `yaml` does not have.** It checks uniqueness by comparing scalar
  values with `===`, which is right for YAML and too narrow for a store whose
  paths are strings: measured, `1: a` and `"1": b` are two distinct YAML keys
  that both resolve to the path `1`, and `toJS()` silently keeps the second. One
  setting with two answers and nothing said, which is the collision the XML store
  refuses for the same reason one format along. A `uniqueKeys` comparator turns
  it into `yaml`'s own `DUPLICATE_KEY` **with a line** -- the parser's machinery
  rather than a second walk, which is what makes the line free. A **symbol** key
  is the merge key and two of them in one map are legal, so excluding a symbol is
  what keeps `<<: *a` and `<<: *b` from reading as a duplicate; `yaml`'s own
  comparator special-cases that and a custom one replaces it.

#### What is refused at read, and the four `yaml` resolves to the wrong thing

Almost all of the reading is the parser's. What the walk adds is the four shapes
`yaml` resolves to something **wrong** rather than refusing, each measured:

- **A tag outside the core schema.** `!!set`, `!!omap`, `!!binary`, `!!timestamp`
  and `!!pairs` each resolve **without a warning** to a JS `Set`, `Map`, `Buffer`
  or `Date` -- a value no other layer format can hand back, which
  `isPlainObject()` reads as a leaf so the merge carries it by reference, and
  which this store's own `canRepresent()` then refuses to write. So a file
  holding one reads as a value that cannot be written back. Refused where it was
  read, which is where the line is. An explicit **core** tag is taken, because
  `!!str 5` is the one spelling of "this 5 is a string" and refusing every tag
  would refuse the feature.
- **A mapping key that is a collection**, and refused **before** `toJS()` rather
  than after -- which is not an ordering nicety: that call stringifies such a key
  _and prints `Warning: Keys with collection values will be stringified` to
  stderr_ through `process.emitWarning`. A CLI writing to stderr because
  somebody's config has an exotic key in it is not something to let happen and
  then explain. A **scalar** key of any type is taken, because `1: a` is the path
  `1`, which is where `{"1": "a"}` puts it in JSON.
- **A recursive alias**, whose value is a cycle -- measured, `a: &x\n  b: *x`
  answers a value where `v.a.b === v.a`. Detectable from `visit()`'s own ancestor
  path, so it is core's cycle refusal with a line on it rather than a second
  opinion.
- **An alias that comes before its anchor.** `doc.errors` is **empty** for one
  and `toJS()` **and `toString()`** each throw `Unresolved alias` -- so refusing
  it in the walk is load bearing rather than tidy: the fidelity round trip renders
  the unmodified document, so without this a forward alias threw out of _that_,
  with neither the path nor a line in it, before the read was reached at all.
  Found by the first run of the tests.

Everything else `yaml` already reports and reports better: a multi-document
stream is `MULTIPLE_DOCS`, a duplicate is `DUPLICATE_KEY`, a syntax error is what
it is -- each with a line, which is why `doc.errors` is consulted rather than
reimplemented.

- **An unsafe key is left to core, which is what keeps one answer to that
  question.** `__proto__` arrives from `toJS()` as an **own** property rather
  than moving the prototype -- measured -- so `copyValue()` refuses it with
  `Unsafe config key`, naming the layer. This store does not reimplement the
  guard. What it has to do is **preserve it as own**, which is the entry below.
- **An empty or a dotted key is allowed, because core allows both over a JSON
  layer.** `{"": 1}` and `{"a.b": 1}` are each unreachable by a dotted path and
  each accepted, so the YAML store accepts them rather than inventing a refusal
  its sibling format does not have.
- **A file that is not there, one holding only whitespace, and one holding only
  comments all read as an empty document.** The third does not fall out of the
  second: `parseDocument('# c')` is a document whose value is `null`, so without
  a null branch it is refused by the must-hold-a-mapping check rather than read
  as empty.

#### `toJS()` shares an anchored value with its aliases, which was a real defect

- **`toJS()` resolves an alias to the _same object_ the anchor resolved to**, so
  a write to one path moved another. Measured: `base: &b {p: 1}` with `c: *b`
  answers a value where `v.base === v.c`, so `overlay()` applying a claimed `c.p`
  made `base.p` move with it, the diff reported **two** edits where one was asked
  for, and the refusal then named **`base`** -- a path the caller never mentioned.
  A refusal that names the wrong path is worse than one that names none, because
  it is believed.

  Nothing in `yaml` turns the sharing off and `structuredClone()` preserves it by
  design, so the copy is written: a plain recursive walk with **no memo**, which
  is what duplicates each occurrence rather than linking them. A cycle cannot
  reach it, because the walk above refuses a recursive alias -- and
  `maxAliasCount` bounds how many aliases a document may have at all, so an
  unshared copy is bounded too.

  It also makes this store's answer the shape every other store's is: core copies
  a layer's value on the way in, so the sharing never reached a merged view -- but
  an app calling `store.readSync()` directly would have had one value where
  `json()` hands over two.

- **And that copy was itself a prototype-pollution vector, written two hours
  after the defect it fixed.** `out[key] = ...` with a key of `__proto__` goes
  through `Object.prototype`'s own accessor and sets the copy's **prototype**
  rather than writing a property -- which is the hazard `dotted.ts` is written at
  length about, reintroduced by a function added to fix something else. What a
  user saw was `must hold an object` about a file whose real problem is a key
  nobody should be able to write, because `isPlainObject()` then said the
  document was not a mapping. `Object.defineProperty` is the fix, and both halves
  are pinned -- the key arrives own with the prototype untouched, **and** core
  refuses it naming the layer.

  Found by a test that had **passed before that function existed**, which is the
  shape worth keeping: the regression was invisible to every assertion written
  for the sharing bug and visible to one written for something else an hour
  earlier.

#### The write is a diff, and a path it cannot take is refused with a reason

- **`doc.contents = createNode(value)` is one line and loses every comment**, so
  the write computes the paths at which the document and the target **differ** and
  calls `setIn()` or `deleteIn()` for each. Which is the XML store's `applyInto()`
  one format along and for its reason: everything untouched is untouched, so a
  comment, an anchor, a quoting style and a block scalar survive because nothing
  rewrote them. A sequence is diffed by **index**, so a `push` is one edit and an
  `unshift` rewrites every element -- the same trade that store records.

- **An anchor, an alias and a merge key are the three things YAML has that no
  other config format does, and a write that touched one would be wrong in a
  different way each time.** Which is why the refusal is sharper than the
  ticket's "both answers are defensible". Measured against `yaml` 2.9.1:

  1. **Through an alias**: `c: *b` and a write to `c.p` throws
     `Expected YAML collection at c. Remaining path: p` out of `setIn()` -- an
     internal error naming neither the file nor anything a user can act on.
  2. **A delete of a merged key**: `deleteIn(['c','p'])` answers **`false`** and
     changes nothing, so the value still reads `1` after a `delete()` said it was
     gone. Silent, which is the worst of the three.
  3. **An aliased anchor**: writing `base.p` where another map merges `&b` moves
     `c.p` as well -- a path the write never claimed -- so the document no longer
     holds the value it was handed. And **deleting** one leaves the document
     unserializable: `toString()` throws `Unresolved alias`, so the file cannot be
     written at all.

  Each names the path and the line. Nothing else in the file is affected, which
  is what the diff buys.

- **An anchor fences its subtree only where something _aliases_ it**, which is a
  narrowing rather than caution: an anchor nobody refers to is a label, so editing
  what it names moves nothing else and the write preserves the anchor either way.
  An anchor something does alias is shared state, and (3) is what happens when a
  write edits one.

- **A _set_ of a merged key is allowed, and that is the one place this differs
  from the list.** `set('c.p', 99)` writes `p: 99` **into `c`**, shadowing the
  merge: measured, the anchor is untouched, `base.p` stays `1`, and a re-read
  answers exactly what was written. An explicit key beats a merge key whatever
  their order, so the value round-trips -- and shadowing is the only way to make
  that path hold that value without editing an anchor every other map that merges
  it also reads. The surprise, a key that used to track `base` and now does not,
  is what a `set()` on that path asks for.

- **Every edit is checked before any is applied**, which is `Show`'s own rule:
  build first and touch nothing until there is something to put there, because
  that is the only order where a failure needs no undo. A refusal part way
  through would leave the document half written and the file is written from it.

- **A refusal is a _write_-time one, and that asymmetry is declared rather than
  closed.** `canRepresent()` is handed the path and is the place a refusal
  belongs, and answering it would mean a file read per `set()` -- which the XML
  store does not do either, and which could not be right anyway, because the
  document may change between the `set()` and the `save()`.

- **A delete of the only key a map had removes the map**, which is **core's**
  prune rule rather than this store's: `d: {<<: *b}` and `delete('d.p')` leaves
  `d` empty, `deletePath()` prunes it, and the edit is a removal of `d` itself --
  allowed, correct, and consistent with what a JSON layer does. Worth writing
  down because it is why a README example needed a map with an own key beside the
  merge in order to show the merged-delete refusal at all.

#### The layout is detected as _options_, which is the half XML has no analogue for

- **`yaml` renders indentation from options rather than from the source**, where
  `@xmldom/xmldom` reproduces whatever the source had. So a store that re-rendered
  a four-space document at the default two would reindent the whole file -- and
  the `wouldLose` guard would then fire on every four-space config, which is the
  guard-firing-on-correct-code pattern this file refuses.

  So the shape has two halves. The three bytes a parser does not carry -- a byte
  order mark, CRLF, and the exact run of newlines the file ends with -- are
  detected and reapplied, which is the XML store's `shape.ts` one format along.
  The **layout** is detected as `{ indent, indentSeq, flowCollectionPadding }`
  and handed to `toString()`.

- **The detection and the fidelity check are one computation.** `fidelity.ts`
  asks whether a no-op write reproduces the document's own bytes, and that
  question needs stringify options to ask it with -- so the round trip that
  _chooses_ the options is the round trip that _answers_ it. Either the render
  equals the source, in which case nothing is lost and those are the options a
  real write uses, or it does not and what differs is a residual to report.

- **The regex detection hit 24 of 24 measured documents on the first try** --
  one-, two-, four-, six- and eight-space indentation, an unindented sequence, a
  tight flow collection, comments, anchors, CRLF, a BOM, no final newline, a
  block scalar and a nested map among them. So the bounded fallback sweep is for
  a shape it has not met, and what it buys is that a missed detection costs a
  slower read rather than a false report of loss. Measured: one `toString()`
  where the first candidate matches, which is **1.22ms** over a 900-line file,
  against **20.37ms** for the 24-candidate sweep the first version swept
  unconditionally.

- **An empty flow collection is no evidence about padding.** `{}` is `{}` either
  way, so reading it as tight made every document holding one render its padded
  collections tight.

- **`lineWidth: 0` on every candidate rather than detected.** `yaml` folds a long
  plain scalar at 80 columns by default, so a long value in a config comes back
  wrapped across lines it was never written across. A value long enough to fold
  is one somebody wrote on one line.

#### `wouldLose` is a line diff, not a table of patterns

- **The XML store matches regexes against the source and its own entry records
  what that costs**: a pattern that matches inside a comment or a CDATA section
  "names a line the author would go and find nothing wrong with", which took a
  `contentOf()` pass blanking four kinds of region to close. YAML is worse for
  that -- a `#` inside a quoted scalar is not a comment, and quoting in YAML has
  five spellings -- so the same design would need a scalar-aware blanking pass
  and would still be a guess.

  So what is compared is the **two renderings, line by line**, and what is
  reported is the first line of each kind of difference. One entry per _kind_
  rather than per line, keyed by the sentence, because a reindented file differs
  on every line and ten entries saying so is a wall nobody reads.

  That was written down as "cannot be a false positive by construction: a line
  it names is a line where the source and a no-op write really do differ", and a
  review round falsified it. It held for the _kind_ and not for the _line_: the
  comparison was `source.split('\n')[i]` against `rendered.split('\n')[i]`, so
  an inserted or deleted line shifted every index after it. Measured,
  `a: 1\n\n\nb: 2\n` renders as `a: 1\n\nb: 2\n` and the report named line 4,
  `b: 2`, which is in the output one line higher -- and `Math.max` of the two
  lengths walked past the end of the source, so `a: 1\n# tail\n` reported a
  **phantom** line 3: the empty string `split` leaves after a final newline.

  The claim is true again rather than weakened, because the lines are **paired**
  now. `align()` takes the common prefix and suffix off -- for a document
  against its own re-render that is nearly all of it -- and matches what is left
  by longest common subsequence, with `coalesce()` zipping a run of gone lines
  against the run of added lines that follows it so that a line whose _text_
  changed is still one pair for a recognizer to read. A pair with both halves is
  a line that changed, one half is a line gone or added, and no pair names an
  index either array has not got.

- **It is also strictly more informative, and that made the sibling's
  document-level fallback unreachable.** Two strings that differ cannot have
  identical line arrays, so the trim in `align()` cannot consume all of both and
  it yields at least one pair, which the per-line fallback records something for
  -- which means **every** answer names a line of the file, where XML's fallback
  can only say that the document differs. The
  document-level fallback was written, proved unreachable and **deleted**, which
  is what this file does with a guard that cannot fire; the property is asserted
  over a corpus instead.

- **The complete residual is eleven, over a corpus of thirty-five documents of
  which twenty-four round-trip byte for byte.** Comments, anchors, aliases, merge
  keys, block scalars, quoting styles, flow collections, CRLF, a byte order mark,
  a trailing blank line, no final newline, an integer key and five indentation
  widths all survive. Both counts are **asserted** in `test/corpus.test.ts`
  rather than written down, which is this repository's own standard and was
  earned immediately: the first measurement read "nineteen of twenty-seven",
  the corpus growing by six made it 24 of 33 within the hour, and the sabotage
  pass then turned up two more residual shapes and made it 24 of 35.
  What does not: the whitespace before an inline comment; a tab before one; a run
  of blank lines inside the document; the blank line added before a trailing
  comment; `? a` / `: 1`; a folded scalar's own line breaks; `!!str 5` gaining
  quotes; an indented comment above an **unindented** sequence item moving to
  column 0; a flow collection written across lines; a block scalar indented past
  the step; and a four-space document with an unindented sequence.

- **The last is the parser's own limitation rather than a detection failure.**
  Measured, `{ indent: 4, indentSeq: false }` does not reproduce
  `a:\n    b:\n    - 1`: `yaml` indents the sequence by the step whatever
  `indentSeq` says once the step is not two.

- **The comment row was found by a test asserting the wrong thing**, which is
  worth the note: `yaml` renders a sequence item's own `commentBefore` at the
  item's indent, so with `indentSeq: false` an indented comment above it moves to
  column 0. A comment above an _indented_ item keeps its indent, and so does one
  above a mapping key -- which is why it is one row rather than the general case,
  and it has a recognizer ahead of the general indentation one because the cause
  and what a reader would do about it are both different.

- **The folded-scalar recognizer is the one that has to look _back_.** `a: >` is
  **identical** in both renderings, so the walk never stops on it -- what differs
  is the content two lines down, which says nothing about folding on its own. So
  the marker is found by walking up to the nearest line indented less than this
  one, which is the block's own header. Which is why a recognizer is handed the
  index and both line arrays rather than a pair of strings: the first version was
  handed the pair and the row never fired.

#### `canRepresent()` is the widest of the three, in both directions

- **It allows `Infinity` and `-Infinity`, which `jsonCanHold()` refuses.**
  Written `.inf` and `-.inf`, they read back as themselves and
  `checkValue(Infinity, 'number')` takes one -- it refuses only `NaN` -- so the
  value survives both the round trip and the next load. JSON rewrites both as
  `null`, which is why its store refuses them. The first time a sibling store's
  answer is **wider** than core's rather than narrower, and it is the format
  rather than a preference.

- **It allows every string there is**, where XML refuses a whole class -- a C0
  control, a lone surrogate, `U+FFFE`, a value whose own leading or trailing
  whitespace matters -- because XML has no escape for most of them and its parser
  normalizes the rest. YAML has a double-quoted scalar with an escape for
  everything, and `yaml` reaches for one when it has to: measured **through a real
  UTF-8 file**, `\u0000`, `\u0001`, `\u007f`, NEL, LS, PS, a bare CR, a CRLF,
  `U+FFFE`, both halves of a surrogate pair on their own, a byte order mark inside
  a value and `' padded '` each round-trip byte for byte. A lone surrogate
  survives because `yaml` escapes it as `\ud800`, so the file is valid UTF-8.

  LS and PS are written **raw** and read back, which is YAML 1.2 saying they are
  not line breaks where 1.1 said they were -- so a 1.1-only parser would differ.
  A portability note rather than a round-trip failure for this store, and refusing
  a character this store round-trips because another parser might differ would be
  inventing a rule.

- **It allows any key**, because YAML quotes one. What a key still cannot be is
  unreachable-by-path, and that is core's refusal rather than this one's.

- **What it refuses is eight values, and only one of them is loud.** `undefined`
  writes `null`; `NaN` writes `.nan` and reads back as `NaN`, which
  `checkValue()` refuses on a `number` setting, so writing one produces a config
  the next run cannot load; a `bigint` writes `10` and reads back the **number**
  10, so no data type reads one back -- which is XML's reason rather than JSON's,
  since `JSON.stringify` _throws_ for one where `String(10n)` is exact text; an
  invalid `Date` writes `null`; a `Map`, a `Set` and a class instance each write
  their own contents and read back as a plain mapping or a sequence; a hole in an
  array writes `null`. A function and a symbol are the loud one, thrown out of
  `toString()` as `Tag not resolved` with neither the path nor the file in it.

- **The invalid `Date` is checked before the `toJSON` pass, and it is one value
  where this store is narrower than core's.** `new Date(NaN).toJSON()` is `null`,
  so the generic pass would let it through and `yaml` would write `null`. Core's
  JSON store has the same hole and closing it there is a change to what every
  app's `set()` accepts, taken inside a sibling package's ticket -- so this store
  refuses one value its sibling allows and says so rather than quietly diverging.

#### `.yml` and `.yaml` are one store, and the option exists to say so

- **Two registrations would be two stores to keep in agreement** about a schema
  version, a residual table and three write refusals, for two spellings of one
  format. So the extension is not read at all and the store is the same either
  way. `YamlStoreOptions.format` is what an app that wants its `.yml` layer to
  say `yml` in a message passes, which is the decision made visible rather than
  worked around.

- **There is deliberately no `schema` option**, which the XML store needs: an XML
  list with one occurrence is indistinguishable from a scalar, and YAML spells a
  one-item list `[a]` or `- a`. So there is no ambiguity for a schema to resolve,
  and this store reads no schema at all -- which is the asymmetry between the two
  siblings stated from the other side.

#### What it settled about SIG-148's own design

Both were better found here than guessed at there, which is what the ticket said.

- **The span applier stays internal.** `yaml`'s own document model does the
  editing, so this store never calls core's ordered-splice applier -- and
  deciding whether it is public against a store that does not need it is the
  wrong way round. It stays unpublished until the first store written over a
  parser with _no_ editing model asks, which is the rule `which` waited eighteen
  months on.

- **The lossless check _is_ reachable for a well-built store, and that is a
  finding rather than a gap.** The ticket expected `yaml`'s Document to carry
  enough that the guard would never fire; it fires for nine shapes, which is the
  guard earning its keep and is a measurement of what `Document.toString()`
  renormalizes. Twenty-four of thirty-five documents round-trip, so it is not
  firing on the common case either -- which is what the layout detection is for,
  and without that detection it would have fired on every four-space config.

- **And `checkValue()` and `transformValue()` are both needed, which is the thing
  only two siblings could establish.** YAML's core schema resolves `8080` to a
  number, so a YAML layer goes through `checkValue()`; XML has nothing but
  strings, so an XML layer goes through `transformValue()`. Each sibling
  exercises one. Neither is the store's own call -- `Config` coerces every layer
  whatever produced it -- so this store calls neither function, and the saving is
  that it does not have to ask.

#### What it costs

- **17.15 kB of its own code over one module**, plus `yaml`, which is about 300 kB
  of JavaScript and has no dependencies of its own. An app that does not import
  it pays nothing for either. It was 10.4 kB before the first review round, and
  the 4.4 kB that round added is what its seven severe fixes come to: `rootOf()`
  and `openRoot()`, `nativePath()`, the tagged-scalar and merge-descent refusals,
  the key-anchor fence, `align()` with `coalesce()`, and the `toJSON` walk.

  **This figure said 14.8 kB for two commits after it had stopped being true**,
  which is the stale snapshot this file warns about arriving in its own
  measurement: the cross-model round took it to 16.80 kB and did not re-run it,
  and the second PR round's 379 bytes took it to 17.18 -- where the third
  round's deletion of a condition takes 23 bytes back off, to 17.15. Measured
  both from a worktree at the base commit rather than inferred from the delta,
  which is what said whose staleness it was. And the **README** said 10 kB, which is the
  pre-first-round figure and the one a _consumer_ reads -- stale by 6.8 kB, found
  by following this one rather than reported. Nothing asserts either, so re-run
  `pnpm --filter @ttylabs/config-yaml build` rather than reading them here -- and
  no tally of how often it has moved, because that is a second figure nobody can
  re-derive.

  What the readme test holds is the **magnitude**, which is the right shape and
  was the only reason the drift was survivable: 5k to 20k, which 17.15 passes.
  The ceiling is 30k now, set against the one failure it is for -- `yaml` is
  about 300 kB, so inlining it rather than importing it is what it catches --
  rather than against today's size, where 20k was 1.16x and would have failed on
  the next ordinary addition.

- **The published declaration names no `yaml` type.** Its only import is
  `@ttylabs/sigil/config`, so a consumer that reads this store's signature does
  not take the parser's types on -- which is the call `@ttylabs/config-xml`
  already makes with its own structural `XmlNode`.

- **A fourth workspace member cost exactly what the XML entry says one costs**:
  two `--filter` lists, two guards in `cli.test.ts`, the Layout table and the
  `packages/`-holds-four paragraph. `turbo.json` needed no edit, for the sibling's
  reason: the root `build` task's `inputs` and `outputs` are inherited and this
  package writes only `dist/**`. The second time through that list was a
  checklist rather than a discovery, which is the entry earning its keep.

- **And `demos/` declares it**, which is the only consumer that reaches the
  package the way an app does: every test in `packages/config-yaml/` imports
  relatively, so none of them goes through the `exports` map or reads `dist/`.
  `demos.test.ts` needed **no change at all** for that, and that is the XML
  entry's own fix earning its keep rather than a second one: it already matches
  every `@ttylabs/` specifier and resolves through `createRequire` from
  `demos/package.json`, which is exactly the widening a fourth package would
  otherwise have arrived uncovered by. Checked rather than assumed -- a named
  import of an export this package does not have fails that test.

> Moved: _What the sabotage pass found, and the three it declared_, _What the review round found, and the two claims above it that were false_, _What the PR review round found: the guard that refused its own output_ — see [docs/history/a-yaml-config-store-and-the-second-time-an-outsider-implemen.md](../../docs/history/a-yaml-config-store-and-the-second-time-an-outsider-implemen.md).

#### What a second, cross-model round found, and all seven severe ones reproduced

Four `muse-wonder-1.0-medium` reviewers through `cursor-agent`, one per module
pair, pointed at the three commits the first round's own fixes produced --
which is the rule this file records three times over and had not yet applied
here: code written in response to a review is code no review has seen.
**Seventeen confirmed findings**, and every one of the seven severe was
reproduced before it was believed. A different model family from the grok round
and the overlap was small, which is the argument for running both rather than
picking one.

- **A boxed `String` as `paths` evaded the core guard, and the reviewer
  under-measured it.** `overlay()` refused only `typeof paths === 'string'`, and
  `new String('ab')` is an object that iterates as characters -- which is the
  precise mechanism that guard's own comment exists to stop. Reported against
  the YAML store; measured here on **all three**, each silently deleting `a` and
  `b`, byte for byte the pre-guard behaviour. Asked with
  `Object.prototype.toString` now, which covers both spellings and is
  cross-realm where `instanceof String` is not. Fixed in **core** for the reason
  SIG-149's own path/item ambiguity was: all three share it, and a guard in one
  leaves the other two holding it.
- **A tagged scalar used `typeof` as a proxy for "the tag re-stringifies
  this".** Two silent-wrong-data shapes and two unreadable files, all measured:
  `!!bool true` set to `null` wrote `a: !!bool false` and read back **`false`**,
  `!!str 5` set to `null` read back the **string** `"null"` -- `typeof null` is
  `'object'`, which the guard exempted as a kind change -- and `!!int 5` set to
  `1.5`, or `!!float 1.5` set to `2`, each wrote a file the store's own reader
  refuses. `tagTakes()` asks the **tag**, from a matrix of five tags against
  nine values measured through `createNode()` and a re-parse rather than reasoned
  from the grammar. The integer pair is the subtle one: `!!int` takes a number
  only where its decimal _printing_ is all digits, so `1e21` is refused although
  `Number.isInteger(1e21)` is true, and `!!float` only where it is **not**,
  because JS cannot spell `2.0`.
- **A `.nan` key is refused at read, which is where that defect's fix belongs.**
  `yaml` matches a pair by its key's own value and `NaN !== NaN`, so
  `setIn([NaN], v)` appends a second pair -- measured, an edit produced a
  duplicate key the reader then refuses -- and `deleteIn([NaN])` answers `false`,
  so a delete is a silent no-op. Neither half is fixable in the writer, because
  no spelling of the segment reaches the pair; a key no write can address is a
  key that names no usable path. `.inf` is **not** refused with it, because
  `Infinity === Infinity` and a write addresses one perfectly well.
- **A float-spelled key past 2^53 was a path silently renamed.** The integer
  guard fires on `INTEGER_SOURCE`, so `9007199254740993.0: a` escaped it and
  read back as the path `9007199254740992` -- while the **same digits** in
  integer form were refused, so the two spellings disagreed. A float _value_
  rounding is ordinary float semantics and stays allowed; a key is a path
  segment. Compared as **canonical decimals** rather than as text, or every
  ordinary float spelling would go with it: `2.50` against the path `2.5`, `1e21`
  against `1e+21`, `007` against `7` and `-0` against `0` are each the same
  number written twice, and each is pinned.
- **An ancestor holding an aliased anchor evaded both fences.** They check
  prefixes of the edit path and the exact path, and `editsFor()` emits a drop or
  a kind-changing replacement of a whole subtree as **one edit at the
  ancestor** -- so the anchor buried inside it was never consulted and `yaml`
  threw its own `Unresolved alias`, with neither the file nor the path in it,
  which is exactly the message both refusals were written to replace. The file
  survived, so this is the crash class rather than data loss. A collection value
  was exempted on the ground that `editsFor()` descends into one -- which is
  true only where the two sides are the **same kind**, so the exemption was the
  defect half-fixed, and the PR round below is where that is measured.
- **The array guard tested "a canonical number" where it meant "an array
  index".** `String(Number(key)) !== key` passes `-1`, `1.5`, `Infinity`, `NaN`,
  `4294967295` -- one past the last index a JS array has -- and
  `9007199254740991`; none extends `length` or makes a hole for the hole check
  to catch, so each was an own enumerable property **silently dropped** by a
  guard written to refuse exactly that. `foo` was caught all along, which is why
  it read as working.
- **`coalesce()` zipped a gone run against an added run across an unchanged
  line, dropping a whole loss kind.** `align()` emitted nothing for a line it
  matched, so the two runs looked adjacent -- measured,
  `a: 1\n\n\nb: 2\n# tail\n` reported the collapsed blank run and silently
  lost the blank added before the trailing comment, where each half alone
  reported correctly. The fix is to **emit** the matched lines so the run scans
  stop on them and drop them again once they have served as boundaries, which
  is the claim that paragraph already made -- "never across an unchanged line" --
  made true rather than restated.

  It also closed the round's own **Unsure** item, which was right: the index for
  a line only the rendering has was the _rendered_ one used as a source index,
  and the two part the moment anything above net-inserted or net-deleted. With a
  blank run collapsed above it the trailing-comment row looked at `b: 2` and did
  not fire. `Aligned.at` carries the source cursor the walk emitted the line at,
  which is exact where the derivation was a coincidence.

- **Three recognizers named the wrong cause or none.** The flow-collection row
  asked only about the **source** line, so any differing line ending in `[` or
  `{` was reported as a flow collection -- including literal block content whose
  indent moved, and a comment, in neither of which is there a flow collection;
  it asks about the rendered line too now, which is the rule the explicit-key
  row already kept. The same row's `$` could not see a CRLF file's carriage
  return, so it never fired there at all -- the end-of-line class the blank rows
  were fixed for, in the one row that fix did not reach. And the inline-comment
  row normalized the **first** whitespace-hash run, which is inside the scalar
  whenever the scalar holds one, so the commonest residual there is fell through
  to the bare sentence. `\S` before the run is what puts the greed in the right
  place, and the first attempt at it -- a bare `(.*)` -- broke the plain case as
  well, because the capture eats the whitespace and leaves `[ \t]+` matching one
  space, which is a no-op.
- **A block-scalar header with its indicators in the other order was read as
  structure.** YAML allows `|2-` as well as `|-2` and `yaml` accepts all four
  spellings; written chomping-then-digits only, the scalar's own content line
  set the step, and a write reindented the whole mapping around it from six
  spaces to three. The block scalar itself moves either way -- an explicit
  indicator pins its content, so the document is lossy whatever candidate is
  chosen -- so what the missed detection cost was the **rest of the file**.
- **`candidates()` repeated one.** The sweep deduplicated each entry against
  `out[0]` alone, so wherever the detected indent is 2 the appended default
  collided with one of the flips and the bounded six was five distinct layouts
  for the commonest shape there is -- a redundant render and line diff on every
  read. The uniqueness assertion beside it exercised a four-space document,
  where no collision occurs, so it read as a general guarantee the code did not
  keep.
- **And `writtenAs()` was wrong about three cells rather than the two
  reported.** Measured against `createNode()`: a `DataView` is an
  `ArrayBuffer.isView` with no iterator and no indexed members, so it writes
  `{}` rather than a sequence; a boxed `BigInt` was in no branch and fell
  through to the mapping default where it writes `10`; and a boxed **`String`**
  is iterable, so the sequence test claimed it where it writes the scalar `ab`.
  The boxed primitives are asked first now. A generator's `constructor.name` is
  the empty string besides, which `??` passes through, so its refusal read
  "YAML writes a of this kind as".

Four were prose contradicting the code beside them -- the module header's "four
shapes" where the walk now refuses more, `indentOf()`'s summary still claiming a
block scalar needs no skipping over the loop that skips it, the module's "three
kinds of path a write refuses" where there are five, and a cap paragraph
counting nine answers where there are ten. That class is a third of the round,
which is what this file already records about a heavily commented codebase: the
written rule is what stops the next reader checking the call site.

> Moved: _What the second PR round found: a tag refused and a value's newlines dropped_, _What the third PR round found: the exemption that was never load bearing_ — see [docs/history/a-yaml-config-store-and-the-second-time-an-outsider-implemen.md](../../docs/history/a-yaml-config-store-and-the-second-time-an-outsider-implemen.md).

#### The i18n gap is the sibling's, unchanged

Everything a user's **file** can provoke is translated and everything only the
app's own code can provoke stays English, which is the line the i18n work drew.
And `sigil check` reports every one of this package's keys as an **orphan**,
because it compares an app's catalogs against `SIGIL_KEYS` plus the app's own and
a dependency's keys are in neither -- a warning on correct code with a message
pointing the wrong way. The shape of the fix is `sigil check` unioning an
`./i18n-keys` subpath from each dependency that publishes one, which is purely
additive and is a change to what that command promises **every** app, taken
inside a store package's ticket. Not closed here, for the second time, and
recorded for the second time because the two packages share it.
