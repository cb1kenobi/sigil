const pathed = { path: './commands/b.js' };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { path: './commands/a.js', ...pathed, name: 'x' },
  },
};
