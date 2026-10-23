# `packages/sigil/src/config` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### A layered config module: one merged view over an ordered stack

SIG-148 is the **read** half. `src/config/` is the whole of it: the layer stack,
the merged read, dotted paths, the schema, `.json` and `.jsonc` reading, and the
`ConfigStore` interface three other tickets are blocked on. Writing a file back
without destroying it is SIG-154's.

- **This is not oclif parity, which is the thing to know first.**
  `this.config` in oclif is CLI _metadata_ -- `configDir`, `cacheDir`,
  `platform`, `plugins`. Its own documentation says oclif "does not provide
  built-in mechanisms for loading, merging, or saving user configuration files"
  and demonstrates reading a `config.json` with `fs-extra` in a base class, and
  the feature request asking for precisely this layered merge is **closed as not
  planned** (oclif/oclif#136). The ecosystem answer is cosmiconfig, which is a
  dependency. So this is a differentiator rather than a gap, and a better one
  than the component runtime in one respect: every CLI with settings wants it,
  where only some want a TUI.

- **Core does not load config, and does not accept one either -- which reverses
  an earlier decision taken here.** The first design made config a third source
  inside `applyFallback()`'s chain -- argv, environment, config layers, the
  option's `default` -- on the argument that this repository writes every
  precedence chain out as a single chain. That is withdrawn. **Options and config
  settings are separate, and the app decides how to mix them.**

  They are not the same kind of thing. An option is something a user types for
  one run; a config setting is something that persists. Coupling them means every
  option wants a config key and every config key wants an option, and neither is
  true -- most config settings have no flag, and most flags have no business
  being persisted. And the mixing an app actually wants is one line, in either of
  two spellings, neither of which needs anything from core: `argv.port ??
  config.get('server.port')` inside `run()`, or `default: config.get(...)` at
  schema-build time, which gives argv then env then config through the chain that
  already exists. The second works _because_ core does not load config, so the
  app has one before it builds its schema.

  What that deletes, none of it missed: discovering a config file, a `--config`
  in every app's namespace, a naming convention -- `--config <path>` in eslint,
  prettier, webpack, rollup and vite, `--config-file` in babel, a **directory**
  in docker, `KEY=VALUE` **or** a path, repeatable, in cargo, a path **or** a
  JSON blob in jest -- deciding what a `--config` does to the layer stack, and
  answering what happens when somebody passes both a file and a blob, which once
  the app owns it is not a conflict at all but two layers. Every one of those was
  a question only because the framework was going to own the flag. This is the
  opposite call from `--help`, `--version` and `completion`, and the distinction
  is sharp: those three the framework can answer identically for every app, and
  this it cannot.

  What is given up, stated plainly: there is no automatic "this option falls back
  to this config key."

- **It imports no parser module at all, and that is a test rather than a
  coincidence.** Measured as transitive static import byte weight off `dist/`,
  at the time: **38,064 B over seven modules**, of which **9,880 B over six** is
  what it starts from -- `paths.mjs`, `i18n.mjs`, the `transform` and `debug`
  chunks, the 66-byte `env-value` chunk the parser shares, and the 525-byte
  `mkdir-owner-sync` one the update cache shares. So the module itself was
  28,184 B, and the graph **5.09x** the root entry's 7,518 B and a **sixth** of
  `components.mjs`'s 240,792 B over 27 -- all three measured the same way, which
  is the only comparison that means anything. It was
  **20,649 B over six** before SIG-154, which is the write half costing about
  11.5 kB, **32,523 B** before SIG-149's store kit, and **32,625 B** before
  SIG-153's watcher, which is 5,439 B and no new module. Re-derived after every
  change that moved it: a figure only a re-run can confirm is the stale snapshot
  this file warns about -- and a running tally of how many times is a second
  such figure, which is why there is no longer one. The two copies of that tally
  had drifted to five and six, two lines after the sentence warning about
  exactly this. The shape the ticket's own projection predicted, even though its
  figure was the starting point rather than the total. `should not reach any
  parser module to import the config module` holds it, keyed on symbols the
  minifier keeps.

  The reverse direction is the ticket's own ask in as many words -- "nothing in
  `main()` or `parse()` loads or accepts a config, and a test that says so" --
  and it is a pair rather than an absence, for the reason every pair in
  `dist.test.ts` already gives. Which cost a round: the first markers included
  `mergeLayers`, a name that is only ever _called_ and is therefore in no bundle
  at all, so the absence half passed while saying nothing. The presence half
  failed immediately, which is what the presence half is for.

  Sabotaged by appending `export * from './config/index.js'` to `src/index.ts`:
  **five** assertions fail -- the four absence halves, and the root entry's own
  20 kB ceiling, which 10.7 kB of config walks straight through. The first
  version of this entry said ten, from a `grep -c` that counted vitest's two
  lines per failure rather than the failures, which is the stale-figure hazard
  this file keeps recording arriving in its own measurement.

- **Titanium's `--config-file` pattern works and core is not involved in
  either half.** `titanium-cli`'s `initGlobals()` declares `--config-file [file]`
  and handles it with Commander's `on('option:config-file')`: `this.config.load(
  file)` and then `loadCustomCommands()`, which reads `paths.commands` from the
  **reloaded** config and registers what it finds -- so there, `--config-file`
  really does change the command tree, which an earlier draft of this analysis
  asserted was impossible and was wrong about. A sigil app does both: the first
  load shapes the tree, because the app loads config before building its schema
  and puts `paths.commands` into `schema.commands`, which is what
  core-not-loading _buys_ rather than prevents; and the reload is a `parse` hook,
  which fires inside `parseArgv()` and is handed the registries, so
  `commands.add(await initCommand(...))` takes effect immediately.

  Two things are true of the reload that are not true of Commander's. It is
  **positional** -- `mycli --config-file x build` can see the option in
  `state.$` and `mycli build --config-file x` cannot, which is the same shape as
  the recorded limitation about a subcommand's option used before its
  subcommand. And it **does not survive `sigil build`**, which reads `commands`
  statically off the entry, so an app computing it from config gets the "there is
  one I cannot read" diagnostic `readAppCommands()` already produces. So
  config-driven command paths are an unbundled feature, and the build says so
  rather than silently disagreeing.

#### The store interface, and the two refusals that are two shapes

- **`ConfigStore` is public API rather than an internal seam, which is why it is
  drawn whole here and not left to fall out of whichever store was written
  first.** The reason is about **variance** rather than about version numbers.
  Both packages are at `0.0.1` and `0.y.z` carries no stability guarantee, so
  nothing here is locked today. What makes an interface the expensive thing to get
  wrong is which way the obligation points: adding an optional parameter to a
  function **callers** use is backwards-compatible, while adding a required method
  to an interface **implementors** write is breaking for every one of them and
  cannot be softened by a default. So the cost of being wrong is paid by somebody
  else's package, and it is paid at 1.0. Drawing it whole now is cheap; drawing it
  twice is not.

- **`read()` and `readSync()` are both required, and that is what dropping the
  `.js` layer buys.** Two earlier shapes were wrong in opposite directions and
  both are recorded so neither comes back. The **first** made `read()` required
  and had a synchronous store write `async read() { return this.readSync(); }` --
  a store lying about itself to satisfy a signature, which defeats the point of
  the interface. The **second** made both optional with the presence of
  `readSync()` as the capability, which moved the lie into a **ternary at every
  call site**: `store.readSync ? store.readSync() : await store.read()`. Honest,
  and it leaks into every caller that ever grows one.

  Both existed to accommodate exactly one store kind -- `.js`, where `import()`
  leaves no choice. With that layer gone and an object layer in its place every
  store can do both, so both are required and the problem evaporates: no
  optionality, no union, no ternary, no wrapper. And the two methods are **two
  real implementations** over one shared parse rather than one wrapping the other,
  which is what `file.ts` does: two different I/O calls, one `parse()`. A
  third-party store that genuinely cannot do sync -- a remote one -- throws from
  `readSync()` with its own message saying so, which is strictly better than the
  optional shape: the failure is localized to the store that has it and worded by
  the author who knows why, and **no caller branches**.

- **Will not write is a separate interface; cannot represent this value is a
  predicate.** A read-only store is a `ConfigStore` and a writable one is a
  `WritableConfigStore`, so read-only is something TypeScript enforces and
  `isWritableStore()` narrows, rather than a method that throws at run time.
  `canRepresent()` is the other refusal and it is **synchronous on purpose**,
  because `set()` is: a value the format cannot hold is refused at the call that
  wrote it, naming the layer and the format, rather than discovered by a `save()`
  in an exit handler. TOML is the case that proves the second is needed -- it has
  no `null` at all, in 1.0 or in the newly released 1.1, with the question
  deferred to 1.2 or later -- so "I am read-only" and "I cannot hold that" are two
  answers, and an interface with only the first makes the second surface as a
  corrupt file.

- **`ConfigLayer.readOnly` is the _other_ read-only statement, and both are
  real.** The store's says "this format cannot be written"; the layer's says
  "this one is not mine to write" -- an `/etc` file an app reads and must not
  touch, whose store could write perfectly well. One mechanism for each, because
  they are different sentences, and writability is `!layer.readOnly &&
  isWritableStore(store)`.

- **`ConfigStore.source` is on the interface because the `delete()` message
  needs two paths.** The ticket drew the interface with `format` alone, and the
  message it specifies -- "Set it in ~/.config/app/config.jsonc to override the
  value, or remove it from /etc/app/config.json" -- names the path to write
  instead and the path to edit by hand. A layer's _name_ is what the app chose to
  call it, which is not a file a user can open. An optional readonly property is
  free for implementors to add later, so this is cheap either way; it is here
  because drawing it now is cheaper than drawing it twice.

- **`write()` and `writeSync()` are declared here and have no caller, and
  `wouldLose` has no producer in core.** Both are deliberate and each is the
  shape this file already records twice: a property with no reader is dead, and a
  property with no **producer** is a contract -- `Schema.routeInfo`'s own entry.
  `save()` is SIG-154's, so `write()` is the contract SIG-149 and SIG-152 are
  blocked on; `wouldLose` is **absent** for a store that edits spans even over a
  comment-rich file and populated by one that reprints, which is what a YAML or
  XML store will fill. It is given a **reader** so it cannot go quiet:
  `config.layers` carries it per layer.

  The file stores were therefore `ConfigStore` rather than `WritableConfigStore`
  in that ticket, which is the clean line the split falls on; they are
  `WritableConfigStore` since SIG-154, and `write()` has a caller. A _reprinting_ JSON
  writer here would destroy the comments a `.jsonc` file is read for, which is
  exactly what SIG-154's span writer exists to prevent -- so there is no file
  write until there is a correct one, and `object()` is what gives `set()`,
  `delete()` and the array methods a real writable layer to target. An app whose
  only layers are files gets `No writable config layer`, naming the
  `object()` layer on top, which is the in-memory override every other answer to
  that reduces to.

#### The object layer, which is what replaces `.js`

- **A `.js` config is the popular shape and reading one is the only thing in this
  design that cannot be done synchronously**, because `import()` is async and
  there is no synchronous ESM loader. One store kind was forcing the entire
  interface to carry optional methods, so it is dropped and an **object layer**
  takes its place: a store constructed over a plain value the app already has.
  **Nothing is lost in capability**, only in convenience -- and what the app gains
  in exchange is control over _how_ its module is loaded: TypeScript, with
  arguments, conditionally, or not at all.

  It also moves the ESM module-cache problem to the app, which is the only party
  that knows whether it cares: a `.js` layer could never be reloaded, because the
  loader caches a module for the life of the process and a cache-busting query
  string leaks one per reload. An app that wants to re-import with a buster may;
  that is its leak and its decision. SIG-153's "`.js` layers are not watchable"
  rule retires with the layer kind.

- **`object()` with nothing handed in is the in-memory layer**, which is the
  runtime override: a run that overrides a setting for its own duration and
  persists nothing. One store rather than an `object()` and a `memory()` that are
  the same thing under two names, which is the drift this repository refuses
  everywhere.

- **`apply(layer, value)` replaces a layer's content, and that is the decision
  rather than a default.** It is the same mechanism as construction after
  construction, which is what a reload is. A merge _inside_ a layer would be a
  second merge semantics sitting beside the cross-layer one, and the two would
  then need to agree about depth and about arrays -- where the cross-layer merge
  already has an answer. And it is unnecessary, which is the better half of the
  argument: **two objects that should merge are two layers.** The stack _is_ the
  merge, it already works, and it already has the array rule. It is allowed on a
  **read-only** layer, because re-reading one is not writing it -- which is what
  makes it a reload rather than a write.

#### The one precedence chain

- **A setting's environment variable, then the layers from last to first, then
  the setting's `default`.** Written out as a single chain, which is the form this
  repository keeps for every precedence rule it has. The environment is on top
  because a variable is a statement about one run and a file is a persistent one,
  which is the same reading argv gets against the environment one layer up; the
  default is underneath everything because it is what the app ships rather than
  what anybody configured.

  Both are **materialized into the merge** rather than consulted on a miss, so
  that `get('server')` holds a defaulted `server.port` and there is one object to
  read. Making them synthetic _layers_ was the other candidate and was refused
  over the name collision it creates: the ticket's own example declares an app
  layer called `defaults`, so a synthetic one would need a reserved spelling and a
  rule about which names an app may not use.

- **The environment is read once, at construction.** A `get()` that re-read it
  would be a different answer to the same question at two moments, which is the
  parser's answer too -- it reads `state.env` at parse time. `ConfigOptions.env`
  is how a test asks what a variable does without setting one on the process every
  other test in the worker shares, which is the reason `ParseState.env` is an
  option.

- **`envValue()` moved to `src/util/env-value.ts`, because there are two readers
  now.** The parser's rule is `if (state.env[env])`, so `''` is skipped while
  `'0'` and `' '` are returned -- only the empty string is falsy among the values
  a variable can hold. Config reads it **from the same place** rather than
  reimplementing it, because a config setting declaring `env` and an option
  declaring `env` disagreeing about what `PORT=` means is the two-readers-of-one-
  question drift this file has half a dozen entries about. `parse.ts` calls
  `envValue(state.env, envs)` now, and what the function asks is the same
  comparison it always asked -- only the parameter it reads it off moved.

- **The file's own version of that rule: a key absent and a key set to `null`
  are both "not configured"; a key set to `""` is an empty string.** Which is the
  `--port=` side of the same question. A `null` at a setting's path is
  **removed** rather than validated, and that is not tidiness: left in place it
  would be a _value_, and a value replaces the layer under it -- so a user writing
  `"theme": null` would be shadowing the default to `null` rather than falling
  back to it.

#### The schema is config's own, and shares the parser's types

- **A config setting is declared in the parser's own type vocabulary** --
  `type`, `choices`, `multiple`, `default`, `env` -- and validated with
  `transformValue()`, `checkValue()` and `assertChoices()`, which are the most
  heavily tested code in the repository. Three obvious answers were build a
  validator, inject one, or drop the feature; this is the fourth and it is better
  than all of them. What it buys: zero dependencies, which is the hard
  constraint; no new grammar; and a config setting and an option that happen to
  cover the same thing **cannot come to disagree about what `on` means**, which
  is the precise drift the `bool` entry is written about.

  What it does not give is nested object shapes, whole-subtree requiredness or
  `oneOf`. For CLI config that is probably not missed, and saying so is better
  than a half-built JSON Schema. The toolchain's own migration is where that line
  shows: `build.external` is typed by the schema and `build` itself cannot be, so
  "build must be an object" stays in `packages/cli/src/config.ts`.

- **A path the schema does not declare is left exactly as it arrived.** The call
  `allowUnknownOptions` already makes for argv: a config file legitimately holds
  things this app's schema has nothing to say about -- a plugin's own settings, a
  key a newer version reads -- so the schema is a partial typing over a free-form
  document rather than a closed shape. What that gives up is a typo being caught,
  and saying so is better than refusing a file somebody's plugin wrote half of.
  There is deliberately no `strict` option, because nothing has asked for one.

- **A setting whose path runs through another setting's is refused where the
  schema is read.** `server` as a `json` object and `server.port` as an `int`
  would each validate the other's value, so it is refused rather than resolved by
  a precedence nobody would remember.

- **`checkValue(value, type)` sits beside `transformValue()`, in the same
  file.** `transformValue()` turns a **string** into a value, which is the wrong
  function for the only source this module exists for: a JSON or YAML file hands
  back `true`, `8080` and `{...}` already typed. Measured on the parser's own
  `default` path, which is the closest existing analogue, on a `--port [n]`
  declared `type: 'int'`: `'8080'` lands as the number 8080 and `'yes'` throws,
  while `true` and `{"a":1}` pass through **untouched**. For a `default` that is
  deliberate and is recorded -- "non-string defaults pass through untouched",
  because the author wrote it in code in the right type. A user's config file is
  not that.

  A **string** is handed straight to `transformValue()` rather than being
  refused, and that is the decision rather than a convenience: it is what makes
  an all-strings format work at all, since XML has no other scalar kind, and it is
  what stops `--shake=off`, `SHAKE=off` and `"shake": "off"` meaning three
  different things. So there is **no flag on `ConfigDocument`** saying which kind
  of store a value came from, which the ticket's "XML needs `transformValue()`,
  YAML needs `checkValue()`" framing would otherwise have needed: one function
  answers both, and the interface the ticket drew stands unchanged.

  What that cost the toolchain's own migration is one strictness: `"sourcemap":
  "false"` used to be refused and is now coerced. The old reason was that
  coercion invents a setting nobody chose, and `transformValue()`'s vocabulary is
  strict and symmetric -- `false/f/no/n/off/0/''` and `true/t/yes/y/on/1`,
  anything else throws -- so there is no silent wrong answer available. Three
  readers agreeing is worth more than that refusal.

- **What a `default` does is `applyFallback()`'s behaviour, measured on a real
  parse rather than read off the code -- and two of the three answers are not
  what "non-string defaults pass through untouched" predicts.**

  | a `default` of | on an option declared | lands as                       |
  | -------------- | --------------------- | ------------------------------ |
  | `'a'`          | `multiple: true`      | `['a']` -- **wrapped**         |
  | `['a']`        | `multiple: true`      | `['a']`                        |
  | `'z'`          | `choices: ['a', 'b']` | **throws** `Invalid value "z"` |
  | `8080.5`       | `type: 'int'`         | `8080.5` -- untouched          |

  All three are kept, and the first version of `defaultsOf()` had two of them
  wrong: a scalar default on a `multiple` setting was left a scalar, so
  `get('plugins')` answered `'a'` where a list was declared, and a default
  outside `choices` was never checked at all. A string is coerced and a
  non-string is not, which is the recorded rule; a non-array is **wrapped**,
  because a declaration can only write one value and the wrap is what makes the
  shape not depend on how many were written; and `choices` is checked, because a
  `default` is a producer and the rule is that a value is validated by whoever
  produced it.

  A non-string default is deliberately **not** type-checked, which is the one
  place this is looser than it could be and is the one of the four that was
  already right. Diverging would make the two declarations disagree about a value
  written in code, and the reason it is defensible is the recorded one -- the
  author wrote it in the right type, and a config schema is as much the app's own
  source as an option declaration is. Measured rather than assumed, which is how
  the other two were found.

- **Every refusal `checkValue()` makes is one of the parser's own keys, with the
  **value** through the slot rather than a word for its kind.** The first version
  wrote `Expected an integer, got ${describe(value)}`, which puts the English
  words "a number" through a slot -- and the i18n work already records that as
  the wrong shape, because a translator needs the whole sentence and `Invalid
  {0}: {1}` with a noun in the first slot is a sentence they cannot write. So it
  reuses `Invalid boolean: "{0}"`, `Invalid integer: {0}`, `Invalid date: "{0}"`,
  `Invalid number: {0}`, `Value must be "{0}" or "{1}"` and both
  too-large-to-be-exact keys, and costs **one** new key -- `Invalid string: {0}`,
  new because argv hands over nothing but strings so the parser never had to
  refuse a non-string for a `string` option.

  `show()` is what makes the slot readable, and the one value kind whose JSON
  **lies** about it is a `Date`: `Date.prototype.toJSON` answers `null` for an
  invalid one, so `JSON.stringify(new Date(NaN))` is the string `"null"` -- a
  message about a date that says nothing about a date. `String()` answers
  `Invalid Date`, which is the one thing a reader needs to see. Found by a test
  rather than by reading.

- **`DATA_TYPES` is one list where `init-arg.ts`, `init-option.ts` and a config
  schema each had their own.** Exact membership rather than a pattern, which is
  what the anchoring entry was reaching for all along: `/^auto|bool|...|yesno$/`
  bound the alternation looser than the anchors, so any string merely
  _containing_ one of the middle names passed. A `Set` cannot be got wrong that
  way. Two sets because the vocabularies really differ by one -- an option may be
  a `count` and an argument may not, and neither may a config setting, because a
  counter is a thing argv increments and a config file has nothing to increment.
  `should name only types the coercion branches on` is the guard, and its table
  has to cover the list exactly, so a type added without a probe is the hole
  again.

- **`assertChoices()` moved out of `parse.ts` for the same reason**, and the
  oddity it carries is why it is worth sharing rather than copying: membership is
  `includes()`, which compares a `Date` and an object by **identity**, so a
  `choices` list of either is a declaration no value can satisfy. That is true of
  a command line as well, and it is exactly the kind of property a second copy
  quietly disagrees about.

- **A scalar where a `multiple` setting was declared is refused rather than
  wrapped, and an environment value is wrapped.** Those are two answers to one
  question and both are right: the parser wraps an environment value because argv
  and the environment can only hand over one value at a time, and a _file_ can
  write a list -- so a scalar there is a mistake worth reporting.

#### Sync accessors, async at load

- **`get()`, `set()`, `has()`, `delete()` and the four array methods are
  synchronous; `createConfig()` is async and `createConfigSync()` sits beside
  it.** What could force an async accessor was enumerated rather than assumed:
  reading a file (no -- `readFileSync` exists and three modules here already use
  it), parsing (no), loading a store from a sibling package (no -- that is the
  _app's_ static import, resolved before any of this runs), a store's own
  `read()` (**yes**, for a remote store somebody else writes), a store's own
  `write()` (**yes**, which is why `save()` is), creating a layer lazily on first
  `set()` (refused, below), and watching (a callback, so it does not reach this
  question). So the async is at load and at save, and **an async `get()` would be
  a promise per read of data already in memory.**

  An earlier draft leaned hardest on the parser -- `applyFallback()` and
  `envValue()` are plain synchronous functions and `processOptions()` contains no
  `await` at all, so config-as-a-fallback-source had no asynchrony available to
  it. That is still true of `processOptions()` and is now **irrelevant**, because
  config is not a fallback source. Recorded so it is not cited later as though it
  still carried weight.

- **Lazy layer creation is the one thing config-kit's async buys, and it is
  refused.** A `set()` targets a layer that is already **registered**, and
  registration is `createConfig()`'s -- which is where the async is. The _file_
  need not exist: `save()` creates it and `mkdirOwnerSync()` creates the
  directory. So the reason config-kit forces async does not arise here, because
  this design registers layers up front rather than conjuring one on a write.

- **The two entry points are two real implementations of one loop, and the
  shape that looked obvious is a bug.** `createConfigSync()` cannot be written in
  terms of the async one: `then()` runs on a later microtask whatever the promise
  holds, so a synchronous entry point that awaited an already-settled promise
  would not be synchronous. The first version did exactly that -- `void
  buildLayers(...).then((built) => { layers = built })` followed by a check that
  `layers` was filled -- which **always** threw. One shared `layerOf()` between
  them is the honest split, which is the same two-real-implementations rule the
  store interface asks of every store it describes.

- **`createConfigSync()` is withdrawn from an earlier refusal, and the caller is
  better than a preference.** The earlier draft refused both sync entry points on
  the rule `which` waited eighteen months on -- real surface for no caller. An
  exit or signal handler **cannot await**, which is the same reason
  `Terminal.syncRestore()` exists, and "read the config on the way in and write it
  on the way out" is that shape exactly. Every core store implements both halves,
  so all four entry points work and nothing branches. `.js` was the one layer kind
  that could not, and it is gone.

#### The merge, and what it owns

- **The merged view is structure this module owns, and sharing one sub-object
  with a layer was a real bug.** `mergeInto()` answered with `over[key]` by
  reference wherever the base lacked the key -- so the merged view held a layer's
  own nested object, `deepFreeze()` then froze **the layer**, and the next
  `set()` on it threw `Cannot delete property 'c' of #<Object>`. Found by a test
  rather than by reading, which is why it is written down. Everything that comes
  from `over` is copied now; `base` needs no copy, because it is either the first
  copy or the result of a previous step.

