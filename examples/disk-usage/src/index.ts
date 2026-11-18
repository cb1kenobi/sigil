// The visualizer's schema, which `sigil build` compiles into `dist/disk-usage.mjs`.
//
// Exported rather than run, because the build *reads* this module to learn the
// app's shape and does not import it -- anything here that did something would
// happen at build time. A `run` on the schema is what a single-command app does
// when argv names no command, so `disk-usage` opens the screen and
// `disk-usage --help` is still a CLI's help.
//
// The directory comes in through `DiskContext`, which is how the tests point the
// visualizer at one they made, so a directory on the command line is the same
// provider with the directory in it.
//
// The mouse is on: a treemap is a picture, and pointing at the part of it you
// want to know about is the first thing anybody does with one. Nothing on the
// screen is text worth selecting, which is what a terminal reporting the mouse
// gives up.
import { createDisk, DiskContext } from './disk.ts';
import { App, stylesheet } from './root.tsx';
import { runApp } from '@ttylabs/sigil/app';
import { provideContext } from '@ttylabs/sigil/renderer';

export default {
  name: 'disk-usage',
  desc: 'Where the space went: a tree of sizes beside a treemap',
  args: [
    {
      name: 'dir',
      desc: 'The directory to scan. Defaults to the working directory',
    },
  ] as const,

  async run({ argv }: { argv: { dir?: string } }): Promise<void> {
    const disk = createDisk(argv.dir);
    process.exitCode = await runApp(() => provideContext(DiskContext, disk, App), {
      mouse: true,
      sheets: [stylesheet],
    }).exited;
  },
};
