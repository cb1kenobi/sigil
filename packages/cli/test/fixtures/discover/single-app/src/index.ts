// A single-command app: the schema is the command, which is what
// `sigil new --single` scaffolds. There is no `commands` because there are no
// subcommands, and `main()` dispatches the root.
//
// `run` is written as a **method**, which is how anybody writes a handler and
// is why the presence test for it is `outermostDeclaring()` rather than
// `outermostWith()` -- the latter answers with a value and so leaves a method
// out.
export default {
  args: [{ desc: 'Who to greet', name: '[who]' }],
  desc: 'Greet somebody',
  name: 'single-app',
  run({ argv }: { argv: { who?: string } }) {
    process.stdout.write(`hello ${argv.who ?? 'world'}\n`);
  },
};
