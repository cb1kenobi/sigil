// Object-literal order decides what a command module says about itself: a
// spread replaces what came before it. `early` writes its keys before one and
// `late` after one, and the build read both the same way (SIG-352).
export default {
  name: 'spread-order',
  baseDir: import.meta.dirname,
  commands: './commands',
};
