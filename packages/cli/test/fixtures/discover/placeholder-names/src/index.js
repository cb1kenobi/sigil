// oxlint-disable no-dupe-keys, unicorn/no-useless-spread -- a key written twice, and a spread
// of a literal, are what this app is about

const named = { name: 'later' };
const on = true;

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
    // a literal is read, not evaluated: what a spread of one holds, and a computed
    // key that is a string, are the keys they spell
    quoted: { ['name']: 'quote', path: './commands/a.js' },
    quotedpath: { ['path']: './commands/b.js' },
    inlined: { ...{ path: './commands/a.js' } },
    nested: { ...{ ...{ name: 'deep' } }, path: './commands/b.js' },
    // ...and a conditional or a logical expression is what its arms hold, so one
    // whose arms hold neither `name`, `path` nor `load` is no reason to refuse
    logical: { ...(on && { hidden: true }), path: './commands/a.js' },
    conditional: { ...(on ? { hidden: false } : { hidden: true }), path: './commands/b.js' },
    // ...and a symbol is not a string
    symbol: { [Symbol.for('meta')]: 1, [Symbol.iterator]: 2, path: './commands/a.js' },
    // an async arrow is still an arrow returning an import
    asynced: { load: async () => import('./commands/b.js') },
  },
};