- **The merged view is deeply frozen, and that is the call every initial value in
  the property table already gets.** It is a computed value an app holds a live
  reference to until something recomputes, so mutating it would change what a
  later `get()` answers while changing no layer -- a value with no writer, which
  is the parser's own phrase for the same shape. Freezing makes the mistake loud;
  `structuredClone(config.get('x'))` is the mutable copy.

- **Only the structure is copied and only the structure is frozen.** A `Date`, a
  class instance, a `Map` and a function are leaves carried by reference, which is
  what lets an object layer hold a plugin -- the thing a `.js` config was _for_.
  `structuredClone()` is the obvious alternative for the copy and **throws on a
  function**, which is exactly the case this has to serve. And freezing a `Date`
  an app handed in, or a function, would be freezing somebody else's object on the
  way past.

- **A plain object is one whose prototype is `Object.prototype` or `null`, and
  everything else is a leaf.** Merging into a class instance makes no sense --
  what would the result be an instance of -- so the structure this module owns is
  plain objects and arrays, and `copyValue()`, `mergeInto()` and `deepFreeze()`
  all ask the same `isPlainObject()`. One definition, because two would be two
  answers about what the merge and the freeze are each walking.

- **Arrays replace by default and `merge: 'concat'` is opt-in per key.** Replace
  because it is the less surprising of the two -- a user writing `exclude: [...]`
  in their own file means "this is my list", not "append mine to whatever
  shipped" -- and because concat has no ordering or de-duplication story without
  further decisions, so defaulting to it imports those decisions silently.
  `concat` is asked **by path** rather than by value, which is what keeps the two
  array rules one decision the schema makes rather than a guess at what the values
  look like; it concatenates bottom first and does not de-duplicate.

