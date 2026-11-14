// oxlint-disable no-dupe-keys -- a key written twice is what this app is about

const named = { name: 'later' };

// The runtime registers each placeholder as the object it ends up as: the last
// spelling of a key, or what a later spread puts there. `sigil build` read
// `name`, `path` and `load` from the first spelling (SIG-433, SIG-434), so the
// built app answered to a spelling the app does not. Plain JavaScript, because
// `tsc` refuses a key written twice.
export default {
  name: 'placeholder-names',
  baseDir: import.meta.dirname,
  commands: {
    // `first` was baked, so `second` was `Unexpected argument`
    twice: { name: 'first', name: 'second', path: './commands/first.js' },
    // spelled after a spread, so nothing replaces it
    settled: { ...named, name: 'final', path: './commands/second.js' },
    // `a.js` was bundled, and `b.js` is what runs
    pathed: { path: './commands/a.js', path: './commands/b.js' },
    loaded: { load: () => import('./commands/a.js'), load: () => import('./commands/b.js') },
  },
};
