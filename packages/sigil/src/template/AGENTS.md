# `packages/sigil/src/template` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Templates

- **The toolchain is proved by a spawned `tsc` and a spawned node, not from
  inside the suite.** Everything in `test/template/` reaches JSX by calling
  `jsx()` and `jsxs()` directly, which is what the transform emits -- so it
  proves the runtime and cannot prove `jsxImportSource` resolving
  `@ttylabs/sigil/jsx-runtime`, the `exports` map answering for that subpath, or
  node importing what `tsc` wrote. `packages/cli/test/template.test.ts` is the
  other half, for the reason `typescript.test.ts` and the demos already live
  there: vite transforms whatever a test file imports, and a spawned process is
  the whole difference. Not theoretical -- `jsx-dev-runtime` did not exist for a
  while and every test passed throughout, because the production transform never
  asks for it and nothing compiled a `.tsx` for real.
- **The three fixtures behind that test are one component written three ways**
  -- by hand, through the tag, as JSX -- and asserting they agree is the
  differential invariant taken across the package boundary. They began as an
  ergonomics comparison for choosing the design, in a directory called
  `prototype/` that nothing ran; the comparison did its job once, and what was
  worth keeping was the check, so it became one. A `.tsx` fixture is excluded
  from its package's own tsconfig and checked by the one the test drives, since
  the package pass has no `jsx` settings and should not grow them for a fixture.
- **Two frontends, one IR, one emitter.** JSX and the `ui` tag both build
  `IRNode`s and both hand them to `emit()`, so there is exactly one
  implementation of what a template _means_. Build-time and runtime parsing
  separately is the failure SIG-69 exists to prevent: a template that behaves
  differently after `sigil build` than it did in development is close to
  undebuggable. `test/template/tag.test.ts` asserts the two build the same tree
  from the same template, and it has already caught a divergence introduced by
  a fix to something else.
- **JSX is the canonical syntax and the `ui` tag is the zero-build one, because
  Node's type stripping does not handle JSX and will not.** Stripping is erasure
  and JSX is a transform, so a `.tsx` command module cannot run under the rule
  recorded above that a command module may be TypeScript with nothing compiling
  it. What JSX buys in exchange is what a tagged template cannot have: prop type
  checking, completion, go-to-definition and rename, in every editor, with no
  extension installed.
- **A function-valued prop or child is reactive; a value is static.** `{count}`
  is reactive, `{count()}` is a snapshot, `{() => count() * 2}` is reactive. It
  is the convention `renderer/control.ts` already follows, where `ShowProps.when`
  is `() => T`. Solid reaches fine-grained JSX by compiling `{count() * 2}` into
  a getter and pays for it by having JSX mean different things compiled and
  uncompiled; here no compiler rewrites an expression, so a build step is a
  **pure optimizer** -- it may hoist, fold, resolve class names and pre-measure,
  and it may not change what anything evaluates to. The price is
  `{() => count() * 2}`, which for CLI-sized templates is cheap, and `{count}`
  for the bare accessor is shorter than Solid's `{count()}`.
- **The interpolation is `${}` because it is the only one there is.** A template
  literal splits on `${}` and nothing else, so `{expr}` arrives as literal text
  and evaluating it would need `new Function` -- which the backends rule out.
  Not a preference.
- **A component is interpolated in the tag, never named.** `<${Counter} />`,
  because a tag function has no scope to look a name up in: the alternatives are
  a registry, which costs tree-shaking, or this. Host elements stay bare, since
  `box`, `text` and `raw` are the only three and need no lookup.
- **`jsx` and `jsxs` are not the same function, and aliasing them is a
  divergence.** `props.children` is a _single child_ in `jsx` and a _list_ in
  `jsxs`. Treating both as a list flattened `<Kind>{[a]}</Kind>` into one child
  and handed the component `a` where the tag handed it `[a]` -- the same
  template, two trees. An array reaching `jsx()` is one child that happens to be
  an array.