- **`push` appends to that layer's array rather than to the merged one**, and
  that is the array rule said once rather than twice: with `merge: 'concat'` it
  reads as appending to the merged list, and with the default `replace` it appends
  to that layer's own list, which then replaces what is underneath. Seeding from
  the merged value would copy a lower layer's values into this one, after which a
  change to the defaults never reaches the user again.

- **One value per call rather than a variadic list**, so that every mutator has
  one shape: a path, maybe a value, maybe a layer. A trailing layer name and a
  trailing string value cannot be told apart, which is what rules the variadic
  form out -- and one shape for all six is worth more than the convenience.

- **A mutator with no layer named writes to the topmost writable layer.** The
  stack is ordered and the top is what wins, so writing to a lower one means
  `get()` does not change -- a mutation that looks like it did nothing.

- **A mutation validates the whole layer rather than the setting at its own
  path, and the narrower version was a hole in both directions.** A path can be
  _inside_ a declared setting or _outside_ one declared under it, and a pass that
  asked only about `parts.join('.')` missed both. Measured rather than reasoned:
  with a schema of `{ server: { type: 'string' } }`, `set('server.port', 1)` left
  `{ server: { port: 1 } }` on the layer, which `createConfig()` over a file
  holding the same thing refuses outright; and with `{ 'a.b': { type: 'int' } }`,
  `set('a', { b: 'nope' })` put the string on an `int` setting. Either way a
  `set()` could leave a layer in a state the load path says is impossible, which
  is the worst shape a validation hole has -- the next run of the same app over
  the same file refuses to start.

  So there is **one** validation pass and `apply()` already ran it, which makes
  this hole-free by construction rather than by a rule about which settings a
  path touches. What it costs is a path read per declared setting per mutation,
  which for a config is a handful of lookups. Restoring the one path is enough
  even though the pass rewrites every setting it validates, because
  `coerceSetting()` is **idempotent**: a coerced value coerces to itself, and a
  `null` that was dropped is absent on the second pass -- so a run that threw
  part way through has changed nothing but the path being put back. Found by
  self-review, and `settingAt()` went with it, because a function with no reader
  is dead.

  What that does **not** do is constrain an undeclared parent: `a: [1, 2]` with
  `a.b` declared leaves the array alone and reads `a.b` as absent, because a
  config schema has no nested object shapes. Which is why the toolchain keeps its
  own "build must be an object", and is pinned so that the absence is a decision
  rather than an accident.

- **A refused mutation puts the layer back, and back to what was there rather
  than to nothing.** The rule `Show` and `For` already keep about a branch that
  threw. Deleting where there was nothing rather than writing `undefined`, because
  `deletePath()` prunes the objects the write made on its way down -- without
  which a refused `set('a.b.c', ...)` leaves `{ a: { b: {} } }` behind, and an
  empty object is a difference the merged view can see.

#### `delete()` on a key in a read-only layer: throw

- **Not a tombstone.** The fatal objection is that TOML cannot represent one, and
  there are two more: a tombstone is a new value concept **every** store must
  support, and it needs a sentinel that can collide with a `null` the user wrote
  in a file. The useful half already works without it -- `set(path, value)` on a
  writable layer **shadows** a read-only value -- and what cannot be expressed is
  shadowing to _absent_, which is the limitation to document rather than to invent
  a mechanism for.

- **It throws only for a read-only layer, and a `default` or an environment
  variable still answers after a delete.** Those two have the same confusion --
  delete it and `get()` still answers -- and including the environment would make
  `delete()` throw over an unrelated variable, breaking a legitimate "clear this
  from my config file". A default is not something you delete; it is what you get
  when nothing is configured.

- **It throws only where the writable layer has nothing at that path.** Where it
  does have something the delete works, and `get()` then answers from the
  read-only layer -- which is the merge rather than a surprise.

- **The message is one key, not three.** `Cannot delete "{0}": it is set in {1},
  which is read-only.\n  Set it in {2} to override the value, or\n  remove it from
  {3}.` -- a sentence per line would hand a translator three fragments and no way
  to reorder them, which is what the suggestion work already refuses.

#### A dotted path setter is where prototype pollution lives

- **`__proto__`, `constructor` and `prototype` are refused at both doors.** A
  path segment, and a key anywhere in a document. Those are the two places a
  hostile key can **enter**: `set('__proto__.x', 1)` on a plain object goes
  through `Object.prototype`'s own accessor and changes the target's prototype
  rather than writing a property, and `set('constructor.prototype.x', 1)` is the
  same attack two steps along -- with a path that can arrive from a file in a
  repository somebody cloned. Past the doors nothing internal can be handed one,
  so the ordinary assignments need no second check, which is the whole reason the
  guards are at the entrances.

  `prototype` on its own is harmless and is refused anyway, because the set is
  easier to be sure of than the reasoning about which two of the three are the
  live ones.

- **A file that holds one is refused rather than carried through.** `JSON.parse`
  puts `__proto__` on an object as an own property rather than through the
  accessor, so a file holding one is read without incident -- and then the first
  `Object.assign({}, config.get('x'))` an app writes triggers the setter. Refused
  rather than skipped, because a file that holds one is either a mistake or an
  attack and in both cases the app should not start quietly.

- **An inner empty segment is refused too**, which is a different thing from an
  empty path: `get()` with nothing is the whole merged view, and `a..b` is a path
  somebody got wrong rather than a key called `''`.

#### JSONC strips rather than parses

- **The JSON value grammar is `JSON.parse`'s and this scans only for what JSONC
  adds.** The obvious shape is a JSON parser that happens to allow comments, and
  it is the wrong one: `JSON.parse` is the reference implementation of that
  grammar -- `-0`, `1e400`, a surrogate pair written `😀`, the exact set
  of legal escapes -- and a second one here would be a second grammar to get
  wrong in a way nobody notices until a number comes back slightly different. So
  a comment and a trailing comma are each replaced with a **space**, every newline
  is kept, and what comes out is ordinary JSON at the **same offsets** -- so
  `JSON.parse`'s own message still points at the character it was about, and
  SIG-154's span editor works over the original text with this same scan.

- **A `.json` reports a comment rather than letting `JSON.parse` meet it.** That
  is the one thing this adds over calling it directly: `Comments are not allowed
  in <path>, on line 2` is a sentence somebody can act on, where `Unexpected token
  /` is one they have to work out. Same for a trailing comma.

- **A leading byte order mark is blanked rather than trimmed.** An editor writes
  one and `JSON.parse` refuses it, and it is not a character the document holds --
  blanked so that every offset after it still means what it meant.

