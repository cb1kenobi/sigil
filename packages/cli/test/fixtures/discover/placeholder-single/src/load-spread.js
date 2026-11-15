const loaded = { load: () => import('./commands/a.js') };
export default {
  name: 'placeholder-single',
  baseDir: import.meta.dirname,
  commands: {
    x: { ...loaded, name: 'x' },
  },
};
