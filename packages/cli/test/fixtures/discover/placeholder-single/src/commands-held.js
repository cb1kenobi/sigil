// A `const` holding `commands` is not read, as `holdsReadObject()` says: it would
// be a shared object a copy can add a subcommand to (SIG-725). The schema module
// can say so now that the const is not a second schema (SIG-728), and the build
// refuses the placeholder that spreads it rather than guessing which name and
// module it carries, as the app answers `x` from source.
const base = { commands: { sub: './commands/b.js' } };

export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...base, path: './commands/a.js' },
  },
};
