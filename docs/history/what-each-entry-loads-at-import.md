# What each entry loads at import — how it was arrived at

The measurements, experiments and sabotage passes behind "What each entry loads
at import, and what it only asks for" in
[packages/sigil/src/testing/AGENTS.md](../../packages/sigil/src/testing/AGENTS.md).
The decisions are there; this is the record of how they were reached. SIG-328.

Machine: arm64 macOS, node 26.10.0, other agents running builds alongside --
which is why every before-and-after that a decision rests on is an
**interleaved** A/B rather than two runs of the table.

#### How it was measured

`staticGraph()` moved into `packages/sigil/test/static-graph.ts` so that a script
could import it; `dist.test.ts` imports it from there. Two readers were added
beside it: `graphBytes()`, which the five ceilings were each spelling out as a
`reduce`, and `staticBuiltins()`, which reads `from"node:x"` and `import"node:x"`
in the minifier's spelling, because `updates.mjs` carries the update worker
baked in as a string, imports and all, and a reader that took any quote would
count text as an import. While the worker still imported `node:https`, that
string held `from 'node:https'` and the shipped chunk was a real test of the
reader; once this change made the worker ask for https instead, the only import
left in the string was `node:fs`, which the chunk also imports for real, and the
assertion written against the shipped bytes passed for a reader of either
spelling. Review round 1 found that, below.

`scripts/entry-cost.mjs` prints the table. The runtime half runs a fresh node
per sample, warms `performance` before reading anything (the first version
counted `perf_hooks` as a builtin every entry loaded, because `performance.now()`
loads it lazily), and reads `process.moduleLoadList` before and after one
`await import()`. A baseline of an empty `data:` module is printed first.

What one builtin costs on its own, the median of 31 fresh processes each
importing it after a warm-up import, against 1.14 to 1.24 ms for an empty
module: `node:https` 4.64, `node:crypto` 3.36, `node:zlib` 1.94,
`node:console` and `node:stream` together 1.57, `node:fs/promises` 1.50,
`node:util` 1.44, `node:child_process` 1.39, `node:os` 1.14. So https, crypto
and zlib were the three worth moving and the rest were each a few tenths.

`node:util` turned out to be loaded before any user code runs; what its ESM
import cost was the facade, which pulled in `worker_threads`, `stream` and
`string_decoder` behind it. `process.getBuiltinModule('node:util')` hands back
the CommonJS object without that, which is why the debug overlay's `format()`
moved too although `util` itself never stopped loading.

#### Every entry before, from `origin/main` at b421f20d

Median of 15 per entry, not interleaved; read the import column as a ranking.