- **Not JSON5, and the list is explicit.** No single-quoted strings, no unquoted
  keys, no `+1`, no hex, no `NaN`, no bare fractions. This is the flavour
  `tsconfig.json` and VS Code's settings are written in, which is what people mean
  by a `.jsonc`, and widening it would be inventing a dialect other tools cannot
  read.

- **The scan is fuzzed differentially, and the fuzzer is what found the one
  nesting case.** `fuzz.test.ts` generates a value, re-prints it as JSONC with
  comments and trailing commas scattered through it, scans that and requires
  `JSON.parse` of the result to deep-equal the value it started from -- plus the
  two properties the strip rests on, that the output is the same length and has
  the same number of lines. 400 seeds, with the corpus counted: a run that never
  met a comment or a trailing comma is a green test about nothing, which is the
  rule the composite fuzzer records.

  It earns its keep rather than corroborating. Five sabotages were caught by the
  hand-written cases and the fuzzer alike -- not skipping strings, not resetting
  the pending comma on a value, blanking a newline, resetting it on a comment,
  and blanking the brace instead of the comma -- and a sixth, **not closing the
  pending-comma window on a `[` or a `{`**, was caught by the fuzzer and by
  nothing else. `[1, []]` is the shape: without the reset the inner `]` finds the
  _outer_ comma still pending, blanks a real separator, and the document stops
  parsing. It has a named test now, because a seed is a worse thing to read than
  a case -- which is the rule the layout fuzzer's own entries already keep.

- **A document whose root is not an object is refused where it was read.**
  Merging `42` or `[1, 2]` would make every key of every layer below it vanish, so
  it is refused rather than discovered as a missing setting later.

- **A file that is not there, and a file holding nothing but whitespace, both
  read as an empty document.** The first is the ordinary state of a config file --
  an app ships defaults and the user has written nothing yet -- which is the call
  `readSigilConfig()` already made. The second is because `JSON.parse('')` is a
  syntax error, and reporting one over `touch config.json` would be refusing to
  start over an empty file. **`EISDIR` is deliberately not in that set**: a path
  naming a directory is an app pointing at the wrong thing, and answering "there
  is no config" for it is the silence that costs an afternoon.

- **The path is expanded through `paths.expand()` rather than taken literally.**
  A `~` is the single most likely thing an app writes by hand, and
  `readFileSync()` of one is an `ENOENT` naming a path with a `~` still in it --
  which reads as "the file is missing" rather than "the `~` was not expanded". One
  implementation of that rule, which is the one `paths.ts` already holds; on
  Windows it expands `%VAR%` too, for the same reason.

#### What is translated and what is not

- **The line is whose mistake it is.** Anything a _user's config file or
  environment_ can provoke is translated: every JSONC message, the unsafe-key
  refusal, `Failed to read`, `{0} must hold an object`, `Invalid value for "{0}"
  in {1}: {2}`, `Expected a list of values`, the read-only `delete()` message, the
  `canRepresent()` refusal, and `"{0}" in {1} is not a list` with its
  `is not an object` sibling. Anything only the
  _app's own code or a store's own code_ can provoke stays English: a dotted path
  that cannot mean anything, a layer name that is not there, a schema declaration
  that cannot mean anything, `No writable config layer`, a store whose document is
  not an object, and `apply()` handed something that is not one. That is the line
  the i18n work already drew -- a translated `Expected option choices to be an
  array` is a bug report in a language the maintainer cannot read.

- **`setting "{0}"` is a key, matching `option {0}` and `argument <{0}>`.** It
  is a label fragment interpolated into `Invalid value "{0}" for {1}`, which is
  exactly what the parser already does with its own two.

- **The four array methods share one key rather than putting the method name
  through a slot.** `Cannot {0} to "{1}" in {2}` was the first version, and `push`
  is an API name a translator sees as prose. `"{0}" in {1} is not a list` is one
  complete sentence for all four, and what it loses -- which call it was -- is in
  the stack trace.

- **16 new keys, and 77 in total once the two strict-reader keys went.** `SIGIL_KEYS.length` is the figure and the
  generator prints the count it wrote; no number here should be read as the
  current one.

#### `paths.config()` is `paths.configHome()`

- **A prose collision rather than a code one.** `@ttylabs/sigil/config` is a
  module about config _files_ and `paths.config()` beside it is two things called
  the same word, one of which is a directory and the other a layered merge.
  Renamed rather than explained, and renamed to the spelling that makes the pair
  obvious: this reads `XDG_CONFIG_HOME` and `configDirs()` reads
  `XDG_CONFIG_DIRS`, so each function is named for its own variable. A breaking
  change to a published export, taken because the package is at `0.0.1` -- which
  is the call `heading()` already got.

  The ticket's own example spells it `paths.userConfig()`; `configHome()` was
  chosen over it because it names the variable the function reads, which is the
  rule that makes both names obvious rather than one of them explained.

  It cost one shadow in `paths.test.ts`: a local `const configHome` inside the
  `XDG_*_DIRS` block was fine while the import was called `config` and shadows it
  now, so the local is `declared`. Which is the kind of thing a rename finds and a
  type-check does not.

#### `readSigilConfig()` migrated, which is the acceptance test

- **One layer, which is this file.** The stack is what an _app_ reaches for; the
  toolchain has exactly one place its own settings live, and a second layer would
  be a second place to look for an answer to one question.

- **What the migration changed is three things.** A file that is not there, one
  holding nothing, and one holding valid JSON read exactly as before. A **string
  where a boolean was declared is coerced** rather than refused, which is the
  shared vocabulary arriving and is argued above. The **type messages are the
  shared ones** -- `Invalid value for "build.sourcemap" in <path>: Invalid
  boolean: "42"` rather than a sentence written in the toolchain -- which name the
  file, the setting and what was wrong. And a **field written `null` reads as
  absent** rather than throwing, which is the entry below.

- **Three checks the schema's vocabulary cannot say stayed in the toolchain**,
  and finding them is what the migration was for. `"build": []` is a mistake
  nothing in the schema would report, because a schema declares settings by dotted
  path and has no nested object shapes -- and declaring `build` as well is refused
  by the setting-inside-a-setting rule. An empty `components` or `locale` passes
  `type: 'string'` and is right to, because a key written `""` is an empty string
  somebody chose. And "relative to the app" is a fact about what a field is _for_
  rather than about what kind of value it is.

- **The migration was walked check by check against the old reader, which is
  the only way an acceptance test means anything.** Eleven validations, nine
  unchanged -- `build` must be an object, every name non-empty, every list a list
  of non-empty names, `components` relative, `locale` a non-empty string, a
  parse failure reported, an absent file empty -- and the two that moved are the
  coercion and the messages, argued above. Two further differences turned up by
  walking it rather than by reading it:

  An **unknown key under `build`** used to be dropped, because the reader named
  each field it read; the merged view holds whatever the _file_ holds, so passing
  it through handed back an object with keys `BuildConfig` does not declare. That
  is a value that lies about its own type over a key which is almost always a
  typo for one of the six, so `readSection()` picks by a list. An unknown key
  _beside_ `build` was and is ignored.

  And a **directory where the file was named** used to answer `{}`, because
  `isFile()` is false for one -- so an app pointing at the wrong thing looked
  like an app with no config. It is `Failed to read` now, which is the
  `EISDIR`-is-not-absence rule arriving at its first real caller.

  A third turned up the same way, by walking the inputs rather than reading the
  checks, and it is a **class** rather than one field: **a field written `null`
  used to throw and now reads as absent.** `{"build": null}` was `"build" must be
  an object`, because the old reader asked `!value` before it asked about the
  type; `{"locale": null}` and `{"components": null}` were `must be a non-empty
  string`; `{"build": {"shake": null}}` was `must be true or false`. All four are
  `{}` now, because `null` is "not configured" wherever it is written -- the
  config module's own rule and the ticket's, arriving at its first real caller.
  Correct rather than dropped: somebody who writes `"shake": null` is saying
  nothing about shaking, and what nothing means is the default. So "nine
  unchanged" above is nine for every value but `null`, which is the honest form of
  it -- a check that still fires for `[]`, for `42` and for `"nope"` and no longer
  fires for the one value the module reads as silence.

  Worth knowing where each half of a message comes from: the type messages name
  the **layer**, which the toolchain calls after whichever of the two files it
  found -- `sigil.json` or `sigil.jsonc` -- while the parse and read messages
  name the store's **source**, which is the absolute path. So
  `Invalid value for "build.external" in sigil.json` and
  `Failed to parse /path/to/sigil.json` sit side by side, and each names the
  thing its own reader can act on.

- **A file that is not there and a file holding `{}` are now the same answer.**
  The keys are set only where the file said something, where the hand-written
  reader set every one of them to `undefined` and distinguished the two cases only
  by returning early. A reader cannot tell "absent" from "present and undefined"
  and no longer has to.

#### The public surface, and what the emitted declaration said about it

- **The constructor's parameters are public types, because the published
  `.d.mts` is where that is visible and nowhere else.** `Config`'s first
  signature took the built `Layer[]` and the read `Setting[]` -- both this
  module's own, neither exported -- so the generated declaration held
  `constructor(layers: Layer[], settings: readonly Setting[], ...)` over two
  interfaces a consumer could not name: a constructor in the public surface that
  nobody can call. Found by reading `dist/config.d.mts` rather than the source,
  which is the only place it appears, and the type-check is perfectly happy with
  it either way.

  So the reading happens outside and the **building** happens in the
  constructor, which takes `(opts: ConfigOptions, docs: readonly
  (ConfigDocument | undefined)[])`. What it costs is that `readSchema()` and
  `assertLayers()` run twice -- once in the entry point, so that a declaration
  which cannot mean anything is refused **before** any store is read, which for
  a remote store is a network call, and once in the constructor, because that has
  to be correct when called directly. Both are pure. What it buys beyond the
  declaration is that `new Config(opts, docs)` is a coherent thing to call: build
  a config from documents somebody already read.

  Exporting the two interfaces was the cheap alternative and is refused for the
  reason the rest of this section is written: `Layer` is `ConfigLayerInfo` plus
  the mutable value, and publishing it would be surface nobody should use.

- **`scanJsonc()` and `lineAt()` are not in the barrel, which is the rule
  `transformValue()` already follows.** They were, and they have no caller
  outside this package: SIG-154's span editor is in it and imports relatively,
  the tests import the module directly, and nobody has asked for a JSONC scanner.
  Real surface for no caller is what `which` waited eighteen months over.

  What the barrel does export is `createConfig`, `createConfigSync`, `Config`,
  `isWritableStore`, the three stores, and the eleven types -- and `Config` is
  there for an app's own signatures rather than to be constructed, which the
  honest constructor above now makes safe to say.

> Moved: _Two of these headings collided, and that is how the prose went in the wrong section_, _What the sabotage pass found, and the one declared survivor_, _What the first review round found, and the third prototype door_, _Walking the degenerate inputs, which found four things no guard was aimed at_, _Walking the comma shapes, which found the scanner wider than its own rule_, _What the second review round found, and it was twelve tests and sentences_, _What the third round found, and the review half of it never ran_ — see [docs/history/a-layered-config-module-one-merged-view-over-an-ordered-stac.md](../../../../docs/history/a-layered-config-module-one-merged-view-over-an-ordered-stac.md).

