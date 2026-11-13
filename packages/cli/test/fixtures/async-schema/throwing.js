// A schema function that throws synchronously, built with `--entry` beside the
// async one: the generated entry has to render this exactly as it renders a
// rejection, since there is no `main()` yet to catch either. It still returns a
// schema literal naming the commands, behind a condition nothing sets, because
// that literal is what the build reads off the module.
export default () => {
  if (process.env.ASYNC_SCHEMA !== 'calm') {
    throw new Error('schema threw');
  }
  return { baseDir: import.meta.dirname, commands: './commands', name: 'asyncapp' };
};