- **Whitespace follows JSX's rule rather than one of our own.** Each line is
  trimmed of the indentation that exists only because the template spans lines,
  blank lines go, and what is left joins with a single space. The first rule --
  drop any run containing a newline -- was right between two elements and wrong
  inside prose: `hello` and `world` on two lines came out `helloworld`, and JSX's
  transform joins them with a space, so the two frontends were different
  languages. A run with no newline in it is the author's, which is what keeps
  the trailing space in `<text>Enter your email: </text>`.
- **A component's whitespace-only text children are dropped; a host element's
  are not.** A host's whitespace is content. A component's children are data it
  interprets, and a stray space is never part of that -- one space before an
  expression made `props.children` the array `[' ', fn]`, so
  `<${Show}> ${(v) => ...}</>` failed with `props.children is not a function`
  while the same template across two lines worked. This is the one place the
  frontends diverge from JSX on purpose, and they diverge together.
- **A boolean in text position is absent rather than the word it spells.**
  `{cond && 'ready'}` is empty when `cond` is false, which is what JSX has
  always done. `appendValue()` skipped a boolean and `stringify()` did not, so
  one rule said twice disagreed: empty as a box's child and the word `false`
  inside a `<text>`. `0` is still `"0"` -- a number is a value somebody meant to
  show.
- **An element in text position is refused, and the check is where the node
  is.** There is no inline layout, so a `<box>` inside a `<text>` has nowhere to
  go. Asked before the content is assembled rather than inside `textValue()` for
  two reasons: JSX evaluates a child before the call, so a nested host arrives
  already built and wrapped as a _slot_ rather than as an element node -- left
  to a `kind` check it was painted as `[object Object]` -- and the node is where
  the source position still is. It is asked in two places for that second
  reason: `textPart()` refuses an element _node_, where the child's own position
  is, and `applyText()` refuses an element that arrived as a slot, where only
  the `<text>`'s position is left. Both refuse before anything is built, because
  an effect's throw is reported rather than raised -- so the dynamic spelling of
  it used to hand back an empty text node and a log where the static spelling
  threw.
- **`<raw>` refuses children rather than discarding them.** It paints its own
  cells, so a child has nowhere to go, and JSX had already built it and left its
  effects on the owner before it was dropped. The rule a property the engine
  ignores already follows: parsing something and doing nothing with it is worse
  than not accepting it.
- **The IR is not serializable, and that is the expression decision rather than
  a second one.** An expression is opaque JavaScript, so `${() => count()}` is a
  closure and no design makes it data. The payoff the ticket wanted -- shipping
  the IR as data to skip shipping a parser -- is already delivered by the build
  emitter producing JS source, which tree-shakes the parser out anyway.
- **Control flow stays `Show` and `For` rather than becoming IR node kinds.**
  SIG-69 originally asked for the opposite and `renderer/control.ts` had already
  recorded the reason against it: those two are the one implementation of what
  mounting and unmounting a branch means, and a second definition in the IR is a
  second thing to keep in agreement. A build emitter that wants something
  tighter recognizes the imported bindings by name.
- **A source position is optional on an IR node, because the production JSX
  transform passes none.** `jsxDEV` carries a file, line and column; `jsx`
  carries nothing; the `ui` tag always knows its line. So an error points at the
  template from the tag and from a dev build, and not from a release one --
  which is the transform's asymmetry rather than ours, and is why `loc` is not
  required.
- **The host prop types are derived from the property table, not listed beside
  it.** `Style` carries every longhand and its resolved type; the shorthands and
  aliases are literal unions on their own tables. `Kebab<>` and `Camel<>` are
  `kebab()` and `camelCase()` written in the type system, so both spellings are
  offered in both directions -- `isKnownProperty('flexFlow')` is true at runtime,
  and offering only the kebab key made `<box flexFlow="column" />` a type error
  and a runtime success.