| entry           | modules |   bytes | static builtins                                                      | import ms | public builtins loaded                                                                                                                                                     |
| --------------- | ------: | ------: | -------------------------------------------------------------------- | --------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (empty module)  |       0 |       0 | -                                                                    |      0.22 | -                                                                                                                                                                          |
| index           |       8 |  12,326 | console stream                                                       |      3.23 | console string_decoder stream/promises stream net                                                                                                                          |
| ansi            |       4 |   7,790 | -                                                                    |      1.00 | -                                                                                                                                                                          |
| app             |      28 | 207,114 | console stream                                                       |      8.73 | console string_decoder stream/promises stream net                                                                                                                          |
| canvas          |       9 |  38,777 | -                                                                    |      3.70 | string_decoder stream/promises stream net                                                                                                                                  |
| coerce          |       4 |   7,563 | console stream                                                       |      2.32 | console string_decoder stream/promises stream net                                                                                                                          |
| components      |      38 | 473,733 | buffer child_process console fs fs/promises os path stream util zlib |     15.23 | console string_decoder stream/promises stream os zlib net dgram child_process fs/promises worker_threads                                                                   |
| config          |       9 |  39,397 | console crypto fs fs/promises os path stream                         |      5.95 | string_decoder os stream/promises stream fs/promises crypto console net                                                                                                    |
| element         |      14 | 131,505 | -                                                                    |      6.28 | string_decoder stream/promises stream net                                                                                                                                  |
| error-handler   |       6 |   8,422 | console stream                                                       |      2.82 | console string_decoder stream/promises stream net                                                                                                                          |
| help            |      28 | 184,164 | console path stream                                                  |      8.06 | console string_decoder stream/promises stream net                                                                                                                          |
| i18n            |       2 |   3,979 | console stream                                                       |      2.07 | console string_decoder stream/promises stream net                                                                                                                          |
| i18n-keys       |       1 |   9,446 | -                                                                    |      0.37 | -                                                                                                                                                                          |
| input           |      11 |  58,043 | -                                                                    |      4.37 | string_decoder stream/promises stream net                                                                                                                                  |
| jsx-dev-runtime |      28 | 170,545 | console stream                                                       |      8.66 | console string_decoder stream/promises stream net                                                                                                                          |
| jsx-runtime     |      27 | 170,311 | console stream                                                       |      8.09 | console string_decoder stream/promises stream net                                                                                                                          |
| layout          |       2 |  13,269 | -                                                                    |      0.63 | -                                                                                                                                                                          |
| paths           |       1 |   1,855 | os path                                                              |      0.48 | os                                                                                                                                                                         |
| png             |       5 |  14,609 | buffer console stream zlib                                           |      3.62 | console string_decoder stream/promises stream zlib net                                                                                                                     |
| reference       |      14 |  41,961 | console fs path stream url                                           |      4.67 | console string_decoder stream/promises stream os net                                                                                                                       |
| renderer        |      26 | 166,513 | console stream                                                       |      8.28 | console string_decoder stream/promises stream net                                                                                                                          |
| routes          |       2 |   2,604 | fs path                                                              |      1.54 | string_decoder os stream/promises stream                                                                                                                                   |
| signals         |       2 |   6,776 | -                                                                    |      0.64 | -                                                                                                                                                                          |
| style           |       9 |  75,603 | -                                                                    |      3.10 | -                                                                                                                                                                          |
| suggest         |       2 |   1,344 | -                                                                    |      0.75 | -                                                                                                                                                                          |
| template        |      27 | 174,120 | console stream                                                       |      7.98 | console string_decoder stream/promises stream net                                                                                                                          |
| terminal        |       5 |  15,242 | -                                                                    |      3.03 | string_decoder stream/promises stream net                                                                                                                                  |
| testing         |      16 |  51,372 | child_process console stream                                         |      5.61 | console string_decoder stream/promises stream net dgram child_process                                                                                                      |
| theme           |       9 |  96,225 | -                                                                    |      3.14 | -                                                                                                                                                                          |
| themes          |       1 |   4,119 | -                                                                    |      0.26 | -                                                                                                                                                                          |
| updates         |       4 |  18,332 | child_process console fs https path stream                           |      6.18 | console string_decoder stream/promises stream os net dgram child_process crypto tls _http_agent _http_incoming _http_common _http_outgoing _http_server _http_client https |
| width           |       3 |   4,220 | -                                                                    |      1.08 | -                                                                                                                                                                          |
| which           |       1 |   1,446 | fs path                                                              |      1.38 | string_decoder os stream/promises stream                                                                                                                                   |
| wrap            |       4 |   9,157 | -                                                                    |      1.39 | -                                                                                                                                                                          |

#### Every entry after

Median of 21, not interleaved.

