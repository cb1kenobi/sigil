# `packages/sigil/src/i18n` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Translating: the English is the key

Translatable strings, for the framework's own output and for an app's.
`src/i18n/` is the runtime, `packages/cli/src/build/i18n.ts` is the extractor
and the check, and `src/i18n/keys.ts` is generated.

- **The English sentence _is_ the catalog key, and that is the decision the rest
  of the design falls out of.** `` __`Unknown option "${name}"` `` looks up
  `Unknown option "{0}"`. There are no dotted key names to invent, the fallback
  is in the source rather than in a catalog so it is always a correct sentence,
  and two sites that say the same thing share one entry -- `Invalid number: {0}`
  is thrown from two places in `transformValue()` and is one key, as
  `Show help for a command` is one key for both the `--help` option and the
  `help` command. The design pass had planned a `sigil.` prefix over dotted
  names _and_ a committed `SIGIL_KEYS` carrying the English _and_ the template
  literal left at the throw site: two copies of every sentence in two different
  forms, which is the drift this file keeps deleting.

  The known weakness of keying on the English is that a copy-edit orphans every
  translation. It is already covered: `sigil check` compares the key sets both
  ways, so a reword surfaces as one missing key and one orphan, which is exactly
  the "this string changed" signal a dotted key is supposed to buy.

- **A tag rather than a call, and `%s` is what it is not.** printf consumes its
  arguments sequentially, so it **cannot be reordered** -- and reordering is the
  entire reason interpolation beats concatenation, because German puts the label
  before the value as readily as after it. A tag's key carries numbered slots
  and those do reorder: a translator writes `Für {1} ist "{0}" ungültig` and the
  arguments stay where they were. `%1$s` would reorder too, at the cost of the
  thing nobody likes about printf.

  What a tag cannot give is _named_ slots: `${v}` hands over the value and not
  the name `v`. `${{ value: v }}` would work through shorthand and is horrible,
  so it is refused. Over 37 framework keys with two slots or fewer each, and the
  English sentence as the key supplying the context, numbered is enough.

  The other thing the tag buys is that **the toolchain already reads tagged
  templates**: `findTemplates()` plus `bindings.ts` is the mechanism the `ui` tag
  uses, so the extractor is a third reader of proven code rather than a new one.

- **It is called `__` and `__n`, because `t` is a trap here.** `t` is i18next's
  convention and it is the one name that cannot work: `reboundNames()` in
  `bindings.ts` is **module-wide**, so any `t` bound anywhere in a file drops
  every string in that file from `sigil check`'s key set, silently. Measured
  rather than feared -- there are **22** `t` bindings in `packages/*/src` today,
  all of them in `src/style/`, where `t` is the normalized progress fraction in
  `easing.ts`, `interpolate.ts` and `animate.ts`. Those three files hold no
  user-facing string, so `t` would have worked today, **by luck**: the first
  message added to a file that eases, or the first easing helper added to a file
  with messages, takes every key in it away with nothing to say so. `__` and
  `__n` have zero bindings in the tree, are the `mashpie/i18n-node` and
  WordPress convention, and come with an established name for the plural partner
  rather than needing one invented.

- **It renders at the call site, so `err.message` is localized.** The design
  pass had an error carry `{ key, params }` with `.message` kept English and
  `renderError()` doing the lookup. Rendering where the string is built is
  smaller by a lot -- no `ParseError` subclass, no key/params plumbing, no change
  to `renderError()`, and **one** mechanism for errors and for help chrome rather
  than two -- and it is what this file already says a parser error is: "they are
  what the user sees, so write them accordingly". The existing suite passes
  unchanged, because a test runs with no catalog and a catalog-less `__` zips the
  template back together.

- **The English path builds no key at all.** `__()` tests whether a catalog is
  active before anything else, and with none it zips the parts and the values
  together -- no key, no lookup, no allocation beyond the string. `__n()` selects
  with `count === 1` there, so **no `Intl` constructor is built on the English
  path** and `--version` stays free of ICU, which is the hardest constraint this
  feature had.

- **A plural is an object of categories, not a mini-syntax.**
  `{ one: 'Alias:', other: 'Aliasse:' }`, selected with `Intl.PluralRules`, which
  is the only `Intl` constructor cheap enough to be here -- it does not
  initialize ICU. Polish's four categories and Arabic's six come free. A plain
  string is taken too, for a language with one form for every count, which is
  what Japanese, Chinese and Korean have. ICU MessageFormat is refused for the
  reason the design pass measured: the framework has exactly **one** plural, and
  a grammar for one plural is the weight the ticket was asking about.

- **`templateKey()` is exported, because there are two readers of the key rule
  and a second implementation would be a lie about a working string.** The tag is
  handed its parts by the engine and the extractor reads them off an AST; if
  those two disagreed, `sigil check` would report a missing key for a sentence
  that translates perfectly. So it is one function taking the parts, not a
  `TemplateStringsArray`, and the test that holds it is a **differential**: a
  catalog is built from the key the _extractor_ reported and the tag is then
  evaluated for real, over thirteen shapes of template. Sabotaged with an
  off-by-one second reading, nine tests fail.

  It is the **cooked** parts rather than the raw ones, so a `\n` in the source is
  a newline in the key -- which is what a translator editing JSON expects to see.

