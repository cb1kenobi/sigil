// A placeholder whose only `commands` is a getter (SIG-732). The runtime calls it, so
// `x sub` is a command; the build cannot run it, so the built app has none of the
// subcommands, and `warnUnbaked()` is what says so.
export default {
  baseDir: import.meta.dirname,
  commands: {
    x: {
      path: './commands/a.js',
      get commands() {
        return { sub: './commands/b.js' };
      },
    },
  },
  name: 'shared-base',
};