| entry           | modules |   bytes | static builtins                              | import ms | public builtins loaded                                                |
| --------------- | ------: | ------: | -------------------------------------------- | --------: | --------------------------------------------------------------------- |
| (empty module)  |       0 |       0 | -                                            |      0.22 | -                                                                     |
| index           |       8 |  12,326 | console stream                               |      2.99 | console string_decoder stream/promises stream net                     |
| ansi            |       4 |   7,790 | -                                            |      0.99 | -                                                                     |
| app             |      28 | 207,114 | console stream                               |      8.35 | console string_decoder stream/promises stream net                     |
| canvas          |       9 |  38,777 | -                                            |      3.64 | string_decoder stream/promises stream net                             |
| coerce          |       4 |   7,563 | console stream                               |      2.34 | console string_decoder stream/promises stream net                     |
| components      |      38 | 473,873 | buffer console fs fs/promises os path stream |     14.16 | console string_decoder stream/promises stream os fs/promises net      |
| config          |       9 |  39,414 | console fs fs/promises os path stream        |      3.84 | string_decoder os stream/promises stream fs/promises console net      |
| element         |      14 | 131,505 | -                                            |      6.08 | string_decoder stream/promises stream net                             |
| error-handler   |       6 |   8,422 | console stream                               |      2.62 | console string_decoder stream/promises stream net                     |
| help            |      28 | 184,164 | console path stream                          |      7.75 | console string_decoder stream/promises stream net                     |
| i18n            |       2 |   3,979 | console stream                               |      2.08 | console string_decoder stream/promises stream net                     |
| i18n-keys       |       1 |   9,446 | -                                            |      0.32 | -                                                                     |
| input           |      11 |  58,043 | -                                            |      3.91 | string_decoder stream/promises stream net                             |
| jsx-dev-runtime |      28 | 170,545 | console stream                               |      8.01 | console string_decoder stream/promises stream net                     |
| jsx-runtime     |      27 | 170,311 | console stream                               |      7.88 | console string_decoder stream/promises stream net                     |
| layout          |       2 |  13,269 | -                                            |      0.62 | -                                                                     |
| paths           |       1 |   1,855 | os path                                      |      0.45 | os                                                                    |
| png             |       5 |  14,676 | buffer console stream                        |      2.56 | console string_decoder stream/promises stream net                     |
| reference       |      14 |  41,961 | console fs path stream url                   |      4.47 | console string_decoder stream/promises stream os net                  |
| renderer        |      26 | 166,513 | console stream                               |      7.79 | console string_decoder stream/promises stream net                     |
| routes          |       2 |   2,604 | fs path                                      |      1.50 | string_decoder os stream/promises stream                              |
| signals         |       2 |   6,776 | -                                            |      0.65 | -                                                                     |
| style           |       9 |  75,603 | -                                            |      3.08 | -                                                                     |
| suggest         |       2 |   1,344 | -                                            |      0.73 | -                                                                     |
| template        |      27 | 174,120 | console stream                               |      8.01 | console string_decoder stream/promises stream net                     |
| terminal        |       5 |  15,242 | -                                            |      2.73 | string_decoder stream/promises stream net                             |
| testing         |      16 |  51,372 | child_process console stream                 |      5.23 | console string_decoder stream/promises stream net dgram child_process |
| theme           |       9 |  96,225 | -                                            |      3.07 | -                                                                     |
| themes          |       1 |   4,119 | -                                            |      0.25 | -                                                                     |
| updates         |       4 |  18,536 | console fs path stream                       |      2.61 | console string_decoder stream/promises stream os net                  |
| width           |       3 |   4,220 | -                                            |      1.08 | -                                                                     |
| which           |       1 |   1,446 | fs path                                      |      1.28 | string_decoder os stream/promises stream                              |
| wrap            |       4 |   9,157 | -                                            |      1.30 | -                                                                     |

The five entries that moved, interleaved, median of 41 each:

| entry        | before ms | after ms | saved |
| ------------ | --------: | -------: | ----: |
| `index`      |      3.03 |     2.95 |  0.08 |
| `components` |     15.33 |    14.08 |  1.25 |
| `config`     |      5.92 |     3.76 |  2.17 |
| `png`        |      3.16 |     2.53 |  0.63 |
| `updates`    |      6.18 |     2.55 |  3.63 |

`index` is the control and moved by noise. The chunk `main()` imports for
`updateCheck` (`auto-*.mjs`), interleaved over 31: 6.90 before, 3.42 after.