- **A slot no value names is left exactly as it was, and `{{` is the escape.**
  So a literal `{0}` in a string with no interpolations is safe without anybody
  having to know about escaping, which is the overwhelmingly common case; the
  escape is there for the rest. One regex in one pass, so `{{0}}` cannot be
  unescaped to `{0}` and then interpolated.

- **A locale is a loader map on the schema, which is the shape `Command.load`
  already is.** A literal specifier inside a dynamic import is the one thing a
  bundler can see, follow and split on -- so per-locale chunk splitting **falls
  out with no build code at all**, verified rather than assumed: the fixture's
  `de.json` comes out as `chunks/de-BMZtSuZA.mjs`, 0.5 kB, lazy. A directory
  convention was refused because discovering `locales/*.json` means `node:fs` on
  every run including `--version`, to answer a question a map answers for free.

- **An app that declares no `locales` resolves no locale at all.** A declared
  fast path rather than a guard: with no catalogs there is nothing to resolve a
  locale _for_, so the common path never asks `Intl.getCanonicalLocales()`
  whether `LANG` names a language. The only thing it changes is that `locale()`
  answers nothing, which is the right answer when English is what is in effect.

- **The chain is `AppOptions.locale`, `SIGIL_LOCALE`, `LC_ALL`, `LC_MESSAGES`,
  `LANG`, `Schema.defaultLocale`, English.** `SIGIL_COLOR_SCHEME`'s chain with
  its reasons: each step down is less specific knowledge about the same question,
  the app is on top because a named locale is a statement about its output rather
  than a guess, and the user is next because what they are correcting is the
  detection. `LC_ALL` over `LC_MESSAGES` over `LANG` is POSIX's own order.
  Namespaced because there is no cross-tool convention for forcing a CLI's
  message locale the way `NO_COLOR` is one for colour.

  `C` and `POSIX` mean English and read no catalog, which is this feature's
  `NO_COLOR` -- `LANG=C.UTF-8` is what CI generally holds and English is the
  right answer for a CI log. A variable that is **set and blank** falls through
  to the next, the way an empty environment variable already does in the parser,
  while `LC_ALL=C` is a decision and stops the walk.

- **`Schema.defaultLocale` is the bottom of that chain, and it is a second
  property rather than a second writer of `AppOptions.locale`.** Two
  precedences, so two names: `AppOptions.locale` is the app saying "this
  program's output _is_ German" and outranks the environment, while
  `defaultLocale` is the app saying "ship in German unless the machine asks
  otherwise" and the environment outranks it. One name meaning both is how a
  default comes to override the user, which is the trap. It is what
  `"locale": "de"` in `sigil.json` reaches, through the build.

  It does **not** open the no-catalogs fast path: an app that names a default and
  ships no `locales` still resolves nothing, because a default is not a catalog
  and there is nothing to load. And it is a tag rather than a catalog, so it goes
  through the same normalization and the same fallback chain as `LANG` -- `de`
  serves Austria from one `de` catalog, and a tag no loader is keyed by reads as
  English.

- **`sigil.json` gains a `locale`, which is the first key in that file that
  changes what the app says at run time -- so it is top level rather than under
  `build`.** Everything else in there is a toolchain setting: `components` is
  where `sigil add` ejects and `build.*` are bundler knobs, none of which the
  running app can observe. `build.locale` would read as _baking_ a language in,
  which is a different thing and is deliberately not done; `locale` reads as a
  fact about the app, which is what it is. `sigil build` writes it into the
  schema it generates as `defaultLocale`, beside the version and the baked tree.

  The runtime cannot read that file, and that is the whole reason the build has
  to carry it: reading one at startup is what `Schema.locales` being a map rather
  than a directory convention exists to avoid. It is not validated as a BCP 47
  tag in the toolchain either, because the runtime normalizes it and a tag no
  catalog is keyed by already reads as English -- a second grammar for BCP 47
  here would be one that disagrees with `Intl`.

  What it costs is an asymmetry worth stating rather than hiding: the key reaches
  the **built** app only, so an app whose `sigil.json` says `de` and whose schema
  says nothing is German built and English unbundled. That is `version`'s own
  shape -- the manifest's version is baked while the app's own function is the
  unbundled answer -- and the answer is the same: an app that wants its
  unbundled runs to match writes `defaultLocale` in its schema too, in which
  case the build writes the same value over the top. Not closed with a mechanism,
  because the only one available is a file read at startup.

- **The POSIX forms are normalized by hand, because `Intl` refuses all of
  them.** `en_US.UTF-8`, `pt_BR`, `zh_Hans_CN`, `de_DE@euro`, `C` and `C.UTF-8`
  each throw `RangeError` out of `Intl.getCanonicalLocales()`, so leaning on it
  is not an option that exists. Two traps the six lines have to know: **`POSIX`
  canonicalizes to `posix` rather than throwing**, so a resolver that trusts the
  answer reads the C locale as a language -- which is why the C check is made
  _before_ `Intl` is asked -- and **`nonsense` canonicalizes to `nonsense`**,
  because canonicalization validates syntax and not existence. The second is
  harmless and is left alone: a tag no loader is keyed by simply reads as
  English.

  A **single letter** is not a valid primary language subtag, which is how two
  tests in the suite first came to assert the English fallback while believing
  they had loaded a catalog -- `loadCatalog({ x: … }, {}, 'x')` resolves to
  nothing. One failed honestly and its sibling passed for the wrong reason, which
  is the vacuous-fixture shape this file keeps recording; the fallback test
  carries a sibling key that _does_ translate now, so a catalog that fails to
  load cannot be mistaken for the behaviour being asserted.