#### What is deliberately out

- **`mkdirOwnerSync()` stays internal**, and it has a caller now: `writeAtomic()`
  creates the directory it writes into, which is the "apply the parent
  directory's owner under sudo" rule the update cache already reads. Still no
  subpath publishes it, so a third-party store writes its own.
- **No `strict` schema option**, for the reason the unknown-key entry gives.
- **No `memory()` beside `object()`**, which would be two names for one store.
- **No discovery, no `--config`, no naming convention**, for the reason core does
  not load config.

### Writing a config file back without destroying it

SIG-148 read a layered config and mutated it in memory; SIG-154 persists it, and
the whole difficulty is in **not damaging a file somebody hand-wrote.**
`src/config/spans.ts` is the span-and-edit layer, `jsonc-write.ts` is the JSONC
writer, `atomic.ts` is the temp-plus-rename, `represent.ts` is what JSON cannot
hold, and `Config.save()` is the one caller of all four.

- **Comment preservation is a span problem rather than an AST problem, and the
  idiom was already here.** A faithful CST per format -- model the trivia, attach
  comments to nodes, print the tree back -- is what `yaml`'s document model is
  and is a large amount of work per format. The other way is to **parse for spans
  and apply minimal text edits to the original source**: to change a value,
  replace the span it occupies; to add a key, splice at an offset. Everything
  untouched stays untouched _by construction_, because it is still the same
  bytes. That is what `compile-templates.ts` already does to an app's module and
  what `shake.ts` already does to a `utilitySheet()` call site, so it is this
  repository's own answer to "modify somebody else's file" rather than a new one.

  `magic-string` is what the toolchain uses for the same job and is a dependency,
  so the applier is written here: ordered splices over a string, which is small.

- **It also makes a subset reader _safer_ than a complete one, which is the
  property the sibling stores rest on.** A construct the reader does not
  understand but nobody edited survives byte for byte, where a reprinter corrupts
  it -- so CRLF line endings, a missing final newline, the user's indentation
  style and their key order all come through for free. Which is the lossless rule
  stated backwards: **a span store cannot lose what it was not asked to change**,
  so it never trips the guard. The guard is for everybody else.

- **The structure is scanned over the _blanked_ text, and that is the whole
  trick.** `scanJsonc()` replaces every comment and trailing comma with a space
  and keeps every newline, so what it hands back is ordinary JSON **at the same
  offsets as the source** -- which its own doc comment already said this editor
  would use. So the structural pass reads the blanked text, where there are no
  comments and no trailing commas and the grammar is plain JSON, and every span
  it records is a span of the source. One grammar with two readers that cannot
  come to disagree, because one feeds the other.

  Two texts are in play and each answers what it is for. **Structure** is the
  blanked text's: where a value starts and ends, and -- because a comment is
  whitespace there -- where the comma between two entries is, which is what lets
  a comment sitting between them survive a removal. **Trivia** is the source's:
  what a line is indented by, whether a comment follows a value on its line,
  whether the container spans lines at all.

  It also lets the structural scan be written to the grammar with **no error
  handling at all**, because `editJsonc()` parses before it structures: a text
  `JSON.parse` has accepted has no malformed shape left in it for a guard to
  describe.

- **A node tree rather than the path-to-span index the ticket named.** The
  obvious shared shape is a map from dotted path to span, and it cannot answer
  the question insertion asks: where the closing brace is, whether the container
  spans lines, what its last entry is indented by, whether a comma already
  follows it. A tree carries all of that and the index is a walk of it, so the
  tree is what is built -- and a separate lookup over it is not, because it would
  have no caller.

- **An object member and an array element are one shape, because the hard half is
  the same question for both.** The comma handling, the line handling and the
  indentation differ not at all between them; only the serialization of a _new_
  one does. So `Entry` carries a span and a node and optionally a key, and `key`
  is what says which it is.

- **The applier's two rules about a shared offset, and both are load bearing.**
  **An insertion goes before a replacement** that starts there, which is what
  lets a new key be spliced in at the offset a removed one starts at -- otherwise
  every emitter has to get that order right, and one that has to is one that gets
  it wrong. Measured as exactly that: with the emitters ordered the other way,
  replacing every key of an object produced `{\n\t,\n\t"b": 1\n}`, which is a
  dangling comma and invalid JSON. **Two insertions keep the order they were
  emitted in**, because adding a key to an object with no trailing comma needs a
  `,` after the last value _and_ a new member after the line's trivia, and when
  there is no trivia both land on the same offset.

- **The comma is decided against what _survives_ rather than against what is
  there, and that is the half that cannot be done one entry at a time.** Dropping
  the last two of three has each of them reach for the comma in front of it, and
  a pass that looked only at its neighbours would have both reach for the same one
  and produce two overlapping edits. So an entry takes the comma that **follows**
  it, and only one with no survivor after it and a survivor before it reaches
  backwards instead -- which means a container being emptied takes every comma in
  it forwards, where a rule about "no survivors either side" leaves a dangling one.
  Found by probing a duplicate-key object whose every key was replaced, which came
  out `{\n\t"b": 1\n\t,\n}`.

- **And the insertion anchors on the last entry that is _staying_.** An insertion
  anchored on an entry that is being removed lands inside the removal, which is
  the same dangling comma by the other road -- so `insertInto()` takes the drop
  set, and a container whose every entry is going anchors just inside the brace,
  which is the one offset no removal can reach.

- **The trailing whitespace of a removal is the entry's unless it is the
  container's padding.** `{ "a": 1 }` emptied has to keep the space in front of
  its brace, while `{ "a":1, "b":2 }` with `a` removed should not come out
  `{  "b":2 }` -- so the scan forward over spaces and tabs is committed only
  where what follows is not the closing brace. The **whole line** goes on top of
  that where the entry owned one, which is what an editor does and is what stops
  a removal leaving an indented blank line behind; it cannot fire for an entry
  that reached backwards for its comma, because the range then starts at the
  comma and a comma owns no line.

- **The gap between an entry and its comma is swallowed when it is whitespace and
  left alone when it is not.** Which is what keeps a comment that sits there -- at
  the cost of the whitespace around it, which is the lesser loss. Asked of the
  **source** rather than the blanked text, because in the blanked text a comment
  _is_ whitespace and the question is exactly whether one is there.

- **An inserted member's own value is indented by the line it lands on, which is
  not where its separator goes.** A multi-line container puts the new entry on a
  line of its own, so its value's continuation lines take the entry's indent; a
  single-line one puts the entry _beside_ the last, so the value lands on the
  container's own line. Reading the entry's indent there pushed a nested object
  one level further in than the line it sits on -- measured,
  `{"a": 1, "b": {\n\t\t"c": 2\n\t}}` -- and the test for it is what found the
  two apart.

- **The indentation, the line ending and the trailing-comma style are read off
  the document.** One level of indentation is the first container with an entry
  that owns a line and is indented further than the container's own line; the
  default is **two spaces**. The line ending is `\r\n` where the document holds
  one. And a trailing comma is put back where the object had one, because the
  user's trailing-comma style is one more thing a write is not being asked to
  change.

- **That default was a tab, and the reason written down for it was false.** The
  entry said "a tab, because that is what npm writes into a `package.json` and
  what this repository's own formatter uses". The first half is wrong, measured
  rather than argued: `npm init -y` indents with **two spaces**. The second half
  is true and does not transfer -- that formatter formats this package's
  **TypeScript**, and what a tool writes into somebody else's data file is a
  different question from how it formats its own source. Written down because the
  sentence was specific enough to be believed, which is what kept anybody from
  checking it.

  Three places emitted a tab and every JSON file this repository **owns** is two
  spaces, including its own `sigil.json` -- so the practice and the output
  disagreed, and the scaffold disagreed with itself: it wrote `package.json` and
  `tsconfig.json` with two spaces and `sigil.json` with a tab, in one function.
  `DEFAULT_STEP`, that scaffold line and `generate-registry.mjs` are all two
  spaces now. Reported by the repository owner, who was right on both counts.

  What it changes is **only a document with nothing to read from**, because
  `detectStep()` copies whatever the file already uses -- so an existing
  tab-indented config stays tab-indented, which is the rule that matters and is
  untouched. The one place the default is visible beside the user's own bytes is a
  container holding a comment and no entries: the comment keeps its tab and the
  new entry gets two spaces, which is mixed and is honest about which half is
  whose. `should insert into an object that is empty, behind a comment in it`
  pins it, and reading an indent off trivia would be a new rule for the one shape
  that is a comment and nothing else.

- **`lineTriviaEnd()` skips comments as comments rather than scanning for the
  next newline, and the case that forces it is a block comment holding a line
  break.** Scanning for the next line terminator lands _inside_
  `"a": 1 /* long\n comment */` and breaks it. A line comment ends at the
  terminator, which is exactly where the new member belongs -- so it goes under
  the comment and the comma stays in front of it, where a comma written after the
  comment would be _inside_ it. And a container whose closing brace is on this
  line has no line to end, so the insert goes straight after the value.

- **Duplicate keys are the one thing in the writer that reads as pedantry and is
  not.** `{"a":1,"a":2}` is legal JSON and `JSON.parse` answers `2`, so the last
  member of a name is the live one -- which means a _change_ edits that one and
  leaves the shadowed ones shadowed, while a _removal_ has to take every one of
  them or the shadowed value becomes live and the round trip changes a value
  nobody touched. That is the worst class of failure a writer can have, so it is
  handled rather than hoped about. What is left is a stale shadowed member in the
  file, which is the lossless answer: it is already dead, and removing it would
  be changing something nobody asked about.

- **An array is diffed by index, so a `push` is one insertion and an `unshift` is
  a rewrite of every element plus one.** The second is the worse of the two and is
  still correct, and what it keeps is everything _between_ the elements -- so a
  comment on a line of its own inside a list survives either. By identity would
  need a notion of element identity that JSON does not have.

- **A no-op write touches no file, which is not tidiness.** The store compares the
  rendered text against the bytes it read and returns where they are equal, which
  keeps the mtime SIG-153's watcher is reading and makes `apply()` of a freshly
  read value a no-op rather than a rewrite of the same bytes.

#### `write()` reads the file itself, and the cache was the dangerous shape

- **The store holds no source text between calls.** A cache is the faster shape
  and is the one that corrupts: a `write()` computing edits against text the file
  no longer holds splices at the wrong offsets, which is the single failure mode a
  span writer has. So `write()` reads the current bytes itself, which costs a
  second read per save -- `save()` already read for the three-way merge -- and
  makes the method work standalone, which is what public API should do.

- **It validates its own input, which is what makes `canRepresent()` the _early_
  answer rather than the only one.** `set()`'s call names the one value and the one
  path at the moment they were written; `write()`'s answers for the document,
  because a caller who went straight to `write()` has had nothing checked.

- **A value JSON cannot hold is refused, and the third of `JSON.stringify`'s three
  answers is why.** It **throws** for a `BigInt`. It answers `undefined` -- the
  value, not a string -- for `undefined`, a function and a symbol, which reaches a
  file as broken output. And it **silently rewrites** `NaN`, `Infinity` and
  `-Infinity` as `null`, a `Map` or a `Set` as `{}`, and a class instance as
  whatever its own enumerable keys happen to be. The third is the silent-loss class
  every other decision in this module refuses, so it is what `represent.ts` is for.

