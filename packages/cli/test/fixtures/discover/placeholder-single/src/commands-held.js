// A `const` holding `commands` is not read, as `holdsReadObject()` says: it would
// be a shared object a copy can add a subcommand to (SIG-725). The schema module
// can say so now that the const is not a second schema (SIG-728), and the build
// refuses the placeholder that spreads it rather than guessing which name it
// carries, as the app answers `x` from source. It holds a `name` for that: a const
// that holds none of `name`, `path` and `load` is no carrier of them (SIG-731) and
// the placeholder builds, with a warning for the `commands` alone.
const base = { name: 'x', commands: { sub: './commands/b.js' } };

export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...base, path: './commands/a.js' },
  },
};