- **`Intl.DateTimeFormat().resolvedOptions().locale` is the wrong thing to
  ask**, because it reads the **host** rather than the environment and answers
  `en-US` on a machine with `LANG=C.UTF-8` set.

- **Both sides of a loader-map match are normalized, because a map is written by
  hand.** An app keying one `de_DE` or `de-de` means `de-DE`, and matching the
  spelling rather than the tag would leave it unreachable with nothing to say so.
  The fallback chain truncates at `-`, so one `de` catalog serves Austria and
  Switzerland and `zh-Hans-CN` is served by `zh-Hans` or `zh`; a more specific
  catalog wins where there is one.

- **A loader that throws, or that answers something that is not a catalog,
  leaves English in effect and says so through `sigil:i18n`.** What a broken
  translation must not do is fail a parse: the English it falls back to is a
  working message, and the user is already being told something went wrong. A
  catalog that answers the wrong _shape_ for a key -- an object where the source
  asked for a string -- falls back for the same reason rather than putting
  `[object Object]` on screen.

- **A missing key is silent at run time and loud at build time.** Loud at
  runtime is refused on the case that decides it: a partial catalog is the
  **normal** state of a translation, so a `de.json` with 30 of the keys is a
  German build with the rest in English, and `[missing: …]` would make
  that build _worse_ than the English one -- on the error path, where the user is
  already being told something went wrong. A key that falls back **forever** is
  the real failure, and only a build can see that.

- **The framework's keys are counted and the app's are named, and that is not a
  preference about noise.** The two have different audiences. An app's own
  missing key is a bug in that app's catalog: few of them, each a specific string
  somebody wrote, and naming it is what makes it fixable. The framework's 37 are
  a bulk translation job -- one task, the same strings for every app there is --
  so a line per key turns a half-finished translation into a wall, **measured at
  35 warnings** for one fixture catalog that had translated its own strings and
  none of sigil's. A wall is what teaches people to stop reading warnings, and
  the runtime's own argument applies to the build too. Three readable warnings
  rather than thirty-seven.

  Both directions are warnings rather than errors, because the app works either
  way, in English, and refusing to build over an incomplete translation would
  make a partial catalog worse than no catalog. And a framework key the **app**
  also writes is reported from neither side, which is the merge keying on the
  English buys.

- **`src/i18n/keys.ts` is generated into the runtime and has a subpath of its
  own.** Generated for the reason `utilities.ts` and `east-asian-width.ts` are:
  extracting the keys needs oxc and is toolchain work, while what the runtime
  gains is a sorted array of strings. In the **runtime** rather than the
  toolchain because `sigil check` compares an app's catalogs against the key set
  of the `@ttylabs/sigil` that app actually depends on, and the toolchain is a
  devDependency on its own version line -- a copy there could be a release ahead
  and report a missing key for a message the installed runtime does not have,
  which is the argument the registry already records. On `./i18n-keys` rather
  than on `./i18n` so it is on nobody's runtime path, which is the call `./themes`
  already made against `./theme`: verified, the root entry's static graph does
  not hold it.

  It came out at **37 keys**, which is the number the design pass counted before
  any of this was written -- and that is a coincidence rather than a
  confirmation: it counted 37 without the three merges this gained
  (`Invalid number`, `{0} options:`, `Show help for a command`) and without the
  three metasyntax keys it gained (`[options]`, `[command]`, `<command>`). It is
  **55** now, and 2 plural: the prompts are the section below, and no figure
  anywhere should be read as the current count -- `SIGIL_KEYS.length` is.

- **`[options]`, `[command]` and `<command>` are translated and `<entry>` is
  not.** The asymmetry is right: those three are _metasyntax_ a user never
  types, where an argument or option name is the API they do type. So a usage
  line is half translated on purpose -- `私のツール build [オプション] <entry>` --
  which is what every localized CLI does.

- **`heading()` stopped appending its colon, and the catalog owns the
  punctuation.** It used to render `` `${title}:` `` while `hanging()` was handed
  `'Usage:'` _with_ its colon, so the two disagreed about whose the punctuation
  was -- and the colon is not a constant across languages: French wants a narrow
  space in front of it and Japanese the fullwidth one, neither of which a caller
  that cannot reach the character can express. A breaking change to a published
  export from `@ttylabs/sigil/help`, taken because the package is at `0.0.1`.

- **The CJK hypothesis held and needed no code change.** Every measurement in
  `help/` already goes through `stringWidth()` -- `template.ts`'s hanging indent
  is `width - stringWidth(label) - 1` -- so a Japanese screen fits at 120, 100,
  80, 60 and 40 columns with every description column square. Asserted as the
  _property_ over five widths rather than as a picture, and the raggedness check
  is **per section**, because `Commands:` and `Options:` legitimately have
  different label widths. The width help lays out in is `terminalWidth()`'s,
  which reads `COLUMNS`; `settings.help` is not a knob, which the first version
  of that test assumed and so measured the same screen five times.

