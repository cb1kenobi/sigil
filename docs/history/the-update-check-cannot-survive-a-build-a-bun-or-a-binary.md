# The update check cannot survive a build, a Bun, or a binary — how it was arrived at

The probes and measurements behind
[packages/sigil/src/updates/AGENTS.md](../../packages/sigil/src/updates/AGENTS.md) and
the update-check section of [packages/cli/AGENTS.md](../../packages/cli/AGENTS.md).
The decisions themselves are there; this is the record of what each
measurement found, which is kept because a finding nobody wrote down is
one somebody re-discovers.

SIG-156. Three defects found while measuring SIG-138, one mechanism: the
worker was a separate file, fed to a runtime, through a spelling only Node
accepts.

#### What the runtimes actually do with a script on stdin

Measured on node v26.10.0 and bun 1.4.4, with a module using an `import`, a
top-level `await`, `process.env` and the inherited `cwd`.

| invocation                         | node  | bun                                |
| ---------------------------------- | ----- | ---------------------------------- |
| `node -` / `bun -`                 | works | works                              |
| `--input-type module` (two tokens) | works | `error: Script not found "module"` |
| `--input-type=module` with stdin   | —     | prints its usage text              |

So `['-']` is the one spelling both accept, and the fix for defect 2 is a
single token. Three further properties were measured on both, because the
design that removes the duplicate fetcher rests on all three:

- **TypeScript is stripped from stdin.** `node -` and `bun -` both ran a
  module with an `interface` and annotated parameters. This is the same
  guarantee the root `AGENTS.md` already records for command modules
  (`engines` says node >=22.19.0, stripping on by default since 22.18).
- **`import type` erases.** A module piped with
  `import type { UpdateChecker } from './checker.js'` ran on both, which is
  what lets the worker be typed against a sibling it cannot import.
- **A module with exports plus an appended call runs.** Piping
  `<module source>\nawait main(process.env);\n` works on both, which is what
  lets one file be imported on the in-process path and piped on the other.

#### Defect 1, measured from both ends

An app whose `run()` calls `check()`:

```
source:  OK {"current":"1.0.0", ...}
built:   FAILED ENOENT: no such file or directory, open '<out>/worker.ts'
```

`sigil build` reported complete success in both cases. Re-measured as a
sabotage after the fix: removing `inlineWorker` from `tsdown.config.ts`,
rebuilding `@ttylabs/sigil`, and rebuilding the fixture app reproduces exactly
that `ENOENT`, and both guards fail -- `test/dist.test.ts` and the built-app
test in `packages/cli/test/update-check.test.ts`.

The plugin guard earned itself immediately: the first version replaced
`worker-source.ts` wholesale, and adding `WORKER_ARGV` and `WORKER_ENTRY` to
that module made them **vanish from the build** while working perfectly from
source -- the same defect, one layer up, within an hour of fixing it. The
build now fails with
`worker-source.ts must export workerSource() and nothing else; found 2 exports`,
verified by sabotage.

#### Defect 3: what a compiled binary looks like from the inside

Probed with `bun build --compile` on bun 1.4.4, against the same script run
uncompiled:

| signal             | uncompiled                   | compiled                  |
| ------------------ | ---------------------------- | ------------------------- |
| `process.execPath` | `~/.bun/bin/bun`             | `<cwd>/probe-bin`         |
| `Bun.main`         | the real path                | `/$bunfs/root/probe-bin`  |
| `import.meta.url`  | a real `file://` URL         | `file:///$bunfs/root/...` |
| `node:sea`         | `ERR_UNKNOWN_BUILTIN_MODULE` | same                      |

`node:sea`'s `isSea()` answers `false` on plain node and is the Node half; it
throws on Bun, which is why it is asked second and inside a `try`.

`process.execPath` being the app's own binary is the whole of defect 3: the
spawned path would have re-executed the CLI.

#### The three compiled behaviours, measured in a real Bun binary

```
no checker declared ->  {"current":"1.0.0"}            (and did not re-exec itself)
explicit checker, wait  -> {"current":"1.0.0","latest":"bun-v1.4.4"}
best effort             -> returned in 6 ms; process exited immediately
```

And the cost of the chosen default, read at `process.on('exit')`:

```
best effort (default):  cache at exit: EMPTY
linger: true:           cache at exit: written
```

That emptiness is the honest consequence of "costs the run nothing" in a
process that cannot outlive itself, not a bug. It is why `linger` exists and
why the default is the one it is.

#### Why `node:https` rather than `fetch()` in process

`fetch()` would have been fifteen lines against forty. It exposes no handle to
unref, so the only behaviour available with it is holding the event loop open
until the request settles -- which is `linger`, as the _default_. The promise
the default path exists for is that the check costs the run nothing, and
`req.on('socket', (s) => s.unref())` is what keeps it. That decided the
transport, and the transport is what made the worker worth sharing rather than
duplicating.

#### Where `define` lives in rolldown

Measured against rolldown 1.2.15. `define` is **not** a top-level input
option: passing it there warns
`Invalid input options (1 issue found) - For the "define". Invalid key: Expected never but received "define"`
and silently does nothing. It is `transform.define`, and it does reach a
module inside `node_modules` -- verified with a dependency whose exported
function reads the identifier through `typeof`, which printed the replaced
value and left no occurrence of the identifier in the output.

#### What the first versions of the tests got wrong

- **A source grep matched its own comment.** `should not pass a node-only
  input-type flag` read `index.ts` and asserted it did not contain
  `--input-type` -- which the comment _explaining why the flag is wrong_
  contains. It asserts `WORKER_ARGV` now, with a real spawn beside it proving
  the spelling works.
- **A test went to the network.** The baked-checker case declared
  `{ "type": "github", "repo": "acme/mycli" }` and asserted a DNS failure;
  GitHub answered `404 Not Found`, because the test really did ask it. It
  names a second local port nothing is listening on instead, which proves
  the same thing -- which address the check reached for -- offline.
- **A fixture could not be a re-export.** `updates-none` was going to be
  `export { default } from '../../updates/src/index.js'`, and the build
  refused it with `no "commands" found in this module`: the build **reads**
  an app's entry rather than importing it, so a re-export has no object
  literal to find. That is what the `.variants/` copy exists for.
