// A base carrying the `baseDir`, which the build reads, spread into the schema that
// names a relative `commands` directory (SIG-728). The `baseDir` is the schema's
// whichever object spells it, and a build that looked only at the literal written
// in the schema reported a relative path with nothing to say what it is relative to.
const base = { baseDir: import.meta.dirname };

export default { ...base, commands: './commands', name: 'shared-base' };
