/**
 * An app with two command directories, so that two builds of it differ.
 *
 * The generated entry bakes the command tree in, so building this app twice with
 * different `--commands` is the cheapest way to make a shared entry path
 * *observable*: the trees differ, so a build that read the other's entry offers
 * the wrong command rather than merely being byte-identical by luck.
 */
export default {
	// `baseDir` because the path is relative, and without it the build resolves it
	// against this file while the runtime resolves it against the working
	// directory -- a warning the toolchain raises on purpose, and a fixture should
	// not be the thing demonstrating the mistake
	baseDir: import.meta.dirname,
	commands: './treeA',
	name: 'two-trees',
};
