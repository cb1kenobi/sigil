// A base the build cannot read -- a `let` -- that carries the `baseDir` of a schema's
// relative `commands` directory (SIG-729). The runtime reads it through the spread,
// so the schema does set one, and a build that said it sets none was wrong.
let base = { baseDir: import.meta.dirname };

export default { ...base, commands: './commands', name: 'shared-base' };
