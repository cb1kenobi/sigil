// The same mixin with a `commands` written to it (SIG-730). It spells none in its
// literal, and the app runs the one assigned: `c` is a command and `a` is not.
// The warning stays for it, and the built app differs from this one.
const mixin = { name: 'shared-base' };
mixin.commands = { c: './commands/b.js' };

export default {
  baseDir: import.meta.dirname,
  commands: { a: './commands/a.js', b: './commands/b.js' },
  ...mixin,
};