- **A value with a `toJSON` passes and is not walked.** This asks what
  `JSON.stringify` will do rather than what the value holds, and `JSON.stringify`
  calls `toJSON` first and never looks at the rest -- so an object that said what
  it is in JSON has said it. A `Date` is the case that matters, because its JSON
  form is an ISO string and the schema's own `date` type reads one back, so it
  round trips through this module rather than through JSON alone. Found by a test:
  the first version asked the structure first, so `{ toJSON: () => 1 }` was walked
  as a plain object and refused for the function inside it. What that method
  **answers** is not checked, because checking means calling a caller's code
  during a guard; `serialize()` throws for the one answer that would reach a file
  broken, which is a tripwire rather than a case anybody has.

- **The refusal names the path rather than the value it was handed.**
  `set('server', { retries: Infinity })` is a plain object holding something JSON
  turns into `null`, and a refusal naming `server` would be pointing at the thing
  that is fine. The walk adds and removes around the recursion, which is
  `copyInto()`'s own rule and for its reason: a value referenced twice is a DAG
  that JSON writes twice, and only a genuine cycle is refused.

#### The atomic write, which is new machinery in this repository

- **The temp file goes in the target's own directory.** `rename()` is only atomic
  **within one filesystem**, so a temp file in `tmp()` is a copy and a delete
  rather than a rename -- which has the half-written window back, plus a
  cross-device failure on the platforms that refuse `EXDEV`. The cost is a stray
  `.tmp` beside the config when a process is killed between the write and the
  rename, which is litter rather than damage.

- **Where it goes is pinned by a wrapped `fs` rather than by reading the
  directory afterwards.** The temp file exists only between the open and the
  rename, so nothing outside can look -- and the first version of that test read
  the directory _after_ the write and would have passed for a temp file in
  `tmp()`. `atomic-temp.test.ts` wraps `node:fs` the way `bundle-close.test.ts`
  wraps `rolldown`: the real calls run, and the wrapper adds a record of which
  paths were opened, renamed and unlinked plus a way to make one of them fail. A
  file of its own, because `vi.mock` is hoisted and module-wide.

  The same pass retired a second vacuous test. "Should remove the temp file where
  the write failed" wrote to a path under an existing _file_, which
  `mkdirOwnerSync()` refuses before any temp file exists -- so it asserted the
  cleanup over a run that had nothing to clean up.

- **The mode is preserved and the setuid bits are not.** A `600` config has to
  come back `600`, or writing a setting hands its contents to every user on the
  machine. The setuid, setgid and sticky bits are deliberately not copied, because
  re-creating one on a file this just wrote is a privilege decision a config
  writer has no business making; a file that did not exist gets whatever the umask
  says, which is what every other new file on the system gets.

- **And the owner, under sudo.** `sudo mycli config set` must not leave a
  root-owned config in somebody's home directory, after which they cannot edit
  their own settings without sudo again. So when the process is root the temp file
  is chowned before the rename: to the target's own owner where there is one, and
  to the containing directory's where the file is new. That is `mkdirOwnerSync()`'s
  rule read one level down, which is what makes the directory and the file it holds
  agree.

- **It flushes the file and not the directory.** Without an `fsync()` the rename
  can be visible after a power loss while the data behind it is not, which is the
  truncated file this exists to prevent arriving by the other road. The
  **directory** is not flushed, which is where `write-file-atomic` -- the package
  npm itself writes with -- draws the same line: what that gives up is durability
  of the rename across a power loss, and what it buys is one fewer disk round trip
  per save on every filesystem. A flush that fails is **swallowed**, because the
  filesystems that refuse one refuse it always -- `EINVAL` and `EPERM` are what a
  network mount or a container layer answers, and failing a save over a durability
  hint the kernel declined is refusing to write a file that would have written.

- **One bracket around everything the temp file exists for.** Whatever fails,
  there is no temp file left behind -- which is the rule `bundleApp()`'s own
  `finally` keeps about a handle it opened, and is why the close is nested inside
  the cleanup rather than beside it. `writeFile` rather than one `write`, because
  a `write` may be short and a config half written into the temp file is the thing
  this is for.

- **It is not published.** No subpath reaches it. SIG-152's YAML store would want
  it, and the rule is to decide against the first caller that does rather than
  against one that does not -- which is the same call the span applier gets.

#### `set()` mutates and `save()` persists, which is forced rather than chosen

- **A synchronous `set()` cannot report an asynchronous write failure, so it does
  not try one.** Every accessor is synchronous and a store's `write()` may not be
  -- a remote store is async by nature -- so one that tried would be the
  silent-loss class every other decision here refuses. That is better anyway: a
  run that sets five keys writes once rather than five times, and the
  temp-plus-rename and the re-read are one operation rather than five.

- **`autoSave` is deliberately out**, because a `set()` that schedules a write is
  a `set()` that cannot say the write failed. The hazard that leaves is named
  rather than guarded -- an app that sets and exits without saving loses the write
  -- and `ConfigLayerInfo.dirty` is what makes it actionable: an app that wants to
  warn, or to ask before discarding, needs to be able to ask. It is also what makes
  the tracking testable without reaching into a private field, which is the
  decider, because a mechanism with no observable is one a test cannot pin.

- **`saveSync()` is beside `save()` rather than instead of it**, for the reason
  `createConfigSync()` is: an exit or signal handler **cannot await**, which is the
  same reason `Terminal.syncRestore()` exists, and "read the config on the way in
  and write it on the way out" is that shape exactly. Two real implementations of
  one loop, because a synchronous entry point that awaited an already-settled
  promise would not be synchronous -- so everything between them is a shared
  method rather than one calling the other.

- **It re-reads before it writes, and what gets applied over the fresh read is
  the _paths_ this process touched.** Which makes the common cross-process case
  work: two invocations setting two _different_ keys both survive, where a blind
  write loses one of them. Paths rather than a before-and-after copy of the layer
  is the cheaper shape _and_ the more honest one -- what a three-way merge needs
  is "what did **this** process change", and a path is that said directly where a
  deep diff is it inferred.

  The residual race is **last-writer-wins on the same key**, documented rather
  than guarded: a lock is the only real fix, nothing has asked for one, and a
  half-guard here would read as safety and not be.

- **The empty string is the whole layer, which is what `apply()` records.**
  Consistent with the rest of the module, where an absent path is already the
  whole merged view -- and it is what makes `apply()` replace rather than merge on
  the write side too, so the other process's keys are not honoured for a layer
  that was replaced wholesale. A reload is the same statement and costs nothing:
  re-applying what was just read diffs to no bytes at all, so the write is
  skipped.

- **Two values are staged and they are two different readings of one result.**
  What is **written** is the freshly read document with this process's own paths
  applied over it, _uncoerced_: a layer holds `false` where the file says `"off"`,
  so coercing what goes back would rewrite a spelling nobody asked to change. What
  is **held** is the coerced copy of it, because a layer's value is always one the
  schema has validated -- and it is built before the write, so that a document the
  schema cannot hold is a refusal rather than a file already on disk.

- **`copyDocument()` is `copyValue()` with a `null` kept, and the write path is
  what it is for.** `copyValue()` drops a `null` because _this module_ reads one as
  a format saying nothing, which is right for a layer; a file that says
  `"theme": null` is a file whose `null` the write was not asked to change, so
  dropping it on the way to the writer would delete the line -- and with it
  whatever comment sits above it. `undefined` is still dropped, and that is not an
  inconsistency: `null` is a value in every text format and `undefined` is a value
  in none.

- **A layer the save re-read may come back holding keys it did not hold before**,
  so `get()` can answer differently after a `save()` than before it. That is the
  file being right about itself, and the alternative -- a view that disagrees with
  the bytes just written -- is the worse of the two surprises.

- **A clean layer is skipped and a named read-only one is refused**, which is the
  split every mutator here already keeps: `save()` with no name over a stack
  holding an `/etc` file is an ordinary thing to ask, and naming that layer is the
  app asking for something it cannot have. The message distinguishes the two
  refusals the types already distinguish -- a store with no writer at all, and a
  layer that is not this app's to write.

- **One method with two signatures rather than two methods**, which is the shape
  `InputRouter.bind()` already takes. A trailing layer name is the idiom every
  mutator here keeps and `save()` has no positional argument for a name to trail,
  so `save({ lossy: true })` has to work or the common escape hatch is spelled
  `save(undefined, { lossy: true })`.

#### The lossless rule, and the one place a message is not translated

- **The thing to guard is not comments, it is loss.** Comments are the visible
  casualty and every other one is silent in exactly the same way -- key order, an
  anchor, an indentation style, CRLF line endings, a missing final newline, an XML
  attribute that was spelled as an attribute. A guard that greps for comments
  protects the one people notice and leaves the rest. So the property is: **a write
  either preserves everything it was not asked to change, or it names what it would
  lose and refuses.**

  That is `clipboardSequence()`'s rule one subsystem along: over the cap it refuses
  by default and truncates only when asked, because sending and hoping is the one
  answer that cannot be observed. A config file quietly stripped of its comments is
  the same failure with a slower fuse -- the user finds out next time they open the
  file.

- **It is a property of the write rather than of the store.** The cheap version is
  a `lossless` flag on each store and it is wrong in the direction that annoys
  people: a reprinting store writing a file that **has no comments in it** loses
  nothing, and refusing that write is a guard firing on correct code. So the
  question is asked of the _document_, which a span store answers for free because
  it already parsed it. Which means the guard is mostly **for the sibling
  packages**: the stores in here never report a loss, so nothing in core ever trips
  it, and the tests for it are written against a store that reprints.

- **Per call and per layer, never one global setting.** A global "allow
  clobbering" is set once in a scaffold and never thought about again, which
  defeats it. Per **layer** is the legitimate case -- this file is generated, so
  clobber it freely -- and per **call** is the escape hatch, which is where
  `truncate` already sits on the clipboard rather than on a config object.

- **The message names both ways out, and its detail is the one thing here that is
  not translated.** `Loss.kind` is an open string the _store_ chose -- `comment`,
  `anchor`, or whatever a format this package has never heard of calls its own
  trivia -- so the phrase is assembled out of words this package did not pick and
  cannot translate. `kind:line` is the `file:line` convention the toolchain's own
  diagnostics already use, it needs no English of its own, and it carries the count
  by being a list, so there is no plural to translate either. Capped at ten, because
  a store reporting five hundred losses would otherwise produce a message nobody
  reads to the end of.

  It is `lossy: true` rather than `{ lossy: true }` in that sentence, because a
  `{...}` in a key is what `should number a slot per interpolation, never name one`
  refuses -- and it is right to: a translator meeting one has no way to tell a
  literal brace from a slot somebody spelled with a name.

