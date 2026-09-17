import { fileURLToPath } from 'node:url';

// every path here is relative to this module, which is neither the directory
// the app was run from nor the directory the root schema lives in
export default {
	commands: {
		all: './all.js',
		// an absolute path is already an answer and is left alone
		here: fileURLToPath(new URL('./sub/here.js', import.meta.url)),
		// the object form, whose `path` is read the same way
		obj: {
			desc: 'this should be overwritten',
			path: './sub/obj.js',
		},
	},
	desc: 'build it',
};
