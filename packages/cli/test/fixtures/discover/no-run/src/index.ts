// A sigil app whose schema declares neither `commands` nor `run`, which is an
// app that forgot its commands rather than a single-command app. The build has
// to go on saying so: this is the other half of accepting a schema that is
// itself the command.
export default { desc: 'Does nothing at all', name: 'no-run' };
