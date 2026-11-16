// An app whose routes are named by the file system: a scoped package, which
// registers as the name after its scope, and a `commands.json` that hides and
// aliases a route, which is the supported way to do what a file name's
// punctuation used to be read as doing.
export default {
  desc: 'A fixture app whose route names are literal',
  name: 'route-names',
  baseDir: import.meta.dirname,
  commands: './commands',
};