- **The one list that is written out is the colour properties, and a test pins
  it.** `Color` is `number`, and a conditional type cannot tell a colour from a
  padding -- `T extends Color` matched every numeric property, so
  `<box paddingTop={1} />` was a type error while `<box color={39} />` was legal,
  which is both answers backwards. A colour is spelled and never counted:
  `parseColor()` refuses `"39"`. `test/template/props.test.ts` asserts the list
  against `COLOR_PROPERTIES`, and `test/template/jsx-types.tsx` -- checked by
  `tsconfig.jsx.json` under `pnpm check` -- is what fails if the widening comes
  back, because the runtime test cannot see it.
- **A table that a mapped type reads must keep its keys through the declaration
  emitter.** `keyof typeof SHORTHANDS` was a union inside the package and
  `string` in the published `.d.mts`, because the emitter widens the table to
  `Record<string, Shorthand>` -- so the mapped type became an index signature and
  let every misspelled prop through, for consumers only. Two things caused the
  widening and both are fixed: an `as unknown as Record<...>` cast on the
  literal, and a `__proto__: null` key, which makes TypeScript type the literal
  loosely. The tables close with `satisfies` against a written union and set the
  null prototype with `Object.setPrototypeOf()` afterwards, which is the same
  runtime defense with the keys intact.

- **The two emitters share every leaf, and disagree only about _when_.**
  `emit()` decides the shape of a tree and hands every leaf decision -- is this
  prop reactive, what does this content come to, what does a slot append -- to
  `applyProp()`, `applyText()`, `appendValue()`, `rawElement()` and
  `rootElement()`. The build emitter in `@ttylabs/cli` calls the same five. So
  the two cannot come to _disagree_ about what a prop or a child means; they can
  only differ over which of those answers was settled ahead of time, and
  settling one ahead of time is the definition of a pure optimizer. The shape it
  replaced had one implementation of the thunk rule inside `emit()` and would
  have grown a second inside the toolchain, which is the drift SIG-72 exists to
  prevent, written as code rather than as a promise.
- **`parse()` is separable from `emit()`, and `Expr` is the hole that leaves.**
  A compiler reads a template out of a file, so every `${...}` in it is text:
  the shape of the tree is knowable and what was interpolated is not. It parses
  with _this_ parser, an `Expr` per interpolation, because a toolchain with a
  parser of its own is the second parser this design cannot afford -- the day
  the two disagreed about whitespace or about a closing tag is the day a
  template means one thing before `sigil build` and another after. So `Expr`
  lives in the IR rather than in `@ttylabs/cli`: nothing at runtime makes one,
  and every helper above refuses one by name rather than letting a prop object
  reach the cascade several layers from the mistake. Two `Expr`s are compared by
  their source rather than by identity, since a compiler makes a fresh one per
  interpolation and `</${Counter}>` is never the same object as the
  `<${Counter}>` it closes.
- **The analysis pass rewrites the IR rather than marking it.** SIG-69 handed
  this over as marks, with the warning that marks nothing reads are marks that
  go stale; the answer to that is not to be careful with the marks, it is to
  have none. A fold is written into the IR, so the build emitter prints
  `text("Counter")` because the node says one literal child -- not because a
  flag beside it claims the children were static. There is no second copy of the
  truth to keep in agreement, and the rewritten IR still runs through `emit()`,
  which is what makes "the analyzer may not change what anything builds" a test
  over the corpus rather than a sentence in a comment.
- **What it folds is a `<text>`'s content and a box child that is already a
  string.** Both are exactly what `applyText()` and `appendValue()` do at run
  time, done once instead of per mount; adjacent literals merge only inside a
  `<text>`, because a box's two text children are two flex items and merging
  them there would delete one. It is conservative about anything that is not a
  primitive, since `textValue()` throws on an element and a fold must not turn a
  run-time error into a build-time one. The asymmetry is worth knowing: `${7}`
  folds on the interpreted path and _cannot_ on the build path, where it is an
  `Expr` -- so the two paths run different code and are asserted to produce the
  same tree, which is the whole point of the corpus.
