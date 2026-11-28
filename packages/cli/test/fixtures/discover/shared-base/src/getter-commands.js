// A schema whose only `commands` is a getter (SIG-734). The runtime reads it, so `a`
// is a command from source; the build cannot run it, so a built app would have none,
// and the build has to say that rather than that no `commands` were found.
export default {
  baseDir: import.meta.dirname,
  get commands() {
    return { a: './commands/a.js' };
  },
  name: 'shared-base',
};
