// An app that asks for the utility sheet and names none of it in a way the
// scan can see, which is the case the shake has to say something about rather
// than silently dropping every rule.
export default {
	baseDir: import.meta.dirname,
	commands: './commands',
	desc: 'A fixture app whose classes are opaque to the scan',
	name: 'opaque',
};