- **A static prop object is hoisted; a static subtree is not.** Hoisting a
  subtree is the optimization everybody reaches for first and it is unsound
  here: Solid hoists a DOM template and _clones_ it per use, and an `Element`
  cannot be cloned -- it is mutable, it has one parent, and a component body
  runs once per instance, so a subtree at module scope would be one tree shared
  by every row of a `For`. That is not a faster right answer. The prop objects
  are safe because `Element.#apply()` reads one and never keeps it; they are
  deduplicated by their source, so two elements with the same props share one,
  and frozen, so a future that keeps one is loud rather than silent. A
  _component's_ props object is never hoisted however static it is: a component
  is handed that object and may keep it, add to it, or pass it on.
- **The constructor takes the static props only where no name is repeated.** Two
  props of one name are written in order and the last one wins, and lifting the
  literal one into the constructor reverses that: `color=${x}` followed by
  `color="red"` is red until the signal moves, and would have been `x` from the
  first frame. Nobody writes it, and the fix is to stop reordering rather than
  to reason about when reordering is safe. Pinned end to end by a corpus entry
  rather than only by the shape of the output, because what is wrong about it is
  a frame and not a line of source.
- **What is decidable from the IR fails the build rather than the frame.** An
  element inside a `<text>`, a `<raw>` with children, a `<raw>` whose measure is
  a value rather than an expression: all answerable without running anything, so
  they are compile errors -- the same rule the utility generator follows by
  parsing every declaration it generates on the way out. It is also why
  `emitRaw()` asks about children _before_ it asks about the measure and the
  paint: children are the half a compiler can answer, and two emitters reporting
  two different faults about one element is the divergence they exist to avoid.
  A component the IR holds as a live function is the one thing the compiler
  refuses that the interpreter accepts, and it has to: there is no source to
  print, and that shape is how a template reaches the IR at run time rather than
  how it reaches a file.
- **The output is JavaScript, it is formatted, and it carries positions rather
  than a source map.** JavaScript because emitting TypeScript is one more thing
  in the pipeline in exchange for typed props nobody reads -- the app's own
  `.tsx` is where its types are. Formatted because it is going to be read
  whatever the intent. Positions rather than a source map because this emitter
  is handed the quasis of one template and not a file: _where in a module_ that
  template sat is what `sigil build` knows, so the map belongs there. What it
  can do it does -- each `loc` is printed into the helper calls that can throw,
  so a compiled template's error names the same line the interpreted one does.
- **It compiles the tag rather than JSX, and it does not find templates in a
  file.** Neither is a gap. A `.tsx` is compiled by the app's own TypeScript
  toolchain into `jsx()` calls, which carry no parser to shake out; the tag is
  the frontend that ships one, so it is the one worth compiling -- and any
  frontend that can produce IR with `Expr` in it, SIG-71's YAML and JSON
  included, compiles through the same emitter. Finding the templates in a
  module, and knowing where to write each expression and the module-scope
  statements back, is `compile-templates.ts`'s -- written now, and described
  under "Compiling an app's templates" in `packages/cli`; it was SIG-73's to
  own because reading an app off disk was already there. The consequence worth
  knowing is that a `ui` template written _inside_ an interpolation is printed
  back verbatim and stays interpreted: an expression is not the compiler's to
  read, and the pipeline finds those the same way it found the outer one.
- **Resolving class names and pre-measuring are deferred with reasons rather
  than omitted.** SIG-69 named both as this pass's work. A resolved class name
  needs the app's stylesheets, which the build owns and one template does not
  have. A measurement needs a width and a resolved style, and a text's
  measurement is cached per width and keyed on the resolved style _object_ --
  so at build time there is no width to pre-measure at and no style to key on.
  They are the build's once it has an app to read.
- **Every name the generated code uses carries the prefix, imports included.**
  That was the whole of what `prefix` was documented to promise and the imports
  were taken bare anyway, which is the one that looks safe and is not: the
  interpreted emitter holds a function reference and never does a scope lookup,
  while the compiled one is spliced into a module this compiler has never seen.
  A component whose prop is called `text` puts a `text` in scope, and
  `const $e0 = text("")` then calls it -- `TypeError: text is not a function`,
  from a template with nothing wrong with it, in the one emitter that cannot
  have the problem's mirror. So `CompiledImport` carries a local beside the
  imported name and the output reads `text as $text`. Found by review rather
  than by the corpus, because a corpus of templates cannot say what is in scope
  where its output lands -- which is why an entry may now ask to be built with
  every imported name **shadowed** by a local. Which names those are is read off
  the compiled module's own imports rather than listed, for the reason
  `COLOR_PROPERTIES` and `INHERITED` are: the list went stale on the first try,
  naming `raw`, which the emitter never imports, and missing `rawElement` and
  `rootElement`, which it does -- so it shadowed a name nothing used and left
  two real ones uncovered.
