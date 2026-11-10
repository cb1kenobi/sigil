// The schema is an `async` function, which is a schema that has to be built
// rather than declared -- reading a file or the environment before it knows what
// it is. Its name differs from the package's on purpose: a built app that lost
// the schema falls back to its file name, and `asyncapp` is then nowhere on the
// screen.
export default async () => ({
  baseDir: import.meta.dirname,
  commands: './commands',
  desc: 'An app whose schema is awaited',
  name: 'asyncapp',
  options: {
    '-l, --loud': { desc: 'Say it louder' },
  },
});