- **A `desc` is a string or a thunk, and the thunk is what makes a description
  translatable at all.** The limitation this closes was measured before it was
  fixed: a `__` in an object literal is evaluated when the module holding it is
  imported, which for the schema is before `main()` is called -- so on a built
  app `Verwendung:` and `Optionen:` translated and
  `--where [w]  Where to put it` did not. `Argument`, `Option`, `Command` and
  `Schema` all take `string | DescThunk` now, and `initArg()`, `initOption()` and
  `initCommand()` resolve it through one `resolveDesc()`, because three readings
  of "a description may be a function" is three answers to one question.

  The shape `Schema.version` already had, which is what makes it the obvious one
  rather than an invention: a value in a literal is evaluated too early and a
  function is called when the answer is known. Resolved **once**, at init, rather
  than through a getter -- a lazy one would answer differently after a
  `setLocale()`, which is the rule `err.message` already follows, and it is why
  `InternalCommand.desc` narrows back to a `string` so no reader past `init*()`
  meets a function.

  It is **guarded** rather than assigned unconditionally, and the tests are what
  said so: normalizing must not _add_ a key the declaration never wrote, because
  the copies echo the declaration -- twelve `deep.equal` assertions in
  `options.test.ts` fail over a `desc: undefined`. `hidden` always reading back a
  boolean is the one declared exception.

  A thunk that answers something that is not a string **throws**, naming the
  declaration, because a description is measured and wrapped: before this,
  `desc: () => 42` was `r.split is not a function` out of the wrapper with nothing
  named. `Schema.version` is lenient about the same shape and is entitled to be,
  since what it answers is interpolated into a string and coerces.

  `Schema.desc` is **declared** while this was being done, because help has
  always printed it -- `Command`'s index signature let it through -- and a
  property help reads should be a property the types name.

  An option's **shorthand** takes a thunk too, and leaving it out was the one
  real gap a self-review found: `'--where': 'a description'` is a `desc` written
  in a shorthand, so `'--where': () => __`...`` is the same statement the other
  way -- and before this it was `Expected option to be an object`, which names
  nothing. A thunk working in `{ desc: () => ... }` and not three characters to
  the left is the asymmetry this file keeps recording as a defect.

- **And the static lift reads a `__` tag, so the lift and translation stopped
  being a choice between two.** That was the half worth fixing: a tagged template
  is not a string literal, so `` desc: __`Build the app` `` in a command module
  was reported as `"desc" is computed` and the root help listed that command by
  name alone -- while the key was sitting in the source the whole time.
  `translatedKey()` reads it, through `bindings.ts` rather than by spelling, so
  which shapes of the tag count is the answer `findTemplates()` already gets; and
  `generate.ts` prints `` desc: () => __`Build the app` `` over an import of the
  tag, so the built app renders it through its own catalog rather than baking the
  English in.

  The import is emitted only when something in the tree needs it, and by
  `generateCommands()` rather than by its caller -- a caller deciding would be a
  second reading of the same tree, and the one that got it wrong would print a
  module with an undefined tag in it. It is printed as a **template literal**
  rather than a quoted string because `__` is a tag and there is no call form of
  it, which costs the escapes: the key is built from the _cooked_ quasis, so what
  is emitted has to cook back to exactly what was lifted. Pinned as a round trip
  over eight keys rather than as a spelling.

  An **interpolated** tag -- `` desc: __`build ${target}` `` -- is reported with
  a message of its own rather than as plain computed, because "computed rather
  than a string literal" about a `__` tag whose neighbour lifted perfectly well
  names nothing the author can act on.

  Measured end to end on a real build: `build  Die App bauen` on the root screen
  of an app whose command module was never imported.

- **Baking a single pinned locale is deferred, and its helper went with it.** The
  design pass measured it at +0.07 ms at 34 keys, and said the form is the object
  literal rather than the `JSON.parse`-of-a-string-literal trick everybody
  reaches for first -- which loses until about a thousand keys. A `printCatalog()`
  was written and tested and then **removed**, because the baking is not wired and
  this repo does not ship an export with no caller. What `sigil.json` gained
  instead is a `locale` **default** rather than a baked catalog, which is the
  entry below: it decides which catalog is loaded and bakes none of it.

- **One module instance across two entries, which is the hazard the design pass
  did not name.** An app imports `__` from `@ttylabs/sigil/i18n` while the
  framework's copy is bundled into `index.mjs`; if rolldown gave those two
  entries separate copies, nothing `main()` resolved would reach an app's own
  strings -- and the failure would be silent, because every lookup would simply
  miss. Verified both ways: `index.mjs` imports `./i18n.mjs` directly, and a
  built app whose `main()` resolved `de` has its own `` __`…` `` from the subpath
  answer out of that catalog.

- **The root entry grew from 4.1 kB to 6.8 kB**, which is `i18n.mjs` and nothing
  else -- the key constant is not on it. Splitting the locale resolution into a
  module `main()` imports only when the schema declares `locales` would give
  about 1.5 kB of that back, and is not done: nothing measures a 1.5 kB module,
  and it would cost an internal/public split of one barrel. The ceiling in
  `test/dist.test.ts` is 20 kB and its comment named 6.8 rather than 4.1. It names
  **7.5 kB** since SIG-135, for the ~700 bytes the section below measures -- and
  the two halves of this sentence contradicted each other for a commit, the first
  describing a comment the same diff had already changed.