#### What `sigil build` makes of it

A scratch app whose only code was `createSpinner()` from
`@ttylabs/sigil/components`, built with `node src/sigil.ts build` from
`packages/cli` against the old and the new `dist/` (a package directory whose
`dist` was a symlink to a copy of the old build). `staticGraph()` was given a
`dir` argument for this, and resolves each specifier against its importer's
directory, since an app's entry sits above `chunks/`.

- Before: the entry's static graph was 192,891 B over seven files -- no codec,
  no `Not a PNG file` anywhere in the output -- and it imported
  `child_process`, `console`, `fs`, `os`, `path`, `stream` and `zlib`. The
  entry's first line held `import{constants as x}from"node:os";import{constants
  as S}from"node:zlib";import"node:child_process"`, followed by
  `S.Z_DEFAULT_STRATEGY;` on its own and the editor's signal-table loop over
  `x.signals`. The lazy chunks for the update check and the completion installer
  imported `https`, `child_process` and `crypto`.
- After: 192,653 B over the same seven, importing `console`, `fs`, `path` and
  `stream`; no file in the output imports `zlib`, `child_process`, `crypto`,
  `https` or `util` statically.
- Wall clock for the whole run, interleaved over 61: built 36.3 to 35.4 ms,
  unbundled (a `bin.mjs` calling `main()` on the same schema, resolving the
  package from `node_modules`) 40.2 to 38.7 ms. An empty module is about 20.7.

An app that draws a picture with `image()` keeps the decoder and drops the
encoder, which is why `shake-builtins.test.ts` asserts the decoder's presence
and not the deflate settings'.

Two module-level statements of the same shape were seen in that output and left
alone, being outside this ticket: a `createLog()` call kept at module level, and
a spread of `Array.from({ length: 95 })` whose result nobody holds. Neither
loads a builtin.

#### What a subpath per component would buy

A scratch build of the package with three extra entries -- `spinner.ts`,
`image.ts` and `prompt.ts` from `src/components/` -- through a copy of
`tsdown.config.ts` with a plugin dumping each chunk's `modules`:

| entry                 | modules |   bytes | import ms |
| --------------------- | ------: | ------: | --------: |
| `components` (barrel) |      41 | 475,138 |     15.44 |
| spinner alone         |      29 | 194,707 |      8.38 |
| image alone           |      22 | 176,757 |      7.41 |
| prompt core alone     |      30 | 239,927 |         - |

The barrel's own chunk is fifty modules of comparable size -- the largest,
before minifying, were the QR encoder at 41,570 B of 726,796, `decrypt` at
35,453 and the markdown parser at 33,349 -- so there is no one module whose
removal would move it much. The weight that a one-component app does not need
is the other forty-odd components together. That is a public-surface decision
and is recommended rather than taken.

#### Compatibility of `process.getBuiltinModule()`

Present on node 22.3 and later; the `engines` floor is 22.19. Checked by hand:
the piped update worker fetched `https://registry.npmjs.org/-/package/npm/dist-tags`
and wrote its cache on node 24.18.0 and 26.10.0 and on bun 1.2.23, 1.3.14 and
1.4.4; `encodePng()` and `decodePng()` round-tripped a pixel through the built
`png.mjs` on node 24.18.0 and 26.10.0. Node 22 is CI's.

#### The sabotage pass

Each against a fresh `pnpm build`, each type-checked with `tsc --noEmit`
before the run so that a failure could not be a type error:

