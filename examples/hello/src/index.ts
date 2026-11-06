// hello's schema: the JSX twin, which `sigil build` compiles into
// `dist/hello.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it -- anything here that did something would
// happen at build time. A `run` on the schema is what a single-command app
// does when argv names no command, so `hello` opens the screen and
// `hello --help` is still a CLI's help.
//
// `runApp()` resolves an exit code and leaves `process.exitCode` alone, so
// making it the process's is this line's job. Nothing is returned from `run()`,
// because what `run()` returns is the command's answer and is printed.
import { App, stylesheet } from './root.tsx';
import { runApp } from '@ttylabs/sigil/app';

export default {
  name: 'hello',
  desc: 'The smallest full-screen sigil app',

  async run(): Promise<void> {
    process.exitCode = await runApp(App, { sheets: [stylesheet] }).exited;
  },
};
