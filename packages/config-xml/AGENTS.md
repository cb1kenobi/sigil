# `packages/config-xml` — deliberate decisions

These are the entries from [../../AGENTS.md](../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### An XML config store, in a package of its own

SIG-148 drew `ConfigStore` as public API rather than letting it fall out of
whichever store was written first, and said why: adding a required method to an
interface **implementors** write is breaking for every one of them and cannot be
softened by a default, so the cost of being wrong is paid by somebody else's
package. `packages/config-xml` is the first external implementation, and that is
what it is **for** -- an interface nobody has implemented from outside is an
interface nobody knows is implementable. The XML is the vehicle.

It needed **no change to `ConfigStore`**, which is the result. What it needed was
five things core had deliberately not published, which is the entry below.

- **A package rather than dependency injection, and the rule is about the
  runtime's dependencies rather than about this repository's.** An XML layer
  wants a parser and `@ttylabs/sigil` may not have one; the two ways out are the
  app handing a store a parser or a separate package depending on one. The second
  wins on two counts and the first is the one that decides it: an app that does
  not want XML pays **nothing**, where injection makes every app wire a parser
  into a store it does not otherwise care about. The second is ergonomic -- an
  app imports a store that works rather than a store plus the thing it needs.
  `@xmldom/xmldom` has no dependencies of its own.

#### The store kit, which is the real cost of a sibling

- **Five things core had deliberately not published, published now, and it is one
  decision rather than five.** `writeAtomic()`, `writeAtomicSync()`,
  `isMissing()`, `overlay()`, `segments()` and `isPlainObject()`. Each was
  unpublished on the rule `which` waited eighteen months on -- decide against the
  first caller that does rather than against one that does not -- and this is that
  caller; `atomic.ts`'s own entry says so in as many words. What they share is
  that a sibling reimplementing one would not merely duplicate it, it would
  **disagree**, and in every case about something that is already a recorded
  review finding:

  - `writeAtomic()` is the temp-plus-rename, the mode and owner it preserves, the
    symlink chain it resolves through `realpathSync.native` and the five flush
    failures it swallows. A second copy inherits none of it, and the thing it is
    protecting is a user's hand-edited config.
  - `isMissing()` is which errors mean "the file is not there", which is `ENOENT`
    alone -- reading every error that way was a real defect that handed a `0o600`
    config back world-readable.
  - `overlay()` is the whole of `WriteOptions.paths`: the null exemption, the
    non-object refusal and the claimed-delete no-op. A store that honours `paths`
    and gets those wrong reverts another process's keys, which is the defect that
    option exists for.
  - `segments()` carries the prototype-pollution guard. A sibling splitting on
    `.` reopens it.
  - `isPlainObject()` is where the boundary between structure and a leaf is, and
    a store walking a value has to draw it where the merge does.

  It costs **102 bytes**, measured: the config entry's graph went from 32,523 B
  to 32,625 B over the same seven modules, because `json()` already uses four of
  the six and what is added is the export statements. The root entry was
  **7,518 B** then and unchanged by this, because `config` is its own entry.

- **The alternative was publishing nothing and letting the sibling rewrite them**,
  which is worth stating because it is what a reader will assume happened. It is
  refused for the reason above, and the asymmetry with the **i18n** gap below is
  deliberate: the store kit is what makes a sibling store _correct_, so without it
  the feature cannot exist; the i18n registration is what makes its messages
  _translatable_, so without it the feature merely has an English corner.

#### The mapping, and why a sentinel is not a spelling preference

- **Attributes and child elements share one path space**, so
  `<server port="8080"><host>a</host></server>` is `server.port` and
  `server.host`. Which makes `<port>8080</port>` and `<server port="8080"/>` the
  same setting at the same path, and that is the whole of this package's design.

  A reserved key -- `_attributes`, `$`, `@_`, which xml2js and fast-xml-parser
  both use -- is wrong here for a reason with nothing to do with taste: **it puts
  one setting at two paths depending on the format of the layer it came from.** An
  XML system layer under a JSON user layer is the ordinary arrangement, and under
  a sentinel it is `server._attributes.port` against `server.port`: two paths, so
  neither shadows the other, the merged view holds both, the system default is
  invisible at the path an app reads, and a user who deletes their override gets
  `undefined` rather than `8080`. The precedence chain -- the one thing a layered
  config provides -- broken by the _format_ of a layer, which is precisely what a
  store interface exists to make invisible. The same argument rules out a parallel
  accessor and an XPath-ish `server/@port`: both are a second path space wearing a
  different hat.

  It is a **test** rather than a sentence -- `should let a JSON layer shadow an
  XML one at the same path` builds exactly that stack, in both spellings, and
  deletes the override to confirm the default is reachable.

- **A name used twice is refused where it was written, naming the line.** One path
  space has one value per name. The cost is a document that cannot be expressed,
  and it is one nobody writes on purpose.

- **A prefix is not part of a path**, so `<n:port>` is `port`. A prefix is a
  document-level spelling decision and `xmlns:n` against `xmlns:cfg` must not
  change which config key an app reads -- the sentinel argument one level in. What
  it costs is that two differently-prefixed names with one local name collide, and
  that is the same refusal through a second door.

  Which needed a guard the obvious implementation does not have: grouping children
  by local name alone **merges** `<n:a/>` and `<m:a/>` into one array -- two
  namespaces silently becoming one setting -- so the grouping tracks the spellings
  each local name arrived under and refuses more than one.

- **`xmlns`, `xmlns:*` and `xml:*` are no setting at all, matched by namespace URI
  rather than by spelling.** `xmlns:n` has a `localName` of `n`, so a prefix
  declaration would otherwise be a setting called `n` -- and `xml:space`, which is
  the spec's own answer to whitespace and therefore the attribute an author is
  most likely to write here, would be one called `space`.

- **An element holds a scalar or named parts, never both.**
  `<name>Chris<title>Mr</title></name>` and `<name sir="yes">Chris</name>` are the
  same problem -- a value for the element itself _and_ a value for something named
  inside it, with no path for the first -- so it is one rule rather than two:
  non-whitespace text beside any attribute or element child is mixed content, and
  whitespace is not, because every pretty-printed document has it.

- **A leaf's text is trimmed, and so is an attribute's value.** Whitespace around a
  value in XML is **layout**: a user who breaks a long description across lines
  for readability means the words, and an untrimmed read gives every
  pretty-printed leaf its surrounding newlines. Both, because trimming one and not
  the other is the format split this mapping exists to refuse one level in -- the
  same path with two values.

  Which is the one place this diverges from the parser, deliberately:
  `transformValue()`'s own rule is that an attached value is taken exactly as
  typed. A command line has no pretty-printer and XML does, so "exactly as typed"
  means something different. What it gives up is a value whose own surrounding
  whitespace matters, and `canRepresent()` refuses writing one rather than letting
  a round trip quietly change it -- honest and inconvenient over silent and wrong,
  which is the direction the `createEffect` type error already records.

- **The root element is the document rather than a setting.** Its name is not in
  the path space -- `<cfg>` and `<settings>` hold the same config -- and an element
  with nothing named in it is therefore an **empty config** rather than the empty
  string. Without that root-only rule `<config/>` reads as `''`, is refused for not
  holding an object, and an app whose config file exists and is empty cannot
  start. A root holding a scalar is still refused, which is `json()`'s rule for a
  file holding `42`.

#### Lists: the reopened question, and the split that was not one

- **A review round reported the list mapping as the cross-format split this
  package's own argument refuses, and the split it was looking at is between two
  _shapes_.** Its table was:

  | layer | file says                                                 | path holding the list |
  | ----- | --------------------------------------------------------- | --------------------- |
  | XML   | `<plugins><plugin>a</plugin><plugin>b</plugin></plugins>` | `plugins.plugin`      |
  | JSON  | `{"plugins":["a","b"]}`                                   | `plugins`             |

  Which reads as the `_attributes` table with `plugins.plugin` in it, and is not:
  **those are two different documents.** The JSON equivalent of the XML wrapper is
  `{"plugins":{"plugin":["a","b"]}}`, and the XML equivalent of `{"plugins":[…]}`
  is repeated `<plugins>` **siblings** -- which the plain mapping puts at
  `plugins`, exactly where JSON does. Both formats spell both shapes, and each
  shape has one path in both. The `_attributes` case really is a split, because
  `<server port="8080"/>` and `{"server":{"port":8080}}` are the _same_ document in
  two formats and a sentinel gives them two paths.

  So the mapping needs **no collapse rule**, which is what the round proposed and
  what could not have worked: one child of one tag is ambiguous between a list of
  one and an object of one, so "a wrapper whose children share a tag is an array"
  turns `<server><host>x</host></server>` into `server: ['x']`.

- **What the round was right about is a different defect, and it is the one the
  schema fixes.** A setting declared `multiple: true` over an XML layer with a
  **single** occurrence meets `'a'` where it wants `['a']`, so `coerceSetting()`
  throws `Expected a list of values` on the **first load**, before anything is
  written. A real app failing to start.

  Core is right and this is the format leaking: the same document in JSON --
  `{"plugins":"a"}` -- throws identically, which is `coerceSetting()`'s own
  recorded decision that a scalar where a list was declared is a mistake worth
  reporting rather than something to wrap. So the store takes the schema and
  wraps, which is the ticket's own accepted sentence -- "the schema is how you get
  rid of the ambiguity" -- made true by something actually reading it.

- **It takes the schema as a constructor option and reads one field of it.**
  `xml(path, { schema })`, the **same object** an app passes to `createConfig()`,
  and the store reads `multiple` and nothing else. A constructor option rather
  than anything on `ConfigStore`, so the no-interface-change claim stands: it is
  app wiring, and the published surface is unchanged. A path the schema declares
  that `segments()` refuses is **skipped** rather than thrown over, because
  `createConfig()` is about to refuse it with a better message and a store is not
  the right place to report a schema somebody got wrong.

- **An empty occurrence at a `multiple` path is the empty list**, which is what
  makes `[] -> <plugins/> -> []` hold. Zero elements is the key being _absent_,
  which merges as nothing and lets the layer below show through rather than
  shadowing it with an explicit empty -- so an empty list writes **one empty
  element** and reads back as `[]`.

  What that costs is a list of one empty string, which is the same bytes, and
  `canRepresent()` refuses exactly that array. `['a', '', 'b']` is three
  occurrences and reads back whole, so only the single-item case is ambiguous.

- **An attribute at a `multiple` path wraps too**, which is the single-occurrence
  case met through the other spelling -- refusing it while wrapping the element
  form would be the two spellings disagreeing again. What it means is that an
  attribute can never express a list of more than one, which is a property of the
  format.

#### Writing: through the DOM, diffing first

- **`write()` is re-read, parse, diff, serialize, and it needed no interface
  change.** `WritableConfigStore.write(value)` is handed the whole value the layer
  should hold and chooses how to get there -- the JSON store splices spans, this
  one walks a DOM.

  The read-only decision this reverses had one argument and it is correct about a
  writer that **reprints**: comments, the declaration, a DOCTYPE, CDATA, attribute
  order, self-closing versus paired, entity spellings and indentation are all lost
  by one. It says nothing about a writer that keeps the DOM and serializes it
  back, which is the third option the argument did not consider. Measured over
  thirty-two documents, **seventeen round-trip byte for byte**, including every one
  of those six.

- **Diffing first is a correctness rule rather than an optimization, and the
  obvious mechanism corrupts the file.** Measured: assigning `textContent` to a
  CDATA-bearing element **with the string it already holds** turns
  `<banner><![CDATA[<b>hi</b>]]></banner>` into
  `<banner>&lt;b&gt;hi&lt;/b&gt;</banner>`, because the assignment replaces the
  CDATA section with a text node. So "walk the value, find or create each node,
  set it" destroys every CDATA section in the file on any write, for keys nobody
  touched. The JSONC writer's own rule, met in a second format: **touch only what
  changed.**

- **And the diff is structural rather than careful.** What the DOM currently says
  is read back through `readElement()` -- the _same_ mapping the store reads with
  -- and a subtree whose current value equals its target is skipped whole. Two
  separate walks is how a write comes to disagree with a read about what a path
  means; being the read's own arithmetic is the only way to agree by construction,
  which is the argument SIG-125 already makes about the layout measure.

- **The comparison is at the level of the bytes, which is the same defect arriving
  through the schema.** A layer's value has been through `coerceLayer()`, so an
  `int` setting holds the **number** `8080` where the document holds the string
  `'8080'`. Comparing those as values says they differ, and then every typed
  setting is rewritten on every save -- which is the CDATA corruption again, by a
  route no careless walk is needed for. So a scalar is compared as the text it
  would be written as, because the question this diff asks is whether the bytes
  have to change.

- **The spelling follows the DOM where it fits and the value where it does not.**
  A setting already spelled as an attribute stays an attribute and one spelled as
  an element stays an element -- the DOM is what remembers which, which is what
  makes a round trip clean and is why a sentinel mapping was refused. A key with
  no existing spelling becomes a child **element**, which is the conservative half:
  an element can hold a scalar, an object or a list, so it never has to be
  promoted later.

  An object or a list at a path currently spelled as an **attribute** promotes: the
  attribute is removed and elements are written. Which is the general statement --
  an element can hold anything and an attribute is the special case kept where it
  still fits -- rather than the `setAttribute('server', '[object Object]')` a
  review round measured. Removed **before** the elements are written, or the
  document holds the collision this mapping refuses.

- **An attribute update goes through its own namespace and qualified name.**
  `setAttributeNS(null, 'mode', …)` on an element whose attribute is `n:mode` adds
  a **second** attribute called `mode` beside it -- which is the
  two-answers-for-one-setting this mapping refuses, created by the write that was
  meant to keep the spelling. So `XmlAttr` carries `nodeName`, which a read does
  not need.

- **A new element takes its parent's namespace and prefix.** Measured:
  `createElement('b')` inside `<n:cfg xmlns:n="urn:x">` yields `<b>2</b>` beside
  `<n:a>1</n:a>` -- a new key silently out of the namespace every other key is in,
  which for a document something else validates is a file that stops validating.
  `createElementNS` with the parent's URI and prefix is what puts it where its
  siblings are, and for a **default** namespace the two spellings serialize
  identically -- also measured -- so it is one rule rather than a branch.

- **A removal takes the whitespace that was laying its child out.** Left behind, a
  removal leaves an indented blank line per key, which is the line rule
  `removeFrom()` in the JSONC writer already keeps.

- **An insert copies the indentation of the first sibling that _has_ one**, which
  is neither the first nor the last and took probing the detection to arrive at.
  The first alone is wrong for `<config><a>1</a>\n  <b>2</b>\n</config>`, where
  `<a>` shares the opening tag's line and has no preceding text at all -- so an
  insert read "no layout" off it and landed inline against a `<b>` that is laid
  out. The last alone copies an **outlier**: a document whose indentation is
  inconsistent gets the odd one out rather than the majority. Measured on both.

  The step is read off the document -- the first element whose own indent is longer
  than its parent's -- so it is the user's answer rather than this package's, with
  two spaces where a document is laid out across lines and has no nesting to read
  one off. A document with no line break in its layout, `<a><b>1</b></a>`, has no
  step, and an insert stays on the line it is already on: inventing one would
  reformat a file nobody asked to reformat.

- **An element with no children to copy has its whitespace dropped before the
  layout is written, and the _root_ is where that shows.** A scalar becoming a
  container is already cleared, because the read says `''` and the target says an
  object; the **root** reads as `{}` by its own rule, so both sides are plain
  objects, the clear was skipped, and `<config>\n</config>` kept its newline while
  the insert added a second one beside it -- a stray blank line in every file
  written into an empty-but-laid-out document. Also found by probing rather than by
  a report.

  A document written **from nothing** is the one case the detection gets wrong on
  its own, and the caller says so rather than the bytes: a fresh `<config/>` has no
  text in it at all, so it reads as single-line and a from-scratch file would come
  out as one line however many settings it holds.

- **A fresh file carries a declaration and a root the caller can name.** `config`
  by default, and `root` is the one decision a from-scratch JSON file does not have
  to make, because `{}` is a whole document and there is no XML equivalent. Only a
  _write_ needs one -- a missing or blank file reads as an empty document.

- **The acceptance test is `json()`'s own, one format along**: a comment-rich
  document with a declaration, two comments, a CDATA section and tab indentation,
  with one key set, and **every other byte identical**.

#### `wouldLose`, per document, and the three things that are not losses

- **Computed at read time by round-tripping the source against itself**, which is
  `WriteOptions.lossy`'s own rule and this is the store it was written for: a DOM
  store writing a file with no trivia in it loses nothing, and refusing that write
  would be a guard firing on correct code. Equal means the field is **absent** --
  which is how `layer.wouldLose?.length` reads it -- and unequal means the specific
  normalization is named.

- **A byte order mark, CRLF and a trailing newline are detect-and-reapply rather
  than losses**, and that is the contradiction a review round found: they were in
  the residual table _and_ in the reapply, so a check on the raw serialize reports
  a loss every CRLF config does not actually suffer. `reshape()` runs first and
  then the comparison does -- and it compares against the document's **own bytes**,
  mark and all, because comparing the reshaped output against the BOM-stripped
  body reports every marked file as lossy, which is the same contradiction through
  the third thing that is reapplied.

  The mark is the one that is not merely cosmetic. Measured: `U+FEFF` then `<a/>`
  **parses**, reports an `error` through `onError`, and the mark survives into the
  output as a text node _outside the root_; and `U+FEFF` then a declaration
  **throws**, because the declaration is no longer at position 0. So stripping it
  before the parse is what makes a marked file readable at all.

- **An internal DTD entity reference is refused at read rather than reported.** A
  review round named it as the residual that matters -- `&e;` serializes as
  `&amp;e;`, a silent corruption rather than a renormalization -- and it is right
  about the serializer and wrong about where it belongs. Measured:
  `@xmldom/xmldom` reports **`entity not found`** at the `error` level while
  parsing one, so the store refuses the document where it was written.

  Which is the stronger answer and the reason is that the loss is not cosmetic: the
  parser cannot expand the entity, so the _value_ this store would read is the four
  characters `&e;` where the document says `hi`. A wrong value is not something to
  write down in a loss table and carry on from. A declaration nothing **references**
  round-trips untouched -- also measured -- so a document is refused for the
  reference rather than for the DOCTYPE.

- **The residual that is left is seven cosmetic rows and two the spec requires.**
  An empty paired tag, a single-quoted attribute value, whitespace around an
  attribute's `=`, a numeric character reference, `&apos;` and `&quot;`, and a bare
  `>` in text -- that last one found by the measurement rather than by the ticket.
  Attribute-value and NEL normalization are **required of every conforming
  parser**, so they are not this store's to avoid and get a `kind` of `spec`
  saying so.

- **What a read-time round trip cannot see is edit-induced loss**, and both cases
  are **closed in the writer** rather than reported: an unprefixed insert by
  `createElementNS`, and a CDATA section written over by diffing first. Which is
  the right place for them, because a loss a store can avoid is one it should avoid
  rather than report -- so an empty `wouldLose` is the honest answer to the
  question it asks, and is not a bound on what a `set()` will do.

- **A difference the table has not met is still reported**, with a sentence saying
  the document does not survive a round trip unchanged. The table is what makes a
  message actionable rather than what makes the answer true, so a normalization
  this serializer grows later is still a loss rather than silence.

#### `canRepresent()`, and the four things this mapping cannot tell apart

- **Three of the four refusals are this store's mapping rather than the format.**
  `null` and `undefined` are XML's -- it has no such thing, and core drops a key
  holding either before it reaches a store, so this is reachable only through a
  `write()` a caller made directly. The other three are the mapping's:

  - **`{}` against `''`.** An element with nothing in it serializes as `<a/>`
    whichever it came from, so the mapping has to pick, and it picks `''` -- because
    that is what `set('host', '')` writes, so the round trip holds for the value an
    app can actually set. Which makes the empty object the one refused, and the way
    to clear a subtree is `delete()`. The **document** is exempt: there `{}` is an
    empty config, is what a store over a file nobody has written yet reads, and
    `<config/>` reads back as `{}` by the root rule.
  - **`['']` against `[]`**, which is the empty-list entry above read from the
    other side.
  - **A string that does not trim to itself**, which is the trim entry above read
    from the other side.

- **Everything else is written as text, which is a saving rather than a cost.** XML
  has no scalar kind, so a number, a boolean and a `Date` all reach the file as a
  string and `checkValue()` coerces them back -- exactly as an environment variable
  already reaches an option. So this store calls **no** `checkValue()` of its own,
  which SIG-148's finding about already-typed values bypassing coercion simply does
  not apply to.

  Which is true of the _store_ and false read as "an XML value never meets the
  schema", and the ticket's own prose had to be corrected for it: `Config` runs
  `coerceLayer()` over every layer whatever produced it, so `'8080'` on an `int`
  setting is the number every reader after the coercion sees. The saving is that
  the store does not have to ask. A value with **no** schema setting reads back as
  a string, which is the format rather than this store.

- **A `Date` is the one non-plain object allowed through, written as its ISO
  form.** Because `transformValue(iso, 'date')` reads one back, so it really does
  round-trip where a `Map` or a class instance reaches the file as `[object Map]`.
  The same reasoning `jsonCanHold()` records for letting a `toJSON` through,
  narrowed to the one case the schema can read -- a general `toJSON` rule would
  have to answer what to do when one returns structure, and nothing needs it.

- **A `bigint` is refused**, unlike JSON's reason for refusing one. `JSON.stringify`
  **throws** for a bigint, where `String(10n)` is exact text -- so the refusal here
  is not inherited. It is that there is no schema type that reads one back: `'10'`
  on an `int` is the number `10` rather than `10n`, so a bigint does not round-trip
  under any declaration, where `8080` does.

- **A non-finite number is refused, and `NaN` is the one that decides it.**
  `transformValue('NaN', 'number')` **throws** -- measured -- so writing one
  produces a config the next run cannot load, which is the silent-loss class one
  step worse. `Infinity` happens to read back and is refused with it rather than
  explained: one rule is worth more than a divergence from `jsonCanHold()` that has
  to be remembered.

#### Characters and names, which the probe found and the ticket did not name

- **A C0 control is written _raw_ and parsed back, so the file round-trips here and
  is rejected by everything else.** Measured, and it is the sharpest defect in this
  package's own self-review: `set('a', '\u0001')` produced
  `<config><a>\u0001</a></config>`, which `@xmldom/xmldom` reads back perfectly and
  which is outside XML 1.0's `Char` production -- so a store whose whole argument
  is about not corrupting a user's file was writing one no conforming tool can
  read, with nothing saying so.

  So `canRepresent()` refuses every character outside `Char`: C0 except tab,
  newline and carriage return; a lone surrogate; U+FFFE and U+FFFF, where the
  range stops at U+FFFD. **U+007F to U+009F are legal** and are allowed, which is
  the one place reading the production rather than guessing changed the answer --
  they are inside `[#x20-#xD7FF]`.

  Expressed as **code points rather than a character class**, which is this
  repository's own recorded rule and the lint is what asked for it: a class of
  escapes is what `no-control-regex` is about, and the answer is not a
  suppression, because one a formatter can detach from the line it was written
  over stops working without anybody editing anything -- which happened once in
  the toolchain's copy of the escape pass. `\p{Cc}` is the usual way out and is
  the **wrong set** here: it is C0, `DEL` and C1, where this wants C0 minus three
  and neither `DEL` nor C1. And the walk is by code **point**, which is what lets
  a _lone_ surrogate be the thing refused -- iterating a string yields a paired
  one as a single code point above U+FFFF and an unpaired one as itself, so
  "is this in the surrogate range at all" is only ever true for a lone one.

- **And every character this parser _changes_, measured rather than reasoned
  about.** A carriage return reads back as a newline, which is XML's own
  line-ending normalization; NEL (U+0085) reads back as a newline in text and as a
  **space** in an attribute, which is XML 1.1's. A lone surrogate is in both sets:
  illegal _and_ it reaches the file as U+FFFD, so the value changes even where a
  tool would read it. Each is a round trip that quietly changes a value, which is
  the thing the trim refusal is already written for.

  What survives is worth recording because it is not obvious: a tab and a newline
  round-trip in **both** spellings, because the serializer escapes them in an
  attribute as `&#9;` and `&#10;` -- so the loss-table row about attribute
  whitespace is about _reading_ a document that holds one raw rather than about
  writing one.

- **A name no element can have is refused at the `set()` rather than thrown out of
  the DOM at a `save()`.** Measured: `set('1bad', 'v')` reached `write()` and threw
  `invalid character in qualified name "1bad"` -- `@xmldom/xmldom`'s own message,
  untranslated, with neither the file nor the path in it. Which is exactly what
  `canRepresent()` is synchronous for.

  XML's `Name` production **minus the colon**, which is the one deliberate
  narrowing: a colon makes a prefixed name, and this mapping's rule is that a
  prefix is not part of a path -- so `a:b` would write `b` under a prefix `a` and
  read back as `b`. The DOM's own answer there is
  `prefix is non-null and namespace is null`, which names nothing.

  Asked of **each segment of the path and each key of the value**, because
  `write()` is handed a whole document and the path it is asked about is `''`: a
  key nothing ever passed to `set()` -- one off an `apply()`, or out of another
  layer -- reaches the DOM with no segment check behind it.

- **One consequence, conservative on purpose.** The check is asked of the _merged_
  document rather than of what the caller passed, which is `jsonCanHold()`'s own
  recorded reason -- so a file that already holds a character XML cannot carry
  refuses **every** write to it, naming the character and the key. The alternative
  is the store deliberately emitting a document no conforming tool can read.
  Reading such a file is fine, and `wouldLose` reports nothing about it, which is
  honest: nothing is lost, the file was illegal before and after.

> Moved: _What review round 1 found, and it reviewed a source it had invented_, _What review round 2 found, and what reading its findings cost_, _What the pass over round 2's own fixes found_, _Round 3 never answered, and what was done in its place_, _What the PR review round found: an errno and a code unit_, _What the second PR review round found: the same number, three more times_, _The sabotage pass, counted in one run against the final tree_, _What the packaging claims come to, measured_ — see [docs/history/an-xml-config-store-in-a-package-of-its-own.md](../../docs/history/an-xml-config-store-in-a-package-of-its-own.md).

#### Parse errors, and the one thing the parser does twice

- **A fatal parse error is reported through `onError` _and then thrown_, so the
  parse is bracketed as well as handled.** Measured over ten malformed documents:
  seven do both and three only report. Without the bracket a `ParseError` escapes
  with its own message -- `Opening and ending tag mismatch: "a" != "config"`,
  untranslated, with the path nowhere in it -- which is the whole of what reached a
  caller. Found by a test rather than by review, and the collected message is
  preferred over the thrown one because a parser that reported before it threw has
  already said the thing closest to the first offending byte.

- **An `error` level is a refusal rather than something to carry on from**, and
  what makes that affordable is the mark being stripped first: with it, content
  outside the root really is content somebody wrote, which has no config path and
  would be silently kept or silently dropped either way. `&nope;` and `<1b/>` are
  the other two that report and do not throw.

#### A sibling package's translated messages have no key registration

- **Everything a user's file can provoke is translated, and `sigil check` reports
  every one of them as an orphan.** Measured through `checkCatalogs()` directly:
  a catalog carrying this store's own key gets

  > `"de" translates "…", which nothing asks for; the English may have been reworded`

  which is a **warning on correct code with a message pointing the wrong way** --
  the key is not a reword, it belongs to a dependency. The check compares an app's
  catalogs against `SIGIL_KEYS` plus the app's own, and `appKeys()` walks the app's
  tree, so a dependency's keys are in neither set.

- **Translated anyway, and the gap recorded rather than closed.** The alternative
  is English messages, and those are _unfixable_: no app can make them German,
  where the warning is a warning, says exactly what it found, and only appears for
  an app that chose to translate them. The i18n work's own `PromptError` finding is
  the same call -- `Fehler: Cancelled` is half a sentence, and fixing it was worth
  three keys.

- **The shape of the fix is `sigil check` unioning an `./i18n-keys` subpath from
  each dependency that publishes one**, which is purely additive -- it can only
  make the framework set larger, turning an orphan into a count. It is not taken
  here because it is a change to what `sigil check` promises **every** app, inside
  a ticket about one store, which is the call this file refuses repeatedly. The
  asymmetry with the store kit is above: that one the feature cannot exist without.

#### What a third workspace member cost, which is what the ticket asked

Every item the ticket predicted, paid:

- **The Layout table and the `packages/`-holds-two paragraph**, both edited at the
  top of this file.
- **Two `--filter` lists.** `pnpm test` and `pnpm coverage` name their packages
  exactly rather than by glob, for the recorded Windows reason, so a third package
  is a third filter in each -- and `the root build filter` reads the workspace and
  fails if one is added without joining the build, which is that test working.
- **Two guards in `cli.test.ts`.** `pinned dependencies` gains the manifest and its
  count, and `the build hash` gains the task plus a `reads` row -- which for this
  package is `tsdown` over `tsconfig.build.json` and nothing else: no generator, no
  registry and no test read, so it is `@ttylabs/sigil`'s shape with the generator
  taken out rather than `@ttylabs/cli`'s.
- **`turbo.json` needed no edit at all**, which is worth saying because the ticket
  expected one: the root `build` task's `inputs` and `outputs` are inherited, and
  this package writes only `dist/**`, which is already named. Claiming
  `registry/**` it never writes is harmless -- turbo captures nothing from a glob
  that does not match -- and is the same inheritance `@ttylabs/cli` already relies
  on, which is why the outputs assertion reads the **resolved** definition.

- **`demos/` is a fourth consumer, and it is the only one that proves the
  package is reachable the way an app reaches it.** Every test in
  `packages/config-xml/` imports relatively, so none of them goes through the
  `exports` map or reads `dist/` -- which is the gap `demos.test.ts` exists for
  and which `padCell()` once sat in for a whole pull request. So
  `demos/package.json` declares `@ttylabs/config-xml` as `workspace:*`, which is
  the shape `website` and `demos` already have and is deliberately **not** a root
  dependency, for the reason the global-hash entry gives at length.

#### The demo, and the import check it found a hole in

`demos/config/02-xml.js` is an XML layer under a JSON one in a single stack, and
it was written because nothing in the suite shows the thing the ticket is for:
that past the layer list nothing asks which format a layer is. The claims it
makes were each measured against the running demo before the prose was written.

- **It is a second demo rather than a layer added to `01-layers.js`.** That one
  is about the merge -- the chain, the schema, `set()` touching one layer, the
  frozen view -- and an XML layer in it would have been a format detail inside a
  demo about something else. This one is about a **store from another package**,
  which is a different claim and has four parts: one path space, the schema
  coercing text, a write that keeps the file, and the two refusals.

- **The two refusals are the half that could not be shown anywhere else.**
  `canRepresent()` names what the format cannot hold at the `set()` that wrote
  the value, and `wouldLose` plus the `save()` refusal is the lossless rule --
  which this file already records as being "mostly for the sibling packages,
  the stores in here never report a loss, so nothing in core ever trips it". So
  a demo in `packages/sigil` could not have shown it firing at all, and this one
  can: a single-quoted attribute and a numeric character reference are enough.

- **Both refusal blocks assert rather than merely catching**, because a `catch`
  that logs is the vacuous shape this file keeps deleting: a save that stopped
  refusing would have printed its heading with nothing under it and still exited
  0, which is exactly how a renamed import once went unnoticed. The cleanup is a
  bare `try`/`finally` for the same reason -- `01-layers.js`'s own gated `catch`
  is written up above as the mistake that cost a round.

- **And the import check had a hole the demo walked straight into.**
  `demos.test.ts` matched `@ttylabs/sigil` alone and resolved each specifier the
  way **that test file** would, which answered correctly only because
  `@ttylabs/cli` happens to depend on sigil too. A `@ttylabs/config-xml` import
  was therefore unchecked -- measured, a named import of an export that does not
  exist passes with the narrow pattern and fails with the widened one, which is
  what says the widening is load bearing rather than tidy. It matches every
  `@ttylabs/` specifier now and resolves through `createRequire` from
  `demos/package.json`, which is the more honest question besides: the demo is
  what runs, so the resolution that matters is the demo's.

  Resolving it from the test instead would have meant a devDependency on
  `@ttylabs/config-xml` for `@ttylabs/cli`, and `the toolchain's dependencies`
  writes that list out so that taking one is a decision somebody makes. Taking a
  dependency to make a test resolve, when the correct resolution needs none, is
  not that decision.

#### And the lint found a byte order mark in four comments, which `sources.test.ts` could not

- **The gap the FIGlet pass recorded, walked into again, and closed this time.**
  That entry says a byte order mark is a **format** character rather than a control
  one, so `test/sources.test.ts` -- which checks C0, `DEL` and C1 -- cannot see
  one, and that widening to `\p{Cf}` needs an allow-list for the two legitimate
  U+200D in the tree. So it was left. Four literal marks then went into this
  package's comments, written by a `\uFEFF` in a shell heredoc being interpreted,
  and `oxlint`'s `no-irregular-whitespace` is what said so.

- **Closed for the mark alone**, which needs no allow-list because no file here has
  a reason to hold one -- and it is the one format character that is not merely
  invisible: it changes how a file **parses**, which is what `shape.ts` spends a
  module on.

- **It found two more that predate it, and one of them is the entry recording the
  hazard.** `AGENTS.md`'s own sentence -- "Both are `\uFEFF` escapes now" -- held a
  **literal** mark where it meant to show the escape, invisibly, in the one file
  somebody reads to find out about it. The other is `jsonc.test.ts`'s own
  leading-BOM case, which is escaped rather than allow-listed: the escape feeds the
  same byte and keeps the source readable, so the allow-list stays for the tests
  where a raw byte really is the subject.

- **And a blind replace is how it got worse before it got better.** Replacing every
  literal mark with the prose `U+FEFF` hit the `const BOM` and two test strings as
  well as the comments, because the character is invisible and a bulk edit cannot
  see which is which. Which is the hazard stated as a cost: the fix for an
  invisible character is itself hard to do by eye.

- **Then the paragraph above put two more in, and a test file a third**, which is
  the fourth and fifth instances and what they say is about the tooling rather than
  about anybody's care: the
  two sentences naming the escape were written into this file through a shell
  heredoc, and the `\uFEFF` in them arrived as the character. So the new check caught
  the prose describing it, twice, in the commit that added the check -- and then a
  third time, in a test asserting that a marked file is **not** a loss, written
  through the same heredoc an hour later. The fix is to build the six characters in
  a script rather than to type them. Which is the whole argument for the check in
  one line: an escape sequence for an invisible character is itself something a
  layer of tooling can quietly turn back into the character, so nothing but reading
  the bytes answers it -- and the check caught all three, which is the first time
  anything in this repository has.
