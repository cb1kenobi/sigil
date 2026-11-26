// A `baseDir` of `null` (SIG-733). The runtime reads it as none -- `baseDir ?
// resolve(baseDir, file) : file` -- so the relative `commands` resolve against the
// working directory, and from anywhere but the app's own `src/` they are not found.
export default {
  baseDir: null,
  commands: './commands',
};
