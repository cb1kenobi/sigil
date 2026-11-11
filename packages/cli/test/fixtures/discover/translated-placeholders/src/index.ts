// One command module whose `desc` is a `__` tag, reached by every spelling a
// schema has for it. Each spelling is one declaration, so each has to bake the
// translating thunk -- the object form dropped it and printed the English
// (SIG-352). `literal` is the one that must not: its placeholder's own `desc`
// wins, and that is prose rather than a catalog key.
export default {
  name: 'translated-placeholders',
  baseDir: import.meta.dirname,
  commands: {
    loaded: { load: () => import('./commands/build.ts') },
    pathed: './commands/build.ts',
    object: { path: './commands/build.ts' },
    literal: { desc: 'Its own words', load: () => import('./commands/build.ts') },
  },
  locales: {
    de: () => import('./locales/de.json', { with: { type: 'json' } }),
  },
};
