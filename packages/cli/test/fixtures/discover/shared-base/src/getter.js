// oxlint-disable no-dupe-keys -- a key written twice is what this app is about
// A getter after a plain `commands` (SIG-730). The runtime reads the last spelling
// of a key, which is the getter, so `a` and `b` are the commands and `old` is not;
// what the build can read is the plain one, and it has to say so.
export default {
  baseDir: import.meta.dirname,
  commands: { old: './commands/a.js' },
  get commands() {
    return { a: './commands/a.js', b: './commands/b.js' };
  },
  name: 'shared-base',
};