- **`literals.ts` gained `outermostWith()` and `loaderSpecifier()`, and both are
  shared rather than copied.** The catalog reader asks "which object literal is
  the schema" and "what file does this loader name", and `readAppCommands()` and
  `moduleSpecifier()` were already asking exactly those -- two implementations of
  either is two answers to one question, which is the rule `readRoutes()` records
  for the two route walks.

- **The catalogs are read statically, never by calling a loader.** Importing the
  entry would run the app, which is the rule the whole build keeps -- so a
  loader's literal specifier is followed to the file and the JSON is read off
  disk, the same thing the build already does for a command's `load`. A loader
  doing anything else is not refused: it is a function and may do what it likes
  at run time, so the build **says** it could not check that one rather than
  reporting a clean catalog it never opened.

- **`appKeys()` does not exclude a previous build's output**, and what that
  costs is bounded. `--out` is resolved after `inspect()` has run, so there is no
  directory to pass; a bundle that inlined the runtime holds no import of
  `@ttylabs/sigil/i18n` for `importBindings()` to match and contributes nothing,
  and one built `--external @ttylabs/sigil` contributes the app's own keys, which
  are the keys being collected anyway. The one thing it can change is to suppress
  an orphan warning for a string since deleted, which is the safe direction.

- **The whole thing costs nothing measurable, and `--version` reads the catalog
  where the design pass had it not.** Forty interleaved rounds with a
  `node -e process.exit(0)` control, nine variants of a real app:

  ```
  variant                      min      p25   median
  no locales   --version    26.80    27.57    27.94
  no locales   happy        26.85    27.76    28.56
  no locales   error        26.56    27.91    28.43
  en (C)       --version    27.07    27.62    28.30
  en (C)       happy        26.56    27.75    28.36
  en (C)       error        26.63    27.79    28.65
  de           --version    26.77    27.81    28.37
  de           happy        26.73    27.86    28.21
  de           error        26.67    28.11    28.50
  control      node exit    20.31    21.33    21.91
  ```

  All nine inside **0.71 ms** of each other, which is the spread the control
  itself shows -- so the German error path, the only one that reads a catalog and
  renders out of it, is indistinguishable from the no-locales happy path.

  The divergence worth naming is that the design pass had
  `LANG=de_DE.UTF-8 --version` read **no** catalog, because the catalog was to be
  loaded lazily inside `errorHandler()`. Rendering at the call site means
  `main()` loads it before `parse()`, so `--version` on an app that declares a
  locale does read one. Measured at nothing: `import` of a JSON module is about
  0.1 ms because node's own JSON loader does not pull userland `node:fs` in,
  which is the measurement the loader body was chosen on. What has not changed is
  the property that matters -- an app that declares **no** `locales` reads
  nothing, resolves nothing and constructs no `Intl`, which is every app that has
  not asked for this.

- **`demos/i18n/01-translating.js` is where the three halves are shown
  together**, because each one is unconvincing on its own: a reordered slot only
  reads as a point beside the `%s` it replaces, a plural only earns
  `Intl.PluralRules` where a language has more than two forms, and `setLocale()`
  only means anything if you can see what it does _not_ reach. So one screen has
  the German reordering `Copied {0} to {1}`, Polish taking four categories where
  Japanese takes a plain string, and four `setLocale()` calls with nothing
  already printed changing -- which is "translated where it is built" as a thing
  to look at rather than a sentence. Its catalogs are inline objects, which is
  the one place this repo writes a loader that is not a JSON import: a loader is
  a function and may do anything, and a demo that shipped three JSON files would
  be three files to read before the point arrives. The Japanese chrome is
  deliberately absent so that `--help` shows a partial catalog falling back
  whole, and it is drivable by `demos.test.ts` because it needs no terminal at
  all.

- **Fifteen sabotages, fourteen caught, one declared.** Three of the five that
  survived the first run were real gaps and each got the input that makes it
  matter: the first-spelling-wins rule in the loader map, which needs two
  spellings of **one** tag rather than two tags; the no-locales fast path, which
  is observable through `locale()`; and the slot range check, whose test took the
  English fast path and so never reached `fill()` at all -- the vacuous-fixture
  shape, in a test of this feature's own. A fourth was the **sabotage** being
  equivalent rather than the code unguarded: the loader-throw mutation threw from
  inside the `try`, so the catch still caught it, and removing the catch is the
  mutation that bites. The one declared survivor is the English fast path in
  `__()`, which changes no answer -- without it the key is built, the lookup
  misses and the branch below answers with the same `zip()`.

