import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
 */

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

/** Tab, newline and carriage return: the file's own formatting, not a sequence. */
const FORMATTING = new Set([0x09, 0x0a, 0x0d]);

/** Whether a code point is one a terminal would act on rather than print. */
function isControl(code: number): boolean {
  if (FORMATTING.has(code)) {
    return false;
  }
  // C0 and DEL, then C1 -- where U+009B is a CSI all by itself, and is one of
  // the two escapes `codes.ts` builds
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

describe('the shipped bundles', () => {
  const files = readdirSync(dist).filter((name) => name.endsWith('.mjs'));

  it('should have been built', () => {
    // a missing `dist/` is a build that did not run, not a passing test
    expect(files.length, `no bundles in ${dist}; run \`pnpm build\``).toBeGreaterThan(0);
  });

  it.each(files)('should carry no raw control characters: %s', (name) => {
    // a raw `ESC` in a shipped file is a sequence waiting for something to
    // print it, and Node prints the offending source line on an uncaught
    // error -- so a crash anywhere inside the bundle wrote `ESC ] 8 ; ;` to
    // the user's terminal and left every line after it inside a hyperlink
    // nothing closed. The build escapes them; this is what says it still does
    const text = readFileSync(join(dist, name), 'utf8');
    const found = new Map<number, number>();

    for (const char of text) {
      const code = char.codePointAt(0) ?? 0;
      if (isControl(code)) {
        found.set(code, (found.get(code) ?? 0) + 1);
      }
    }

    const report = [...found]
      .map(([code, count]) => `U+${code.toString(16).toUpperCase().padStart(4, '0')} x${count}`)
      .join(', ');

    expect(found.size, `${name} ships raw control characters: ${report}`).toBe(0);
  });

  it('should still spell the escapes it needs', () => {
    // the other half of it: escaping them must not have taken them away. The
    // styler cannot work without an `ESC`, and a build that dropped one would
    // pass the check above by being wrong
    const ansi = readFileSync(join(dist, 'ansi.mjs'), 'utf8');
    const imported = readdirSync(dist)
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => readFileSync(join(dist, name), 'utf8'))
      .join('');

    expect(ansi.length).toBeGreaterThan(0);
    expect(imported).toMatch(/\\x1B/i);
  });
});

/**
 * Every module a static `import` of `entry` would load, and nothing else.
 *
 * Static rather than every specifier, because the difference is the whole
 * point: `main()` reaches the parser and the help screen through `await
 * import()`, so neither is on the graph that importing the package costs. A
 * dynamic import is spelled `import(` and a static one is `import ... from"x"`
 * or `import"x"`, so the parenthesis is what tells them apart.
 *
 * @param entry - A bundle in `dist/`, by name.
 * @returns The bundles reachable from it without calling anything.
 */
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];

  while (queue.length > 0) {
    const name = queue.shift() as string;
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);

    const source = readFileSync(join(dist, name), 'utf8');
    for (const re of [/\bfrom\s*["'](\.\/[^"']+)["']/g, /\bimport\s*["'](\.\/[^"']+)["']/g]) {
      for (const [, spec] of source.matchAll(re)) {
        queue.push((spec as string).slice(2));
      }
    }
  }

  return seen;
}

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
    'tableView',
    'enableDebugOverlay',
    'qrcodeView',
    'commandPalette',
    'noteView',
    'logView',
    'barChartView',
    'taskLog',
    'calendarView',
    'ruleView',
    'paginatorView',
    'outlineView',
    'filePicker',
    'selectRow',
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
        readdirSync(dist).filter(
          (name) => name.endsWith('.mjs') && readFileSync(join(dist, name), 'utf8').includes(symbol)
        ),
        symbol
      ).not.toEqual([]);
    }
  );

  it('should reach exactly the eight modules the measurement names', () => {
    // the markers say what it must not reach and this says it reaches nothing
    // else at all, which is the only form that catches a parser module arriving
    // as a chunk of its own under a name nothing here could have predicted.
    // Eight: the entry, `paths.mjs`, `i18n.mjs`, and the `transform`, `debug`,
    // `env-value`, `mkdir-owner-sync` and `atomic` chunks -- which is the
    // module list the byte figure below is over, so the two cannot come apart.
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
    // eight after: 138 bytes of preamble for the sharing
    expect([...staticGraph('config.mjs')].sort()).toHaveLength(8);
  });

  it('should cost a module rather than a component', () => {
    const graph = staticGraph('config.mjs');
    const bytes = [...graph].reduce((n, name) => n + statSync(join(dist, name)).size, 0);

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
    // tell which was measured. The README carries a rounded "about 38 kB over
    // eight modules" for an app author deciding whether to import it, which is
    // a different statement and names the same eight
    expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(48 * 1024);
  });

  it('should keep the root entry small enough to be worth it', () => {
    const graph = staticGraph('index.mjs');
    const bytes = [...graph].reduce((n, name) => n + statSync(join(dist, name)).size, 0);

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
    const bytes = [...graph].reduce((n, name) => n + statSync(join(dist, name)).size, 0);

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
    const shipped = new Set(readdirSync(dist).filter((name) => name.endsWith('.mjs')));

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
    // coercion itself is nearly all; a ceiling at about 3x, so ordinary growth
    // never touches it and the parser arriving does
    const bytes = [...coerce].reduce((n, name) => n + statSync(join(dist, name)).size, 0);
    expect(bytes, `${[...coerce].join(', ')}`).toBeLessThan(24 * 1024);
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
    const shipped = new Set(readdirSync(dist).filter((name) => name.endsWith('.mjs')));
    const printer = printerChunk();

    for (const marker of ['because the input is not a terminal', '(space to select']) {
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
    const shipped = new Set(readdirSync(dist).filter((name) => name.endsWith('.mjs')));
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
    // A ceiling rather than a measurement, at about 1.4x, so ordinary growth
    // never touches it and a second runtime stack does
    const graph = staticGraph('components.mjs');
    const bytes = [...graph].reduce((n, name) => n + statSync(join(dist, name)).size, 0);

    expect(bytes, `${[...graph].join(', ')}`).toBeLessThan(448 * 1024);
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
    expect(readdirSync(dist).filter((name) => name.includes('worker'))).toEqual([]);
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
