// What a spread carries is read where a placeholder's key is and where a routed
// module's is (SIG-725, SIG-726). `mixin` is a `let`, so the build cannot read it,
// and it may carry the subcommands `b` would have.
let mixin = {};

export default {
  name: 'placeholder-routed',
  baseDir: import.meta.dirname,
  commands: {
    a: { path: './commands/a.js' },
    b: { ...mixin, name: 'b', path: './commands/a.js' },
  },
};