- **Format conversion is no longer a thing core can be asked for**, because there
  is one file store and it reads both extensions. What this records is the entry
  that was here: `json()` over a `.jsonc` path used to throw, on the argument that
  such an extension exists to say comments are allowed and the strict store exists
  to say they are not. The asymmetry it rested on -- that the _reverse_ was not
  refused, because `tsconfig.json` is JSONC under a `.json` name -- is what
  eventually overturned the whole distinction. See "One reader for both extensions"
  below. A store that genuinely cannot preserve what it was handed still refuses
  where the layer is built, which is the rule; core just has no such store.

#### One reader for both extensions, and `sigil.json` stays `sigil.json`

This reverses a decision recorded here, at the repository owner's call, and the
reversal is better than what it replaces -- so what the entry below is for is the
argument rather than the history.

- **A `.json` is read as JSONC, and so is a `.jsonc`.** One reader rather than one
  per extension. What this replaced read the `.jsonc` one with comments allowed
  and the `.json` one strictly, on the argument that an extension should mean what
  it says -- and the counterexample was already written into this file one
  paragraph away, as the reason the _reverse_ conversion was not refused:
  **`tsconfig.json` is JSONC under a `.json` name**, and so are VS Code's own
  settings. An extension is a file name rather than a declaration about the bytes,
  and a config file is the file people most want to annotate. So the rule that
  "each extension means what it says" was being applied to a convention the
  ecosystem had already settled the other way.

- **What it gives up is the `Comments are not allowed in {0}, on line {1}`
  message**, which named the line where `JSON.parse`'s `Unexpected token /` does
  not. It bought strictness nobody asked for: this store never _writes_ a comment,
  so reading one strictly could only refuse a file every other tool accepts. An
  app that needs a file to stay strict JSON has something that says so -- its own
  validator, or whatever consumes it -- and that something is not this. Two i18n
  keys went with it, 79 to 77.

- **So `json()` and `jsonc()` collapsed into one `json()`**, because two names for
  one behaviour is the drift this file deletes everywhere else. `json()` is the
  surviving spelling: it is the one that reads naturally over a `config.json`,
  which is the extension an app already has. A breaking change to a published
  export, taken because the package is at `0.0.1` -- the call `heading()` and
  `paths.config()` already got.

- **And the format-conversion refusal went with it.** `json('x.jsonc')` used to
  throw, which was coherent only while the two stores read differently: with one
  reader there is nothing to convert and nothing to refuse. `fileStore()`'s
  `jsonc` parameter, `scanJsonc()`'s and `parseJsonc()`'s `allow`, and
  `EditOptions.allow` all went the same way -- an unused parameter is worse than
  no parameter, and the strict branch they fed had no caller left.

- **Both at once is refused, naming them.** The two-routes-one-name rule said about
  a config file: with both there, picking one picks it by the order an array happens
  to be written in and the other silently does nothing. `sigil.json` is first and
  is what `sigil new` writes, because it is the name an app already had and there is
  nothing left for the other extension to buy.

- **This repository's own is a commented `sigil.json`**, which is what makes the span
  writer dogfood rather than a feature with a test of its own. Four sabotages over the
  reversal, all four caught: refusing a comment again fails **42** tests across
  both packages, reporting the store's format as `json` fails 3, putting `.jsonc`
  back at the head of `CONFIG_FILES` fails 3, and having `sigil new` write a
  `.jsonc` fails 1. So the new behaviour is pinned rather than incidental, which
  for a reversal is the thing worth checking: a decision reversed without a test
  is one the next round reverses back.
  `packages/cli/test/config-write.test.ts` copies it, sets `build.sourcemap`,
  saves, and asserts the result is the original with that one token changed and
  **every other byte identical** -- over the real `CONFIG_SCHEMA` rather than a
  copy of it, so what is asserted is that the writer preserves the file the
  toolchain actually reads. It also asserts the file **has** comments, because a
  commit that took them out would leave every other assertion true and empty.

- **There is deliberately no `saveSigilConfig()`.** The toolchain has no setting
  it persists -- every one of them is a literal somebody edits -- and a function
  with no caller is the dead code this file has an entry about, where the exported
  half outlived the script it told the reader to run. `CONFIG_SCHEMA` is exported
  instead, which is what the acceptance test needs and is API only inside the
  package, since `@ttylabs/cli` publishes a bin and no subpaths. A
  `sigil config set` is where a write would get a caller.

- **`inputs` names both file names in both turbo configs**, because `inputs`
  replaces rather than extends and a build that reads either name and does not
  hash it is the stale-`dist/` hole the `registry/**` incident is written about.

> Moved: _What the sabotage pass found, and the two declared survivors_, _What the first review round found, and two of them wrote invalid output_, _What the first round's own fixes cost, measured_, _What the second review round found, and it was all prose and tests_, _Reading the two rounds' own guards, which nobody had_, _What the third review round found, and the entry above it was wrong_ — see [docs/history/writing-a-config-file-back-without-destroying-it.md](../../../../docs/history/writing-a-config-file-back-without-destroying-it.md).

#### And "both of its callers" was false, which counting settled

Round 3's own fix rewrote `writePath()`'s doc to say that "both of its callers
refuse one before they get here", and there are **six functions** with eight call
sites. Found by reading the claim rather than the code -- the shape this file
records as unestablishable by tracing the route you had in mind, written into the
doc of the function it is about, one commit after a round had corrected the
sentence it replaced.

The claim it was reaching for is true, and it is true for a **different reason per
caller**, which is why the doc enumerates them now: `#assertWritable()` for
`set()`, `delete()` and the four array methods; ancestors the undone write had
just made, for the rollback; `overlay()`'s own walk, for a claimed path; a path
`readPath()` found a value at, for `coerceLayer()`; and a **fresh** document plus
`readSchema()`'s refusal of overlapping setting paths, for `defaultsOf()` and
`envOf()`.

Two things were measured on the way, and the second is why the first is not a
finding. `push('a.b', 1)` over a layer whose `a` is `5` **refuses**, which is
`#assertWritable()` covering the array methods as well. And an **environment**
value at `a.b` over the same layer answers `{ b: 7 }` where a `default` at `a.b`
answers `5` -- which looks like the same defect one door along and is not: both
write into a fresh document, so no `writePath()` ancestor is involved at all, and
what differs is the **merge** putting the env layer over the file and the default
layer under it. A scalar meeting an object is the merge's own rule, the asymmetry
is the precedence chain working, and neither is this branch's: `schema.ts` is
untouched by it.

#### And the applier enforced half of its own one rule

`applyEdits()`'s rule is "ordered and non-overlapping", and it threw for the
first half and **corrupted silently** for the second: an edit whose `end` is
before its `start` leaves the cursor behind where the slice ended, so `[2, 1)`
over `abc` came out `abXbc` -- the text duplicated rather than replaced. Found by
walking the function's degenerate inputs rather than by a round.

A tripwire rather than a reachable defect, exactly as its sibling is: round 1
recorded that no input reaches the overlap throw either, and both are kept on the
same footing -- the day an emitter produces one, it is a bug report in English
rather than a config file with a line written twice. Both directions are
sabotage-checked, and the second is what says the comparison is `<` rather than
`<=`: an **insertion** is `start === end`, which is the shape every new key is
spliced in by, so refusing it fails twenty-seven tests.

Three other things in `spans.ts` were walked and left alone. `lineStartAt()` of a
negative offset answers that offset, which its own doc declares -- "every caller
hands over a span of this text", and a sabotage of the clamp changed no answer.
`lineAt()` past the end answers the last line, and of a negative offset the first.
And an edit whose offsets are `NaN` prepends, which is unreachable for the same
reason the inverted one is and which the guard above does not catch, since every
comparison against `NaN` is false -- written down rather than guarded, because a
second tripwire for a value no emitter can produce is a guard the first one
already stands for.

> Moved: _What the fourth review round found, and five of the six were the last two commits' own prose_, _What the fifth round found: the insertion arithmetic nobody had read_, _What the first round of PR review found, and the CI it was reading_, _What the second round of PR review found: the dangling half of the symlink fix_, _What the third round of PR review found: lexical `..` against the kernel's_, _What the fourth round of PR review found: the kept entry's own comment_ — see [docs/history/writing-a-config-file-back-without-destroying-it.md](../../../../docs/history/writing-a-config-file-back-without-destroying-it.md).

#### What the write half costs

- **The config module's graph was 32,625 B over seven modules**, against 20,649 B
  over six for the read half -- so the span writer, the atomic write and the
  representability check are about 11.5 kB between them, which is measured
  before the store kit's own 102 B joined the entry and is why the two figures
  do not subtract to each other. The seventh module is the
  `mkdir-owner-sync` chunk the update cache already shares. It still imports no
  parser module at all, which is the property the read half's own test holds and is
  why the ceiling did not move.

- **No new dependency**, which is the hard constraint: the applier is ordered
  splices over a string rather than `magic-string`, and the value grammar is still
  `JSON.parse`'s and `JSON.stringify`'s rather than a second one here.

### A config watcher that survives our own atomic write

SIG-148 refused watching, and what stood was the _reason_ it refused, because it
is the specification: **our own atomic write breaks a naive watcher.** SIG-153 is
the watcher. `src/config/watch.ts` is the diff, the compare and the two event
sources; the state -- the handler set, the debounce, the reload -- is on
`Config`, because that is where the layers and the merged view it reads live.

- **`fs.watch(file)` is a feature that works until the first save and then stops,
  silently, for the life of the process -- measured before a line was written.**
  Over a real temp-plus-rename on macOS:

  | what was watched             | first rename | second rename |
  | ---------------------------- | ------------ | ------------- |
  | the **file**                 | one event    | **nothing**   |
  | the **directory** holding it | three events | three events  |

  A rename swaps the inode, so a watch registered on the path is watching a file
  nothing will ever write to again -- which is why an editor that saves
  atomically is the known case that breaks `fs.watch`, and `save()` is one. The
  directory entry is what changes and the directory's own inode does not.

  The measurement is **not** in the suite, and that is this repository's own
  standard for a platform claim rather than laziness: it is unportable (inotify
  watches the inode too, so Linux dies for the same reason by a different route),
  and a platform claim in a suite that runs on nine node-and-os combinations is
  the flakiest thing there is. What pins the **design** is the integration test
  that sees a _second_ atomic replace; if `fs.watch` on a file ever survived one,
  it would go on passing and this module would merely be doing unnecessary work.
  The first attempt at asserting it in the suite failed for a third reason worth
  knowing: a watcher written to immediately after it is created misses the event
  on macOS, so the measurement needs a warm-up sleep -- which is the shape the
  whole test file is written to avoid.

- **The event is never read: not `eventType`, not `filename`.** Any event in the
  watched directory means re-read and compare. A basename filter is the obvious
  saving and is refused on an asymmetry rather than a preference: **a filter can
  only ever _lose_ an event, and the one it is most likely to lose is the rename
  this module is named for surviving**, because which name a rename reports is
  precisely the platform-dependent thing. Measured, our own write fires
  `rename config.json.tmp`, `rename config.json` and the directory's own name on
  macOS. What not filtering costs is a wasted read of a small file, which the
  compare absorbs; what filtering wrong costs is the feature silently not
  working. The residual is named rather than guarded: a directory with sustained
  churn means one `readFileSync` per debounce window for as long as the other
  writer runs.

