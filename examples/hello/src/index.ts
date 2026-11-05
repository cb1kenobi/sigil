// hello's schema: the JSX twin, which `sigil build` compiles into
// `dist/hello.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it -- anything here that did something would
// happen at build time. A `run` on the schema is what a single-command app
// does when argv names no command, so `hello` opens the screen and
// `hello --help` is still a CLI's help.
import { App, stylesheet } from './root.tsx';
import { start } from './start.ts';

export default {
  name: 'hello',
  desc: 'The smallest full-screen sigil app',

  async run(): Promise<void> {
    process.exitCode = await start(App, { stylesheet });
  },
};
