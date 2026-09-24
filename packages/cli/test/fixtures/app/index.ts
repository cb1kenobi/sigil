// the entry `sigil check` discovers: its schema says where the commands are
//
// The type is written out because this file sits inside the package's own
// type-check, where `--isolatedDeclarations` will infer neither the type of
// `import.meta.dirname` nor an object holding a shorthand property. An app
// outside this repository writes the literal and nothing else.
export const schema: { baseDir: string; commands: string; name: string } = {
	baseDir: import.meta.dirname,
	commands: './commands',
	name: 'fixture-app',
};
