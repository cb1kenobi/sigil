// The file manager's schema: the JSX twin, which `sigil build` compiles into
// `dist/file-manager.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it -- anything here that did something would
// happen at build time. A `run` on the schema is what a single-command app does
// when argv names no command, so `file-manager` opens the screen and
// `file-manager --help` is still a CLI's help.
//
// Where it opens comes in through `FilesContext`, which is how the tests point
// it at a directory they made, so a directory on the command line is the same
// provider with the directory in it.
import { createFiles, FilesContext } from './files.ts';
import { App, stylesheet } from './root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';

export default {
  name: 'file-manager',
  desc: 'A file manager in Miller columns, with a preview',
  args: [
    {
      name: 'dir',
      desc: 'Where to open, or a file to open beside. Defaults to the working directory',
    },
  ] as const,

  async run({ argv }: { argv: { dir?: string } }): Promise<void> {
    const files = createFiles({ start: argv.dir });
    process.exitCode = await runApp(() => provideContext(FilesContext, files, App), {
      sheets: [stylesheet],
    }).exited;
  },
};
