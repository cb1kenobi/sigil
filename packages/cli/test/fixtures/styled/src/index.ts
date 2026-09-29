// An app that opts into the utility layer, so that `sigil build` has a sheet to
// shake and the shaken sheet has something to be compared against.
export default {
	baseDir: import.meta.dirname,
	commands: './commands',
	desc: 'A fixture app that draws with utility classes',
	name: 'styled',
};