- **The prefix is a contract, it cuts both ways, and an empty one is refused.**
  It must not occur anywhere in the module the output is spliced into, and that
  is the caller's to guarantee rather than something the emitter can check,
  because it is handed IR and not a file. Outward is the entry above: a local at
  the splice site shadows a generated name. Inward is the same problem read
  backwards, and is the one nobody thinks of -- an interpolated expression is
  printed back into the scope the generated locals are declared in, so a
  template whose expression reads a free variable called `$e0` reads the
  generated `$e0` instead of the author's. Neither is reachable by a caller that
  scans the module for its prefix before choosing it, which is a substring
  search and is `sigil build`'s to do. An empty prefix is refused outright,
  because it hands back bare imports -- the first bug again -- and it is what a
  caller reaches by passing something falsy rather than by meaning it.
- **`__proto__` is written as a computed key, and it is hardening rather than a
  fix.** Written plainly or quoted it is prototype sugar, so
  `Object.freeze({ "__proto__": "x" })` has no own property of that name and the
  prop would be dropped on the way into the constructor. Nothing observable
  depends on it today: `Element`'s prop store is a plain object, so the
  interpreted path's `#props["__proto__"] = "x"` is swallowed by
  `Object.prototype`'s setter and both paths end up with nothing -- measured,
  not reasoned. It is closed anyway because the rule this repo already records
  for the parser's registries is that a name really can be `__proto__`, and the
  day that store becomes null-prototype is the day this becomes a divergence
  nobody would be looking for here.
- **`compile()` takes a module's templates, not one template.** Imports, the
  hoisted block and the prefix are all facts about a _module_; compiling one
  template at a time made the caller merge all three, and merging is where one
  answer becomes several. Twenty templates each asking for `text` under their
  own prefix is twenty aliases for one import, and two templates that share a
  prop set share nothing. One call, one prefix, one hoisted block that
  deduplicates across every template in the file -- and `renderImports()` stays,
  because printing is still worth doing in one place.
- **A printed expression gets a newline before its closing paren when it could
  open a line comment.** An expression ending `foo // why` swallows whatever
  follows it on that line, which is the `)` the emitter has just written: a
  `SyntaxError` in the generated module, again from a template with nothing
  wrong with it. Asked with `includes('//')` rather than by tokenizing, which is
  sound in the direction that matters -- a source with no `//` in it cannot open
  one, and a `//` inside a string costs a newline and nothing else. `(0, expr)`
  was the other candidate and is wrong: it unbinds `this`, so the component
  callee `(0, scope.Show)` would stop being a method call. The callee goes
  through the same function as every other expression now, since it was the one
  written out in two places -- which is how one of them comes to be missing a
  rule the other has.
- **Both sides of the differential test are generated from one corpus, and
  nothing about a divergence is loud.** A compiled template that builds a
  slightly different tree renders, lays out and paints perfectly happily; the
  only person who finds out is the one who ran `sigil build` and noticed their
  app changed. So `test/template-corpus.ts` is data, and `test/emitters.test.ts`
  generates three builders per entry -- interpreted, analyzed, compiled -- into
  modules it imports, comparing the element structure, every element's resolved
  style, and the painted grid in full colour, before and after a signal write.
  Generated rather than hand-written for the reason the fixtures behind
  `template.test.ts` are one component written three ways, and one more besides:
  two hand-written sides can be quietly edited to agree, and one corpus cannot.
  The expression _source_ is what is shared, so the interpreter and the compiler
  are provably given the same expressions to evaluate.
