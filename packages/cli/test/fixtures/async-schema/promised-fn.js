// A Promise of a function rather than of a schema, built with `--entry` beside
// the async one. The entry awaits the export and does not call what it finds,
// as `sigil reference` does not, so this is refused rather than spread into an
// app with no name or options. The literal is what the build reads.
export default Promise.resolve(() => ({
  baseDir: import.meta.dirname,
  commands: './commands',
  name: 'asyncapp',
}));
