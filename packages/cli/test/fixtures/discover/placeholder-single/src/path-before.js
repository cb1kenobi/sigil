// `let` rather than `const`: the build resolves a spread of a `const` that is only ever
// spread (SIG-440), and this fixture is about the spread it cannot read
let pathed = { path: './commands/b.js' };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { path: './commands/a.js', ...pathed, name: 'x' },
  },
};
