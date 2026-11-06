## sigil

This project uses sigil v{{version}} (`@ttylabs/sigil`), a zero-dependency
TypeScript framework for command-line apps, and its toolchain `@ttylabs/cli`,
which provides the `sigil` command.

- Use sigil for what it covers instead of adding a package: parsing, help and
  errors come from `@ttylabs/sigil`; prompts, spinners, progress bars and
  tables from `@ttylabs/sigil/components`; colour from `@ttylabs/sigil/ansi`.
  Don't add commander, yargs, inquirer, chalk or ora.
- `src/index.ts` (`src/index.js` in a JavaScript app) exports the schema: the
  app's name, its global options and `commands: './commands'`. Each module in
  `src/commands/` is a command named after its file, and a subdirectory is a
  command whose `index` module is the directory's own command. Nothing is
  registered by hand.
- `--help`, `help`, `completion` and `--quiet` are generated from the schema,
  and `sigil build` adds `--version`. Don't write them by hand.
- Wrap a command in `command()` from `@ttylabs/sigil`, so that `argv` is typed
  from its format strings. Dashed names are camel-cased: `--dry-run` is
  `argv.dryRun`.
- `<value>` in an option's format makes the option itself required. Use
  `[value]` for an optional option that takes a value. A value is a string
  unless the option sets `type`, such as `'int'` or `'bool'`.
- A command in `src/commands/` answers to its file name and nothing else: a
  `name` or an `alias` inside the module does not route it, because the module
  is only loaded once argv has matched the file. For a second spelling, list
  the commands in the schema instead of a directory:
  `commands: { 'hello, hi': './commands/hello.ts' }` runs `hi` and shows both
  spellings in help.
- To fail, throw an `Error`. `main()` from `@ttylabs/sigil` prints its message
  without a stack and exits with 1, or with the error's integer `exitCode`.
- For output a script can read, return data from `run()` and set
  `format: true` on the command; `--json` then prints it. Don't add a `--json`
  option by hand.
- A prompt rejects with a `PromptError` from `@ttylabs/sigil/components` when
  stdin or stdout is not a terminal. Accept every answer as an argument or an
  option too, so that scripts and agents can skip the prompt.
- Test with `runCommand()` from `@ttylabs/sigil/testing`, and always pass
  `argv`. `sigil check` reports what is wrong with the app without building it.
- Docs for this version, as Markdown: {{site}}/llms.txt