- **The thunk and the default locale added forty more, and all forty are
  caught.** Seventeen over the runtime and twenty-three over the toolchain,
  counted against the shipped tree in one run each rather than summed across
  rounds. Four survived first time and every one was the same shape -- a guard
  whose _reader_ nothing exercised:

  `main()` reading `Schema.defaultLocale` was the sharpest, because that one
  argument is the whole of what makes `"locale": "de"` reach a screen and
  nothing in 355 tests touched it. `generateBin()` passing the runtime down to
  the tree survived because the two defaults agree, so it needed an app whose
  runtime is **not** `@ttylabs/sigil` -- and the claim is real: the entry names
  one runtime, so the tag has to come from the same place. The `sigil build`
  command's one line getting the locale out of the config survived because the
  end-to-end test called `bundleApp()` with it already read, so it needed a run
  through the command itself. And `unwrap()` in `translatedKey()` survived
  because the test for it used the **wrong parenthesis shape**: measured,
  `` (__)`x` `` keeps the parens on the _tag_, which `bindingName()` unwraps,
  while ``(__`x`)`` keeps them on the _value_, which is the only shape this
  unwrap reaches -- so the two are pinned separately now.

  The harness reported six patterns as `PATTERN MISSED` rather than as passes,
  which is the guard this file records it for earning its keep again: three went
  stale when the formatter reflowed `backtick()`'s escape chain onto one line
  each, and the three replacements were generated **from the file** rather than
  written by hand, because hand-escaping a `replaceAll('\\\\', ...)` through a
  JSON cases file is how a pattern comes to match nothing. It also refused a run
  whose reporter did not exist -- `--reporter=basic` is not a vitest 5 reporter,
  so every mutation would otherwise have read as caught.

- **What is deliberately out.** **Number, date, currency and list formatting**,
  on the design pass's measurement: each ICU-backed `Intl` constructor is 4-7 ms
  in a cold process, a quarter of a whole `--version` run, and the framework has
  no number to format -- every number in its own messages is a value the user
  typed, which has to be echoed verbatim, because `Invalid integer:
  9007199254740993` must say that integer and not `9.007.199.254.740.993`.
  **Locale-aware sorting**, at `Intl.Collator`'s +3.87 ms, to buy an ordering
  nobody asked for. **ICU MessageFormat** and any mini-syntax, for one plural.
  **A `--locale` flag**, because a parse can fail before an option is read, so
  the message about `--porx` is exactly the one that needed the locale, and
  making a flag work means a second scan of argv ahead of `parse()` -- a second
  parser that disagrees with the first is worth a great deal more than a flag
  whose job the environment already does. **Translating `Invalid JSON: {0}`'s
  inner half**, which is V8's English and reaches no catalog; the outer frame is
  a key. **Translating argument, option or command names**, which are the API the
  user types -- a localized placeholder is expressible as an option _hint_, which
  is the one of the three that is never typed. **The 139 developer-facing
  errors**: a translated `Expected option choices to be an array` is a bug report
  in a language the maintainer cannot read. **`@ttylabs/cli`'s own output**,
  whose reader is a developer and whose piped form exists so tooling can grep it.
  **Right-to-left layout**, for the reason `large-text.ts` refuses an RTL FIGlet
  font. **Any lazy `.message`**, because a getter that formatted in the current
  locale would answer differently when read twice. **Shipping any locale**, which
  the repo owner decided: no `de.json` anywhere, because nobody here can review a
  Korean catalog and shipping N locales signs the project up to maintain them
  across every release that adds a key. The **prompts** were on this list and are
  the section below: the real question there was the input vocabulary rather than
  the translation, and `argv is API and a keystroke is not` is what settled it.

#### The prompts: the hint is the keys, and argv does not move

SIG-53 left the prompts out and said why -- the real question is the **input
vocabulary** rather than the translation. `src/components/prompt.ts` is where the
strings are, `confirmKeys()` in `src/i18n/index.ts` is the one new mechanism, and
the two width defects it turned up were already wrong in English.

- **argv is API and stays English; a keystroke at an interactive prompt is
  not.** That one line settles the three options SIG-135 offered.
  `transformValue()`'s `yesno` vocabulary reaches a _value in a shell script_, so
  translating the keys "with one deferring to the other" either breaks
  `--force=y` in somebody's CI or makes the accepted set depend on `LANG` -- a
  script whose meaning is a function of the environment. So the parser's
  vocabulary does not move at all and only the prompt's keys gain anything.

  The objection to accepting both -- that the hint becomes an incomplete
  statement of what works -- is the **safe** direction of incompleteness. A hint
  naming a subset is not a lie: `bool` accepts six spellings of true and no hint
  names them. The rule this file keeps is about a hint naming something that does
  **not** work.

- **SIG-53 had already shipped that defect one layer along, and it was the only
  key with the shape.** `Value must be "yes" or "no"` was in the key set, so a
  German catalog says `… "ja" oder "nein" …` and `yesRE` then refuses the `ja`
  the message just asked for. A translator handed that key has nothing telling
  them the quoted words are a vocabulary rather than prose. The quoted literals
  are **slots** now -- the key is `Value must be "{0}" or "{1}"` with `yes`/`no`
  interpolated -- so the quotes stay structural and what is inside them arrives
  as data. The audit for other keys of that shape found none.

- **One catalog entry decides what is drawn _and_ what is accepted, which is what
  stops the two disagreeing.** The entry is `y/n` -- the two keys and nothing
  else -- and the parens and the capital are `confirmKeys()`'s. So there is one
  entry rather than three, a translator has no second place to contradict
  themselves, and the hint is built there rather than parsed back out of a
  sentence -- from the **halves** rather than from the keys, which is the
  distinction the review round below is about. `(Y/n)` in English is byte for byte
  what it was, derived.

  The key for each half is its **first code point**, so `j/n` gives `j`/`n` and
  `ja/nein` gives the same keys while drawing `(Ja/nein)`. A one-character half is
  the degenerate case of that rule rather than a second rule. By code point
  because half a surrogate pair is a key no terminal can send, which is the rule
  `highlightRuns()` already keeps, and `toLowerCase()` rather than the locale
  variant for `camelCase()`'s reason read in this function's own direction -- the
  locale one lowercases `I` to the dotless `ı` in Turkish, so an entry of `I/n`
  would have a key of `ı` there while the reader pressing that key sends `i`, and
  it would stop matching on that machine and nowhere else.

