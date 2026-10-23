# A `run` on the schema — how it was arrived at

The measurements and sabotage passes behind
[`main()` dispatches a `run` on the schema](../../AGENTS.md) in the root
`AGENTS.md` and the two build entries in
[packages/cli/AGENTS.md](../../packages/cli/AGENTS.md). The decisions themselves
are there; this is the record of what each pass found, which is kept because a
finding nobody wrote down is one somebody re-discovers.

## The ticket was closed without the fix, and that is how it was found

SIG-150 was marked Done on 2026-10-12, in the same batch as SIG-139 and
SIG-140, and nothing had landed. What said so, before anything was changed:

- No commit in the tree mentions it (`git log --grep`).
- `packages/sigil/src/index.ts` still read `const { cmd } = state;` followed by
  `if (cmd?.run)`, so a `run` on the schema had no path that reached it.
- `scaffold/index.ts`'s `entry()` still wrote the root-level `run` for
  `layout === 'single'`.
- The root `AGENTS.md` still carried the Known bugs entry, which was the
  ticket's own fourth scope item.
- Run against the built runtime with the exact schema the scaffold writes and
  `argv: ['World']`: **no output, exit 0**.

Worth recording because the closure looked like a fix from every angle except
the tree, and the entry in `AGENTS.md` was the thing that disagreed.

## What the parse already did, which decided the design

Probed before anything was written, against the built runtime, with the
scaffold's own schema:

```
argv: {"who":"World","verbose":false}   cmd: undefined   contexts: [ 'demo' ]
root has run: function
```

So every piece was already in place and only the dispatch was missing. The
schema's own `args` and `options` reach `argv` correctly, the root context
carries the schema's `run` -- `parse()` builds it with
`initCommand({ ...schema, ... })` and `copyDeclaration()` copies `run` across
like everything else -- and a required argument the app was not given already
fails with `Missing required arguments: <who>`. That is what made this a
one-expression fix rather than a feature, and it is the evidence for the entry's
claim that the root _is_ a command rather than something being promoted to one.

## Nothing broke, which is the argument rather than luck

The full suite passed with the dispatch added and before a single test was
written: **7,514 tests, 184 files**. That is the unreachability argument
measured rather than asserted -- code that never ran has no behaviour for a test
to have pinned, so there was nothing to break. It is also why the tests had to
be written afterwards: the change is invisible to the suite that existed.

## Two things the fix turned up that were already wrong

- **`run: null` is refused, and `Command.run`'s `| null` permits what the
  runtime throws on.** `initCommand()` raises `Invalid run function` for a `run`
  that is not a function, so `null` -- which the type offers as the spelling for
  "dispatches nothing" -- fails the parse instead. Already known and recorded
  inside `after-run.test.ts`, where a test named for it passed for the wrong
  reason; the sentence in `src/parser/AGENTS.md` claiming `run: null` dispatches
  nothing was still there and is corrected. `Schema.run` is therefore not spelled
  `| null`, and a test asserts the refusal rather than repeating the type's claim.

- **`Schema`'s `version` doc comment had come adrift.** SIG-147 inserted
  `topicSeparator` between it and `version`, so the interface carried two doc
  blocks on `topicSeparator` and none on `version`. Found while placing `run` in
  the same interface, and fixed there -- a comment attached to the wrong member
  is the defect this repository keeps recording, arriving through a merge rather
  than through an edit.

## The variance question `Schema.run` had, and the recorded answer to it

Declaring the property at all is what the `Schema.desc` entry asks for -- a
property the framework reads should be one the types name -- and the obvious
spelling breaks the scaffold. Measured against this repo's own TypeScript, over
the annotation the `--ts` scaffold writes
(`run({ argv }: { argv: { who?: string; verbose: boolean } })`):

| `Schema.run` typed as                         | the scaffold's handler |
| --------------------------------------------- | ---------------------- |
| `CommandRunHandler` (property syntax)         | **TS2322**             |
| `run?(state: ParseState): unknown` (a method) | **TS2322**             |
| `CommandRunHandler<any>`                      | compiles               |

Method syntax does not rescue it, which is worth knowing because it is the
plausible guess: the bivariance exemption does not apply in this direction. The
answer is the one `AnyCommand` is already written for and in its own words -- "a
command whose `run` takes a narrow `argv` is not assignable to one whose `run`
takes the wide default, because a function parameter is contravariant" -- so the
`argv` is `any`-wide, and the type still refuses a non-function. `Schema` is not
made generic instead, because inference happens at a **call** and the scaffold's
schema is a bare `export default` literal that nothing calls, so a generic
`Schema` would narrow nothing there.

## The second half, which the first half's own premise demanded

The runtime fix was complete and `--single` was still broken: `sigil check` and
`sigil build` refused the scaffolded app with `no "commands" found in this
module`, so `pnpm build` on a brand-new app exited **1**. Measured after the
dispatch fix was working, which is how it surfaced -- the app ran from source
and could not be built.

It is the same defect rather than scope creep. The ticket's own premise is that
"a flag that scaffolds a non-working app is worse than a flag that is not
offered", `pnpm build` is one of the four scripts the scaffold writes, and
works-unbundled-fails-built is the divergence the shared route rules exist to
prevent -- arriving here through the schema rather than through a route, which
is the one door those rules do not cover.

What it cost was smaller than it looked, because `generateBin()` needed nothing:
it writes its baked `commands` over a schema whose `run` is the root's, which is
an empty object over an absent one. The executable answers `single-app Ada` and
bare `single-app` exactly as the app does from source.

**The presence test is where this could have failed silently.**
`outermostWith(program, 'run')` finds nothing in the scaffolded entry, because
`plainProperty()` excludes a method and the scaffold writes
`run({ argv }) { ... }`. That was the first implementation and it left the app
refused exactly as before -- a fix that changed nothing, with no test of its own
yet to say so. `outermostDeclaring()` is the membership test that counts a
method, an accessor, a shorthand and a quoted key, sharing the one walk.

## What the sabotage pass found

Six mutations, one at a time, with the relevant files run after each. All six
caught.

The runtime half, against `test/root-run.test.ts` (19 tests):

- **Dropping the dispatch** -- `state.cmd ?? state.contexts.at(-1)` written
  `state.cmd`, which is `main()` as it was. **9 failed.**
- **Inverting the precedence** -- written
  `state.contexts.at(-1) ?? state.cmd`, so the root answers for everything.
  **3 failed**: the `default` command, the named command, and the namespace
  command. That third one is the test that says the fallback is reached by
  `state.cmd` being unset rather than by its `run` being unset.

The build half, against `check.test.ts` and `build-command.test.ts` (51 tests):

- **`outermostWith` for `outermostDeclaring`** -- the method goes unseen, which
  is the defect the first implementation shipped. **3 failed.**
- **`root` always `true`** -- an app that forgot its `commands` builds in
  silence. **2 failed**, which are the two halves of the other direction.
- **`commandsFound()` always counting** -- `0 commands` for a single-command
  app. **2 failed.**
- **Dropping the `!declared.root` guard on the error** -- the scaffolded layout
  is refused again. **3 failed.**

And the scaffold test, which is the one the ticket asked for by name: reverting
`main()` and running `new.test.ts` fails `should scaffold a single-command app
that produces its output`, and nothing else in that file. That is the gap the
defect shipped through -- the single layout's generated test asserted `--help`,
and `--help` worked.
