// Next-style: the app exports its schema and `sigil build` supplies the bin.
export default {
	desc: 'A fixture app that builds',
	name: 'buildable',
	options: { '-v, --verbose': 'Say more' },
	// what './commands' is relative to. Without it this module means one thing
	// to the build and another to the runtime
	baseDir: import.meta.dirname,
	commands: './commands',
};
