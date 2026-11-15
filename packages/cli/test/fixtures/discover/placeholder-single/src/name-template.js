const prefix = 'pre';
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { name: `${prefix}-x`, path: './commands/a.js' },
  },
};
