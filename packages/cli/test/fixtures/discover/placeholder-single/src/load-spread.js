// `let` rather than `const`: the build resolves a spread of a `const` that is only ever
// spread (SIG-440), and this fixture is about the spread it cannot read
let loaded = { load: () => import('./commands/a.js') };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...loaded, name: 'x' },
  },
};