- **Re-targeting down the climb is correctness rather than tidiness, and that is
  the measurement the shape rests on.** `fs.watch` on a missing path throws
  `ENOENT`, measured, and a config file the user has not created is the ordinary
  case on a fresh install -- so the watcher climbs to the deepest existing
  ancestor, which is `mkdirOwnerSync()`'s own idiom for a different reason.
  Watching `a` because `a/b` is missing: creating `a/b` fires on the `a` watcher,
  and then **writing `a/b/config.json` fires nothing at all**, because
  `recursive` is off. So without moving the watch down the file is never seen.
  The same rule covers the other direction, measured too: removing `a/b` fires on
  both watchers, so the climb runs again and the watch goes back up.

- **And an event can be dropped, which makes a stuck climb permanent.** The one
  thing no amount of reading the documentation would have said, and it cost the
  suite three flaky runs before it was measured rather than guessed at -- the
  guesses were a `watchFile` baseline race (**false**, it fires at every gap) and
  an `fs.watch` warm-up window (**false** on an idle machine, 0 of 40 at every
  gap). What is true: a **cold** watcher -- created and then written near
  immediately -- loses its event about **3% of the time under heavy parallel
  filesystem load** and 0 of 30 times idle, where a **warm** one does not (0 of 40
  replacements under the same load).

  In the steady state that costs latency and recovers, because the next write
  fires and the reload reads whatever the file holds by then. During the **climb**
  it is permanent: the one event that would ever move the watch down is the one
  that creates the directory, and the watcher was created microseconds earlier.
  Lose it and every write to the config is invisible for the life of the process,
  which is the silent-death failure mode point 7 is about arriving on a
  filesystem that works.

  So **while the watch is not on the directory it wants, something keeps
  asking**: an unref'd interval that re-targets and tells the listeners when it
  moved. Self-limiting -- it exists only in the degenerate state and is cleared
  the moment the real directory is reached -- and it reuses `interval` rather
  than inventing a number, because it is the same idea as `poll` applied to a
  narrower question. It also makes `MAX_CLIMB` giving up recoverable rather than
  final. What is **not** closed is the cold-start drop in the steady state, which
  is one stat per second per layer forever to guard -- which is `poll`, and `poll`
  is the answer for anybody who cannot accept it.

- **Polling turned out to be a different shape rather than the same one with a
  flag, and four measurements say so.** `fs.watchFile` polls **a path**, so each
  poll is a fresh `stat()` and it is immune to everything the event source
  handles: a missing file fires **once** and goes quiet, it fires when the file
  appears, it survives a rename-over and a second one, and
  `unwatchFile(path, listener)` removes one listener and leaves the others --
  **Node already refcounts per path**, so there is no map, no climb, no
  re-target and no refcount of its own. Which is why `WatchSource` is "watch this
  **file**" rather than "watch this directory": the directory is `fs.watch`'s
  problem, and hiding both behind one question is what keeps the caller from
  having to know which.

- **A reload is **synchronous**, which is what makes it atomic.** `readSync()`
  rather than `await read()`, so the whole reload happens in one timer callback:
  a second event's reload cannot start inside it, there is no race for a latch to
  fix and no older read that can win. Every store here and in both siblings
  implements both halves. A store that genuinely cannot read synchronously -- a
  remote one -- throws from `readSync()`, which arrives as the retry path and is
  reported; such a store has no file path to watch either, and `apply()` from the
  app's own `await read()` is its way into the diff.

- **The compare is what makes the debounce's value not matter, which is the right
  way round.** 50ms, on the recorded precedent -- `ESCAPE_TIMEOUT` is 50 because
  bytes from a terminal arrive at machine speed and `SEQUENCE_TIMEOUT` is 500
  because a finger does not -- and a timer whose correctness rests on the number
  being right is a timer that is wrong on a slow machine. One logical save is two
  to five events, so a reload per event reads a truncated file and clobbers a good
  config with nothing; the debounce coalesces them and the compare publishes
  nothing for a value already held.

- **A read that fails is retried once rather than reported.** A read that lands
  mid-write is **expected**, so only a failure that persists past another window
  is reported, with the last good value kept -- replacing a working config with a
  parse error because the editor had not finished writing is the worst available
  outcome. One retry rather than a count, because the number that matters is the
  debounce: the window has already waited for the write to settle, so a read that
  fails twice with no event between is a file that is actually broken, and a third
  attempt would be a second number to justify. A new event resets it, which falls
  out of rescheduling from scratch.

  The error passed on is **the store's own**, unwrapped: it is already translated
  and already names the file, where a sentence of ours would be a second one about
  one failure and would name the layer instead -- which is what the app called it
  rather than what the user can open. So this feature added **no i18n key**.

- **`touched` is cleared on every successful read, whether or not anything is
  published**, because a successful read means the layer **is** what the file
  says, which is exactly what `dirty` reports. The compare decides whether to
  _publish_, which is a different question. That is also the
  reload-overwrites-an-unsaved-`set()` rule said where it takes effect: **a reload
  is a reload**, an unsaved `delete()` is restored by one, and two rules there
  would mean a reloaded layer is neither what the file says nor what you set.

- **A diff rather than the fact of a change, which is the half that makes this
  worth having.** `config.get(change.path)` always equals `change.value`, and a
  change in a lower-precedence layer that a higher one **shadows publishes
  nothing** -- the one thing a per-file watcher can never tell you. Walked to the
  finest granularity: two plain objects recurse and anything else is one change
  at the path it sits at, so an array is a leaf, which is what an app watching
  `exclude` wants.

- **A key no dotted path can name is reported at its parent**, which is what makes
  `get(change.path) === change.value` an invariant rather than a hope. A config
  file may hold `{"server.port": 8080}`, which is a key _named_ `server.port`
  rather than a nested one and which `get()` does not find -- already this
  module's documented state. Reporting a change at that key would hand the app a
  path that reads as a nested one, so the whole object is one change at the
  object's own path and the walk stops: coarser, unambiguous, and
  non-overlapping. The rule fires on a dotted key that **moved** rather than on
  one that is merely there, or every config with a flat dotted key in it would
  report every change at the root.

- **A path handler reads its own path out of both views rather than matching a
  change by prefix.** The prefix reading over-fires: `{a: 1}` becoming
  `{a: {b: 2}}` is one change at `a`, and a handler watching `a.c` is
  prefix-related to it while `a.c` is `undefined` on both sides. One `readPath`
  on each side costs less than the prefix arithmetic and makes the rule exact --
  _a path handler fires when the merged value at its path moved, and is handed
  that value and the one before it._

- **`apply()` publishes and `set()` does not**, which is the one asymmetry here
  worth stating rather than smoothing over. `apply()` is a **reload** -- it
  replaces a layer with what some source now says, which is what `watch()` is
  about, and for a layer with no watchable source it is the **only** way into the
  diff at all. `set()` is the app composing a value it will later save, so
  publishing it would be telling the app what it just said; it would also make a
  handler that sets loop, with nothing but the value compare to stop it.

- **`onError` has no default that can be right, so the floor is the debug log and
  an app that watches config should pass one.** `console.error` from a library
  corrupts a full-screen app's screen and throwing from a timer callback is an
  uncaught exception. Two kinds through one channel, because an app's answer to
  both is the same -- write it down somewhere a human will see it -- and two
  options would be two things to pass.

- **`onError`, `source` and `poll` are refused where they are written; `debounce`
  and `interval` fall back.** The asymmetry has a reason rather than being an
  oversight: a **delay** that is not a finite number at or above zero falls back,
  which is the rule every timer option in this library keeps, while a
  **function** has nothing to fall back to that is not a different answer -- a
  `source` that is not one would silently get the built-in watcher, so an app
  that handed over its own file watcher would be watching with ours and never
  know. And `poll` is neither: a truthy non-boolean read as `true`, or a
  non-`true` value read as `false`, is the works-in-dev-dead-in-Docker failure the
  option exists to prevent, chosen by a typo.

- **`interval` has a floor and `debounce` does not.** `debounce: 0` means "do not
  wait", which fires once; an **interval repeats forever**, so zero is not a rate
  but a spin -- `setInterval(fn, 0)` is clamped by node to 1ms, measured, so
  `interval: 0` over a missing directory put a `statSync` of the ancestor chain
  through a thousand times a second for the life of the process. Clamped to 10ms
  rather than fallen back to the default, because somebody who wrote `0` meant
  "as fast as you can".

- **What it costs is 5,439 B on the config entry's graph and nothing anywhere
  else.** 38,064 B over seven modules against 32,625 B over the same seven -- no
  new module, because the entry already reached `debug` through `i18n` and
  `atomic.ts`, which the watcher imports for `realPathOf()`, was already there
  for the write half. The root entry was **7,518 B** and `components.mjs`
  240,792 B over 27, both unchanged by this -- all three measured the same way,
  which is the only comparison that means anything. It read 4,406 B before
  the first review round's fixes and 5,064 B before the second's, which is why
  the instruction is to measure it again rather than to carry the number.

#### How it is tested without a flaky suite

- **The source is injectable, so everything but the filesystem is tested with no
  sleeps.** The debounce, the compare, the retry, the diff, the dispatch, the
  latch, the handler sets and every refusal run against a function that fires on
  demand, with vitest's fake timers for the debounce -- which is the repository's
  own idiom rather than a new seam. 64 tests in tens of milliseconds.
- **The fs source's climb, refcount and re-target run against a wrapped
  `node:fs`**, which is `atomic-temp.test.ts`'s and `shake-walk.test.ts`'s own
  technique and for their reason: which directory the source ended up watching is
  visible nowhere outside, and the alternative is a seam whose only reader would
  be that file. 38 tests, likewise.
- **Seven integration tests await real events, sequenced rather than slept.** A
  negative is asserted by waiting for a **later** event and then counting, never
  by waiting a fixed time and hoping -- so "our own `save()` published nothing" is
  established by an external write afterwards whose own publish arrives, by which
  time the save's event has certainly been handled. About 800ms for those seven,
  against tens of milliseconds for the 106 above them, which is what says
  the injectable source is worth having.
- **And the first change in each of them is re-applied until it lands**, which is
  not a sleep dressed up: every one writes microseconds after `watch()`, so every
  one is in the cold-start window by construction. Re-applying is safe because the
  content is identical, so the compare means at most one publish however many
  writes it took and an assertion on the exact change set stays exact.
- **`watch-debug.test.ts` sets `DEBUG` before the import**, which is the only way
  to observe the floor: `debug()` reads the variable once at its own load, from a
  `const` nothing can reach afterwards. Which makes the log exactly the kind of
  thing a test asserts with `not.toThrow()` and thereby says nothing about -- two
  tests named for it would have passed with the logging deleted.

> Moved: _What the sabotage pass found, and the two it declared_, _What review round 1 found, and it could run nothing at all_, _What review round 2 found, and the save it could silently undo_ — see [docs/history/a-config-watcher-that-survives-our-own-atomic-write.md](../../../../docs/history/a-config-watcher-that-survives-our-own-atomic-write.md).
