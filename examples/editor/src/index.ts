// The editor's schema, which `sigil build` compiles into `dist/editor.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it -- anything here that did something would
// happen at build time. A `run` on the schema is what a single-command app does
// when argv names no command, so `editor` opens the screen and `editor --help`
// is still a CLI's help.
//
// The directory comes in through `WorkspaceContext`, which is how the tests point
// the editor at one they made, so a directory on the command line is the same
// provider with the directory in it.
//
// The mouse is off, as the log browser's is: a terminal that reports the mouse
// stops selecting text, and copying out of a file someone has open matters more
// than clicking a tab. `--mouse` turns it on, for the wheel, a click on a tab
// and a drag selection inside the text area.
import { App, stylesheet } from './root.tsx';
import { createWorkspace, WorkspaceContext } from './workspace.ts';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';

export default {
  name: 'editor',
  desc: 'A text editor with a Markdown preview',
  args: [
    {
      name: 'dir',
      desc: 'The directory to open in the file tree. Defaults to the working directory',
    },
  ] as const,
  options: {
    '--mouse':
      'Scroll with the wheel, click tabs and drag a selection, at the cost of the terminal selecting text',
  },

  async run({ argv }: { argv: { dir?: string; mouse: boolean } }): Promise<void> {
    const workspace = createWorkspace(argv.dir);
    process.exitCode = await runApp(() => provideContext(WorkspaceContext, workspace, App), {
      mouse: argv.mouse,
      sheets: [stylesheet],
    }).exited;
  },
};
