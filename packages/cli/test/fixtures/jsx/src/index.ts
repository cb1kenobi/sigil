// An app whose output is a JSX element rather than factory calls or a tag, so
// that `sigil build` has something to run through rolldown's JSX transform.
export default {
	// what './commands' is relative to, without which this module means one
	// thing to the build and another to the runtime
	baseDir: import.meta.dirname,
	commands: './commands',
	desc: 'A fixture app whose output is JSX',
	name: 'jsx',
};
