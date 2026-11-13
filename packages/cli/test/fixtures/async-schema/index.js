// The schema is an `async` function, which is a schema that has to be built
// rather than declared -- reading a file or the environment before it knows what
// it is. Its name differs from the package's on purpose: a built app that lost
// the schema falls back to its file name, and `asyncapp` is then nowhere on the
// screen.
//
// `ASYNC_SCHEMA` steers the failure paths: `reject` rejects, with an exit code
// of its own; `null` resolves to something that is not a schema; `getter`
// carries a getter that throws when the entry spreads the schema; and `rethrow`
// asks `main()` to rethrow its own errors with `errorHandler: false`, which has
// to stay a rejection rather than be rendered by the entry. `throwing.js`
// beside this is the sync function that throws.
export default async () => {
  const mode = process.env.ASYNC_SCHEMA;

  await Promise.resolve();
  if (mode === 'reject') {
    throw Object.assign(new Error('schema rejected'), { exitCode: 4 });
  }
  if (mode === 'null') {
    return null;
  }
  if (mode === 'getter') {
    // no `commands` here: the build reads the one literal that declares them,
    // and a second would be two schemas in one module
    return {
      get settings() {
        throw new Error('getter threw');
      },
    };
  }

  return {
    baseDir: import.meta.dirname,
    commands: './commands',
    desc: 'An app whose schema is awaited',
    name: 'asyncapp',
    options: {
      '-l, --loud': { desc: 'Say it louder' },
    },
    ...(mode === 'rethrow' && { settings: { errorHandler: false } }),
  };
};
