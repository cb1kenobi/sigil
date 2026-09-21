# Template frontends: a prototype for SIG-69

Not shipped, not tested, not the compiler. This exists to settle one question:
whether "a thunk is the reactive thing" reads acceptably in both frontends, and
what each one costs.

```
node packages/sigil/prototype/run.js          # the three-way comparison
node packages/sigil/prototype/error-probe.js  # what the tag says when it is wrong
```

`run.js` needs `out/counter-jsx.js`, which is
`pnpm exec tsc -p packages/sigil/prototype/tsconfig.json`.

## What it shows

All three frontends produce byte-identical output, before and after a signal
write -- so the comparison is of the reactivity as well as the first frame.
That is SIG-72's differential test in miniature, one layer up.

|            | build step | reactive expression    | prop checking           | errors               |
| ---------- | ---------- | ---------------------- | ----------------------- | -------------------- |
| hand-built | none       | `createEffect` by hand | full                    | at the call          |
| `ui` tag   | none       | `${() => ...}`         | none                    | at parse, at runtime |
| JSX        | `tsc`      | `{() => ...}`          | elements and components | at compile           |

## The rule both frontends follow

**A function-valued prop or child is reactive; a value is static.** `count` is
reactive, `count()` is a snapshot, `() => count() * 2` is reactive.

It is the convention `renderer/control.ts` already follows, and it is what makes
a build step a pure optimizer: Solid reaches `{count() * 2}` by compiling it
into a getter, which means the same source means different things compiled and
uncompiled -- the divergence SIG-72 exists to prevent.

## Typed props

A host element's props are derived from the `Style` interface, plus the
shorthand and alias tables, so `<box padddding="1" />` and `<box
display="grid" />` are compile errors and nothing enumerates a property. Both
spellings are accepted, because `Kebab<>` is `kebab()` written in the type
system. `typecheck-probe.tsx` is the pin: every line in it is meant to be an
error, so a line that stops being one means the types have drifted.

## Where the pins live

Not here. Two rounds of review found thirteen defects, and each one is an
assertion in the suite rather than a line this directory prints:
`test/template/tag.test.ts` for the ones that produced wrong output, and
`test/template/jsx-types.tsx` for the ones that are type errors. Both run under
`pnpm test` and `pnpm check`. What stays in this directory is the thing a test
cannot answer -- whether the three ways of writing the same component read
acceptably side by side.

## What it deliberately does not do

The analysis pass and the build emitter (SIG-72), source positions through the
IR, and hoisting. The seam for all of them is `IRNode`.