| sabotage                                                        | tsc | failed                                           |
| --------------------------------------------------------------- | --- | ------------------------------------------------ |
| static `inflateSync` import back in `decode.ts`                 | 0   | 4: both entries, static and run time             |
| `zlib().constants` read at module level in `encode.ts`          | 0   | 2: run time only -- the case that half is for    |
| static `randomBytes` import back in `atomic.ts`                 | 0   | 2                                                |
| static `https` import back in `worker.ts`                       | 0   | 3                                                |
| static `spawn` import back in `editor.ts`                       | 0   | 2                                                |
| static `spawn` import back in `updates/index.ts`                | 0   | 2                                                |
| static `format` import back in `debug-overlay.ts`               | 0   | 1: static only, as designed                      |
| `staticBuiltins()` matching single quotes instead               | 0   | 1: the presence checks -- it went blind          |
| `staticBuiltins()` matching either quote, with spaces (round 1) | 0   | 1: `should not read an import that is only text` |
| the editor's signal table back at module level (round 1)        | 0   | 1: the spinner half of `shake-builtins.test.ts`  |
| `which` removed from `CEILINGS`                                 | 0   | 1: the manifest check                            |
| `DEFAULT_STRATEGY` hoisted to a static `node:zlib` import again | 0   | 2: both halves of `shake-builtins.test.ts`       |

The last one failed the image half too, because a static import of zlib is a
static import in a picture-drawing app as much as in a spinner -- which is what
that test's last assertion is for.

#### Review round 1

grok-4.7, over the whole diff. It confirmed no public API changed shape and
measured the per-call cost of `getBuiltinModule()` at about 37 ns after warm-up
-- `chunkCrc()` runs it once per PNG chunk, `deflate()` once or twice per
encode, `tempFor()` once per name, `captureConsole()` once per install -- so
none of the six is worth caching. It also checked that `vi.spyOn(https, 'get')`
still sees the worker's call, that `moduleLoadList` spells ids the same way on
node 24 and 26, and every figure in `CEILINGS` against the built `dist/`. Three
findings, all reproduced:

- **Medium: the honesty test no longer distinguished anything.** Its
  `not.toContain('node:https')` on `updates.mjs` was written while the baked
  worker still said `from 'node:https'`; after this change it does not, so a
  reader widened to any quote passed it. Replaced by a module written into a
  temp directory with one real import and two imports inside a template
  literal, read through `staticGraph()`'s `dir` argument. Widening the reader
  now fails it. The "single quotes instead" row above failed before the fix
  too, but through the presence checks, because that reader went blind rather
  than wide -- which is the distinction the round drew.
- **Low: the shake test named `node:os` and did not guard it.** It cannot be
  asked about by name -- the lazy chunks of the update check and the completion
  installer import `node:os` for
  real -- so the test looks for the loop itself,
  `Object.entries(<x>.signals)`, absent from the spinner app and present in the
  package's `components.mjs` as its presence half. Putting the loop back at
  module level fails it.
- **Low: two comments outside the diff still said the codec loads zlib.**
  `png/image.ts` and `canvas/image.ts` gave zlib as the reason the canvas
  imports `assertRgbaImage()` from the module rather than the barrel; the reason
  is now the codec's bytes, and both say so.

#### Review round 2

grok-4.7, over the round 1 fix and what round 1 had not covered: `packages/cli/src/build/`
as far as it touches this, the CommonJS form `sigil package` uses for a node
single executable, `updates/host.ts` and `auto.ts`, and the website's client
bundles. **No substantive findings.** It checked, by building in memory with
rolldown 1.2.16, that CommonJS and ESM output both keep each
`process.getBuiltinModule()` call inside its function rather than hoisting it
to a `require`, and that the CommonJS output executes; that `bun build --target
node` leaves the call alone; that nothing in the toolchain's `define`,
`external` or plugins depends on these builtins being static imports; and that
`@ttylabs/sigil/suggest` and the website's two client importers of it reach no
module the change touched. It measured the widened readers against the new
string fixture -- either quote with spaces and single quotes with a space both
fail it -- and confirmed the signal-table regex matches the minified loop in
`components.mjs`. One nit, taken: the shake test's comment named only the
update check's chunk as the one importing `node:os` for real, where the
completion installer's does too. Not run by either round: a SEA binary, and
Windows, which CI covers for the tests.
