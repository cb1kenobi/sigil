// A const is shared with another name by a shallow copy, so an array in it can be
// written without the const ever being named (SIG-440, review). The app answers
// to `x` for it, which a build that read `shared` as it was declared would not
const shared = { alias: ['early'], path: './commands/a.js' };
const other = { ...shared };
other.alias.push('x');
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    y: { ...shared, name: 'y' },
  },
};
