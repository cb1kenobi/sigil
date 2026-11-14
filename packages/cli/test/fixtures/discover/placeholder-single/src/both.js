export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { name: 'x', path: './commands/a.js', load: () => import('./commands/b.js') },
  },
};
