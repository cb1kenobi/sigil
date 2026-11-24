import { main } from '@ttylabs/sigil';

// What an app built on `main()` does with its output, for `output.test.ts` and
// `closed-pipe.test.ts`: a help screen longer than one block of a size limit, a
// command that returns data in one piece, a command that writes a long listing
// in pieces of its own, and one that keeps writing for a while so a terminal can
// hang up under it (`hung-up-terminal.test.ts`).
await main({
  schema: {
    commands: {
      list: {
        desc: 'List the items, as data',
        format: true,
        run: () => ({ items: Array.from({ length: 200 }, (_, i) => `item-${i}`) }),
      },
      ticks: {
        desc: 'Write a line at a time, slowly, and say on stderr how it ended',
        run: async () => {
          process.stdout.write('ready\n');
          for (let i = 0; i < 20; i++) {
            await new Promise((settle) => setTimeout(settle, 20));
            process.stdout.write(`tick ${i}\n`);
          }
          process.stderr.write(`finished isTTY=${process.stdout.isTTY === true}\n`);
        },
      },
      lines: {
        desc: 'Write a long listing, a line at a time',
        run: () => {
          for (let i = 0; i < 200; i++) {
            process.stdout.write(`line ${i}\n`);
          }
        },
      },
    },
    desc: 'A program whose help screen runs well past one block of a size limit. '.repeat(20),
    name: 'out',
    version: '1.2.3',
  },
});
