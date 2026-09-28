// An app that says everything about its JSX in its own tsconfig, and says
// `react-jsxdev` rather than `react-jsx`: the build replaces the import source
// and leaves the rest of the transform to the app, so this one reaches
// `@ttylabs/sigil/jsx-dev-runtime` and carries the positions that come with it.
export default {
	// what './commands' is relative to, without which this module means one
	// thing to the build and another to the runtime
	baseDir: import.meta.dirname,
	commands: './commands',
	desc: 'A fixture app whose tsconfig asks for the development JSX runtime',
	name: 'jsx-dev',
};
