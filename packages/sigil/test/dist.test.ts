import { dist, graphBytes, shippedModules, staticBuiltins, staticGraph } from './static-graph.js';
import { tempDir } from './temp.js';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * What ships, read as bytes.
 *
 * Everything else in this suite tests `src/`, which is the right default: `dist/`
 * is what the bundler made of it and testing the bundler is not this project's
 * job. This file is the exception, because one property of the output cannot be
 * seen from the source at all -- the minifier constant-folds
 * `String.fromCharCode(0x1b)` back into a raw byte, so the care `src/ansi/codes.ts`
 * takes is undone somewhere nobody was looking.
 *
 * Reads `dist/`, so it needs a build first, which is what `pnpm test` does and
 * what `@ttylabs/cli`'s tests already require.
 *
 * The check that no shipped file carries a raw control character is not here:
 * it is `should ship no raw control character` in
 * `packages/cli/test/cli.test.ts`, which reads every package's `dist/` with one
 * definition of the rule. What stays is the half only this package has.
 */

describe('the shipped bundles', () => {
  const files = shippedModules();

  it('should have been built', () => {
    // a missing `dist/` is a build that did not run, not a passing test
    expect(files.length, `no bundles in ${dist}; run \`pnpm build\``).toBeGreaterThan(0);
  });

  it('should still spell the escapes it needs', () => {
    // the other half of it: escaping them must not have taken them away. The
    // styler cannot work without an `ESC`, and a build that dropped one would
    // pass the control-character check in `packages/cli/test/cli.test.ts` by
    // being wrong
    const ansi = readFileSync(join(dist, 'ansi.mjs'), 'utf8');
    const imported = shippedModules()
      .map((name) => readFileSync(join(dist, name), 'utf8'))
      .join('');

    expect(ansi.length).toBeGreaterThan(0);
    expect(imported).toMatch(/\\x1B/i);
  });
});

/**
 * `"sideEffects": false`, and the one module-scope effect it has to survive.
 *
 * The field tells an app's bundler that a shipped file whose exports go unused
 * can be dropped whole. Exactly one module in `src/` does anything at import
 * beyond building its own values: `style/shorthand.ts` ends with
 * `registerShorthandLookup(shorthandLonghands)`, which fills a hook in
 * `style/properties.ts` so that `transition-property: padding` can expand a
 * shorthand -- `properties.ts` cannot import `shorthand.ts`, which imports it.
 * Dropping that file would leave the hook answering `undefined` and the parse
 * would throw `no such property` on a name that is one.
 *
 * It is safe because the two modules ship in one file, so nothing can keep the
 * reader and drop the registration: a bundler drops a file, never half of one,
 * and a call that writes a binding something kept reads is never shaken out of
 * a file that stays. That is a fact about how tsdown chunked the build rather
 * than about the source, so it is asserted here rather than assumed.
 */
describe('what "sideEffects": false relies on', () => {
  const manifest = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
  ) as { sideEffects?: unknown };

  /** The shipped file holding a string only the given module writes. */
  function holding(marker: string): string[] {
    return shippedModules().filter((name) =>
      readFileSync(join(dist, name), 'utf8').includes(marker)
    );
  }

  it('should declare the package free of import-time effects', () => {
    expect(manifest.sideEffects).toBe(false);
  });

  it('should ship the shorthand registration in the file that reads it', () => {
    // `parseTransitionProperty()` in properties.ts, and `expandShorthand()` in
    // shorthand.ts, the module whose last statement is the registration. The
    // call itself has no marker that survives minification -- both names in it
    // are mangled -- so this asks for the module it ends, which a bundler
    // never splits across files. More than one reader is a stale `dist/` a
    // cached build left chunks in, which is still fine as long as each one
    // carries the registrar beside it
    const reader = holding('Invalid transition-property');
    const registrar = holding('is not a shorthand');

    expect(reader.length).toBeGreaterThan(0);
    expect(registrar).toStrictEqual(reader);
  });
});

/**
 * What grapheme segmentation looks like in a shipped chunk.
 *
 * The `granularity` the one `Intl.Segmenter` in the package is constructed with,
 * which is a string literal rather than a name -- so the minifier keeps it, where
 * `graphemes` and `Segmenter` are a local and a global it is free to rename. The
 * same reason the mouse markers are an exported name and a mode sequence.
 */
const SEGMENTATION = 'grapheme';

/**
 * The chunk the root entry reaches `parse()` through.
 *
 * A hashed name rather than an entry, because the parser is behind an
 * `await import()` -- which is the whole reason it is off the root entry's
 * graph -- so it has to be read out of the specifier rather than named.
 *
 * The **whole static graph** rather than `index.mjs` alone, because which chunk
 * holds the `import()` is rolldown's to decide and it moves: a second entry
 * sharing code with the root one puts `main()` in a shared chunk, so the
 * specifier went from `index.mjs` to a `src-*.mjs` the day `./testing` landed.
 * What this has to find is the deferral, and that is a property of the graph
 * rather than of one file -- the entry staying small is what the size ceiling
 * below is for, and 18.5 kB of parser joining it blows straight through that.
 *
 * @returns The chunk's file name.
 */
