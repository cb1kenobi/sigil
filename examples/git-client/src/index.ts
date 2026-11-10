// The git client's schema: the JSX twin, which `sigil build` compiles into
// `dist/git-client.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it -- anything here that did something would
// happen at build time. A `run` on the schema is what a single-command app does
// when argv names no command, so `git-client` opens the screen and
// `git-client --help` is still a CLI's help.
//
// The repository comes in through `GitContext`, which is how the tests point
// the client at one they made, so a directory on the command line is the same
// provider with the directory in it.
import { createGit, GitContext } from './git.ts';
import { App, stylesheet } from './root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';
import { resolve } from 'node:path';

export default {
  name: 'git-client',
  desc: 'A git client in the shape of lazygit',
  args: [
    {
      name: 'dir',
      desc: 'The repository, or any directory inside it. Defaults to the working directory',
    },
  ] as const,

  async run({ argv }: { argv: { dir?: string } }): Promise<void> {
    const git = createGit({ cwd: argv.dir === undefined ? undefined : resolve(argv.dir) });
    process.exitCode = await runApp(() => provideContext(GitContext, git, App), {
      sheets: [stylesheet],
    }).exited;
  },
};
