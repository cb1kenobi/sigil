// An app whose output is a `ui` template rather than factory calls, so that
// `sigil build` has something to compile and the compiled path has something to
// be compared against.
export default {
	// what './commands' is relative to, without which this module means one
	// thing to the build and another to the runtime
	baseDir: import.meta.dirname,
	commands: './commands',
	desc: 'A fixture app whose output is a template',
	name: 'templated',
};
