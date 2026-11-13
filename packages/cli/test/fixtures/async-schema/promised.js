// A schema exported as a Promise rather than as a function returning one, built
// with `--entry` beside the async function: the generated entry awaits the
// export itself as well as a function's result, so this is the same schema.
export default Promise.resolve({
  baseDir: import.meta.dirname,
  commands: './commands',
  desc: 'An app whose schema is awaited',
  name: 'asyncapp',
  options: {
    '-l, --loud': { desc: 'Say it louder' },
  },
});
