import { main } from '@ttylabs/sigil';

// What an app built on `main()` does with its output, for `output.test.ts` and
// `closed-pipe.test.ts`: a help screen longer than one block of a size limit, a
// command that returns data in one piece, a command that writes a long listing
// in pieces of its own, and one that keeps writing for a while so a terminal can
// hang up under it (`hung-up-terminal.test.ts`).
await main({
  schema: {
    commands: {
      // a message longer than one block, from an error that asks for the exit
      // code it names: `2> log` on a full file cuts the message off, and the
      // code is the only thing left to say so (`output.test.ts`)
      fail: {
        desc: 'Fail with a long message, and the exit code argv names',
        args: ['[code]'],
        run: (state) => {
          throw Object.assign(new Error('a message that does not fit. '.repeat(100)), {
            exitCode: Number(state.argv.code ?? 1),
          });
        },
      },
      list: {
        desc: 'List the items, as data',
        format: true,
        run: () => ({ items: Array.from({ length: 200 }, (_, i) => `item-${i}`) }),
      },
      ticks: {
        desc: 'Write a line at a time, slowly, and say on stderr how it ended',
        run: async () => {
          // counted beside `main()`'s own listener, which it does not replace: how many
          // writes failed is what says the terminal really hung up under the loop
          let failed = 0;
          process.stdout.on('error', () => void failed++);
          process.stdout.write('ready\n');
          for (let i = 0; i < 40; i++) {
            await new Promise((settle) => setTimeout(settle, 20));
            process.stdout.write(`tick ${i}\n`);
          }
          process.stderr.write(
            `finished isTTY=${process.stdout.isTTY === true} failedWrites=${failed}\n`
          );
        },
      },
      // a document handed to `page()`, which with no terminal on the other end
      // writes it out as it was given (`output.test.ts`, SIG-672)
      page: {
        desc: 'Page a long document, which is written out when output is a file',
        run: async () => {
          const { page } = await import('@ttylabs/sigil/components/pager');
          await page('a line of a document that is longer than one block\n'.repeat(60));
        },
      },
      // an unmounted outline, which with no terminal writes its whole tree on
      // `done()` (`output.test.ts`, SIG-680)
      outline: {
        desc: 'Write a long outline, which is written out when output is a file',
        run: async () => {
          const { createOutline } = await import('@ttylabs/sigil/components/outline');
          const items = Array.from({ length: 120 }, (_, i) => `an item of a list, number ${i}`);
          const list = createOutline(items);
          list.done();
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
