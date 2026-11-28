# `packages/mcp` — deliberate decisions

These are the decisions for `@ttylabs/mcp`. The root `AGENTS.md` still applies in
full.

## Deliberate decisions — do not "fix" these

### A sigil app as an MCP server (SIG-721)

- **A package of its own, so `@ttylabs/sigil` keeps no dependencies and none of
  MCP's churn.** The specification revises about twice a year; an app that does
  not serve MCP should not follow it. This is the third shape the root
  `AGENTS.md` describes, after the two config stores.
- **The transport is hand-written.** Newline-delimited JSON-RPC over stdio is a
  line reader and `JSON.stringify`, and a tool server answers five methods. The
  official SDK would be the package's only dependency and most of its size; what
  writing it costs is tracking revisions here, which is `PROTOCOL_VERSIONS`.
- **A child process per call, because nothing else keeps the protocol clean.** A
  command that prints writes into the JSON-RPC stream if it runs in the server,
  and process-wide state -- `process.exitCode`, the quiet axis, the locale, the
  working directory, `process.exit()` -- leaks between calls. The child is the
  app's own entry started again (`self()` in `server.ts`), so it is the same code
  from source and built; a single executable is started without a script.
- **The child exits once its answer is sent, and the server does not wait for
  ever on its pipes.** The first version disconnected and let the event loop
  drain, and the server answered on the child's `close` -- so a command that
  returned with a pool, a timer or a socket still open never answered and leaked
  the process (found in review). The child flushes stdout and stderr, then
  `process.exit()`s. A process the command started can still hold the pipes open
  past that, so the server answers `EXIT_GRACE_MS` after the child exits if
  `close` has not come by then, with what the child wrote, which it flushed
  before exiting. What that process does afterwards is not the call's: a command
  that means to leave something running detaches it.
- **The arguments travel as data, and core grew `input` for it.** Rebuilt as argv
  they lose what argv cannot say: `--` sends what follows to extra arguments, so
  a positional starting with a dash is read as an option, and with unknown options
  allowed it is accepted as one. `main({ input })` and `parse({ input })` put each
  value on its destination, judged by `checkValue()`, `choices` and the required
  checks like a typed value. The test that proves it calls `echo` with `-5`.
- **The command's return value is read off an `afterRun` hook** wrapped around
  the app's own, because `main()` answers with the parse state for a command that
  returned nothing. A value is sent over IPC as JSON, so a `Map` arrives as `{}`;
  a value IPC cannot carry at all is reported as a failure rather than a call that
  never ends.
- **A tool name is the path joined with `_`, and a collision is refused.**
  Numbering two colliding tools would make a name depend on declaration order.
- **Hidden commands are not tools; `exclude` leaves out others.** A per-command
  `mcp: false` was the alternative and is not taken: it would be a property the
  core declares for one package's sake.
- **Progress and questions travel the same IPC channel, both ways (SIG-722).**
  The child sends `progress`, `elicit` and finally `answer`; the server sends the
  `call` and `elicited` replies. Both are hooks in core rather than in this
  package: `observeProgress()` on `@ttylabs/sigil/output`, which the progress bar
  and the spinner report into, and `askRemotely()` on the prompt subpath, which the
  four prompts consult only with no terminal. Each is a process-wide slot on
  `globalThis` under `Symbol.for`, so an ejected prompt -- a copy -- and a second
  install of the package still reach it. The child installs them only for what the
  client can take: progress where it sent a token, questions where it declared
  elicitation, and the prompt module is loaded only then.
- **A report reads signals untracked.** A spinner or a bar driven from an effect
  must not subscribe that effect to its own state, and `display.test.ts` caught
  the first version doing exactly that.
- **Progress is sent only growing**, by the server, because the specification
  requires it and a bar's draws can repeat a value. A spinner's progress is a
  count of its updates, since it has no measure.
- **Elicitation is the specification's restricted schema**: one property,
  `value` -- a string, a boolean, a string out of the labels, or from
  `2025-11-25` a list of them. A choice is asked by label and mapped back by the
  prompt; duplicate labels cannot be asked. A password never is, because the
  specification forbids requesting sensitive information this way.
- **A prompt that names an option is answered by the call's arguments first
  (SIG-719).** The order is one function's, `answerOr()` in `prompt.ts`: a value
  for the option -- in argv, its variable, a `default`, or the call's `input`,
  which counts for a flag too, so `{ "yes": false }` is an answer -- then, with no
  terminal, a remote asker that can ask this question, then the usage error that
  names the argument to pass. So an elicitation asks only what the arguments left
  out, and a client that cannot elicit is told which argument would have answered
  it rather than that there is no terminal. Found merging #730 under this: the two
  sides taken as written refuse before the asker is asked, so no prompt that named
  an option would ever have been elicited; `answerOr()` takes the asker as its
  last argument for that.
- **Not done:** log messages. The ticket called them optional, and a command's
  stderr is still captured and shown when it fails without an answer.
