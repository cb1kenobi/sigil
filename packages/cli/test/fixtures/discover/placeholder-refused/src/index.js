const named = { name: 'later' };
const pathed = { path: './commands/three.js' };
const loaded = { load: () => import('./commands/four.js') };
const key = 'path';

// Each of these runs from source and used to build with no complaint: the build
// read the first spelling of `name`, or found no module where a spread or a
// computed key carried one, so the built app routed by another name or printed
// help for a command that has none to run (SIG-433, SIG-434). A spread the
// build cannot read is refused rather than guessed at, and the fix is the same
// for each: spell the key literally, after any spread.
export default {
  name: 'placeholder-refused',
  baseDir: import.meta.dirname,
  commands: {
    spreadname: { name: 'early', ...named, path: './commands/one.js' },
    carriedname: { ...named, path: './commands/two.js' },
    carried: { desc: 'carried', ...pathed },
    replaced: { path: './commands/five.js', ...pathed },
    loadcarried: { desc: 'carried', ...loaded },
    loadreplaced: { load: () => import('./commands/six.js'), ...loaded },
    computed: { [key]: './commands/seven.js' },
  },
};
