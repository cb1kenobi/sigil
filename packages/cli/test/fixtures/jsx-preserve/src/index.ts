// An app whose tsconfig asks for no JSX transform at all, which `tsc` obeys by
// emitting the JSX for something downstream to compile. A bundle is the end of
// the pipeline, so there is no downstream: what `preserve` can produce here is
// an executable that dies with `Unexpected token '<'` the first time it is
// loaded, which is why the build refuses it rather than honouring it.
export default {
	// what './commands' is relative to, without which this module means one
	// thing to the build and another to the runtime
	baseDir: import.meta.dirname,
	commands: './commands',
	desc: 'A fixture app whose tsconfig preserves its JSX',
	name: 'jsx-preserve',
};
