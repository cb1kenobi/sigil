// oxlint-disable no-dupe-keys -- a key written twice is what this app is about

const base = { alias: 'erase' };
const off = { default: false };

// The runtime registers each placeholder as the object it ends up -- the last
// spelling of a key, or what a later spread puts there -- and the build read
// `alias` and `default` from the first spelling (SIG-430). Plain JavaScript,
// because `tsc` refuses a key written twice.
export default {
  name: 'placeholder-spellings',
  baseDir: import.meta.dirname,
  commands: {
    // `'yes'` and `42` were refused, though neither is what the app runs with
    ship: { default: 'yes', default: true, path: './commands/ship.js' },
    remove: { alias: 42, alias: 'rm', path: './commands/remove.js' },
    // `del` and `true` were baked, though the spread replaces both. `name` is
    // spelled after the spread because a spread that may carry one is refused
    // (SIG-433), which is the other fixtures' subject and not this one's
    purge: { alias: 'del', ...base, name: 'purge', path: './commands/purge.js' },
    stage: { default: true, ...off, name: 'stage', path: './commands/stage.js' },
  },
};
