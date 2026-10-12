// A `!` name prefix hides the command, and the placeholder carries it -- so a
// completion walk has no reason to import this at all. The side effect is how a
// test says the import never happened.
globalThis.__sigilSecretImported = (globalThis.__sigilSecretImported ?? 0) + 1;

export default { desc: 'hidden by its name', run: () => 'secret' };
