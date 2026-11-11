// log-browser's schema: the JSX twin, which `sigil build` compiles into
// `dist/log-browser.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it. A `run` on the schema is what a
// single-command app does when argv names no command, so `log-browser` opens the
// screen and `log-browser --help` is still a CLI's help. `ui.ts` spells the same
// schema out over the `ui`-tag root, because Node cannot load this file's
// import of `root.tsx`.
import { EnvironmentContext, environment } from './browser.ts';
import { App, stylesheet } from './root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';

export default {
  name: 'log-browser',
  desc: 'A log and resource browser in the shape of k9s and lnav',
  args: [
    { desc: 'A log file to read and follow, instead of the simulated pods', name: '[file]' },
  ] as const,

  options: {
    '--mouse': 'Scroll with the wheel and click rows, at the cost of the terminal selecting text',
  },

  async run({ argv }: { argv: { file?: string; mouse: boolean } }): Promise<void> {
    const env = environment(argv.file);
    process.exitCode = await runApp(() => provideContext(EnvironmentContext, env, App), {
      mouse: argv.mouse,
      sheets: [stylesheet],
    }).exited;
  },
};
