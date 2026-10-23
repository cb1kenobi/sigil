# `packages/sigil/src/debug` — deliberate decisions

These are the entries from [../../../../AGENTS.md](../../../../AGENTS.md) that are about this directory. Claude Code loads this file when it
works with files here; other agents should read it before changing
anything in this area. The root `AGENTS.md` holds the rules that apply
everywhere and still applies in full.

How each of these was arrived at — the review rounds and sabotage
passes — is under [docs/history/](../../../../docs/history), linked from
the entry it belongs to.

## Deliberate decisions — do not "fix" these

### Debug logging

- **A `DEBUG` namespace is a literal with one wildcard, and a pattern that will
  not compile turns logging off rather than the library.** Every token is
  escaped except `*`, which becomes `.*?`. Nothing was escaped before, so
  `DEBUG='('` threw a `SyntaxError` out of `enable()` -- which runs at module
  load, behind every entry point there is -- and the import died before `main()`
  existed to render it as a message, while the quieter half of it had
  `DEBUG='sigil.updates'` matching `sigilXupdates` too. The `new RegExp` calls
  are wrapped anyway, because escaping is a claim about a grammar and the cost
  of being wrong about that one is a library nobody can import; `metaRE` is
  declared above the call that reads it for the same reason, since a `const`
  further down the file is in its temporal dead zone at load and that is the
  identical dead import with a `ReferenceError` on it.
- **A pattern that names nothing leaves logging off.** `,,`, whitespace, and a
  lone `-` all reach the token loop and add neither an allowed namespace nor an
  excluded one, and they used to fall through to the `/./` that means
  "everything the exclusions left" -- so a `DEBUG` naming nothing at all turned
  every logger in the process on. Covered by `test/debug/debug.test.ts`.