function parseChunk(): string {
  for (const name of staticGraph('index.mjs')) {
    const m = readFileSync(join(dist, name), 'utf8').match(
      /import\(`?\.\/(parse-[^`")]+\.mjs)`?\)/
    );

    if (m) {
      return m[1] as string;
    }
  }

  return expect.fail('the root entry no longer reaches parse() through a dynamic import');
}

/**
 * The chunk the `completion` command reaches the emitters through.
 *
 * A hashed name for `parseChunk()`'s reason: the printer is behind an
 * `await import()`, which is the whole point, so it is read out of the
 * specifier. The parse chunk is where the `import()` is, because that is where
 * the command's `run` lives.
 *
 * @returns The chunk's file name.
 */
function printerChunk(): string {
  for (const name of staticGraph(parseChunk())) {
    const m = readFileSync(join(dist, name), 'utf8').match(
      /import\(`?\.\/(completion-[^`")]+\.mjs)`?\)/
    );

    if (m) {
      return m[1] as string;
    }
  }

  return expect.fail('the completion command no longer reaches the emitters dynamically');
}

describe('what importing the package costs', () => {
  /**
   * Names only a component's implementation defines.
   *
   * Class names would not do: `FRAMEWORK_CSS` carries `.sigil-spinner` and
   * every one of its siblings, and that sheet is on the help path because help
   * is themed -- so a search for the *vocabulary* finds the theme and reports
   * the whole component set as loaded when none of it is.
   */
  // one per component, because the presence half below is what stops the absence
  // half going vacuous -- so a component added without a name here is one whose
  // absence from the root entry is pinned by nothing it can be renamed out of.
  // `ScrollBox` was missing for the same reason `createTypewriter` was: the list
  // is not derived from anything, so it is a list somebody has to add to
  const IMPLEMENTATIONS = [
    'createSpinner',
    'createProgress',
    'createMultiProgress',
    'clockView',
    'createTypewriter',
    'largeTextView',
    'createDecrypt',
    'mountLive',
    'PromptError',
    'renderBar',
    'ScrollBox',
    'describeCollapsible',
    'describeTabs',
    'createPager',
    'tableView',
    'enableDebugOverlay',
    'openModal',
    'TextField',
    'showToast',
    'attachTooltip',
    'openMenuSession',
    'menubarControl',
    'Dropdown',
    'markdownView',
    'qrcodeView',
    'commandPalette',
    'noteView',
    'Panel',
    'paneControl',
    'logView',
    'barChartView',
    'taskLog',
    'calendarView',
    'ruleView',
    'paginatorView',
    'outlineView',
    'filePicker',
    'selectRow',
    'treeView',
    'imageView',
    'describeSlider',
  ];

  /** The bundles in a graph that define any of them. */
  const carriers = (graph: Set<string>, symbol: string): string[] =>
    [...graph].filter((name) => readFileSync(join(dist, name), 'utf8').includes(symbol));

  it.each(IMPLEMENTATIONS)('should not load %s to import the package', (symbol) => {
    // `src/index.ts` exports `main`, `command`, `options` and the error
    // handling, and nothing else -- so a CLI that prints one line pays 4 KB
    // rather than the 124 KB the component set comes to. It is true by
    // omission, which is exactly the kind of thing that stops being true when
    // somebody adds `export * from './components/index.js'` for convenience
    // and nothing says so.
    expect(carriers(staticGraph('index.mjs'), symbol)).toEqual([]);
  });

  it.each(IMPLEMENTATIONS)('should load %s to import the components', (symbol) => {
    // the other half, and it is not decoration: a test that only asserts a
    // symbol is absent passes forever the day the symbol is renamed, and
    // would then be pinning nothing at all
    expect(carriers(staticGraph('components.mjs'), symbol)).not.toEqual([]);
  });

  // `runCommand` among them, which the first version left out: it is the export
  // an app actually imports, and dropping it from the barrel while leaving the
  // module reachable kept the presence half green. Which is this file's own rule
  // about an absence-only test, applied to the one name that matters most
  it.each(['runCommand', 'runOnTerminal', 'createTestTerminal', 'already running'])(
    'should not load %s to import the package',
    (symbol) => {
      // the measurement that decided where the testing helpers live. A subpath
      // of the runtime rather than a package of its own -- which is the version
      // skew argument `sigil add` already records, since `runCommand()` has to
      // run the app's *own* `main()` -- and the cost of that is the question a
      // subpath raises: it is permanent public surface on the package every app
      // depends on at run time.
      //
      // It is zero. Nothing on the root entry's graph imports it, so the graph
      // was 7,532 B over the same six modules it was before the testing subpath
      // landed -- 21 B *less*, which is a shared chunk boundary moving and is
      // noise. That figure is a measurement of **that** change rather than of
      // the tree: the entry is **11,991 B** today, which `afterRun`, the quiet
      // axis, output formats and this branch each moved in turn, and a review round caught this
      // sentence claiming the old one in the present tense -- so it is written
      // as of the merge rather than as a standing fact, which is what the
      // instruction further down means. `testing.mjs` is 48,740 B
      // over fifteen modules and is paid only by a module that asks for it,
      // which is a test file -- the same figure src/testing/AGENTS.md records,
      // because two comments disagreeing about one measurement leave a later
      // reader with no way to tell which was measured.
      //
      // An exported name and a string literal, which survive minification where
      // a name that is only ever called does not
      expect(carriers(staticGraph('index.mjs'), symbol)).toEqual([]);
    }
  );

  it.each(['runCommand', 'runOnTerminal', 'createTestTerminal', 'already running'])(
    'should load %s to import the testing helpers',
    (symbol) => {
      // the other half, and it is not decoration: a test that only asserts an
      // absence passes forever the day the symbol is renamed
      expect(carriers(staticGraph('testing.mjs'), symbol)).not.toEqual([]);
    }
  );

  // Two exported names and two string literals, which is this file's own rule
  // rather than a preference: a name that is only ever *called* is one the
  // minifier renames, so it is in no bundle at all and the absence half passes
  // while saying nothing. `mergeLayers` was the first spelling and is exactly
  // that -- it failed the presence half immediately, which is what the presence
  // half is for.
  //
  // The pair is the one SIG-148 asked for in as many words: "nothing in
  // `main()` or `parse()` loads or accepts a config, and a test that says so"
  const CONFIG_MARKERS = [
    'createConfigSync',
    'isWritableStore',
    'Unsafe config key',
    'No writable config layer',
  ];

  it.each(CONFIG_MARKERS)('should not load %s to import the package', (symbol) => {
    // **Core does not load config, and does not accept one either.** Options
    // and config settings are separate and the app decides how to mix them,
    // which is the opposite call from `--help`, `--version` and `completion`:
    // those three the framework can answer identically for every app, and
    // this it cannot -- the ecosystem does not even agree on what the flag is
    // called.
    expect(carriers(staticGraph('index.mjs'), symbol)).toEqual([]);
  });

  it.each(CONFIG_MARKERS)('should load %s to import the config module', (symbol) => {
    // the other half, for the reason every pair above gives
    expect(carriers(staticGraph('config.mjs'), symbol)).not.toEqual([]);
  });

  // Every one of them a **string literal**, which is this file's own rule
  // arriving a second time: `parseArgv` and `initOption` were the first two
  // spellings and are names the minifier renames, so they are in no bundle at
  // all -- measured, `grep -l` over every `dist/*.mjs` finds neither. Both
  // absence halves therefore passed while saying nothing, which is the
  // `mergeLayers` disease one block up, in the test written right after it.
  //
  // One per parser area rather than one, because a parser module can come in as
  // a chunk of its own: measured, `export { initArg } from
  // '../parser/argument/init-arg.js'` in the config barrel adds an
  // `init-arg-*.mjs` and pulls the parse chunk in not at all, so a marker set
  // keyed on `parse`'s own literals cannot see it
  const PARSER_MARKERS = ['Unknown option', 'Expected command', 'Invalid argument', 'Usage:'];

  it.each(PARSER_MARKERS)('should not reach %s to import the config module', (symbol) => {
    // which the packaging measurement assumed and is now a property rather
    // than a coincidence: a config module usable by an app that does not use
    // sigil's parser is a better module than one wired into it
    expect(carriers(staticGraph('config.mjs'), symbol), symbol).toEqual([]);
  });

  it.each(PARSER_MARKERS)(
    'should have %s somewhere in dist, so the absence means something',
    (symbol) => {
      // the presence half, for the reason the pair above gives: an absence over a
      // marker that is in no bundle is an assertion that cannot fail
      expect(
        shippedModules().filter((name) => readFileSync(join(dist, name), 'utf8').includes(symbol)),
        symbol
      ).not.toEqual([]);
    }
  );

  it('should reach exactly the ten modules the measurement names', () => {
    // the markers say what it must not reach and this says it reaches nothing
    // else at all, which is the only form that catches a parser module arriving
    // as a chunk of its own under a name nothing here could have predicted.
    // Ten: the entry, `paths.mjs`, `i18n.mjs`, and the `transform`, `debug`,
    // `env-value`, `mkdir-owner-sync`, `atomic`, `array-index` and `jsonc` chunks --
    // which is the module list the byte figure below is over, so the two
    // cannot come apart.
    // `mkdir-owner-sync` is the write half's: `save()` creates the directory it
    // writes into, which is the "apply the parent directory's owner under sudo"
    // rule the update cache already reads.
    //
    // It was seven until SIG-151, and the eighth is a chunk boundary rather
    // than a module: `completion/installer.ts` writes a completion script with
    // `writeAtomic()` -- a second *caller* rather than a second writer, which
    // is what keeps the symlink and the chown out of a second resolver -- so
    // `atomic.ts` is shared and rolldown splits it out of this entry instead of
    // inlining it. Measured at 38,101 B over seven before and 38,239 over
    // eight after: 138 bytes of preamble for the sharing.
    //
    // The ninth is the same shape again, from SIG-242: `isArrayIndex()` is one
    // definition now where the output formats and the YAML store each had a
    // spelling, and `format.ts` is on the root entry's graph, so the module is
    // shared and split out. Measured at 38,280 B over eight before and 38,672
    // over nine after, the rest of the difference being the store kit's text
    // half; the root entry went from 12,269 B over seven to 12,326 over eight.
    //
    // The tenth is the same shape a third time, from SIG-324: a routed
    // directory's `commands.json` is read with `parseJsonc()`, so the JSONC
    // reader is shared with `routes.ts` and split out of this entry rather than
    // inlined. Measured at 39,576 B over ten after; the root entry did not move,
    // since it reaches the parser only through a dynamic import
    expect([...staticGraph('config.mjs')].sort()).toHaveLength(10);
  });

  it('should cost a module rather than a component', () => {
    const graph = staticGraph('config.mjs');
    const bytes = graphBytes(graph);

    // 38,239 B over eight modules, of which 9,880 B over six is what it starts
    // from: `paths.mjs`, `i18n.mjs`, the `transform` and `debug` chunks, the
    // 66-byte `env-value` chunk the parser shares, and the 525-byte
    // `mkdir-owner-sync` one the update cache shares. The eighth is the atomic
    // write, which SIG-151's installer now shares. The graph is 3.19x the root
    // entry's 11,991 B and a sixth of `components.mjs`'s 245,744 B over 29 --
    // all three measured the same way, which is the only comparison that means
    // anything. It read 38,064 B and 5.06x until a review round measured both:
    // this graph is unchanged by `afterRun` and was already 37 bytes out, and
    // the root entry moved under the ratio. It was 20,649 B over six before the write half, so the span
    // writer, the atomic write and the representability check are about 11.5 KB
    // between them; 32,523 B before the store kit, which is the 102 bytes that
    // costs; and 32,625 B before the watcher, which is 5,439 B and **no new
    // module** -- the entry already reached `debug` through `i18n`. Read
    // again after every change that moves it -- a figure only a re-run can
    // confirm is the stale snapshot this file warns about, and review round 2
    // caught this one carrying the pre-store-kit number while the line below
    // said it must agree with src/config/AGENTS.md. A running tally of how many
    // times is a second such figure, and the two copies of it had drifted to
    // five here and six there, so what is kept is the instruction and not the
    // count.
    //
    // A ceiling rather than a measurement, about 2.4x over what it is, so that
    // ordinary growth never touches it and pulling the parser or the renderer
    // onto it does. The **measured** figure is here and in src/config/AGENTS.md
    // and nowhere else, for the reason the root entry's is: two comments
    // disagreeing about one measurement leave a later reader with no way to
    // tell which was measured. The README carries a rounded "about 39 kB over
    // ten modules" for an app author deciding whether to import it, which is
    // a different statement and names the same ten
    expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(48 * 1024);
  });

  it('should keep the root entry small enough to be worth it', () => {
    const graph = staticGraph('index.mjs');
    const bytes = graphBytes(graph);

    // a ceiling rather than a measurement -- it sits about 1.7x over the 11.7 KB
    // this is today, so ordinary growth never touches it and pulling a
    // rendering path onto the entry blows straight through it. It said 7.5 KB
    // and 2.7x until `afterRun` added 459 B of hook walk and firing to the
    // entry, which a review round caught here as readily as in
    // src/parser/AGENTS.md -- which is the argument for the figure living in
    // two places and no more.
    //
    // 3,825 B of it is SIG-142's output formats, and it is on the entry for one
    // reason: `errorHandler()` serializes an error in the selected format, so
    // the 3,160 B `format` chunk is reachable from the error path every app has.
    // Carrying the resolved serializer on `ParseState` instead would take the
    // chunk off this graph entirely and was weighed and refused -- a name is
    // what a reader, a hook and a test want on the state, and `formatFor()` is
    // deterministic given the schema, so resolving it twice cannot drift.
    //
    // 1,615 B of that chunk is the **loss refusal**, which two review rounds
    // are what bought: `json` walks what it was handed and refuses a value
    // `JSON.stringify` would silently rewrite, so a command returning a `Map`
    // of results no longer pipes `{}`. It cannot be deferred for the reason the
    // rest of the chunk cannot -- `renderError()` is synchronous by design, so
    // there is no `await import()` available on the path that reaches it -- and
    // the trade is 2.3 KB on every app's entry against losing somebody's data
    // without saying so.
    //
    // 4.1 KB of that was the entry before i18n; the 2.2 KB `i18n.mjs` is the
    // tag, the plural and the locale resolution, and it is here because
    // `main()` resolves a locale before `parse()` can throw. Splitting the
    // resolution into a module `main()` imports only when the schema declares
    // `locales` would give about 1.5 KB of it back, and is not done: nothing
    // measures a 1.5 KB module, and it would cost an internal/public split of
    // one barrel. That is the shape to reach for if this ever gets tight.
    expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(20 * 1024);
  });

  it('should not drag grapheme segmentation in to suggest a command', () => {
    // SIG-143 gave the parser a reason to want `fuzzyMatch()`, which lives
    // beside `highlightRuns()` -- and that one is the only thing in that file
    // that reaches for `graphemes()`. Measured both ways: importing
    // `components/fuzzy.js` from the parser puts `width`, `strip` and `codes`
    // on the parse chunk's graph and takes it from 38.8 KB to 43.5 KB, because
    // rolldown does not shake the segmentation back out of a shared chunk. So
    // `fuzzyMatch()` moved to `src/util/fuzzy.ts`, which is the move `seeded()`
    // already made to `src/util/random.ts` and for the same reason.
    //
    // Keyed on the symbol rather than on the chunk's name, and that is this
    // file's own rule rather than a preference: a name filter asserted empty
    // passes forever the day the chunk is renamed, which is what the pair above
    // is written about. `SEGMENTATION` is the `granularity` the one
    // `Intl.Segmenter` in the package is built with, so it is a string literal
    // the minifier keeps and is named for exactly what is being refused
    expect(carriers(staticGraph(parseChunk()), SEGMENTATION)).toEqual([]);
  });

  it('should still reach it to draw, which is the half a rename would fail', () => {
    // the other half, for the reason the component pair gives: an absence on
    // its own pins nothing once the marker stops existing, and help draws text,
    // so it is where the segmentation legitimately is
    expect(carriers(staticGraph('help.mjs'), SEGMENTATION)).not.toEqual([]);
  });

  it('should not drag the drawing stack in to import the key router', () => {
    // the mouse gave the router a reason to reach into the element tree, and
    // reaching it through `element/paint.js` for two lines of arithmetic put the
    // layout engine, the cascade and the canvas behind `sigil/input`: measured at
    // 29 kB before and 93 kB after, for an app that wanted a key router and no
    // rendering at all. `paintOrder()` and `contains()` live in `element/hit.js`
    // instead, which imports nothing but a type -- so this is 33 kB, and the
    // 3.6 kB is the mouse itself.
    //
    // A ceiling rather than a measurement, at about 3x, so ordinary growth never
    // touches it and a barrel import does
    const graph = staticGraph('input.mjs');
    const bytes = graphBytes(graph);

    expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(100 * 1024);
  });

  it('should not drag the parser in to import the components', () => {
    // the worry the palette was written against, and the measurement says it
    // does not happen: a palette reads the command registries through the
    // `Internal` symbol, which is `src/types.ts` and is a 154 B chunk, and
    // coerces a value with `transformValue()`, which is `src/util/transform.ts`
    // and is 1.8 kB. Neither is in `src/parser/` -- so `parse-*.mjs` (18.5 kB)
    // and `option-registry-*.mjs` (7.2 kB) are both absent from the graph, and
    // the components entry grew by 11,008 B rather than by 26 kB.
    //
    // Asserted as an absence by two string literals, which survive
    // minification where a name that is only ever called does not -- the first
    // spelling of this looked for `parseArgv` and the minifier renames it, so
    // it was in no bundle at all and the test said nothing.
    //
    // What it pins is `parse.ts` specifically rather than everything under
    // `src/parser/`, which a sabotage established: importing `initArg` from
    // there leaves the graph where it was, because that module is a leaf
    // rolldown puts in this chunk. Importing `parse` itself fails this and
    // takes the graph to 253,201 B, about 29 kB more -- which is what the
    // palette does not cost
    const graph = staticGraph('components.mjs');
    const shipped = new Set(shippedModules());

    for (const marker of ['Extra arguments are not allowed', 'Missing required arguments']) {
      // the presence half first, because an absence alone passes forever the
      // day the marker stops being in the output -- `parseArgv` was the first
      // spelling of this and the minifier renames a function nothing exports,
      // so it was in no bundle at all and the test said nothing
      expect(carriers(shipped, marker), marker).not.toEqual([]);
      expect(carriers(graph, marker), marker).toEqual([]);
    }

    // and the other side of it: the coercion really is the parser's own, in the
    // bytes rather than in the source
    expect(carriers(graph, 'Invalid boolean')).not.toEqual([]);
  });

  it('should keep the coerce subpath to the coercion and off the root entry', () => {
    // `@ttylabs/sigil/coerce` is what an ejected `date()`, `number()` or palette
    // reads the parser's own coercion through. It is a subpath and not a name on
    // the root because it is parser weight: a command that only answers
    // `--version` must not load it, and it is not in the root's static graph
    const root = staticGraph('index.mjs');
    const coerce = staticGraph('coerce.mjs');

    expect(
      [...root].filter((name) => name.startsWith('coerce')),
      'coerce in the root'
    ).toEqual([]);

    // the presence half first: the coercion really is in its graph, and the
    // parser proper really is not -- a re-export of `transform.ts` must not
    // grow into an import of `parse.ts`
    expect(carriers(coerce, 'Invalid boolean')).not.toEqual([]);
    for (const marker of ['Extra arguments are not allowed', 'Missing required arguments']) {
      expect(carriers(coerce, marker), marker).toEqual([]);
    }

    // measured at 7,529 B over four modules as of SIG-201, of which the
    // coercion itself is nearly all, and 7,563 as of SIG-328, which moved the
    // ceiling from 24 KiB -- about 3x -- to the 2x the rest of the entries are
    // held to: ordinary growth never touches it and the parser arriving does
    const bytes = graphBytes(coerce);
    expect(bytes, `${[...coerce].join(', ')}`).toBeLessThan(16 * 1024);
  });

  it("should keep zlib out of the canvas, which checks a picture with the codec's own check", () => {
    // `resampleImage()` asks `assertRgbaImage()` from `png/image.ts` rather than
    // from the subpath's barrel, because the barrel is the codec: about 10 kB,
    // and the `node:zlib` it asks for when it encodes or decodes, which since
    // SIG-328 is a `getBuiltinModule()` call rather than an import -- so the
    // specifier is still in the codec's bytes, and still the marker that it
    // arrived. The presence half: the check really is in the canvas
    const canvas = staticGraph('canvas.mjs');
    expect(carriers(canvas, 'node:zlib')).toEqual([]);
    expect(carriers(canvas, 'expects a width and height')).not.toEqual([]);
  });

  it('should keep the png subpath to the codec and off the root entry', () => {
    // `@ttylabs/sigil/png` is read by whatever draws an image and by whatever
    // writes a screenshot, and by nothing that only parses argv -- so it is a
    // subpath, the root entry's graph does not reach it, and its own graph is
    // the codec plus the `__` tag its errors are written in
    const root = staticGraph('index.mjs');
    const png = staticGraph('png.mjs');

    expect(
      [...root].filter((name) => name.startsWith('png')),
      'png in the root'
    ).toEqual([]);

    // the presence half: both directions really are in it, and the parser and
    // the drawing stack really are not
    expect(carriers(png, 'Not a PNG file')).not.toEqual([]);
    expect(carriers(png, 'IEND')).not.toEqual([]);
    for (const marker of ['Missing required arguments', SEGMENTATION]) {
      expect(carriers(png, marker), marker).toEqual([]);
    }

    // measured at 14,344 B over three modules as of SIG-114, of which the codec
    // is 10,365; a ceiling at about 2x, so ordinary growth never touches it and
    // anything that is not a codec arriving does
    const bytes = graphBytes(png);
    expect(bytes, `${[...png].join(', ')}`).toBeLessThan(28 * 1024);
  });

  it('should keep the highlight subpath to the lexers, with nothing they feed behind them', () => {
    // SIG-289: `highlightCode()` imports the seam's span type and no value, so a
    // pager, a log viewer or a browser page can colour code without loading the
    // element tree, the prompts or the theme. A value import from a sibling --
    // `TOKEN_ROLE` from the prompt module is the obvious slip -- would put the
    // whole component stack behind it, which this is here to catch
    const graph = staticGraph('components/highlight.mjs');

    expect([...graph].sort(), 'the facade and the lexers, and nothing else').toEqual([
      'components/highlight.mjs',
      expect.stringMatching(/^highlight-[\w-]+\.mjs$/),
    ]);
    expect(staticBuiltins(graph)).toEqual([]);
  });

  it('should keep the suggest subpath free of anything a browser cannot load', () => {
    // `@ttylabs/sigil/suggest` exists so that the website's 404 page can ask the
    // parser's own "did you mean" rule in the browser. The parser's module
    // reaches i18n and the debug logger, which import `node:` modules, and a
    // bundler building a browser page refuses those -- Turbopack panics on
    // `node:console` from `/components`. So the whole static graph has to be free
    // of them, and of the parser, which is what would bring them back.
    const graph = staticGraph('suggest.mjs');

    for (const name of graph) {
      const source = readFileSync(join(dist, name), 'utf8');
      expect(source, `${name} imports a node: module`).not.toMatch(/\bfrom\s*["']node:/);
      expect(source, `${name} imports a node: module`).not.toMatch(/\bimport\s*\(?\s*["']node:/);
    }

    // the presence half: the edit distance really is in it, and the parser's
    // sentences really are not
    expect([...graph].join(', ')).not.toMatch(/\bparse-|\bi18n|\bdebug-/);
    expect(carriers(graph, 'Unknown command')).toEqual([]);

    // measured at 685 B over the shared `fuzzy` chunk as of SIG-268 and 1,344
    // over two as of SIG-328, which moved the ceiling from 8 KiB -- six times
    // what it guards -- to about 2x: ordinary growth never touches it and the
    // parser arriving does
    const bytes = graphBytes(graph);
    expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(3 * 1024);
  });

  it('should not put the prompts on the path that only prints a script', () => {
    // the whole packaging argument for SIG-151. `app completion bash > file` is
    // the scriptable form and loads the printer: the prompt chunk's own graph is
    // 192,027 B over 24 modules, which is three times the printer's, so a
    // statically imported `confirm()` would make the redirect pay for an
    // installer it never reaches.
    //
    // `interactive.ts` is the module that holds them and the command reaches it
    // through `await import()`, so what is asserted is that the **printer's**
    // graph names no prompt -- and the presence half beside it, because an
    // absence alone passes forever the day the marker is reworded.
    //
    // Measured: the printer is 63,718 B over 12 modules and the interactive
    // path is 261,480 over 37, so the whole of what the installer and the
    // prompts add is +197,762 and +25 -- which is a different subtraction from
    // the figure above and the two were read as one for a commit. The estimate
    // the ticket was taken on was +180 kB, which held.
    //
    // Re-measure rather than quote, which these have now needed twice: they
    // moved by 1,218 B when the first review round's fixes landed in
    // `interactive.ts`, and again when `main` was merged in -- the quiet axis
    // and `afterRun` both grew the graphs underneath. That is the staleness the
    // comment three hundred lines up is written about, and a merge moves these
    // figures exactly as an edit does
    const shipped = new Set(shippedModules());
    const printer = printerChunk();

    for (const marker of ['because the input is not a terminal', 'Choose at least one']) {
      expect(carriers(shipped, marker), marker).not.toEqual([]);
      expect(carriers(staticGraph(printer), marker), marker).toEqual([]);
    }

    // and the other side of it: the printer really is what prints
    expect(carriers(staticGraph(printer), '#compdef ')).not.toEqual([]);
  });

  it('should keep the completion installer off the root entry', () => {
    // it writes files into a home directory, so every module it needs --
    // `config/atomic.ts`, `paths.ts`, `mkdir-owner-sync.ts` -- would be on the
    // path a `--version` takes if the command reached it statically. The
    // command is on the parse path by construction, because a `choices` list
    // has to exist while the schema is built; the installer is two dynamic
    // imports past it
    const shipped = new Set(shippedModules());
    const root = staticGraph('index.mjs');

    for (const marker of ['was not written by sigil', 'bash-completion']) {
      expect(carriers(shipped, marker), marker).not.toEqual([]);
      expect(carriers(root, marker), marker).toEqual([]);
    }
  });

  it('should keep the components entry worth importing for one component', () => {
    // 245,744 B over 29 modules when SIG-136 merged -- re-measured then,
    // because it read 234,912 over 23 while the comment 130 lines up said
    // 239,929 over 26, which is the two-comments-disagreeing-about-one-
    // measurement defect that one is written about, in the same file. Of it the
    // palette is 10,624: its own code, the 1,778 B `transform` chunk, the 154 B
    // `types` chunk and 180 B of class names in `FRAMEWORK_CSS`, which ships
    // because the vocabulary comment is inside the template literal. The QR
    // encoder is another 10,255 of it, which is what moved this figure when
    // SIG-136 merged.
    //
    // 328,125 B over 31 when SIG-181 merged, which crossed the 320 KiB this
    // ceiling was: `main` was already at 324,756, and the outline added 3,369 B
    // of its own code and class names and no module at all. That is ordinary
    // growth, which a ceiling exists not to catch, so the ceiling moved -- to
    // 1.4x of the new figure, which is the ratio it was set at
    //
    // 472,476 B over 37 when SIG-326 added the image component, which crossed
    // the 448 KiB the ceiling had been moved to: `main` was at 457,132 over 36,
    // already 1.003x under it rather than the 1.4x it was set at. Of the 15,344
    // the image added, 5,021 are its own -- the component, the box filter in
    // `canvas/image.ts` and `quantizeColor()` -- and 10,323 are the PNG codec,
    // the one new module, which `imageView()` decodes bytes with. Ordinary
    // growth, so the ceiling moved to 640 KiB, which is 1.39x of the new figure
    //
    // 473,873 B over 38 as of SIG-328, which audited every entry to win that
    // back and did not: what it took out of this entry was load **time** --
    // zlib, `child_process` and `util` became `getBuiltinModule()` calls inside
    // the functions that need them, 15.3 ms to 14.1 ms of a fresh node's import
    // -- and the bytes are where they were, because the codec is decoded when
    // `imageView()` is built and so cannot be loaded later without making that
    // asynchronous. So the ceiling stays: 640 KiB is already 1.38x, under the 2x
    // the other entries are held to, and moving it either way would be a number
    // changed for its own sake. The audit is in src/testing/AGENTS.md
    //
    // 496,422 B over 110 as of SIG-330, which gave every component a subpath of
    // its own: the component code that was all in `components.mjs` is now one
    // chunk per module so that a subpath loads only its own, and the barrel
    // imports all of them. From 473,873 B over 38, and the 22.5 kB is the import
    // and export statements between those chunks, which went from about 14 kB
    // to 38 kB of the graph. The modules are what an unbundled import of the
    // barrel pays for -- about 6 ms more, measured in src/components/AGENTS.md
    // -- and the bytes are ordinary growth, so the ceiling stays, at 1.32x
    //
    // A ceiling rather than a measurement, at about 1.4x, so ordinary growth
    // never touches it and a second runtime stack does
    const graph = staticGraph('components.mjs');
    const bytes = graphBytes(graph);

    expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(640 * 1024);
  });

  // SIG-183 put seven spinner sets in the components entry and the rest in the
  // registry, at 803 B on the graph above (337,387 to 338,190 over the same 31
  // modules). The point of the split is that the long tail costs an app nothing
  // until it is copied in, which is true only while nothing in `src/` imports
  // `spinner-frames.ts` -- so a glyph only that file draws is asked of every
  // shipped file, beside one from each side of the built-ins as the presence half
  it.each(['✺', '⊶', '◰', '⣾', '◢'])('should leave the long-tail spinner glyph %s out', (glyph) => {
    const shipped = new Set(shippedModules());
    expect(carriers(shipped, glyph)).toEqual([]);
  });

  it.each(['◜', '◴', '↙'])('should ship the built-in spinner glyph %s', (glyph) => {
    expect(carriers(staticGraph('components.mjs'), glyph)).not.toEqual([]);
  });

  // `mouseenter` and the mode sequence rather than `hitTest` and `enableMouse`: a
  // name that is only ever called is renamed by the minifier, while an exported one
  // and a string literal survive. The other half of the ceiling above, for the
  // reason the component list gives -- a test that only asserts an absence passes
  // forever the day the symbol is renamed
  it.each(['parseMouseReport', 'mouseenter', '?1006h', '?1003h'])(
    'should load %s to import the router',
    (symbol) => {
      expect(carriers(staticGraph('input.mjs'), symbol)).not.toEqual([]);
    }
  );

  // The measurement `@ttylabs/sigil/app` is a subpath of its own for: the runner is
  // the one module that needs the router, the framework sheet and the renderer at
  // once, and the renderer keeps the first two off its graph on purpose -- a spinner
  // pays for neither. Folded into `renderer` it would have grown that graph by the
  // 38 KB of the router chunk and the theme. A router string, a framework-sheet
  // selector and the runner's own message, each absent from one graph and present
  // in the other, so that neither half can pass by a rename
  it.each(['mouseenter', '.sigil-text-field', 'outside runApp()'])(
    'should not load %s to import the renderer',
    (symbol) => {
      expect(carriers(staticGraph('renderer.mjs'), symbol)).toEqual([]);
    }
  );

  // The runner captures the console by default (SIG-310), so it needs the ring and
  // the patch -- which live in a module of their own so that it does not need the
  // overlay's pane, scroll box and stats line with them. A string the pane draws,
  // absent from the runner's graph and present in the components one, and the
  // patch's own presence in the runner's, so the split cannot pass by a rename
  it('should not load the debug pane to import the app runner', () => {
    expect(carriers(staticGraph('app.mjs'), 'stats off')).toEqual([]);
    expect(carriers(staticGraph('components.mjs'), 'stats off')).not.toEqual([]);
  });

  it('should load the console patch to import the app runner', () => {
    // `node:util` is asked for by the capture and by nothing else on this graph
    expect(asks(staticGraph('app.mjs'), 'node:util')).not.toEqual([]);
  });

  it.each(['mouseenter', '.sigil-text-field', 'outside runApp()'])(
    'should load %s to import the app runner',
    (symbol) => {
      expect(carriers(staticGraph('app.mjs'), symbol)).not.toEqual([]);
    }
  );
});

/**
 * Whether a graph asks for a builtin lazily, through `process.getBuiltinModule()`.
 *
 * A pattern rather than a fixed string, because the quote is the minifier's to
 * pick: the source says `'node:zlib'` and the bundle says it with backticks,
 * while the update worker -- baked in as text -- keeps the source's.
 */
function asks(graph: Set<string>, builtin: string): string[] {
  const re = new RegExp(`getBuiltinModule\\(\\s*[\`'"]${builtin}[\`'"]\\s*\\)`);
  return [...graph].filter((name) => re.test(readFileSync(join(dist, name), 'utf8')));
}

/**
 * The builtins node has loaded, by name, once `entry` is imported -- and again
 * once each of `then` has been asked for.
 *
 * In a fresh node, because a builtin loaded is loaded for the life of the
 * process. Read off `process.moduleLoadList` whole rather than as a difference
 * from before the import, so that a builtin node had already loaded at startup
 * reads as loaded here and fails the absence below rather than passing it.
 */
function loadedBy(entry: string, then: string[]): { atImport: string[]; asked: string[] } {
  const probe = `
    const names = () => process.moduleLoadList
      .filter((m) => m.startsWith('NativeModule '))
      .map((m) => 'node:' + m.slice('NativeModule '.length));
    await import(process.argv[1]);
    const atImport = names();
    for (const b of process.argv.slice(2)) process.getBuiltinModule(b);
    process.stdout.write(JSON.stringify({ atImport, asked: names() }));
  `;
  // without NODE_OPTIONS, so that whatever loader a test runner was started
  // with is not counted against the entry
  const { NODE_OPTIONS: _ignored, ...env } = process.env;
  return JSON.parse(
    execFileSync(
      process.execPath,
      ['--input-type=module', '-e', probe, pathToFileURL(join(dist, entry)).href, ...then],
      { encoding: 'utf8', env }
    )
  );
}

describe('the builtins an entry loads, and the ones it only asks for', () => {
  // SIG-328's audit, pinned. Each of these is a builtin the entry needs inside
  // a function and not at load, and each was measured as the costliest thing
  // left on that entry's import: `node:https` is `tls`, `net` and `http` behind
  // it, about 3.4 ms of a fresh node's; `node:crypto` about 2 ms; `node:zlib`
  // about 0.7. They are `process.getBuiltinModule()` calls now, which is
  // synchronous, so `decodePng()`, `encodePng()` and every write kept their
  // signatures. `node:util` is in the static half only: node has it loaded
  // before any user code runs, and what its ESM import cost was the
  // `worker_threads` and stream stack the facade pulled in behind it
  const LAZY: [string, string][] = [
    ['components.mjs', 'node:zlib'],
    ['components.mjs', 'node:child_process'],
    ['components.mjs', 'node:util'],
    ['png.mjs', 'node:zlib'],
    ['config.mjs', 'node:crypto'],
    ['updates.mjs', 'node:https'],
    ['updates.mjs', 'node:child_process'],
  ];

  it.each(LAZY)('should not import %s at load: %s', (entry, builtin) => {
    const graph = staticGraph(entry);
    expect(staticBuiltins(graph)).not.toContain(builtin);
    // the presence half, for the reason every pair above gives: the code that
    // needs it is still in the graph and still asks for it, so the absence is
    // about how it is reached rather than about it having gone
    expect(asks(graph, builtin), `${entry} no longer asks for ${builtin}`).not.toEqual([]);
  });

  it('should still see a static import, which is the half that keeps the table honest', () => {
    // `staticBuiltins()` reads one spelling of an import, the minifier's, and a
    // reader that matched nothing would pass every absence above forever. So it
    // is asked about imports that are really there, one per entry in the table
    expect(staticBuiltins(staticGraph('components.mjs'))).toContain('node:fs');
    expect(staticBuiltins(staticGraph('png.mjs'))).toContain('node:buffer');
    expect(staticBuiltins(staticGraph('config.mjs'))).toContain('node:fs/promises');
    expect(staticBuiltins(staticGraph('updates.mjs'))).toContain('node:fs');
  });

  it('should not read an import that is only text in a string', () => {
    // the case the spelling is chosen for: the update worker is baked into
    // `updates.mjs` as a string, imports and all. Asked of a module written for
    // it rather than of the shipped one, because the worker's one remaining
    // import is `node:fs`, which that chunk also imports for real -- so the
    // shipped bytes cannot tell a reader that ignores the string from one that
    // does not, and review round 1 found this assertion passing either way
    const dir = tempDir('sigil-static-builtins-');
    writeFileSync(
      join(dir, 'entry.mjs'),
      'import{a as b}from"node:fs";const w=`import https from \'node:https\';\nimport "node:zlib";`;export{b,w};'
    );
    expect(staticBuiltins(staticGraph('entry.mjs', dir), dir)).toEqual(['node:fs']);
  });

  // the runtime half, which the static one cannot be: a `getBuiltinModule()`
  // call at module level loads the builtin as surely as an import does and is
  // in no import list -- and the encoder's deflate options were one in waiting,
  // an object at module level reading zlib's `constants`, which spelled as a
  // `zlib().constants` would have loaded zlib at import with no import in sight.
  // Here the entry is imported and the process asked what it loaded. `tls` stands for the
  // https stack, since `https` is what was asked for and `tls` is what cost
  const LOADED: [string, string[]][] = [
    ['components.mjs', ['node:zlib', 'node:child_process']],
    ['png.mjs', ['node:zlib']],
    ['config.mjs', ['node:crypto']],
    ['updates.mjs', ['node:https', 'node:tls', 'node:child_process']],
  ];

  it.each(LOADED)('should load none of them to import %s: %j', (entry, builtins) => {
    const { asked, atImport } = loadedBy(entry, builtins);
    for (const builtin of builtins) {
      expect(atImport, `${entry} loads ${builtin} at import`).not.toContain(builtin);
      // the presence half: asking for it does load it, in a list read the same
      // way -- so a `moduleLoadList` that stopped naming builtins like this
      // would fail here rather than pass the absence
      expect(asked, `asking for ${builtin} did not load it`).toContain(builtin);
    }
  });
});

/**
 * Every published entry's byte ceiling, about 2x what it measured as of SIG-328.
 *
 * The convention every dedicated ceiling above already follows, extended to the
 * entries that had none -- which was most of them, so an entry could double and
 * nothing would say so. In KiB; what each measured is the second figure, and it
 * is a measurement **as of SIG-328** rather than a claim about the tree, which
 * is the root AGENTS.md's rule about byte figures -- and as of SIG-330 for the
 * `components/` subpaths, which that ticket added. The entries with a test of
 * their own keep it and are listed in `DEDICATED`, so that no entry has two
 * ceilings to disagree.
 */
const CEILINGS: Record<string, [kib: number, measured: number]> = {
  ansi: [16, 7_790],
  app: [400, 207_114],
  canvas: [76, 38_777],
  // a component's subpath, as of SIG-330: its own module and the stack it is
  // drawn with, which is most of every figure here
  'components/autocomplete': [488, 248_844],
  'components/badge': [316, 162_783],
  // as of SIG-277, which added these three after the rest were measured
  'components/border-label': [260, 133_586],
  // as of SIG-199, which added the four form controls and `control`, what they
  // share -- button, checkbox, control, radio-set and switch
  'components/button': [388, 197_258],
  'components/calendar': [484, 248_571],
  'components/catalog': [6, 2_800],
  'components/chart': [396, 201_844],
  'components/checkbox': [488, 248_863],
  'components/clock': [384, 196_045],
  'components/collapsible': [380, 193_603],
  // added when SIG-309 gave every component one colour-level rule
  'components/color-level': [16, 7_639],
  // added when SIG-310 split the ring and the console patch out of the overlay
  'components/console-capture': [4, 1_573],
  'components/control': [332, 168_553],
  // SIG-281, measured when it was added
  'components/data-table': [464, 235_819],
  'components/date': [496, 253_149],
  'components/debug-overlay': [272, 140_286],
  'components/decrypt': [384, 196_337],
  'components/diff': [488, 249_598],
  // as of SIG-285, which added the menus and the overlay plumbing they share
  'components/dropdown': [424, 216_762],
  'components/editing': [12, 5_876],
  'components/editor': [480, 245_196],
  'components/file-picker': [492, 252_742],
  'components/fuzzy': [11, 5_500],
  'components/group': [468, 240_621],
  'components/group-multiselect': [476, 244_308],
  // SIG-289, measured when it was added: the lexers and nothing else, since the
  // module imports only a type -- which is what lets a highlighter be imported
  // without the component stack it feeds
  'components/highlight': [28, 14_145],
  'components/image': [344, 176_806],
  'components/key-help': [332, 169_903],
  'components/keys': [6, 2_860],
  'components/large-text': [324, 165_478],
  'components/list': [472, 241_986],
  // SIG-280, measured when it was added
  'components/list-view': [408, 209_306],
  'components/log': [488, 248_992],
  'components/log-stream': [20, 10_089],
  'components/markdown': [516, 264_822],
  'components/markdown-parse': [32, 15_970],
  'components/masked-text': [476, 243_856],
  'components/menu': [416, 213_145],
  'components/menubar': [424, 216_148],
  'components/modal': [388, 198_373],
  'components/mount': [372, 190_145],
  'components/multi-progress': [384, 196_030],
  'components/note': [316, 162_044],
  'components/number': [480, 246_689],
  'components/outline': [384, 195_717],
  'components/overlay': [260, 132_920],
  // added when SIG-305 gave seven components one way to refuse a hook they own
  'components/owned-hooks': [9, 4_273],
  'components/pager': [428, 219_265],
  'components/paginator': [380, 194_228],
  'components/palette': [492, 252_125],
  'components/pane': [392, 201_988],
  'components/panel': [384, 196_687],
  'components/path': [484, 248_156],
  'components/progress': [380, 193_936],
  'components/prompt': [468, 240_102],
  'components/qrcode': [332, 169_062],
  'components/radio-set': [492, 250_508],
  'components/rule': [320, 163_424],
  // SIG-280: a row is built under an owner of its own, which is the renderer's --
  // 174,349 B over 28 modules, from 136,485, and still under the ceiling it had
  'components/scroll-box': [268, 136_485],
  'components/select-key': [476, 243_021],
  'components/select-row': [480, 245_393],
  // as of SIG-286, which added it
  'components/slider': [392, 200_048],
  'components/sort': [476, 242_891],
  'components/spinner': [380, 194_847],
  'components/switch': [488, 249_814],
  'components/table': [316, 162_282],
  'components/tabs': [384, 196_349],
  'components/tasks': [400, 203_977],
  'components/text-area': [512, 260_642],
  'components/text-field': [472, 242_489],
  'components/toast': [380, 195_187],
  'components/toggle': [472, 241_207],
  'components/tooltip': [380, 195_074],
  'components/tree': [512, 262_589],
  // SIG-282, measured when it was added: the tree's module and the list view's,
  // which it is built on
  'components/tree-list-view': [568, 289_948],
  'components/typewriter': [376, 192_912],
  element: [256, 131_505],
  'error-handler': [16, 8_422],
  help: [360, 184_164],
  i18n: [8, 3_979],
  'i18n-keys': [18, 9_446],
  'jsx-dev-runtime': [336, 170_545],
  'jsx-runtime': [336, 170_311],
  layout: [26, 13_269],
  paths: [4, 1_855],
  reference: [82, 41_961],
  renderer: [328, 166_513],
  // SIG-324: a `commands.json` is read with the config module's JSONC reader,
  // which brings `__` and the debug logger with it -- 2,604 B over two before
  routes: [22, 10_979],
  signals: [14, 6_776],
  style: [148, 75_603],
  template: [340, 174_120],
  terminal: [30, 15_242],
  testing: [100, 51_372],
  theme: [188, 96_225],
  themes: [8, 4_119],
  updates: [36, 18_536],
  width: [8, 4_220],
  which: [3, 1_446],
  wrap: [18, 9_157],
};

/** The entries whose ceiling is a test of its own, above. */
const DEDICATED = ['index', 'coerce', 'components', 'config', 'input', 'png', 'suggest'];

describe('what each entry costs', () => {
  it('should hold every published entry to a ceiling', () => {
    // derived from the manifest rather than listed, because a list somebody has
    // to add to is how `ScrollBox` went unpinned above: a new subpath without a
    // ceiling fails here, naming itself
    const manifest = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8')
    ) as { exports: Record<string, unknown> };
    const published = Object.keys(manifest.exports)
      .filter((key) => key !== './package.json')
      .map((key) => (key === '.' ? 'index' : key.slice(2)))
      .sort();

    expect([...Object.keys(CEILINGS), ...DEDICATED].sort()).toEqual(published);
  });

  it.each(Object.entries(CEILINGS))('should keep %s under its ceiling', (entry, [kib]) => {
    const graph = staticGraph(`${entry}.mjs`);
    expect(graphBytes(graph), [...graph].join(', ')).toBeLessThan(kib * 1024);
  });
});

// `src/updates/worker.ts` is piped into a runtime rather than imported on the
// spawned path, and a file nothing imports is a file no bundler can see -- so
// `workerSource()` read it off a path relative to its own module URL, which
// points wherever the bundle was written. Every app `sigil build` produced
// died on `ENOENT` the first time it checked for an update, with the build
// reporting complete success. `tsdown.config.ts` bakes the worker in as a
// string instead, and a build that quietly stops doing that looks exactly like
// one that does.
describe('the update worker, baked in', () => {
  // everything `updates.mjs` loads rather than the entry alone: the worker
  // lives in a chunk shared with the automatic check, so the entry is a few
  // re-exports and the bytes are one import away. `staticGraph()` is the
  // answer to "which modules does this pull in" and a second implementation
  // of it is how two figures for one entry come to disagree
  const bundle = [...staticGraph('updates.mjs')]
    .map((name) => readFileSync(join(dist, name), 'utf-8'))
    .join('\n');

  it('should carry the worker rather than a path to it', () => {
    // a string the minifier keeps, from the worker and from nowhere else
    expect(bundle).toContain('CHECK_URL is not set');
  });

  it('should not ship a worker file for anything to read', () => {
    // the read is gone, so the file has no reason to be copied -- and leaving
    // it there would let a build that stopped baking go on working from
    // `node_modules` while every bundled app failed, which is this defect
    expect(
      readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter((name) =>
        name.includes('worker')
      )
    ).toEqual([]);
  });

  it('should carry the whole worker, not a truncated one', () => {
    // one **line** from each end rather than a span across lines, because a
    // line ending is the one thing that differs between checkouts and there
    // are three forms of it to get wrong: `.gitattributes` forces LF for a
    // `.js` and says nothing about a `.ts`, so `worker.ts` is CRLF on
    // Windows -- and the minifier stores the bake as a template literal with
    // the CR escaped to a two-character `\r`, so normalizing the file's own
    // `\r\n` is not enough either. Matching within a line cannot care.
    //
    // That is the platform-specific-fixture rule in the root AGENTS.md, met
    // through a line ending rather than a path separator, and found by
    // converting the file to CRLF and watching the first two attempts fail.
    const lines = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'updates', 'worker.ts'),
      'utf-8'
    )
      .split(/\r?\n/)
      .map((line) => line.trimEnd())
      .filter((line) => line.trim().length >= 15);

    // and taken from the source rather than written out, so the two cannot
    // come apart the way a quoted literal does
    expect(lines.length).toBeGreaterThan(20);
    expect(bundle, 'the first line of the worker').toContain(lines[0]);
    expect(bundle, 'the last line of the worker').toContain(lines.at(-1));
  });
});
