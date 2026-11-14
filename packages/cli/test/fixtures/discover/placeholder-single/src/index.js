// Not an app of its own: each of the other files here is one, with exactly one
// thing wrong with it, so that a build refusing it can only be refusing that.
// Built with `--entry`, and run from source through `dev.ts`.
export default { name: 'placeholder-single', baseDir: import.meta.dirname, commands: {} };
