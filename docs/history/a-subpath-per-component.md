# A subpath per component — how it was arrived at

The measurements, the two builds compared and the sabotage passes behind "A
subpath per component" in
[packages/sigil/src/components/AGENTS.md](../../packages/sigil/src/components/AGENTS.md).
The decisions are there; this is the record of how they were reached. SIG-330.

Machine: arm64 macOS, node 26.10.0, at a load average of 10 to 12 from other
agents building alongside -- which is why every timing below is an
**interleaved** A/B of fresh processes rather than two runs of
`scripts/entry-cost.mjs`, and why the milliseconds are worth reading against
each other rather than against SIG-328's.

#### How it was measured

Bytes and modules are `staticGraph()` and `graphBytes()` from
`packages/sigil/test/static-graph.ts`, the readers `dist.test.ts` sets its
ceilings with, run over a copy of `dist/` taken before the change and one taken
after. Import time is a fresh `node --input-type=module` per sample timing one
`await import()` of the file, the candidates taken in turn inside each round so
that whatever the machine was doing landed on all of them; the median of 61
rounds. A built app is `bundleApp()` from `packages/cli/src/build/` over the
`shake-spinner` fixture and its `shake-spinner-subpath` twin -- the same app,
importing `createSpinner` the two ways -- its static graph read with the same
`staticGraph()`, and its wall clock a fresh `node` running it, median of 41. The
"built, before" row is the barrel fixture built against the old `dist/`, put back
in place for that one build.

#### The module as the entry, and why it was not kept

The first build made each module its own entry. It worked, and it published too
much: an entry's every export is public, and the modules export what their
siblings share. Importing each built subpath and the barrel and diffing their
keys:

| subpath    | values beyond the barrel's                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------- |
| `calendar` | `addDays`, `dayOf`, `localDate`                                                                    |
| `keys`     | `KEY_NAMES`, `pendingIsString`                                                                     |
| `path`     | `answerOf`, `commonPrefix`, `directoryOf`, `extendSegment`, `separatorFor`, `splitTyped`           |
| `prompt`   | `fieldBox`, `fitted`, `gutterLayers`, `gutterOf`, `lineEnd`, `lineStart`, `offsetIn`, `tokenLayer` |

Nineteen values against the barrel's 260, and their types besides. The facade
build replaced it. The two were measured against each other on the same tree:

| build               | barrel modules | barrel bytes | barrel ms | spinner modules | spinner bytes | spinner ms |
| ------------------- | -------------: | -----------: | --------: | --------------: | ------------: | ---------: |
| module as the entry |             92 |      501,662 |      23.4 |              29 |       194,815 |        9.4 |
| facade as the entry |            110 |      496,422 |      24.0 |              30 |       194,847 |        9.3 |

So the facade costs the subpath one module and 32 B, and the barrel 18 modules
and no measurable time, for publishing nothing the barrel had not.

#### What the barrel costs now

Both builds put the barrel at 6 to 8 ms more than before, which is the price of
the split rather than of either build: 15.0 to 22.4 ms in the final run, and in
earlier ones 15.0 to 21.6 and 14.4 to 20.5 with the module as the entry, and 16.3
to 24.0 with the facade. Its bytes grew
by 22,549, and counting the import and export statements in its graph accounts
for all of it -- about 14 kB of them before and 38 kB after. The modules are what
costs the time, at roughly a tenth of a millisecond each.

#### The website's reader

`componentApi()` in `website/scripts/lib/component-options.ts` read
`components.d.mts` alone, which after the split is a list of re-exports, and
followed a name only inside that one file. Taught to follow imports across the
declaration chunks, it reproduced all 62 committed captures exactly except for
`shared` on 51 of them, which each gained `ansi`, `colorLevel`, `colorScheme`,
`reducedMotion`, `sheets` and `theme`: the members of `StyledOptions`, which the
old `components.d.mts` imported from `theme.d.mts` rather than declared, so the
one-file reader had always found it empty. The captures were rewritten with
`node scripts/capture-transcripts.ts`, and nothing else in them moved.

#### Sabotage

- An untracked `src/components/zz-new.ts` with no subpath: `should publish a
  subpath for every module in src/components` fails, naming `zz-new`.
- `./components/badge` deleted from the manifest: four tests in
  `component-subpaths.test.ts` fail -- the module without a subpath, the facade
  without one, the barrel no longer the union, and the built barrel exporting
  `badge` from no subpath -- and `should hold every published entry to a
  ceiling` in `dist.test.ts` with them.
- The registry generator put back to rewriting a sibling to
  `@ttylabs/sigil/components`: 44 registry tests fail, the new
  `should import a sibling from its own subpath rather than the barrel` among
  them.
- That same test then failed 13 entries **after** the generator was restored,
  which is how it found the doc comments: a component's JSDoc example still
  imported from the barrel, and the manifest's `imports` reads every `from '@...'`
  in the file. The examples were moved to their subpaths, which is what they
  should teach anyway.

Each was reverted by hand.