- **The hint is authoritative and English is additive.** `y` and `n` are accepted
  on top of whatever the entry named, and each is dropped where it would
  contradict the entry. A romanized `n/a` has `n` meaning _yes_, as the reader was
  told, so English `n` is refused rather than giving one keypress both answers --
  and the mirror holds, `t/y` refuses English `y`. That precedence is forced by
  the hint being the thing on screen rather than chosen: what a reader was told is
  what has to be true.

- **An entry that is not two halves naming two distinct keys is refused
  outright.** Empty, no slash, three halves, or two halves whose first characters
  are equal: English stands and it says so through `sigil:i18n`, which is the rule
  `__()` already follows for an entry of the wrong shape. Refused rather than
  guessed at, because a hint nobody can read is worse than an English one.

- **The lookup is at the call site and the parsing is in `i18n`, and the split is
  forced from both ends.** `confirmKeys(__`y/n`, fallback)` -- the tag is in
  `prompt.ts` because the key generator deliberately **skips** the i18n module:
  `__` there is a local declaration rather than an import binding, so
  `importBindings()` has nothing to match and a tag written there is a key
  `SIGIL_KEYS` would not carry. Measured: written inside i18n it came out at 51
  keys with `y/n` missing, so `sigil check` would have reported an app's own
  translation of it as an **orphan**. The parsing is in i18n because that is the
  module which already decides whether a catalog entry is usable, and because it
  has the logger -- `prompt.ts` is a `sigil add` entry and may import only what
  the package publishes, and `src/debug/` has no subpath. Exported from the barrel
  rather than written onto the root entry's path, so an app that answers
  `--version` shakes it out -- and _that last clause was false_, which is the shape
  this file keeps warning about: a sentence asserting a property nothing checks.
  `dist/index.mjs` imports `./i18n.mjs` for `__`, and an **entry chunk is not
  shaken per importer**, so everything this barrel exports is on the graph an app
  that answers `--version` loads. Measured: **6,825 bytes to 7,513**, which is
  about 700 for `confirmKeys()` and its helpers, against the 20 kB ceiling
  `test/dist.test.ts` holds -- and the first version of that figure read 648 and
  went stale by 40 bytes within the hour, when the decomposed guard landed, so
  read the ceiling rather than this. Paid rather than avoided, because the alternative is a
  published subpath of its own -- permanent API surface for one consumer -- and
  `prompt.ts` has to reach it through a published subpath whichever module it is in.
  Found by checking the claim rather than by a review.

  `ENGLISH_PAIR` is the same string in two roles rather than one copy too many: at
  the call site it is the key, because the English _is_ the key, and in `i18n` it
  is the floor a malformed entry lands on. A refusal has to name some vocabulary.

- **What is _not_ translatable is the punctuation and the order.** A locale that
  shows no first, or wants fullwidth parens, cannot say so. Making either
  translatable means parsing a sentence to find the keys again, which is the thing
  this shape exists to avoid.

- **A modified key is not an answer.** `k.name` for Ctrl-Y is `y`, so `ch === 'y'`
  read it as yes -- and the hint says `Y` rather than `ctrl-Y`, so that is the
  hint being wrong about what it accepts. Pre-existing, and fixed here because it
  is the same sentence this whole section is about. The rule the key sequences
  already keep: a modifier makes it a different key.

- **A modifier is translated and a key name is not.** `keyLabel()` builds
  `ctrl-d`, and a German keyboard labels that key `Strg` -- so a hint saying
  `ctrl` names a key that is not there. The letter on the cap, and `enter` and
  `tab`, are printed the same on essentially every keyboard sold, so translating
  those would be inventing a vocabulary rather than matching one. Each combination
  is a **whole** key -- `ctrl-{0}`, `alt-{0}`, `ctrl-alt-{0}` -- rather than two
  translatable fragments, so a translator sees the shape and picks the separator
  too, which is `+` in German and `-` here. A key with no modifier is its own name
  and no lookup.

- **`select()` has no hint and keeps none.** Only `multiselect()` does, because
  tick boxes need telling and arrow keys are discoverable. Worth writing down
  because the inventory reads as though one is missing.

- **The inventory was about double what the ticket said**, because SIG-111 landed
  `multiline()` the same day it was filed: twelve keys rather than seven, the
  multiline four and `Choose at least one` and `none` among them, and
  `(+{0} more line)` is the **second plural** the framework has after `Alias:`.
  Three of the five `PromptError` messages are translated and two are not --
  `Cannot prompt for "{0}" …`, `Input ended …` and `Cancelled` are what a _user_
  sees through `errorHandler()`'s own translated `Error: {0}` frame, so a German
  app that cancelled a prompt printed `Fehler: Cancelled`, which is half a
  sentence. A prompt declared with no choices or no submit key is a bug in the
  app, like the 139 developer errors SIG-53 left alone.

