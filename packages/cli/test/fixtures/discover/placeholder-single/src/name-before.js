// `let` rather than `const`: the build resolves a spread of a `const` that is only ever
// spread (SIG-440), and this fixture is about the spread it cannot read
let named = { name: 'later' };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { name: 'early', ...named, path: './commands/a.js' },
  },
};
