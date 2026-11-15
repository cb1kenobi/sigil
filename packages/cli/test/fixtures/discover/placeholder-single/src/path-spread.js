const pathed = { path: './commands/a.js' };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { desc: 'carried', ...pathed, name: 'x' },
  },
};
