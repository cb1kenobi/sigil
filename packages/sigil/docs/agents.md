## sigil

This project uses sigil v{{version}} (`@ttylabs/sigil`), a zero-dependency
TypeScript framework for command-line apps, and its toolchain `@ttylabs/cli`,
which provides the `sigil` command.

- Both packages ship a skill written for agents, describing the installed
  version. Read `node_modules/@ttylabs/sigil/skills/sigil/SKILL.md` before
  changing the app, and `node_modules/@ttylabs/cli/skills/sigil-cli/SKILL.md`
  before building, packaging, or editing `sigil.json`.
- Use sigil for what it covers instead of adding a package: parsing, help and
  errors come from `@ttylabs/sigil`; prompts, spinners, progress bars and
  tables from a subpath of `@ttylabs/sigil/components` named after the
  component's file, such as `@ttylabs/sigil/components/spinner`; colour from
  `@ttylabs/sigil/ansi`. Don't add commander, yargs, inquirer, chalk or ora.
- `src/index.ts` (`src/index.js` in a JavaScript app) exports the schema: the
  app's name, its global options and `commands: './commands'`. Each module in
  `src/commands/` is a command named after its file, and a subdirectory is a
  command whose `index` module is the directory's own command. Nothing is
  registered by hand.
- `--help`, `help`, `completion`, `schema` and `--quiet` are generated from the
  schema, and `sigil build` adds `--version`. Don't write them by hand. `schema`
  prints each command's input as JSON Schema, for an agent to call the app with.
- Declare `readOnly: true` on a command module that changes nothing,
  `destructive: true` on one that can delete or overwrite, and `idempotent: true`
  on one that is safe to retry. An agent decides whether to run a command from
  these, and `schema` hands them over.
- `sigil reference --skill` writes this app's own agent skill to `skills/<name>/`,
  from the command declarations. Run it again after changing a command, and keep
  `skills` in the manifest's `files` so the skill is published.
- Wrap a command in `command()` from `@ttylabs/sigil`, so that `argv` is typed
  from its format strings. Dashed names are camel-cased: `--dry-run` is
  `argv.dryRun`.
- `<value>` in an option's format makes the option itself required. Use
  `[value]` for an optional option that takes a value. A value is a string
  unless the option sets `type`, such as `'int'` or `'bool'`.
- A command in `src/commands/` answers to its file name: a `name`, an `alias`
  or `default: true` inside the module does not route it, because the module is
  only loaded once argv has matched the file. Help leaves such a spelling out,
  and `sigil check` and `sigil build` warn about it in the modules they read.
  Say it in a `commands.json` in the same directory instead, keyed by file name
  without the extension: `{ "hello": { "desc": "Say hello", "alias": "hi" } }`
  runs `hi` without listing it, and describes `hello` in help without loading
  the module. A subdirectory has its own `commands.json`. For a second spelling
  that help shows, list the commands in the schema instead of a directory:
  `commands: { 'hello, hi': './commands/hello.ts' }`.
- To fail, throw an `Error`. `main()` from `@ttylabs/sigil` prints its message
  without a stack and exits with 1, or with the error's integer `exitCode`. The
  parser's own complaints about argv are `UsageError`s and exit with 2; throw one
  yourself (`new UsageError(message, 'invalid-value')`) for a bad invocation your
  own code finds.
- For output a script can read, return data from `run()` and set
  `format: true` on the command; `--json` then prints it. Don't add a `--json`
  option by hand.
- A prompt rejects with a `PromptError` from `@ttylabs/sigil/components/prompt` when
  stdin or stdout is not a terminal. Accept every answer as an argument or an
  option too, so that scripts and agents can skip the prompt.
- Test with `runCommand()` from `@ttylabs/sigil/testing`, and always pass
  `argv`. `sigil check` reports what is wrong with the app without building it.
- Docs for this version, as Markdown: {{site}}/llms.txt