- **What is deliberately left English, after an exhaustive sweep.** Every string
  literal reaching a `text`, `textNode` or `textElement` under `src/components/`
  and `src/help/` was read, and after the palette's three there is exactly
  **one** left: the debug overlay's `debug` pane title. It stays, by the rule
  SIG-53 already applied to `@ttylabs/cli`'s own output -- its reader is a
  developer, so a translated one is a bug report in a language the maintainer
  cannot read. Everything else in those components is caller-supplied text or a
  `TypeError` about a programming mistake, which is the 139 developer errors
  SIG-53 left alone. Written down so that the next sweep finds a decision rather
  than an omission.

- **And the keystroke a translated key needs may not be one the keyboard
  sends.** `keyOfHalf()` reads a _code point_, and a decomposed `é` typed as one
  keystroke arrives as two keys -- `readOne()` splits by code point -- so the
  first is the bare `e`. An entry written with a precomposed `é` therefore names
  a key that input method never sends, and normalizing the entry would not fix
  it, because what is decomposed is the keystroke rather than the catalog. A
  catalog writes the pair in the form the keyboard produces, which for a yes-or-no
  key is a plain letter in essentially every language. Recorded rather than
  guarded: the machinery would be a normalization pass over something it cannot
  reach.

##### Reserving the tail's columns, which was two defects in English

The ticket flagged the width question as unmeasured. Measuring it found the head
broken in both directions, neither caused by translation.

- **Reserving nothing clipped the affordance away.** A hint is a flex item beside
  a message with `flex-shrink: 0`, and `headWidths()` reserved exactly **one**
  column for whatever followed -- so a message that took every column left
  squeezed the hint into one and the canvas, capped at the terminal's width,
  clipped the rest. Measured, `? Overwrite the file`: 26 columns drew `(Y/n)`, 24
  drew `(Y/`, 22 drew `(`, and from about 18 to 24 a yes-or-no question had **no
  readable affordance at all**. `(ctrl-d to submit)` was worse -- at 40 columns it
  came out as `(`, `t`, `s` down the right-hand side, one character per row.

- **Reserving the tail in full was the overcorrection.** The multiselect hint is
  35 columns, so at 40 it left `Pick some things` four columns and seven rows of
  two letters. Found by measuring the fix rather than by a test.

- **So neither half of the head gives up more than half the line.** The tail's own
  width is reserved, capped at `floor(avail / 2)`. A short affordance is then
  always whole -- `(Y/n)` down to **13** columns, which the arithmetic predicts and
  a sweep confirms -- and a long one wraps with the message intact. Below 13 the
  closing paren is clipped, and the _vocabulary_ is still on screen, which is the
  residual rather than a fix: at 12 columns nothing is good.

  Both halves clamp with `Math.max(1, ...)`, so at an `avail` of 1 or less they
  sum to more than there is and the row over-commits -- which the canvas clips.
  What has to hold there is only that it is neither an exception nor a loop, and
  that `wrap()` is never handed a width below 1. Round 1 read that correctly off
  the code; it is checked down to **one column** now, an `avail` of -2, and pinned
  rather than reasoned about.

- **And `lines` counts the taller of the two halves, not the message.** It counted
  the message alone, so a hint that wrapped made the head taller than the choice
  window believed and the row reserved for the error line absorbed it -- measured,
  the multiselect head goes 1 to 4 rows at 30 columns while `lines` answered 1.
  With the tail reserved it does not normally wrap and the message decides; where
  it does, the tail is what decides. One expression rather than a second
  mechanism, and it is the same change that fixed the clipping.

- **Nothing about `text()`, `password()` or `select()` moved**, and that is
  measured rather than read off the code. By construction each passes no tail,
  `Math.max(1, 0)` is the `- 1` that was there, and `rest` is the same number it
  was -- and "by construction" is exactly the kind of claim this file records as
  unestablishable by tracing the route you had in mind. So the six prompts were
  rendered at nine widths on `main`'s source and on this one and the frames
  diffed: **`text`, `password` and `select` are byte-identical at every one of
  the nine**, and nothing at all changes at 60 or 80 columns. What moves is
  `confirm` at 30 and below and `multiline` and `multiselect` at 40 and below,
  which is the defect and nothing else.

  The three changed blocks are each the improvement rather than a different kind
  of bad. `confirm` at 30 goes from `(` to `(Y/n)`. `multiline` at 40 goes from a
  hint split over two ragged rows to one whole row with the message wrapping
  instead. And `multiselect` at 40 gets _shorter_ -- a four-row hint column
  becomes two, so the head is 2 rows where it was 4. The 76 cases in
  `prompt.test.ts` pass unchanged besides, which is the check an extraction gets.

- **What it cost was one fixture, and the reason is worth keeping.** A palette
  case asserted `/Invalid integer: eight/` against a 60-column frame; the message
  wraps for the submit hint now, and the hint sits _between_ its two halves on
  screen -- which no row-major read can reassemble, whatever it does to the
  whitespace. Collapsing whitespace was tried first and does not work. The claim
  there is that the complaint is the parser's own, so the fixture is a width that
  can show one.

> Moved: _What walking the hostile inputs found, which no test had_, _What the sabotage pass found_, _What the second review round found, and it was all prose but one_, _And the harness left a mutation in the tree, which is a trap of its own_, _What the first review round found, and the one thing it got wrong_ — see [docs/history/translating-the-english-is-the-key.md](../../../../docs/history/translating-the-english-is-the-key.md).
